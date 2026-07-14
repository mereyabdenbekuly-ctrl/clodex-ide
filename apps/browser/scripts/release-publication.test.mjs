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
  const manifestPath = path.join(root, 'manifests', `${platform}-${arch}.json`);
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
      version: '1.16.0-preview.2',
    },
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
      });
    }

    const outputDirectory = path.join(root, 'release');
    const reportPath = path.join(root, 'report/release-assets.json');
    const report = await collectValidatedReleaseAssets({
      channel: 'prerelease',
      expectedBuilds: 'macos:arm64,macos:x64,linux:x64,windows:x64',
      inputDirectory: path.join(root, 'downloaded'),
      outputDirectory,
      reportPath,
      version: '1.16.0-preview.2',
    });
    assert.equal(report.status, 'validated');
    assert.deepEqual(readdirSync(outputDirectory).sort(), assetNames.sort());
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).assets.length, 4);

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
        version: '1.16.0-preview.2',
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
