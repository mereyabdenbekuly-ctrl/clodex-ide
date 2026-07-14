import {
  canonicalizeJson,
  encodeUtf8,
  parseCanonicalJson,
} from '@clodex/contracts';

export const CONTROL_PLANE_TRANSACTION_KIND =
  'clodex.execution-control-plane-transaction' as const;
export const CONTROL_PLANE_TRANSACTION_VERSION = 1 as const;
export const CONTROL_PLANE_TERMINAL_EVIDENCE_KIND =
  'clodex.execution-terminal-evidence' as const;
export const CONTROL_PLANE_TERMINAL_EVIDENCE_VERSION = 1 as const;
export const CONTROL_PLANE_EVIDENCE_RECEIPT_KIND =
  'clodex.control-plane-evidence-admission-receipt' as const;
export const CONTROL_PLANE_EVIDENCE_RECEIPT_VERSION = 1 as const;
export const TRUSTED_COMMIT_PERMIT_KIND =
  'clodex.trusted-commit-permit-admission' as const;
export const TRUSTED_COMMIT_PERMIT_VERSION = 1 as const;

export const CONTROL_PLANE_RECORD_LIMITS = Object.freeze({
  maximumDepth: 20,
  maximumNodes: 1024,
  maximumObjectKeys: 64,
  maximumArrayLength: 256,
  maximumStringBytes: 512 * 1024,
  maximumRecordBytes: 1024 * 1024,
} as const);

export const CONTROL_PLANE_IDENTITY_KEY_MAX_LENGTH = 320 as const;

export type ControlPlanePhase =
  | 'PREPARED'
  | 'COMMIT_PERMIT'
  | 'EFFECT_IN_FLIGHT'
  | 'COMMITTED'
  | 'RESULT_UNAVAILABLE'
  | 'FAILED_PRE_EFFECT'
  | 'UNCERTAIN';

export type ControlPlaneTerminalPhase = Extract<
  ControlPlanePhase,
  'COMMITTED' | 'RESULT_UNAVAILABLE' | 'FAILED_PRE_EFFECT' | 'UNCERTAIN'
>;

export type ControlPlaneEffectStatus =
  | 'NOT_STARTED'
  | 'IN_FLIGHT'
  | 'OBSERVED_COMMITTED'
  | 'NO_EFFECT'
  | 'UNCERTAIN';

export type ControlPlaneEvidenceOutboxStatus =
  | 'RESERVED'
  | 'READY'
  | 'DELIVERED';

/**
 * Closed result produced by an external authority-verification TCB. The
 * control plane never signs, mints, broadens, or refreshes this authority.
 */
export interface TrustedCommitPermitAdmission {
  readonly kind: typeof TRUSTED_COMMIT_PERMIT_KIND;
  readonly version: typeof TRUSTED_COMMIT_PERMIT_VERSION;
  readonly permitId: string;
  readonly permitDigest: string;
  readonly admissionReceiptHash: string;
  readonly issuerId: string;
  readonly trustEpoch: number;
  readonly registryDigest: string;
  readonly ticketId: string;
  readonly ticketCommitment: string;
  readonly operationCommitment: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly admittedAt: string;
}

export interface ControlPlaneTicketState {
  readonly ticketId: string;
  readonly ticketCommitment: string;
  readonly authorityScopeHash: string;
  readonly nonce: string;
  readonly budgetReservationId: string;
  readonly status: 'RESERVED' | 'CONSUMED';
  readonly consumedAt: string | null;
}

export interface ControlPlaneEffectState {
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly operationCommitment: string;
  readonly targetObjectId: string;
  readonly preStateHash: string | null;
  readonly idempotencyKey: string | null;
  readonly status: ControlPlaneEffectStatus;
  readonly startedAt: string | null;
  readonly terminalAt: string | null;
  readonly resultHash: string | null;
  readonly postStateHash: string | null;
  readonly observationRef: string | null;
  readonly terminalReasonCode: string | null;
}

/**
 * Redundant, closed ledger projection stored in the same transaction as the
 * ticket and evidence outbox. Redundancy is intentional: validation rejects a
 * snapshot if the projections disagree.
 */
export interface ControlPlaneLedgerEntry {
  readonly entryId: string;
  readonly state: ControlPlanePhase;
  readonly ticketConsumed: boolean;
  readonly commitPermitDigest: string | null;
  readonly effectMayHaveOccurred: boolean;
  readonly terminalReasonCode: string | null;
}

export interface ControlPlaneTerminalEvidence {
  readonly kind: typeof CONTROL_PLANE_TERMINAL_EVIDENCE_KIND;
  readonly version: typeof CONTROL_PLANE_TERMINAL_EVIDENCE_VERSION;
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly ticketId: string;
  readonly ticketCommitment: string;
  readonly permitId: string | null;
  readonly permitDigest: string | null;
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly operationCommitment: string;
  readonly targetObjectId: string;
  readonly terminalPhase: ControlPlaneTerminalPhase;
  readonly effectMayHaveOccurred: boolean;
  readonly resultHash: string | null;
  readonly postStateHash: string | null;
  readonly observationRef: string | null;
  readonly reasonCode: string;
  readonly observedAt: string;
}

