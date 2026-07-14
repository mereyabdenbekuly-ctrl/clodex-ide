import {
  CONTROL_PLANE_IDENTITY_KEY_MAX_LENGTH,
  ControlPlaneValidationError,
  validateControlPlaneTransactionRecord,
  type ControlPlaneTransactionRecord,
} from './model.js';

export const CONTROL_PLANE_DURABILITY_CONTRACT_VERSION = 1 as const;

export interface MemoryOnlyControlPlaneDurabilityContract {
  readonly version: typeof CONTROL_PLANE_DURABILITY_CONTRACT_VERSION;
  readonly mode: 'memory-only';
  readonly adapterId: string;
  readonly atomicScope: 'single-js-isolate';
  readonly atomicTicketPermitLedgerOutbox: true;
  readonly linearizableCas: true;
  readonly stableBeforeSuccess: false;
  readonly restartReadable: false;
  readonly multiProcessCas: false;
  readonly externalEffectInStorageTransaction: false;
  readonly recoveryMayReplayEffects: false;
}

export interface AdapterDeclaredDurableControlPlaneContract {
  readonly version: typeof CONTROL_PLANE_DURABILITY_CONTRACT_VERSION;
  readonly mode: 'adapter-declared-durable';
  readonly adapterId: string;
  readonly atomicScope: 'storage-transaction';
  readonly atomicTicketPermitLedgerOutbox: true;
  readonly linearizableCas: true;
  readonly stableBeforeSuccess: true;
  readonly restartReadable: true;
  readonly multiProcessCas: true;
  readonly externalEffectInStorageTransaction: false;
  readonly recoveryMayReplayEffects: false;
}

export type ControlPlaneDurabilityContract =
  | MemoryOnlyControlPlaneDurabilityContract
  | AdapterDeclaredDurableControlPlaneContract;

export type ControlPlanePreCommitFence = () => void;

export interface ControlPlaneStorageMutation {
  readonly transactionId: string;
  /** Null inserts revision 1; a number requires an exact current revision. */
  readonly expectedRevision: number | null;
  readonly nextRecord: ControlPlaneTransactionRecord;
  /**
   * Optional synchronous authority/trust fence. A conforming store invokes it
   * exactly once, under mutation exclusion, after conflict checks and before
   * the local transaction's linearization point. It must never be awaited.
   */
  readonly preCommitFence?: ControlPlanePreCommitFence;
}

export type ControlPlaneStorageCasResult =
  | {
      readonly outcome: 'APPLIED';
      readonly record: unknown;
    }
  | {
      readonly outcome: 'REVISION_CONFLICT';
      readonly actualRevision: number | null;
    }
  | {
      readonly outcome: 'IDENTITY_CONFLICT';
      readonly identityKey: string;
    };

/**
 * Injected local storage transaction TCB. APPLIED must cover the complete
 * record and all exported identity reservations. It deliberately cannot make
 * an external filesystem/Git/network/process effect atomic with this write.
 */
export interface ControlPlaneStorageTransactionPort {
  readonly durability: ControlPlaneDurabilityContract;
  read(transactionId: string): Promise<unknown | null>;
  scan(): Promise<readonly unknown[]>;
  compareAndSwap(
    mutation: ControlPlaneStorageMutation,
  ): Promise<ControlPlaneStorageCasResult>;
}

