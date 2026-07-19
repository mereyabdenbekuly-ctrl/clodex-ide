import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertProtectedDraftState,
  exactUploadEndpoint,
  GitHubReleaseApi,
  parseProtectedDraftArguments,
  stageProtectedReleaseDraft,
} from './create-protected-release-draft.mjs';
import { queryGitHubReleaseState } from './github-release-state.mjs';
import {
  assertReleaseTagReusable,
  sha256Text,
  validateReleasePlan,
} from './release-plan.mjs';
import { assembleCanaryObservationEvidenceBundle } from './assemble-canary-observation-receipt.mjs';
import { canonicalCanaryArtifactBytes } from './canary-observation-summaries.mjs';
import {
  CANARY_FIXTURE_NOW,
  canaryDistributionSummary,
  canaryHealthSummary,
  canaryReceiptProducer,
} from './canary-observation-test-fixtures.mjs';

const repositoryRoot = new URL('../../', import.meta.url);

test('technical preview retry accepts only an absent or exact-SHA tag', () => {
  const releaseRef = 'a'.repeat(40);
  assert.doesNotThrow(() =>
    assertReleaseTagReusable({
      existingTagCommit: null,
      releaseRef,
      tag: 'v1.16.0-preview.2',
    }),
  );
  assert.doesNotThrow(() =>
    assertReleaseTagReusable({
      existingTagCommit: releaseRef,
      releaseRef,
      tag: 'v1.16.0-preview.2',
    }),
  );
  assert.throws(
    () =>
      assertReleaseTagReusable({
        existingTagCommit: 'b'.repeat(40),
        releaseRef,
        tag: 'v1.16.0-preview.2',
      }),
    /points to b+.*expected a+/,
  );
});

function expectedBundles() {
  return [
    'clodex-linux-x64',
    'clodex-macos-arm64',
    'clodex-macos-x64',
    'clodex-windows-x64',
  ];
}

function expectedValidation(version) {
  return [
    `linux-x64-${version}.json`,
    `linux-x64-${version}.sha256`,
    `macos-arm64-${version}.json`,
    `macos-arm64-${version}.sha256`,
    `macos-x64-${version}.json`,
    `macos-x64-${version}.sha256`,
    `windows-x64-${version}.json`,
    `windows-x64-${version}.sha256`,
  ];
}

function commonPlan(version) {
  return {
    acceptance: { binding: 'manifest-sha256+source-commit' },
    authentication: {
      oauthWebAuthReady: false,
      releaseClaim: 'OAuth/WebAuth is not included in this release.',
    },
    githubArtifactBundles: expectedBundles(),
    schemaVersion: 2,
    sourceRef: 'main',
    validationArtifacts: expectedValidation(version),
    version,
  };
}

function baselinePlan() {
  const version = '1.16.0-preview.2';
  return {
    ...commonPlan(version),
    acceptance: {
      binding: 'manifest-sha256+source-commit',
      requiredStatus: 'ready-as-rollback-baseline',
    },
    buildChannel: 'prerelease',
    channel: 'preview',
    distribution: {
      access: 'release-operators-only',
      githubReleaseState: 'draft',
      canaryInstallations: 0,
      protectedEnvironment: 'Release',
      publicDownloadLinks: false,
    },
    promotionRole: 'rollback-baseline',
    releaseKind: 'technical-preview',
    rollback: { mode: 'distribution-stop-only' },
    tag: `v${version}`,
  };
}

function acceptedEvidence({ plan, sourceCommit, status, canary }) {
  const historicalManifest = `${JSON.stringify(plan, null, 2)}\n`;
  const reportFileName = 'clodex-release-publication.json';
  const reportSha256 = '8'.repeat(64);
  return {
    evidence: {
      blockers: [],
      canary,
      checks: [
        'source.commit-bound',
        'source.clean-tree',
        'publication.github-release',
        'toolchain.node',
        'toolchain.pnpm',
        'artifact.validation-manifest',
        'artifact.packaged-smoke',
        'artifact.clean-profile-launch',
        'artifact.app-icon',
        'security.distribution-trust',
        'product.quick-task-green',
        'product.task-creation-contract',
        'product.browser-contract',
        'product.mcp-contract',
        'product.guardian-egress-contract',
        'product.session-recovery-contract',
        'manual.dock-or-tray-icon',
        'manual.task-creation',
        'manual.terminal',
        'manual.browser',
        'manual.mcp',
        'manual.guardian-egress-prompt',
        'manual.restart-session-recovery',
      ].map((id) => ({ id, reasonCode: 'test-pass', status: 'pass' })),
      collector: {
        repository: 'mereyabdenbekuly-ctrl/clodex-ide',
        runAttempt: 1,
        runId: 456,
        sourceCommit: '4'.repeat(40),
        sourceRef: 'refs/heads/main',
        workflow:
          'mereyabdenbekuly-ctrl/clodex-ide/.github/workflows/release-acceptance-evidence.yml',
        workflowCommit: '4'.repeat(40),
      },
      evidenceKind: 'release-acceptance',
      generatedAt: '2026-07-15T00:00:00.000Z',
      manifest: {
        path: '.release-notes/clodex-technical-preview.json',
        sha256: sha256Text(historicalManifest),
        sourceCommit,
      },
      inputs: {
        automatedChecks: {
          path: 'automated-checks.json',
          sha256: 'a'.repeat(64),
          sourceCommit,
        },
        manualChecks: {
          path: 'manual-checks.json',
          sha256: 'b'.repeat(64),
          sourceCommit: '4'.repeat(40),
        },
      },
      publication: {
        assets: [
          {
            bytes: 128,
            fileName: 'clodex-preview.dmg',
            releaseAssetId: 1001,
            sha256: '7'.repeat(64),
          },
          {
            bytes: 256,
            fileName: reportFileName,
            releaseAssetId: 1002,
            sha256: reportSha256,
          },
        ],
        createdAt: '2026-07-12T23:00:00.000Z',
        releaseId: 123,
        reportAssetId: 1002,
        reportFileName,
        reportSha256,
        repository: 'mereyabdenbekuly-ctrl/clodex-ide',
        sourceCommit,
        tag: plan.tag,
      },
      release: {
        channel: 'preview',
        promotionRole: plan.promotionRole,
        tag: plan.tag,
        version: plan.version,
      },
      rollback: {
        mode: 'distribution-stop-only',
        ...(plan.promotionRole === 'canary'
          ? { targetTag: 'v1.16.0-preview.2' }
          : {}),
      },
      schemaVersion: 4,
      status,
    },
    historicalManifest,
  };
}

function observationEvidenceForAcceptedPlan({
  manifestSha256,
  plan,
  reportSha256,
  sourceCommit,
}) {
  const distribution = canaryDistributionSummary();
  const health = canaryHealthSummary();
  for (const summary of [distribution, health]) {
    summary.source.commit = sourceCommit;
    summary.manifest.sha256 = manifestSha256;
    summary.manifest.sourceCommit = sourceCommit;
    summary.release.sourceCommit = sourceCommit;
    summary.release.tag = plan.tag;
    summary.release.version = plan.version;
    summary.publication.createdAt = '2026-07-12T23:00:00.000Z';
    summary.publication.releaseId = 123;
    summary.publication.reportAssetId = 1002;
    summary.publication.reportSha256 = reportSha256;
    summary.publication.sourceCommit = sourceCommit;
    summary.publication.tag = plan.tag;
  }
  return assembleCanaryObservationEvidenceBundle(
    {
      distributionBytes: canonicalCanaryArtifactBytes(distribution),
      healthBytes: canonicalCanaryArtifactBytes(health),
      producer: canaryReceiptProducer(),
    },
    { now: CANARY_FIXTURE_NOW },
  );
}