/** Closed receipt returned by an external evidence-admission TCB. */
export interface ControlPlaneEvidenceAdmissionReceipt {
  readonly kind: typeof CONTROL_PLANE_EVIDENCE_RECEIPT_KIND;
  readonly version: typeof CONTROL_PLANE_EVIDENCE_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly transactionId: string;
  readonly evidenceIntentId: string;
  readonly attestationId: string;
  readonly evidenceEnvelopeHash: string;
  readonly evidenceLedgerId: string;
  readonly evidenceSequence: number;
  readonly checkpointDigest: string;
  readonly admittedAt: string;
}

export interface ControlPlaneEvidenceOutbox {
  readonly intentId: string;
  readonly attestationId: string;
  readonly status: ControlPlaneEvidenceOutboxStatus;
  readonly terminalEvidence: ControlPlaneTerminalEvidence | null;
  readonly readyAt: string | null;
  readonly deliveredAt: string | null;
  readonly admissionReceipt: ControlPlaneEvidenceAdmissionReceipt | null;
}

/**
 * The complete local atomic unit. Ticket consumption, COMMIT_PERMIT, the
 * ledger projection, and the evidence outbox are never separate local writes.
 */
export interface ControlPlaneTransactionRecord {
  readonly kind: typeof CONTROL_PLANE_TRANSACTION_KIND;
  readonly version: typeof CONTROL_PLANE_TRANSACTION_VERSION;
  readonly transactionId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly phase: ControlPlanePhase;
  readonly ticket: ControlPlaneTicketState;
  readonly commitPermit: TrustedCommitPermitAdmission | null;
  readonly effect: ControlPlaneEffectState;
  readonly ledger: ControlPlaneLedgerEntry;
  readonly evidenceOutbox: ControlPlaneEvidenceOutbox;
}

export class ControlPlaneValidationError extends Error {
  public constructor(
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'ControlPlaneValidationError';
  }
}

export function isControlPlaneTerminalPhase(
  phase: ControlPlanePhase,
): phase is ControlPlaneTerminalPhase {
  return (
    phase === 'COMMITTED' ||
    phase === 'RESULT_UNAVAILABLE' ||
    phase === 'FAILED_PRE_EFFECT' ||
    phase === 'UNCERTAIN'
  );
}

export function validateControlPlaneTransactionRecord(
  value: unknown,
): ControlPlaneTransactionRecord {
  assertBoundedClosedData(value, 'Control-plane transaction');
  const record = requireRecord(value, 'Control-plane transaction');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'transactionId',
      'revision',
      'createdAt',
      'updatedAt',
      'phase',
      'ticket',
      'commitPermit',
      'effect',
      'ledger',
      'evidenceOutbox',
    ],
    'Control-plane transaction',
  );
  requireLiteral(
    record.kind,
    CONTROL_PLANE_TRANSACTION_KIND,
    'Control-plane transaction kind',
  );
  requireLiteral(
    record.version,
    CONTROL_PLANE_TRANSACTION_VERSION,
    'Control-plane transaction version',
  );

  const transactionId = requireIdentifier(
    record.transactionId,
    'Transaction ID',
  );
  const revision = requirePositiveInteger(record.revision, 'Revision');
  const createdAt = requireTimestamp(record.createdAt, 'createdAt');
  const updatedAt = requireTimestamp(record.updatedAt, 'updatedAt');
  requireTimeOrder(createdAt, updatedAt, 'updatedAt precedes createdAt');
  const phase = requireEnum(
    record.phase,
    [
      'PREPARED',
      'COMMIT_PERMIT',
      'EFFECT_IN_FLIGHT',
      'COMMITTED',
      'RESULT_UNAVAILABLE',
      'FAILED_PRE_EFFECT',
      'UNCERTAIN',
    ] as const,
    'Control-plane phase',
  );
  const ticket = validateTicket(record.ticket);
  const commitPermit =
    record.commitPermit === null
      ? null
      : validateTrustedCommitPermitAdmission(record.commitPermit);
  const effect = validateEffect(record.effect);
  const ledger = validateLedger(record.ledger);
  const evidenceOutbox = validateEvidenceOutbox(record.evidenceOutbox);

  if (transactionId !== ticket.ticketId) {
    throw validationError('Transaction ID must equal ticket ID');
  }
  if (ledger.entryId.length === 0) {
    throw validationError('Ledger entry ID is empty');
  }
  assertPermitBinding(ticket, effect, commitPermit);
  assertStateProjection(
    phase,
    ticket,
    commitPermit,
    effect,
    ledger,
    evidenceOutbox,
    updatedAt,
  );
  assertReachableRevision(
    phase,
    revision,
    commitPermit,
    effect,
    evidenceOutbox.status,
  );

  const validated = deepFreeze({
    kind: CONTROL_PLANE_TRANSACTION_KIND,
    version: CONTROL_PLANE_TRANSACTION_VERSION,
    transactionId,
    revision,
    createdAt,
    updatedAt,
    phase,
    ticket,
    commitPermit,
    effect,
    ledger,
    evidenceOutbox,
  });
  const bytes = encodeUtf8(canonicalizeJson(validated)).length;
  if (bytes > CONTROL_PLANE_RECORD_LIMITS.maximumRecordBytes) {
    throw validationError('Control-plane transaction exceeds its byte limit');
  }
  return validated;
}