export function validateControlPlaneDurabilityContract(
  value: unknown,
): ControlPlaneDurabilityContract {
  const record = requireRecord(value, 'Control-plane durability contract');
  requireExactKeys(
    record,
    [
      'version',
      'mode',
      'adapterId',
      'atomicScope',
      'atomicTicketPermitLedgerOutbox',
      'linearizableCas',
      'stableBeforeSuccess',
      'restartReadable',
      'multiProcessCas',
      'externalEffectInStorageTransaction',
      'recoveryMayReplayEffects',
    ],
    'Control-plane durability contract',
  );
  if (record.version !== CONTROL_PLANE_DURABILITY_CONTRACT_VERSION) {
    throw new ControlPlaneValidationError(
      'Control-plane durability contract version is invalid',
    );
  }
  const adapterId = requireIdentifier(record.adapterId, 'Storage adapter ID');
  if (record.mode === 'memory-only') {
    if (
      record.atomicScope !== 'single-js-isolate' ||
      record.atomicTicketPermitLedgerOutbox !== true ||
      record.linearizableCas !== true ||
      record.stableBeforeSuccess !== false ||
      record.restartReadable !== false ||
      record.multiProcessCas !== false ||
      record.externalEffectInStorageTransaction !== false ||
      record.recoveryMayReplayEffects !== false
    ) {
      throw new ControlPlaneValidationError(
        'Memory-only durability declaration is inconsistent',
      );
    }
    return Object.freeze({
      version: CONTROL_PLANE_DURABILITY_CONTRACT_VERSION,
      mode: 'memory-only',
      adapterId,
      atomicScope: 'single-js-isolate',
      atomicTicketPermitLedgerOutbox: true,
      linearizableCas: true,
      stableBeforeSuccess: false,
      restartReadable: false,
      multiProcessCas: false,
      externalEffectInStorageTransaction: false,
      recoveryMayReplayEffects: false,
    });
  }
  if (record.mode === 'adapter-declared-durable') {
    if (
      record.atomicScope !== 'storage-transaction' ||
      record.atomicTicketPermitLedgerOutbox !== true ||
      record.linearizableCas !== true ||
      record.stableBeforeSuccess !== true ||
      record.restartReadable !== true ||
      record.multiProcessCas !== true ||
      record.externalEffectInStorageTransaction !== false ||
      record.recoveryMayReplayEffects !== false
    ) {
      throw new ControlPlaneValidationError(
        'Durable control-plane declaration is inconsistent',
      );
    }
    return Object.freeze({
      version: CONTROL_PLANE_DURABILITY_CONTRACT_VERSION,
      mode: 'adapter-declared-durable',
      adapterId,
      atomicScope: 'storage-transaction',
      atomicTicketPermitLedgerOutbox: true,
      linearizableCas: true,
      stableBeforeSuccess: true,
      restartReadable: true,
      multiProcessCas: true,
      externalEffectInStorageTransaction: false,
      recoveryMayReplayEffects: false,
    });
  }
  throw new ControlPlaneValidationError(
    'Control-plane durability mode is invalid',
  );
}

export function validateControlPlaneStorageCasResult(
  value: unknown,
): ControlPlaneStorageCasResult {
  const record = requireRecord(value, 'Control-plane CAS result');
  if (record.outcome === 'APPLIED') {
    requireExactKeys(record, ['outcome', 'record'], 'Applied CAS result');
    return Object.freeze({ outcome: 'APPLIED', record: record.record });
  }
  if (record.outcome === 'REVISION_CONFLICT') {
    requireExactKeys(
      record,
      ['outcome', 'actualRevision'],
      'Revision-conflict CAS result',
    );
    const actualRevision =
      record.actualRevision === null
        ? null
        : requireNonNegativeInteger(
            record.actualRevision,
            'CAS actual revision',
          );
    return Object.freeze({ outcome: 'REVISION_CONFLICT', actualRevision });
  }
  if (record.outcome === 'IDENTITY_CONFLICT') {
    requireExactKeys(
      record,
      ['outcome', 'identityKey'],
      'Identity-conflict CAS result',
    );
    const identityKey = requireIdentityKey(record.identityKey);
    return Object.freeze({ outcome: 'IDENTITY_CONFLICT', identityKey });
  }
  throw new ControlPlaneValidationError('Control-plane CAS outcome is invalid');
}

export function validateControlPlanePersistenceRecord(
  value: unknown,
): ControlPlaneTransactionRecord {
  try {
    return validateControlPlaneTransactionRecord(value);
  } catch (error) {
    throw new ControlPlaneValidationError(
      'Persistence returned an invalid control-plane transaction',
      error,
    );
  }
}

export function invokeControlPlanePreCommitFence(
  fence: ControlPlanePreCommitFence | undefined,
): void {
  if (fence === undefined) return;
  const returned = fence() as unknown;
  if (returned !== undefined) {
    throw new ControlPlaneValidationError(
      'Control-plane pre-commit fence must return void',
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
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
    throw new ControlPlaneValidationError(
      `${label} must be a closed data record`,
    );
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ControlPlaneValidationError(
      `${label} has unknown or missing fields`,
    );
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw new ControlPlaneValidationError(
      `${label} must be a bounded identifier`,
    );
  }
  return value;
}

function requireIdentityKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > CONTROL_PLANE_IDENTITY_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw new ControlPlaneValidationError('CAS identity key is invalid');
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ControlPlaneValidationError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}
