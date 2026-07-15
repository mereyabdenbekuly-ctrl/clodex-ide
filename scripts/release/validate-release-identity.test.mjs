import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { validateReleaseIdentity } from './validate-release-identity.mjs';

const repositoryRoot = new URL('../../', import.meta.url);
const validatorPath = fileURLToPath(
  new URL('validate-release-identity.mjs', import.meta.url),
);

const VALID_IDENTITIES = [
  {
    channel: 'release',
    tag: 'clodex@1.16.0',
    version: '1.16.0',
  },
  {
    channel: 'preview',
    tag: 'v1.16.0-preview.2',
    version: '1.16.0-preview.2',
  },
  {
    channel: 'alpha',
    tag: 'clodex@1.16.1-alpha001',
    version: '1.16.1-alpha001',
  },
  {
    channel: 'beta',
    tag: 'clodex@1.16.1-beta999',
    version: '1.16.1-beta999',
  },
  {
    channel: 'nightly',
    tag: 'clodex@1.16.1-nightly20260715c001',
    version: '1.16.1-nightly20260715c001',
  },
];

test('accepts only canonical channel-specific Clodex identities', () => {
  for (const identity of VALID_IDENTITIES) {
    assert.deepEqual(validateReleaseIdentity(identity), {
      ...identity,
      product: 'clodex',
    });
  }

  assert.deepEqual(
    validateReleaseIdentity({
      channel: 'release',
      product: 'karton',
      tag: '@clodex/karton@2.3.4',
      version: '2.3.4',
    }),
    {
      channel: 'release',
      product: 'karton',
      tag: '@clodex/karton@2.3.4',
      version: '2.3.4',
    },
  );
});

test('rejects noncanonical versions, channel mismatches, and tag mismatches', () => {
  const invalid = [
    ['release', '01.16.0', 'clodex@01.16.0'],
    ['release', '1.16.0-preview.2', 'clodex@1.16.0-preview.2'],
    ['preview', '1.16.0-preview.0', 'v1.16.0-preview.0'],
    ['preview', '1.16.0-preview.2', 'clodex@1.16.0-preview.2'],
    ['alpha', '1.16.1-alpha.1', 'clodex@1.16.1-alpha.1'],
    ['alpha', '1.16.1-alpha000', 'clodex@1.16.1-alpha000'],
    ['beta', '1.16.1-beta1000', 'clodex@1.16.1-beta1000'],
    [
      'nightly',
      '1.16.1-nightly20260230c001',
      'clodex@1.16.1-nightly20260230c001',
    ],
    [
      'nightly',
      '1.16.1-nightly20260715c000',
      'clodex@1.16.1-nightly20260715c000',
    ],
  ];
  for (const [channel, version, tag] of invalid) {
    assert.throws(() => validateReleaseIdentity({ channel, tag, version }));
  }
});

test('shell metacharacters remain inert and fail closed', () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'clodex-release-identity-'),
  );
  const marker = path.join(directory, 'injected');
  const payloads = [
    `1.16.0; touch "${marker}"`,
    `1.16.0$(touch "${marker}")`,
    `1.16.0\`touch "${marker}"\``,
    `1.16.0\ntouch "${marker}"`,
    '1.16.0&whoami',
    '1.16.0"; Write-Output injected; "',
  ];

  for (const payload of payloads) {
    assert.throws(() =>
      execFileSync(
        'bash',
        [
          '-c',
          'node "$VALIDATOR" --channel="$CHANNEL" --version="$VERSION" --tag="$TAG"',
        ],
        {
          env: {
            ...process.env,
            CHANNEL: 'release',
            TAG: `clodex@${payload}`,
            VALIDATOR: validatorPath,
            VERSION: payload,
          },
          stdio: 'pipe',
        },
      ),
    );
    assert.equal(existsSync(marker), false);
  }
});

