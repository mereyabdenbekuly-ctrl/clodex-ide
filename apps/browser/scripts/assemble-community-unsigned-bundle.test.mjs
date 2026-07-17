import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assembleCommunityUnsignedBundle,
  COMMUNITY_OBSERVED_MANIFEST_FILE,
  COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
  COMMUNITY_OBSERVED_WARNING_FILE,
  COMMUNITY_UNSIGNED_CHECKSUMS_FILE,
  COMMUNITY_UNSIGNED_MANIFEST_FILE,
  COMMUNITY_UNSIGNED_WARNING_FILE,
} from './assemble-community-unsigned-bundle.mjs';

const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const version = '1.16.0-community42';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assetRecord(filePath, bytes) {
  return {
    bytes: bytes.length,
    fileName: path.basename(filePath),
    path: filePath,
    sha256: sha256(bytes),
  };
}

function writeAsset(sourceRoot, relativePath, content = relativePath) {
  const filePath = path.join(sourceRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(content);
  writeFileSync(filePath, bytes);
  return assetRecord(filePath, bytes);
}

function makeFixture(platform, requestedArchitecture) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-community-bundle-'));
  const sourceRoot = path.join(root, 'source');
  const validationDirectory = path.join(sourceRoot, 'validation');
  const artifactDirectory = path.join(sourceRoot, 'make');
  mkdirSync(validationDirectory, { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  const architecture =
    requestedArchitecture ?? (platform === 'macos' ? 'arm64' : 'x64');
  const assets = [];
  let checks;
  let trust;
  let signature;
  let build = {
    arch: architecture,
    channel: 'release',
    distributionMode: 'community-unsigned',
    platform,
    sourceCommit,
    version,
  };

  if (platform === 'macos') {
    assets.push(
      writeAsset(
        artifactDirectory,
        `clodex-community-unsigned-${version}-${architecture}.dmg`,
      ),
      writeAsset(
        artifactDirectory,
        `clodex-community-unsigned-darwin-${architecture}-${version}.zip`,
      ),
      writeAsset(
        validationDirectory,
        `macos-${architecture}-${version}.cdx.json`,
        '{"bomFormat":"CycloneDX"}\n',
      ),
    );
    checks = {
      attribution: { status: 'READY' },
      zip: { attribution: { status: 'READY' } },
    };
    signature = Object.fromEntries(
      ['packaged', 'mounted', 'copied', 'zip'].map((name) => [
        name,
        {
          authorities: [],
          isAdhoc: true,
          signature: 'adhoc',
          teamIdentifier: 'not set',
        },
      ]),
    );
    signature.requiredMode = 'community-ad-hoc';
    trust = {
      applicationStapler: { passed: false },
      copiedApplicationStapler: { passed: false },
      dmgStapler: { passed: false },
    };
    build = { ...build, updateServerConfigured: false };
  } else if (platform === 'windows') {
    assets.push(
      writeAsset(
        artifactDirectory,
        `clodex-community-unsigned-${version}-${architecture}-setup.exe`,
      ),
      writeAsset(
        artifactDirectory,
        `clodex-community-unsigned-${version}-${architecture}-full.nupkg`,
      ),
      writeAsset(artifactDirectory, `RELEASES-win32-${architecture}`),
      writeAsset(
        validationDirectory,
        `windows-${architecture}-${version}-nupkg.cdx.json`,
        '{"bomFormat":"CycloneDX"}\n',
      ),
    );
    const notSigned = { checked: true, passed: false, status: 'NotSigned' };
    checks = {
      nupkg: { payload: { attribution: { status: 'READY' } } },
      packagedExecutableAuthenticode: notSigned,
      setupAuthenticode: notSigned,
    };
  } else {
    const debArchitecture = architecture === 'x64' ? 'amd64' : 'arm64';
    const rpmFileArchitecture = architecture === 'x64' ? 'x86_64' : 'arm64';
    assets.push(
      writeAsset(
        artifactDirectory,
        `clodex-community-unsigned_${version}_${debArchitecture}.deb`,
      ),
      writeAsset(
        artifactDirectory,
        `clodex-community-unsigned-${version.replace('-community', '.community')}-1.${rpmFileArchitecture}.rpm`,
      ),
      writeAsset(
        validationDirectory,
        `linux-${architecture}-${version}-deb.cdx.json`,
        '{"bomFormat":"CycloneDX","payload":"deb"}\n',
      ),
      writeAsset(
        validationDirectory,
        `linux-${architecture}-${version}-rpm.cdx.json`,
        '{"bomFormat":"CycloneDX","payload":"rpm"}\n',
      ),
    );
    checks = {
      debian: { payload: { attribution: { status: 'READY' } } },
      rpm: { payload: { attribution: { status: 'READY' } } },
    };
  }

  const distributionTrust =
    platform === 'macos'
      ? {
          codeSigning: 'ad-hoc',
          mode: 'community-unsigned',
          notarization: 'absent',
          osTrust: 'absent',
          updater: 'excluded',
          warningCode: 'CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST',
        }
      : platform === 'windows'
        ? {
            codeSigning: {
              packagedExecutable: checks.packagedExecutableAuthenticode,
              setupExecutable: checks.setupAuthenticode,
            },
            mode: 'community-unsigned',
            notarization: 'not-applicable',
            osTrust: 'absent',
            updater: 'excluded',
            warningCode: 'CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST',
          }
        : {
            codeSigning: 'not-applicable',
            mode: 'community-unsigned',
            notarization: 'not-applicable',
            osTrust: 'platform-package-unsigned',
            updater: 'excluded',
            warningCode: 'CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST',
          };

  const manifest = {
    schemaVersion: 2,
    status: 'passed',
    build,
    checks,
    distributionTrust,
    ...(signature ? { signature } : {}),
    ...(trust ? { trust } : {}),
    artifacts:
      platform === 'macos'
        ? Object.fromEntries(
            assets.map((asset, index) => [`artifact${index}`, asset]),
          )
        : assets,
    publication: {
      assets: assets.map(({ bytes, fileName, sha256: digest }) => ({
        bytes,
        fileName,
        sha256: digest,
      })),
      status: 'validated',
    },
  };
  const manifestPath = path.join(
    validationDirectory,
    `${platform}-${architecture}-${version}.json`,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    architecture,
    assets,
    manifest,
    manifestPath,
    outputDirectory: path.join(root, 'bundle'),
    platform,
    root,
    sourceRoot,
  };
}

function rewriteManifest(fixture) {
  writeFileSync(
    fixture.manifestPath,
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
  );
}

function assemble(fixture, overrides = {}) {
  return assembleCommunityUnsignedBundle({
    allowedSourceRoot: fixture.sourceRoot,
    architecture: fixture.architecture,
    manifestPath: fixture.manifestPath,
    outputDirectory: fixture.outputDirectory,
    platform: fixture.platform,
    sourceCommit,
    version,
    ...overrides,
  });
}

for (const platform of ['macos', 'windows', 'linux']) {
  test(`assembles a byte-bound ${platform} bundle and excludes updater payloads`, () => {
    const fixture = makeFixture(platform);
    try {
      const result = assemble(fixture);
      const names = readdirSync(result.outputDirectory).sort();
      assert.ok(names.includes(COMMUNITY_UNSIGNED_WARNING_FILE));
      assert.ok(names.includes(COMMUNITY_UNSIGNED_MANIFEST_FILE));
      assert.ok(names.includes(COMMUNITY_UNSIGNED_CHECKSUMS_FILE));
      assert.ok(
        names.some((name) => name.startsWith(`validation-${platform}-`)),
      );
      assert.equal(
        names.some((name) => name.endsWith('.zip')),
        false,
      );
      assert.equal(
        names.some((name) => name.endsWith('.nupkg')),
        false,
      );
      assert.equal(
        names.some((name) => name.startsWith('RELEASES')),
        false,
      );

      const warning = readFileSync(
        path.join(result.outputDirectory, COMMUNITY_UNSIGNED_WARNING_FILE),
        'utf8',
      );
      assert.match(
        warning,
        /no trusted operating-system distribution signature/i,
      );
      assert.match(warning, new RegExp(sourceCommit));
      assert.match(warning, /Auto-update metadata.*intentionally excluded/s);

      const bundleManifest = JSON.parse(
        readFileSync(
          path.join(result.outputDirectory, COMMUNITY_UNSIGNED_MANIFEST_FILE),
          'utf8',
        ),
      );
      assert.equal(bundleManifest.distributionMode, 'community-unsigned');
      assert.equal(bundleManifest.sourceCommit, sourceCommit);
      assert.equal(bundleManifest.updater.status, 'excluded');
      if (platform === 'macos') {
        assert.deepEqual(
          bundleManifest.updater.excludedAssets.map((asset) => asset.reason),
          ['macos-update-zip'],
        );
      }
      if (platform === 'windows') {
        assert.deepEqual(
          bundleManifest.updater.excludedAssets
            .map((asset) => asset.reason)
            .sort(),
          ['squirrel-package', 'squirrel-releases'],
        );
      }

      const checksums = readFileSync(
        path.join(result.outputDirectory, COMMUNITY_UNSIGNED_CHECKSUMS_FILE),
        'utf8',
      )
        .trim()
        .split('\n');
      for (const line of checksums) {
        const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
        assert.ok(match, `invalid checksum line: ${line}`);
        const [, expected, fileName] = match;
        assert.equal(
          sha256(readFileSync(path.join(result.outputDirectory, fileName))),
          expected,
        );
      }
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
}

test('accepts MakerRPM ARM64 output naming', () => {
  const fixture = makeFixture('linux', 'arm64');
  try {
    const result = assemble(fixture);
    assert.ok(
      readdirSync(result.outputDirectory).includes(
        'clodex-community-unsigned-1.16.0.community42-1.arm64.rpm',
      ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('assembles a separately identified community-observed bundle with validated telemetry policy', () => {
  const fixture = makeFixture('linux');
  const observedVersion = '1.16.0-communityobserved42';
  try {
    fixture.manifest.build.distributionMode = 'community-observed';
    fixture.manifest.build.version = observedVersion;
    fixture.manifest.distributionTrust.mode = 'community-observed';
    fixture.manifest.distributionTrust.warningCode =
      'CLODEX_COMMUNITY_OBSERVED_NO_OS_TRUST';
    fixture.manifest.telemetryTrust = {
      status: 'validated',
      transport: 'posthog-node-backend',
      optIn: 'explicit',
      declaredConsentContract: 'required-choice-v1',
      consentVersion: COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
      consentUiMarker: 'present',
      allowedTelemetryLevel: 'anonymous',
      privacyMode: true,
      disableGeoip: true,
      personProfileDisableProperty: 'present',
      renderer: {
        enabled: false,
        projectKeyEmbedded: false,
        autocapture: 'disabled',
        sessionRecording: 'disabled',
      },
      exceptions: 'disabled',
      modelTracing: 'disabled',
      contentPolicy: 'event-field-allowlist-v1',
    };

    fixture.assets.forEach((asset, index) => {
      const nextFileName = asset.fileName
        .replaceAll('clodex-community-unsigned', 'clodex-community-observed')
        .replaceAll('1.16.0.community42', '1.16.0.communityobserved42')
        .replaceAll(version, observedVersion);
      const nextPath = path.join(path.dirname(asset.path), nextFileName);
      renameSync(asset.path, nextPath);
      asset.fileName = nextFileName;
      asset.path = nextPath;
      fixture.manifest.publication.assets[index].fileName = nextFileName;
    });
    rewriteManifest(fixture);

    const result = assemble(fixture, {
      distributionMode: 'community-observed',
      version: observedVersion,
    });
    const names = readdirSync(result.outputDirectory);
    assert.ok(names.includes(COMMUNITY_OBSERVED_WARNING_FILE));
    assert.ok(names.includes(COMMUNITY_OBSERVED_MANIFEST_FILE));
    assert.ok(
      names.includes(
        'clodex-community-observed-1.16.0.communityobserved42-1.x86_64.rpm',
      ),
    );
    assert.equal(
      result.bundleManifest.telemetry.transport,
      'posthog-node-backend',
    );
    assert.equal(
      result.bundleManifest.telemetry.consentPrompt,
      'required-choice',
    );
    assert.equal(
      result.bundleManifest.telemetry.consentVersion,
      COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
    );
    assert.equal(result.bundleManifest.telemetry.allowedLevel, 'anonymous');
    assert.equal(result.bundleManifest.telemetry.personProfiles, 'disabled');
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects official or non-release validation identity', () => {
  const fixture = makeFixture('windows');
  try {
    fixture.manifest.build.distributionMode = 'official';
    rewriteManifest(fixture);
    assert.throws(() => assemble(fixture), /community identity is invalid/);
    fixture.manifest.build.distributionMode = 'community-unsigned';
    fixture.manifest.build.channel = 'prerelease';
    rewriteManifest(fixture);
    assert.throws(() => assemble(fixture), /community identity is invalid/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects blocked attribution and trusted Windows signatures', () => {
  const fixture = makeFixture('windows');
  try {
    fixture.manifest.checks.nupkg.payload.attribution.status = 'BLOCKED';
    rewriteManifest(fixture);
    assert.throws(
      () => assemble(fixture),
      /attribution must be strictly READY/,
    );

    fixture.manifest.checks.nupkg.payload.attribution.status = 'READY';
    fixture.manifest.checks.setupAuthenticode = {
      checked: true,
      passed: true,
      status: 'Valid',
    };
    rewriteManifest(fixture);
    assert.throws(() => assemble(fixture), /explicitly NotSigned/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects changed bytes after validation', () => {
  const fixture = makeFixture('linux');
  try {
    writeFileSync(fixture.assets[0].path, 'tampered bytes');
    assert.throws(() => assemble(fixture), /Validated asset bytes changed/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects source path escapes and symlinked validation assets', () => {
  const fixture = makeFixture('windows');
  const outsidePath = path.join(
    fixture.root,
    path.basename(fixture.assets[0].path),
  );
  try {
    const outside = Buffer.from('outside');
    writeFileSync(outsidePath, outside);
    const setup = fixture.assets[0];
    setup.path = outsidePath;
    setup.bytes = outside.length;
    setup.sha256 = sha256(outside);
    const publicationSetup = fixture.manifest.publication.assets.find((asset) =>
      asset.fileName.endsWith('-setup.exe'),
    );
    publicationSetup.bytes = outside.length;
    publicationSetup.sha256 = sha256(outside);
    rewriteManifest(fixture);
    assert.throws(
      () => assemble(fixture),
      /escapes the community build output root/,
    );

    const symlinkPath = path.join(
      fixture.sourceRoot,
      'make',
      path.basename(outsidePath),
    );
    rmSync(symlinkPath, { force: true });
    symlinkSync(outsidePath, symlinkPath);
    setup.path = symlinkPath;
    rewriteManifest(fixture);
    assert.throws(() => assemble(fixture), /must be a non-empty regular file/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects unexpected non-installer publication files', () => {
  const fixture = makeFixture('macos');
  try {
    const unexpected = writeAsset(
      fixture.sourceRoot,
      'make/community-readme.txt',
    );
    fixture.manifest.artifacts.unexpected = unexpected;
    fixture.manifest.publication.assets.push({
      bytes: unexpected.bytes,
      fileName: unexpected.fileName,
      sha256: unexpected.sha256,
    });
    rewriteManifest(fixture);
    assert.throws(
      () => assemble(fixture),
      /Unexpected community publication asset/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects RPM assets with mismatched community version, release, or architecture', () => {
  for (const invalidFileName of [
    'clodex-community-unsigned-1.16.0.community420-1.x86_64.rpm',
    'clodex-community-unsigned-1.16.0.community42-2.x86_64.rpm',
    'clodex-community-unsigned-1.16.0.community42-1.aarch64.rpm',
  ]) {
    const fixture = makeFixture('linux');
    try {
      const rpmAsset = fixture.assets.find((asset) =>
        asset.fileName.endsWith('.rpm'),
      );
      assert.ok(rpmAsset);
      const originalFileName = rpmAsset.fileName;
      const renamedPath = path.join(
        path.dirname(rpmAsset.path),
        invalidFileName,
      );
      renameSync(rpmAsset.path, renamedPath);
      rpmAsset.fileName = invalidFileName;
      rpmAsset.path = renamedPath;
      const publicationAsset = fixture.manifest.publication.assets.find(
        (asset) => asset.fileName === originalFileName,
      );
      assert.ok(publicationAsset);
      publicationAsset.fileName = invalidFileName;
      rewriteManifest(fixture);

      assert.throws(
        () => assemble(fixture),
        /Unexpected community publication asset/,
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }
});

test('rejects mismatched source commit and unsafe output overlap', () => {
  const fixture = makeFixture('linux');
  try {
    assert.throws(
      () => assemble(fixture, { sourceCommit: 'f'.repeat(40) }),
      /community identity is invalid/,
    );
    assert.throws(
      () => assemble(fixture, { outputDirectory: fixture.sourceRoot }),
      /Unsafe or overlapping/,
    );
    assert.equal(existsSync(fixture.manifestPath), true);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
