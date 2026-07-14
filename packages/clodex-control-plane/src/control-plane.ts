import { canonicalizeJson, encodeUtf8 } from '@clodex/contracts';
import {
  CONTROL_PLANE_RECORD_LIMITS,
  ControlPlaneValidationError,
  cloneControlPlaneTransactionRecord,
  controlPlaneIdentityKeys,
  snapshotClosedData,
  validateControlPlaneEvidenceAdmissionReceipt,
  validateTrustedCommitPermitAdmission,
  type ControlPlaneEvidenceAdmissionReceipt,
  type ControlPlaneTransactionRecord,
  type TrustedCommitPermitAdmission,
} from './model.js';
import type {
  CommitPermitAuthorityPort,
  CommitPermitBinding,
  ControlPlaneEffectExecutionRequest,
  ControlPlaneEffectObservation,
  ControlPlaneEffectPort,
  ControlPlaneFaultInjector,
  ControlPlaneFaultPoint,
  EvidenceAdmissionReceiptPort,
  EvidenceReceiptBinding,
  TrustedSynchronousClock,
} from './ports.js';
import {
  classifyControlPlaneRecovery,
  type ControlPlaneRecoveryDecision,
} from './recovery.js';
import {
  validateControlPlaneDurabilityContract,
  validateControlPlanePersistenceRecord,
  validateControlPlaneStorageCasResult,
  type ControlPlaneDurabilityContract,
  type ControlPlanePreCommitFence,
  type ControlPlaneStorageCasResult,
  type ControlPlaneStorageMutation,
  type ControlPlaneStorageTransactionPort,
} from './storage.js';
import {
  closeControlPlaneFailedBeforePermit,
  closeControlPlaneFromEffectObservation,
  closeControlPlaneUncertainAfterPermit,
  consumeCommitPermit,
  createPreparedControlPlaneRecord,
  markControlPlaneEffectInFlight,
  markControlPlaneEvidenceDelivered,
  type PrepareControlPlaneTransactionInput,
} from './transitions.js';

export const CONTROL_PLANE_SCAN_LIMITS = Object.freeze({
  maximumRecords: 4096,
  maximumAggregateBytes: 64 * 1024 * 1024,
  maximumRecordBytes: CONTROL_PLANE_RECORD_LIMITS.maximumRecordBytes,
} as const);

export type ControlPlaneErrorCode =
  | 'authority-rejected'
  | 'cas-conflict'
  | 'effect-not-executable'
  | 'evidence-rejected'
  | 'identity-conflict'
  | 'input-invalid'
  | 'not-found'
  | 'persistence-invalid'
  | 'persistence-unavailable'
  | 'post-effect-persistence-unavailable';

