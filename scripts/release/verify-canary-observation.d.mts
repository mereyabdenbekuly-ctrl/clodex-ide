import type {
  CanaryObservationBindings,
  ValidatedCanaryObservationReceipt,
} from './canary-observation-receipt.mjs';

export function verifyCanaryObservationReceipt(
  value: unknown,
  options: {
    expected: CanaryObservationBindings;
    now?: Date;
  },
): ValidatedCanaryObservationReceipt;