export function cloneControlPlaneTransactionRecord(
  record: ControlPlaneTransactionRecord,
): ControlPlaneTransactionRecord {
  const validated = validateControlPlaneTransactionRecord(record);
  return validateControlPlaneTransactionRecord(
    parseCanonicalJson(canonicalizeJson(validated)),
  );
}

export function validateTrustedCommitPermitAdmission(
  value: unknown,
): TrustedCommitPermitAdmission {
  assertBoundedClosedData(value, 'Trusted COMMIT_PERMIT admission');
  const record = requireRecord(value, 'Trusted COMMIT_PERMIT admission');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'permitId',
      'permitDigest',
      'admissionReceiptHash',
      'issuerId',
      'trustEpoch',
      'registryDigest',
      'ticketId',
      'ticketCommitment',
      'operationCommitment',
      'issuedAt',
      'expiresAt',
      'admittedAt',
    ],
    'Trusted COMMIT_PERMIT admission',
  );
  requireLiteral(
    record.kind,
    TRUSTED_COMMIT_PERMIT_KIND,
    'Trusted COMMIT_PERMIT kind',
  );
  requireLiteral(
    record.version,
    TRUSTED_COMMIT_PERMIT_VERSION,
    'Trusted COMMIT_PERMIT version',
  );
  const issuedAt = requireTimestamp(record.issuedAt, 'Permit issuedAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'Permit expiresAt');
  const admittedAt = requireTimestamp(record.admittedAt, 'Permit admittedAt');
  requireTimeOrder(issuedAt, admittedAt, 'Permit admitted before issue');
  requireTimeOrder(admittedAt, expiresAt, 'Permit admission after expiry');
  return deepFreeze({
    kind: TRUSTED_COMMIT_PERMIT_KIND,
    version: TRUSTED_COMMIT_PERMIT_VERSION,
    permitId: requireIdentifier(record.permitId, 'Permit ID'),
    permitDigest: requireCommitment(record.permitDigest, 'Permit digest'),
    admissionReceiptHash: requireCommitment(
      record.admissionReceiptHash,
      'Permit admission receipt hash',
    ),
    issuerId: requireIdentifier(record.issuerId, 'Permit issuer ID'),
    trustEpoch: requireNonNegativeInteger(record.trustEpoch, 'Trust epoch'),
    registryDigest: requireCommitment(
      record.registryDigest,
      'Trust-registry digest',
    ),
    ticketId: requireIdentifier(record.ticketId, 'Permit ticket ID'),
    ticketCommitment: requireCommitment(
      record.ticketCommitment,
      'Permit ticket commitment',
    ),
    operationCommitment: requireCommitment(
      record.operationCommitment,
      'Permit operation commitment',
    ),
    issuedAt,
    expiresAt,
    admittedAt,
  });
}

export function validateControlPlaneEvidenceAdmissionReceipt(
  value: unknown,
): ControlPlaneEvidenceAdmissionReceipt {
  assertBoundedClosedData(value, 'Evidence admission receipt');
  const record = requireRecord(value, 'Evidence admission receipt');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'receiptId',
      'transactionId',
      'evidenceIntentId',
      'attestationId',
      'evidenceEnvelopeHash',
      'evidenceLedgerId',
      'evidenceSequence',
      'checkpointDigest',
      'admittedAt',
    ],
    'Evidence admission receipt',
  );
  requireLiteral(
    record.kind,
    CONTROL_PLANE_EVIDENCE_RECEIPT_KIND,
    'Evidence receipt kind',
  );
  requireLiteral(
    record.version,
    CONTROL_PLANE_EVIDENCE_RECEIPT_VERSION,
    'Evidence receipt version',
  );
  return deepFreeze({
    kind: CONTROL_PLANE_EVIDENCE_RECEIPT_KIND,
    version: CONTROL_PLANE_EVIDENCE_RECEIPT_VERSION,
    receiptId: requireIdentifier(record.receiptId, 'Evidence receipt ID'),
    transactionId: requireIdentifier(
      record.transactionId,
      'Evidence receipt transaction ID',
    ),
    evidenceIntentId: requireIdentifier(
      record.evidenceIntentId,
      'Evidence intent ID',
    ),
    attestationId: requireIdentifier(record.attestationId, 'Attestation ID'),
    evidenceEnvelopeHash: requireCommitment(
      record.evidenceEnvelopeHash,
      'Evidence envelope hash',
    ),
    evidenceLedgerId: requireIdentifier(
      record.evidenceLedgerId,
      'Evidence ledger ID',
    ),
    evidenceSequence: requirePositiveInteger(
      record.evidenceSequence,
      'Evidence sequence',
    ),
    checkpointDigest: requireCommitment(
      record.checkpointDigest,
      'Evidence checkpoint digest',
    ),
    admittedAt: requireTimestamp(record.admittedAt, 'Evidence admittedAt'),
  });
}

