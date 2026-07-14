import { canonicalizeJson } from '@clodex/contracts';
import {
  CONTROL_PLANE_TERMINAL_EVIDENCE_KIND,
  CONTROL_PLANE_TERMINAL_EVIDENCE_VERSION,
  CONTROL_PLANE_TRANSACTION_KIND,
  CONTROL_PLANE_TRANSACTION_VERSION,
  ControlPlaneValidationError,
  cloneControlPlaneTransactionRecord,
  isControlPlaneTerminalPhase,
  validateControlPlaneEvidenceAdmissionReceipt,
  validateControlPlaneTransactionRecord,
  validateTrustedCommitPermitAdmission,
  type ControlPlaneEvidenceAdmissionReceipt,
  type ControlPlaneTerminalEvidence,
  type ControlPlaneTerminalPhase,
  type ControlPlaneTransactionRecord,
  type TrustedCommitPermitAdmission,
} from './model.js';
import type { ControlPlaneEffectObservation } from './ports.js';

export interface PrepareControlPlaneTransactionInput {
  readonly transactionId: string;
  readonly ticketCommitment: string;
  readonly authorityScopeHash: string;
  readonly nonce: string;
  readonly budgetReservationId: string;
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly operationCommitment: string;
  readonly targetObjectId: string;
  readonly preStateHash: string | null;
  readonly idempotencyKey: string | null;
  readonly ledgerEntryId: string;
  readonly evidenceIntentId: string;
  readonly attestationId: string;
  readonly now: string;
}

export function createPreparedControlPlaneRecord(
  input: PrepareControlPlaneTransactionInput,
): ControlPlaneTransactionRecord {
  return validateControlPlaneTransactionRecord({
    kind: CONTROL_PLANE_TRANSACTION_KIND,
    version: CONTROL_PLANE_TRANSACTION_VERSION,
    transactionId: input.transactionId,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    phase: 'PREPARED',
    ticket: {
      ticketId: input.transactionId,
      ticketCommitment: input.ticketCommitment,
      authorityScopeHash: input.authorityScopeHash,
      nonce: input.nonce,
      budgetReservationId: input.budgetReservationId,
      status: 'RESERVED',
      consumedAt: null,
    },
    commitPermit: null,
    effect: {
      attemptId: input.attemptId,
      adapterId: input.adapterId,
      adapterDigest: input.adapterDigest,
      operationCommitment: input.operationCommitment,
      targetObjectId: input.targetObjectId,
      preStateHash: input.preStateHash,
      idempotencyKey: input.idempotencyKey,
      status: 'NOT_STARTED',
      startedAt: null,
      terminalAt: null,
      resultHash: null,
      postStateHash: null,
      observationRef: null,
      terminalReasonCode: null,
    },
    ledger: {
      entryId: input.ledgerEntryId,
      state: 'PREPARED',
      ticketConsumed: false,
      commitPermitDigest: null,
      effectMayHaveOccurred: false,
      terminalReasonCode: null,
    },
    evidenceOutbox: {
      intentId: input.evidenceIntentId,
      attestationId: input.attestationId,
      status: 'RESERVED',
      terminalEvidence: null,
      readyAt: null,
      deliveredAt: null,
      admissionReceipt: null,
    },
  });
}

export function consumeCommitPermit(
  value: ControlPlaneTransactionRecord,
  permitValue: TrustedCommitPermitAdmission,
  now: string,
): ControlPlaneTransactionRecord {
  const current = validateControlPlaneTransactionRecord(value);
  const permit = validateTrustedCommitPermitAdmission(permitValue);
  if (current.phase !== 'PREPARED') {
    throw transitionError('Only PREPARED may consume COMMIT_PERMIT');
  }
  assertNotBefore(current.updatedAt, now, 'COMMIT_PERMIT time moved backwards');
  assertNotBefore(
    permit.admittedAt,
    now,
    'COMMIT_PERMIT consumed before admission',
  );
  assertAtOrBefore(
    now,
    permit.expiresAt,
    'COMMIT_PERMIT expired before consumption',
  );
  if (
    permit.ticketId !== current.ticket.ticketId ||
    permit.ticketCommitment !== current.ticket.ticketCommitment ||
    permit.operationCommitment !== current.effect.operationCommitment
  ) {
    throw transitionError('COMMIT_PERMIT binding does not match transaction');
  }
  return validateControlPlaneTransactionRecord({
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
    phase: 'COMMIT_PERMIT',
    ticket: {
      ...current.ticket,
      status: 'CONSUMED',
      consumedAt: now,
    },
    commitPermit: permit,
    ledger: {
      ...current.ledger,
      state: 'COMMIT_PERMIT',
      ticketConsumed: true,
      commitPermitDigest: permit.permitDigest,
    },
  });
}

