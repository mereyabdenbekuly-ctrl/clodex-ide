import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const upstreamBase = 'ef9d249f29f2a98dfeac80b2f1013315333994d6';

const requiredText = [
  {
    file: 'CLODEX_VS_UPSTREAM.md',
    values: [upstreamBase, 'Stagewise'],
  },
  {
    file: 'THIRD-PARTY-NOTICES.md',
    values: [upstreamBase, 'stagewise-io/stagewise'],
  },
  {
    file: 'CONTRIBUTORS.md',
    values: ['Stagewise upstream contributors'],
  },
  {
    file: 'GOVERNANCE.md',
    values: ['Clodex Labs', 'project label'],
  },
  {
    file: 'packages/karton/LICENSE.md',
    values: [
      'Copyright (c) 2025 stagewise GmbH',
      'Copyright (c) 2026 Merey Abdenbekuly and Clodex contributors',
    ],
  },
];

let failed = false;

for (const check of requiredText) {
  const content = readFileSync(check.file, 'utf8');
  for (const value of check.values) {
    if (!content.includes(value)) {
      console.error(
        `Missing required provenance text in ${check.file}: ${value}`,
      );
      failed = true;
    }
  }
}

const listed = spawnSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

if (listed.status !== 0) {
  throw new Error(listed.stderr || 'git ls-files failed');
}

const forbiddenClaims = [
  /\bclodex(?:\s+labs)?(?:\s+|\s*,\s*)(?:gmbh|inc(?:orporated)?\.?|llc|ltd\.?)(?![\p{L}\p{N}_])/iu,
];
const forbiddenClaimExamples = [
  'Clodex GmbH',
  'Clodex, Inc.',
  'Clodex Incorporated',
  'Clodex Labs, Inc.',
  'Clodex Labs LLC',
];
const allowedClaimExamples = [
  'Clodex Labs is a project label.',
  'Copyright stagewise GmbH.',
];

for (const example of forbiddenClaimExamples) {
  if (!forbiddenClaims.some((pattern) => pattern.test(example))) {
    throw new Error(`Legal-identity guard does not reject: ${example}`);
  }
}
for (const example of allowedClaimExamples) {
  if (forbiddenClaims.some((pattern) => pattern.test(example))) {
    throw new Error(
      `Legal-identity guard rejects an allowed example: ${example}`,
    );
  }
}
const guardFiles = new Set(['scripts/ci/check-provenance.mjs']);
for (const file of listed.stdout.split('\0').filter(Boolean)) {
  // The guard necessarily contains the denied names as matcher literals.
  // Excluding its own source avoids a permanent self-match after it is tracked.
  if (guardFiles.has(file)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const pattern of forbiddenClaims) {
    if (pattern.test(content)) {
      console.error(
        `Unsupported legal-entity claim ${pattern} found in ${file}`,
      );
      failed = true;
    }
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('Provenance and attribution guard passed.');
}
