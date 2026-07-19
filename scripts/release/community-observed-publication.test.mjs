import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assemblePublicationCandidate,
  COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS,
  normalizeObservedArtifacts,
  safeExtractZip,
  verifyPublicationCandidate,
} from './community-observed-publication.mjs';
import { publishCommunityObservedPrerelease } from './publish-community-observed-prerelease.mjs';

const repository = 'mereyabdenbekuly-ctrl/clodex-ide';
const sourceCommit = 'a2645d0a948a6b2c782edce7b02f4bfde49718ce';
const publisherCommit = 'b2645d0a948a6b2c782edce7b02f4bfde49718cf';
const runId = 29_677_260_054;
const runNumber = 11;
const runAttempt = 1;
const version = '1.16.0-communityobserved11';
const tag = `v${version}`;
const specs = [
  { architecture: 'x64', platform: 'linux' },
  { architecture: 'arm64', platform: 'macos' },
  { architecture: 'x64', platform: 'macos' },
  { architecture: 'x64', platform: 'windows' },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function write(root, name, contents) {
  const filePath = path.join(root, name);
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  writeFileSync(filePath, bytes);
  return {
    bytes: bytes.length,
    fileName: name,
    sha256: sha256(bytes),
  };
}

function artifactName(spec) {
  return `clodex-community-observed-${spec.platform}-${spec.architecture}-${sourceCommit.slice(0, 12)}-attempt${runAttempt}`;
}

function installerNames(spec) {
  if (spec.platform === 'macos') {
    return [`clodex-community-observed-${version}-${spec.architecture}.dmg`];
  }
  if (spec.platform === 'windows') {
    return [`clodex-community-observed-${version}-x64-setup.exe`];
  }
  return [
    `clodex-community-observed-${version.replace('-', '.')}-1.x86_64.rpm`,
    `clodex-community-observed_${version}_amd64.deb`,
  ];
}

function sbomNames(spec) {
  if (spec.platform === 'linux') {
    return [
      `linux-x64-${version}-deb.cdx.json`,
      `linux-x64-${version}-rpm.cdx.json`,
    ];
  }
  if (spec.platform === 'macos') {
    return [`macos-${spec.architecture}-${version}.cdx.json`];
  }
  return [`windows-x64-${version}-nupkg.cdx.json`];
}

function telemetry() {
  return {
    status: 'explicit-required-choice',
    consentPrompt: 'required-choice',
    consentVersion: 1,
    allowedLevel: 'anonymous',
    transport: 'posthog-node-backend',
    privacyMode: true,
    personProfiles: 'disabled',
    renderer: 'disabled',
    exceptions: 'disabled',
    modelTracing: 'disabled',
    contentPolicy: 'event-field-allowlist-v1',
  };
}

function createBundle(inputRoot, spec, artifactIndex) {
  const name = artifactName(spec);
  const root = path.join(inputRoot, name);
  mkdirSync(root);
  const records = [];
  for (const installerName of installerNames(spec)) {
    records.push({
      ...write(
        root,
        installerName,
        `installer:${installerName}:${'x'.repeat(128)}`,
      ),
      kind: 'installer',
    });
  }
  for (const sbomName of sbomNames(spec)) {
    records.push({
      ...write(
        root,
        sbomName,
        `${JSON.stringify({
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          serialNumber: `urn:uuid:00000000-0000-4000-8000-00000000000${artifactIndex}`,
          components: [{ type: 'application', name: 'clodex', version }],
        })}\n`,
      ),
      kind: 'sbom',
    });
  }
  const validationName = `validation-${spec.platform}-${spec.architecture}-${version}.json`;
  const publicationAssets = records.map(
    ({ bytes, fileName, sha256: digest }) => ({
      bytes,
      fileName,
      sha256: digest,
    }),
  );
  const validation = {
    schemaVersion: 2,
    status: 'passed',
    build: {
      arch: spec.architecture,
      channel: 'release',
      distributionMode: 'community-observed',
      platform: spec.platform,
      sourceCommit,
      version,
      ...(spec.platform === 'macos' ? { updateServerConfigured: false } : {}),
    },
    checks: {
      communityPackagedBoundary: {
        schemaVersion: 1,
        status: 'validated',
        distributionMode: 'community-observed',
        telemetry: {
          backendUsPostHogOriginOccurrences: 1,
          requiredInBackend: true,
          requiredOrigin: 'https://us.i.posthog.com',
        },
        scan: { bytes: 100, files: 1, packedEntries: 1, unpackedFiles: 0 },
      },
    },
    publication: { status: 'validated', assets: publicationAssets },
  };
  records.push({
    ...write(root, validationName, `${JSON.stringify(validation, null, 2)}\n`),
    kind: 'validation',
  });
  records.push({
    ...write(
      root,
      'COMMUNITY-OBSERVED-WARNING.md',
      `# Warning\n${sourceCommit}\n${version}\ncommunity-observed\nno trusted operating-system distribution signature\nAuto-update metadata and updater payloads are intentionally excluded\n`,
    ),
    kind: 'warning',
  });
  records.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const bundleManifest = {
    schemaVersion: 1,
    kind: 'clodex-community-observed-bundle',
    status: 'validated',
    distributionMode: 'community-observed',
    sourceCommit,
    version,
    platform: spec.platform,
    architecture: spec.architecture,
    warning: {
      code: 'CLODEX_COMMUNITY_OBSERVED_NO_OS_TRUST',
      fileName: 'COMMUNITY-OBSERVED-WARNING.md',
    },
    telemetry: telemetry(),
    updater: { status: 'excluded', excludedAssets: [] },
    files: records,
    checksumsFile: 'SHA256SUMS',
  };
  const manifest = write(
    root,
    'community-observed-manifest.json',
    `${JSON.stringify(bundleManifest, null, 2)}\n`,
  );
  const checksums = [...records, manifest]
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((record) => `${record.sha256}  ${record.fileName}`)
    .join('\n');
  write(root, 'SHA256SUMS', `${checksums}\n`);
  return {
    architecture: spec.architecture,
    digest: `${artifactIndex}`.repeat(64).slice(0, 64),
    id: 1_000 + artifactIndex,
    name,
    platform: spec.platform,
    sizeInBytes: 10_000 + artifactIndex,
  };
}

function createCandidateFixture() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-observed-publication-test-'),
  );
  const inputRoot = path.join(root, 'input');
  mkdirSync(inputRoot);
  const artifacts = specs.map((spec, index) =>
    createBundle(inputRoot, spec, index + 1),
  );
  const candidateDirectory = path.join(root, 'candidate');
  const result = assemblePublicationCandidate({
    artifacts,
    inputRoot,
    outputDirectory: candidateDirectory,
    repository,
    runAttempt,
    runId,
    runNumber,
    sourceCommit,
    tag,
    version,
  });
  return { artifacts, candidateDirectory, result, root };
}

