import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'community-unsigned-build.yml',
);
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(workflowSource);
const gitAttributesSource = readFileSync(
  path.join(repositoryRoot, '.gitattributes'),
  'utf8',
);

function visit(value, pathParts = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      visit(entry, [...pathParts, String(index)]),
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [
      { key, path: [...pathParts, key].join('.'), value: entry },
      ...visit(entry, [...pathParts, key]),
    ]);
  }
  return [];
}

function step(jobName, name) {
  const result = workflow.jobs?.[jobName]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(result, `missing workflow step ${jobName}/${name}`);
  return result;
}

function githubExpression(value) {
  return `\${{ ${value} }}`;
}

test('community unsigned workflow is manual, exact-main, and read-only', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    'confirm',
  ]);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.confirm.description,
    'Type BUILD_COMMUNITY_UNSIGNED to build non-promotional Actions artifacts',
  );
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.env.NPM_CONFIG_IGNORE_PNPMFILE, 'true');

  const permissionBlocks = visit(workflow).filter(
    (entry) => entry.key === 'permissions',
  );
  assert.deepEqual(
    permissionBlocks.map((entry) => entry.value),
    [{ contents: 'read' }],
  );

  const forbiddenKeys = visit(workflow).filter(
    (entry) => entry.key === 'environment',
  );
  assert.deepEqual(forbiddenKeys, [], 'community jobs must use no Environment');

  const confirmation = step(
    'preflight',
    'Require canonical main and explicit confirmation',
  );
  assert.equal(
    confirmation.env.COMMUNITY_CONFIRMATION,
    githubExpression('inputs.confirm'),
  );
  assert.match(confirmation.run, /BUILD_COMMUNITY_UNSIGNED/);
  assert.match(confirmation.run, /refs\/heads\/main/);
  assert.match(confirmation.run, /mereyabdenbekuly-ctrl\/clodex-ide/);

  const checkout = step(
    'preflight',
    'Checkout dispatch commit without credentials or tags',
  );
  assert.equal(checkout.with.ref, githubExpression('github.sha'));
  assert.equal(checkout.with['fetch-depth'], 1);
  assert.equal(checkout.with['fetch-tags'], false);
  assert.equal(checkout.with['persist-credentials'], false);

  const checkoutSteps = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((candidate) =>
      candidate.uses?.startsWith('actions/checkout@'),
    ),
  );
  assert.equal(checkoutSteps.length, 3);
  for (const checkoutStep of checkoutSteps) {
    assert.equal(checkoutStep.with['fetch-depth'], 1);
    assert.equal(checkoutStep.with['fetch-tags'], false);
    assert.equal(checkoutStep.with['persist-credentials'], false);
  }

  const canonicalMain = step(
    'preflight',
    'Require dispatch commit to be exact canonical main',
  ).run;
  assert.match(canonicalMain, /git ls-remote origin refs\/heads\/main/);
  assert.match(canonicalMain, /GITHUB_SHA/);
  assert.match(canonicalMain, /GITHUB_WORKFLOW_SHA/);

  for (const jobName of ['source-validation', 'build']) {
    const exactCheckout = step(jobName, 'Assert exact source checkout').run;
    assert.match(exactCheckout, /git ls-remote origin refs\/heads\/main/);
    assert.match(exactCheckout, /COMMUNITY_SOURCE_SHA/);
  }

  const identity = step(
    'preflight',
    'Derive non-tagged community build identity',
  ).run;
  assert.match(identity, /-community\$\{runNumber\}/);
  assert.match(identity, /source_sha=/);
  assert.match(identity, /short_sha=/);
  assert.doesNotMatch(identity, /release-tag|git tag|refs\/tags/u);
});

test('community unsigned workflow exposes no release or credential authority', () => {
  const forbidden = [
    /\bsecrets\./u,
    /\bvars\./u,
    /secrets:\s*inherit/u,
    /environment:\s*/u,
    /contents:\s*write/u,
    /actions:\s*write/u,
    /id-token:\s*write/u,
    /attestations:\s*write/u,
    /\bGH_TOKEN\b/u,
    /\bGITHUB_TOKEN\b/u,
    /\bAPPLE_[A-Z0-9_]+\b/u,
    /\bAZURE_[A-Z0-9_]+\b/u,
    /\bPOSTHOG[A-Z0-9_]*\b/u,
    /\bUPDATE_SERVER_ORIGIN\b/u,
    /softprops\/action-gh-release/u,
    /\bgh\s+release\b/u,
    /\/releases(?:\/|\b)/u,
    /\/git\/refs(?:\/|\b)/u,
    /\bgit\s+(?:tag|push)\b/u,
    /refs\/tags/u,
    /_release-browser\.yml/u,
    /auto-release\.yml/u,
    /technical-preview-release\.yml/u,
    /release-publication-attestation\.yml/u,
    /release-acceptance-evidence\.yml/u,
    /verify-release-promotion\.mjs/u,
    /\.release-evidence/u,
    /ready-as-rollback-baseline/u,
    /ready-for-canary/u,
    /ready-for-stable/u,
    /actions\/attest-build-provenance/u,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(workflowSource, pattern);
  }

  const actions = visit(workflow)
    .filter((entry) => entry.key === 'uses' && typeof entry.value === 'string')
    .map((entry) => entry.value);
  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/u, `unpinned action: ${action}`);
  }

  const runBlocks = visit(workflow).filter(
    (entry) => entry.key === 'run' && typeof entry.value === 'string',
  );
  for (const block of runBlocks) {
    assert.doesNotMatch(
      block.value,
      /\$\{\{/u,
      `GitHub expression interpolated directly in ${block.path}`,
    );
  }
});

