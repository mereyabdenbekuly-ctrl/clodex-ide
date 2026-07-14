import {
  validateSafeCodingAction,
  type SafeCodingAction,
} from '@clodex/contracts';
import type {
  PreparedSafeCodingAction,
  SafeCodingAdapterRegistryPort,
  SafeCodingPreparePort,
  TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import type {
  SafeCodingRuntimeAdapter,
  SafeCodingRuntimeAdapterRegistryPort,
} from '@clodex/runtime';

import {
  ReferenceAdapterError,
  bindingEquals,
  capabilityScopeEquals,
  preparedActionFrom,
  readOwnDataField,
  requireClosedRecord,
  snapshotBinding,
  snapshotCapabilityScope,
  snapshotMethod,
  type CapabilityScope,
  type CapabilityConfinedSafeCodingAdapter,
  type SupportedReferenceActionKind,
} from './common.js';

export interface CapabilityConfinedAdapterRegistryPorts {
  readonly capabilityScope: CapabilityScope | null;
  readonly guardianAdapters: SafeCodingAdapterRegistryPort;
  readonly guardianPrepare: SafeCodingPreparePort;
  readonly runtimeAdapters: SafeCodingRuntimeAdapterRegistryPort;
}

interface PinnedAdapter extends SafeCodingRuntimeAdapter {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: SupportedReferenceActionKind;
  };
  prepareAuthorization(
    action: SafeCodingAction,
  ): PreparedSafeCodingAction | Promise<PreparedSafeCodingAction>;
}

/**
 * Immutable shared registry façade. Guardian and runtime see different ports,
 * but both resolve the same pinned adapter snapshot. Every adapter must share
 * one capability scope, and every binding.adapterRegistryDigest is required by
 * contract to commit that scope as part of the registry manifest.
 */
export class CapabilityConfinedAdapterRegistry
  implements CapabilityConfinedAdapterRegistryPorts
{
  public readonly capabilityScope: CapabilityScope | null;
  public readonly guardianAdapters: SafeCodingAdapterRegistryPort;
  public readonly guardianPrepare: SafeCodingPreparePort;
  public readonly runtimeAdapters: SafeCodingRuntimeAdapterRegistryPort;

  readonly #adapters: ReadonlyMap<SupportedReferenceActionKind, PinnedAdapter>;

  public constructor(adapters: readonly CapabilityConfinedSafeCodingAdapter[]) {
    const adapterSnapshot = snapshotAdapterArray(adapters);
    const pinned = new Map<SupportedReferenceActionKind, PinnedAdapter>();
    let capabilityScope: CapabilityScope | null = null;
    for (const adapter of adapterSnapshot) {
      const snapshot = pinAdapter(adapter);
      if (
        capabilityScope !== null &&
        !capabilityScopeEquals(capabilityScope, snapshot.capabilityScope)
      ) {
        throw new ReferenceAdapterError(
          'capability-scope-mismatch',
          'configuration',
          'One adapter registry cannot combine different capability scopes',
        );
      }
      capabilityScope ??= snapshot.capabilityScope;
      if (pinned.has(snapshot.binding.action)) {
        throw new ReferenceAdapterError(
          'adapter-binding-mismatch',
          'configuration',
          `Duplicate adapter for ${snapshot.binding.action}`,
        );
      }
      pinned.set(snapshot.binding.action, snapshot);
    }
    this.capabilityScope = capabilityScope;
    this.#adapters = pinned;
    this.guardianAdapters = Object.freeze({
      resolve: this.resolveBinding.bind(this),
    });
    this.guardianPrepare = Object.freeze({
      prepare: this.prepareForGuardian.bind(this),
    });
    this.runtimeAdapters = Object.freeze({
      resolve: this.resolveRuntime.bind(this),
    });
    Object.freeze(this);
  }

  private resolveBinding(
    actionValue: SafeCodingAction,
  ): TrustedSafeCodingAdapterBinding | null {
    const action = validateSafeCodingAction(actionValue);
    return this.get(action)?.binding ?? null;
  }

  private resolveRuntime(
    actionValue: SafeCodingAction,
  ): SafeCodingRuntimeAdapter | null {
    const action = validateSafeCodingAction(actionValue);
    return this.get(action) ?? null;
  }

  private async prepareForGuardian(
    actionValue: SafeCodingAction,
    bindingValue: TrustedSafeCodingAdapterBinding,
  ): Promise<PreparedSafeCodingAction> {
    const action = validateSafeCodingAction(actionValue);
    const adapter = this.get(action);
    if (!adapter) {
      throw new ReferenceAdapterError(
        'action-not-supported',
        'prepare',
        `No capability-confined adapter is registered for ${action.action}`,
      );
    }
    const binding = snapshotBinding(
      bindingValue as TrustedSafeCodingAdapterBinding & {
        readonly action: SupportedReferenceActionKind;
      },
      adapter.binding.action,
      adapter.binding.effectClass,
    );
    if (!bindingEquals(binding, adapter.binding)) {
      throw new ReferenceAdapterError(
        'adapter-binding-mismatch',
        'prepare',
        'Guardian PREPARE binding differs from the pinned adapter',
      );
    }
    const prepared = await adapter.prepareAuthorization(action);
    const record = requireClosedRecord(
      prepared,
      ['resolvedObjectId', 'stateCommitmentHash'],
      'Guardian prepared action',
      'prepare',
    );
    return preparedActionFrom(
      record.resolvedObjectId as string,
      record.stateCommitmentHash as string,
    );
  }

  private get(action: SafeCodingAction): PinnedAdapter | null {
    if (!isSupportedAction(action.action)) return null;
    return this.#adapters.get(action.action) ?? null;
  }
}