export class ControlPlaneError extends Error {
  public constructor(
    public readonly code: ControlPlaneErrorCode,
    message: string,
    public readonly transactionId: string | null,
    public readonly expectedRevision: number | null,
    public readonly actualRevision: number | null,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export type PrepareControlPlaneInput = Omit<
  PrepareControlPlaneTransactionInput,
  'now'
>;

export interface ConsumeCommitPermitInput {
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly permitEnvelope: unknown;
}

export interface ExecuteControlPlaneEffectInput {
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly effect: ControlPlaneEffectPort;
}

export interface AbortPreparedControlPlaneInput {
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly reasonCode: string;
}

export interface RecoverControlPlaneInput {
  readonly transactionId: string;
  readonly expectedRevision: number;
}

export interface DeliverControlPlaneEvidenceInput {
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly receiptEnvelope: unknown;
}

export interface ControlPlaneRecoveryResult {
  readonly decision: ControlPlaneRecoveryDecision;
  readonly record: ControlPlaneTransactionRecord;
  readonly mutated: boolean;
}

export interface ExecutionControlPlaneOptions {
  readonly storage: ControlPlaneStorageTransactionPort;
  readonly clock: TrustedSynchronousClock;
  readonly commitPermits: CommitPermitAuthorityPort;
  readonly evidenceReceipts?: EvidenceAdmissionReceiptPort;
  readonly faultInjector?: ControlPlaneFaultInjector;
}

/**
 * Runtime-owned local atomic coordinator.
 *
 * It atomically persists local ticket consumption, COMMIT_PERMIT, ledger, and
 * outbox projections. It executes at most one in-process attempt and recovery
 * never calls an effect port. The external effect is deliberately outside the
 * storage transaction; any ambiguous post-permit boundary is closed UNCERTAIN.
 */
export class ExecutionControlPlane {
  public readonly durability: ControlPlaneDurabilityContract;

  readonly #read: (transactionId: string) => Promise<unknown | null>;
  readonly #scan: () => Promise<readonly unknown[]>;
  readonly #compareAndSwap: (
    mutation: ControlPlaneStorageMutation,
  ) => ReturnType<ControlPlaneStorageTransactionPort['compareAndSwap']>;
  readonly #now: () => string;
  readonly #verifyPermit: (
    permitEnvelope: unknown,
    binding: CommitPermitBinding,
  ) => unknown;
  readonly #assertPermitTrusted: (
    permit: TrustedCommitPermitAdmission,
    binding: CommitPermitBinding,
  ) => void;
  readonly #verifyEvidenceReceipt:
    | ((receiptEnvelope: unknown, binding: EvidenceReceiptBinding) => unknown)
    | null;
  readonly #assertEvidenceReceiptTrusted:
    | ((
        receipt: ControlPlaneEvidenceAdmissionReceipt,
        binding: EvidenceReceiptBinding,
      ) => void)
    | null;
  readonly #injectFault: ControlPlaneFaultInjector['inject'] | null;

  public constructor(options: ExecutionControlPlaneOptions) {
    const storage = readDataProperty(options, 'storage');
    const clock = readDataProperty(options, 'clock');
    const commitPermits = readDataProperty(options, 'commitPermits');
    const evidenceReceipts = readOptionalDataProperty(
      options,
      'evidenceReceipts',
    );
    const faultInjector = readOptionalDataProperty(options, 'faultInjector');
    this.durability = validateControlPlaneDurabilityContract(
      readDataProperty(storage, 'durability'),
    );
    this.#read = pinMethod(storage, 'read', 'Storage port');
    this.#scan = pinMethod(storage, 'scan', 'Storage port');
    this.#compareAndSwap = pinMethod(storage, 'compareAndSwap', 'Storage port');
    this.#now = pinMethod(clock, 'now', 'Trusted clock');
    this.#verifyPermit = pinMethod(
      commitPermits,
      'verifySynchronously',
      'COMMIT_PERMIT authority port',
    );
    this.#assertPermitTrusted = pinMethod(
      commitPermits,
      'assertTrustedSynchronously',
      'COMMIT_PERMIT authority port',
    );
    this.#verifyEvidenceReceipt =
      evidenceReceipts === undefined
        ? null
        : pinMethod(
            evidenceReceipts,
            'verifySynchronously',
            'Evidence receipt port',
          );
    this.#assertEvidenceReceiptTrusted =
      evidenceReceipts === undefined
        ? null
        : pinMethod(
            evidenceReceipts,
            'assertTrustedSynchronously',
            'Evidence receipt port',
          );
    this.#injectFault =
      faultInjector === undefined
        ? null
        : pinMethod(faultInjector, 'inject', 'Fault injector');
  }

  public async prepare(
    inputValue: PrepareControlPlaneInput,
  ): Promise<ControlPlaneTransactionRecord> {
    const input = snapshotPrepareInput(inputValue);
    const next = createPreparedControlPlaneRecord({
      ...input,
      now: this.#trustedNow(),
    });
    const applied = await this.#apply({
      transactionId: next.transactionId,
      expectedRevision: null,
      nextRecord: next,
    });
    await this.#fault('after-prepare-durable');
    return applied;
  }

  public async consumeCommitPermit(
    inputValue: ConsumeCommitPermitInput,
  ): Promise<ControlPlaneTransactionRecord> {
    const input = snapshotMutationEnvelopeInput(
      inputValue,
      'permitEnvelope',
      'COMMIT_PERMIT input',
    );
    const current = await this.#getExpected(
      input.transactionId,
      input.expectedRevision,
    );
    if (current.phase !== 'PREPARED') {
      throw controlPlaneError(
        'authority-rejected',
        'Only PREPARED may consume COMMIT_PERMIT',
        current.transactionId,
        input.expectedRevision,
        current.revision,
      );
    }
    const binding = commitPermitBinding(current);
    const permit = this.#admitPermit(input.envelope, binding, current);
    const next = consumeCommitPermit(current, permit, this.#trustedNow());
    const applied = await this.#apply({
      transactionId: current.transactionId,
      expectedRevision: current.revision,
      nextRecord: next,
      preCommitFence: this.#permitFence(permit, binding, current.transactionId),
    });
    await this.#fault('after-commit-permit-durable');
    return applied;
  }

  public async executeOnce(
    inputValue: ExecuteControlPlaneEffectInput,
  ): Promise<ControlPlaneTransactionRecord> {
    const input = snapshotEffectInput(inputValue);
    const execute = pinMethod(input.effect, 'executeOnce', 'Effect port');
    const current = await this.#getExpected(
      input.transactionId,
      input.expectedRevision,
    );
    if (current.phase !== 'COMMIT_PERMIT' || current.commitPermit === null) {
      throw controlPlaneError(
        'effect-not-executable',
        'Transaction is not at the one-shot effect boundary',
        current.transactionId,
        input.expectedRevision,
        current.revision,
      );
    }
    const binding = commitPermitBinding(current);
    const inFlight = markControlPlaneEffectInFlight(
      current,
      this.#trustedNow(),
    );
    const armed = await this.#apply({
      transactionId: current.transactionId,
      expectedRevision: current.revision,
      nextRecord: inFlight,
      preCommitFence: this.#permitFence(
        current.commitPermit,
        binding,
        current.transactionId,
      ),
    });
    await this.#fault('after-effect-in-flight-durable');

    const request = effectExecutionRequest(armed);
    let observation: ControlPlaneEffectObservation;
    try {
      const rawObservation = await execute(request);
      try {
        observation = validateEffectObservation(rawObservation);
      } catch {
        observation = Object.freeze({
          outcome: 'UNCERTAIN',
          reasonCode: 'executor-invalid-observation',
        });
      }
    } catch {
      observation = Object.freeze({
        outcome: 'UNCERTAIN',
        reasonCode: 'executor-threw',
      });
    }

    await this.#fault('after-effect-observation-before-terminal-durable');
    let terminal: ControlPlaneTransactionRecord;
    try {
      terminal = closeControlPlaneFromEffectObservation(
        armed,
        observation,
        this.#trustedNow(),
      );
      terminal = await this.#apply({
        transactionId: armed.transactionId,
        expectedRevision: armed.revision,
        nextRecord: terminal,
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'cas-conflict') {
        throw error;
      }
      throw controlPlaneError(
        'post-effect-persistence-unavailable',
        'Effect was attempted but terminal local settlement was not confirmed',
        armed.transactionId,
        armed.revision,
        null,
        error,
      );
    }
    await this.#fault('after-terminal-durable');
    return terminal;
  }

  public async abortPrepared(
    inputValue: AbortPreparedControlPlaneInput,
  ): Promise<ControlPlaneTransactionRecord> {
    const input = snapshotSimpleMutationInput(
      inputValue,
      ['transactionId', 'expectedRevision', 'reasonCode'],
      'Abort PREPARED input',
    ) as unknown as AbortPreparedControlPlaneInput;
    const current = await this.#getExpected(
      input.transactionId,
      input.expectedRevision,
    );
    const next = closeControlPlaneFailedBeforePermit(
      current,
      requireReasonCode(input.reasonCode),
      this.#trustedNow(),
    );
    const applied = await this.#apply({
      transactionId: current.transactionId,
      expectedRevision: current.revision,
      nextRecord: next,
    });
    await this.#fault('after-terminal-durable');
    return applied;
  }

  public async recover(
    inputValue: RecoverControlPlaneInput,
  ): Promise<ControlPlaneRecoveryResult> {
    const input = snapshotSimpleMutationInput(
      inputValue,
      ['transactionId', 'expectedRevision'],
      'Recovery input',
    ) as unknown as RecoverControlPlaneInput;
    const current = await this.#getExpected(
      input.transactionId,
      input.expectedRevision,
    );
    const decision = classifyControlPlaneRecovery(current);
    if (
      decision.action !== 'CLOSE_FAILED_PRE_EFFECT' &&
      decision.action !== 'CLOSE_UNCERTAIN'
    ) {
      return Object.freeze({ decision, record: current, mutated: false });
    }
    const now = this.#trustedNow();
    const next =
      decision.action === 'CLOSE_FAILED_PRE_EFFECT'
        ? closeControlPlaneFailedBeforePermit(current, decision.reasonCode, now)
        : closeControlPlaneUncertainAfterPermit(
            current,
            decision.reasonCode,
            now,
          );
    const applied = await this.#apply({
      transactionId: current.transactionId,
      expectedRevision: current.revision,
      nextRecord: next,
    });
    await this.#fault('after-recovery-terminal-durable');
    return Object.freeze({
      decision,
      record: applied,
      mutated: true,
    });
  }

  /**
   * Reconciles restart-visible records one CAS at a time, without retries and
   * without ever accepting an effect port. A conflict stops the pass so a
   * caller must rescan rather than apply a stale recovery decision.
   */
  public async recoverAll(): Promise<readonly ControlPlaneRecoveryResult[]> {
    const records = await this.scan();
    const results: ControlPlaneRecoveryResult[] = [];
    for (const record of records) {
      const decision = classifyControlPlaneRecovery(record);
      if (
        decision.action === 'CLOSE_FAILED_PRE_EFFECT' ||
        decision.action === 'CLOSE_UNCERTAIN'
      ) {
        results.push(
          await this.recover({
            transactionId: record.transactionId,
            expectedRevision: record.revision,
          }),
        );
      } else {
        results.push(Object.freeze({ decision, record, mutated: false }));
      }
    }
    return Object.freeze(results);
  }

  public async deliverEvidence(
    inputValue: DeliverControlPlaneEvidenceInput,
  ): Promise<ControlPlaneTransactionRecord> {
    const verifyReceipt = this.#verifyEvidenceReceipt;
    const assertTrusted = this.#assertEvidenceReceiptTrusted;
    if (verifyReceipt === null || assertTrusted === null) {
      throw controlPlaneError(
        'evidence-rejected',
        'No evidence receipt verifier is configured',
        null,
        null,
        null,
      );
    }
    const input = snapshotMutationEnvelopeInput(
      inputValue,
      'receiptEnvelope',
      'Evidence delivery input',
    );
    const current = await this.#getExpected(
      input.transactionId,
      input.expectedRevision,
    );
    const binding = evidenceReceiptBinding(current);
    let receipt: ControlPlaneEvidenceAdmissionReceipt;
    try {
      receipt = validateControlPlaneEvidenceAdmissionReceipt(
        verifyReceipt(input.envelope, binding),
      );
    } catch (error) {
      throw controlPlaneError(
        'evidence-rejected',
        'Evidence admission receipt verification failed',
        current.transactionId,
        current.revision,
        current.revision,
        error,
      );
    }
    const next = markControlPlaneEvidenceDelivered(current, receipt);
    const fence: ControlPlanePreCommitFence = () => {
      try {
        assertSynchronousVoid(assertTrusted(receipt, binding));
      } catch (error) {
        throw controlPlaneError(
          'evidence-rejected',
          'Evidence admission trust fence rejected the receipt',
          current.transactionId,
          current.revision,
          current.revision,
          error,
        );
      }
    };
    const applied = await this.#apply({
      transactionId: current.transactionId,
      expectedRevision: current.revision,
      nextRecord: next,
      preCommitFence: fence,
    });
    await this.#fault('after-evidence-delivered-durable');
    return applied;
  }

  public async get(
    transactionId: string,
  ): Promise<ControlPlaneTransactionRecord | null> {
    requireIdentifier(transactionId, 'Transaction ID');
    let raw: unknown | null;
    try {
      raw = await this.#read(transactionId);
    } catch (error) {
      throw controlPlaneError(
        'persistence-unavailable',
        'Control-plane persistence read failed',
        transactionId,
        null,
        null,
        error,
      );
    }
    if (raw === null) return null;
    try {
      const record = validateControlPlanePersistenceRecord(raw);
      if (record.transactionId !== transactionId) {
        throw new ControlPlaneValidationError(
          'Persistence returned the wrong transaction',
        );
      }
      return cloneControlPlaneTransactionRecord(record);
    } catch (error) {
      throw controlPlaneError(
        'persistence-invalid',
        'Control-plane persistence returned invalid data',
        transactionId,
        null,
        null,
        error,
      );
    }
  }

  public async scan(): Promise<readonly ControlPlaneTransactionRecord[]> {
    let raw: unknown;
    try {
      raw = await this.#scan();
    } catch (error) {
      throw controlPlaneError(
        'persistence-unavailable',
        'Control-plane persistence scan failed',
        null,
        null,
        null,
        error,
      );
    }
    if (
      !Array.isArray(raw) ||
      raw.length > CONTROL_PLANE_SCAN_LIMITS.maximumRecords
    ) {
      throw controlPlaneError(
        'persistence-invalid',
        'Control-plane scan shape or record count is invalid',
        null,
        null,
        null,
      );
    }
    assertClosedArray(raw, 'Control-plane scan');
    const transactionIds = new Set<string>();
    const identityOwners = new Map<string, string>();
    let aggregateBytes = 0;
    const records = raw.map((value) => {
      const record = validateControlPlanePersistenceRecord(value);
      if (transactionIds.has(record.transactionId)) {
        throw controlPlaneError(
          'persistence-invalid',
          'Control-plane scan returned duplicate transaction IDs',
          record.transactionId,
          null,
          null,
        );
      }
      transactionIds.add(record.transactionId);
      for (const identityKey of controlPlaneIdentityKeys(record)) {
        const owner = identityOwners.get(identityKey);
        if (owner !== undefined && owner !== record.transactionId) {
          throw controlPlaneError(
            'persistence-invalid',
            'Control-plane scan returned a cross-record identity collision',
            record.transactionId,
            null,
            null,
          );
        }
        identityOwners.set(identityKey, record.transactionId);
      }
      const bytes = encodeUtf8(canonicalizeJson(record)).length;
      if (bytes > CONTROL_PLANE_SCAN_LIMITS.maximumRecordBytes) {
        throw controlPlaneError(
          'persistence-invalid',
          'Control-plane scan record exceeds its byte limit',
          record.transactionId,
          null,
          null,
        );
      }
      aggregateBytes += bytes;
      if (aggregateBytes > CONTROL_PLANE_SCAN_LIMITS.maximumAggregateBytes) {
        throw controlPlaneError(
          'persistence-invalid',
          'Control-plane scan exceeds its aggregate byte limit',
          null,
          null,
          null,
        );
      }
      return cloneControlPlaneTransactionRecord(record);
    });
    return Object.freeze(
      records.sort((left, right) =>
        compareStrings(left.transactionId, right.transactionId),
      ),
    );
  }

  public async pendingEvidence(): Promise<
    readonly ControlPlaneTransactionRecord[]
  > {
    const records = await this.scan();
    return Object.freeze(
      records.filter((record) => record.evidenceOutbox.status === 'READY'),
    );
  }

  async #getExpected(
    transactionId: string,
    expectedRevision: number,
  ): Promise<ControlPlaneTransactionRecord> {
    requireIdentifier(transactionId, 'Transaction ID');
    requirePositiveInteger(expectedRevision, 'Expected revision');
    const record = await this.get(transactionId);
    if (record === null) {
      throw controlPlaneError(
        'not-found',
        'Control-plane transaction does not exist',
        transactionId,
        expectedRevision,
        null,
      );
    }
    if (record.revision !== expectedRevision) {
      throw controlPlaneError(
        'cas-conflict',
        'Control-plane revision does not match caller expectation',
        transactionId,
        expectedRevision,
        record.revision,
      );
    }
    return record;
  }

  #admitPermit(
    envelope: unknown,
    binding: CommitPermitBinding,
    current: ControlPlaneTransactionRecord,
  ): TrustedCommitPermitAdmission {
    try {
      const permit = validateTrustedCommitPermitAdmission(
        this.#verifyPermit(envelope, binding),
      );
      assertPermitMatchesBinding(permit, binding);
      const now = this.#trustedNow();
      assertTimestampAtOrBefore(
        permit.admittedAt,
        now,
        'Permit admittedAt is in the future',
      );
      assertTimestampAtOrBefore(now, permit.expiresAt, 'Permit is expired');
      return permit;
    } catch (error) {
      throw controlPlaneError(
        'authority-rejected',
        'External COMMIT_PERMIT admission failed',
        current.transactionId,
        current.revision,
        current.revision,
        error,
      );
    }
  }

  #permitFence(
    permit: TrustedCommitPermitAdmission,
    binding: CommitPermitBinding,
    transactionId: string,
  ): ControlPlanePreCommitFence {
    return () => {
      try {
        const now = this.#trustedNow();
        assertTimestampAtOrBefore(
          permit.admittedAt,
          now,
          'Trusted clock moved before permit admission',
        );
        assertTimestampAtOrBefore(
          now,
          permit.expiresAt,
          'Permit expired at final fence',
        );
        assertSynchronousVoid(this.#assertPermitTrusted(permit, binding));
      } catch (error) {
        throw controlPlaneError(
          'authority-rejected',
          'Final COMMIT_PERMIT trust fence rejected authority',
          transactionId,
          null,
          null,
          error,
        );
      }
    };
  }

  #trustedNow(): string {
    let now: unknown;
    try {
      now = this.#now();
    } catch (error) {
      throw controlPlaneError(
        'input-invalid',
        'Trusted clock failed',
        null,
        null,
        null,
        error,
      );
    }
    return requireTimestamp(now, 'Trusted clock result');
  }

  async #apply(
    mutation: ControlPlaneStorageMutation,
  ): Promise<ControlPlaneTransactionRecord> {
    const expected = cloneControlPlaneTransactionRecord(mutation.nextRecord);
    const pinned = Object.freeze({
      transactionId: mutation.transactionId,
      expectedRevision: mutation.expectedRevision,
      nextRecord: expected,
      ...(mutation.preCommitFence === undefined
        ? {}
        : { preCommitFence: mutation.preCommitFence }),
    });
    let rawResult: unknown;
    try {
      rawResult = await this.#compareAndSwap(pinned);
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw controlPlaneError(
        'persistence-unavailable',
        'Control-plane storage transaction failed',
        mutation.transactionId,
        mutation.expectedRevision,
        null,
        error,
      );
    }
    let result: ControlPlaneStorageCasResult;
    try {
      result = validateControlPlaneStorageCasResult(rawResult);
    } catch (error) {
      throw controlPlaneError(
        'persistence-invalid',
        'Control-plane storage returned an invalid CAS response',
        mutation.transactionId,
        mutation.expectedRevision,
        null,
        error,
      );
    }
    if (result.outcome === 'REVISION_CONFLICT') {
      throw controlPlaneError(
        'cas-conflict',
        'Control-plane storage CAS lost',
        mutation.transactionId,
        mutation.expectedRevision,
        result.actualRevision,
      );
    }
    if (result.outcome === 'IDENTITY_CONFLICT') {
      throw controlPlaneError(
        'identity-conflict',
        `Control-plane replay identity is already reserved: ${result.identityKey}`,
        mutation.transactionId,
        mutation.expectedRevision,
        null,
      );
    }
    let persisted: ControlPlaneTransactionRecord;
    try {
      persisted = validateControlPlanePersistenceRecord(result.record);
    } catch (error) {
      throw controlPlaneError(
        'persistence-invalid',
        'Storage APPLIED response contains an invalid transaction',
        mutation.transactionId,
        mutation.expectedRevision,
        null,
        error,
      );
    }
    if (canonicalizeJson(persisted) !== canonicalizeJson(expected)) {
      throw controlPlaneError(
        'persistence-invalid',
        'Storage APPLIED response differs from the requested transaction',
        mutation.transactionId,
        mutation.expectedRevision,
        persisted.revision,
      );
    }
    return cloneControlPlaneTransactionRecord(persisted);
  }

  async #fault(point: ControlPlaneFaultPoint): Promise<void> {
    if (this.#injectFault !== null) await this.#injectFault(point);
  }
}

