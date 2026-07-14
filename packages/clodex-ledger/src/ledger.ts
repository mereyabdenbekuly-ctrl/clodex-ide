import { canonicalizeJson, parseCanonicalJson } from '@clodex/contracts';
import {
  SAFE_CODING_LEDGER_RECORD_LIMITS,
  SafeCodingLedgerValidationError,
  cloneSafeCodingLedgerRecord,
  safeCodingLedgerIdentityKeys,
  type SafeCodingLedgerRecord,
} from './records.js';
import { classifySafeCodingLedgerRecovery } from './recovery.js';
import {
  validatePersistenceRecord,
  validateSafeCodingLedgerDurabilityContract,
  validateSafeCodingLedgerPersistenceCasResult,
  type SafeCodingLedgerDurabilityContract,
  type SafeCodingLedgerPersistenceCasResult,
  type SafeCodingLedgerPersistenceMutation,
  type SafeCodingLedgerPersistenceTransactionPort,
} from './persistence.js';
import {
  closeSafeCodingLedgerCommitted,
  closeSafeCodingLedgerFailedPreEffect,
  closeSafeCodingLedgerResultUnavailable,
  closeSafeCodingLedgerUncertain,
  createPreparedSafeCodingLedgerRecord,
  markSafeCodingLedgerEvidenceAdmitted,
  recordSafeCodingCommitPermit,
  type AdmitLedgerEvidenceInput,
  type CloseCommittedLedgerInput,
  type CloseFailedPreEffectLedgerInput,
  type CloseResultUnavailableLedgerInput,
  type CloseUncertainLedgerInput,
  type PrepareSafeCodingLedgerInput,
  type SafeCodingLedgerCommitPermit,
} from './transitions.js';

export type SafeCodingLedgerErrorCode =
  | 'cas-conflict'
  | 'identity-conflict'
  | 'not-found'
  | 'persistence-invalid'
  | 'persistence-unavailable';

export const SAFE_CODING_LEDGER_SCAN_LIMITS = Object.freeze({
  maximumRecords: 4096,
  maximumAggregateBytes: 32 * 1024 * 1024,
  maximumRecordBytes: SAFE_CODING_LEDGER_RECORD_LIMITS.maximumStringBytes,
} as const);

export class SafeCodingLedgerError extends Error {
  public constructor(
    public readonly code: SafeCodingLedgerErrorCode,
    message: string,
    public readonly transactionId: string | null,
    public readonly expectedRevision: number | null,
    public readonly actualRevision: number | null,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'SafeCodingLedgerError';
  }
}

interface RevisionedLedgerMutation {
  readonly transactionId: string;
  readonly expectedRevision: number;
}

/**
 * Platform-neutral state-machine facade. It validates every persistence read
 * and every CAS response. No operation retries a CAS or an effect implicitly.
 */
export class SafeCodingEffectLedger {
  public readonly durability: SafeCodingLedgerDurabilityContract;

