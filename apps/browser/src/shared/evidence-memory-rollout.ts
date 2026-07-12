import { sha256 } from '@noble/hashes/sha2.js';
import type { AppReleaseChannel } from './feature-gates';

export type EvidenceMemoryRolloutStage =
  | 'shadow'
  | 'canary-5'
  | 'canary-25'
  | 'canary-100'
  | 'hold';

export interface EvidenceMemoryRolloutPolicy {
  stage: EvidenceMemoryRolloutStage;
  allocationPercent: 0 | 5 | 25 | 100;
  minimumRollbackObservations: number;
  minimumRecall: number;
  maximumStaleLeakageRate: number;
  maximumLatencyP95Ms: number;
  maximumMissingProvenanceAdmissions: number;
  maximumUnresolvedContradictionInjections: number;
}

export interface EvidenceMemoryCanaryHealthObservation {
  sampleCount: number;
  guardedMemoryRecall: number;
  guardedMemoryStaleLeakageRate: number;
  guardedMemoryLatencyP95Ms: number;
  missingProvenanceAdmissionCount: number;
  unresolvedContradictionInjectionCount: number;
}

export type EvidenceMemoryRollbackReason =
  | 'recall-regression'
  | 'stale-memory-regression'
  | 'latency-regression'
  | 'missing-provenance-admission'
  | 'unresolved-contradiction-injection'
  | 'health-restore-failed'
  | 'emergency-kill-switch';

export interface EvidenceMemoryCanarySnapshot {
  stage: EvidenceMemoryRolloutStage;
  allocationPercent: number;
  rolledBack: boolean;
  rollbackReasons: EvidenceMemoryRollbackReason[];
  lastObservationCount: number;
}

export const EVIDENCE_MEMORY_ROLLOUT_POLICY = {
  dev: {
    stage: 'canary-100',
    allocationPercent: 100,
    minimumRollbackObservations: 20,
    minimumRecall: 0.95,
    maximumStaleLeakageRate: 0.01,
    maximumLatencyP95Ms: 250,
    maximumMissingProvenanceAdmissions: 0,
    maximumUnresolvedContradictionInjections: 0,
  },
  prerelease: {
    stage: 'shadow',
    allocationPercent: 0,
    minimumRollbackObservations: 20,
    minimumRecall: 0.95,
    maximumStaleLeakageRate: 0.01,
    maximumLatencyP95Ms: 250,
    maximumMissingProvenanceAdmissions: 0,
    maximumUnresolvedContradictionInjections: 0,
  },
  nightly: {
    stage: 'shadow',
    allocationPercent: 0,
    minimumRollbackObservations: 20,
    minimumRecall: 0.95,
    maximumStaleLeakageRate: 0.01,
    maximumLatencyP95Ms: 250,
    maximumMissingProvenanceAdmissions: 0,
    maximumUnresolvedContradictionInjections: 0,
  },
  release: {
    stage: 'hold',
    allocationPercent: 0,
    minimumRollbackObservations: 20,
    minimumRecall: 0.95,
    maximumStaleLeakageRate: 0.01,
    maximumLatencyP95Ms: 250,
    maximumMissingProvenanceAdmissions: 0,
    maximumUnresolvedContradictionInjections: 0,
  },
} as const satisfies Record<AppReleaseChannel, EvidenceMemoryRolloutPolicy>;

export const EVIDENCE_MEMORY_INJECTION_DISABLE_ENV =
  'CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION';

export function getEvidenceMemoryRolloutPolicy(
  channel: AppReleaseChannel,
): EvidenceMemoryRolloutPolicy {
  return EVIDENCE_MEMORY_ROLLOUT_POLICY[channel];
}

export function isEvidenceMemoryInjectionDisabled(
  value: string | undefined,
): boolean {
  switch (value?.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

export class EvidenceMemoryCanaryController {
  private rolledBack = false;
  private rollbackReasons: EvidenceMemoryRollbackReason[] = [];
  private lastObservationCount = 0;

  public constructor(
    private readonly policy: EvidenceMemoryRolloutPolicy,
    killSwitchActive = false,
  ) {
    if (killSwitchActive) {
      this.rolledBack = true;
      this.rollbackReasons = ['emergency-kill-switch'];
    }
  }

  public isTaskAdmitted(taskId: string): boolean {
    if (this.rolledBack || this.policy.allocationPercent === 0) return false;
    return stableBucket(taskId) < this.policy.allocationPercent;
  }

  public observe(
    observation: EvidenceMemoryCanaryHealthObservation,
  ): EvidenceMemoryCanarySnapshot {
    this.lastObservationCount = Math.max(
      this.lastObservationCount,
      observation.sampleCount,
    );
    if (
      this.rolledBack ||
      observation.sampleCount < this.policy.minimumRollbackObservations
    ) {
      return this.snapshot();
    }

    const reasons: EvidenceMemoryRollbackReason[] = [];
    if (observation.guardedMemoryRecall < this.policy.minimumRecall) {
      reasons.push('recall-regression');
    }
    if (
      observation.guardedMemoryStaleLeakageRate >
      this.policy.maximumStaleLeakageRate
    ) {
      reasons.push('stale-memory-regression');
    }
    if (
      observation.guardedMemoryLatencyP95Ms > this.policy.maximumLatencyP95Ms
    ) {
      reasons.push('latency-regression');
    }
    if (
      observation.missingProvenanceAdmissionCount >
      this.policy.maximumMissingProvenanceAdmissions
    ) {
      reasons.push('missing-provenance-admission');
    }
    if (
      observation.unresolvedContradictionInjectionCount >
      this.policy.maximumUnresolvedContradictionInjections
    ) {
      reasons.push('unresolved-contradiction-injection');
    }
    if (reasons.length > 0) {
      this.rolledBack = true;
      this.rollbackReasons = reasons;
    }
    return this.snapshot();
  }

  public rollback(
    reason: EvidenceMemoryRollbackReason,
  ): EvidenceMemoryCanarySnapshot {
    this.rolledBack = true;
    if (!this.rollbackReasons.includes(reason)) {
      this.rollbackReasons.push(reason);
    }
    return this.snapshot();
  }

  public snapshot(): EvidenceMemoryCanarySnapshot {
    return {
      stage: this.policy.stage,
      allocationPercent: this.policy.allocationPercent,
      rolledBack: this.rolledBack,
      rollbackReasons: [...this.rollbackReasons],
      lastObservationCount: this.lastObservationCount,
    };
  }
}

function stableBucket(taskId: string): number {
  const digest = sha256(
    new TextEncoder().encode(`evidence-memory-canary-v1\0${taskId}`),
  );
  const prefix =
    ((digest[0] ?? 0) * 0x1_00_00_00 +
      (digest[1] ?? 0) * 0x1_00_00 +
      (digest[2] ?? 0) * 0x1_00 +
      (digest[3] ?? 0)) >>>
    0;
  return prefix % 100;
}