function snapshotPrepareInput(
  value: PrepareControlPlaneInput,
): PrepareControlPlaneInput {
  return snapshotSimpleMutationInput(
    value,
    [
      'transactionId',
      'ticketCommitment',
      'authorityScopeHash',
      'nonce',
      'budgetReservationId',
      'attemptId',
      'adapterId',
      'adapterDigest',
      'operationCommitment',
      'targetObjectId',
      'preStateHash',
      'idempotencyKey',
      'ledgerEntryId',
      'evidenceIntentId',
      'attestationId',
    ],
    'Prepare input',
  ) as unknown as PrepareControlPlaneInput;
}

function snapshotMutationEnvelopeInput(
  value: unknown,
  envelopeKey: 'permitEnvelope' | 'receiptEnvelope',
  label: string,
): {
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly envelope: unknown;
} {
  const snapshot = snapshotClosedData(value, label);
  const record = requireRecord(snapshot, label);
  requireExactKeys(
    record,
    ['transactionId', 'expectedRevision', envelopeKey],
    label,
  );
  return Object.freeze({
    transactionId: requireIdentifier(record.transactionId, 'Transaction ID'),
    expectedRevision: requirePositiveInteger(
      record.expectedRevision,
      'Expected revision',
    ),
    envelope: record[envelopeKey],
  });
}

