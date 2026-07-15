import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { queryGitHubReleaseState } from './github-release-state.mjs';
import {
  assertReleaseTagReusable,
  sha256Text,
  validateReleasePlan,
} from './release-plan.mjs';

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
      schemaVersion: 3,
      status,
    },
    historicalManifest,
  };
}

test('schema-v2 preview.2 is a draft rollback baseline without a target tag', () => {
  const plan = baselinePlan();
  assert.doesNotThrow(() => validateReleasePlan(plan));
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
  const { evidence, historicalManifest } = acceptedEvidence({
    canary: {
      authFailures: 0,
      distributionClosedAt: '2026-07-14T00:00:00.000Z',
      endedAt: '2026-07-14T00:00:00.000Z',
      observedHours: 24,
      observedInstallations: 5,
      startedAt: '2026-07-13T00:00:00.000Z',
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
      githubReleaseState: 'published',
      publicDownloadLinks: true,
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

function mockedGhResult({ error, httpStatus, status }) {
  return {
    error,
    status,
    stderr:
      httpStatus === undefined ? '' : `gh: mocked failure (HTTP ${httpStatus})`,
    stdout:
      httpStatus === undefined
        ? ''
        : `HTTP/2.0 ${httpStatus} Mocked\nContent-Type: application/json\n\n{}`,
  };
}

test('GitHub release lookup treats only a real HTTP 404 as absent', () => {
  const runGh = () => mockedGhResult({ httpStatus: 404, status: 1 });
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh,
      tag: 'v1.16.0-preview.2',
    }),
    'absent',
  );
});

test('GitHub release lookup accepts an HTTP 200 as existing', () => {
  const runGh = () => mockedGhResult({ httpStatus: 200, status: 0 });
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh,
      tag: 'v1.16.0-preview.2',
    }),
    'exists',
  );
});

test('GitHub release lookup aborts on auth, rate-limit, and server failures', () => {
  for (const httpStatus of [401, 403, 429, 500, 503]) {
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

test('release workflows fail closed when checking completed releases', () => {
  const previewWorkflow = readFileSync(
    new URL('.github/workflows/technical-preview-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(previewWorkflow, /Refuse a completed preview release retry/);
  assert.match(previewWorkflow, /github-release-state\.mjs/);
  assert.match(previewWorkflow, /if ! release_state=/);
  assert.match(previewWorkflow, /exact-SHA tag retry is allowed/);
  assert.doesNotMatch(previewWorkflow, /gh release view/);

  const autoReleaseWorkflow = readFileSync(
    new URL('.github/workflows/auto-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(autoReleaseWorkflow, /Tag exists without a GitHub Release/);
  assert.match(autoReleaseWorkflow, /github-release-state\.mjs/);
  assert.match(autoReleaseWorkflow, /if ! release_state=/);
  assert.doesNotMatch(autoReleaseWorkflow, /gh release view/);
});

test('browser release builds and publishes only the immutable input SHA', () => {
  const workflow = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  const buildSection = workflow.split('\n  build:')[1].split('\n  release:')[0];
  const releaseSection = workflow
    .split('\n  release:')[1]
    .split('\n  attest-publication:')[0];
  const stablePublicationSection = workflow
    .split('\n  publish-stable:')[1]
    .split('\n  trigger-nightly-after-stable:')[0];
  const sourceGate = workflow
    .split('\n  source-gate:')[1]
    .split('\n  promotion-gate:')[0];
  const promotionGate = workflow
    .split('\n  promotion-gate:')[1]
    .split('\n  tag:')[0];

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
    /Audit the exact production lockfile before release effects/,
  );
  assert.match(promotionGate, /pnpm security:dependencies/);
  assert.match(buildSection, /permissions:\n\s+contents: read/);
  assert.match(buildSection, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(buildSection, /persist-credentials: false/);
  assert.doesNotMatch(buildSection, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(buildSection, /Assert immutable release candidate checkout/);
  assert.match(
    releaseSection,
    /Re-assert immutable tag target before publication/,
  );
  assert.match(releaseSection, /Canonical main moved before publication/);
  assert.match(releaseSection, /actual_ref.*RELEASE_REF/s);
  assert.match(
    releaseSection,
    /draft: \$\{\{ needs\.source-gate\.outputs\.trusted_promotion == 'true'.*inputs\.channel == 'release'.*inputs\.draft \}\}/,
  );
  assert.match(
    stablePublicationSection,
    /needs: \[source-gate, release, attest-publication\]/,
  );
  assert.match(stablePublicationSection, /--expected-release-state=draft/);
  assert.match(stablePublicationSection, /gh attestation verify/);
  assert.match(stablePublicationSection, /artifact-ids:/);
  assert.match(stablePublicationSection, /publication-snapshot\.json/);
  assert.match(stablePublicationSection, /actual_sha256.*EXPECTED_SHA256/s);
  assert.match(stablePublicationSection, /cmp[\s\S]*attested-publication/);
  assert.match(stablePublicationSection, /--expected-release-state=published/);
  assert.ok(
    stablePublicationSection.indexOf('--expected-release-state=draft') <
      stablePublicationSection.indexOf('gh api --method PATCH'),
  );
  assert.ok(
    stablePublicationSection.indexOf('gh api --method PATCH') <
      stablePublicationSection.indexOf('--expected-release-state=published'),
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
  assert.match(workflow, /release-publication-attestation\.yml@main/);
  assert.match(
    workflow,
    /draft: \$\{\{ needs\.source-gate\.outputs\.trusted_promotion == 'true'.*inputs\.draft \}\}/,
  );
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
  ]) {
    const source = readFileSync(new URL(file, repositoryRoot), 'utf8');
    assert.doesNotMatch(source, /preview\.1|preview\.1-windows-x64/i);
    assert.match(source, /temporarily unavailable/i);
  }
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