test('CLI invocation through a symlink still validates and fails closed', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'clodex-release-identity-symlink-'),
  );
  const symlinkPath = path.join(directory, 'validate-release-identity.mjs');
  try {
    symlinkSync(validatorPath, symlinkPath);
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          symlinkPath,
          '--channel=release',
          '--version=INVALID',
          '--tag=clodex@INVALID',
        ],
        { stdio: 'pipe' },
      ),
    );
    assert.doesNotThrow(() =>
      execFileSync(
        process.execPath,
        [
          symlinkPath,
          '--channel=release',
          '--version=1.16.0',
          '--tag=clodex@1.16.0',
        ],
        { stdio: 'pipe' },
      ),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

function workflowRuns(value, pathParts = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      workflowRuns(entry, [...pathParts, String(index)]),
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => {
      if (key === 'run' && typeof entry === 'string') {
        return [{ path: [...pathParts, key].join('.'), run: entry }];
      }
      return workflowRuns(entry, [...pathParts, key]);
    });
  }
  return [];
}

test('release shell and PowerShell blocks never interpolate GitHub expressions directly', () => {
  const workflows = [
    '_release-browser.yml',
    '_release-karton.yml',
    'auto-release.yml',
    'nightly-release.yml',
    'prepare-release.yml',
    'release-acceptance-evidence.yml',
    'release-publication-attestation.yml',
    'release-signing-readiness.yml',
    'technical-preview-release.yml',
  ];

  const violations = [];
  for (const workflow of workflows) {
    const source = readFileSync(
      new URL(`.github/workflows/${workflow}`, repositoryRoot),
      'utf8',
    );
    const parsed = YAML.parse(source);
    for (const block of workflowRuns(parsed)) {
      if (block.run.includes('${{')) {
        violations.push(`${workflow}:${block.path}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('browser privilege boundary depends on the unprivileged identity gate', () => {
  const source = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  const workflow = YAML.parse(source);
  const sourceGate = source
    .split('\n  source-gate:')[1]
    .split('\n  promotion-gate:')[0];

  assert.match(sourceGate, /validate-release-identity\.mjs/);
  assert.doesNotMatch(
    sourceGate,
    /environment:\s*Release|contents:\s*write|id-token:\s*write|secrets\./,
  );
  assert.equal(workflow.jobs['promotion-gate'].needs, 'source-gate');
  assert.deepEqual(workflow.jobs.build.needs, ['source-gate', 'tag']);
  assert.deepEqual(workflow.jobs.release.needs, [
    'source-gate',
    'tag',
    'build',
  ]);
});

test('Karton and release preparation preserve exact-source and credential boundaries', () => {
  const kartonSource = readFileSync(
    new URL('.github/workflows/_release-karton.yml', repositoryRoot),
    'utf8',
  );
  const karton = YAML.parse(kartonSource);
  assert.deepEqual(karton.jobs.publish.needs, ['source-gate', 'tag']);
  assert.equal(karton.jobs.publish.environment, 'Release');
  assert.equal(karton.jobs.publish.permissions.contents, 'read');
  assert.equal(karton.jobs.publish.permissions['id-token'], undefined);
  assert.match(kartonSource, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(kartonSource, /persist-credentials: false/);
  assert.match(kartonSource, /packages\/karton\/package\.json/);
  assert.match(kartonSource, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);

  const prepareSource = readFileSync(
    new URL('.github/workflows/prepare-release.yml', repositoryRoot),
    'utf8',
  );
  const prepare = YAML.parse(prepareSource);
  assert.equal(prepare.jobs.prepare.if, "github.ref == 'refs/heads/main'");
  assert.equal(prepare.jobs.prepare.environment, 'Release');
  assert.equal(prepare.permissions.contents, 'read');
  assert.doesNotMatch(prepareSource, /refs\/heads\/release-tests/);
  assert.doesNotMatch(prepareSource, /token: \$\{\{ secrets\.RELEASE_PAT \}\}/);
  assert.match(prepareSource, /persist-credentials: false/);
  assert.match(prepareSource, /git commit -s /);
  assert.doesNotMatch(prepareSource, /git push --force/);
  assert.match(prepareSource, /refusing to overwrite reviewed work/);
});