function snapshotEffectInput(
  value: ExecuteControlPlaneEffectInput,
): ExecuteControlPlaneEffectInput {
  const record = requireRecord(value, 'Effect execution input');
  requireExactKeys(
    record,
    ['transactionId', 'expectedRevision', 'effect'],
    'Effect execution input',
  );
  return Object.freeze({
    transactionId: requireIdentifier(record.transactionId, 'Transaction ID'),
    expectedRevision: requirePositiveInteger(
      record.expectedRevision,
      'Expected revision',
    ),
    effect: readDataProperty(record, 'effect') as ControlPlaneEffectPort,
  });
}

function snapshotSimpleMutationInput(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  const snapshot = snapshotClosedData(value, label);
  const record = requireRecord(snapshot, label);
  requireExactKeys(record, expected, label);
  return Object.freeze(record);
}

function commitPermitBinding(
  record: ControlPlaneTransactionRecord,
): CommitPermitBinding {
  return Object.freeze({
    transactionId: record.transactionId,
    ticketId: record.ticket.ticketId,
    ticketCommitment: record.ticket.ticketCommitment,
    authorityScopeHash: record.ticket.authorityScopeHash,
    operationCommitment: record.effect.operationCommitment,
    adapterId: record.effect.adapterId,
    adapterDigest: record.effect.adapterDigest,
    targetObjectId: record.effect.targetObjectId,
  });
}

