import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectValidatedReleaseAssets,
  inspectPublicationManifest,
  stageValidatedReleaseAssets,
} from './release-publication.mjs';
import { validatePublicationReport } from '../../../scripts/release/release-trust.mjs';

const SOURCE_COMMIT = '1'.repeat(40);
const RELEASE_PLAN_PATH = '.release-notes/clodex-technical-preview.json';
const RELEASE_PLAN_SHA256 = '2'.repeat(64);
const RELEASE_TAG = 'v1.16.0-preview.2';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeValidationManifest(root, { arch, platform }) {
  const assetName = `clodex-${platform}-${arch}.bin`;
  const assetPath = path.join(root, 'source', assetName);
  const content = Buffer.from(`${platform}:${arch}:validated\n`);
  mkdirSync(path.dirname(assetPath), { recursive: true });
  writeFileSync(assetPath, content);
  const manifestPath = path.join(
    root,
    'manifests',
    `${platform}-${arch}-1.16.0-preview.2.json`,
  );
  const artifact = {
    bytes: content.length,
    path: assetPath,
    sha256: sha256(content),
  };
  writeJson(manifestPath, {
    schemaVersion: 2,
    status: 'passed',
    build: {
      arch,
      channel: 'prerelease',
      platform,
      releasePlanPath: RELEASE_PLAN_PATH,
      releasePlanSha256: RELEASE_PLAN_SHA256,
      sourceCommit: SOURCE_COMMIT,
      tag: RELEASE_TAG,
      version: '1.16.0-preview.2',
    },
    ...(platform === 'macos'
      ? {
          checks: {
            cleanProfileUiLaunch: {
              fatalLines: [],
              startupComplete: true,
              windowShown: true,
            },
            smoke: { exitCode: 0, fatalLines: [], successMarker: true },
          },
          metadata: { icon: { bytes: 128, fileName: 'clodex.icns' } },
          signature: {
            copied: { isAdhoc: false },
            mounted: { isAdhoc: false },
            packaged: { isAdhoc: false },
            requiredMode: 'developer-id',
            zip: { isAdhoc: false },
          },
          trust: {
            applicationGatekeeper: { passed: true },
            applicationStapler: { passed: true },
            copiedApplicationGatekeeper: { passed: true },
            copiedApplicationStapler: { passed: true },
            dmgGatekeeper: { passed: true },
            dmgStapler: { passed: true },
          },
        }
      : platform === 'windows'
        ? {
            checks: {
              packagedExecutableAuthenticode: {
                checked: true,
                passed: true,
                status: 'Valid',
              },
              setupAuthenticode: {
                checked: true,
                passed: true,
                status: 'Valid',
              },
            },
          }
        : { checks: {} }),
    artifacts: [artifact],
    publication: {
      assets: [
        {
          bytes: artifact.bytes,
          fileName: assetName,
          sha256: artifact.sha256,
        },
      ],
      status: 'validated',
    },
  });
  return { assetName, manifestPath };
}

