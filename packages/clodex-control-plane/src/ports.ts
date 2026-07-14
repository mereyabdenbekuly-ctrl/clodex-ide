import type {
  ControlPlaneEvidenceAdmissionReceipt,
  ControlPlaneTerminalEvidence,
  TrustedCommitPermitAdmission,
} from './model.js';

export interface TrustedSynchronousClock {
  /** Must return a canonical UTC timestamp and must never return a Promise. */
  now(): string;
}

export interface CommitPermitBinding {
  readonly transactionId: string;
  readonly ticketId: string;
  readonly ticketCommitment: string;
  readonly authorityScopeHash: string;
  readonly operationCommitment: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly targetObjectId: string;
}

/**
 * External authority-admission TCB. Implementations verify signatures,
 * issuer/registry membership, revocation, policy, and scope. The coordinator
 * only consumes the resulting closed admission; it never issues authority.
 */
export interface CommitPermitAuthorityPort {
  verifySynchronously(
    permitEnvelope: unknown,
    binding: CommitPermitBinding,
  ): unknown;
  /** Final synchronous fence executed inside the storage mutation lock. */
  assertTrustedSynchronously(
    permit: TrustedCommitPermitAdmission,
    binding: CommitPermitBinding,
  ): void;
}

export interface ControlPlaneEffectExecutionRequest {
  readonly transactionId: string;
  readonly ticketId: string;
  readonly ticketCommitment: string;
  readonly permit: TrustedCommitPermitAdmission;
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly operationCommitment: string;
  readonly targetObjectId: string;
  readonly preStateHash: string | null;
  readonly idempotencyKey: string | null;
}

export interface CommittedEffectObservation {
  readonly outcome: 'COMMITTED';
  readonly resultHash: string;
  readonly postStateHash: string;
  readonly observationRef: string;
  readonly reasonCode: string;
}

export interface CommittedResultUnavailableObservation {
  readonly outcome: 'RESULT_UNAVAILABLE';
  readonly postStateHash: string;
  readonly observationRef: string;
  readonly reasonCode: string;
}

export interface NoEffectObservation {
  readonly outcome: 'NO_EFFECT';
  readonly reasonCode: string;
}

export interface UncertainEffectObservation {
  readonly outcome: 'UNCERTAIN';
  readonly reasonCode: string;
}

export type ControlPlaneEffectObservation =
  | CommittedEffectObservation
  | CommittedResultUnavailableObservation
  | NoEffectObservation
  | UncertainEffectObservation;

/**
 * Execution TCB. The method must represent one attempt only. It must not
 * internally retry an ambiguous effect. A thrown error is classified as
 * UNCERTAIN by the coordinator.
 */
export interface ControlPlaneEffectPort {
  executeOnce(request: ControlPlaneEffectExecutionRequest): Promise<unknown>;
}

export interface EvidenceReceiptBinding {
  readonly transactionId: string;
  readonly evidenceIntentId: string;
  readonly attestationId: string;
  /** Exact terminal payload the admitted signed envelope must contain. */
  readonly terminalEvidence: ControlPlaneTerminalEvidence;
}

/** External signed-evidence admission TCB; it does not execute effects. */
export interface EvidenceAdmissionReceiptPort {
  verifySynchronously(
    receiptEnvelope: unknown,
    binding: EvidenceReceiptBinding,
  ): unknown;
  /** Final synchronous fence executed inside the storage mutation lock. */
  assertTrustedSynchronously(
    receipt: ControlPlaneEvidenceAdmissionReceipt,
    binding: EvidenceReceiptBinding,
  ): void;
}

export type ControlPlaneFaultPoint =
  | 'after-prepare-durable'
  | 'after-commit-permit-durable'
  | 'after-effect-in-flight-durable'
  | 'after-effect-observation-before-terminal-durable'
  | 'after-terminal-durable'
  | 'after-evidence-delivered-durable'
  | 'after-recovery-terminal-durable';

export interface ControlPlaneFaultInjector {
  inject(point: ControlPlaneFaultPoint): void | Promise<void>;
}
