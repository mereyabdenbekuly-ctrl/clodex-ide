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

test('rejects npm-invalid and out-of-range SemVer before release effects', () => {
  for (const version of [
    '1.2.3+build.1',
    '1.2.3-rc.1',
    '9007199254740992.0.0',
    '0.9007199254740992.0',
    '0.0.9007199254740992',
  ]) {
    assert.throws(
      () =>
        validateReleaseIdentity({
          channel: 'release',
          product: 'karton',
          tag: `@clodex/karton@${version}`,
          version,
        }),
      /canonical SemVer|npm SemVer numeric range/,
    );
  }

  assert.throws(
    () =>
      validateReleaseIdentity({
        channel: 'preview',
        tag: 'v1.2.3-preview.9007199254740992',
        version: '1.2.3-preview.9007199254740992',
      }),
    /npm SemVer numeric range/,
  );

  const maximum = '9007199254740991.0.0';
  assert.deepEqual(
    validateReleaseIdentity({
      channel: 'release',
      product: 'karton',
      tag: `@clodex/karton@${maximum}`,
      version: maximum,
    }),
    {
      channel: 'release',
      product: 'karton',
      tag: `@clodex/karton@${maximum}`,
      version: maximum,
    },
  );
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

test('release preparation is an exact-main read-only patch generator', () => {
  const source = readFileSync(
    new URL('.github/workflows/prepare-release.yml', repositoryRoot),
    'utf8',
  );
  const workflow = YAML.parse(source);
  const job = workflow.jobs.prepare;
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  const validation = job.steps.find(
    (step) => step.name === 'Validate exact generated change set',
  );
  const bundle = job.steps.find(
    (step) => step.name === 'Build release preparation artifact',
  );
  const upload = job.steps.find(
    (step) => step.name === 'Upload release preparation artifact',
  );

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.match(checkout.with.ref, /^\$\{\{ github\.sha \}\}$/);
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.match(source, /git ls-remote origin refs\/heads\/main/);
  assert.match(source, /remote_main.*DISPATCH_SHA/s);

  for (const generatedPath of [
    'apps/browser/package.json',
    'apps/browser/CHANGELOG.md',
    'packages/karton/package.json',
    'packages/karton/CHANGELOG.md',
    '.release-version',
    '.release-tag',
    '.release-notes.md',
  ]) {
    assert.ok(
      validation.run.includes(generatedPath),
      `missing generated release path ${generatedPath}`,
    );
  }
  assert.match(validation.run, /changed unexpected path/);
  assert.match(validation.run, /git status --porcelain=v1 -z/);

  assert.match(bundle.run, /git diff --binary --full-index/);
  assert.match(bundle.run, /patchSha256/);
  assert.match(bundle.run, /git commit -s -m/);
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(upload.with['if-no-files-found'], 'error');

  assert.doesNotMatch(
    source,
    /RELEASE_PAT|GH_TOKEN|secrets\.|contents:\s*write|pull-requests:\s*write/,
  );
  assert.doesNotMatch(
    source,
    /git push(?:\s|$)|gh pr create|git add \.|git checkout -b|git commit -m/,
  );
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
  assert.deepEqual(workflow.jobs.build.needs, [
    'source-gate',
    'promotion-gate',
  ]);
  assert.deepEqual(workflow.jobs['tag-authorization'].needs, [
    'source-gate',
    'promotion-gate',
    'build',
  ]);
  assert.deepEqual(workflow.jobs['tag-authorization'].permissions, {
    attestations: 'read',
    contents: 'read',
  });
  assert.equal(workflow.jobs['tag-authorization'].environment, 'Release');
  assert.deepEqual(workflow.jobs.tag.needs, [
    'source-gate',
    'build',
    'tag-authorization',
  ]);
  assert.equal(workflow.jobs.tag.environment, undefined);
  assert.deepEqual(workflow.jobs.tag.permissions, { contents: 'write' });
  const tagEffect = workflow.jobs.tag.steps.find(
    (step) => step.name === 'Create exact lightweight tag through GitHub API',
  );
  assert.ok(tagEffect);
  assert.match(tagEffect.env.GH_TOKEN, /^\$\{\{ github\.token \}\}$/);
  assert.match(
    tagEffect.env.AUTHORIZED_RUN_ATTEMPT,
    /^\$\{\{ needs\.tag-authorization\.outputs\.run_attempt \}\}$/,
  );
  assert.match(
    tagEffect.env.AUTHORIZED_RUN_ID,
    /^\$\{\{ needs\.tag-authorization\.outputs\.run_id \}\}$/,
  );
  assert.doesNotMatch(tagEffect.run, /verify-release-promotion\.mjs/);
  assert.match(
    tagEffect.env.AUTHORIZED_REF,
    /^\$\{\{ needs\.tag-authorization\.outputs\.authorized_ref \}\}$/,
  );
  assert.match(tagEffect.run, /gh api --method POST/);
  assert.deepEqual(workflow.jobs['release-authorization'].needs, [
    'source-gate',
    'tag',
    'build',
  ]);
  assert.deepEqual(workflow.jobs['release-authorization'].permissions, {
    attestations: 'read',
    contents: 'read',
  });
  assert.equal(workflow.jobs['release-authorization'].environment, 'Release');
  assert.deepEqual(workflow.jobs['release-candidate'].needs, [
    'source-gate',
    'tag',
    'build',
    'release-authorization',
  ]);
  assert.equal(workflow.jobs['release-candidate'].environment, undefined);
  assert.deepEqual(workflow.jobs['release-candidate'].permissions, {
    actions: 'read',
    contents: 'read',
  });
  assert.deepEqual(workflow.jobs.release.needs, [
    'source-gate',
    'tag',
    'release-authorization',
    'release-candidate',
  ]);
  assert.deepEqual(workflow.jobs.release.permissions, {
    actions: 'read',
    contents: 'write',
  });
  assert.equal(workflow.jobs.release.environment, undefined);
  const releaseHandoff = workflow.jobs.release.steps.find(
    (step) =>
      step.name ===
      'Verify exact release candidate handoff without repository code',
  );
  const staleAttemptGuard = workflow.jobs.release.steps.find(
    (step) => step.name === 'Reject stale authorization or candidate attempts',
  );
  const releaseWriteAuthorization = workflow.jobs.release.steps.find(
    (step) => step.name === 'Reauthorize exact write target before publication',
  );
  const releaseEffect = workflow.jobs.release.steps.find(
    (step) =>
      step.name === 'Create a new isolated protected draft by exact release ID',
  );
  assert.ok(releaseHandoff);
  assert.ok(staleAttemptGuard);
  assert.match(staleAttemptGuard.run, /GITHUB_RUN_ATTEMPT/);
  assert.match(staleAttemptGuard.run, /GITHUB_RUN_ID/);
  assert.doesNotMatch(releaseHandoff.run, /scripts\/release|apps\/browser/);
  assert.match(releaseHandoff.run, /manifest\.workflowRunAttempt/);
  assert.match(releaseHandoff.run, /manifest\.workflowRunId/);
  assert.ok(releaseWriteAuthorization);
  assert.match(
    releaseWriteAuthorization.env.AUTHORIZED_REF,
    /^\$\{\{ needs\.release-authorization\.outputs\.authorized_ref \}\}$/,
  );
  assert.match(releaseWriteAuthorization.run, /refs\/heads\/main/);
  assert.match(
    releaseWriteAuthorization.run,
    /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/,
  );
  assert.doesNotMatch(
    releaseWriteAuthorization.run,
    /scripts\/release|apps\/browser/,
  );
  assert.ok(releaseEffect);
  assert.match(releaseEffect.env.GH_TOKEN, /^\$\{\{ github\.token \}\}$/);
  assert.doesNotMatch(releaseEffect.run, /verify-release-promotion\.mjs/);
  assert.match(
    releaseEffect.env.RELEASE_ASSETS_DIRECTORY,
    /release-candidate\/release$/,
  );
  assert.match(releaseEffect.run, /create-protected-release-draft\.mjs/);
});

test('Karton tag creation waits for the exact package gate and final CAS recheck', () => {
  const kartonSource = readFileSync(
    new URL('.github/workflows/_release-karton.yml', repositoryRoot),
    'utf8',
  );
  const karton = YAML.parse(kartonSource);

  assert.equal(karton.jobs.package.needs, 'source-gate');
  assert.equal(karton.jobs.package.environment, undefined);
  assert.deepEqual(karton.jobs.package.permissions, { contents: 'read' });
  const packStep = karton.jobs.package.steps.find(
    (step) => step.name === 'Pack and validate exact npm artifact',
  );
  const uploadStep = karton.jobs.package.steps.find(
    (step) => step.name === 'Upload exact packed Karton artifact',
  );
  assert.match(packStep.run, /npm pack --json --ignore-scripts/);
  assert.match(packStep.run, /sha512-/);
  assert.match(packStep.run, /package-identity\.json/);
  assert.match(uploadStep.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(uploadStep.with['if-no-files-found'], 'error');

  assert.deepEqual(karton.jobs.tag.needs, ['source-gate', 'package']);
  assert.equal(karton.jobs.tag.environment, 'Release');
  assert.deepEqual(karton.jobs.tag.permissions, { contents: 'write' });
  const retryGate = karton.jobs['source-gate'].steps.find(
    (step) =>
      step.name === 'Require current main or an exact canonical retry tag',
  );
  const tagStep = karton.jobs.tag.steps.find(
    (step) =>
      step.name ===
      'Recheck exact current main and create tag with CAS semantics',
  );
  assert.ok(retryGate);
  assert.ok(tagStep);
  assert.match(retryGate.run, /retry_commit=.*refs\/tags\/\$\{RELEASE_TAG\}/s);
  assert.match(retryGate.run, /test "\$retry_commit" = "\$RELEASE_REF"/);
  assert.match(tagStep.run, /git ls-remote origin refs\/heads\/main/);
  assert.match(tagStep.run, /final current-main check after all package gates/);
  assert.match(tagStep.run, /test -z .*refs\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(tagStep.run, /gh api --method POST/);
  assert.match(tagStep.run, /raced_commit=.*resolve_remote_tag_commit/);
  assert.match(tagStep.run, /test "\$raced_commit" = "\$RELEASE_REF"/);
});

test('Karton npm publication is retry-safe only for an exact tarball identity', () => {
  const karton = YAML.parse(
    readFileSync(
      new URL('.github/workflows/_release-karton.yml', repositoryRoot),
      'utf8',
    ),
  );

  assert.equal(karton.concurrency['cancel-in-progress'], false);
  assert.match(
    karton.concurrency.group,
    /^karton-npm-publication-\$\{\{ github\.repository \}\}$/,
  );

  assert.deepEqual(karton.jobs['publish-authorization'].needs, [
    'source-gate',
    'package',
    'tag',
  ]);
  const registryStep = karton.jobs['publish-authorization'].steps.find(
    (step) => step.id === 'registry-state',
  );
  assert.deepEqual(karton.jobs.publish.needs, [
    'source-gate',
    'package',
    'tag',
    'publish-authorization',
  ]);
  const publishStep = karton.jobs.publish.steps.find(
    (step) => step.name === 'Publish exact packed artifact to npm when absent',
  );
  const terminalStep = karton.jobs['publish-verification'].steps.find(
    (step) => step.id === 'npm-terminal',
  );
  assert.ok(registryStep);
  assert.ok(publishStep);
  assert.ok(terminalStep);
  assert.match(registryStep.run, /verify-npm-publication\.mjs/);
  assert.match(registryStep.run, /--mode=prepublish/);
  assert.match(registryStep.run, /--github-output="\$GITHUB_OUTPUT"/);
  assert.equal(publishStep.if, undefined);
  assert.match(publishStep.run, /npm publish "\$artifact"/);
  assert.match(publishStep.run, /-u NODE_AUTH_TOKEN/);
  assert.doesNotMatch(publishStep.run, /verify-npm-publication\.mjs/);
  assert.match(publishStep.run, /package\/package\.json/);
  assert.match(publishStep.run, /embeddedPackage\.name/);
  assert.match(publishStep.run, /embeddedPackage\.version/);
  assert.match(publishStep.run, /embeddedPackage\.publishConfig/);
  assert.match(publishStep.run, /npm exact-version metadata/);
  assert.match(publishStep.run, /npm dist-tags metadata/);
  assert.ok(
    publishStep.run.indexOf('npm exact-version metadata') <
      publishStep.run.indexOf('npm publish'),
  );
  assert.match(publishStep.run, /--ignore-scripts/);
  assert.match(
    publishStep.env.NODE_AUTH_TOKEN,
    /^\$\{\{ secrets\.NPM_TOKEN \}\}$/,
  );
  assert.equal(registryStep.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(terminalStep.env.NODE_AUTH_TOKEN, undefined);
  assert.match(terminalStep.run, /verify-npm-publication\.mjs/);
  assert.match(terminalStep.run, /--attempts=18/);
  assert.match(terminalStep.run, /--github-output="\$GITHUB_OUTPUT"/);
  assert.deepEqual(karton.jobs['publish-verification'].needs, [
    'package',
    'publish',
  ]);

  assert.deepEqual(karton.jobs.release.needs, [
    'source-gate',
    'tag',
    'publish-verification',
  ]);
  const releaseIdentityStep = karton.jobs.release.steps.find(
    (step) =>
      step.name === 'Reassert exact tag immediately before GitHub Release',
  );
  assert.ok(releaseIdentityStep);
  assert.match(releaseIdentityStep.run, /refs\/tags\/\$\{RELEASE_TAG\}/);
  assert.doesNotMatch(releaseIdentityStep.run, /refs\/heads\/main/);
});

test('Karton GitHub Release is create-only and reverified by exact returned ID', () => {
  const source = readFileSync(
    new URL('.github/workflows/_release-karton.yml', repositoryRoot),
    'utf8',
  );
  const karton = YAML.parse(source);
  const createStep = karton.jobs.release.steps.find(
    (step) => step.id === 'exact-release',
  );
  const verifyStep = karton.jobs.release.steps.find(
    (step) => step.name === 'Verify returned exact GitHub Release ID and state',
  );
  const terminalTagStep = karton.jobs.release.steps.find(
    (step) => step.name === 'Re-resolve exact remote tag after GitHub Release',
  );
  assert.ok(createStep);
  assert.ok(verifyStep);
  assert.ok(terminalTagStep);
  assert.match(createStep.run, /create-exact-public-release\.mjs/);
  assert.match(createStep.run, /--github-output="\$GITHUB_OUTPUT"/);
  assert.match(verifyStep.run, /--release-id="\$RELEASE_ID"/);
  assert.match(verifyStep.run, /test "\$RELEASE_STATE" = "published"/);
  assert.match(verifyStep.run, /test "\$RELEASE_TARGET" = "\$RELEASE_REF"/);
  assert.match(
    verifyStep.env.RELEASE_ID,
    /^\$\{\{ steps\.exact-release\.outputs\.release_id \}\}$/,
  );
  assert.ok(
    karton.jobs.release.steps.indexOf(terminalTagStep) >
      karton.jobs.release.steps.indexOf(verifyStep),
  );
  assert.match(terminalTagStep.run, /git ls-remote origin/);
  assert.match(
    terminalTagStep.run,
    /terminal_tag_commit=.*refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/s,
  );
  assert.match(
    terminalTagStep.run,
    /test "\$terminal_tag_commit" = "\$RELEASE_REF"/,
  );
  assert.doesNotMatch(source, /softprops\/action-gh-release|\bgh release\b/i);
});

test('Karton publication preserves exact-source and credential boundaries', () => {
  const kartonSource = readFileSync(
    new URL('.github/workflows/_release-karton.yml', repositoryRoot),
    'utf8',
  );
  const karton = YAML.parse(kartonSource);
  assert.equal(karton.jobs.publish.environment, 'Release');
  assert.equal(karton.jobs['publish-authorization'].environment, undefined);
  assert.equal(karton.jobs['publish-verification'].environment, undefined);
  assert.equal(karton.jobs.publish.permissions.contents, 'read');
  assert.equal(karton.jobs.publish.permissions.actions, 'read');
  assert.equal(karton.jobs.publish.permissions['id-token'], undefined);
  assert.match(kartonSource, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(kartonSource, /persist-credentials: false/);
  assert.match(kartonSource, /packages\/karton\/package\.json/);
  assert.match(kartonSource, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.equal(
    karton.jobs.publish.steps.some((step) =>
      String(step.run ?? '').match(/scripts\/release|packages\/karton/),
    ),
    false,
  );
  assert.equal(
    karton.jobs.publish.steps.some((step) =>
      String(step.uses ?? '').startsWith('actions/checkout@'),
    ),
    false,
  );

  const tokenBearingSteps = Object.values(karton.jobs).flatMap((job) =>
    job.steps.filter((step) => step.env?.NODE_AUTH_TOKEN !== undefined),
  );
  assert.equal(tokenBearingSteps.length, 1);
  assert.equal(
    tokenBearingSteps[0].name,
    'Publish exact packed artifact to npm when absent',
  );
});