function evidenceReceiptBinding(
  record: ControlPlaneTransactionRecord,
): EvidenceReceiptBinding {
  if (record.evidenceOutbox.terminalEvidence === null) {
    throw new ControlPlaneValidationError(
      'Evidence receipt binding requires terminal evidence',
    );
  }
  return Object.freeze({
    transactionId: record.transactionId,
    evidenceIntentId: record.evidenceOutbox.intentId,
    attestationId: record.evidenceOutbox.attestationId,
    terminalEvidence: record.evidenceOutbox.terminalEvidence,
  });
}

function effectExecutionRequest(
  record: ControlPlaneTransactionRecord,
): ControlPlaneEffectExecutionRequest {
  if (record.commitPermit === null) {
    throw new ControlPlaneValidationError(
      'In-flight effect has no COMMIT_PERMIT',
    );
  }
  return Object.freeze({
    transactionId: record.transactionId,
    ticketId: record.ticket.ticketId,
    ticketCommitment: record.ticket.ticketCommitment,
    permit: record.commitPermit,
    attemptId: record.effect.attemptId,
    adapterId: record.effect.adapterId,
    adapterDigest: record.effect.adapterDigest,
    operationCommitment: record.effect.operationCommitment,
    targetObjectId: record.effect.targetObjectId,
    preStateHash: record.effect.preStateHash,
    idempotencyKey: record.effect.idempotencyKey,
  });
}