export function controlPlaneIdentityKeys(
  value: ControlPlaneTransactionRecord,
): readonly string[] {
  const record = validateControlPlaneTransactionRecord(value);
  const keys = [
    `attestation:${record.evidenceOutbox.attestationId}`,
    `attempt:${record.effect.attemptId}`,
    `budget-reservation:${record.ticket.budgetReservationId}`,
    `evidence-intent:${record.evidenceOutbox.intentId}`,
    `ledger-entry:${record.ledger.entryId}`,
    `nonce:${record.ticket.nonce}`,
    `ticket:${record.ticket.ticketId}`,
    ...(record.effect.idempotencyKey === null
      ? []
      : [`idempotency:${record.effect.idempotencyKey}`]),
    ...(record.commitPermit === null
      ? []
      : [`commit-permit:${record.commitPermit.permitId}`]),
    ...(record.evidenceOutbox.admissionReceipt === null
      ? []
      : [
          `evidence-receipt:${record.evidenceOutbox.admissionReceipt.receiptId}`,
        ]),
  ].sort();
  if (new Set(keys).size !== keys.length) {
    throw validationError('Control-plane identity keys are not unique');
  }
  if (keys.some((key) => key.length > CONTROL_PLANE_IDENTITY_KEY_MAX_LENGTH)) {
    throw validationError('Control-plane identity key exceeds its bound');
  }
  return Object.freeze(keys);
}

export function snapshotClosedData(value: unknown, label: string): unknown {
  assertBoundedClosedData(value, label);
  return parseCanonicalJson(canonicalizeJson(value));
}

function validateTicket(value: unknown): ControlPlaneTicketState {
  const record = requireRecord(value, 'Ticket state');
  requireExactKeys(
    record,
    [
      'ticketId',
      'ticketCommitment',
      'authorityScopeHash',
      'nonce',
      'budgetReservationId',
      'status',
      'consumedAt',
    ],
    'Ticket state',
  );
  return deepFreeze({
    ticketId: requireIdentifier(record.ticketId, 'Ticket ID'),
    ticketCommitment: requireCommitment(
      record.ticketCommitment,
      'Ticket commitment',
    ),
    authorityScopeHash: requireCommitment(
      record.authorityScopeHash,
      'Authority-scope hash',
    ),
    nonce: requireIdentifier(record.nonce, 'Ticket nonce'),
    budgetReservationId: requireIdentifier(
      record.budgetReservationId,
      'Budget reservation ID',
    ),
    status: requireEnum(
      record.status,
      ['RESERVED', 'CONSUMED'] as const,
      'Ticket status',
    ),
    consumedAt:
      record.consumedAt === null
        ? null
        : requireTimestamp(record.consumedAt, 'Ticket consumedAt'),
  });
}

function validateEffect(value: unknown): ControlPlaneEffectState {
  const record = requireRecord(value, 'Effect state');
  requireExactKeys(
    record,
    [
      'attemptId',
      'adapterId',
      'adapterDigest',
      'operationCommitment',
      'targetObjectId',
      'preStateHash',
      'idempotencyKey',
      'status',
      'startedAt',
      'terminalAt',
      'resultHash',
      'postStateHash',
      'observationRef',
      'terminalReasonCode',
    ],
    'Effect state',
  );
  return deepFreeze({
    attemptId: requireIdentifier(record.attemptId, 'Attempt ID'),
    adapterId: requireIdentifier(record.adapterId, 'Adapter ID'),
    adapterDigest: requireCommitment(record.adapterDigest, 'Adapter digest'),
    operationCommitment: requireCommitment(
      record.operationCommitment,
      'Operation commitment',
    ),
    targetObjectId: requireIdentifier(
      record.targetObjectId,
      'Target object ID',
    ),
    preStateHash:
      record.preStateHash === null
        ? null
        : requireCommitment(record.preStateHash, 'Pre-state hash'),
    idempotencyKey:
      record.idempotencyKey === null
        ? null
        : requireIdentifier(record.idempotencyKey, 'Idempotency key'),
    status: requireEnum(
      record.status,
      [
        'NOT_STARTED',
        'IN_FLIGHT',
        'OBSERVED_COMMITTED',
        'NO_EFFECT',
        'UNCERTAIN',
      ] as const,
      'Effect status',
    ),
    startedAt:
      record.startedAt === null
        ? null
        : requireTimestamp(record.startedAt, 'Effect startedAt'),
    terminalAt:
      record.terminalAt === null
        ? null
        : requireTimestamp(record.terminalAt, 'Effect terminalAt'),
    resultHash:
      record.resultHash === null
        ? null
        : requireCommitment(record.resultHash, 'Result hash'),
    postStateHash:
      record.postStateHash === null
        ? null
        : requireCommitment(record.postStateHash, 'Post-state hash'),
    observationRef:
      record.observationRef === null
        ? null
        : requireIdentifier(record.observationRef, 'Observation reference'),
    terminalReasonCode:
      record.terminalReasonCode === null
        ? null
        : requireReasonCode(record.terminalReasonCode, 'Terminal reason code'),
  });
}

