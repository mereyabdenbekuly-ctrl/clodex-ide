import {
  isControlPlaneTerminalPhase,
  validateControlPlaneTransactionRecord,
  type ControlPlanePhase,
  type ControlPlaneTransactionRecord,
} from './model.js';

export type ControlPlaneRecoveryAction =
  | 'CLOSE_FAILED_PRE_EFFECT'
  | 'CLOSE_UNCERTAIN'
  | 'DELIVER_EVIDENCE_ONLY'
  | 'REVERIFY_DELIVERY_RECEIPT'
  | 'NO_ACTION';

export interface ControlPlaneRecoveryDecision {
  readonly transactionId: string;
  readonly revision: number;
  readonly observedPhase: ControlPlanePhase;
  readonly action: ControlPlaneRecoveryAction;
  readonly targetPhase: ControlPlanePhase;
  readonly reasonCode: string;
  readonly effectReplayAllowed: false;
  readonly effectMayHaveOccurred: boolean;
  readonly reconciliationRequired: boolean;
}

/**
 * Deterministic restart classification from durable local state only. No
 * branch ever returns an effect-execution action.
 */
export function classifyControlPlaneRecovery(
  value: ControlPlaneTransactionRecord,
): ControlPlaneRecoveryDecision {
  const record = validateControlPlaneTransactionRecord(value);
  const phase = record.phase;
  if (phase === 'PREPARED') {
    return decision(record, {
      action: 'CLOSE_FAILED_PRE_EFFECT',
      targetPhase: 'FAILED_PRE_EFFECT',
      reasonCode: 'recovery-before-commit-permit',
      effectMayHaveOccurred: false,
      reconciliationRequired: false,
    });
  }
  if (phase === 'COMMIT_PERMIT' || phase === 'EFFECT_IN_FLIGHT') {
    return decision(record, {
      action: 'CLOSE_UNCERTAIN',
      targetPhase: 'UNCERTAIN',
      reasonCode: 'recovery-after-commit-permit',
      effectMayHaveOccurred: true,
      reconciliationRequired: true,
    });
  }
  if (!isControlPlaneTerminalPhase(phase)) {
    return assertNever(phase);
  }
  if (record.evidenceOutbox.status === 'READY') {
    return decision(record, {
      action: 'DELIVER_EVIDENCE_ONLY',
      targetPhase: phase,
      reasonCode: 'terminal-evidence-delivery-pending',
      effectMayHaveOccurred: phase !== 'FAILED_PRE_EFFECT',
      reconciliationRequired: true,
    });
  }
  return decision(record, {
    action: 'REVERIFY_DELIVERY_RECEIPT',
    targetPhase: phase,
    reasonCode: 'terminal-evidence-receipt-reverification-required',
    effectMayHaveOccurred: phase !== 'FAILED_PRE_EFFECT',
    reconciliationRequired: true,
  });
}

function decision(
  record: ControlPlaneTransactionRecord,
  value: Omit<
    ControlPlaneRecoveryDecision,
    'transactionId' | 'revision' | 'observedPhase' | 'effectReplayAllowed'
  >,
): ControlPlaneRecoveryDecision {
  return Object.freeze({
    transactionId: record.transactionId,
    revision: record.revision,
    observedPhase: record.phase,
    ...value,
    effectReplayAllowed: false,
  });
}

function assertNever(value: never): never {
  throw new Error(`Unknown control-plane phase: ${String(value)}`);
}