export function markControlPlaneEffectInFlight(
  value: ControlPlaneTransactionRecord,
  now: string,
): ControlPlaneTransactionRecord {
  const current = validateControlPlaneTransactionRecord(value);
  if (current.phase !== 'COMMIT_PERMIT' || current.commitPermit === null) {
    throw transitionError('Effect may start only from COMMIT_PERMIT');
  }
  assertNotBefore(current.updatedAt, now, 'Effect start time moved backwards');
  assertAtOrBefore(
    now,
    current.commitPermit.expiresAt,
    'COMMIT_PERMIT expired before effect start',
  );
  return validateControlPlaneTransactionRecord({
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
    phase: 'EFFECT_IN_FLIGHT',
    effect: {
      ...current.effect,
      status: 'IN_FLIGHT',
      startedAt: now,
    },
    ledger: {
      ...current.ledger,
      state: 'EFFECT_IN_FLIGHT',
      effectMayHaveOccurred: true,
    },
  });
}

export function closeControlPlaneFromEffectObservation(
  value: ControlPlaneTransactionRecord,
  observation: ControlPlaneEffectObservation,
  now: string,
): ControlPlaneTransactionRecord {
  const current = validateControlPlaneTransactionRecord(value);
  if (current.phase !== 'EFFECT_IN_FLIGHT') {
    throw transitionError('Effect observation requires EFFECT_IN_FLIGHT');
  }
  if (observation.outcome === 'COMMITTED') {
    return closeTerminal(current, {
      phase: 'COMMITTED',
      effectStatus: 'OBSERVED_COMMITTED',
      resultHash: observation.resultHash,
      postStateHash: observation.postStateHash,
      observationRef: observation.observationRef,
      reasonCode: observation.reasonCode,
      now,
    });
  }
  if (observation.outcome === 'RESULT_UNAVAILABLE') {
    return closeTerminal(current, {
      phase: 'RESULT_UNAVAILABLE',
      effectStatus: 'OBSERVED_COMMITTED',
      resultHash: null,
      postStateHash: observation.postStateHash,
      observationRef: observation.observationRef,
      reasonCode: observation.reasonCode,
      now,
    });
  }
  if (observation.outcome === 'NO_EFFECT') {
    return closeTerminal(current, {
      phase: 'FAILED_PRE_EFFECT',
      effectStatus: 'NO_EFFECT',
      resultHash: null,
      postStateHash: null,
      observationRef: null,
      reasonCode: observation.reasonCode,
      now,
    });
  }
  return closeTerminal(current, {
    phase: 'UNCERTAIN',
    effectStatus: 'UNCERTAIN',
    resultHash: null,
    postStateHash: null,
    observationRef: null,
    reasonCode: observation.reasonCode,
    now,
  });
}

export function closeControlPlaneFailedBeforePermit(
  value: ControlPlaneTransactionRecord,
  reasonCode: string,
  now: string,
): ControlPlaneTransactionRecord {
  const current = validateControlPlaneTransactionRecord(value);
  if (current.phase !== 'PREPARED') {
    throw transitionError('Pre-permit failure requires PREPARED');
  }
  return closeTerminal(current, {
    phase: 'FAILED_PRE_EFFECT',
    effectStatus: 'NO_EFFECT',
    resultHash: null,
    postStateHash: null,
    observationRef: null,
    reasonCode,
    now,
  });
}

export function closeControlPlaneUncertainAfterPermit(
  value: ControlPlaneTransactionRecord,
  reasonCode: string,
  now: string,
): ControlPlaneTransactionRecord {
  const current = validateControlPlaneTransactionRecord(value);
  if (
    current.phase !== 'COMMIT_PERMIT' &&
    current.phase !== 'EFFECT_IN_FLIGHT'
  ) {
    throw transitionError(
      'Post-permit uncertainty requires COMMIT_PERMIT or EFFECT_IN_FLIGHT',
    );
  }
  return closeTerminal(current, {
    phase: 'UNCERTAIN',
    effectStatus: 'UNCERTAIN',
    resultHash: null,
    postStateHash: null,
    observationRef: null,
    reasonCode,
    now,
  });
}