function validateEffectObservation(
  value: unknown,
): ControlPlaneEffectObservation {
  const snapshot = snapshotClosedData(value, 'Effect observation');
  const record = requireRecord(snapshot, 'Effect observation');
  if (record.outcome === 'COMMITTED') {
    requireExactKeys(
      record,
      [
        'outcome',
        'resultHash',
        'postStateHash',
        'observationRef',
        'reasonCode',
      ],
      'Committed effect observation',
    );
    return Object.freeze({
      outcome: 'COMMITTED',
      resultHash: requireCommitment(record.resultHash, 'Result hash'),
      postStateHash: requireCommitment(record.postStateHash, 'Post-state hash'),
      observationRef: requireIdentifier(
        record.observationRef,
        'Observation reference',
      ),
      reasonCode: requireReasonCode(record.reasonCode),
    });
  }
  if (record.outcome === 'RESULT_UNAVAILABLE') {
    requireExactKeys(
      record,
      ['outcome', 'postStateHash', 'observationRef', 'reasonCode'],
      'Result-unavailable observation',
    );
    return Object.freeze({
      outcome: 'RESULT_UNAVAILABLE',
      postStateHash: requireCommitment(record.postStateHash, 'Post-state hash'),
      observationRef: requireIdentifier(
        record.observationRef,
        'Observation reference',
      ),
      reasonCode: requireReasonCode(record.reasonCode),
    });
  }
  if (record.outcome === 'NO_EFFECT' || record.outcome === 'UNCERTAIN') {
    requireExactKeys(record, ['outcome', 'reasonCode'], 'Effect observation');
    return Object.freeze({
      outcome: record.outcome,
      reasonCode: requireReasonCode(record.reasonCode),
    });
  }
  throw new ControlPlaneValidationError(
    'Effect observation outcome is invalid',
  );
}