test('schema-v2 preview.2 is a draft rollback baseline without a target tag', () => {
  const plan = baselinePlan();
  assert.doesNotThrow(() => validateReleasePlan(plan));
  for (const previewNumber of [1, 4, 99]) {
    const version = `1.16.0-preview.${previewNumber}`;
    assert.throws(
      () =>
        validateReleasePlan({
          ...plan,
          tag: `v${version}`,
          validationArtifacts: expectedValidation(version),
          version,
        }),
      /requires preview\.2 as rollback baseline/,
    );
  }
  assert.throws(
    () =>
      validateReleasePlan({
        ...plan,
        rollback: {
          mode: 'distribution-stop-only',
          targetTag: 'v1.16.0-preview.1',
        },
      }),
    /must not declare a rollback target tag/,
  );
  assert.throws(
    () =>
      validateReleasePlan({
        ...plan,
        distribution: { ...plan.distribution, githubReleaseState: 'published' },
      }),
    /must be staged as draft/,
  );
});

test('preview.3 requires committed manifest-bound preview.2 acceptance', () => {
  const baseline = baselinePlan();
  const sourceCommit = '1'.repeat(40);
  const { evidence, historicalManifest } = acceptedEvidence({
    canary: {
      authFailures: 0,
      distributionClosedAt: null,
      endedAt: null,
      observationEvidence: null,
      observedHours: null,
      observedInstallations: null,
      startedAt: null,
      stopReasons: [],
      targetInstallations: 0,
      targetObservationHours: 24,
    },
    plan: baseline,
    sourceCommit,
    status: 'ready-as-rollback-baseline',
  });
  const version = '1.16.0-preview.3';
  const canaryPlan = {
    ...commonPlan(version),
    acceptance: {
      binding: 'manifest-sha256+source-commit',
      entryStatus: 'ready-for-canary',
      requiredStatus: 'ready-for-stable',
    },
    buildChannel: 'prerelease',
    channel: 'preview',
    distribution: {
      access: 'controlled-canary',
      githubReleaseState: 'draft',
      canaryInstallations: 5,
      protectedEnvironment: 'Release',
      publicDownloadLinks: false,
    },
    promotionEvidence: '.release-evidence/v1.16.0-preview.2.json',
    promotionRole: 'canary',
    releaseKind: 'technical-preview',
    rollback: {
      mode: 'distribution-stop-only',
      targetTag: 'v1.16.0-preview.2',
    },
    tag: `v${version}`,
  };
  const evidenceContext = {
    changedPathsSince: () => [
      '.release-evidence/v1.16.0-preview.2.json',
      '.release-notes/clodex-technical-preview.json',
    ],
    isAncestorCommit: () => true,
    loadEvidence: () => ({ committed: true, value: evidence }),
    loadManifestAtCommit: () => historicalManifest,
    now: new Date('2026-07-15T01:00:00.000Z'),
    verifyEvidenceTrust: () => true,
  };
  assert.doesNotThrow(() => validateReleasePlan(canaryPlan, evidenceContext));
  assert.throws(
    () =>
      validateReleasePlan(canaryPlan, {
        ...evidenceContext,
        verifyEvidenceTrust: undefined,
      }),
    /lacks a verified protected-workflow attestation/,
  );
  assert.throws(
    () =>
      validateReleasePlan(canaryPlan, {
        ...evidenceContext,
        loadEvidence: () => ({ committed: false, value: evidence }),
      }),
    /must be committed without worktree changes/,
  );
  assert.throws(
    () =>
      validateReleasePlan(canaryPlan, {
        ...evidenceContext,
        loadEvidence: () => ({
          committed: true,
          value: { ...evidence, status: 'TODO' },
        }),
      }),
    /placeholder text/,
  );
  assert.throws(
    () =>
      validateReleasePlan(canaryPlan, {
        ...evidenceContext,
        loadEvidence: () => ({
          committed: true,
          value: { ...evidence, checks: evidence.checks.slice(1) },
        }),
      }),
    /acceptance checks are incomplete(?: or duplicated)?/,
  );
  assert.throws(
    () =>
      validateReleasePlan(
        {
          ...canaryPlan,
          promotionEvidence: '.release-evidence/../forged.json',
        },
        evidenceContext,
      ),
    /must reference a JSON file under \.release-evidence/,
  );
  assert.throws(
    () =>
      validateReleasePlan(canaryPlan, {
        ...evidenceContext,
        changedPathsSince: () => ['apps/browser/src/backend/main.ts'],
      }),
    /changed product code after accepted source commit/,
  );
});

test('stable release requires real preview.3 canary-5 evidence', () => {
  const canaryVersion = '1.16.0-preview.3';
  const canaryPlan = {
    ...commonPlan(canaryVersion),
    acceptance: {
      binding: 'manifest-sha256+source-commit',
      entryStatus: 'ready-for-canary',
      requiredStatus: 'ready-for-stable',
    },
    buildChannel: 'prerelease',
    channel: 'preview',
    distribution: {
      access: 'controlled-canary',
      githubReleaseState: 'draft',
      canaryInstallations: 5,
      protectedEnvironment: 'Release',
      publicDownloadLinks: false,
    },
    promotionEvidence: '.release-evidence/v1.16.0-preview.2.json',
    promotionRole: 'canary',
    releaseKind: 'technical-preview',
    rollback: {
      mode: 'distribution-stop-only',
      targetTag: 'v1.16.0-preview.2',
    },
    tag: `v${canaryVersion}`,
  };
  const sourceCommit = '3'.repeat(40);
  const canaryManifest = `${JSON.stringify(canaryPlan, null, 2)}\n`;
  const observationEvidence = observationEvidenceForAcceptedPlan({
    manifestSha256: sha256Text(canaryManifest),
    plan: canaryPlan,
    reportSha256: '8'.repeat(64),
    sourceCommit,
  });
  const observation = observationEvidence.receipt.value.observation;
  const { evidence, historicalManifest } = acceptedEvidence({
    canary: {
      authFailures: 0,
      distributionClosedAt: observation.distributionClosedAt,
      endedAt: observation.endedAt,
      observationEvidence,
      observedHours: observation.observedHours,
      observedInstallations: 5,
      startedAt: observation.startedAt,
      stopReasons: [],
      targetInstallations: 5,
      targetObservationHours: 24,
    },
    plan: canaryPlan,
    sourceCommit,
    status: 'ready-for-stable',
  });
  const version = '1.16.0';
  const stablePlan = {
    ...commonPlan(version),
    acceptance: {
      binding: 'manifest-sha256+source-commit',
      requiredStatus: 'ready-for-stable',
    },
    buildChannel: 'release',
    channel: 'release',
    distribution: {
      githubReleaseState: 'draft',
      protectedEnvironment: 'Release',
      publicDownloadLinks: false,
    },
    promotionEvidence: '.release-evidence/v1.16.0-preview.3.json',
    releaseKind: 'stable',
    tag: 'clodex@1.16.0',
  };
  const evidenceContext = {
    changedPathsSince: () => [
      '.release-evidence/v1.16.0-preview.3.json',
      '.release-notes/clodex-stable.json',
    ],
    isAncestorCommit: () => true,
    loadEvidence: () => ({ committed: true, value: evidence }),
    loadManifestAtCommit: () => historicalManifest,
    now: new Date('2026-07-15T01:00:00.000Z'),
    resolveTagCommit: () => sourceCommit,
    verifyEvidenceTrust: () => true,
  };
  assert.doesNotThrow(() => validateReleasePlan(stablePlan, evidenceContext));
  assert.throws(
    () =>
      validateReleasePlan(
        {
          ...stablePlan,
          distribution: {
            githubReleaseState: 'published',
            publicDownloadLinks: true,
          },
        },
        evidenceContext,
      ),
    /protected draft without public links/,
  );
  assert.throws(
    () =>
      validateReleasePlan(stablePlan, {
        ...evidenceContext,
        requirePrerequisiteTag: true,
        resolveTagCommit: () => null,
      }),
    /prerequisite tag v1\.16\.0-preview\.3 must resolve/,
  );
  assert.throws(
    () =>
      validateReleasePlan(stablePlan, {
        ...evidenceContext,
        loadEvidence: () => ({
          committed: true,
          value: {
            ...evidence,
            canary: { ...evidence.canary, targetInstallations: 4 },
          },
        }),
      }),
    /exactly-five|zero-failure/,
  );
});

