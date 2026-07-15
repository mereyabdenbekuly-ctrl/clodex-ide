import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TRUSTED_CANARY_OBSERVATION_STATUS,
  expectedPromotionChain,
  requireTrustedCanaryObservation,
} from './verify-release-promotion.mjs';
import {
  ACCEPTANCE_ATTESTATION_WORKFLOW,
  CANONICAL_REPOSITORY,
  EVIDENCE_MAX_AGE_MS,
  REQUIRED_ACCEPTANCE_CHECK_IDS,
  TRUSTED_SOURCE_REF,
  validateLiveReleasePublication,
  validatePublicationReport,
  validateTrustedAcceptanceEvidence,
} from './release-trust.mjs';

const SOURCE_COMMIT = '1'.repeat(40);
const WORKFLOW_COMMIT = SOURCE_COMMIT;
const REPORT_NAME = 'clodex-release-publication.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicationReport(assets) {
  return {
    schemaVersion: 2,
    reportKind: 'release-publication',
    status: 'validated',
    generatedAt: '2026-07-15T00:00:00.000Z',
    repository: CANONICAL_REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    tag: 'v1.16.0-preview.2',
    version: '1.16.0-preview.2',
    channel: 'prerelease',
    releasePlan: {
      path: '.release-notes/clodex-technical-preview.json',
      sha256: '2'.repeat(64),
    },
    workflow: {
      commit: WORKFLOW_COMMIT,
      runAttempt: 1,
      runId: 123,
      sourceRef: TRUSTED_SOURCE_REF,
    },
    builds: ['linux:x64', 'macos:arm64', 'macos:x64', 'windows:x64'],
    validations: [
      ['linux', 'x64'],
      ['macos', 'arm64'],
      ['macos', 'x64'],
      ['windows', 'x64'],
    ].map(([platform, arch], index) => ({
      arch,
      checksSha256: String(index + 3).repeat(64),
      manifestFileName: `${platform}-${arch}-1.16.0-preview.2.json`,
      manifestSha256: String(index + 4).repeat(64),
      platform,
      signatureSha256: platform === 'macos' ? '8'.repeat(64) : null,
      status: 'passed',
      trustSha256: platform === 'macos' ? '9'.repeat(64) : null,
    })),
    acceptanceChecks: [
      'artifact.app-icon',
      'artifact.clean-profile-launch',
      'artifact.packaged-smoke',
      'artifact.validation-manifest',
      'security.distribution-trust',
    ].map((id) => ({
      id,
      reasonCode: 'attested-publication-validation',
      status: 'pass',
    })),
    assets,
  };
}

function makeLiveFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clodex-live-release.'));
  const contents = new Map([
    ['clodex-linux-x64.AppImage', Buffer.from('linux preview')],
    ['clodex-macos-arm64.dmg', Buffer.from('signed arm64 preview dmg')],
    ['clodex-macos-x64.dmg', Buffer.from('signed x64 preview dmg')],
    ['clodex-windows-x64.exe', Buffer.from('signed preview setup')],
    [REPORT_NAME, Buffer.from('aggregate report bytes')],
  ]);
  const identities = new Map([
    ['clodex-linux-x64.AppImage', 'linux:x64'],
    ['clodex-macos-arm64.dmg', 'macos:arm64'],
    ['clodex-macos-x64.dmg', 'macos:x64'],
    ['clodex-windows-x64.exe', 'windows:x64'],
  ]);
  const reportAssets = [];
  const releaseAssets = [];
  let id = 100;
  for (const [fileName, bytes] of contents) {
    writeFileSync(path.join(directory, fileName), bytes);
    const asset = {
      bytes: bytes.length,
      fileName,
      sha256: sha256(bytes),
    };
    if (fileName !== REPORT_NAME) {
      reportAssets.push({ ...asset, identity: identities.get(fileName) });
    }
    releaseAssets.push({
      digest: `sha256:${asset.sha256}`,
      id: id++,
      name: fileName,
      size: bytes.length,
      state: 'uploaded',
    });
  }
  return {
    directory,
    release: {
      assets: releaseAssets,
      created_at: '2026-07-15T00:05:00.000Z',
      draft: true,
      id: 77,
      prerelease: true,
      published_at: null,
      tag_name: 'v1.16.0-preview.2',
    },
    report: publicationReport(reportAssets),
  };
}