function validateLedger(value: unknown): ControlPlaneLedgerEntry {
  const record = requireRecord(value, 'Ledger projection');
  requireExactKeys(
    record,
    [
      'entryId',
      'state',
      'ticketConsumed',
      'commitPermitDigest',
      'effectMayHaveOccurred',
      'terminalReasonCode',
    ],
    'Ledger projection',
  );
  return deepFreeze({
    entryId: requireIdentifier(record.entryId, 'Ledger entry ID'),
    state: requireEnum(
      record.state,
      [
        'PREPARED',
        'COMMIT_PERMIT',
        'EFFECT_IN_FLIGHT',
        'COMMITTED',
        'RESULT_UNAVAILABLE',
        'FAILED_PRE_EFFECT',
        'UNCERTAIN',
      ] as const,
      'Ledger state',
    ),
    ticketConsumed: requireBoolean(
      record.ticketConsumed,
      'Ledger ticketConsumed',
    ),
    commitPermitDigest:
      record.commitPermitDigest === null
        ? null
        : requireCommitment(
            record.commitPermitDigest,
            'Ledger COMMIT_PERMIT digest',
          ),
    effectMayHaveOccurred: requireBoolean(
      record.effectMayHaveOccurred,
      'Ledger effectMayHaveOccurred',
    ),
    terminalReasonCode:
      record.terminalReasonCode === null
        ? null
        : requireReasonCode(
            record.terminalReasonCode,
            'Ledger terminal reason code',
          ),
  });
}

function validateEvidenceOutbox(value: unknown): ControlPlaneEvidenceOutbox {
  const record = requireRecord(value, 'Evidence outbox');
  requireExactKeys(
    record,
    [
      'intentId',
      'attestationId',
      'status',
      'terminalEvidence',
      'readyAt',
      'deliveredAt',
      'admissionReceipt',
    ],
    'Evidence outbox',
  );
  return deepFreeze({
    intentId: requireIdentifier(record.intentId, 'Evidence intent ID'),
    attestationId: requireIdentifier(
      record.attestationId,
      'Reserved attestation ID',
    ),
    status: requireEnum(
      record.status,
      ['RESERVED', 'READY', 'DELIVERED'] as const,
      'Evidence outbox status',
    ),
    terminalEvidence:
      record.terminalEvidence === null
        ? null
        : validateTerminalEvidence(record.terminalEvidence),
    readyAt:
      record.readyAt === null
        ? null
        : requireTimestamp(record.readyAt, 'Evidence readyAt'),
    deliveredAt:
      record.deliveredAt === null
        ? null
        : requireTimestamp(record.deliveredAt, 'Evidence deliveredAt'),
    admissionReceipt:
      record.admissionReceipt === null
        ? null
        : validateControlPlaneEvidenceAdmissionReceipt(record.admissionReceipt),
  });
}

function validateTerminalEvidence(
  value: unknown,
): ControlPlaneTerminalEvidence {
  const record = requireRecord(value, 'Terminal evidence');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'transactionId',
      'ledgerEntryId',
      'ticketId',
      'ticketCommitment',
      'permitId',
      'permitDigest',
      'attemptId',
      'adapterId',
      'adapterDigest',
      'operationCommitment',
      'targetObjectId',
      'terminalPhase',
      'effectMayHaveOccurred',
      'resultHash',
      'postStateHash',
      'observationRef',
      'reasonCode',
      'observedAt',
    ],
    'Terminal evidence',
  );
  requireLiteral(
    record.kind,
    CONTROL_PLANE_TERMINAL_EVIDENCE_KIND,
    'Terminal evidence kind',
  );
  requireLiteral(
    record.version,
    CONTROL_PLANE_TERMINAL_EVIDENCE_VERSION,
    'Terminal evidence version',
  );
  return deepFreeze({
    kind: CONTROL_PLANE_TERMINAL_EVIDENCE_KIND,
    version: CONTROL_PLANE_TERMINAL_EVIDENCE_VERSION,
    transactionId: requireIdentifier(
      record.transactionId,
      'Evidence transaction ID',
    ),
    ledgerEntryId: requireIdentifier(
      record.ledgerEntryId,
      'Evidence ledger entry ID',
    ),
    ticketId: requireIdentifier(record.ticketId, 'Evidence ticket ID'),
    ticketCommitment: requireCommitment(
      record.ticketCommitment,
      'Evidence ticket commitment',
    ),
    permitId:
      record.permitId === null
        ? null
        : requireIdentifier(record.permitId, 'Evidence permit ID'),
    permitDigest:
      record.permitDigest === null
        ? null
        : requireCommitment(record.permitDigest, 'Evidence permit digest'),
    attemptId: requireIdentifier(record.attemptId, 'Evidence attempt ID'),
    adapterId: requireIdentifier(record.adapterId, 'Evidence adapter ID'),
    adapterDigest: requireCommitment(
      record.adapterDigest,
      'Evidence adapter digest',
    ),
    operationCommitment: requireCommitment(
      record.operationCommitment,
      'Evidence operation commitment',
    ),
    targetObjectId: requireIdentifier(
      record.targetObjectId,
      'Evidence target object ID',
    ),
    terminalPhase: requireEnum(
      record.terminalPhase,
      [
        'COMMITTED',
        'RESULT_UNAVAILABLE',
        'FAILED_PRE_EFFECT',
        'UNCERTAIN',
      ] as const,
      'Evidence terminal phase',
    ),
    effectMayHaveOccurred: requireBoolean(
      record.effectMayHaveOccurred,
      'Evidence effectMayHaveOccurred',
    ),
    resultHash:
      record.resultHash === null
        ? null
        : requireCommitment(record.resultHash, 'Evidence result hash'),
    postStateHash:
      record.postStateHash === null
        ? null
        : requireCommitment(record.postStateHash, 'Evidence post-state hash'),
    observationRef:
      record.observationRef === null
        ? null
        : requireIdentifier(
            record.observationRef,
            'Evidence observation reference',
          ),
    reasonCode: requireReasonCode(record.reasonCode, 'Evidence reason code'),
    observedAt: requireTimestamp(record.observedAt, 'Evidence observedAt'),
  });
}

