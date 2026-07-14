import {
  canonicalizeJson,
  validateSafeCodingEffectAttestation,
  validateSafeCodingExecutionTicket,
  type SafeCodingEffectAttestation,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';
import {
  SAFE_CODING_LEDGER_RECORD_KIND,
  SAFE_CODING_LEDGER_RECORD_VERSION,
  SafeCodingLedgerValidationError,
  cloneSafeCodingLedgerRecord,
  isSafeCodingLedgerTerminalState,
  safeCodingLedgerTimestampMilliseconds,
  validateSafeCodingEvidenceAdmissionReceipt,
  validateSafeCodingEvidenceExpectation,
  validateSafeCodingLedgerRecord,
  type SafeCodingEvidenceAdmissionReceipt,
  type SafeCodingEvidenceExpectation,
  type SafeCodingLedgerRecord,
  type SafeCodingLedgerState,
} from './records.js';

export const SAFE_CODING_LEDGER_RECORDER_PROFILE = Object.freeze({
  issuesExecutionAuthority: false,
  verifiesCommitPermitAuthority: false,
  ownsTrustedClock: false,
  atomicExternalEvidenceAndLedgerTransaction: false,
  purpose: 'record-and-close-only',
} as const);

export interface PrepareSafeCodingLedgerInput {
  readonly ticket: SafeCodingExecutionTicket;
  readonly attemptId: string;
  readonly evidenceIntentId: string;
  readonly attestationId: string;
  readonly evidenceExpectation: SafeCodingEvidenceExpectation;
  readonly now: string;
}

/**
 * Structurally compatible with the kernel's COMMIT_PERMIT output. This module
 * records an already trusted permit; it does not authenticate or issue permit
 * authority, and caller-supplied timestamps are not a trusted-clock proof.
 */
export interface SafeCodingLedgerCommitPermit {
  readonly ticketId: string;
  readonly requestId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly revocationEpoch: number;
  readonly budgetReservationId: string;
  readonly permittedAt: string;
}

interface TerminalTransitionInput {
  readonly now: string;
  readonly attestation: SafeCodingEffectAttestation;
}

export interface CloseCommittedLedgerInput extends TerminalTransitionInput {
  readonly resultHash: string;
}

export interface CloseResultUnavailableLedgerInput
  extends TerminalTransitionInput {
  readonly resultHash: string | null;
  readonly reasonCode: string;
}

export interface CloseUncertainLedgerInput extends TerminalTransitionInput {
  readonly resultHash: string | null;
  readonly reasonCode: string;
  /** True only when an observer positively established effect completion. */
  readonly effectCompletionObserved: boolean;
}

export interface CloseFailedPreEffectLedgerInput
  extends TerminalTransitionInput {
  readonly reasonCode: string;
}

export interface AdmitLedgerEvidenceInput {
  readonly receipt: VerifiedSafeCodingEvidenceAdmissionReceipt;
}

export interface SafeCodingEvidenceAdmissionReceiptVerifier {
  verify(
    receipt: SafeCodingEvidenceAdmissionReceipt,
  ): boolean | Promise<boolean>;
  /** Synchronous final fence against revocation/checkpoint rollback. */
  assertVerified(receipt: SafeCodingEvidenceAdmissionReceipt): void;
}

declare const VERIFIED_EVIDENCE_ADMISSION_RECEIPT: unique symbol;
export type VerifiedSafeCodingEvidenceAdmissionReceipt =
  SafeCodingEvidenceAdmissionReceipt & {
    readonly [VERIFIED_EVIDENCE_ADMISSION_RECEIPT]: true;
  };

interface PinnedEvidenceAdmissionReceiptVerifier {
  readonly verify: SafeCodingEvidenceAdmissionReceiptVerifier['verify'];
  readonly assertVerified: SafeCodingEvidenceAdmissionReceiptVerifier['assertVerified'];
}

const verifiedEvidenceAdmissionReceipts = new WeakMap<
  object,
  PinnedEvidenceAdmissionReceiptVerifier
>();

export function createPreparedSafeCodingLedgerRecord(
  input: PrepareSafeCodingLedgerInput,
): SafeCodingLedgerRecord {
  let ticket: SafeCodingExecutionTicket;
  try {
    ticket = validateSafeCodingExecutionTicket(input.ticket);
  } catch (error) {
    throw transitionError('PREPARED requires a valid execution ticket', error);
  }
  const nowMs = requireTimestamp(input.now, 'PREPARED timestamp');
  const issuedMs = safeCodingLedgerTimestampMilliseconds(ticket.issuedAt);
  const expiresMs = safeCodingLedgerTimestampMilliseconds(ticket.expiresAt);
  if (nowMs < issuedMs || nowMs >= expiresMs) {
    throw transitionError('PREPARED timestamp is outside ticket validity');
  }
  requireIdentifier(input.attemptId, 'Effect attempt ID');
  requireIdentifier(input.evidenceIntentId, 'Evidence intent ID');
  requireUuid(input.attestationId, 'Reserved attestation ID');
  const evidenceExpectation = validateSafeCodingEvidenceExpectation(
    input.evidenceExpectation,
  );

  return validateSafeCodingLedgerRecord({
    kind: SAFE_CODING_LEDGER_RECORD_KIND,
    version: SAFE_CODING_LEDGER_RECORD_VERSION,
    transactionId: ticket.ticketId,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    ticketState: {
      ticket,
      status: 'PREPARED',
      consumedAt: null,
      terminalAt: null,
      terminalReasonCode: null,
    },
    effectAttempt: {
      attemptId: input.attemptId,
      adapterId: ticket.adapterId,
      adapterDigest: ticket.adapterDigest,
      effectClass: ticket.effectClass,
      resolvedObjectId: ticket.resolvedObjectId,
      stateCommitmentHash: ticket.stateCommitmentHash,
      preparedAt: input.now,
      commitPermittedAt: null,
      effectObservedAt: null,
      resultHash: null,
    },
    evidenceExpectation,
    evidenceAdmission: {
      intentId: input.evidenceIntentId,
      attestationId: input.attestationId,
      status: 'RESERVED',
      attestation: null,
      readyAt: null,
      admittedAt: null,
      admissionReceipt: null,
    },
  });
}

export function recordSafeCodingCommitPermit(
  current: SafeCodingLedgerRecord,
  permitValue: SafeCodingLedgerCommitPermit,
): SafeCodingLedgerRecord {
  const record = validateSafeCodingLedgerRecord(current);
  requireState(record, 'PREPARED');
  const permit = validateCommitPermit(permitValue);
  const ticket = record.ticketState.ticket;
  if (
    permit.ticketId !== ticket.ticketId ||
    permit.requestId !== ticket.requestId ||
    permit.contractHash !== ticket.contractHash ||
    permit.contractRevision !== ticket.contractRevision ||
    permit.revocationEpoch !== ticket.revocationEpoch ||
    permit.budgetReservationId !== ticket.budgetReservationId
  ) {
    throw transitionError('COMMIT_PERMIT does not exactly match the ticket');
  }
  const permittedMs = safeCodingLedgerTimestampMilliseconds(permit.permittedAt);
  if (
    permittedMs <
      safeCodingLedgerTimestampMilliseconds(record.effectAttempt.preparedAt) ||
    permittedMs >= safeCodingLedgerTimestampMilliseconds(ticket.expiresAt)
  ) {
    throw transitionError('COMMIT_PERMIT timestamp is invalid or expired');
  }

  return finishTransition(record, {
    ...record,
    revision: nextRevision(record.revision),
    updatedAt: permit.permittedAt,
    ticketState: {
      ...record.ticketState,
      status: 'COMMIT_PERMIT',
      consumedAt: permit.permittedAt,
    },
    effectAttempt: {
      ...record.effectAttempt,
      commitPermittedAt: permit.permittedAt,
    },
  });
}

export function closeSafeCodingLedgerCommitted(
  current: SafeCodingLedgerRecord,
  input: CloseCommittedLedgerInput,
): SafeCodingLedgerRecord {
  requireDigest(input.resultHash, 'Committed result hash');
  return closePostPermit(current, {
    ...input,
    status: 'COMMITTED',
    reasonCode: null,
    effectCompletionObserved: true,
  });
}

export function closeSafeCodingLedgerResultUnavailable(
  current: SafeCodingLedgerRecord,
  input: CloseResultUnavailableLedgerInput,
): SafeCodingLedgerRecord {
  if (input.resultHash !== null) {
    requireDigest(input.resultHash, 'Unavailable result hash');
  }
  requireIdentifier(input.reasonCode, 'Result-unavailable reason code');
  return closePostPermit(current, {
    ...input,
    status: 'RESULT_UNAVAILABLE',
    effectCompletionObserved: true,
  });
}

export function closeSafeCodingLedgerUncertain(
  current: SafeCodingLedgerRecord,
  input: CloseUncertainLedgerInput,
): SafeCodingLedgerRecord {
  if (input.resultHash !== null) {
    requireDigest(input.resultHash, 'Uncertain result hash');
  }
  requireIdentifier(input.reasonCode, 'Uncertain reason code');
  if (input.resultHash !== null && !input.effectCompletionObserved) {
    throw transitionError(
      'An uncertain result hash requires observed effect completion',
    );
  }
  return closePostPermit(current, { ...input, status: 'UNCERTAIN' });
}

export function closeSafeCodingLedgerFailedPreEffect(
  current: SafeCodingLedgerRecord,
  input: CloseFailedPreEffectLedgerInput,
): SafeCodingLedgerRecord {
  const record = validateSafeCodingLedgerRecord(current);
  requireState(record, 'PREPARED');
  requireIdentifier(input.reasonCode, 'Failed-pre-effect reason code');
  const attestation = validateTerminalAttestation(
    record,
    input.attestation,
    'failed_no_effect',
    null,
    input.now,
    false,
  );
  requireNotBefore(record.updatedAt, input.now, 'Terminal timestamp regressed');

  return finishTransition(record, {
    ...record,
    revision: nextRevision(record.revision),
    updatedAt: input.now,
    ticketState: {
      ...record.ticketState,
      status: 'FAILED_PRE_EFFECT',
      terminalAt: input.now,
      terminalReasonCode: input.reasonCode,
    },
    evidenceAdmission: pendingEvidence(record, attestation, input.now),
  });
}

/**
 * Converts only an externally verified, synchronously re-fenced receipt into
 * the opaque value accepted by the ADMITTED transition. A raw digest or a
 * structurally valid caller-authored receipt is never sufficient.
 */
export async function verifySafeCodingEvidenceAdmissionReceipt(
  value: unknown,
  verifierValue: SafeCodingEvidenceAdmissionReceiptVerifier,
): Promise<VerifiedSafeCodingEvidenceAdmissionReceipt> {
  const receipt = validateSafeCodingEvidenceAdmissionReceipt(value);
  const verifier = Object.freeze({
    verify: pinPortMethod(
      verifierValue,
      'verify',
      'Evidence admission receipt verifier',
    ),
    assertVerified: pinPortMethod(
      verifierValue,
      'assertVerified',
      'Evidence admission receipt verifier',
    ),
  });
  let verified: boolean;
  try {
    verified = await verifier.verify(receipt);
  } catch (error) {
    throw transitionError(
      'Evidence admission receipt verification failed closed',
      error,
    );
  }
  if (verified !== true) {
    throw transitionError('Evidence admission receipt is not trusted');
  }
  try {
    assertSynchronous(
      verifier.assertVerified(receipt),
      'Final evidence admission receipt fence',
    );
  } catch (error) {
    throw transitionError(
      'Evidence admission receipt final trust fence failed closed',
      error,
    );
  }
  verifiedEvidenceAdmissionReceipts.set(receipt, verifier);
  return receipt as VerifiedSafeCodingEvidenceAdmissionReceipt;
}

export function markSafeCodingLedgerEvidenceAdmitted(
  current: SafeCodingLedgerRecord,
  input: AdmitLedgerEvidenceInput,
): SafeCodingLedgerRecord {
  assertClosedRecord(input, ['receipt'], 'Evidence admission transition input');
  const record = validateSafeCodingLedgerRecord(current);
  if (!isSafeCodingLedgerTerminalState(record.ticketState.status)) {
    throw transitionError('Evidence cannot be admitted before terminal state');
  }
  if (record.evidenceAdmission.status !== 'PENDING') {
    throw transitionError('Evidence intent is not pending admission');
  }
  const receipt = requireVerifiedEvidenceAdmissionReceipt(input.receipt);
  if (
    receipt.transactionId !== record.transactionId ||
    receipt.evidenceIntentId !== record.evidenceAdmission.intentId ||
    receipt.attestationId !== record.evidenceAdmission.attestationId
  ) {
    throw transitionError(
      'Evidence admission receipt does not bind the pending outbox identity',
    );
  }
  requireNotBefore(
    record.updatedAt,
    receipt.admittedAt,
    'Admission timestamp regressed',
  );

  return finishTransition(record, {
    ...record,
    revision: nextRevision(record.revision),
    updatedAt: receipt.admittedAt,
    evidenceAdmission: {
      ...record.evidenceAdmission,
      status: 'ADMITTED',
      admittedAt: receipt.admittedAt,
      admissionReceipt: receipt,
    },
  });
}

export function assertSafeCodingLedgerSuccessor(
  previousValue: SafeCodingLedgerRecord,
  nextValue: SafeCodingLedgerRecord,
): void {
  const previous = validateSafeCodingLedgerRecord(previousValue);
  const next = validateSafeCodingLedgerRecord(nextValue);
  if (next.revision !== nextRevision(previous.revision)) {
    throw transitionError('Ledger revision must advance by exactly one');
  }
  if (
    next.transactionId !== previous.transactionId ||
    next.createdAt !== previous.createdAt ||
    canonicalizeJson(next.ticketState.ticket) !==
      canonicalizeJson(previous.ticketState.ticket) ||
    next.effectAttempt.attemptId !== previous.effectAttempt.attemptId ||
    canonicalizeJson(next.evidenceExpectation) !==
      canonicalizeJson(previous.evidenceExpectation) ||
    next.evidenceAdmission.intentId !== previous.evidenceAdmission.intentId ||
    next.evidenceAdmission.attestationId !==
      previous.evidenceAdmission.attestationId
  ) {
    throw transitionError('Ledger successor changed immutable identity');
  }
  requireNotBefore(
    previous.updatedAt,
    next.updatedAt,
    'Ledger successor timestamp regressed',
  );

  const from = previous.ticketState.status;
  const to = next.ticketState.status;
  if (from === 'PREPARED') {
    if (to !== 'COMMIT_PERMIT' && to !== 'FAILED_PRE_EFFECT') {
      throw transitionError(`Invalid ledger transition ${from} -> ${to}`);
    }
  } else if (from === 'COMMIT_PERMIT') {
    if (
      to !== 'COMMITTED' &&
      to !== 'RESULT_UNAVAILABLE' &&
      to !== 'UNCERTAIN'
    ) {
      throw transitionError(`Invalid ledger transition ${from} -> ${to}`);
    }
  } else {
    if (to !== from) {
      throw transitionError('Terminal ledger state cannot reopen or change');
    }
    assertAdmissionOnlySuccessor(previous, next);
  }
}

function closePostPermit(
  current: SafeCodingLedgerRecord,
  input: TerminalTransitionInput & {
    readonly status: 'COMMITTED' | 'RESULT_UNAVAILABLE' | 'UNCERTAIN';
    readonly resultHash: string | null;
    readonly reasonCode: string | null;
    readonly effectCompletionObserved: boolean;
  },
): SafeCodingLedgerRecord {
  const record = validateSafeCodingLedgerRecord(current);
  requireState(record, 'COMMIT_PERMIT');
  const expectedAttestationStatus =
    input.status === 'COMMITTED'
      ? 'committed'
      : input.status === 'RESULT_UNAVAILABLE'
        ? 'committed_result_unavailable'
        : 'uncertain';
  const attestation = validateTerminalAttestation(
    record,
    input.attestation,
    expectedAttestationStatus,
    input.resultHash,
    input.now,
    input.effectCompletionObserved,
  );
  requireNotBefore(record.updatedAt, input.now, 'Terminal timestamp regressed');

  return finishTransition(record, {
    ...record,
    revision: nextRevision(record.revision),
    updatedAt: input.now,
    ticketState: {
      ...record.ticketState,
      status: input.status,
      terminalAt: input.now,
      terminalReasonCode: input.reasonCode,
    },
    effectAttempt: {
      ...record.effectAttempt,
      effectObservedAt: input.effectCompletionObserved ? input.now : null,
      resultHash: input.resultHash,
    },
    evidenceAdmission: pendingEvidence(record, attestation, input.now),
  });
}

function validateTerminalAttestation(
  record: SafeCodingLedgerRecord,
  value: SafeCodingEffectAttestation,
  expectedStatus: SafeCodingEffectAttestation['status'],
  resultHash: string | null,
  terminalAt: string,
  effectCompletionObserved: boolean,
): SafeCodingEffectAttestation {
  let attestation: SafeCodingEffectAttestation;
  try {
    attestation = validateSafeCodingEffectAttestation(value);
  } catch (error) {
    throw transitionError('Terminal attestation is invalid', error);
  }
  const ticket = record.ticketState.ticket;
  const expectation = record.evidenceExpectation;
  const noEffect =
    expectedStatus === 'failed_no_effect' ||
    (expectedStatus === 'uncertain' && !effectCompletionObserved);
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
  if (
    attestation.attestationId !== record.evidenceAdmission.attestationId ||
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
    attestation.status !== expectedStatus ||
    attestation.resultHash !== resultHash ||
    canonicalizeJson(attestation.budgetCharges) !==
      canonicalizeJson(expectedBudgetCharges) ||
    attestation.startedAt !== record.effectAttempt.preparedAt ||
    attestation.finishedAt !== terminalAt ||
    attestation.evidenceLevel !== expectedEvidenceLevel ||
    attestation.reconciliationRef !== expectedReconciliationRef
  ) {
    throw transitionError('Terminal attestation does not match the attempt');
  }
  return attestation;
}

const ZERO_BUDGET_CHARGES = Object.freeze({
  uniqueModifiedFiles: 0,
  mutationBytes: 0,
  testRuns: 0,
});

function pendingEvidence(
  record: SafeCodingLedgerRecord,
  attestation: SafeCodingEffectAttestation,
  now: string,
) {
  return {
    ...record.evidenceAdmission,
    status: 'PENDING' as const,
    attestation,
    readyAt: now,
  };
}

function assertAdmissionOnlySuccessor(
  previous: SafeCodingLedgerRecord,
  next: SafeCodingLedgerRecord,
): void {
  if (
    previous.evidenceAdmission.status !== 'PENDING' ||
    next.evidenceAdmission.status !== 'ADMITTED'
  ) {
    throw transitionError('Terminal successor may only acknowledge evidence');
  }
  if (
    canonicalizeJson(previous.ticketState) !==
      canonicalizeJson(next.ticketState) ||
    canonicalizeJson(previous.effectAttempt) !==
      canonicalizeJson(next.effectAttempt) ||
    previous.evidenceAdmission.intentId !== next.evidenceAdmission.intentId ||
    previous.evidenceAdmission.attestationId !==
      next.evidenceAdmission.attestationId ||
    previous.evidenceAdmission.readyAt !== next.evidenceAdmission.readyAt ||
    canonicalizeJson(previous.evidenceAdmission.attestation) !==
      canonicalizeJson(next.evidenceAdmission.attestation)
  ) {
    throw transitionError('Evidence acknowledgement mutated terminal outcome');
  }
}

function finishTransition(
  previous: SafeCodingLedgerRecord,
  nextValue: SafeCodingLedgerRecord,
): SafeCodingLedgerRecord {
  const next = validateSafeCodingLedgerRecord(nextValue);
  assertSafeCodingLedgerSuccessor(previous, next);
  return cloneSafeCodingLedgerRecord(next);
}

function validateCommitPermit(
  value: SafeCodingLedgerCommitPermit,
): SafeCodingLedgerCommitPermit {
  assertClosedRecord(
    value,
    [
      'ticketId',
      'requestId',
      'contractHash',
      'contractRevision',
      'revocationEpoch',
      'budgetReservationId',
      'permittedAt',
    ],
    'COMMIT_PERMIT',
  );
  return Object.freeze({
    ticketId: requireIdentifier(value.ticketId, 'Permit ticket ID'),
    requestId: requireIdentifier(value.requestId, 'Permit request ID'),
    contractHash: requireDigest(value.contractHash, 'Permit contract hash'),
    contractRevision: requirePositiveInteger(
      value.contractRevision,
      'Permit contract revision',
    ),
    revocationEpoch: requireNonNegativeInteger(
      value.revocationEpoch,
      'Permit revocation epoch',
    ),
    budgetReservationId: requireIdentifier(
      value.budgetReservationId,
      'Permit budget reservation ID',
    ),
    permittedAt: requireTimestampString(value.permittedAt, 'Permit timestamp'),
  });
}

function assertClosedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): void {
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
    throw transitionError(`${label} must be a closed data record`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw transitionError(`${label} has unknown or missing fields`);
  }
}