function mockedGhResult({ body = [], error, httpStatus, status }) {
  return {
    error,
    status,
    stderr:
      httpStatus === undefined ? '' : `gh: mocked failure (HTTP ${httpStatus})`,
    stdout: status === 0 ? JSON.stringify(body) : '',
  };
}

test('GitHub release lookup paginates all records and reports no exact tag as absent', () => {
  const calls = [];
  const runGh = (...args) => {
    calls.push(args);
    return mockedGhResult({
      body: [[{ draft: false, published_at: 'now', tag_name: 'other' }]],
      status: 0,
    });
  };
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh,
      tag: 'v1.16.0-preview.2',
    }),
    'absent',
  );
  assert.deepEqual(calls[0][1], [
    'api',
    '--paginate',
    '--slurp',
    '--method',
    'GET',
    'repos/owner/repository/releases?per_page=100',
  ]);
});

test('GitHub release lookup distinguishes exact drafts from published releases', () => {
  const tag = 'v1.16.0-preview.2';
  const draftGh = () =>
    mockedGhResult({
      body: [[{ draft: true, published_at: null, tag_name: tag }]],
      status: 0,
    });
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh: draftGh,
      tag,
    }),
    'draft',
  );

  const publishedGh = () =>
    mockedGhResult({
      body: [
        [
          {
            draft: false,
            published_at: '2026-07-15T12:00:00Z',
            tag_name: tag,
          },
        ],
      ],
      status: 0,
    });
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh: publishedGh,
      tag,
    }),
    'published',
  );
});

test('GitHub release lookup rejects duplicate, malformed, or inconsistent state', () => {
  const tag = 'v1.16.0-preview.2';
  for (const [body, expectedError] of [
    [
      [[{ draft: true, published_at: '2026-07-15T12:00:00Z', tag_name: tag }]],
      /inconsistent publication state/,
    ],
    [
      [[{ draft: false, published_at: null, tag_name: tag }]],
      /inconsistent publication state/,
    ],
    [
      [
        [
          { draft: true, published_at: null, tag_name: tag },
          { draft: true, published_at: null, tag_name: tag },
        ],
      ],
      /found 2 records/,
    ],
    [
      [{ draft: true, published_at: null, tag_name: tag }],
      /paginated response/,
    ],
    [[[null]], /invalid release metadata/],
  ]) {
    assert.throws(
      () =>
        queryGitHubReleaseState({
          repository: 'owner/repository',
          runGh: () => mockedGhResult({ body, status: 0 }),
          tag,
        }),
      expectedError,
    );
  }
});

test('GitHub release lookup aborts on auth, rate-limit, and server failures', () => {
  for (const httpStatus of [401, 403, 404, 429, 500, 503]) {
    const runGh = () => mockedGhResult({ httpStatus, status: 1 });
    assert.throws(
      () =>
        queryGitHubReleaseState({
          repository: 'owner/repository',
          runGh,
          tag: 'v1.16.0-preview.2',
        }),
      new RegExp(`HTTP ${httpStatus}`),
    );
  }
});

test('GitHub release lookup aborts on network and status-less failures', () => {
  assert.throws(
    () =>
      queryGitHubReleaseState({
        repository: 'owner/repository',
        runGh: () =>
          mockedGhResult({
            error: new Error('spawn gh ENETUNREACH'),
            status: null,
          }),
        tag: 'v1.16.0-preview.2',
      }),
    /before receiving an HTTP response.*ENETUNREACH/,
  );
  assert.throws(
    () =>
      queryGitHubReleaseState({
        repository: 'owner/repository',
        runGh: () => mockedGhResult({ status: 1 }),
        tag: 'v1.16.0-preview.2',
      }),
    /before receiving an HTTP status/,
  );
});

const protectedTag = 'v1.16.0-preview.2';
const protectedRef = 'a'.repeat(40);
const protectedRepository = 'owner/repository';
const protectedBody = 'Release notes';
const protectedName = 'Clodex Agentic IDE 1.16.0-preview.2';
const protectedFixtureContents = {
  'clodex-preview.zip': 'preview-bytes',
  'clodex-release-publication.json': '{"schemaVersion":3}\n',
};

function protectedReleaseAssets() {
  return Object.entries(protectedFixtureContents).map(
    ([name, contents], index) => ({
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      id: 901 + index,
      name,
      size: Buffer.byteLength(contents),
      state: 'uploaded',
    }),
  );
}

function protectedRelease({
  assets = [],
  body = protectedBody,
  draft = true,
  id = 734,
  name = protectedName,
  prerelease = true,
  tag = protectedTag,
  targetCommitish = protectedRef,
} = {}) {
  return {
    assets,
    body,
    draft,
    id,
    name,
    prerelease,
    published_at: draft ? null : '2026-07-15T12:00:00Z',
    tag_name: tag,
    target_commitish: targetCommitish,
    upload_url: `https://uploads.github.com/repos/${protectedRepository}/releases/${id}/assets{?name,label}`,
  };
}

async function protectedAssetsFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'clodex-protected-draft-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  for (const [name, contents] of Object.entries(protectedFixtureContents)) {
    await writeFile(join(directory, name), contents);
  }
  return directory;
}

test('protected draft parser rejects duplicate CLI arguments', () => {
  assert.throws(
    () =>
      parseProtectedDraftArguments([
        '--tag=v1.16.0-preview.2',
        '--tag=v1.16.0-preview.3',
      ]),
    /Duplicate argument: --tag/,
  );
});

test('protected draft state requires exact non-empty uploaded asset metadata', () => {
  const release = protectedRelease({
    assets: [
      {
        digest: `sha256:${'0'.repeat(64)}`,
        id: 901,
        name: 'clodex-preview.zip',
        size: 13,
        state: 'uploaded',
      },
    ],
  });
  assert.throws(
    () =>
      assertProtectedDraftState({
        assets: release.assets,
        body: protectedBody,
        expectedAssets: [
          {
            bytes: 13,
            name: 'clodex-preview.zip',
            sha256: '1'.repeat(64),
          },
        ],
        name: protectedName,
        prerelease: true,
        release,
        releaseId: 734,
        tag: protectedTag,
        targetCommitish: protectedRef,
      }),
    /digest does not match/,
  );
  assert.throws(
    () =>
      assertProtectedDraftState({
        assets: [{ ...release.assets[0], digest: null, state: 'new' }],
        body: protectedBody,
        expectedAssets: [
          {
            bytes: 13,
            name: 'clodex-preview.zip',
            sha256: '1'.repeat(64),
          },
        ],
        name: protectedName,
        prerelease: true,
        release,
        releaseId: 734,
        tag: protectedTag,
        targetCommitish: protectedRef,
      }),
    /not a complete non-empty upload/,
  );
});

