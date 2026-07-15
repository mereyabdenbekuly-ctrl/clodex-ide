import type {
  CanaryArtifactSubject,
  CanaryDistributionSummary,
  CanaryHealthSummary,
  Sha256,
} from './canary-observation-summaries.mjs';
import type {
  CanaryObservationProducerBinding,
  CanaryObservationReceipt,
} from './canary-observation-receipt.mjs';

export interface CanaryObservationReceiptSubject {
  artifactKind: 'release-canary-observation';
  sha256: Sha256;
  value: CanaryObservationReceipt;
}

export interface CanaryObservationEvidenceBundle {
  distribution: CanaryArtifactSubject<CanaryDistributionSummary>;
  health: CanaryArtifactSubject<CanaryHealthSummary>;
  receipt: CanaryObservationReceiptSubject;
}

export interface CanaryObservationAssemblerInput {
  distributionBytes: Uint8Array;
  healthBytes: Uint8Array;
  producer: CanaryObservationProducerBinding;
}

export function assembleCanaryObservationReceipt(
  input: CanaryObservationAssemblerInput,
  options?: { now?: Date },
): CanaryObservationReceipt;
export function createCanaryObservationReceiptSubject(
  value: CanaryObservationReceipt,
  options?: { now?: Date },
): CanaryObservationReceiptSubject;
export function validateCanaryObservationReceiptSubject(
  subject: CanaryObservationReceiptSubject,
  options?: { now?: Date },
): CanaryObservationReceiptSubject;
export function assembleCanaryObservationEvidenceBundle(
  input: CanaryObservationAssemblerInput,
  options?: { now?: Date },
): CanaryObservationEvidenceBundle;
export function validateCanaryObservationEvidenceBundle(
  value: CanaryObservationEvidenceBundle,
  options?: { now?: Date },
): {
  bindings: Record<string, unknown>;
  bundle: CanaryObservationEvidenceBundle;
  policy: {
    observedHours: number;
    policySatisfied: boolean;
    stopReasons: string[];
  };
};
