import type {
  CanaryObservationBindings,
  ValidatedCanaryObservationReceipt,
} from './canary-observation-receipt.mjs';
import type { CanaryObservationEvidenceBundle } from './assemble-canary-observation-receipt.mjs';
import type {
  CanarySummaryProducer,
  VerifiedCanaryAttestation,
} from './canary-observation-summaries.mjs';

export function verifyCanaryObservationReceipt(
  value: unknown,
  options: {
    expected: CanaryObservationBindings;
    now?: Date;
  },
): ValidatedCanaryObservationReceipt;

export function verifyCanaryObservationEvidenceBundle(
  value: CanaryObservationEvidenceBundle,
  options: {
    expected: CanaryObservationBindings;
    expectedProducers: {
      distribution: CanarySummaryProducer;
      health: CanarySummaryProducer;
      receipt: import('./canary-observation-receipt.mjs').CanaryObservationProducerBinding;
    };
    now?: Date;
    verifiedAttestations: {
      distribution: VerifiedCanaryAttestation;
      health: VerifiedCanaryAttestation;
      receipt: VerifiedCanaryAttestation;
    };
  },
): {
  bindings: CanaryObservationBindings;
  bundle: CanaryObservationEvidenceBundle;
  policy: ValidatedCanaryObservationReceipt;
  receipt: ValidatedCanaryObservationReceipt;
};
