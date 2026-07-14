import {
  canonicalizeJson,
  validateSafeCodingEffectAttestation,
  validateSafeCodingExecutionTicket,
  type SafeCodingEffectAttestation,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';

export const SAFE_CODING_LEDGER_RECORD_KIND =
  'clodex.safe-coding-effect-transaction' as const;
export const SAFE_CODING_LEDGER_RECORD_VERSION = 1 as const;
export const SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_KIND =
  'clodex.evidence-admission-receipt' as const;
export const SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_VERSION = 1 as const;

export const SAFE_CODING_LEDGER_RECORD_LIMITS = Object.freeze({
  maximumDepth: 16,
  maximumNodes: 512,
  maximumObjectKeys: 64,
  maximumStringBytes: 256 * 1024,
} as const);
/** Longest namespace prefix plus one maximum 256-character identifier. */
export const SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH = 288 as const;

export type SafeCodingLedgerState =
  | 'PREPARED'
  | 'COMMIT_PERMIT'
  | 'COMMITTED'
  | 'RESULT_UNAVAILABLE'
  | 'UNCERTAIN'
  | 'FAILED_PRE_EFFECT';

export type SafeCodingLedgerTerminalState = Exclude<
  SafeCodingLedgerState,
  'PREPARED' | 'COMMIT_PERMIT'
>;

export type SafeCodingEvidenceAdmissionState =
  | 'RESERVED'
  | 'PENDING'
  | 'ADMITTED';

export interface SafeCodingLedgerTicketState {
  readonly ticket: SafeCodingExecutionTicket;
  readonly status: SafeCodingLedgerState;
  /** Set exactly once when COMMIT_PERMIT consumes the ticket. */
  readonly consumedAt: string | null;
  readonly terminalAt: string | null;
  /** Bounded machine-readable reason; never a raw exception or tool output. */
  readonly terminalReasonCode: string | null;
}

export interface SafeCodingLedgerEffectAttempt {
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly effectClass: SafeCodingExecutionTicket['effectClass'];
  readonly resolvedObjectId: string;
  readonly stateCommitmentHash: string;
  readonly preparedAt: string;
  readonly commitPermittedAt: string | null;
  /** Non-null only when completion was positively observed. */
  readonly effectObservedAt: string | null;
  readonly resultHash: string | null;
}

export interface SafeCodingEvidenceBudgetCharges {
  readonly uniqueModifiedFiles: number;
  readonly mutationBytes: number;
  readonly testRuns: number;
}

/**
 * Immutable evidence commitments reserved before COMMIT_PERMIT. Terminal
 * callers may report an observation, but cannot choose the identity, state,
 * budget, or evidence-strength fields after the effect boundary.
 *
 * `completion*` fields describe an observed-effect outcome. A no-effect
 * closure is deterministically constrained to null post-state/result, zero
 * charges, `attempt_only`, and no reconciliation reference.
 */
export interface SafeCodingEvidenceExpectation {
  readonly delegationLineageHash: string;
  readonly runnerId: string;
  readonly runnerDigest: string;
  readonly observerId: string;
  readonly preStateHash: string | null;
  readonly completionPostStateHash: string;
  readonly idempotencyKey: string | null;
  readonly completionBudgetCharges: SafeCodingEvidenceBudgetCharges;
  readonly completionEvidenceLevel: Exclude<
    SafeCodingEffectAttestation['evidenceLevel'],
    'attempt_only'
  >;
  /** Reserved reconciliation identity for independently reconciled evidence. */
  readonly completionReconciliationRef: string | null;
}

/**
 * Closed output of a trusted evidence admission verifier. The receipt binds
 * the ledger transaction/outbox identity to the admitted signed envelope and
 * the exact protected evidence-chain checkpoint.
 */
export interface SafeCodingEvidenceAdmissionReceipt {
  readonly kind: typeof SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_KIND;
  readonly version: typeof SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_VERSION;
  readonly transactionId: string;
  readonly evidenceIntentId: string;
  readonly attestationId: string;
  /** Exact payload recovered from and bound to the signed envelope. */
  readonly attestation: SafeCodingEffectAttestation;
  readonly envelopeHash: string;
  readonly evidenceLedgerId: string;
  readonly evidenceSequence: number;
  readonly evidenceHeadHash: string;
  readonly checkpointPublicationId: string;
  readonly checkpointDigest: string;
  readonly receiptHash: string;
  readonly admittedAt: string;
}

/**
 * The attestation is the outbox payload. `intentId` and `attestationId` are
 * reserved in PREPARED so restart delivery cannot mint a second identity.
 */
export interface SafeCodingEvidenceAdmissionIntent {
  readonly intentId: string;
  readonly attestationId: string;
  readonly status: SafeCodingEvidenceAdmissionState;
  readonly attestation: SafeCodingEffectAttestation | null;
  readonly readyAt: string | null;
  readonly admittedAt: string | null;
  readonly admissionReceipt: SafeCodingEvidenceAdmissionReceipt | null;
}

/**
 * One record is the logical transaction boundary: ticket lifecycle, effect
 * attempt, and evidence-outbox intent are never persisted as separate writes.
 */
export interface SafeCodingLedgerRecord {
  readonly kind: typeof SAFE_CODING_LEDGER_RECORD_KIND;
  readonly version: typeof SAFE_CODING_LEDGER_RECORD_VERSION;
  /** Equal to ticketId; one ticket owns exactly one lifecycle record. */
  readonly transactionId: string;
  /** Starts at 1 and advances by exactly one under persistence CAS. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ticketState: SafeCodingLedgerTicketState;
  readonly effectAttempt: SafeCodingLedgerEffectAttempt;
  readonly evidenceExpectation: SafeCodingEvidenceExpectation;
  readonly evidenceAdmission: SafeCodingEvidenceAdmissionIntent;
}

export class SafeCodingLedgerValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SafeCodingLedgerValidationError';
  }
}

export function isSafeCodingLedgerTerminalState(
  state: SafeCodingLedgerState,
): state is SafeCodingLedgerTerminalState {
  return (
    state === 'COMMITTED' ||
    state === 'RESULT_UNAVAILABLE' ||
    state === 'UNCERTAIN' ||
    state === 'FAILED_PRE_EFFECT'
  );
}

export function validateSafeCodingLedgerRecord(
  value: unknown,
): SafeCodingLedgerRecord {
  assertBoundedCanonicalData(value, 'Ledger record');
  const record = requireRecord(value, 'Ledger record');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'transactionId',
      'revision',
      'createdAt',
      'updatedAt',
      'ticketState',
      'effectAttempt',
      'evidenceExpectation',
      'evidenceAdmission',
    ],
    'Ledger record',
  );
  requireLiteral(
    record.kind,
    SAFE_CODING_LEDGER_RECORD_KIND,
    'Ledger record kind',
  );
  requireLiteral(
    record.version,
    SAFE_CODING_LEDGER_RECORD_VERSION,
    'Ledger record version',
  );

  const transactionId = requireIdentifier(
    record.transactionId,
    'Ledger transaction ID',
  );
  const revision = requirePositiveInteger(record.revision, 'Ledger revision');
  const createdAt = requireTimestamp(record.createdAt, 'Ledger createdAt');
  const updatedAt = requireTimestamp(record.updatedAt, 'Ledger updatedAt');
  assertTimeOrder(createdAt, updatedAt, 'Ledger updatedAt precedes createdAt');

  const ticketState = validateTicketState(record.ticketState);
  const effectAttempt = validateEffectAttempt(record.effectAttempt);
  const evidenceExpectation = validateEvidenceExpectation(
    record.evidenceExpectation,
  );
  const evidenceAdmission = validateEvidenceAdmission(record.evidenceAdmission);

  if (transactionId !== ticketState.ticket.ticketId) {
    throw validationError('Ledger transaction ID must equal ticket ID');
  }
  assertTicketAttemptBinding(ticketState.ticket, effectAttempt);
  if (
    evidenceExpectation.observerId === ticketState.ticket.audience.executorId
  ) {
    throw validationError(
      'Evidence observer principal must be distinct from the ticket executor',
    );
  }
  if (createdAt !== effectAttempt.preparedAt) {
    throw validationError('Effect preparedAt must equal record createdAt');
  }
  assertTimeOrder(createdAt, updatedAt, 'Ledger update time moved backwards');
  assertStateShape(
    ticketState,
    effectAttempt,
    evidenceExpectation,
    evidenceAdmission,
    updatedAt,
  );
  assertReachableRevision(
    revision,
    ticketState.status,
    evidenceAdmission.status,
  );

  return deepFreeze({
    kind: SAFE_CODING_LEDGER_RECORD_KIND,
    version: SAFE_CODING_LEDGER_RECORD_VERSION,
    transactionId,
    revision,
    createdAt,
    updatedAt,
    ticketState,
    effectAttempt,
    evidenceExpectation,
    evidenceAdmission,
  });
}

export function cloneSafeCodingLedgerRecord(
  record: SafeCodingLedgerRecord,
): SafeCodingLedgerRecord {
  const validated = validateSafeCodingLedgerRecord(record);
  return validateSafeCodingLedgerRecord(
    JSON.parse(canonicalizeJson(validated)) as unknown,
  );
}

export function safeCodingLedgerIdentityKeys(
  record: SafeCodingLedgerRecord,
): readonly string[] {
  const validated = validateSafeCodingLedgerRecord(record);
  const keys = [
    `attestation:${validated.evidenceAdmission.attestationId}`,
    `attempt:${validated.effectAttempt.attemptId}`,
    `evidence-intent:${validated.evidenceAdmission.intentId}`,
    `nonce:${validated.ticketState.ticket.nonce}`,
    `request:${validated.ticketState.ticket.requestId}`,
    `reservation:${validated.ticketState.ticket.budgetReservationId}`,
    `ticket:${validated.ticketState.ticket.ticketId}`,
    ...(validated.evidenceExpectation.idempotencyKey === null
      ? []
      : [`idempotency:${validated.evidenceExpectation.idempotencyKey}`]),
  ].sort();
  if (
    keys.some((key) => key.length > SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH)
  ) {
    throw validationError('Ledger identity key exceeds its persisted bound');
  }
  return Object.freeze(keys);
}

function validateTicketState(value: unknown): SafeCodingLedgerTicketState {
  const record = requireRecord(value, 'Ledger ticket state');
  requireExactKeys(
    record,
    ['ticket', 'status', 'consumedAt', 'terminalAt', 'terminalReasonCode'],
    'Ledger ticket state',
  );
  let ticket: SafeCodingExecutionTicket;
  try {
    ticket = validateSafeCodingExecutionTicket(record.ticket);
  } catch (error) {
    throw validationError('Ledger ticket is invalid', error);
  }
  return deepFreeze({
    ticket,
    status: requireEnum(
      record.status,
      [
        'PREPARED',
        'COMMIT_PERMIT',
        'COMMITTED',
        'RESULT_UNAVAILABLE',
        'UNCERTAIN',
        'FAILED_PRE_EFFECT',
      ] as const,
      'Ledger ticket status',
    ),
    consumedAt: requireNullableTimestamp(
      record.consumedAt,
      'Ticket consumedAt',
    ),
    terminalAt: requireNullableTimestamp(
      record.terminalAt,
      'Ticket terminalAt',
    ),
    terminalReasonCode: requireNullableIdentifier(
      record.terminalReasonCode,
      'Ticket terminal reason code',
    ),
  });
}

function validateEffectAttempt(value: unknown): SafeCodingLedgerEffectAttempt {
  const record = requireRecord(value, 'Ledger effect attempt');
  requireExactKeys(
    record,
    [
      'attemptId',
      'adapterId',
      'adapterDigest',
      'effectClass',
      'resolvedObjectId',
      'stateCommitmentHash',
      'preparedAt',
      'commitPermittedAt',
      'effectObservedAt',
      'resultHash',
    ],
    'Ledger effect attempt',
  );
  return Object.freeze({
    attemptId: requireIdentifier(record.attemptId, 'Effect attempt ID'),
    adapterId: requireIdentifier(record.adapterId, 'Effect adapter ID'),
    adapterDigest: requireDigest(record.adapterDigest, 'Effect adapter digest'),
    effectClass: requireEnum(
      record.effectClass,
      ['local.observation', 'local.reversible', 'sandbox.ephemeral'] as const,
      'Effect class',
    ),
    resolvedObjectId: requireIdentifier(
      record.resolvedObjectId,
      'Effect resolved object ID',
    ),
    stateCommitmentHash: requireDigest(
      record.stateCommitmentHash,
      'Effect state commitment hash',
    ),
    preparedAt: requireTimestamp(record.preparedAt, 'Effect preparedAt'),
    commitPermittedAt: requireNullableTimestamp(
      record.commitPermittedAt,
      'Effect commitPermittedAt',
    ),
    effectObservedAt: requireNullableTimestamp(
      record.effectObservedAt,
      'Effect observedAt',
    ),
    resultHash: requireNullableDigest(record.resultHash, 'Effect result hash'),
  });
}

export function validateSafeCodingEvidenceExpectation(
  value: unknown,
): SafeCodingEvidenceExpectation {
  return validateEvidenceExpectation(value);
}

function validateEvidenceExpectation(
  value: unknown,
): SafeCodingEvidenceExpectation {
  const record = requireRecord(value, 'Evidence expectation');
  requireExactKeys(
    record,
    [
      'delegationLineageHash',
      'runnerId',
      'runnerDigest',
      'observerId',
      'preStateHash',
      'completionPostStateHash',
      'idempotencyKey',
      'completionBudgetCharges',
      'completionEvidenceLevel',
      'completionReconciliationRef',
    ],
    'Evidence expectation',
  );
  const expectation: SafeCodingEvidenceExpectation = {
    delegationLineageHash: requireDigest(
      record.delegationLineageHash,
      'Expected delegation lineage hash',
    ),
    runnerId: requireIdentifier(record.runnerId, 'Expected runner ID'),
    runnerDigest: requireDigest(record.runnerDigest, 'Expected runner digest'),
    observerId: requireIdentifier(record.observerId, 'Expected observer ID'),
    preStateHash: requireNullableDigest(
      record.preStateHash,
      'Expected pre-state hash',
    ),
    completionPostStateHash: requireDigest(
      record.completionPostStateHash,
      'Expected completion post-state hash',
    ),
    idempotencyKey: requireNullableIdentifier(
      record.idempotencyKey,
      'Reserved idempotency key',
    ),
    completionBudgetCharges: validateBudgetCharges(
      record.completionBudgetCharges,
      'Expected completion budget charges',
    ),
    completionEvidenceLevel: requireEnum(
      record.completionEvidenceLevel,
      [
        'adapter_observed',
        'local_state_reconciled',
        'remote_provider_attested',
        'independently_reconciled',
      ] as const,
      'Expected completion evidence level',
    ),
    completionReconciliationRef: requireNullableIdentifier(
      record.completionReconciliationRef,
      'Expected completion reconciliation reference',
    ),
  };
  if (
    (expectation.completionEvidenceLevel === 'independently_reconciled') !==
    (expectation.completionReconciliationRef !== null)
  ) {
    throw validationError(
      'Only independently reconciled completion evidence may reserve a reconciliation reference',
    );
  }
  if (
    (expectation.completionEvidenceLevel === 'local_state_reconciled' ||
      expectation.completionEvidenceLevel === 'independently_reconciled') &&
    expectation.preStateHash === null
  ) {
    throw validationError(
      'Reconciled completion evidence requires a reserved pre-state hash',
    );
  }
  return deepFreeze(expectation);
}

function validateBudgetCharges(
  value: unknown,
  label: string,
): SafeCodingEvidenceBudgetCharges {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    ['uniqueModifiedFiles', 'mutationBytes', 'testRuns'],
    label,
  );
  return Object.freeze({
    uniqueModifiedFiles: requireNonNegativeInteger(
      record.uniqueModifiedFiles,
      `${label} uniqueModifiedFiles`,
    ),
    mutationBytes: requireNonNegativeInteger(
      record.mutationBytes,
      `${label} mutationBytes`,
    ),
    testRuns: requireNonNegativeInteger(record.testRuns, `${label} testRuns`),
  });
}

export function validateSafeCodingEvidenceAdmissionReceipt(
  value: unknown,
): SafeCodingEvidenceAdmissionReceipt {
  const record = requireRecord(value, 'Evidence admission receipt');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'transactionId',
      'evidenceIntentId',
      'attestationId',
      'attestation',
      'envelopeHash',
      'evidenceLedgerId',
      'evidenceSequence',
      'evidenceHeadHash',
      'checkpointPublicationId',
      'checkpointDigest',
      'receiptHash',
      'admittedAt',
    ],
    'Evidence admission receipt',
  );
  requireLiteral(
    record.kind,
    SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_KIND,
    'Evidence admission receipt kind',
  );
  requireLiteral(
    record.version,
    SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_VERSION,
    'Evidence admission receipt version',
  );
  return deepFreeze({
    kind: SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_KIND,
    version: SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_VERSION,
    transactionId: requireIdentifier(
      record.transactionId,
      'Receipt transaction ID',
    ),
    evidenceIntentId: requireIdentifier(
      record.evidenceIntentId,
      'Receipt evidence intent ID',
    ),
    attestationId: requireUuid(record.attestationId, 'Receipt attestation ID'),
    attestation: validateRequiredAttestation(
      record.attestation,
      'Receipt attestation payload',
    ),
    envelopeHash: requireDigest(record.envelopeHash, 'Receipt envelope hash'),
    evidenceLedgerId: requireIdentifier(
      record.evidenceLedgerId,
      'Receipt evidence ledger ID',
    ),
    evidenceSequence: requirePositiveInteger(
      record.evidenceSequence,
      'Receipt evidence sequence',
    ),
    evidenceHeadHash: requireDigest(
      record.evidenceHeadHash,
      'Receipt evidence head hash',
    ),
    checkpointPublicationId: requireIdentifier(
      record.checkpointPublicationId,
      'Receipt checkpoint publication ID',
    ),
    checkpointDigest: requireDigest(
      record.checkpointDigest,
      'Receipt checkpoint digest',
    ),
    receiptHash: requireDigest(record.receiptHash, 'Receipt hash'),
    admittedAt: requireTimestamp(record.admittedAt, 'Receipt admittedAt'),
  });
}

function validateEvidenceAdmission(
  value: unknown,
): SafeCodingEvidenceAdmissionIntent {
  const record = requireRecord(value, 'Evidence admission intent');
  requireExactKeys(
    record,
    [
      'intentId',
      'attestationId',
      'status',
      'attestation',
      'readyAt',
      'admittedAt',
      'admissionReceipt',
    ],
    'Evidence admission intent',
  );
  const attestation = validateNullableAttestation(record.attestation);
  return deepFreeze({
    intentId: requireIdentifier(record.intentId, 'Evidence intent ID'),
    attestationId: requireUuid(record.attestationId, 'Reserved attestation ID'),
    status: requireEnum(
      record.status,
      ['RESERVED', 'PENDING', 'ADMITTED'] as const,
      'Evidence admission state',
    ),
    attestation,
    readyAt: requireNullableTimestamp(record.readyAt, 'Evidence readyAt'),
    admittedAt: requireNullableTimestamp(
      record.admittedAt,
      'Evidence admittedAt',
    ),
    admissionReceipt:
      record.admissionReceipt === null
        ? null
        : validateSafeCodingEvidenceAdmissionReceipt(record.admissionReceipt),
  });
}

function validateNullableAttestation(
  value: unknown,
): SafeCodingEffectAttestation | null {
  if (value === null) return null;
  try {
    return validateSafeCodingEffectAttestation(value);
  } catch (error) {
    throw validationError('Evidence attestation is invalid', error);
  }
}

function validateRequiredAttestation(
  value: unknown,
  label: string,
): SafeCodingEffectAttestation {
  try {
    return validateSafeCodingEffectAttestation(value);
  } catch (error) {
    throw validationError(`${label} is invalid`, error);
  }
}

function assertTicketAttemptBinding(
  ticket: SafeCodingExecutionTicket,
  attempt: SafeCodingLedgerEffectAttempt,
): void {
  if (
    attempt.adapterId !== ticket.adapterId ||
    attempt.adapterDigest !== ticket.adapterDigest ||
    attempt.effectClass !== ticket.effectClass ||
    attempt.resolvedObjectId !== ticket.resolvedObjectId ||
    attempt.stateCommitmentHash !== ticket.stateCommitmentHash
  ) {
    throw validationError('Effect attempt is not exactly bound to its ticket');
  }
}

function assertStateShape(
  ticketState: SafeCodingLedgerTicketState,
  attempt: SafeCodingLedgerEffectAttempt,
  expectation: SafeCodingEvidenceExpectation,
  evidence: SafeCodingEvidenceAdmissionIntent,
  updatedAt: string,
): void {
  const status = ticketState.status;
  if (status === 'PREPARED') {
    requireAllNull(
      [
        ticketState.consumedAt,
        ticketState.terminalAt,
        ticketState.terminalReasonCode,
        attempt.commitPermittedAt,
        attempt.effectObservedAt,
        attempt.resultHash,
      ],
      'PREPARED record contains post-prepare fields',
    );
    if (evidence.status !== 'RESERVED') {
      throw validationError('PREPARED evidence must remain RESERVED');
    }
    if (updatedAt !== attempt.preparedAt) {
      throw validationError('PREPARED update time must equal preparedAt');
    }
  } else if (status === 'COMMIT_PERMIT') {
    requireNonNull(ticketState.consumedAt, 'COMMIT_PERMIT requires consumedAt');
    if (attempt.commitPermittedAt !== ticketState.consumedAt) {
      throw validationError('Permit timestamps must match exactly');
    }
    requireAllNull(
      [
        ticketState.terminalAt,
        ticketState.terminalReasonCode,
        attempt.effectObservedAt,
        attempt.resultHash,
      ],
      'COMMIT_PERMIT record contains terminal fields',
    );
    if (evidence.status !== 'RESERVED') {
      throw validationError('COMMIT_PERMIT evidence must remain RESERVED');
    }
    if (updatedAt !== ticketState.consumedAt) {
      throw validationError('COMMIT_PERMIT update time must equal consumedAt');
    }
  } else {
    assertTerminalShape(ticketState, attempt, expectation, evidence);
  }

  if (evidence.status === 'RESERVED') {
    requireAllNull(
      [
        evidence.attestation,
        evidence.readyAt,
        evidence.admittedAt,
        evidence.admissionReceipt,
      ],
      'RESERVED evidence contains admission fields',
    );
  } else {
    requireNonNull(evidence.attestation, 'Evidence payload is missing');
    requireNonNull(evidence.readyAt, 'Evidence readyAt is missing');
    if (evidence.attestation.attestationId !== evidence.attestationId) {
      throw validationError('Attached attestation ID was not pre-reserved');
    }
    if (evidence.status === 'PENDING') {
      requireAllNull(
        [evidence.admittedAt, evidence.admissionReceipt],
        'PENDING evidence contains admission acknowledgement',
      );
      if (updatedAt !== evidence.readyAt) {
        throw validationError(
          'Pending evidence readiness must be latest update',
        );
      }
    } else {
      requireNonNull(evidence.admittedAt, 'ADMITTED evidence lacks admittedAt');
      requireNonNull(
        evidence.admissionReceipt,
        'ADMITTED evidence lacks a verified receipt',
      );
      assertAdmissionReceiptBinding(ticketState, evidence);
      assertTimeOrder(
        evidence.readyAt,
        evidence.admittedAt,
        'Evidence admission precedes readiness',
      );
      if (updatedAt !== evidence.admittedAt) {
        throw validationError(
          'Admission acknowledgement must be latest update',
        );
      }
    }
  }
}

function assertTerminalShape(
  ticketState: SafeCodingLedgerTicketState,
  attempt: SafeCodingLedgerEffectAttempt,
  expectation: SafeCodingEvidenceExpectation,
  evidence: SafeCodingEvidenceAdmissionIntent,
): void {
  const status = ticketState.status as SafeCodingLedgerTerminalState;
  requireNonNull(ticketState.terminalAt, 'Terminal record lacks terminalAt');
  if (evidence.status === 'RESERVED' || evidence.attestation === null) {
    throw validationError(
      'Terminal state and evidence admission intent must be atomic',
    );
  }
  if (
    evidence.readyAt !== ticketState.terminalAt ||
    evidence.attestation.finishedAt !== ticketState.terminalAt
  ) {
    throw validationError('Terminal and evidence timestamps must match');
  }
  assertAttestationBinding(
    ticketState.ticket,
    attempt,
    expectation,
    status,
    evidence,
  );

  if (status === 'FAILED_PRE_EFFECT') {
    requireAllNull(
      [
        ticketState.consumedAt,
        attempt.commitPermittedAt,
        attempt.effectObservedAt,
        attempt.resultHash,
      ],
      'FAILED_PRE_EFFECT cannot contain a consumed effect attempt',
    );
    requireNonNull(
      ticketState.terminalReasonCode,
      'FAILED_PRE_EFFECT requires a reason code',
    );
    return;
  }

  requireNonNull(ticketState.consumedAt, `${status} requires consumedAt`);
  assertTimeOrder(
    attempt.preparedAt,
    ticketState.consumedAt,
    'Ticket consumption precedes PREPARED',
  );
  assertTimeOrder(
    ticketState.consumedAt,
    ticketState.terminalAt,
    'Terminal state precedes COMMIT_PERMIT',
  );
  if (attempt.commitPermittedAt !== ticketState.consumedAt) {
    throw validationError('Terminal permit timestamps must match');
  }
  if (status === 'COMMITTED') {
    if (ticketState.terminalReasonCode !== null) {
      throw validationError('COMMITTED cannot carry a failure reason');
    }
    requireNonNull(
      attempt.effectObservedAt,
      'COMMITTED requires observed effect completion',
    );
    requireNonNull(attempt.resultHash, 'COMMITTED requires a result hash');
  } else {
    requireNonNull(
      ticketState.terminalReasonCode,
      `${status} requires a reason code`,
    );
  }
  if (status === 'RESULT_UNAVAILABLE') {
    requireNonNull(
      attempt.effectObservedAt,
      'RESULT_UNAVAILABLE requires observed effect completion',
    );
  }
  if (
    attempt.effectObservedAt !== null &&
    attempt.effectObservedAt !== ticketState.terminalAt
  ) {
    throw validationError('Observed effect time must equal terminal time');
  }
}

function assertAttestationBinding(
  ticket: SafeCodingExecutionTicket,
  attempt: SafeCodingLedgerEffectAttempt,
  expectation: SafeCodingEvidenceExpectation,
  status: SafeCodingLedgerTerminalState,
  evidence: SafeCodingEvidenceAdmissionIntent,
): void {
  const attestation = evidence.attestation!;
  const expectedStatus =
    status === 'COMMITTED'
      ? 'committed'
      : status === 'RESULT_UNAVAILABLE'
        ? 'committed_result_unavailable'
        : status === 'UNCERTAIN'
          ? 'uncertain'
          : 'failed_no_effect';
  const noEffect =
    status === 'FAILED_PRE_EFFECT' ||
    (status === 'UNCERTAIN' && attempt.effectObservedAt === null);
  const expectedPostStateHash = noEffect
    ? null
    : expectation.completionPostStateHash;
  const expectedBudgetCharges = noEffect
    ? ZERO_BUDGET_CHARGES
    : expectation.completionBudgetCharges;
  const expectedEvidenceLevel = noEffect
    ? 'attempt_only'
    : expectation.completionEvidenceLevel;
  const expectedReconciliationRef = noEffect
    ? null
    : expectation.completionReconciliationRef;
  if (attestation.status !== expectedStatus) {
    throw validationError('Attestation status does not match ledger state');
  }
  if (
    attestation.ticketId !== ticket.ticketId ||
    attestation.requestId !== ticket.requestId ||
    attestation.contractHash !== ticket.contractHash ||
    attestation.contractRevision !== ticket.contractRevision ||
    attestation.actionHash !== ticket.actionHash ||
    attestation.delegationLineageHash !== expectation.delegationLineageHash ||
    attestation.adapterId !== ticket.adapterId ||
    attestation.adapterDigest !== ticket.adapterDigest ||
    attestation.runnerId !== expectation.runnerId ||
    attestation.runnerDigest !== expectation.runnerDigest ||
    attestation.executorId !== ticket.audience.executorId ||
    attestation.observerId !== expectation.observerId ||
    attestation.effectClass !== ticket.effectClass ||
    attestation.registryDigest !== ticket.registryDigest ||
    attestation.revocationEpoch !== ticket.revocationEpoch ||
    attestation.preStateHash !== expectation.preStateHash ||
    attestation.postStateHash !== expectedPostStateHash ||
    attestation.idempotencyKey !== expectation.idempotencyKey ||
    attestation.resultHash !== attempt.resultHash ||
    canonicalizeJson(attestation.budgetCharges) !==
      canonicalizeJson(expectedBudgetCharges) ||
    attestation.startedAt !== attempt.preparedAt ||
    attestation.evidenceLevel !== expectedEvidenceLevel ||
    attestation.reconciliationRef !== expectedReconciliationRef
  ) {
    throw validationError('Attestation is not exactly bound to the attempt');
  }
}

const ZERO_BUDGET_CHARGES = Object.freeze({
  uniqueModifiedFiles: 0,
  mutationBytes: 0,
  testRuns: 0,
} satisfies SafeCodingEvidenceBudgetCharges);

function assertAdmissionReceiptBinding(
  ticketState: SafeCodingLedgerTicketState,
  evidence: SafeCodingEvidenceAdmissionIntent,
): void {
  const receipt = evidence.admissionReceipt!;
  if (
    receipt.transactionId !== ticketState.ticket.ticketId ||
    receipt.evidenceIntentId !== evidence.intentId ||
    receipt.attestationId !== evidence.attestationId ||
    canonicalizeJson(receipt.attestation) !==
      canonicalizeJson(evidence.attestation) ||
    receipt.admittedAt !== evidence.admittedAt
  ) {
    throw validationError(
      'Evidence admission receipt is not exactly bound to its transaction',
    );
  }
}

function assertReachableRevision(
  revision: number,
  state: SafeCodingLedgerState,
  evidenceState: SafeCodingEvidenceAdmissionState,
): void {
  const expected =
    state === 'PREPARED'
      ? 1
      : state === 'COMMIT_PERMIT'
        ? 2
        : state === 'FAILED_PRE_EFFECT'
          ? evidenceState === 'PENDING'
            ? 2
            : 3
          : evidenceState === 'PENDING'
            ? 3
            : 4;
  if (revision !== expected) {
    throw validationError(
      `Ledger revision ${revision} is unreachable for ${state}/${evidenceState}`,
    );
  }
}

function assertBoundedCanonicalData(value: unknown, label: string): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  const visited = new WeakSet<object>();
  let nodes = 0;
  let stringBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > SAFE_CODING_LEDGER_RECORD_LIMITS.maximumNodes) {
      throw validationError(`${label} exceeds the bounded node limit`);
    }
    if (current.depth > SAFE_CODING_LEDGER_RECORD_LIMITS.maximumDepth) {
      throw validationError(`${label} exceeds the bounded nesting depth`);
    }
    if (typeof current.value === 'string') {
      stringBytes += boundedUtf8ByteLength(
        current.value,
        SAFE_CODING_LEDGER_RECORD_LIMITS.maximumStringBytes - stringBytes,
      );
      if (stringBytes > SAFE_CODING_LEDGER_RECORD_LIMITS.maximumStringBytes) {
        throw validationError(`${label} exceeds the bounded string-byte limit`);
      }
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (visited.has(current.value)) {
      throw validationError(`${label} cannot contain cycles or aliases`);
    }
    visited.add(current.value);
    const prototype = Object.getPrototypeOf(current.value);
    const isArray = Array.isArray(current.value);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      throw validationError(`${label} must contain only plain data containers`);
    }
    if (Object.getOwnPropertySymbols(current.value).length > 0) {
      throw validationError(`${label} cannot contain symbol keys`);
    }
    const names = Object.getOwnPropertyNames(current.value);
    if (names.length > SAFE_CODING_LEDGER_RECORD_LIMITS.maximumObjectKeys) {
      throw validationError(`${label} contains too many fields`);
    }
    if (isArray) {
      const array = current.value as unknown[];
      if (
        names.length !== array.length + 1 ||
        names[names.length - 1] !== 'length'
      ) {
        throw validationError(`${label} contains a sparse or extended array`);
      }
    } else if (names.length !== Object.keys(current.value).length) {
      throw validationError(`${label} cannot hide non-enumerable fields`);
    }
    for (const name of names) {
      if (name === 'length' && isArray) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current.value, name);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw validationError(
          `${label} cannot contain accessors or hidden data`,
        );
      }
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }

  try {
    canonicalizeJson(value);
  } catch (error) {
    throw validationError(
      `${label} is outside the closed canonical shape`,
      error,
    );
  }
}

function boundedUtf8ByteLength(value: string, remaining: number): number {
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
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > remaining) return bytes;
  }
  return bytes;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw validationError(`${label} must be a plain object`);
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
    Object.getOwnPropertyNames(value).some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || !('value' in descriptor);
    })
  ) {
    throw validationError(`${label} must contain only enumerable data fields`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw validationError(`${label} has unknown or missing fields`);
  }
}

function requireLiteral<Value extends string | number>(
  value: unknown,
  expected: Value,
  label: string,
): asserts value is Value {
  if (value !== expected) throw validationError(`${label} is invalid`);
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw validationError(`${label} is invalid`);
  }
  return value as Values[number];
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

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw validationError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireNullableIdentifier(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireIdentifier(value, label);
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw validationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireNullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : requireDigest(value, label);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw validationError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw validationError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || timestampMilliseconds(value) === null) {
    throw validationError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function requireNullableTimestamp(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireTimestamp(value, label);
}

export function safeCodingLedgerTimestampMilliseconds(value: string): number {
  const timestamp = timestampMilliseconds(value);
  if (timestamp === null) {
    throw validationError('Timestamp must be canonical UTC');
  }
  return timestamp;
}

function timestampMilliseconds(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(
      value,
    );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, ms] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = ms === undefined ? 0 : Number(ms);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const timestamp = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return timestamp;
}

function assertTimeOrder(before: string, after: string, message: string): void {
  if (
    safeCodingLedgerTimestampMilliseconds(after) <
    safeCodingLedgerTimestampMilliseconds(before)
  ) {
    throw validationError(message);
  }
}

function requireAllNull(values: readonly unknown[], message: string): void {
  if (values.some((value) => value !== null)) throw validationError(message);
}

function requireNonNull<Value>(
  value: Value | null,
  message: string,
): asserts value is Value {
  if (value === null) throw validationError(message);
}

function validationError(
  message: string,
  cause?: unknown,
): SafeCodingLedgerValidationError {
  const error = new SafeCodingLedgerValidationError(message);
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
