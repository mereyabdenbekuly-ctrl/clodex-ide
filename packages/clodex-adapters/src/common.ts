import {
  canonicalizeJson,
  encodeUtf8,
  hashSafeCodingAction,
  validateSafeCodingAction,
  validateSafeCodingExecutionTicket,
  type CanonicalJsonValue,
  type HashPort,
  type SafeCodingAction,
  type SafeCodingEffectClass,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';
import type {
  PreparedSafeCodingAction,
  TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import type {
  PreparedRuntimeEffect,
  SafeCodingRuntimeAdapter,
  SafeCodingRuntimeAdapterResult,
} from '@clodex/runtime';

export const CAPABILITY_CONFINED_REFERENCE_ADAPTER_PROFILE = Object.freeze({
  authorityModel: 'injected-fixed-operation-ports',
  durability: 'port-defined-not-provided',
  filesystemConfinement: 'protocol-only-not-openat2',
  gitConfinement: 'policy-commitment-not-cli-implementation',
  testConfinement: 'profile-commitment-not-os-sandbox',
  hostWorkspaceAdapter: false,
} as const);

export type SupportedReferenceActionKind =
  | 'filesystem.create'
  | 'filesystem.replace'
  | 'filesystem.mkdir'
  | 'git.status'
  | 'git.diff'
  | 'test.run';

export type ReferenceAdapterErrorStage =
  | 'configuration'
  | 'prepare'
  | 'execute';

export type ReferenceAdapterErrorCode =
  | 'action-not-supported'
  | 'action-ticket-mismatch'
  | 'adapter-binding-mismatch'
  | 'capability-scope-mismatch'
  | 'content-integrity-mismatch'
  | 'content-unavailable'
  | 'dependency-invalid'
  | 'hardened-policy-invalid'
  | 'port-result-invalid'
  | 'prepared-effect-consumed'
  | 'prepared-state-mismatch'
  | 'sandbox-profile-invalid'
  | 'sandbox-profile-unavailable';

export class ReferenceAdapterError extends Error {
  public constructor(
    public readonly code: ReferenceAdapterErrorCode,
    public readonly stage: ReferenceAdapterErrorStage,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'ReferenceAdapterError';
  }
}

export interface CapabilityConfinedSafeCodingAdapter
  extends SafeCodingRuntimeAdapter {
  /**
   * Fixed object-capability boundary. The adapter registry digest MUST commit
   * this exact scope together with the adapter set and binding metadata.
   */
  readonly capabilityScope: CapabilityScope;
  prepareAuthorization(
    action: SafeCodingAction,
  ): PreparedSafeCodingAction | Promise<PreparedSafeCodingAction>;
}

export interface CapabilityScope {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
}

export interface CapabilityScopedPortInput {
  readonly capabilityScope: CapabilityScope;
}

export type ActionOfKind<K extends SafeCodingAction['action']> = Extract<
  SafeCodingAction,
  { readonly action: K }
>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export function snapshotHashPort(hash: HashPort): HashPort {
  return Object.freeze({
    sha256: snapshotMethod(hash, 'sha256', 'SHA-256 HashPort'),
  });
}

export function snapshotCapabilityScope(value: unknown): CapabilityScope {
  const record = requireClosedRecord(
    value,
    ['workspaceId', 'taskId', 'rootObjectId'],
    'Capability scope',
    'configuration',
  );
  return Object.freeze({
    workspaceId: requireIdentifier(
      record.workspaceId,
      'Capability workspace ID',
      'configuration',
    ),
    taskId: requireIdentifier(
      record.taskId,
      'Capability task ID',
      'configuration',
    ),
    rootObjectId: requireIdentifier(
      record.rootObjectId,
      'Capability root object ID',
      'configuration',
    ),
  });
}

export function capabilityScopeEquals(
  left: CapabilityScope,
  right: CapabilityScope,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.taskId === right.taskId &&
    left.rootObjectId === right.rootObjectId
  );
}

export function snapshotBinding<K extends SupportedReferenceActionKind>(
  value: TrustedSafeCodingAdapterBinding & { readonly action: K },
  expectedAction: K,
  expectedEffectClass: SafeCodingEffectClass,
): TrustedSafeCodingAdapterBinding & { readonly action: K } {
  const record = requireClosedRecord(
    value,
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
    'Adapter binding',
    'configuration',
  );
  if (record.action !== expectedAction) {
    throw new ReferenceAdapterError(
      'adapter-binding-mismatch',
      'configuration',
      `Adapter binding must name ${expectedAction}`,
    );
  }
  if (record.effectClass !== expectedEffectClass) {
    throw new ReferenceAdapterError(
      'adapter-binding-mismatch',
      'configuration',
      `${expectedAction} requires effect class ${expectedEffectClass}`,
    );
  }
  const binding = {
    action: expectedAction,
    policyDigest: requireDigest(
      record.policyDigest,
      'Adapter policy digest',
      'configuration',
    ),
    adapterId: requireIdentifier(
      record.adapterId,
      'Adapter ID',
      'configuration',
    ),
    adapterDigest: requireDigest(
      record.adapterDigest,
      'Adapter digest',
      'configuration',
    ),
    adapterRegistryDigest: requireDigest(
      record.adapterRegistryDigest,
      'Adapter registry digest',
      'configuration',
    ),
    runnerRegistryDigest: requireDigest(
      record.runnerRegistryDigest,
      'Runner registry digest',
      'configuration',
    ),
    effectRegistryDigest: requireDigest(
      record.effectRegistryDigest,
      'Effect registry digest',
      'configuration',
    ),
    effectClass: expectedEffectClass,
  } as const;
  return Object.freeze(binding);
}

export function requireActionKind<K extends SafeCodingAction['action']>(
  value: unknown,
  expectedAction: K,
): ActionOfKind<K> {
  let action: SafeCodingAction;
  try {
    action = validateSafeCodingAction(value);
  } catch (error) {
    throw new ReferenceAdapterError(
      'action-not-supported',
      'prepare',
      'Safe Coding action is invalid',
      error,
    );
  }
  if (action.action !== expectedAction) {
    throw new ReferenceAdapterError(
      'action-not-supported',
      'prepare',
      `Adapter accepts only ${expectedAction}`,
    );
  }
  return action as ActionOfKind<K>;
}

export async function requireExactTicket<
  K extends SupportedReferenceActionKind,
>(
  ticketValue: unknown,
  action: ActionOfKind<K>,
  binding: TrustedSafeCodingAdapterBinding & { readonly action: K },
  capabilityScope: CapabilityScope,
  hash: HashPort,
): Promise<SafeCodingExecutionTicket> {
  let ticket: SafeCodingExecutionTicket;
  try {
    ticket = validateSafeCodingExecutionTicket(ticketValue);
  } catch (error) {
    throw new ReferenceAdapterError(
      'action-ticket-mismatch',
      'prepare',
      'Execution Ticket is invalid',
      error,
    );
  }
  if (
    ticket.audience.workspaceId !== capabilityScope.workspaceId ||
    ticket.audience.taskId !== capabilityScope.taskId
  ) {
    throw new ReferenceAdapterError(
      'capability-scope-mismatch',
      'prepare',
      'Execution Ticket audience is outside the adapter capability scope',
    );
  }
  let actionHash: string;
  try {
    actionHash = await hashSafeCodingAction(action, hash);
  } catch (error) {
    throw new ReferenceAdapterError(
      'action-ticket-mismatch',
      'prepare',
      'Action hash could not be recomputed',
      error,
    );
  }
  if (
    ticket.requestId !== (action as SafeCodingAction).requestId ||
    ticket.actionHash !== actionHash
  ) {
    throw new ReferenceAdapterError(
      'action-ticket-mismatch',
      'prepare',
      'Execution Ticket does not bind the exact action bytes',
    );
  }
  if (
    ticket.adapterId !== binding.adapterId ||
    ticket.adapterDigest !== binding.adapterDigest ||
    ticket.policyDigest !== binding.policyDigest ||
    ticket.registryDigest !== binding.adapterRegistryDigest ||
    ticket.runnerRegistryDigest !== binding.runnerRegistryDigest ||
    ticket.effectRegistryDigest !== binding.effectRegistryDigest ||
    ticket.effectClass !== binding.effectClass
  ) {
    throw new ReferenceAdapterError(
      'adapter-binding-mismatch',
      'prepare',
      'Execution Ticket does not bind the exact adapter profile',
    );
  }
  return ticket;
}

export function preparedActionFrom(
  resolvedObjectId: string,
  stateCommitmentHash: string,
): PreparedSafeCodingAction {
  return Object.freeze({
    resolvedObjectId: requireIdentifier(
      resolvedObjectId,
      'Resolved object ID',
      'prepare',
    ),
    stateCommitmentHash: requireDigest(
      stateCommitmentHash,
      'State commitment hash',
      'prepare',
    ),
  });
}

export function assertPreparedMatchesTicket(
  prepared: PreparedSafeCodingAction,
  ticket: SafeCodingExecutionTicket,
): void {
  if (
    prepared.resolvedObjectId !== ticket.resolvedObjectId ||
    prepared.stateCommitmentHash !== ticket.stateCommitmentHash
  ) {
    throw new ReferenceAdapterError(
      'prepared-state-mismatch',
      'prepare',
      'Prepared object/state does not exactly match the Execution Ticket',
    );
  }
}

export function createOneShotPreparedEffect(
  executeOperation: () =>
    | SafeCodingRuntimeAdapterResult
    | Promise<SafeCodingRuntimeAdapterResult>,
): PreparedRuntimeEffect {
  let consumed = false;
  const execute = async (): Promise<SafeCodingRuntimeAdapterResult> => {
    if (consumed) {
      throw new ReferenceAdapterError(
        'prepared-effect-consumed',
        'execute',
        'Prepared effect is one-shot and retry is forbidden',
      );
    }
    consumed = true;
    return await executeOperation();
  };
  return Object.freeze({ execute });
}

export function createAdapterResult(
  result: CanonicalJsonValue,
  preStateHash: string,
  postStateHash: string,
): SafeCodingRuntimeAdapterResult {
  return Object.freeze({
    result,
    preStateHash: requireDigest(
      preStateHash,
      'Operation pre-state hash',
      'execute',
    ),
    postStateHash: requireDigest(
      postStateHash,
      'Operation post-state hash',
      'execute',
    ),
    evidenceLevel: 'adapter_observed' as const,
  });
}

export function requireClosedRecord(
  value: unknown,
  expectedFields: readonly string[],
  label: string,
  stage: ReferenceAdapterErrorStage,
): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw new Error('not a closed plain object');
    }
    const names = Object.getOwnPropertyNames(value).sort();
    const expected = [...expectedFields].sort();
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      throw new Error('unknown or missing fields');
    }
    for (const name of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error('accessors or hidden fields are forbidden');
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ReferenceAdapterError) throw error;
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} must be a closed data-only object`,
      error,
    );
  }
}

export function requireDigest(
  value: unknown,
  label: string,
  stage: ReferenceAdapterErrorStage,
): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

export function requireIdentifier(
  value: unknown,
  label: string,
  stage: ReferenceAdapterErrorStage,
): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} must be a canonical identifier`,
    );
  }
  return value;
}