function assertPermitMatchesBinding(
  permit: TrustedCommitPermitAdmission,
  binding: CommitPermitBinding,
): void {
  if (
    permit.ticketId !== binding.ticketId ||
    permit.ticketCommitment !== binding.ticketCommitment ||
    permit.operationCommitment !== binding.operationCommitment
  ) {
    throw new ControlPlaneValidationError(
      'Verified COMMIT_PERMIT does not match transaction binding',
    );
  }
}

function assertSynchronousVoid(value: unknown): void {
  if (value !== undefined) {
    throw new ControlPlaneValidationError(
      'Synchronous trust port must return void',
    );
  }
}

function assertTimestampAtOrBefore(
  earlier: string,
  later: string,
  message: string,
): void {
  if (Date.parse(earlier) > Date.parse(later)) {
    throw new ControlPlaneValidationError(message);
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

function readDataProperty<T extends object, K extends keyof T>(
  value: T,
  key: K,
): T[K] {
  if (value === null || typeof value !== 'object') {
    throw new ControlPlaneValidationError('Port container must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) {
    throw new ControlPlaneValidationError(
      `Property ${String(key)} must be an own data property`,
    );
  }
  return descriptor.value as T[K];
}

function readOptionalDataProperty<T extends object, K extends keyof T>(
  value: T,
  key: K,
): T[K] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new ControlPlaneValidationError(
      `Property ${String(key)} must be a data property`,
    );
  }
  return descriptor.value as T[K];
}

function pinMethod<T extends object, K extends keyof T>(
  value: T,
  key: K,
  label: string,
): T[K] {
  let target: object | null = value;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new ControlPlaneValidationError(
          `${label} method ${String(key)} must be a data method`,
        );
      }
      return descriptor.value.bind(value) as T[K];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new ControlPlaneValidationError(
    `${label} method ${String(key)} is missing`,
  );
}

function assertClosedArray(value: readonly unknown[], label: string): void {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    throw new ControlPlaneValidationError(
      `${label} must be a dense plain array`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new ControlPlaneValidationError(
        `${label} contains an accessor or hole`,
      );
    }
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw new ControlPlaneValidationError(`${label} is invalid`);
  }
  return value;
}

function requireCommitment(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw new ControlPlaneValidationError(`${label} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ControlPlaneValidationError(
      `${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function requireReasonCode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/.test(value)
  ) {
    throw new ControlPlaneValidationError('Reason code is invalid');
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ControlPlaneValidationError(
      `${label} is not a canonical UTC timestamp`,
    );
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function controlPlaneError(
  code: ControlPlaneErrorCode,
  message: string,
  transactionId: string | null,
  expectedRevision: number | null,
  actualRevision: number | null,
  originalCause?: unknown,
): ControlPlaneError {
  return new ControlPlaneError(
    code,
    message,
    transactionId,
    expectedRevision,
    actualRevision,
    originalCause,
  );
}