function assertPermitBinding(
  ticket: ControlPlaneTicketState,
  effect: ControlPlaneEffectState,
  permit: TrustedCommitPermitAdmission | null,
): void {
  if (permit === null) return;
  if (
    permit.ticketId !== ticket.ticketId ||
    permit.ticketCommitment !== ticket.ticketCommitment ||
    permit.operationCommitment !== effect.operationCommitment
  ) {
    throw validationError('COMMIT_PERMIT is not bound to this transaction');
  }
}

function assertStateProjection(
  phase: ControlPlanePhase,
  ticket: ControlPlaneTicketState,
  permit: TrustedCommitPermitAdmission | null,
  effect: ControlPlaneEffectState,
  ledger: ControlPlaneLedgerEntry,
  outbox: ControlPlaneEvidenceOutbox,
  updatedAt: string,
): void {
  if (ledger.state !== phase) {
    throw validationError('Ledger state does not match transaction phase');
  }
  const consumed = permit !== null;
  if (
    ledger.ticketConsumed !== consumed ||
    (consumed
      ? ticket.status !== 'CONSUMED' || ticket.consumedAt === null
      : ticket.status !== 'RESERVED' || ticket.consumedAt !== null) ||
    ledger.commitPermitDigest !== (permit?.permitDigest ?? null)
  ) {
    throw validationError('Ticket/permit/ledger projections disagree');
  }
  if (ticket.consumedAt !== null && permit !== null) {
    requireTimeOrder(
      permit.admittedAt,
      ticket.consumedAt,
      'Ticket consumed before permit admission',
    );
  }

  if (phase === 'PREPARED') {
    if (
      permit !== null ||
      effect.status !== 'NOT_STARTED' ||
      effect.startedAt !== null ||
      effect.terminalAt !== null ||
      ledger.effectMayHaveOccurred ||
      ledger.terminalReasonCode !== null ||
      outbox.status !== 'RESERVED' ||
      outbox.terminalEvidence !== null ||
      outbox.readyAt !== null ||
      outbox.deliveredAt !== null ||
      outbox.admissionReceipt !== null
    ) {
      throw validationError('PREPARED transaction has post-prepare state');
    }
    return;
  }

  if (phase === 'COMMIT_PERMIT') {
    if (
      permit === null ||
      effect.status !== 'NOT_STARTED' ||
      effect.startedAt !== null ||
      effect.terminalAt !== null ||
      ledger.effectMayHaveOccurred ||
      ledger.terminalReasonCode !== null ||
      outbox.status !== 'RESERVED' ||
      outbox.terminalEvidence !== null ||
      outbox.readyAt !== null ||
      outbox.deliveredAt !== null ||
      outbox.admissionReceipt !== null
    ) {
      throw validationError('COMMIT_PERMIT transaction shape is invalid');
    }
    return;
  }

  if (phase === 'EFFECT_IN_FLIGHT') {
    if (
      permit === null ||
      effect.status !== 'IN_FLIGHT' ||
      effect.startedAt === null ||
      effect.terminalAt !== null ||
      effect.resultHash !== null ||
      effect.postStateHash !== null ||
      effect.observationRef !== null ||
      effect.terminalReasonCode !== null ||
      !ledger.effectMayHaveOccurred ||
      ledger.terminalReasonCode !== null ||
      outbox.status !== 'RESERVED' ||
      outbox.terminalEvidence !== null ||
      outbox.readyAt !== null ||
      outbox.deliveredAt !== null ||
      outbox.admissionReceipt !== null
    ) {
      throw validationError('EFFECT_IN_FLIGHT transaction shape is invalid');
    }
    requireTimeOrder(
      ticket.consumedAt as string,
      effect.startedAt,
      'Effect started before ticket consumption',
    );
    return;
  }

  if (!isControlPlaneTerminalPhase(phase)) {
    throw validationError('Unknown non-terminal control-plane phase');
  }
  assertTerminalProjection(
    phase,
    ticket,
    permit,
    effect,
    ledger,
    outbox,
    updatedAt,
  );
}