  readonly #read: (transactionId: string) => Promise<unknown | null>;
  readonly #scan: () => Promise<readonly unknown[]>;
  readonly #compareAndSwap: (
    mutation: SafeCodingLedgerPersistenceMutation,
  ) => ReturnType<SafeCodingLedgerPersistenceTransactionPort['compareAndSwap']>;

  public constructor(port: SafeCodingLedgerPersistenceTransactionPort) {
    this.durability = validateSafeCodingLedgerDurabilityContract(
      readDataProperty(port, 'durability'),
    );
    this.#read = pinMethod(port, 'read');
    this.#scan = pinMethod(port, 'scan');
    this.#compareAndSwap = pinMethod(port, 'compareAndSwap');
  }

  public async createPrepared(
    input: PrepareSafeCodingLedgerInput,
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotDataInput<PrepareSafeCodingLedgerInput>(
      input,
      [
        'ticket',
        'attemptId',
        'evidenceIntentId',
        'attestationId',
        'evidenceExpectation',
        'now',
      ],
      'PREPARED mutation input',
    );
    const next = createPreparedSafeCodingLedgerRecord(snapshot);
    return await this.apply({
      transactionId: next.transactionId,
      expectedRevision: null,
      nextRecord: next,
    });
  }

  public async recordCommitPermit(
    input: RevisionedLedgerMutation & {
      readonly permit: SafeCodingLedgerCommitPermit;
    },
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotMutationInput<
      RevisionedLedgerMutation & {
        readonly permit: SafeCodingLedgerCommitPermit;
      }
    >(input, ['transactionId', 'expectedRevision', 'permit']);
    return await this.mutate(snapshot, (record) =>
      recordSafeCodingCommitPermit(record, snapshot.permit),
    );
  }

  public async closeCommitted(
    input: RevisionedLedgerMutation & CloseCommittedLedgerInput,
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotMutationInput<
      RevisionedLedgerMutation & CloseCommittedLedgerInput
    >(input, [
      'transactionId',
      'expectedRevision',
      'now',
      'attestation',
      'resultHash',
    ]);
    return await this.mutate(snapshot, (record) =>
      closeSafeCodingLedgerCommitted(record, snapshot),
    );
  }

  public async closeResultUnavailable(
    input: RevisionedLedgerMutation & CloseResultUnavailableLedgerInput,
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotMutationInput<
      RevisionedLedgerMutation & CloseResultUnavailableLedgerInput
    >(input, [
      'transactionId',
      'expectedRevision',
      'now',
      'attestation',
      'resultHash',
      'reasonCode',
    ]);
    return await this.mutate(snapshot, (record) =>
      closeSafeCodingLedgerResultUnavailable(record, snapshot),
    );
  }

  public async closeUncertain(
    input: RevisionedLedgerMutation & CloseUncertainLedgerInput,
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotMutationInput<
      RevisionedLedgerMutation & CloseUncertainLedgerInput
    >(input, [
      'transactionId',
      'expectedRevision',
      'now',
      'attestation',
      'resultHash',
      'reasonCode',
      'effectCompletionObserved',
    ]);
    return await this.mutate(snapshot, (record) =>
      closeSafeCodingLedgerUncertain(record, snapshot),
    );
  }

  public async closeFailedPreEffect(
    input: RevisionedLedgerMutation & CloseFailedPreEffectLedgerInput,
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotMutationInput<
      RevisionedLedgerMutation & CloseFailedPreEffectLedgerInput
    >(input, [
      'transactionId',
      'expectedRevision',
      'now',
      'attestation',
      'reasonCode',
    ]);
    return await this.mutate(snapshot, (record) =>
      closeSafeCodingLedgerFailedPreEffect(record, snapshot),
    );
  }

  public async markEvidenceAdmitted(
    input: RevisionedLedgerMutation & AdmitLedgerEvidenceInput,
  ): Promise<SafeCodingLedgerRecord> {
    const snapshot = snapshotVerifiedReceiptMutation(input);
    return await this.mutate(snapshot, (record) =>
      markSafeCodingLedgerEvidenceAdmitted(record, snapshot),
    );
  }

  public async get(
    transactionId: string,
  ): Promise<SafeCodingLedgerRecord | null> {
    let value: unknown | null;
    try {
      value = await this.#read(transactionId);
    } catch (error) {
      throw persistenceUnavailable(transactionId, null, error);
    }
    if (value === null) return null;
    try {
      const record = validatePersistenceRecord(value);
      if (record.transactionId !== transactionId) {
        throw new SafeCodingLedgerValidationError(
          'Persistence read returned the wrong transaction',
        );
      }
      return cloneSafeCodingLedgerRecord(record);
    } catch (error) {
      throw persistenceInvalid(transactionId, null, error);
    }
  }

  public async scan(): Promise<readonly SafeCodingLedgerRecord[]> {
    let values: unknown;
    try {
      values = await this.#scan();
    } catch (error) {
      throw persistenceUnavailable(null, null, error);
    }
    const rows = validateBoundedScanRows(values);
    const transactionIds = new Set<string>();
    const identityOwners = new Map<string, string>();
    let aggregateBytes = 0;
    const records = rows.map((value) => {
      let record: SafeCodingLedgerRecord;
      try {
        record = validatePersistenceRecord(value);
      } catch (error) {
        throw persistenceInvalid(null, null, error);
      }
      if (transactionIds.has(record.transactionId)) {
        throw persistenceInvalid(
          record.transactionId,
          null,
          new Error('scan returned duplicate transaction'),
        );
      }
      transactionIds.add(record.transactionId);
      for (const identityKey of safeCodingLedgerIdentityKeys(record)) {
        const owner = identityOwners.get(identityKey);
        if (owner !== undefined && owner !== record.transactionId) {
          throw persistenceInvalid(
            record.transactionId,
            null,
            new Error(
              `scan returned replay identity ${identityKey} owned by ${owner}`,
            ),
          );
        }
        identityOwners.set(identityKey, record.transactionId);
      }
      const canonical = canonicalizeJson(record);
      const recordBytes = utf8ByteLength(canonical);
      if (recordBytes > SAFE_CODING_LEDGER_SCAN_LIMITS.maximumRecordBytes) {
        throw persistenceInvalid(
          record.transactionId,
          null,
          new Error('scan record exceeds the byte limit'),
        );
      }
      aggregateBytes += recordBytes;
      if (
        aggregateBytes > SAFE_CODING_LEDGER_SCAN_LIMITS.maximumAggregateBytes
      ) {
        throw persistenceInvalid(
          null,
          null,
          new Error('scan exceeds the aggregate byte limit'),
        );
      }
      return cloneSafeCodingLedgerRecord(record);
    });
    return Object.freeze(
      records.sort((left, right) =>
        compareStrings(left.transactionId, right.transactionId),
      ),
    );
  }

  public async scanRecovery() {
    const records = await this.scan();
    return Object.freeze(records.map(classifySafeCodingLedgerRecovery));
  }

  public async pendingEvidence(): Promise<readonly SafeCodingLedgerRecord[]> {
    const records = await this.scan();
    return Object.freeze(
      records.filter((record) => record.evidenceAdmission.status === 'PENDING'),
    );
  }

  private async mutate(
    input: RevisionedLedgerMutation,
    transition: (record: SafeCodingLedgerRecord) => SafeCodingLedgerRecord,
  ): Promise<SafeCodingLedgerRecord> {
    const current = await this.get(input.transactionId);
    if (!current) {
      throw new SafeCodingLedgerError(
        'not-found',
        'Ledger transaction does not exist',
        input.transactionId,
        input.expectedRevision,
        null,
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new SafeCodingLedgerError(
        'cas-conflict',
        'Ledger revision does not match caller expectation',
        input.transactionId,
        input.expectedRevision,
        current.revision,
      );
    }
    const next = transition(current);
    return await this.apply({
      transactionId: input.transactionId,
      expectedRevision: input.expectedRevision,
      nextRecord: next,
    });
  }

  private async apply(
    mutation: SafeCodingLedgerPersistenceMutation,
  ): Promise<SafeCodingLedgerRecord> {
    const transactionId = mutation.transactionId;
    const expectedRevision = mutation.expectedRevision;
    const expectedRecordCanonical = canonicalizeJson(mutation.nextRecord);
    const pinnedMutation = Object.freeze({
      transactionId,
      expectedRevision,
      nextRecord: mutation.nextRecord,
    });
    let rawResult: unknown;
    try {
      rawResult = await this.#compareAndSwap(pinnedMutation);
    } catch (error) {
      throw persistenceUnavailable(transactionId, expectedRevision, error);
    }
    let result: SafeCodingLedgerPersistenceCasResult;
    try {
      result = validateSafeCodingLedgerPersistenceCasResult(rawResult);
    } catch (error) {
      throw persistenceInvalid(transactionId, expectedRevision, error);
    }
    if (result.outcome === 'REVISION_CONFLICT') {
      throw new SafeCodingLedgerError(
        'cas-conflict',
        'Persistence rejected ledger revision CAS',
        transactionId,
        expectedRevision,
        result.actualRevision,
      );
    }
    if (result.outcome === 'IDENTITY_CONFLICT') {
      throw new SafeCodingLedgerError(
        'identity-conflict',
        `Persistence rejected replay identity ${result.identityKey}`,
        transactionId,
        expectedRevision,
        null,
      );
    }
    let applied: SafeCodingLedgerRecord;
    try {
      applied = validatePersistenceRecord(result.record);
    } catch (error) {
      throw persistenceInvalid(transactionId, expectedRevision, error);
    }
    if (
      applied.transactionId !== transactionId ||
      canonicalizeJson(applied) !== expectedRecordCanonical
    ) {
      throw persistenceInvalid(
        transactionId,
        expectedRevision,
        new Error('APPLIED result differs from requested atomic record'),
      );
    }
    return cloneSafeCodingLedgerRecord(applied);
  }
}

