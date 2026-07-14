import {
  isSafeCodingLedgerTerminalState,
  validateSafeCodingLedgerRecord,
  type SafeCodingLedgerRecord,
  type SafeCodingLedgerState,
} from './records.js';

export type SafeCodingLedgerRecoveryAction =
  | 'CLOSE_FAILED_PRE_EFFECT'
  | 'CLOSE_UNCERTAIN'
  | 'DELIVER_EVIDENCE_ONLY'
  | 'NO_ACTION';

export interface SafeCodingLedgerRecoveryDecision {
  readonly transactionId: string;
  readonly revision: number;
  readonly observedState: SafeCodingLedgerState;
  readonly action: SafeCodingLedgerRecoveryAction;
  readonly targetState: SafeCodingLedgerState;
  readonly reasonCode: string;
  /** Recovery never replays the same ticket or effect attempt. */
  readonly effectReplayAllowed: false;
  readonly effectMayHaveOccurred: boolean;
  readonly reconciliationRequired: boolean;
}

/**
 * Classifies only from persisted state. It never probes or executes the target
 * effect, so the same record always produces the same decision.
 */
export function classifySafeCodingLedgerRecovery(
  value: SafeCodingLedgerRecord,
): SafeCodingLedgerRecoveryDecision {
  const record = validateSafeCodingLedgerRecord(value);
  const state = record.ticketState.status;
  if (state === 'PREPARED') {
    return decision(record, {
      action: 'CLOSE_FAILED_PRE_EFFECT',
      targetState: 'FAILED_PRE_EFFECT',
      reasonCode: 'recovery-before-commit-permit',
      effectMayHaveOccurred: false,
      reconciliationRequired: false,
    });
  }
  if (state === 'COMMIT_PERMIT') {
    return decision(record, {
      action: 'CLOSE_UNCERTAIN',
      targetState: 'UNCERTAIN',
      reasonCode: 'recovery-after-commit-permit',
      effectMayHaveOccurred: true,
      reconciliationRequired: true,
    });
  }
  if (!isSafeCodingLedgerTerminalState(state)) {
    return assertNever(state);
  }
  // Structural restore cannot re-establish the external checkpoint/trust proof
  // behind an ADMITTED receipt. Recovery therefore never treats a persisted
  // acknowledgement as authoritative on its own; it performs evidence-only
  // reconciliation and never replays the effect.
  return decision(record, {
    action: 'DELIVER_EVIDENCE_ONLY',
    targetState: state,
    reasonCode:
      record.evidenceAdmission.status === 'PENDING'
        ? 'terminal-evidence-admission-pending'
        : 'terminal-evidence-reverification-required',
    effectMayHaveOccurred: state !== 'FAILED_PRE_EFFECT',
    reconciliationRequired: true,
  });
}

function decision(
  record: SafeCodingLedgerRecord,
  value: Omit<
    SafeCodingLedgerRecoveryDecision,
    'transactionId' | 'revision' | 'observedState' | 'effectReplayAllowed'
  >,
): SafeCodingLedgerRecoveryDecision {
  return Object.freeze({
    transactionId: record.transactionId,
    revision: record.revision,
    observedState: record.ticketState.status,
    ...value,
    effectReplayAllowed: false,
  });
}

function assertNever(value: never): never {
  throw new Error(`Unknown ledger state: ${String(value)}`);
}