test('protected draft staging rejects zero-byte assets before API access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clodex-empty-draft-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'empty.zip'), '');
  await assert.rejects(
    stageProtectedReleaseDraft({
      api: {
        listReleases: async () => {
          throw new Error('API must not be called');
        },
      },
      assetsDirectory: directory,
      body: 'Release notes',
      name: 'Clodex Agentic IDE 1.16.0-preview.2',
      prerelease: true,
      repository: protectedRepository,
      tag: protectedTag,
      targetCommitish: protectedRef,
    }),
    /must not be empty/,
  );
});

test('protected draft staging refuses a pre-existing public release without mutation', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const calls = [];
  const api = {
    createDraft: async () => {
      calls.push('create');
      throw new Error('must not create');
    },
    deleteRelease: async () => calls.push('delete'),
    getRelease: async () => calls.push('get'),
    listReleases: async () => {
      calls.push('list');
      return [protectedRelease({ draft: false, id: 100 })];
    },
    uploadAsset: async () => calls.push('upload'),
  };

  await assert.rejects(
    stageProtectedReleaseDraft({
      api,
      assetsDirectory,
      body: 'Release notes',
      name: 'Clodex Agentic IDE 1.16.0-preview.2',
      prerelease: true,
      repository: protectedRepository,
      tag: protectedTag,
      targetCommitish: protectedRef,
    }),
    /does not match the exact protected draft identity.*existing GitHub Release ID 100.*left untouched/,
  );
  assert.deepEqual(calls, ['list']);
});

test('protected draft retry verifies an exact draft and uploads only missing assets', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const expectedAssets = protectedReleaseAssets();
  const partialRelease = protectedRelease({ assets: [expectedAssets[0]] });
  const completeRelease = protectedRelease({ assets: expectedAssets });
  const calls = [];
  let getCount = 0;
  let listCount = 0;
  const api = {
    createDraft: async () => {
      calls.push({ type: 'create' });
      throw new Error('must not create while an exact draft exists');
    },
    getRelease: async (repository, releaseId) => {
      calls.push({ releaseId, repository, type: 'get' });
      getCount += 1;
      return getCount === 1 ? partialRelease : completeRelease;
    },
    listReleases: async () => {
      calls.push({ type: 'list' });
      listCount += 1;
      return listCount === 1 ? [partialRelease] : [completeRelease];
    },
    uploadAsset: async ({ asset, uploadEndpoint }) => {
      calls.push({
        endpoint: uploadEndpoint.href,
        name: asset.name,
        type: 'upload',
      });
      return {
        digest: `sha256:${asset.sha256}`,
        id: 999,
        name: asset.name,
        size: asset.bytes,
        state: 'uploaded',
      };
    },
  };

  const result = await stageProtectedReleaseDraft({
    api,
    assetsDirectory,
    body: protectedBody,
    name: protectedName,
    prerelease: true,
    repository: protectedRepository,
    tag: protectedTag,
    targetCommitish: protectedRef,
  });

  assert.deepEqual(result, {
    assetNames: Object.keys(protectedFixtureContents).sort(),
    releaseId: 734,
    resumed: true,
  });
  assert.deepEqual(
    calls.filter((call) => call.type === 'upload'),
    [
      {
        endpoint: `https://uploads.github.com/repos/${protectedRepository}/releases/734/assets`,
        name: expectedAssets[1].name,
        type: 'upload',
      },
    ],
  );
  assert.equal(
    calls.some((call) => call.type === 'create'),
    false,
  );
});

test('protected draft retry is idempotent when the exact asset set is complete', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const release = protectedRelease({ assets: protectedReleaseAssets() });
  let getCount = 0;
  let listCount = 0;
  const result = await stageProtectedReleaseDraft({
    api: {
      createDraft: async () => {
        throw new Error('must not create');
      },
      getRelease: async () => {
        getCount += 1;
        return release;
      },
      listReleases: async () => {
        listCount += 1;
        return [release];
      },
      uploadAsset: async () => {
        throw new Error('must not upload');
      },
    },
    assetsDirectory,
    body: protectedBody,
    name: protectedName,
    prerelease: true,
    repository: protectedRepository,
    tag: protectedTag,
    targetCommitish: protectedRef,
  });

  assert.equal(result.releaseId, 734);
  assert.equal(result.resumed, true);
  assert.equal(getCount, 2);
  assert.equal(listCount, 2);
});

test('protected draft retry rejects duplicate exact-tag records before mutation', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const calls = [];
  await assert.rejects(
    stageProtectedReleaseDraft({
      api: {
        createDraft: async () => calls.push('create'),
        getRelease: async () => calls.push('get'),
        listReleases: async () => [
          protectedRelease(),
          protectedRelease({ id: 735 }),
        ],
        uploadAsset: async () => calls.push('upload'),
      },
      assetsDirectory,
      body: protectedBody,
      name: protectedName,
      prerelease: true,
      repository: protectedRepository,
      tag: protectedTag,
      targetCommitish: protectedRef,
    }),
    /2 GitHub Release record\(s\) already use this tag/,
  );
  assert.deepEqual(calls, []);
});

test('protected draft retry rejects identity and asset drift without mutation', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const exactAssets = protectedReleaseAssets();
  const driftCases = [
    {
      error: /exact protected draft identity/,
      release: protectedRelease({ body: 'different notes' }),
    },
    {
      error: /exact protected draft identity/,
      release: protectedRelease({ name: 'Different release' }),
    },
    {
      error: /exact protected draft identity/,
      release: protectedRelease({ targetCommitish: 'b'.repeat(40) }),
    },
    {
      error: /exact protected draft identity/,
      release: protectedRelease({ prerelease: false }),
    },
    {
      error: /unexpected asset/,
      release: protectedRelease({
        assets: [
          ...exactAssets,
          {
            digest: `sha256:${'f'.repeat(64)}`,
            id: 990,
            name: 'unmanifested.bin',
            size: 12,
            state: 'uploaded',
          },
        ],
      }),
    },
    {
      error: /does not match the staged file/,
      release: protectedRelease({
        assets: [{ ...exactAssets[0], size: exactAssets[0].size + 1 }],
      }),
    },
    {
      error: /digest does not match/,
      release: protectedRelease({
        assets: [{ ...exactAssets[0], digest: `sha256:${'f'.repeat(64)}` }],
      }),
    },
    {
      error: /missing its SHA-256 digest/,
      release: protectedRelease({
        assets: [{ ...exactAssets[0], digest: null }],
      }),
    },
    {
      error: /not a complete non-empty upload/,
      release: protectedRelease({
        assets: [{ ...exactAssets[0], state: 'new' }],
      }),
    },
    {
      error: /duplicate asset names/,
      release: protectedRelease({
        assets: [exactAssets[0], { ...exactAssets[0], id: 991 }],
      }),
    },
  ];

  for (const { error, release } of driftCases) {
    const mutations = [];
    await assert.rejects(
      stageProtectedReleaseDraft({
        api: {
          createDraft: async () => mutations.push('create'),
          getRelease: async () => mutations.push('get'),
          listReleases: async () => [release],
          uploadAsset: async () => mutations.push('upload'),
        },
        assetsDirectory,
        body: protectedBody,
        name: protectedName,
        prerelease: true,
        repository: protectedRepository,
        tag: protectedTag,
        targetCommitish: protectedRef,
      }),
      error,
    );
    assert.deepEqual(mutations, []);
  }
});