export function markControlPlaneEvidenceDelivered(
  value: ControlPlaneTransactionRecord,
  receiptValue: ControlPlaneEvidenceAdmissionReceipt,
): ControlPlaneTransactionRecord {
  const current = validateControlPlaneTransactionRecord(value);
  const receipt = validateControlPlaneEvidenceAdmissionReceipt(receiptValue);
  if (
    !isControlPlaneTerminalPhase(current.phase) ||
    current.evidenceOutbox.status !== 'READY' ||
    current.evidenceOutbox.readyAt === null
  ) {
    throw transitionError('Only READY terminal evidence may be delivered');
  }
  if (
    receipt.transactionId !== current.transactionId ||
    receipt.evidenceIntentId !== current.evidenceOutbox.intentId ||
    receipt.attestationId !== current.evidenceOutbox.attestationId
  ) {
    throw transitionError('Evidence admission receipt binding mismatch');
  }
  assertNotBefore(
    current.updatedAt,
    receipt.admittedAt,
    'Evidence admission time moved backwards',
  );
  return validateControlPlaneTransactionRecord({
    ...current,
    revision: current.revision + 1,
    updatedAt: receipt.admittedAt,
    evidenceOutbox: {
      ...current.evidenceOutbox,
      status: 'DELIVERED',
      deliveredAt: receipt.admittedAt,
      admissionReceipt: receipt,
    },
  });
}

export function assertControlPlaneSuccessor(
  previousValue: ControlPlaneTransactionRecord,
  nextValue: ControlPlaneTransactionRecord,
): void {
  const previous = validateControlPlaneTransactionRecord(previousValue);
  const next = validateControlPlaneTransactionRecord(nextValue);
  if (
    next.transactionId !== previous.transactionId ||
    next.revision !== previous.revision + 1 ||
    next.createdAt !== previous.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  ) {
    throw transitionError('Control-plane successor revision is invalid');
  }
  assertCanonicalEqual(
    {
      ticketId: previous.ticket.ticketId,
      ticketCommitment: previous.ticket.ticketCommitment,
      authorityScopeHash: previous.ticket.authorityScopeHash,
      nonce: previous.ticket.nonce,
      budgetReservationId: previous.ticket.budgetReservationId,
      effect: {
        attemptId: previous.effect.attemptId,
        adapterId: previous.effect.adapterId,
        adapterDigest: previous.effect.adapterDigest,
        operationCommitment: previous.effect.operationCommitment,
        targetObjectId: previous.effect.targetObjectId,
        preStateHash: previous.effect.preStateHash,
        idempotencyKey: previous.effect.idempotencyKey,
      },
      ledgerEntryId: previous.ledger.entryId,
      outbox: {
        intentId: previous.evidenceOutbox.intentId,
        attestationId: previous.evidenceOutbox.attestationId,
      },
    },
    {
      ticketId: next.ticket.ticketId,
      ticketCommitment: next.ticket.ticketCommitment,
      authorityScopeHash: next.ticket.authorityScopeHash,
      nonce: next.ticket.nonce,
      budgetReservationId: next.ticket.budgetReservationId,
      effect: {
        attemptId: next.effect.attemptId,
        adapterId: next.effect.adapterId,
        adapterDigest: next.effect.adapterDigest,
        operationCommitment: next.effect.operationCommitment,
        targetObjectId: next.effect.targetObjectId,
        preStateHash: next.effect.preStateHash,
        idempotencyKey: next.effect.idempotencyKey,
      },
      ledgerEntryId: next.ledger.entryId,
      outbox: {
        intentId: next.evidenceOutbox.intentId,
        attestationId: next.evidenceOutbox.attestationId,
      },
    },
    'Control-plane immutable identity changed',
  );
  assertAllowedPhaseTransition(previous.phase, next.phase);
  if (previous.commitPermit !== null) {
    assertCanonicalEqual(
      previous.commitPermit,
      next.commitPermit,
      'COMMIT_PERMIT changed after consumption',
    );
  }
  if (previous.evidenceOutbox.terminalEvidence !== null) {
    assertCanonicalEqual(
      previous.evidenceOutbox.terminalEvidence,
      next.evidenceOutbox.terminalEvidence,
      'Terminal evidence changed after closure',
    );
  }
  if (
    (previous.evidenceOutbox.status === 'RESERVED' &&
      next.evidenceOutbox.status !==
        (isControlPlaneTerminalPhase(next.phase) ? 'READY' : 'RESERVED')) ||
    (previous.evidenceOutbox.status === 'READY' &&
      next.evidenceOutbox.status !== 'DELIVERED')
  ) {
    throw transitionError('Evidence outbox transition is not atomic/reachable');
  }
  if (previous.evidenceOutbox.status === 'DELIVERED') {
    throw transitionError('DELIVERED transaction is immutable');
  }
}

