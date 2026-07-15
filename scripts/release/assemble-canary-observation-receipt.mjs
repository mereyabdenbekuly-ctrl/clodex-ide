import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CANARY_DISTRIBUTION_SUMMARY_KIND,
  CANARY_HEALTH_SUMMARY_KIND,
  CANARY_OBSERVATION_RECEIPT_KIND,
  canaryObservationBindings,
  createCanaryObservationReceipt,
  validateCanaryObservationReceipt,
  validateCanaryReceiptProducer,
} from './canary-observation-receipt.mjs';
import {
  canonicalCanaryArtifactBytes,
  canonicalCanaryJson,
  createCanaryArtifactSubject,
  parseCanonicalCanarySummaryBytes,
  validateCanaryArtifactSubject,
} from './canary-observation-summaries.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactBinding(left, right, label) {
  assert(
    canonicalCanaryJson(left) === canonicalCanaryJson(right),
    `canary summary ${label} bindings differ`,
  );
}

function laterCanonicalInstant(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function assemble({ distributionBytes, healthBytes, producer }, { now }) {
  validateCanaryReceiptProducer(producer);
  const distribution = parseCanonicalCanarySummaryBytes(distributionBytes, {
    kind: CANARY_DISTRIBUTION_SUMMARY_KIND,
    now,
  });
  const health = parseCanonicalCanarySummaryBytes(healthBytes, {
    kind: CANARY_HEALTH_SUMMARY_KIND,
    now,
  });
  for (const label of ['source', 'manifest', 'release', 'publication']) {
    assertExactBinding(distribution.value[label], health.value[label], label);
  }
  assert(
    distribution.value.observation.startedAt ===
      health.value.observation.startedAt &&
      distribution.value.observation.endedAt ===
        health.value.observation.endedAt,
    'canary summary observation windows differ',
  );

  const counters = {
    ...distribution.value.observation.counters,
    ...health.value.observation.counters,
  };
  const receipt = createCanaryObservationReceipt(
    {
      evidence: {
        distribution: {
          artifactKind: distribution.value.artifactKind,
          sha256: distribution.sha256,
        },
        telemetry: {
          artifactKind: health.value.artifactKind,
          sha256: health.sha256,
        },
      },
      generatedAt: laterCanonicalInstant(
        distribution.value.generatedAt,
        health.value.generatedAt,
      ),
      manifest: { ...distribution.value.manifest },
      observation: {
        counters,
        distributionClosedAt:
          distribution.value.observation.distributionClosedAt,
        endedAt: distribution.value.observation.endedAt,
        startedAt: distribution.value.observation.startedAt,
      },
      producer: { ...producer },
      publication: { ...distribution.value.publication },
      release: { ...distribution.value.release },
      source: { ...distribution.value.source },
    },
    { now },
  );
  return { distribution, health, receipt };
}

export function assembleCanaryObservationReceipt(
  input,
  { now = new Date() } = {},
) {
  return assemble(input, { now }).receipt;
}

export function createCanaryObservationReceiptSubject(
  value,
  { now = new Date() } = {},
) {
  validateCanaryObservationReceipt(value, { now });
  const bytes = canonicalCanaryArtifactBytes(value);
  return {
    artifactKind: CANARY_OBSERVATION_RECEIPT_KIND,
    sha256: sha256Bytes(bytes),
    value: JSON.parse(bytes.toString('utf8')),
  };
}

export function validateCanaryObservationReceiptSubject(
  subject,
  { now = new Date() } = {},
) {
  const keys = Object.keys(subject ?? {}).sort();
  assert(
    JSON.stringify(keys) ===
      JSON.stringify(['artifactKind', 'sha256', 'value']),
    'canary observation receipt subject contains missing or unsupported fields',
  );
  assert(
    subject.artifactKind === CANARY_OBSERVATION_RECEIPT_KIND &&
      subject.value?.receiptKind === CANARY_OBSERVATION_RECEIPT_KIND &&
      SHA256.test(String(subject.sha256 ?? '')),
    'canary observation receipt subject identity is invalid',
  );
  validateCanaryObservationReceipt(subject.value, { now });
  assert(
    sha256Bytes(canonicalCanaryArtifactBytes(subject.value)) === subject.sha256,
    'canary observation receipt subject digest is invalid',
  );
  return subject;
}

export function assembleCanaryObservationEvidenceBundle(
  input,
  { now = new Date() } = {},
) {
  const assembled = assemble(input, { now });
  return {
    distribution: createCanaryArtifactSubject(assembled.distribution.value, {
      now,
    }),
    health: createCanaryArtifactSubject(assembled.health.value, { now }),
    receipt: createCanaryObservationReceiptSubject(assembled.receipt, { now }),
  };
}

export function validateCanaryObservationEvidenceBundle(
  value,
  { now = new Date() } = {},
) {
  const keys = Object.keys(value ?? {}).sort();
  assert(
    JSON.stringify(keys) ===
      JSON.stringify(['distribution', 'health', 'receipt']),
    'canary observation evidence bundle contains missing or unsupported fields',
  );
  const distribution = validateCanaryArtifactSubject(value.distribution, {
    kind: CANARY_DISTRIBUTION_SUMMARY_KIND,
    now,
  });
  const health = validateCanaryArtifactSubject(value.health, {
    kind: CANARY_HEALTH_SUMMARY_KIND,
    now,
  });
  const receipt = validateCanaryObservationReceiptSubject(value.receipt, {
    now,
  });
  const reconstructed = assembleCanaryObservationReceipt(
    {
      distributionBytes: canonicalCanaryArtifactBytes(distribution.value),
      healthBytes: canonicalCanaryArtifactBytes(health.value),
      producer: receipt.value.producer,
    },
    { now },
  );
  assert(
    canonicalCanaryJson(reconstructed) === canonicalCanaryJson(receipt.value),
    'canary observation receipt was not assembled from the exact summary subjects',
  );
  const bindings = canaryObservationBindings(receipt.value, { now });
  assert(
    bindings.evidence.distribution.sha256 === distribution.sha256 &&
      bindings.evidence.telemetry.sha256 === health.sha256,
    'canary observation receipt does not bind the exact summary subjects',
  );
  return {
    bindings,
    bundle: value,
    policy: validateCanaryObservationReceipt(receipt.value, { now }),
  };
}

function parseArguments(values) {
  const allowed = new Set([
    'bundle-output',
    'distribution',
    'health',
    'output',
    'producer',
  ]);
  const options = {};
  for (const value of values) {
    if (!value.startsWith('--') || !value.includes('=')) {
      fail(`Invalid argument: ${value}`);
    }
    const [name, ...parts] = value.slice(2).split('=');
    if (!allowed.has(name)) fail(`Unknown argument: ${value}`);
    if (Object.hasOwn(options, name)) fail(`Duplicate argument: --${name}`);
    options[name] = parts.join('=');
  }
  return options;
}

async function readRegularFile(filePath, label) {
  const resolved = path.resolve(filePath ?? '');
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) fail(`${label} path must be a regular file`);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} path`)) {
      throw error;
    }
    fail(`${label} path must be a readable regular file`);
  } finally {
    await handle?.close();
  }
}

async function assertWritablePath(filePath, label) {
  const resolved = path.resolve(filePath ?? '');
  const stats = await lstat(resolved).catch(() => null);
  if (stats?.isSymbolicLink() || stats?.isDirectory()) {
    fail(`${label} path must not be a symlink or directory`);
  }
  return resolved;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const required of ['distribution', 'health', 'output', 'producer']) {
    if (!options[required]) fail(`--${required} is required`);
  }
  const distributionBytes = await readRegularFile(
    options.distribution,
    'distribution summary',
  );
  const healthBytes = await readRegularFile(options.health, 'health summary');
  const producerBytes = await readRegularFile(options.producer, 'producer');
  let producer;
  try {
    producer = JSON.parse(producerBytes.toString('utf8'));
  } catch {
    fail('producer file is not valid JSON');
  }
  const bundle = assembleCanaryObservationEvidenceBundle(
    { distributionBytes, healthBytes, producer },
    { now: new Date() },
  );
  const outputPath = await assertWritablePath(options.output, 'receipt output');
  await writeFile(
    outputPath,
    canonicalCanaryArtifactBytes(bundle.receipt.value),
    {
      flag: 'wx',
    },
  );
  if (options['bundle-output']) {
    const bundleOutputPath = await assertWritablePath(
      options['bundle-output'],
      'bundle output',
    );
    await writeFile(bundleOutputPath, canonicalCanaryArtifactBytes(bundle), {
      flag: 'wx',
    });
  }
  console.log(
    JSON.stringify({
      distributionSha256: bundle.distribution.sha256,
      healthSha256: bundle.health.sha256,
      receiptSha256: bundle.receipt.sha256,
    }),
  );
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      `[canary-observation-assembler] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