function requireVerifiedEvidenceAdmissionReceipt(
  value: VerifiedSafeCodingEvidenceAdmissionReceipt,
): SafeCodingEvidenceAdmissionReceipt {
  if (
    value === null ||
    typeof value !== 'object' ||
    !verifiedEvidenceAdmissionReceipts.has(value)
  ) {
    throw transitionError(
      'ADMITTED requires a receipt returned by the trusted verifier',
    );
  }
  const verifier = verifiedEvidenceAdmissionReceipts.get(value)!;
  try {
    assertSynchronous(
      verifier.assertVerified(value),
      'Final one-shot evidence admission receipt fence',
    );
  } catch (error) {
    verifiedEvidenceAdmissionReceipts.delete(value);
    throw transitionError(
      'Evidence admission receipt became stale before one-shot use',
      error,
    );
  }
  verifiedEvidenceAdmissionReceipts.delete(value);
  return value;
}

function assertSynchronous(value: unknown, label: string): void {
  if (value !== undefined) {
    throw transitionError(`${label} must synchronously return undefined`);
  }
}

function pinPortMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (
    port === null ||
    (typeof port !== 'object' && typeof port !== 'function')
  ) {
    throw transitionError(`${label} is missing`);
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw transitionError(`${label} ${String(name)} must be a data method`);
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw transitionError(`${label} must provide ${String(name)}()`);
}

function requireState(
  record: SafeCodingLedgerRecord,
  expected: SafeCodingLedgerState,
): void {
  if (record.ticketState.status !== expected) {
    throw transitionError(
      `Expected ${expected}, received ${record.ticketState.status}`,
    );
  }
}

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw transitionError('Ledger revision cannot be incremented safely');
  }
  return revision + 1;
}

function requireTimestamp(value: string, label: string): number {
  try {
    return safeCodingLedgerTimestampMilliseconds(value);
  } catch (error) {
    throw transitionError(`${label} is invalid`, error);
  }
}

function requireTimestampString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw transitionError(`${label} is invalid`);
  requireTimestamp(value, label);
  return value;
}

function requireNotBefore(
  before: string,
  after: string,
  message: string,
): void {
  if (requireTimestamp(after, message) < requireTimestamp(before, message)) {
    throw transitionError(message);
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw transitionError(`${label} must be a bounded identifier`);
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
    throw transitionError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw transitionError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw transitionError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw transitionError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function transitionError(message: string, cause?: unknown) {
  const error = new SafeCodingLedgerValidationError(message);
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