test('stages and collects only exact manifest-bound release assets', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-publication-test.'));
  try {
    const builds = [
      { platform: 'macos', arch: 'arm64' },
      { platform: 'macos', arch: 'x64' },
      { platform: 'linux', arch: 'x64' },
      { platform: 'windows', arch: 'x64' },
    ];
    const assetNames = [];
    for (const build of builds) {
      const fixture = makeValidationManifest(root, build);
      assetNames.push(fixture.assetName);
      await stageValidatedReleaseAssets({
        manifestPath: fixture.manifestPath,
        outputDirectory: path.join(
          root,
          'downloaded',
          `${build.platform}-${build.arch}`,
        ),
        requireTrustedBinding: true,
      });
    }

    const outputDirectory = path.join(root, 'release');
    const reportPath = path.join(root, 'report/release-assets.json');
    const report = await collectValidatedReleaseAssets({
      channel: 'prerelease',
      expectedBuilds: 'macos:arm64,macos:x64,linux:x64,windows:x64',
      inputDirectory: path.join(root, 'downloaded'),
      outputDirectory,
      releasePlanPath: RELEASE_PLAN_PATH,
      releasePlanSha256: RELEASE_PLAN_SHA256,
      repository: 'mereyabdenbekuly-ctrl/clodex-ide',
      reportPath,
      requireTrustedBinding: true,
      runAttempt: 1,
      sourceCommit: SOURCE_COMMIT,
      tag: RELEASE_TAG,
      version: '1.16.0-preview.2',
      workflowCommit: SOURCE_COMMIT,
      workflowRunId: 123,
      workflowSourceRef: 'refs/heads/main',
    });
    assert.equal(report.status, 'validated');
    assert.equal(report.schemaVersion, 2);
    assert.deepEqual(readdirSync(outputDirectory).sort(), assetNames.sort());
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).assets.length, 4);
    assert.deepEqual(
      report.validations.map((validation) => validation.manifestFileName),
      [
        'linux-x64-1.16.0-preview.2.json',
        'macos-arm64-1.16.0-preview.2.json',
        'macos-x64-1.16.0-preview.2.json',
        'windows-x64-1.16.0-preview.2.json',
      ],
    );
    assert.doesNotThrow(() => validatePublicationReport(report));

    writeFileSync(
      path.join(root, 'downloaded/linux-x64/assets/unmanifested.bin'),
      'not validated',
    );
    await assert.rejects(
      collectValidatedReleaseAssets({
        channel: 'prerelease',
        expectedBuilds: 'macos:arm64,macos:x64,linux:x64,windows:x64',
        inputDirectory: path.join(root, 'downloaded'),
        outputDirectory,
        releasePlanPath: RELEASE_PLAN_PATH,
        releasePlanSha256: RELEASE_PLAN_SHA256,
        repository: 'mereyabdenbekuly-ctrl/clodex-ide',
        requireTrustedBinding: true,
        runAttempt: 1,
        sourceCommit: SOURCE_COMMIT,
        tag: RELEASE_TAG,
        version: '1.16.0-preview.2',
        workflowCommit: SOURCE_COMMIT,
        workflowRunId: 123,
        workflowSourceRef: 'refs/heads/main',
      }),
      /do not exactly match the validated manifest/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('rejects a downloaded asset after hash drift', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-publication-test.'));
  try {
    const fixture = makeValidationManifest(root, {
      arch: 'x64',
      platform: 'linux',
    });
    const bundleDirectory = path.join(root, 'downloaded/linux-x64');
    await stageValidatedReleaseAssets({
      manifestPath: fixture.manifestPath,
      outputDirectory: bundleDirectory,
    });
    writeFileSync(
      path.join(bundleDirectory, 'assets', fixture.assetName),
      'tampered but downloaded\n',
    );
    await assert.rejects(
      collectValidatedReleaseAssets({
        channel: 'prerelease',
        expectedBuilds: 'linux:x64',
        inputDirectory: path.join(root, 'downloaded'),
        outputDirectory: path.join(root, 'release'),
        version: '1.16.0-preview.2',
      }),
      /(size|SHA-256) mismatch/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('rejects a trusted validation manifest with a non-normalized release-plan path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-publication-test.'));
  try {
    const fixture = makeValidationManifest(root, {
      arch: 'x64',
      platform: 'linux',
    });
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    manifest.build.releasePlanPath = '.release-notes/../../outside.json';
    writeJson(fixture.manifestPath, manifest);
    assert.throws(
      () =>
        inspectPublicationManifest(fixture.manifestPath, {
          requireTrustedBinding: true,
        }),
      /not source\/plan\/tag bound/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('reads Windows artifact paths on the Linux publication runner', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-publication-test.'));
  try {
    const manifestPath = path.join(root, 'windows-x64.json');
    const hash = sha256('windows artifact');
    writeJson(manifestPath, {
      schemaVersion: 2,
      status: 'passed',
      build: {
        arch: 'x64',
        channel: 'prerelease',
        platform: 'windows',
        version: '1.16.0-preview.2',
      },
      artifacts: [
        {
          bytes: 16,
          path: 'D:\\a\\clodex\\out\\clodex-setup.exe',
          sha256: hash,
        },
      ],
      publication: {
        assets: [
          {
            bytes: 16,
            fileName: 'clodex-setup.exe',
            sha256: hash,
          },
        ],
        status: 'validated',
      },
    });
    assert.equal(
      inspectPublicationManifest(manifestPath).assets[0].fileName,
      'clodex-setup.exe',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