function validateBoundedScanRows(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw persistenceInvalid(
      null,
      null,
      new Error('scan did not return an ordinary array'),
    );
  }
  if (value.length > SAFE_CODING_LEDGER_SCAN_LIMITS.maximumRecords) {
    throw persistenceInvalid(
      null,
      null,
      new Error('scan exceeds the record-count limit'),
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw persistenceInvalid(null, null, new Error('scan array has symbols'));
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    names[names.length - 1] !== 'length' ||
    Object.keys(value).some((key, index) => key !== String(index))
  ) {
    throw persistenceInvalid(
      null,
      null,
      new Error('scan returned a sparse or extended array'),
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw persistenceInvalid(
        null,
        null,
        new Error('scan array contains an accessor'),
      );
    }
  }
  return value;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotMutationInput<Value extends RevisionedLedgerMutation>(
  value: Value,
  expectedKeys: readonly string[],
): Value {
  const snapshot = snapshotDataInput<Value>(
    value,
    expectedKeys,
    'Ledger mutation input',
  );
  validateMutationIdentity(snapshot as RevisionedLedgerMutation);
  return snapshot;
}

function snapshotDataInput<Value>(
  value: Value,
  expectedKeys: readonly string[],
  label: string,
): Value {
  assertClosedDataTree(value, expectedKeys, label);
  let snapshot: unknown;
  try {
    snapshot = parseCanonicalJson(canonicalizeJson(value));
  } catch (error) {
    throw new SafeCodingLedgerValidationError(
      error instanceof Error
        ? `${label} is invalid: ${error.message}`
        : `${label} is invalid`,
    );
  }
  return deepFreeze(snapshot) as Value;
}

function snapshotVerifiedReceiptMutation(
  value: RevisionedLedgerMutation & AdmitLedgerEvidenceInput,
): RevisionedLedgerMutation & AdmitLedgerEvidenceInput {
  const record = requireClosedTopLevelRecord(
    value,
    ['transactionId', 'expectedRevision', 'receipt'],
    'Evidence-admission mutation input',
  );
  const snapshot = Object.freeze({
    transactionId: record.transactionId,
    expectedRevision: record.expectedRevision,
    receipt: record.receipt,
  }) as RevisionedLedgerMutation & AdmitLedgerEvidenceInput;
  validateMutationIdentity(snapshot);
  return snapshot;
}

function validateMutationIdentity(value: RevisionedLedgerMutation): void {
  if (
    typeof value.transactionId !== 'string' ||
    value.transactionId.length === 0 ||
    value.transactionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value.transactionId)
  ) {
    throw new SafeCodingLedgerValidationError(
      'Ledger mutation transactionId is invalid',
    );
  }
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1
  ) {
    throw new SafeCodingLedgerValidationError(
      'Ledger mutation expectedRevision is invalid',
    );
  }
}