function assertTerminalProjection(
  phase: ControlPlaneTerminalPhase,
  ticket: ControlPlaneTicketState,
  permit: TrustedCommitPermitAdmission | null,
  effect: ControlPlaneEffectState,
  ledger: ControlPlaneLedgerEntry,
  outbox: ControlPlaneEvidenceOutbox,
  updatedAt: string,
): void {
  if (
    effect.terminalAt === null ||
    effect.terminalReasonCode === null ||
    ledger.terminalReasonCode !== effect.terminalReasonCode ||
    outbox.status === 'RESERVED' ||
    outbox.terminalEvidence === null ||
    outbox.readyAt === null
  ) {
    throw validationError('Terminal transaction lacks atomic closure data');
  }
  if (effect.terminalAt !== outbox.readyAt) {
    throw validationError('Terminal timestamps do not share one closure time');
  }
  const mayHaveOccurred = phase !== 'FAILED_PRE_EFFECT';
  if (ledger.effectMayHaveOccurred !== mayHaveOccurred) {
    throw validationError('Terminal effect-occurrence projection disagrees');
  }
  if (
    phase === 'COMMITTED' &&
    (permit === null ||
      effect.startedAt === null ||
      effect.status !== 'OBSERVED_COMMITTED' ||
      effect.resultHash === null ||
      effect.postStateHash === null ||
      effect.observationRef === null)
  ) {
    throw validationError('COMMITTED requires a positive complete observation');
  }
  if (
    phase === 'RESULT_UNAVAILABLE' &&
    (permit === null ||
      effect.startedAt === null ||
      effect.status !== 'OBSERVED_COMMITTED' ||
      effect.resultHash !== null ||
      effect.postStateHash === null ||
      effect.observationRef === null)
  ) {
    throw validationError(
      'RESULT_UNAVAILABLE requires a positive committed-effect observation',
    );
  }
  if (
    phase === 'FAILED_PRE_EFFECT' &&
    (effect.status !== 'NO_EFFECT' ||
      effect.resultHash !== null ||
      effect.postStateHash !== null ||
      effect.observationRef !== null ||
      ledger.effectMayHaveOccurred)
  ) {
    throw validationError('FAILED_PRE_EFFECT cannot contain effect evidence');
  }
  if (
    phase === 'FAILED_PRE_EFFECT' &&
    ((permit === null && effect.startedAt !== null) ||
      (permit !== null && effect.startedAt === null))
  ) {
    throw validationError('FAILED_PRE_EFFECT origin is inconsistent');
  }
  if (
    phase === 'UNCERTAIN' &&
    (effect.status !== 'UNCERTAIN' ||
      effect.resultHash !== null ||
      effect.postStateHash !== null ||
      effect.observationRef !== null ||
      !ledger.effectMayHaveOccurred ||
      permit === null)
  ) {
    throw validationError('UNCERTAIN shape is invalid');
  }
  if (
    permit === null &&
    (phase !== 'FAILED_PRE_EFFECT' || ticket.status !== 'RESERVED')
  ) {
    throw validationError('Only pre-permit failure may omit COMMIT_PERMIT');
  }
  assertTerminalEvidenceBinding(
    outbox.terminalEvidence,
    phase,
    ticket,
    permit,
    effect,
    ledger,
  );
  if (outbox.status === 'READY') {
    if (
      outbox.deliveredAt !== null ||
      outbox.admissionReceipt !== null ||
      updatedAt !== outbox.readyAt
    ) {
      throw validationError('READY evidence outbox has delivery state');
    }
  } else {
    if (outbox.deliveredAt === null || outbox.admissionReceipt === null) {
      throw validationError('DELIVERED evidence outbox lacks its receipt');
    }
    requireTimeOrder(
      outbox.readyAt,
      outbox.deliveredAt,
      'Evidence delivered before it was ready',
    );
    const receipt = outbox.admissionReceipt;
    if (
      receipt.transactionId !== outbox.terminalEvidence.transactionId ||
      receipt.evidenceIntentId !== outbox.intentId ||
      receipt.attestationId !== outbox.attestationId ||
      receipt.admittedAt !== outbox.deliveredAt ||
      updatedAt !== outbox.deliveredAt
    ) {
      throw validationError('Evidence receipt is not bound to this outbox');
    }
  }
}

