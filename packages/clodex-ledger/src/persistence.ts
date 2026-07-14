import {
  SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH,
  SafeCodingLedgerValidationError,
  validateSafeCodingLedgerRecord,
  type SafeCodingLedgerRecord,
} from './records.js';

export const SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION = 1 as const;

export interface MemoryOnlyLedgerDurabilityContract {
  readonly version: typeof SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION;
  readonly mode: 'memory-only';
  readonly adapterId: string;
  readonly atomicScope: 'single-js-isolate';
  readonly atomicRecordAndOutbox: true;
  readonly stableBeforeSuccess: false;
  readonly restartReadable: false;
  readonly multiProcessCas: false;
}

/**
 * This is an adapter declaration, not proof. Production claim review must
 * separately audit the adapter, storage engine, fsync/barrier behavior, and
 * startup recovery wiring.
 */
export interface AdapterDeclaredDurableLedgerContract {
  readonly version: typeof SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION;
  readonly mode: 'adapter-declared-durable';
  readonly adapterId: string;
  readonly atomicScope: 'storage-transaction';
  readonly atomicRecordAndOutbox: true;
  readonly stableBeforeSuccess: true;
  readonly restartReadable: true;
  readonly multiProcessCas: true;
}

export type SafeCodingLedgerDurabilityContract =
  | MemoryOnlyLedgerDurabilityContract
  | AdapterDeclaredDurableLedgerContract;

export interface SafeCodingLedgerPersistenceMutation {
  readonly transactionId: string;
  /** Null inserts revision 1; a number requires an exact current revision. */
  readonly expectedRevision: number | null;
  /** The complete ticket + effect + evidence-outbox logical transaction. */
  readonly nextRecord: SafeCodingLedgerRecord;
}

export type SafeCodingLedgerPersistenceCasResult =
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
 * Persistence TCB contract.
 *
 * `compareAndSwap` MUST atomically validate the expected record revision,
 * reserve every exported identity key, and replace the complete record. An
 * APPLIED response must not be returned until the guarantees declared by
 * `durability` are satisfied. `scan` must expose restart-visible records for a
 * durable adapter. The core validates returned shapes but cannot make a
 * dishonest or crash-unsafe adapter durable.
 */
export interface SafeCodingLedgerPersistenceTransactionPort {
  readonly durability: SafeCodingLedgerDurabilityContract;
  read(transactionId: string): Promise<unknown | null>;
  scan(): Promise<readonly unknown[]>;
  compareAndSwap(
    mutation: SafeCodingLedgerPersistenceMutation,
  ): Promise<SafeCodingLedgerPersistenceCasResult>;
}

export function validateSafeCodingLedgerDurabilityContract(
  value: unknown,
): SafeCodingLedgerDurabilityContract {
  const record = requireRecord(value, 'Ledger durability contract');
  requireExactKeys(
    record,
    [
      'version',
      'mode',
      'adapterId',
      'atomicScope',
      'atomicRecordAndOutbox',
      'stableBeforeSuccess',
      'restartReadable',
      'multiProcessCas',
    ],
    'Ledger durability contract',
  );
  if (record.version !== SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION) {
    throw validationError('Ledger durability contract version is invalid');
  }
  const adapterId = requireIdentifier(record.adapterId, 'Ledger adapter ID');
  if (record.mode === 'memory-only') {
    if (
      record.atomicScope !== 'single-js-isolate' ||
      record.atomicRecordAndOutbox !== true ||
      record.stableBeforeSuccess !== false ||
      record.restartReadable !== false ||
      record.multiProcessCas !== false
    ) {
      throw validationError(
        'Memory-only durability declaration is inconsistent',
      );
    }
    return Object.freeze({
      version: SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION,
      mode: 'memory-only',
      adapterId,
      atomicScope: 'single-js-isolate',
      atomicRecordAndOutbox: true,
      stableBeforeSuccess: false,
      restartReadable: false,
      multiProcessCas: false,
    });
  }
  if (record.mode === 'adapter-declared-durable') {
    if (
      record.atomicScope !== 'storage-transaction' ||
      record.atomicRecordAndOutbox !== true ||
      record.stableBeforeSuccess !== true ||
      record.restartReadable !== true ||
      record.multiProcessCas !== true
    ) {
      throw validationError('Durable adapter declaration is inconsistent');
    }
    return Object.freeze({
      version: SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION,
      mode: 'adapter-declared-durable',
      adapterId,
      atomicScope: 'storage-transaction',
      atomicRecordAndOutbox: true,
      stableBeforeSuccess: true,
      restartReadable: true,
      multiProcessCas: true,
    });
  }
  throw validationError('Ledger durability mode is invalid');
}

export function validateSafeCodingLedgerPersistenceCasResult(
  value: unknown,
): SafeCodingLedgerPersistenceCasResult {
  const record = requireRecord(value, 'Ledger persistence CAS result');
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
    return Object.freeze({
      outcome: 'IDENTITY_CONFLICT',
      identityKey: requireIdentityKey(record.identityKey, 'CAS identity key'),
    });
  }
  throw validationError('Ledger persistence CAS outcome is invalid');
}

export function validatePersistenceRecord(
  value: unknown,
): SafeCodingLedgerRecord {
  try {
    return validateSafeCodingLedgerRecord(value);
  } catch (error) {
    throw validationError(
      'Persistence returned an invalid ledger record',
      error,
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
    throw validationError(`${label} must be a closed data record`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw validationError(`${label} has unknown or missing fields`);
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw validationError(`${label} must be a bounded identifier`);
  }
  return value;
}

function requireIdentityKey(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw validationError(`${label} must be a bounded replay identity key`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw validationError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function validationError(message: string, cause?: unknown) {
  const error = new SafeCodingLedgerValidationError(message);
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
