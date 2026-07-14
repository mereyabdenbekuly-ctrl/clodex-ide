import type {
  SafeCodingExecutionTicket,
  SafeCodingIntentContract,
  VerifiedIntentContract,
} from '@clodex/contracts';

export const SAFE_CODING_KERNEL_STATE_VERSION = 1 as const;

export type KernelContractStatus = 'active' | 'revoked' | 'superseded';

export type KernelTicketStatus =
  | 'registered'
  | 'commit-permit'
  | 'failed-no-effect'
  | 'committed'
  | 'result-unavailable'
  | 'uncertain';

export type KernelTerminalTicketStatus = Exclude<
  KernelTicketStatus,
  'registered' | 'commit-permit'
>;

export interface KernelActiveContractSnapshot {
  readonly contractId: string;
  readonly contractHash: string;
  readonly revision: number;
  readonly revocationEpoch: number;
  readonly status: KernelContractStatus;
}

export interface KernelContractCasExpectation {
  readonly contractHash: string;
  readonly revision: number;
  readonly revocationEpoch: number;
}

export interface ActivateKernelContractInput {
  readonly verifiedContract: VerifiedIntentContract;
  /** Null only for revision 1. Later revisions require exact active-state CAS. */
  readonly expectedPrevious: KernelContractCasExpectation | null;
  readonly now: string;
}

export interface RevokeKernelContractInput {
  readonly contractId: string;
  readonly expectedActive: KernelContractCasExpectation;
  readonly now: string;
  readonly reason?: string;
}

export interface KernelBudgetCharge {
  readonly uniqueModifiedFiles: number;
  readonly mutationBytes: number;
  readonly testRuns: number;
}

/**
 * This is intentionally structurally identical to the Guardian state-port
 * registration input. The kernel does not import or depend on Guardian.
 */
export interface KernelTicketRegistration {
  readonly ticket: SafeCodingExecutionTicket;
  readonly expectedActive: KernelActiveContractSnapshot;
  readonly limits: SafeCodingIntentContract['authority']['limits'];
  readonly charge: KernelBudgetCharge;
}

export interface RegisterKernelTicketInput extends KernelTicketRegistration {
  readonly now: string;
}

export interface CommitPermitInput {
  readonly ticket: SafeCodingExecutionTicket;
  readonly now: string;
}

export interface FailBeforeCommitInput {
  readonly ticketId: string;
  readonly now: string;
  readonly reason: string;
}

export interface SettleKernelTicketInput {
  readonly ticketId: string;
  readonly status: KernelTerminalTicketStatus;
  readonly now: string;
  readonly resultHash?: string | null;
  readonly reason?: string | null;
}

export interface KernelCommitPermit {
  readonly ticketId: string;
  readonly requestId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly revocationEpoch: number;
  readonly budgetReservationId: string;
  readonly permittedAt: string;
}

export interface KernelContractRevisionRecord {
  readonly contract: SafeCodingIntentContract;
  readonly contractHash: string;
  readonly revision: number;
  readonly previousRevisionHash: string | null;
  readonly status: KernelContractStatus;
  readonly revocationEpoch: number;
  readonly activatedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
}

export interface KernelBudgetUsage {
  readonly modifiedObjectIds: readonly string[];
  readonly mutationBytes: number;
  readonly testRuns: number;
}

export interface KernelContractLineage {
  readonly contractId: string;
  readonly currentContractHash: string;
  readonly revocationEpoch: number;
  readonly revisions: readonly KernelContractRevisionRecord[];
  /** Reservations are conservative and are not refunded after terminal state. */
  readonly budget: KernelBudgetUsage;
}

export interface KernelTicketRecord {
  readonly ticket: SafeCodingExecutionTicket;
  readonly contractId: string;
  readonly status: KernelTicketStatus;
  readonly registeredAt: string;
  readonly commitPermittedAt: string | null;
  readonly terminalAt: string | null;
  readonly terminalReason: string | null;
  readonly resultHash: string | null;
  /** Increment reserved by this ticket after resolved-object deduplication. */
  readonly reservedCharge: KernelBudgetCharge;
  /** Lineage-wide totals immediately after this ticket was registered. */
  readonly aggregateCharge: KernelBudgetCharge;
}

/**
 * Plain-data state only: no Map, Set, Date, function, promise, or platform
 * handle. A later durable adapter can serialize this state and apply the same
 * exported pure transitions under its own transaction/CAS boundary.
 */
export interface SafeCodingKernelState {
  readonly version: typeof SAFE_CODING_KERNEL_STATE_VERSION;
  readonly lineages: Readonly<Record<string, KernelContractLineage>>;
  readonly tickets: Readonly<Record<string, KernelTicketRecord>>;
  readonly requestIds: Readonly<Record<string, string>>;
  readonly reservationIds: Readonly<Record<string, string>>;
}

export function createEmptySafeCodingKernelState(): SafeCodingKernelState {
  return {
    version: SAFE_CODING_KERNEL_STATE_VERSION,
    lineages: {},
    tickets: {},
    requestIds: {},
    reservationIds: {},
  };
}

export type SafeCodingKernelErrorCode =
  | 'budget-exhausted'
  | 'contract-already-exists'
  | 'contract-cas-mismatch'
  | 'contract-invalid'
  | 'contract-not-active'
  | 'contract-not-found'
  | 'contract-revoked'
  | 'request-replay'
  | 'reservation-replay'
  | 'ticket-expired'
  | 'ticket-invalid'
  | 'ticket-not-executable'
  | 'ticket-not-found'
  | 'ticket-replay'
  | 'ticket-stale'
  | 'ticket-terminal';

export class SafeCodingKernelError extends Error {
  public constructor(
    public readonly code: SafeCodingKernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeCodingKernelError';
  }
}

export function isKernelTerminalTicketStatus(
  status: KernelTicketStatus,
): status is KernelTerminalTicketStatus {
  return (
    status === 'failed-no-effect' ||
    status === 'committed' ||
    status === 'result-unavailable' ||
    status === 'uncertain'
  );
}