function assertTerminalEvidenceBinding(
  evidence: ControlPlaneTerminalEvidence,
  phase: ControlPlaneTerminalPhase,
  ticket: ControlPlaneTicketState,
  permit: TrustedCommitPermitAdmission | null,
  effect: ControlPlaneEffectState,
  ledger: ControlPlaneLedgerEntry,
): void {
  if (
    evidence.transactionId !== ticket.ticketId ||
    evidence.ledgerEntryId !== ledger.entryId ||
    evidence.ticketId !== ticket.ticketId ||
    evidence.ticketCommitment !== ticket.ticketCommitment ||
    evidence.permitId !== (permit?.permitId ?? null) ||
    evidence.permitDigest !== (permit?.permitDigest ?? null) ||
    evidence.attemptId !== effect.attemptId ||
    evidence.adapterId !== effect.adapterId ||
    evidence.adapterDigest !== effect.adapterDigest ||
    evidence.operationCommitment !== effect.operationCommitment ||
    evidence.targetObjectId !== effect.targetObjectId ||
    evidence.terminalPhase !== phase ||
    evidence.effectMayHaveOccurred !== ledger.effectMayHaveOccurred ||
    evidence.resultHash !== effect.resultHash ||
    evidence.postStateHash !== effect.postStateHash ||
    evidence.observationRef !== effect.observationRef ||
    evidence.reasonCode !== effect.terminalReasonCode ||
    evidence.observedAt !== effect.terminalAt
  ) {
    throw validationError('Terminal evidence is not an exact state projection');
  }
}

function assertReachableRevision(
  phase: ControlPlanePhase,
  revision: number,
  permit: TrustedCommitPermitAdmission | null,
  effect: ControlPlaneEffectState,
  outboxStatus: ControlPlaneEvidenceOutboxStatus,
): void {
  const baseRevision =
    phase === 'PREPARED'
      ? 1
      : phase === 'COMMIT_PERMIT'
        ? 2
        : phase === 'EFFECT_IN_FLIGHT'
          ? 3
          : phase === 'COMMITTED' || phase === 'RESULT_UNAVAILABLE'
            ? 4
            : phase === 'UNCERTAIN'
              ? effect.startedAt === null
                ? 3
                : 4
              : permit === null
                ? 2
                : 4;
  const expected =
    outboxStatus === 'DELIVERED' ? baseRevision + 1 : baseRevision;
  if (revision !== expected) {
    throw validationError('Revision cannot reach the persisted state');
  }
}

function assertBoundedClosedData(value: unknown, label: string): void {
  let nodes = 0;
  let stringBytes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (
      nodes > CONTROL_PLANE_RECORD_LIMITS.maximumNodes ||
      depth > CONTROL_PLANE_RECORD_LIMITS.maximumDepth
    ) {
      throw validationError(`${label} exceeds structural limits`);
    }
    if (typeof candidate === 'string') {
      stringBytes += encodeUtf8(candidate).length;
      if (stringBytes > CONTROL_PLANE_RECORD_LIMITS.maximumStringBytes) {
        throw validationError(`${label} exceeds its string-byte limit`);
      }
      return;
    }
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'number'
    ) {
      if (
        typeof candidate === 'number' &&
        (!Number.isFinite(candidate) || Object.is(candidate, -0))
      ) {
        throw validationError(`${label} contains a non-canonical number`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      assertClosedArray(candidate, label);
      if (candidate.length > CONTROL_PLANE_RECORD_LIMITS.maximumArrayLength) {
        throw validationError(`${label} contains an oversized array`);
      }
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const record = requireRecord(candidate, label);
    const keys = Object.keys(record);
    if (keys.length > CONTROL_PLANE_RECORD_LIMITS.maximumObjectKeys) {
      throw validationError(`${label} contains an oversized object`);
    }
    for (const key of keys) {
      stringBytes += encodeUtf8(key).length;
      if (stringBytes > CONTROL_PLANE_RECORD_LIMITS.maximumStringBytes) {
        throw validationError(`${label} exceeds its string-byte limit`);
      }
      visit(record[key], depth + 1);
    }
  };
  visit(value, 0);
}

function assertClosedArray(value: readonly unknown[], label: string): void {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw validationError(`${label} contains a non-plain array`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes('length')) {
    throw validationError(`${label} contains a sparse or extended array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw validationError(`${label} contains an accessor or sparse array`);
    }
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
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw validationError(`${label} has unknown or missing fields`);
  }
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) throw validationError(`${label} is invalid`);
  return expected;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw validationError(`${label} is invalid`);
  }
  return value as T[number];
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw validationError(`${label} must be a bounded identifier`);
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
    throw validationError(`${label} must be a bounded opaque commitment`);
  }
  return value;
}

function requireReasonCode(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/.test(value)
  ) {
    throw validationError(`${label} must be a bounded machine-readable code`);
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
    throw validationError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function requireTimeOrder(
  earlier: string,
  later: string,
  message: string,
): void {
  if (Date.parse(earlier) > Date.parse(later)) throw validationError(message);
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

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw validationError(`${label} is invalid`);
  return value;
}

function validationError(
  message: string,
  originalCause?: unknown,
): ControlPlaneValidationError {
  return new ControlPlaneValidationError(message, originalCause);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