test('protected draft uploads only through the returned exact release ID and never mutates', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const expectedAssets = protectedReleaseAssets();
  const exactRelease = protectedRelease({ assets: expectedAssets });
  const calls = [];
  let listCount = 0;
  let nextAssetId = 900;
  const api = {
    createDraft: async (input) => {
      calls.push({ input, type: 'create' });
      return protectedRelease();
    },
    deleteRelease: async (...args) => calls.push({ args, type: 'delete' }),
    getRelease: async (...args) => {
      calls.push({ args, type: 'get' });
      return exactRelease;
    },
    listReleases: async (...args) => {
      calls.push({ args, type: 'list' });
      listCount += 1;
      return listCount === 1 ? [] : [exactRelease];
    },
    uploadAsset: async ({ asset, uploadEndpoint }) => {
      calls.push({
        endpoint: uploadEndpoint.href,
        name: asset.name,
        type: 'upload',
      });
      nextAssetId += 1;
      return {
        digest: `sha256:${asset.sha256}`,
        id: nextAssetId,
        name: asset.name,
        size: asset.bytes,
        state: 'uploaded',
      };
    },
  };

  const result = await stageProtectedReleaseDraft({
    api,
    assetsDirectory,
    body: 'Release notes',
    name: 'Clodex Agentic IDE 1.16.0-preview.2',
    prerelease: true,
    repository: protectedRepository,
    tag: protectedTag,
    targetCommitish: protectedRef,
  });

  assert.equal(result.releaseId, 734);
  const createCall = calls.find((call) => call.type === 'create');
  assert.equal(createCall.input.targetCommitish, protectedRef);
  assert.equal(createCall.input.tag, protectedTag);
  const uploads = calls.filter((call) => call.type === 'upload');
  assert.equal(uploads.length, 2);
  assert.deepEqual(
    new Set(uploads.map((call) => call.endpoint)),
    new Set([
      `https://uploads.github.com/repos/${protectedRepository}/releases/734/assets`,
    ]),
  );
  assert.equal(
    calls.some((call) => call.type === 'delete'),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'update'),
    false,
  );
  assert.throws(
    () =>
      exactUploadEndpoint({
        releaseId: 734,
        repository: protectedRepository,
        uploadUrl: `https://uploads.github.com/repos/${protectedRepository}/releases/735/assets{?name,label}`,
      }),
    /not bound to the exact release ID/,
  );
});

test('GitHub asset transport posts binary data only to the exact-ID upload URL', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const filePath = join(assetsDirectory, 'clodex-preview.zip');
  const calls = [];
  const api = new GitHubReleaseApi({
    fetchImpl: async (url, request) => {
      calls.push({
        contentLength: request.headers['Content-Length'],
        method: request.method,
        url: String(url),
      });
      request.body.destroy();
      return new Response(
        JSON.stringify({
          id: 901,
          name: 'clodex-preview.zip',
          size: 13,
          state: 'uploaded',
        }),
        { status: 201 },
      );
    },
    token: 'test-token',
  });
  await api.uploadAsset({
    asset: {
      bytes: 13,
      filePath,
      name: 'clodex-preview.zip',
    },
    uploadEndpoint: new URL(
      `https://uploads.github.com/repos/${protectedRepository}/releases/734/assets`,
    ),
  });
  assert.deepEqual(calls, [
    {
      contentLength: '13',
      method: 'POST',
      url: `https://uploads.github.com/repos/${protectedRepository}/releases/734/assets?name=clodex-preview.zip`,
    },
  ]);
});

test('protected draft leaves its exact ID untouched after a concurrent duplicate', async (t) => {
  const assetsDirectory = await protectedAssetsFixture(t);
  const expectedAssets = protectedReleaseAssets();
  const exactRelease = protectedRelease({ assets: expectedAssets });
  let listCount = 0;
  const cleanupMutations = [];
  const api = {
    createDraft: async () => protectedRelease(),
    deleteRelease: async (repository, releaseId) => {
      cleanupMutations.push({ releaseId, repository, type: 'delete' });
    },
    getRelease: async () => exactRelease,
    listReleases: async () => {
      listCount += 1;
      return listCount === 1
        ? []
        : [exactRelease, protectedRelease({ draft: false, id: 999 })];
    },
    uploadAsset: async ({ asset }) => ({
      id: 900,
      name: asset.name,
      size: asset.bytes,
      state: 'uploaded',
    }),
    updateRelease: async (repository, releaseId) => {
      cleanupMutations.push({ releaseId, repository, type: 'update' });
    },
  };

  await assert.rejects(
    stageProtectedReleaseDraft({
      api,
      assetsDirectory,
      body: 'Release notes',
      name: 'Clodex Agentic IDE 1.16.0-preview.2',
      prerelease: true,
      repository: protectedRepository,
      tag: protectedTag,
      targetCommitish: protectedRef,
    }),
    /concurrent duplicate or public.*GitHub Release ID 734.*left untouched.*protected orphan.*manual protected inspection/,
  );
  assert.deepEqual(cleanupMutations, []);
});