function assertClosedDataTree(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): void {
  requireClosedTopLevelRecord(value, expectedKeys, label);
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > 1024) {
      throw new SafeCodingLedgerValidationError(`${label} is too large`);
    }
    if (current === null || typeof current !== 'object') continue;
    if (visited.has(current)) {
      throw new SafeCodingLedgerValidationError(`${label} contains aliases`);
    }
    visited.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      (Array.isArray(current) && prototype !== Array.prototype) ||
      (!Array.isArray(current) &&
        prototype !== Object.prototype &&
        prototype !== null)
    ) {
      throw new SafeCodingLedgerValidationError(
        `${label} contains a non-data container`,
      );
    }
    if (Object.getOwnPropertySymbols(current).length !== 0) {
      throw new SafeCodingLedgerValidationError(`${label} contains symbols`);
    }
    const names = Object.getOwnPropertyNames(current);
    if (names.length > 128) {
      throw new SafeCodingLedgerValidationError(`${label} is too wide`);
    }
    for (const name of names) {
      if (name === 'length' && Array.isArray(current)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new SafeCodingLedgerValidationError(
          `${label} contains an accessor or hidden field`,
        );
      }
      pending.push(descriptor.value);
    }
  }
}

function requireClosedTopLevelRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new SafeCodingLedgerValidationError(
      `${label} must be a plain record`,
    );
  }
  const names = Object.getOwnPropertyNames(value);
  const expected = [...expectedKeys].sort();
  const actual = [...names].sort();
  if (
    names.length !== Object.keys(value).length ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new SafeCodingLedgerValidationError(
      `${label} has unknown, hidden, or missing fields`,
    );
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) {
      throw new SafeCodingLedgerValidationError(
        `${label} contains an accessor`,
      );
    }
  }
  return value as Record<string, unknown>;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function pinMethod<
  Name extends 'read' | 'scan' | 'compareAndSwap',
  Port extends SafeCodingLedgerPersistenceTransactionPort,
>(port: Port, name: Name): Port[Name] {
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new SafeCodingLedgerValidationError(
          `Persistence ${name} must be a data method`,
        );
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new SafeCodingLedgerValidationError(
    `Persistence ${name} method is missing`,
  );
}

function readDataProperty(
  port: SafeCodingLedgerPersistenceTransactionPort,
  name: 'durability',
): unknown {
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor)) {
        throw new SafeCodingLedgerValidationError(
          'Persistence durability must be a data property',
        );
      }
      return descriptor.value;
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new SafeCodingLedgerValidationError(
    'Persistence durability declaration is missing',
  );
}

function persistenceUnavailable(
  transactionId: string | null,
  expectedRevision: number | null,
  cause: unknown,
) {
  return new SafeCodingLedgerError(
    'persistence-unavailable',
    'Ledger persistence operation failed closed',
    transactionId,
    expectedRevision,
    null,
    cause,
  );
}

function persistenceInvalid(
  transactionId: string | null,
  expectedRevision: number | null,
  cause: unknown,
) {
  return new SafeCodingLedgerError(
    'persistence-invalid',
    'Ledger persistence returned invalid state',
    transactionId,
    expectedRevision,
    null,
    cause,
  );
}