export function requireNonNegativeInteger(
  value: unknown,
  label: string,
  stage: ReferenceAdapterErrorStage,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

export function requireBoolean(
  value: unknown,
  label: string,
  stage: ReferenceAdapterErrorStage,
): boolean {
  if (typeof value !== 'boolean') {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} must be a boolean`,
    );
  }
  return value;
}

export function requireLiteral<T extends string | boolean>(
  value: unknown,
  expected: T,
  label: string,
  stage: ReferenceAdapterErrorStage,
): T {
  if (value !== expected) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} must equal ${String(expected)}`,
    );
  }
  return expected;
}

export async function hashCanonicalCommitment(
  domain: string,
  value: unknown,
  hash: HashPort,
  stage: ReferenceAdapterErrorStage,
): Promise<string> {
  let digest: string;
  try {
    digest = await hash.sha256(
      encodeUtf8(`${domain}\0${canonicalizeJson(value)}`),
    );
  } catch (error) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      'HashPort failed closed',
      error,
    );
  }
  return requireDigest(digest, 'HashPort result', stage);
}

export function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string,
  stage: ReferenceAdapterErrorStage,
): void {
  if (actual !== expected) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      stage,
      `${label} does not match the prepared operation`,
    );
  }
}

export function snapshotMethod<Owner extends object, Name extends keyof Owner>(
  owner: Owner,
  name: Name,
  label: string,
): Owner[Name] {
  if (
    owner === null ||
    (typeof owner !== 'object' && typeof owner !== 'function')
  ) {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      `${label} capability is required`,
    );
  }
  let target: object | null = owner;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new ReferenceAdapterError(
          'dependency-invalid',
          'configuration',
          `${label} must be a data method`,
        );
      }
      return descriptor.value.bind(owner) as Owner[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new ReferenceAdapterError(
    'dependency-invalid',
    'configuration',
    `${label} capability is required`,
  );
}

export function readOwnDataField<T>(
  owner: object,
  name: string,
  label: string,
): T {
  if (
    owner === null ||
    (typeof owner !== 'object' && typeof owner !== 'function')
  ) {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      `${label} owner is required`,
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || !('value' in descriptor)) {
    throw new ReferenceAdapterError(
      'dependency-invalid',
      'configuration',
      `${label} must be an own data field`,
    );
  }
  return descriptor.value as T;
}

export function bindingEquals(
  left: TrustedSafeCodingAdapterBinding,
  right: TrustedSafeCodingAdapterBinding,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}
