import { canonicalizeJson, parseCanonicalJson } from '@clodex/contracts';
import {
  cloneControlPlaneTransactionRecord,
  controlPlaneIdentityKeys,
  validateControlPlaneTransactionRecord,
  type ControlPlaneTransactionRecord,
} from './model.js';
import {
  CONTROL_PLANE_DURABILITY_CONTRACT_VERSION,
  invokeControlPlanePreCommitFence,
  type ControlPlaneStorageCasResult,
  type ControlPlaneStorageMutation,
  type ControlPlaneStorageTransactionPort,
  type MemoryOnlyControlPlaneDurabilityContract,
} from './storage.js';
import { assertControlPlaneSuccessor } from './transitions.js';

export const IN_MEMORY_CONTROL_PLANE_DURABILITY = Object.freeze({
  version: CONTROL_PLANE_DURABILITY_CONTRACT_VERSION,
  mode: 'memory-only',
  adapterId: 'clodex-control-plane.in-memory-reference-v1',
  atomicScope: 'single-js-isolate',
  atomicTicketPermitLedgerOutbox: true,
  linearizableCas: true,
  stableBeforeSuccess: false,
  restartReadable: false,
  multiProcessCas: false,
  externalEffectInStorageTransaction: false,
  recoveryMayReplayEffects: false,
} satisfies MemoryOnlyControlPlaneDurabilityContract);

/**
 * Reference-only isolate-local transaction store. It demonstrates the state
 * machine but intentionally makes no restart or filesystem durability claim.
 */
export class InMemoryControlPlaneStore
  implements ControlPlaneStorageTransactionPort
{
  public readonly durability = IN_MEMORY_CONTROL_PLANE_DURABILITY;

  readonly #records = new Map<string, ControlPlaneTransactionRecord>();
  readonly #identities = new Map<string, string>();

  public async read(transactionId: string): Promise<unknown | null> {
    const record = this.#records.get(transactionId);
    return record ? cloneControlPlaneTransactionRecord(record) : null;
  }

  public async scan(): Promise<readonly unknown[]> {
    return Object.freeze(
      [...this.#records.values()]
        .sort((left, right) =>
          compareStrings(left.transactionId, right.transactionId),
        )
        .map(cloneControlPlaneTransactionRecord),
    );
  }

  public async compareAndSwap(
    mutationValue: ControlPlaneStorageMutation,
  ): Promise<ControlPlaneStorageCasResult> {
    const mutation = validateMutationEnvelope(mutationValue);
    const next = validateControlPlaneTransactionRecord(mutation.nextRecord);
    if (mutation.transactionId !== next.transactionId) {
      throw new Error('Storage mutation key does not match transaction');
    }
    const current = this.#records.get(mutation.transactionId) ?? null;
    if (mutation.expectedRevision === null) {
      if (current !== null) {
        return Object.freeze({
          outcome: 'REVISION_CONFLICT',
          actualRevision: current.revision,
        });
      }
      if (next.revision !== 1 || next.phase !== 'PREPARED') {
        throw new Error('New control-plane transaction must start PREPARED');
      }
    } else {
      if (current === null || current.revision !== mutation.expectedRevision) {
        return Object.freeze({
          outcome: 'REVISION_CONFLICT',
          actualRevision: current?.revision ?? null,
        });
      }
      assertControlPlaneSuccessor(current, next);
    }

    for (const identityKey of controlPlaneIdentityKeys(next)) {
      const owner = this.#identities.get(identityKey);
      if (owner !== undefined && owner !== mutation.transactionId) {
        return Object.freeze({
          outcome: 'IDENTITY_CONFLICT',
          identityKey,
        });
      }
    }

    // No await is permitted between this final fence and the isolate-local
    // atomic assignment below.
    invokeControlPlanePreCommitFence(mutation.preCommitFence);
    const stored = cloneControlPlaneTransactionRecord(next);
    this.#records.set(mutation.transactionId, stored);
    for (const identityKey of controlPlaneIdentityKeys(stored)) {
      this.#identities.set(identityKey, mutation.transactionId);
    }
    return Object.freeze({
      outcome: 'APPLIED',
      record: cloneControlPlaneTransactionRecord(stored),
    });
  }

  public snapshot(): readonly ControlPlaneTransactionRecord[] {
    return Object.freeze(
      [...this.#records.values()]
        .sort((left, right) =>
          compareStrings(left.transactionId, right.transactionId),
        )
        .map((record) =>
          validateControlPlaneTransactionRecord(
            parseCanonicalJson(canonicalizeJson(record)),
          ),
        ),
    );
  }
}

function validateMutationEnvelope(
  value: ControlPlaneStorageMutation,
): ControlPlaneStorageMutation {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
    Object.getOwnPropertyNames(value).some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || !('value' in descriptor);
    })
  ) {
    throw new Error('Storage mutation must be a closed data-method record');
  }
  const hasFence = Object.hasOwn(value, 'preCommitFence');
  const expected = [
    'expectedRevision',
    'nextRecord',
    ...(hasFence ? ['preCommitFence'] : []),
    'transactionId',
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('Storage mutation has unknown or missing fields');
  }
  if (
    value.preCommitFence !== undefined &&
    typeof value.preCommitFence !== 'function'
  ) {
    throw new Error('Storage preCommitFence must be a function');
  }
  return Object.freeze({
    transactionId: value.transactionId,
    expectedRevision: value.expectedRevision,
    nextRecord: value.nextRecord,
    ...(value.preCommitFence === undefined
      ? {}
      : { preCommitFence: value.preCommitFence }),
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