test('live publication rejects deleted, empty, extra, and substituted assets', async (t) => {
  const fixture = makeLiveFixture();
  try {
    await assert.doesNotReject(
      validateLiveReleasePublication({
        assetsDirectory: fixture.directory,
        expectedReleaseId: 77,
        now: new Date('2026-07-15T01:00:00.000Z'),
        release: fixture.release,
        report: fixture.report,
        reportFileName: REPORT_NAME,
      }),
    );

    await t.test('deleted asset', async () => {
      await assert.rejects(
        validateLiveReleasePublication({
          assetsDirectory: fixture.directory,
          expectedReleaseId: 77,
          release: {
            ...fixture.release,
            assets: fixture.release.assets.slice(1),
          },
          report: fixture.report,
          reportFileName: REPORT_NAME,
        }),
        /asset set differs/,
      );
    });
    await t.test('empty asset', async () => {
      await assert.rejects(
        validateLiveReleasePublication({
          assetsDirectory: fixture.directory,
          expectedReleaseId: 77,
          release: {
            ...fixture.release,
            assets: fixture.release.assets.map((asset, index) =>
              index === 0 ? { ...asset, size: 0 } : asset,
            ),
          },
          report: fixture.report,
          reportFileName: REPORT_NAME,
        }),
        /metadata is incomplete/,
      );
    });
    await t.test('extra asset', async () => {
      await assert.rejects(
        validateLiveReleasePublication({
          assetsDirectory: fixture.directory,
          expectedReleaseId: 77,
          release: {
            ...fixture.release,
            assets: [
              ...fixture.release.assets,
              {
                digest: `sha256:${'a'.repeat(64)}`,
                id: 999,
                name: 'unexpected.bin',
                size: 1,
                state: 'uploaded',
              },
            ],
          },
          report: fixture.report,
          reportFileName: REPORT_NAME,
        }),
        /asset set differs/,
      );
    });
    await t.test('substituted asset bytes', async () => {
      writeFileSync(
        path.join(fixture.directory, 'clodex-linux-x64.AppImage'),
        'substituted bytes',
      );
      await assert.rejects(
        validateLiveReleasePublication({
          assetsDirectory: fixture.directory,
          expectedReleaseId: 77,
          release: fixture.release,
          report: fixture.report,
          reportFileName: REPORT_NAME,
        }),
        /(size|digest) mismatch/,
      );
    });
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test('stable publication is verified as an attested draft before it becomes public', async () => {
  const fixture = makeLiveFixture();
  try {
    fixture.report = {
      ...fixture.report,
      channel: 'release',
      releasePlan: {
        path: '.release-notes/clodex-stable.json',
        sha256: fixture.report.releasePlan.sha256,
      },
      tag: 'clodex@1.16.0',
      version: '1.16.0',
    };
    fixture.release = {
      ...fixture.release,
      prerelease: false,
      tag_name: 'clodex@1.16.0',
    };

    await assert.doesNotReject(
      validateLiveReleasePublication({
        assetsDirectory: fixture.directory,
        expectedReleaseId: 77,
        expectedReleaseState: 'draft',
        now: new Date('2026-07-15T01:00:00.000Z'),
        release: fixture.release,
        report: fixture.report,
        reportFileName: REPORT_NAME,
      }),
    );
    await assert.rejects(
      validateLiveReleasePublication({
        assetsDirectory: fixture.directory,
        expectedReleaseId: 77,
        now: new Date('2026-07-15T01:00:00.000Z'),
        release: fixture.release,
        report: fixture.report,
        reportFileName: REPORT_NAME,
      }),
      /identity\/state is invalid/,
    );

    await assert.doesNotReject(
      validateLiveReleasePublication({
        assetsDirectory: fixture.directory,
        expectedReleaseId: 77,
        expectedReleaseState: 'published',
        now: new Date('2026-07-15T01:00:00.000Z'),
        release: {
          ...fixture.release,
          draft: false,
          published_at: '2026-07-15T00:10:00.000Z',
        },
        report: fixture.report,
        reportFileName: REPORT_NAME,
      }),
    );
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

function trustedEvidence() {
  const reportSha256 = '8'.repeat(64);
  return {
    schemaVersion: 3,
    evidenceKind: 'release-acceptance',
    status: 'ready-for-stable',
    generatedAt: '2026-07-15T00:00:00.000Z',
    blockers: [],
    checks: REQUIRED_ACCEPTANCE_CHECK_IDS.map((id) => ({
      id,
      reasonCode: 'verified',
      status: 'pass',
    })),
    collector: {
      repository: CANONICAL_REPOSITORY,
      runAttempt: 1,
      runId: 456,
      sourceCommit: '3'.repeat(40),
      sourceRef: TRUSTED_SOURCE_REF,
      workflow: ACCEPTANCE_ATTESTATION_WORKFLOW,
      workflowCommit: '3'.repeat(40),
    },
    manifest: {
      path: '.release-notes/clodex-technical-preview.json',
      sha256: '2'.repeat(64),
      sourceCommit: SOURCE_COMMIT,
    },
    publication: {
      assets: [
        {
          bytes: 12,
          fileName: 'clodex-preview.dmg',
          releaseAssetId: 100,
          sha256: '7'.repeat(64),
        },
        {
          bytes: 13,
          fileName: REPORT_NAME,
          releaseAssetId: 101,
          sha256: reportSha256,
        },
      ],
      createdAt: '2026-07-13T00:00:00.000Z',
      releaseId: 77,
      reportAssetId: 101,
      reportFileName: REPORT_NAME,
      reportSha256,
      repository: CANONICAL_REPOSITORY,
      sourceCommit: SOURCE_COMMIT,
      tag: 'v1.16.0-preview.3',
    },
    release: {
      channel: 'preview',
      promotionRole: 'canary',
      tag: 'v1.16.0-preview.3',
      version: '1.16.0-preview.3',
    },
    rollback: {
      mode: 'distribution-stop-only',
      targetTag: 'v1.16.0-preview.2',
    },
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
  };
}

test('trusted acceptance rejects stale/open/pre-release/auth-failure canaries', () => {
  const now = new Date('2026-07-15T01:00:00.000Z');
  assert.doesNotThrow(() =>
    validateTrustedAcceptanceEvidence(trustedEvidence(), { now }),
  );

  const stale = trustedEvidence();
  stale.generatedAt = new Date(
    now.getTime() - EVIDENCE_MAX_AGE_MS - 1,
  ).toISOString();
  assert.throws(
    () => validateTrustedAcceptanceEvidence(stale, { now }),
    /evidence is stale/,
  );

  const earlyStart = trustedEvidence();
  earlyStart.canary.startedAt = '2026-07-12T23:59:59.000Z';
  earlyStart.canary.observedHours = 24.000_277_777_8;
  assert.throws(
    () => validateTrustedAcceptanceEvidence(earlyStart, { now }),
    /started before the real release/,
  );

  const open = trustedEvidence();
  open.canary.endedAt = null;
  assert.throws(
    () => validateTrustedAcceptanceEvidence(open, { now }),
    /endedAt is invalid/,
  );

  const notClosed = trustedEvidence();
  notClosed.canary.distributionClosedAt = null;
  assert.throws(
    () => validateTrustedAcceptanceEvidence(notClosed, { now }),
    /distributionClosedAt is invalid/,
  );

  const authFailure = trustedEvidence();
  authFailure.canary.authFailures = 1;
  assert.throws(
    () => validateTrustedAcceptanceEvidence(authFailure, { now }),
    /zero-failure policy/,
  );
});

test('stable promotion stays fail-closed without a trusted canary observation verifier', () => {
  assert.equal(TRUSTED_CANARY_OBSERVATION_STATUS, 'NOT_READY');
  assert.throws(
    () => requireTrustedCanaryObservation(trustedEvidence()),
    /stable promotion is NOT_READY.*trusted.*canary observation/,
  );
  assert.doesNotThrow(() =>
    requireTrustedCanaryObservation({
      status: 'ready-as-rollback-baseline',
    }),
  );
});

test('publication and stable plans bind exact trusted workflow and full chain', () => {
  const report = publicationReport([
    {
      bytes: 10,
      fileName: 'clodex-linux-x64.AppImage',
      identity: 'linux:x64',
      sha256: '7'.repeat(64),
    },
    {
      bytes: 11,
      fileName: 'clodex-macos-arm64.dmg',
      identity: 'macos:arm64',
      sha256: '6'.repeat(64),
    },
    {
      bytes: 12,
      fileName: 'clodex-macos-x64.dmg',
      identity: 'macos:x64',
      sha256: '5'.repeat(64),
    },
    {
      bytes: 13,
      fileName: 'clodex-windows-x64.exe',
      identity: 'windows:x64',
      sha256: '4'.repeat(64),
    },
  ]);
  assert.doesNotThrow(() => validatePublicationReport(report));
  assert.throws(
    () =>
      validatePublicationReport({
        ...report,
        workflow: { ...report.workflow, commit: '4'.repeat(40) },
      }),
    /workflow binding is invalid/,
  );
  assert.throws(
    () =>
      validatePublicationReport({
        ...report,
        releasePlan: {
          ...report.releasePlan,
          path: '.release-notes/../../outside.json',
        },
      }),
    /release-plan binding is invalid/,
  );
  assert.deepEqual(
    expectedPromotionChain({
      promotionEvidence: '.release-evidence/v1.16.0-preview.3.json',
      releaseKind: 'stable',
      version: '1.16.0',
    }),
    ['v1.16.0-preview.3', 'v1.16.0-preview.2'],
  );
});