function snapshotAdapterArray(
  value: unknown,
): readonly CapabilityConfinedSafeCodingAdapter[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      'Adapter registry requires an ordinary fixed adapter array',
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 64
  ) {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      'Adapter registry array length is invalid or exceeds 64',
    );
  }
  const length = lengthDescriptor.value as number;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || !names.includes('length')) {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      'Adapter registry array must be dense and contain no extra fields',
    );
  }
  const snapshot: CapabilityConfinedSafeCodingAdapter[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new ReferenceAdapterError(
        'dependency-invalid',
        'configuration',
        'Adapter registry array cannot contain accessors or hidden entries',
      );
    }
    snapshot.push(descriptor.value as CapabilityConfinedSafeCodingAdapter);
  }
  return Object.freeze(snapshot);
}

function pinAdapter(
  adapter: CapabilityConfinedSafeCodingAdapter,
): PinnedAdapter {
  if (!adapter || typeof adapter !== 'object') {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      'Registry adapter must expose runtime and authorization PREPARE',
    );
  }
  const capabilityScope = snapshotCapabilityScope(
    readOwnDataField(adapter, 'capabilityScope', 'Registry adapter scope'),
  );
  const bindingValue = readOwnDataField<TrustedSafeCodingAdapterBinding>(
    adapter,
    'binding',
    'Registry adapter binding',
  );
  const bindingRecord = requireClosedRecord(
    bindingValue,
    [
      'action',
      'policyDigest',
      'adapterId',
      'adapterDigest',
      'adapterRegistryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'effectClass',
    ],
    'Registry adapter binding',
    'configuration',
  );
  const actionValue = bindingRecord.action as SafeCodingAction['action'];
  if (!isSupportedAction(actionValue)) {
    throw new ReferenceAdapterError(
      'action-not-supported',
      'configuration',
      'Registry adapter action is outside the reference profile',
    );
  }
  const action = actionValue;
  const effectClass = expectedEffectClass(action);
  const binding = snapshotBinding(
    bindingValue as TrustedSafeCodingAdapterBinding & {
      readonly action: SupportedReferenceActionKind;
    },
    action,
    effectClass,
  );
  return Object.freeze({
    capabilityScope,
    binding,
    prepare: snapshotMethod(adapter, 'prepare', 'Registry runtime PREPARE'),
    prepareAuthorization: snapshotMethod(
      adapter,
      'prepareAuthorization',
      'Registry authorization PREPARE',
    ),
  });
}

function isSupportedAction(
  action: SafeCodingAction['action'] | undefined,
): action is SupportedReferenceActionKind {
  return (
    action === 'filesystem.create' ||
    action === 'filesystem.replace' ||
    action === 'filesystem.mkdir' ||
    action === 'git.status' ||
    action === 'git.diff' ||
    action === 'test.run'
  );
}

function expectedEffectClass(
  action: SupportedReferenceActionKind,
): TrustedSafeCodingAdapterBinding['effectClass'] {
  if (action === 'git.status' || action === 'git.diff') {
    return 'local.observation';
  }
  if (action === 'test.run') return 'sandbox.ephemeral';
  return 'local.reversible';
}