function closeTerminal(
  current: ControlPlaneTransactionRecord,
  terminal: {
    readonly phase: ControlPlaneTerminalPhase;
    readonly effectStatus: 'OBSERVED_COMMITTED' | 'NO_EFFECT' | 'UNCERTAIN';
    readonly resultHash: string | null;
    readonly postStateHash: string | null;
    readonly observationRef: string | null;
    readonly reasonCode: string;
    readonly now: string;
  },
): ControlPlaneTransactionRecord {
  assertNotBefore(
    current.updatedAt,
    terminal.now,
    'Terminal time moved backwards',
  );
  const effect = {
    ...current.effect,
    status: terminal.effectStatus,
    terminalAt: terminal.now,
    resultHash: terminal.resultHash,
    postStateHash: terminal.postStateHash,
    observationRef: terminal.observationRef,
    terminalReasonCode: terminal.reasonCode,
  } as const;
  const effectMayHaveOccurred = terminal.phase !== 'FAILED_PRE_EFFECT';
  const evidence = createTerminalEvidence(
    current,
    terminal.phase,
    effectMayHaveOccurred,
    effect,
    terminal.reasonCode,
    terminal.now,
  );
  return validateControlPlaneTransactionRecord({
    ...current,
    revision: current.revision + 1,
    updatedAt: terminal.now,
    phase: terminal.phase,
    effect,
    ledger: {
      ...current.ledger,
      state: terminal.phase,
      effectMayHaveOccurred,
      terminalReasonCode: terminal.reasonCode,
    },
    evidenceOutbox: {
      ...current.evidenceOutbox,
      status: 'READY',
      terminalEvidence: evidence,
      readyAt: terminal.now,
    },
  });
}

function createTerminalEvidence(
  current: ControlPlaneTransactionRecord,
  phase: ControlPlaneTerminalPhase,
  effectMayHaveOccurred: boolean,
  effect: ControlPlaneTransactionRecord['effect'],
  reasonCode: string,
  observedAt: string,
): ControlPlaneTerminalEvidence {
  return {
    kind: CONTROL_PLANE_TERMINAL_EVIDENCE_KIND,
    version: CONTROL_PLANE_TERMINAL_EVIDENCE_VERSION,
    transactionId: current.transactionId,
    ledgerEntryId: current.ledger.entryId,
    ticketId: current.ticket.ticketId,
    ticketCommitment: current.ticket.ticketCommitment,
    permitId: current.commitPermit?.permitId ?? null,
    permitDigest: current.commitPermit?.permitDigest ?? null,
    attemptId: effect.attemptId,
    adapterId: effect.adapterId,
    adapterDigest: effect.adapterDigest,
    operationCommitment: effect.operationCommitment,
    targetObjectId: effect.targetObjectId,
    terminalPhase: phase,
    effectMayHaveOccurred,
    resultHash: effect.resultHash,
    postStateHash: effect.postStateHash,
    observationRef: effect.observationRef,
    reasonCode,
    observedAt,
  };
}

function assertAllowedPhaseTransition(
  previous: ControlPlaneTransactionRecord['phase'],
  next: ControlPlaneTransactionRecord['phase'],
): void {
  const allowed =
    (previous === 'PREPARED' &&
      (next === 'COMMIT_PERMIT' || next === 'FAILED_PRE_EFFECT')) ||
    (previous === 'COMMIT_PERMIT' &&
      (next === 'EFFECT_IN_FLIGHT' || next === 'UNCERTAIN')) ||
    (previous === 'EFFECT_IN_FLIGHT' && isControlPlaneTerminalPhase(next)) ||
    (isControlPlaneTerminalPhase(previous) && previous === next);
  if (!allowed) {
    throw transitionError(`Illegal phase transition ${previous} -> ${next}`);
  }
}

function assertCanonicalEqual(
  left: unknown,
  right: unknown,
  message: string,
): void {
  if (canonicalizeJson(left) !== canonicalizeJson(right)) {
    throw transitionError(message);
  }
}

function assertNotBefore(
  earlier: string,
  later: string,
  message: string,
): void {
  if (Date.parse(later) < Date.parse(earlier)) throw transitionError(message);
}

function assertAtOrBefore(
  earlier: string,
  later: string,
  message: string,
): void {
  if (Date.parse(earlier) > Date.parse(later)) throw transitionError(message);
}

function transitionError(message: string): ControlPlaneValidationError {
  return new ControlPlaneValidationError(message);
}

/** Detached canonical clone useful to adapters and transition tests. */
export function cloneControlPlaneSuccessor(
  value: ControlPlaneTransactionRecord,
): ControlPlaneTransactionRecord {
  return cloneControlPlaneTransactionRecord(value);
}
