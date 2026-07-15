import type {
  CanaryObservationCounters,
  CanaryObservationStopReason,
} from './canary-observation-policy.mjs';

export const CANARY_OBSERVATION_SCHEMA_VERSION: 1;
export const CANARY_OBSERVATION_RECEIPT_KIND: 'release-canary-observation';
export const CANARY_DISTRIBUTION_SUMMARY_KIND: 'content-free-canary-distribution-summary-v1';
export const CANARY_HEALTH_SUMMARY_KIND: 'content-free-canary-health-summary-v1';
export const CANARY_OBSERVATION_MAX_AGE_MS: number;
export const CANARY_OBSERVATION_CLOSURE_GRACE_MS: number;

export interface CanaryObservationSourceBinding {
  commit: string;
  ref: 'refs/heads/main';
  repository: 'mereyabdenbekuly-ctrl/clodex-ide';
}

export interface CanaryObservationManifestBinding {
  path: string;
  sha256: string;
  sourceCommit: string;
}

export interface CanaryObservationReleaseBinding {
  channel: 'preview';
  promotionRole: 'canary';
  sourceCommit: string;
  tag: string;
  version: string;
}

export interface CanaryObservationPublicationBinding {
  createdAt: string;
  releaseId: number;
  reportAssetId: number;
  reportFileName: 'clodex-release-publication.json';
  reportSha256: string;
  repository: 'mereyabdenbekuly-ctrl/clodex-ide';
  sourceCommit: string;
  state: 'draft';
  tag: string;
}

export interface CanaryObservationEvidenceBindings {
  distribution: {
    artifactKind: typeof CANARY_DISTRIBUTION_SUMMARY_KIND;
    sha256: string;
  };
  telemetry: {
    artifactKind: typeof CANARY_HEALTH_SUMMARY_KIND;
    sha256: string;
  };
}

export interface CanaryObservationProducerBinding {
  repository: 'mereyabdenbekuly-ctrl/clodex-ide';
  runAttempt: number;
  runId: number;
  sourceCommit: string;
  sourceRef: 'refs/heads/main';
  workflow: string;
  workflowCommit: string;
}

export interface CanaryObservationInput {
  evidence: CanaryObservationEvidenceBindings;
  generatedAt: string;
  manifest: CanaryObservationManifestBinding;
  observation: {
    counters: CanaryObservationCounters;
    distributionClosedAt: string;
    endedAt: string;
    startedAt: string;
  };
  producer: CanaryObservationProducerBinding;
  publication: CanaryObservationPublicationBinding;
  release: CanaryObservationReleaseBinding;
  source: CanaryObservationSourceBinding;
}

export interface CanaryObservationReceipt
  extends Omit<CanaryObservationInput, 'observation'> {
  observation: CanaryObservationInput['observation'] & {
    observedHours: number;
    stopReasons: CanaryObservationStopReason[];
  };
  policy: {
    id: 'clodex.release.canary-5-observation.v1';
    sha256: string;
  };
  receiptKind: typeof CANARY_OBSERVATION_RECEIPT_KIND;
  schemaVersion: typeof CANARY_OBSERVATION_SCHEMA_VERSION;
}

export interface CanaryObservationBindings {
  evidence: CanaryObservationEvidenceBindings;
  manifest: CanaryObservationManifestBinding;
  producer: CanaryObservationProducerBinding;
  publication: CanaryObservationPublicationBinding;
  release: CanaryObservationReleaseBinding;
  source: CanaryObservationSourceBinding;
}

export interface ValidatedCanaryObservationReceipt {
  observedHours: number;
  policySatisfied: boolean;
  receipt: CanaryObservationReceipt;
  stopReasons: CanaryObservationStopReason[];
}

export function validateCanaryObservationReceipt(
  value: unknown,
  options?: { now?: Date },
): ValidatedCanaryObservationReceipt;

export function createCanaryObservationReceipt(
  input: CanaryObservationInput,
  options?: { now?: Date },
): CanaryObservationReceipt;

export function validateCanaryObservationBindings(
  value: unknown,
): CanaryObservationBindings;

export function canaryObservationBindings(
  receipt: CanaryObservationReceipt,
  options?: { now?: Date },
): CanaryObservationBindings;