test('community unsigned workflow builds and validates exactly four isolated targets', () => {
  assert.equal(workflow.jobs.preflight['timeout-minutes'], 10);
  assert.equal(workflow.jobs['source-validation']['timeout-minutes'], 45);
  assert.equal(workflow.jobs.build['timeout-minutes'], 120);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include, [
    {
      os: 'macos-26',
      platform: 'macos',
      arch: 'arm64',
      artifact: 'macos-arm64',
    },
    {
      os: 'macos-26-intel',
      platform: 'macos',
      arch: 'x64',
      artifact: 'macos-x64',
    },
    {
      os: 'ubuntu-latest',
      platform: 'linux',
      arch: 'x64',
      artifact: 'linux-x64',
    },
    {
      os: 'windows-latest',
      platform: 'windows',
      arch: 'x64',
      artifact: 'windows-x64',
    },
  ]);
  assert.deepEqual(workflow.jobs.build.needs, [
    'preflight',
    'source-validation',
  ]);
  assert.equal(workflow.jobs.build.env.RELEASE_CHANNEL, 'release');
  assert.equal(
    workflow.jobs.build.env.CLODEX_DISTRIBUTION_MODE,
    'community-unsigned',
  );
  assert.equal(workflow.jobs.build.env.CLODEX_AUTH_ENABLED, 'false');
  assert.equal(workflow.jobs.build.env.VITE_DISABLE_TELEMETRY, 'true');
  assert.equal(
    workflow.jobs.build.env.CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD,
    undefined,
  );
  assert.equal(workflow.jobs.build.env.CLODEX_LOCAL_BUILD_ID, undefined);

  for (const jobName of ['source-validation', 'build']) {
    const bootstrap = step(jobName, 'Validate pnpm bootstrap policy');
    const setupIndex = workflow.jobs[jobName].steps.indexOf(
      step(jobName, 'Setup pnpm'),
    );
    const bootstrapIndex = workflow.jobs[jobName].steps.indexOf(bootstrap);
    assert.ok(bootstrapIndex >= 0 && bootstrapIndex < setupIndex);
    const install = step(
      jobName,
      'Install frozen dependencies without repository hooks',
    );
    assert.match(install.run, /--frozen-lockfile/u);
    assert.match(install.run, /--ignore-pnpmfile/u);
  }

  const metadataVersion = step(
    'build',
    'Apply non-tagged community version to package metadata',
  );
  assert.equal(
    metadataVersion.env.COMMUNITY_VERSION,
    githubExpression('needs.preflight.outputs.version'),
  );
  assert.match(metadataVersion.run, /apps\/browser\/package\.json/u);
  assert.match(metadataVersion.run, /GITHUB_RUN_NUMBER/u);
  assert.match(metadataVersion.run, /pkg\.version = expectedVersion/u);
  assert.match(
    metadataVersion.run,
    /git diff --exit-code -- \. ':\(exclude\)apps\/browser\/package\.json'/u,
  );
  assert.ok(
    workflow.jobs.build.steps.indexOf(metadataVersion) <
      workflow.jobs.build.steps.indexOf(
        step('build', 'Build workspace packages'),
      ),
  );

  const sourceValidation = workflow.jobs['source-validation'];
  assert.ok(
    sourceValidation.steps.some(
      (candidate) => candidate.run === 'pnpm security:dependencies',
    ),
  );
  assert.ok(
    sourceValidation.steps.some((candidate) =>
      candidate.run?.includes('release:attribution:check -- --channel=release'),
    ),
  );

  const validation = step(
    'build',
    'Validate exact community desktop artifacts',
  ).run;
  assert.match(validation, /--distribution-mode=community-unsigned/u);
  assert.match(validation, /--source-commit=\$COMMUNITY_SOURCE_SHA/u);
  assert.match(validation, /release:validate:macos/u);
  assert.match(validation, /release:validate:artifacts/u);
  assert.match(validation, /--skip-make/u);
  assert.match(validation, /--ui-launch/u);

  const assembler = step('build', 'Assemble bounded community bundle').run;
  assert.match(assembler, /assemble-community-unsigned-bundle\.mjs/u);
  assert.match(
    assembler,
    /out\/community-unsigned\/validation\/\$\{COMMUNITY_PLATFORM\}-\$\{COMMUNITY_ARCH\}-\$\{COMMUNITY_VERSION\}\.json/u,
  );
  assert.match(assembler, /--source-commit=\$COMMUNITY_SOURCE_SHA/u);
  assert.match(assembler, /--platform=\$COMMUNITY_PLATFORM/u);
  assert.match(assembler, /--arch=\$COMMUNITY_ARCH/u);
});

test('hash-pinned dependency license evidence is byte-preserved on Windows', () => {
  assert.match(
    gitAttributesSource,
    /^docs\/provenance\/dependency-license-texts\/\*\* -text whitespace=-blank-at-eol,-blank-at-eof,cr-at-eol$/mu,
  );
});

test('community outputs are short-lived Actions artifacts only', () => {
  const upload = step('build', 'Upload community Actions artifact');
  assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
  assert.match(upload.with.name, /^clodex-community-unsigned-/u);
  assert.match(upload.with.name, /github\.run_attempt/u);
  assert.match(upload.with.path, /clodex-community-unsigned-bundle\/$/u);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 14);
  assert.equal(upload.with['compression-level'], 0);

  const uploadActions = visit(workflow).filter(
    (entry) =>
      entry.key === 'uses' &&
      typeof entry.value === 'string' &&
      entry.value.startsWith('actions/upload-artifact@'),
  );
  assert.equal(uploadActions.length, 1);
});
