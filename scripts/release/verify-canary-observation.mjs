import {
  validateCanaryObservationBindings,
  validateCanaryObservationReceipt,
} from './canary-observation-receipt.mjs';

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertExpectedBindings(expected) {
  if (!isObject(expected)) fail('expected canary bindings are required');
  validateCanaryObservationBindings(expected);
}

function assertExactBinding(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`canary observation ${label} does not match the expected binding`);
  }
}

/**
 * Verifies the receipt's internal derivations and exact trusted inputs. This
 * Phase A verifier intentionally does not verify a GitHub attestation and does
 * not replace the stable promotion NOT_READY guard.
 */
export function verifyCanaryObservationReceipt(
  value,
  { expected, now = new Date() } = {},
) {
  assertExpectedBindings(expected);
  const validated = validateCanaryObservationReceipt(value, { now });
  const actual = {
    evidence: validated.receipt.evidence,
    manifest: validated.receipt.manifest,
    producer: validated.receipt.producer,
    publication: validated.receipt.publication,
    release: validated.receipt.release,
    source: validated.receipt.source,
  };
  for (const label of [
    'source',
    'manifest',
    'release',
    'publication',
    'producer',
    'evidence',
  ]) {
    assertExactBinding(actual[label], expected[label], label);
  }
  return validated;
}