test('protected publisher structurally forbids automatic release deletion', () => {
  const protectedPublisher = readFileSync(
    new URL(
      'scripts/release/create-protected-release-draft.mjs',
      repositoryRoot,
    ),
    'utf8',
  );
  const workflow = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  const protectedReleaseSection = workflow
    .split('Create a new isolated protected draft by exact release ID')[1]
    .split('Finalize exact non-trusted prerelease after complete draft upload')[0];

  assert.doesNotMatch(
    protectedPublisher,
    /\bdeleteRelease\b|method\s*:\s*['"]DELETE['"]|--method\s+DELETE/i,
  );
  assert.doesNotMatch(
    protectedReleaseSection,
    /\bdeleteRelease\b|method\s*:\s*['"]DELETE['"]|--method\s+DELETE/i,
  );
});

test('release workflows distinguish resumable drafts from immutable publication', () => {
  const previewWorkflow = readFileSync(
    new URL('.github/workflows/technical-preview-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(previewWorkflow, /Classify exact preview release retry state/);
  assert.match(previewWorkflow, /github-release-state\.mjs/);
  assert.match(previewWorkflow, /if ! release_state=/);
  assert.match(previewWorkflow, /published\)/);
  assert.match(previewWorkflow, /draft\)/);
  assert.match(previewWorkflow, /verify and resume its exact identity/);
  assert.match(previewWorkflow, /exact-SHA tag retry is allowed/);
  assert.doesNotMatch(previewWorkflow, /gh release view/);

  const autoReleaseWorkflow = readFileSync(
    new URL('.github/workflows/auto-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(autoReleaseWorkflow, /Tag exists without a GitHub Release/);
  assert.match(autoReleaseWorkflow, /github-release-state\.mjs/);
  assert.match(autoReleaseWorkflow, /if ! release_state=/);
  assert.match(autoReleaseWorkflow, /published\)/);
  assert.match(autoReleaseWorkflow, /draft\)/);
  assert.match(
    autoReleaseWorkflow,
    /exact identity verification and safe resume/,
  );
  assert.doesNotMatch(autoReleaseWorkflow, /gh release view/);
});

test('browser release builds and publishes only the immutable input SHA', () => {
  const workflow = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  const buildSection = workflow
    .split('\n  build:')[1]
    .split('\n  release-authorization:')[0];
  const releaseSection = workflow
    .split('\n  release:')[1]
    .split('\n  attest-publication:')[0];
  const stableDraftSection = workflow
    .split('\n  verify-stable-draft:')[1]
    .split('\n  trigger-nightly-after-stable:')[0];
  const postStableSection = workflow.split(
    '\n  trigger-nightly-after-stable:',
  )[1];
  const sourceGate = workflow
    .split('\n  source-gate:')[1]
    .split('\n  promotion-gate:')[0];
  const promotionGate = workflow
    .split('\n  promotion-gate:')[1]
    .split('\n  tag-authorization:')[0];
  const tagAuthorization = workflow
    .split('\n  tag-authorization:')[1]
    .split('\n  tag:')[0];
  const tagSection = workflow.split('\n  tag:')[1].split('\n  build:')[0];
  const releaseAuthorization = workflow
    .split('\n  release-authorization:')[1]
    .split('\n  release-candidate:')[0];
  const releaseCandidate = workflow
    .split('\n  release-candidate:')[1]
    .split('\n  release:')[0];
  const tagEffectSection = tagSection.split(
    'Create exact lightweight tag through GitHub API',
  )[1];
  const protectedDraftEffectSection = releaseSection
    .split('Create a new isolated protected draft by exact release ID')[1]
    .split('Finalize exact non-trusted prerelease after complete draft upload')[0];

  assert.match(workflow, /Immutable 40-character commit SHA/);
  assert.match(workflow, /Validate immutable canonical-main inputs/);
  assert.match(
    sourceGate,
    /permissions:\n\s+attestations: read\n\s+contents: read/,
  );
  assert.match(sourceGate, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(sourceGate, /remote_main=.*refs\/heads\/main/);
  assert.doesNotMatch(sourceGate, /contents: write|id-token: write|secrets\./);
  assert.match(
    promotionGate,
    /Audit the exact release dependency graph before release effects/,
  );
  assert.match(
    promotionGate,
    /Reverify live promotion authorization after protected approval/,
  );
  assert.match(
    promotionGate,
    /EXPECTED_RELEASE_PLAN_SHA256[\s\S]*verify-release-promotion\.mjs/,
  );
  assert.match(promotionGate, /pnpm security:dependencies/);
  assert.match(buildSection, /needs: \[source-gate, promotion-gate\]/);
  assert.match(buildSection, /permissions:\n\s+contents: read/);
  assert.match(buildSection, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(buildSection, /persist-credentials: false/);
  assert.doesNotMatch(buildSection, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(buildSection, /Assert immutable release candidate checkout/);
  assert.match(
    tagAuthorization,
    /needs: \[source-gate, promotion-gate, build\]/,
  );
  assert.match(
    tagAuthorization,
    /permissions:\n\s+attestations: read\n\s+contents: read/,
  );
  assert.match(tagAuthorization, /verify-release-promotion\.mjs/);
  assert.match(tagAuthorization, /-u GITHUB_OUTPUT/);
  assert.match(tagAuthorization, /environment: Release/);
  assert.match(tagAuthorization, /run_attempt=\$GITHUB_RUN_ATTEMPT/);
  assert.match(tagAuthorization, /run_id=\$GITHUB_RUN_ID/);
  assert.match(tagSection, /needs: \[source-gate, build, tag-authorization\]/);
  assert.match(tagSection, /Create exact lightweight tag through GitHub API/);
  assert.match(tagSection, /AUTHORIZED_RELEASE_PLAN_SHA256/);
  assert.doesNotMatch(tagSection, /environment: Release/);
  assert.doesNotMatch(tagSection, /verify-release-promotion\.mjs/);
  assert.doesNotMatch(tagEffectSection, /verify-release-promotion\.mjs/);
  assert.match(tagEffectSection, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(tagEffectSection, /AUTHORIZED_RUN_ATTEMPT/);
  assert.match(tagEffectSection, /AUTHORIZED_RUN_ID/);
  assert.match(releaseAuthorization, /needs: \[source-gate, tag, build\]/);
  assert.match(
    releaseAuthorization,
    /permissions:\n\s+attestations: read\n\s+contents: read/,
  );
  assert.match(releaseAuthorization, /verify-release-promotion\.mjs/);
  assert.match(releaseAuthorization, /-u GITHUB_OUTPUT/);
  assert.match(releaseAuthorization, /environment: Release/);
  assert.match(releaseAuthorization, /run_attempt=\$GITHUB_RUN_ATTEMPT/);
  assert.match(releaseAuthorization, /run_id=\$GITHUB_RUN_ID/);
  assert.match(
    releaseCandidate,
    /needs: \[source-gate, tag, build, release-authorization\]/,
  );
  assert.match(
    releaseCandidate,
    /Re-assert immutable tag target before publication/,
  );
  assert.match(releaseCandidate, /Canonical main moved before publication/);
  assert.match(releaseCandidate, /release-publication\.mjs/);
  assert.match(releaseCandidate, /Build exact release candidate handoff/);
  assert.match(releaseCandidate, /Upload exact release candidate handoff/);
  assert.match(releaseCandidate, /workflowRunAttempt/);
  assert.match(releaseCandidate, /workflowRunId/);
  assert.match(
    releaseCandidate,
    /permissions:\n\s+actions: read\n\s+contents: read/,
  );
  assert.doesNotMatch(releaseCandidate, /contents: write/);
  assert.match(
    releaseSection,
    /needs: \[source-gate, tag, release-authorization, release-candidate\]/,
  );
  assert.match(releaseSection, /actions: read\n\s+contents: write/);
  assert.doesNotMatch(releaseSection, /environment: Release/);
  assert.doesNotMatch(releaseSection, /verify-release-promotion\.mjs/);
  assert.doesNotMatch(releaseSection, /release-publication\.mjs/);
  assert.match(
    releaseSection,
    /Verify exact release candidate handoff without repository code/,
  );
  assert.match(
    releaseSection,
    /Reject stale authorization or candidate attempts/,
  );
  assert.match(releaseSection, /manifest\.workflowRunAttempt/);
  assert.match(releaseSection, /manifest\.workflowRunId/);
  assert.match(
    releaseSection,
    /Reauthorize exact write target before publication/,
  );
  assert.match(releaseSection, /AUTHORIZED_REF/);
  assert.match(releaseSection, /remote_main=.*refs\/heads\/main/);
  assert.match(releaseSection, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.ok(
    releaseSection.indexOf(
      'Reauthorize exact write target before publication',
    ) <
      releaseSection.indexOf(
        'Finalize exact non-trusted prerelease after complete draft upload',
      ),
  );
  assert.match(releaseSection, /artifact-ids:/);
  assert.match(releaseSection, /terminal_tag_commit/);
  assert.match(releaseSection, /create-protected-release-draft\.mjs/);
  assert.match(
    releaseSection,
    /git show "\$\{RELEASE_REF\}:scripts\/release\/create-protected-release-draft\.mjs"/,
  );
  assert.match(releaseSection, /--github-output="\$publisher_output"/);
  assert.match(releaseSection, /-u GITHUB_OUTPUT/);
  assert.doesNotMatch(
    protectedDraftEffectSection,
    /verify-release-promotion\.mjs/,
  );
  assert.match(
    protectedDraftEffectSection,
    /GH_TOKEN: \$\{\{ github\.token \}\}/,
  );
  assert.match(protectedDraftEffectSection, /RELEASE_ASSETS_DIRECTORY/);
  const publicReleaseSection = releaseSection
    .split('Finalize exact non-trusted prerelease after complete draft upload')[1]
    .split('Query and assert exact live release state')[0];
  assert.doesNotMatch(publicReleaseSection, /softprops\/action-gh-release@/);
  assert.match(
    publicReleaseSection,
    /if: needs\.source-gate\.outputs\.trusted_promotion != 'true' && inputs\.draft == false/,
  );
  assert.match(publicReleaseSection, /alpha\|beta\|nightly/);
  assert.match(publicReleaseSection, /"draft":false/);
  assert.match(publicReleaseSection, /"prerelease":true/);
  assert.match(publicReleaseSection, /"make_latest":"false"/);
  assert.match(
    publicReleaseSection,
    /vars\.GITHUB_IMMUTABLE_RELEASES_ENABLED/,
  );
  assert.match(
    publicReleaseSection,
    /Set repository variable GITHUB_IMMUTABLE_RELEASES_ENABLED=true/,
  );
  assert.match(publicReleaseSection, /X-GitHub-Api-Version: 2026-03-10/);
  assert.match(publicReleaseSection, /gh api --include/);
  assert.match(publicReleaseSection, /If-Match: \$\{etag\}/);
  assert.match(publicReleaseSection, /release\.target_commitish/);
  assert.match(publicReleaseSection, /release\.name/);
  assert.match(publicReleaseSection, /release\.body/);
  assert.match(publicReleaseSection, /release\.immutable !== true/);
  assert.match(publicReleaseSection, /patch_status=0/);
  assert.match(publicReleaseSection, /recovered the exact published prerelease/);
  assert.match(
    publicReleaseSection,
    /releases\/\$\{RELEASE_ID\}[\s\S]*--input/,
  );
  assert.ok(
    publicReleaseSection.indexOf('gh api --include') <
      publicReleaseSection.indexOf('gh api --method PATCH'),
  );
  assert.ok(
    publicReleaseSection.indexOf('GitHub Release assets differ') <
      publicReleaseSection.indexOf('gh api --method PATCH'),
  );
  assert.match(
    releaseSection,
    /RELEASE_ID: \$\{\{ steps\.protected-draft\.outputs\.release_id \}\}/,
  );
  assert.doesNotMatch(
    releaseSection
      .split('Create a new isolated protected draft')[1]
      .split('Finalize exact non-trusted prerelease after complete draft upload')[0],
    /softprops\/action-gh-release/,
  );
  assert.match(releaseSection, /release-candidate\/manifest\.json/);
  assert.match(
    releaseSection,
    /asset\.digest !== `sha256:\$\{expected\.sha256\}`/,
  );
  assert.match(releaseSection, /release\.immutable !== false/);
  assert.match(releaseSection, /release\.immutable !== true/);
  assert.match(releaseSection, /release\.url !== expectedApiUrl/);
  assert.match(releaseSection, /releases\/\$\{RELEASE_ID\}/);
  assert.doesNotMatch(releaseSection, /releases\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(
    stableDraftSection,
    /needs: \[source-gate, release, attest-publication\]/,
  );
  assert.match(stableDraftSection, /--expected-release-state=draft/);
  assert.match(stableDraftSection, /gh attestation verify/);
  assert.match(stableDraftSection, /artifact-ids:/);
  assert.match(stableDraftSection, /publication-snapshot\.json/);
  assert.match(stableDraftSection, /actual_sha256.*EXPECTED_SHA256/s);
  assert.match(stableDraftSection, /cmp[\s\S]*attested-publication/);
  assert.match(stableDraftSection, /contents: read/);
  assert.doesNotMatch(stableDraftSection, /contents: write/);
  assert.doesNotMatch(stableDraftSection, /gh api --method PATCH/);
  assert.doesNotMatch(workflow, /draft=false/);
  assert.doesNotMatch(workflow, /--expected-release-state=published/);
  assert.doesNotMatch(workflow, /\n {2}publish-stable:/);
  assert.match(stableDraftSection, /Stable publication is NOT_READY/);
  assert.match(stableDraftSection, /exit 1/);
  assert.match(postStableSection, /needs: verify-stable-draft/);
  assert.ok(
    stableDraftSection.indexOf('--expected-release-state=draft') <
      stableDraftSection.indexOf('Stable publication is NOT_READY'),
  );

  const nightlyWorkflow = readFileSync(
    new URL('.github/workflows/nightly-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(nightlyWorkflow, /release_ref=\$\(git rev-parse HEAD\)/);
  assert.match(
    nightlyWorkflow,
    /ref: \$\{\{ needs\.version\.outputs\.release_ref \}\}/,
  );
});

test('technical preview workflow stages protected drafts from schema-v2 plans', () => {
  const workflow = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  const previewWorkflow = readFileSync(
    new URL('.github/workflows/technical-preview-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(
    workflow,
    /Verify manifest, trusted evidence, and live prerequisite chain/,
  );
  assert.match(workflow, /verify-release-promotion\.mjs/);
  assert.match(
    workflow,
    /Release draft input differs from the committed manifest/,
  );
  assert.match(workflow, /clodex-release-publication\.json/);
  assert.match(
    workflow,
    /uses: \.\/\.github\/workflows\/release-publication-attestation\.yml/,
  );
  assert.doesNotMatch(workflow, /release-publication-attestation\.yml@main/);
  assert.match(workflow, /create-protected-release-draft\.mjs/);
  assert.doesNotMatch(
    workflow
      .split('Create a new isolated protected draft by exact release ID')[1]
      .split(
        'Finalize exact non-trusted prerelease after complete draft upload',
      )[0],
    /\n\s+if:/,
  );
  assert.match(workflow, /--target-commitish="\$RELEASE_REF"/);
  assert.match(workflow, /environment: Release/);
  assert.match(previewWorkflow, /--require-new-tag=true/);
  assert.match(previewWorkflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(previewWorkflow, /persist-credentials: false/);
  assert.match(
    previewWorkflow,
    /draft: \$\{\{ needs\.preflight\.outputs\.release_draft == 'true' \}\}/,
  );
});

test('trusted release evidence is attested and verified with exact workflow digests', () => {
  const publication = readFileSync(
    new URL(
      '.github/workflows/release-publication-attestation.yml',
      repositoryRoot,
    ),
    'utf8',
  );
  const acceptance = readFileSync(
    new URL(
      '.github/workflows/release-acceptance-evidence.yml',
      repositoryRoot,
    ),
    'utf8',
  );
  for (const workflow of [publication, acceptance]) {
    assert.match(
      workflow,
      /actions\/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373/,
    );
    assert.match(workflow, /environment: Release/);
    assert.match(workflow, /persist-credentials: false/);
  }
  assert.match(publication, /--expected-workflow-run-id="\$\{GITHUB_RUN_ID\}"/);
  assert.match(
    publication,
    /--expected-run-attempt="\$\{GITHUB_RUN_ATTEMPT\}"/,
  );
  assert.match(
    publication,
    /--expected-source-commit="\$\{RELEASE_SOURCE_COMMIT\}"/,
  );
  assert.match(publication, /--expected-tag="\$\{RELEASE_TAG\}"/);
  assert.match(publication, /--expected-release-state=draft/);
  assert.match(publication, /snapshot_artifact_id/);
  assert.match(publication, /snapshot_sha256/);
  assert.ok(
    (publication.match(/actions\/attest-build-provenance@/g) ?? []).length >= 2,
  );
  const publicationCollect = publication
    .split('\n  collect:')[1]
    .split('\n  attest:')[0];
  const publicationAttest = publication.split('\n  attest:')[1];
  assert.match(publicationCollect, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(
    publicationCollect,
    /attestations: write|id-token: write|actions\/attest-build-provenance/,
  );
  assert.match(publicationCollect, /verify-release-publication\.mjs/);
  assert.match(publicationCollect, /-u ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.match(publicationCollect, /-u GITHUB_OUTPUT/);
  assert.match(publicationAttest, /actions: read/);
  assert.match(publicationAttest, /attestations: write/);
  assert.match(publicationAttest, /id-token: write/);
  assert.match(publicationAttest, /artifact-ids:/);
  assert.match(publicationAttest, /actual_sha256|snapshot_sha256/);
  assert.match(publicationAttest, /expectedBuilds/);
  assert.match(publicationAttest, /expectedChecks/);
  assert.match(publicationAttest, /report\.releasePlan/);
  assert.match(publicationAttest, /releases\/\$\{expectedReleaseId\}/);
  assert.match(publicationAttest, /application\/octet-stream/);
  assert.match(publicationAttest, /derivedSnapshot/);
  assert.match(publicationAttest, /canonical main moved during attestation/);
  assert.doesNotMatch(
    publicationAttest,
    /actions\/checkout|verify-release-publication\.mjs|scripts\/release\//,
  );
  assert.match(acceptance, /--source-digest "\$source_commit"/);
  assert.match(acceptance, /--signer-digest "\$workflow_commit"/);
  assert.match(acceptance, /--deny-self-hosted-runners/);
  assert.match(acceptance, /playwright install --with-deps chromium/);
  const collectJob = acceptance
    .split('\n  collect:')[1]
    .split('\n  attest:')[0];
  const attestJob = acceptance.split('\n  attest:')[1];
  assert.match(
    collectJob,
    /permissions:\n\s+attestations: read\n\s+contents: read/,
  );
  assert.doesNotMatch(
    collectJob,
    /attestations: write|id-token: write|actions\/attest-build-provenance/,
  );
  assert.match(collectJob, /pnpm install --frozen-lockfile/);
  assert.match(collectJob, /collect-trusted-source-checks\.ts/);
  const productCheckStep = collectJob
    .split('Run real source and product acceptance checks')[1]
    .split('Generate canonical rollback-baseline evidence candidate')[0];
  assert.doesNotMatch(productCheckStep, /GH_TOKEN|GITHUB_TOKEN/);
  assert.match(productCheckStep, /--publication-snapshot=/);
  assert.doesNotMatch(
    collectJob,
    /git checkout --detach "\$\{\{ steps\.publication\.outputs|--source-commit="\$\{\{ steps\.publication\.outputs/,
  );
  assert.match(attestJob, /actions: read/);
  assert.match(attestJob, /attestations: write/);
  assert.match(attestJob, /id-token: write/);
  assert.match(attestJob, /artifact-ids:/);
  assert.match(attestJob, /actual_sha256.*EXPECTED_SHA256/s);
  assert.match(attestJob, /requiredCheckIds/);
  assert.match(attestJob, /const hasExactKeys/);
  assert.match(attestJob, /hasExactKeys\(evidence, \[/);
  assert.match(attestJob, /hasExactKeys\(evidence\.inputs/);
  assert.match(attestJob, /evidence\.schemaVersion !== 4/);
  assert.match(attestJob, /canary\.observationEvidence !== null/);
  assert.match(attestJob, /subject_bytes.*1048576/s);
  assert.doesNotMatch(
    attestJob,
    /actions\/checkout|pnpm install|pnpm build|playwright|collect-trusted-source-checks/,
  );
  assert.doesNotMatch(acceptance, /canary_metrics_json|--canary=/);

  const verifier = readFileSync(
    new URL('scripts/release/verify-release-promotion.mjs', repositoryRoot),
    'utf8',
  );
  assert.match(verifier, /--source-digest/);
  assert.match(verifier, /--signer-digest/);
  assert.match(verifier, /--deny-self-hosted-runners/);
  assert.match(verifier, /const tagRef = `refs\/tags\/\$\{tag\}`/);
  assert.match(verifier, /\$\{tagRef\}\^\{commit\}/);
  assert.match(verifier, /TRUSTED_CANARY_OBSERVATION_STATUS = 'NOT_READY'/);
  assert.match(verifier, /stable promotion is NOT_READY/);

  const collector = readFileSync(
    new URL(
      'scripts/release/collect-trusted-release-evidence.mjs',
      repositoryRoot,
    ),
    'utf8',
  );
  assert.match(collector, /stable promotion is NOT_READY/);
  assert.match(collector, /schemaVersion: 4/);
  assert.match(collector, /observationEvidence: null/);
  assert.doesNotMatch(collector, /canary metrics are required/);
});

test('preview.2 documentation rejects preview.1 as a trusted target', () => {
  const plan = readFileSync(
    new URL('docs/releases/v1.16.0-preview.2.md', repositoryRoot),
    'utf8',
  );
  assert.match(plan, /rollback target tag: \*\*none\*\*/i);
  assert.match(plan, /preview\.1.*not trusted/is);
  assert.match(plan, /distribution-stop-only/i);
});

test('website exposes no legacy preview.1 download URL', () => {
  for (const file of [
    'apps/website/src/app/download/page.tsx',
    'apps/website/src/app/(home)/_components/download-buttons.tsx',
    'apps/website/src/lib/community-release.ts',
  ]) {
    const source = readFileSync(new URL(file, repositoryRoot), 'utf8');
    assert.doesNotMatch(source, /preview\.1|preview\.1-windows-x64/i);
  }

  const manifest = readFileSync(
    new URL('apps/website/src/lib/community-release.ts', repositoryRoot),
    'utf8',
  );
  assert.match(manifest, /status:\s*'pending-verification'/u);
  assert.match(manifest, /downloads:\s*\[\]/u);
  assert.doesNotMatch(manifest, /releases\/download/u);

  const downloadPage = readFileSync(
    new URL('apps/website/src/app/download/page.tsx', repositoryRoot),
    'utf8',
  );
  assert.match(downloadPage, /COMMUNITY_RELEASE\.status === 'verified'/u);
  assert.match(downloadPage, /COMMUNITY_RELEASE\.downloads\.length > 0/u);
});

test('Squirrel packaging binds public and internal preview versions explicitly', () => {
  const plugin = readFileSync(
    new URL(
      'apps/browser/etc/forge-plugins/squirrel-installer-name-fix.ts',
      repositoryRoot,
    ),
    'utf8',
  );
  assert.match(plugin, /toSquirrelInternalVersion/);
  assert.match(plugin, /Unexpected internal nupkg version/);

  const validator = readFileSync(
    new URL(
      'apps/browser/scripts/validate-release-artifacts.mjs',
      repositoryRoot,
    ),
    'utf8',
  );
  assert.match(validator, /toSquirrelInternalVersion\(version\)/);
  assert.match(validator, /squirrelInternalVersion: internalVersion/);
});