test('assembles exactly five unchanged installers, evidence, and SHA256SUMS.txt', () => {
  const fixture = createCandidateFixture();
  try {
    const names = readdirSync(
      path.join(fixture.candidateDirectory, 'release-assets'),
    ).sort();
    assert.equal(names.length, 7);
    assert.deepEqual(
      names,
      [
        COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS,
        `clodex-community-observed-${version}-arm64.dmg`,
        `clodex-community-observed-${version}-evidence.zip`,
        `clodex-community-observed-${version}-x64-setup.exe`,
        `clodex-community-observed-${version}-x64.dmg`,
        `clodex-community-observed-${version.replace('-', '.')}-1.x86_64.rpm`,
        `clodex-community-observed_${version}_amd64.deb`,
      ].sort(),
    );
    assert.equal(fixture.result.manifest.installers.length, 5);
    assert.equal(fixture.result.manifest.evidence.directories.length, 4);
    assert.equal(
      readFileSync(
        path.join(
          fixture.candidateDirectory,
          'release-assets',
          COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS,
        ),
        'utf8',
      )
        .trim()
        .split('\n').length,
      6,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('candidate verification detects installer tampering', () => {
  const fixture = createCandidateFixture();
  try {
    const installer = path.join(
      fixture.candidateDirectory,
      'release-assets',
      `clodex-community-observed-${version}-arm64.dmg`,
    );
    writeFileSync(installer, 'tampered');
    assert.throws(
      () =>
        verifyPublicationCandidate({
          candidateDirectory: fixture.candidateDirectory,
          repository,
          runId,
          sourceCommit,
          tag,
        }),
      /installer bytes differ|checksum mismatch/u,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('safe ZIP extraction rejects a symlink archive path', () => {
  const fixture = createCandidateFixture();
  const link = path.join(fixture.root, 'evidence-link.zip');
  try {
    const evidence = path.join(
      fixture.candidateDirectory,
      'release-assets',
      `clodex-community-observed-${version}-evidence.zip`,
    );
    symlinkSync(evidence, link);
    assert.throws(
      () => safeExtractZip(link, path.join(fixture.root, 'unsafe-output')),
      /symlink/u,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('safe ZIP extraction rejects traversal, absolute, backslash, symlink, and case collisions', () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-malicious-zip-test-'),
  );
  const cases = [
    {
      name: 'traversal',
      body: "archive.writestr('../escape.txt', b'escape')",
    },
    {
      name: 'absolute',
      body: "archive.writestr('/absolute.txt', b'absolute')",
    },
    {
      name: 'backslash',
      body: "archive.writestr(r'dir\\\\escape.txt', b'backslash')",
    },
    {
      name: 'member-symlink',
      body: [
        "info = zipfile.ZipInfo('link')",
        'info.create_system = 3',
        'info.external_attr = (stat.S_IFLNK | 0o777) << 16',
        "archive.writestr(info, b'target')",
      ].join('\n    '),
    },
    {
      name: 'case-collision',
      body: [
        "archive.writestr('README.md', b'one')",
        "archive.writestr('readme.md', b'two')",
      ].join('\n    '),
    },
  ];
  try {
    for (const fixture of cases) {
      const archivePath = path.join(root, `${fixture.name}.zip`);
      execFileSync('python3', [
        '-c',
        `import stat, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_STORED) as archive:\n    ${fixture.body}\n`,
        archivePath,
      ]);
      assert.throws(
        () =>
          safeExtractZip(
            archivePath,
            path.join(root, `${fixture.name}-output`),
          ),
        /unsafe|forbidden|regular file|colliding|canonical/u,
        fixture.name,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('current rerun artifacts are selected while older attempts remain ignored', () => {
  const current = specs.map((spec, index) => ({
    archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/${2_000 + index}/zip`,
    digest: `sha256:${String(index + 5)
      .repeat(64)
      .slice(0, 64)}`,
    expired: false,
    id: 2_000 + index,
    name: artifactName(spec).replace('attempt1', 'attempt2'),
    size_in_bytes: 100 + index,
    workflow_run: { head_branch: 'main', head_sha: sourceCommit, id: runId },
  }));
  const old = current.map((record, index) => ({
    ...record,
    id: 3_000 + index,
    name: record.name.replace('attempt2', 'attempt1'),
  }));
  const normalized = normalizeObservedArtifacts([...old, ...current], {
    repository,
    runAttempt: 2,
    runId,
    sourceCommit,
  });
  assert.equal(normalized.length, 4);
  assert.ok(normalized.every(({ name }) => name.endsWith('attempt2')));
});

class FakeReleaseApi {
  constructor() {
    this.release = null;
    this.writes = [];
    this.tagPublished = false;
  }

  getRef(_repository, ref) {
    if (ref === 'heads/main') {
      return {
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: publisherCommit },
      };
    }
    if (this.tagPublished) {
      return {
        ref: `refs/${ref}`,
        object: { type: 'commit', sha: sourceCommit },
      };
    }
    return null;
  }

  compareCommits(_repository, base, head) {
    assert.equal(base, sourceCommit);
    assert.equal(head, publisherCommit);
    return {
      status: 'ahead',
      base_commit: { sha: sourceCommit },
      merge_base_commit: { sha: sourceCommit },
    };
  }

  listReleases() {
    return this.release ? [this.release] : [];
  }

  createDraft({
    body,
    name,
    prerelease,
    repository: repo,
    tag: releaseTag,
    targetCommitish,
  }) {
    this.writes.push('create');
    this.release = {
      id: 77,
      url: `https://api.github.com/repos/${repo}/releases/77`,
      html_url: `https://github.com/${repo}/releases/tag/${releaseTag}`,
      upload_url: `https://uploads.github.com/repos/${repo}/releases/77/assets{?name,label}`,
      tag_name: releaseTag,
      target_commitish: targetCommitish,
      name,
      body,
      draft: true,
      prerelease,
      published_at: null,
      immutable: false,
      assets: [],
    };
    return this.release;
  }

  getRelease() {
    return this.release;
  }

  getReleaseWithEtag() {
    return { body: this.release, etag: 'W/"draft-etag"', status: 200 };
  }

  uploadAsset({ asset }) {
    this.writes.push(`upload:${asset.name}`);
    const uploaded = {
      id: 100 + this.release.assets.length,
      name: asset.name,
      size: asset.bytes,
      state: 'uploaded',
      digest: `sha256:${asset.sha256}`,
    };
    uploaded.url = `https://api.github.com/repos/${repository}/releases/assets/${uploaded.id}`;
    this.release.assets.push(uploaded);
    return uploaded;
  }

  publishRelease(_repository, _releaseId, etag) {
    assert.equal(etag, 'W/"draft-etag"');
    this.writes.push('patch');
    this.tagPublished = true;
    this.release = {
      ...this.release,
      draft: false,
      immutable: true,
      published_at: '2026-07-19T12:00:00Z',
    };
    return { body: this.release, etag: 'W/"published"', status: 200 };
  }
}

test('publisher fails before writes when immutable releases are disabled', async () => {
  const fixture = createCandidateFixture();
  const api = new FakeReleaseApi();
  try {
    await assert.rejects(
      publishCommunityObservedPrerelease({
        api,
        candidateDirectory: fixture.candidateDirectory,
        immutabilityEnabled: false,
        repository,
        runId,
        sourceCommit,
        publisherCommit,
        tag,
      }),
      /immutable-release attestation is not enabled/u,
    );
    assert.deepEqual(api.writes, []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('publisher stages seven assets then performs one conditional immutable publication', async () => {
  const fixture = createCandidateFixture();
  const api = new FakeReleaseApi();
  try {
    const result = await publishCommunityObservedPrerelease({
      api,
      candidateDirectory: fixture.candidateDirectory,
      immutabilityEnabled: true,
      repository,
      runId,
      sourceCommit,
      publisherCommit,
      tag,
    });
    assert.equal(result.status, 'published');
    assert.equal(result.release.immutable, true);
    assert.equal(api.writes.filter((entry) => entry === 'create').length, 1);
    assert.equal(
      api.writes.filter((entry) => entry.startsWith('upload:')).length,
      7,
    );
    assert.equal(api.writes.filter((entry) => entry === 'patch').length, 1);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
