#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMMUNITY_OBSERVED_BYTE_AUDIT_REPORT = 'BYTE-AUDIT-REPORT.json';
export const COMMUNITY_OBSERVED_EVIDENCE_README = 'README.md';
export const COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS = 'SHA256SUMS.txt';
export const COMMUNITY_OBSERVED_RELEASE_NOTES =
  'COMMUNITY-OBSERVED-RELEASE-NOTES.md';
export const COMMUNITY_OBSERVED_PUBLICATION_KIND =
  'clodex-community-observed-publication-v1';
export const COMMUNITY_OBSERVED_DISTRIBUTION_MODE = 'community-observed';
export const COMMUNITY_OBSERVED_WARNING_CODE =
  'CLODEX_COMMUNITY_OBSERVED_NO_OS_TRUST';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const EXPECTED_REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';
const EXPECTED_WORKFLOW_NAME = 'Community Observed Build';
const EXPECTED_WORKFLOW_PATH = '.github/workflows/community-observed-build.yml';
const SOURCE_REF = 'refs/heads/main';
const BUNDLE_MANIFEST = 'community-observed-manifest.json';
const BUNDLE_WARNING = 'COMMUNITY-OBSERVED-WARNING.md';
const BUNDLE_CHECKSUMS = 'SHA256SUMS';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-communityobserved[1-9]\d*$/u;
const TAG_PATTERN =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-communityobserved[1-9]\d*)$/u;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+@()-]*$/u;
const MAX_ARTIFACT_BYTES = 4 * 1024 ** 3;
const IO_BUFFER_BYTES = 1024 * 1024;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY = 0x0314;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021;
const ZIP_EXTERNAL_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const MAX_UINT32 = 0xffffffff;
const PLATFORM_SPECS = Object.freeze([
  Object.freeze({ architecture: 'x64', platform: 'linux' }),
  Object.freeze({ architecture: 'arm64', platform: 'macos' }),
  Object.freeze({ architecture: 'x64', platform: 'macos' }),
  Object.freeze({ architecture: 'x64', platform: 'windows' }),
]);
const REDIRECT_HOST_PATTERNS = Object.freeze([
  /^(?:[a-z0-9-]+\.)*blob\.core\.windows\.net$/u,
  /^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/u,
  /^objects\.githubusercontent\.com$/u,
]);
const FORBIDDEN_UPDATER_PATTERNS = Object.freeze([
  /\.nupkg$/iu,
  /^RELEASES(?:-|$)/u,
  /\.blockmap$/iu,
  /^(?:latest|app-update)(?:[-.].*)?\.ya?ml$/iu,
  /(?:^|[-_.])delta(?:[-_.]|$)/iu,
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const safeExtractorPath = path.join(scriptDirectory, 'safe-extract-zip.py');
const telemetryContract = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      'apps/browser/src/shared/community-observed-telemetry-contract.json',
    ),
    'utf8',
  ),
);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertExactKeys(value, expected, label) {
  assert(isObject(value), `${label} must be an object`);
  const observed = Object.keys(value).sort();
  const canonical = [...expected].sort();
  assert(
    JSON.stringify(observed) === JSON.stringify(canonical),
    `${label} keys are not canonical`,
  );
}

function assertSafeFileName(value, label = 'file') {
  assert(
    typeof value === 'string' &&
      SAFE_FILE_NAME.test(value) &&
      value === path.basename(value) &&
      value !== '.' &&
      value !== '..' &&
      !/[\\/\r\n\0]/u.test(value),
    `${label} has an unsafe filename: ${String(value ?? '<missing>')}`,
  );
  return value;
}

function assertSafeArchivePath(value, label = 'ZIP entry') {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !/[\\\r\n\0]/u.test(value),
    `${label} has an unsafe path`,
  );
  const parts = value.split('/');
  assert(
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        SAFE_FILE_NAME.test(part),
    ),
    `${label} has an unsafe path`,
  );
  return value;
}

function assertRepository(value) {
  assert(REPOSITORY_PATTERN.test(value ?? ''), 'repository must be owner/name');
  assert(
    value === EXPECTED_REPOSITORY,
    `repository must be the canonical ${EXPECTED_REPOSITORY}`,
  );
  return value;
}

function assertNoSymlinkComponents(value, label) {
  const absolute = path.resolve(value);
  if (existsSync(absolute)) {
    assert(
      !lstatSync(absolute).isSymbolicLink(),
      `${label} must not be a symlink: ${absolute}`,
    );
  }
  return absolute;
}

function assertSourceCommit(value) {
  assert(
    SOURCE_COMMIT_PATTERN.test(value ?? ''),
    'source commit must be an exact lowercase 40-character SHA',
  );
  return value;
}

function assertPositiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} is invalid`);
  return value;
}

function assertSha256(value, label) {
  assert(SHA256_PATTERN.test(value ?? ''), `${label} is not a SHA-256 digest`);
  return value;
}

function assertPositiveBytes(value, label) {
  assert(
    Number.isSafeInteger(value) && value > 0 && value <= MAX_ARTIFACT_BYTES,
    `${label} is outside the safe byte range`,
  );
  return value;
}

function assertCanonicalVersion(value, runNumber) {
  assert(VERSION_PATTERN.test(value ?? ''), 'observed version is invalid');
  assert(
    value.endsWith(`-communityobserved${runNumber}`),
    'observed version is not bound to the exact workflow run number',
  );
  return value;
}

function assertCanonicalTag(value, version) {
  const match = TAG_PATTERN.exec(value ?? '');
  assert(match?.[1] === version, 'observed release tag is invalid');
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  const descriptor = openSync(filePath, 'r');
  try {
    while (true) {
      const observed = readSync(descriptor, buffer, 0, buffer.length, null);
      if (observed === 0) break;
      hash.update(buffer.subarray(0, observed));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function fileRecord(filePath, kind, extra = {}) {
  const stats = lstatSync(filePath);
  assert(
    stats.isFile() && !stats.isSymbolicLink() && stats.size > 0,
    `expected a non-empty regular file: ${filePath}`,
  );
  return {
    bytes: stats.size,
    fileName: assertSafeFileName(path.basename(filePath)),
    kind,
    sha256: sha256File(filePath),
    ...extra,
  };
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(
      `${label} is not readable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function platformKey({ architecture, platform }) {
  return `${platform}-${architecture}`;
}

function expectedArtifactName(spec, sourceCommit, runAttempt) {
  return `clodex-community-observed-${platformKey(spec)}-${sourceCommit.slice(0, 12)}-attempt${runAttempt}`;
}

function evidenceFileName(version) {
  return `clodex-community-observed-${version}-evidence.zip`;
}

function releaseName(version) {
  const runNumber = /communityobserved([1-9]\d*)$/u.exec(version)?.[1];
  return `CLODEx ${version.split('-')[0]} Community Observed ${runNumber}`;
}

function expectedInstallerNames(version, spec) {
  if (spec.platform === 'macos') {
    return [`clodex-community-observed-${version}-${spec.architecture}.dmg`];
  }
  if (spec.platform === 'windows') {
    return [
      `clodex-community-observed-${version}-${spec.architecture}-setup.exe`,
    ];
  }
  return [
    `clodex-community-observed-${version.replace('-', '.')}-1.x86_64.rpm`,
    `clodex-community-observed_${version}_amd64.deb`,
  ].sort((left, right) => left.localeCompare(right));
}

function expectedSbomNames(version, spec) {
  if (spec.platform === 'linux') {
    return [
      `linux-${spec.architecture}-${version}-deb.cdx.json`,
      `linux-${spec.architecture}-${version}-rpm.cdx.json`,
    ];
  }
  if (spec.platform === 'macos') {
    return [`macos-${spec.architecture}-${version}.cdx.json`];
  }
  return [`windows-${spec.architecture}-${version}-nupkg.cdx.json`];
}

function assertNoUpdaterAsset(fileName, { allowPublicBundle = false } = {}) {
  assertSafeFileName(fileName);
  if (allowPublicBundle && fileName.endsWith('.zip')) return;
  assert(
    !FORBIDDEN_UPDATER_PATTERNS.some((pattern) => pattern.test(fileName)) &&
      !fileName.endsWith('.zip'),
    `updater payload is forbidden in Community Observed publication: ${fileName}`,
  );
}

function parseChecksums(source, label) {
  assert(
    typeof source === 'string' && source.endsWith('\n'),
    `${label} is not canonical`,
  );
  const records = source
    .trimEnd()
    .split('\n')
    .map((line) => {
      const match =
        /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+@()-]*)$/u.exec(line);
      assert(match, `${label} contains an invalid line`);
      return { fileName: assertSafeFileName(match[2]), sha256: match[1] };
    });
  const sorted = [...records].sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
  assert(
    JSON.stringify(records) === JSON.stringify(sorted),
    `${label} is not sorted canonically`,
  );
  assert(
    new Set(records.map(({ fileName }) => fileName)).size === records.length,
    `${label} contains duplicate filenames`,
  );
  return records;
}

function expectedTelemetry() {
  return {
    status: 'explicit-required-choice',
    consentPrompt: 'required-choice',
    consentVersion: telemetryContract.consentVersion,
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

function validateSbom(sbomPath, expectedFileName) {
  const sbom = readJsonFile(sbomPath, `SBOM ${expectedFileName}`);
  assert(isObject(sbom), `SBOM ${expectedFileName} must be an object`);
  assert(
    sbom.bomFormat === 'CycloneDX',
    `SBOM ${expectedFileName} is not CycloneDX`,
  );
  assert(
    /^1\.(?:5|6|7)$/u.test(String(sbom.specVersion ?? '')),
    `SBOM ${expectedFileName} has an unsupported specVersion`,
  );
  assert(
    Array.isArray(sbom.components) && sbom.components.length > 0,
    `SBOM ${expectedFileName} has no components`,
  );
  return sbom;
}

function validateBoundaryEvidence(validation, expected) {
  assert(
    validation?.schemaVersion === 2 && validation?.status === 'passed',
    'validation manifest status is invalid',
  );
  const build = validation.build;
  assert(
    isObject(build) &&
      build.channel === 'release' &&
      build.distributionMode === COMMUNITY_OBSERVED_DISTRIBUTION_MODE &&
      build.sourceCommit === expected.sourceCommit &&
      build.version === expected.version &&
      build.platform === expected.platform &&
      build.arch === expected.architecture,
    'validation manifest build identity differs',
  );
  for (const forbidden of ['tag', 'releasePlanPath', 'releasePlanSha256']) {
    assert(
      build[forbidden] === undefined ||
        build[forbidden] === null ||
        build[forbidden] === '',
      `validation manifest unexpectedly contains ${forbidden}`,
    );
  }
  const boundary = validation.checks?.communityPackagedBoundary;
  assert(
    boundary?.schemaVersion === 1 &&
      boundary?.status === 'validated' &&
      boundary?.distributionMode === COMMUNITY_OBSERVED_DISTRIBUTION_MODE &&
      boundary?.telemetry?.requiredInBackend === true &&
      boundary?.telemetry?.requiredOrigin === 'https://us.i.posthog.com' &&
      Number.isSafeInteger(
        boundary?.telemetry?.backendUsPostHogOriginOccurrences,
      ) &&
      boundary.telemetry.backendUsPostHogOriginOccurrences > 0 &&
      Number.isSafeInteger(boundary?.scan?.bytes) &&
      boundary.scan.bytes > 0,
    'packaged Community Free boundary evidence is missing or invalid',
  );
  assert(
    validation.publication?.status === 'validated' &&
      Array.isArray(validation.publication?.assets),
    'validation publication asset evidence is missing',
  );
}

export function validateObservedBundle(directory, expected) {
  assertSourceCommit(expected.sourceCommit);
  assertCanonicalVersion(expected.version, expected.runNumber);
  const spec = PLATFORM_SPECS.find(
    (candidate) =>
      candidate.platform === expected.platform &&
      candidate.architecture === expected.architecture,
  );
  assert(spec, 'unsupported observed platform/architecture');
  const root = assertNoSymlinkComponents(directory, 'bundle root');
  const rootStats = lstatSync(root);
  assert(
    rootStats.isDirectory() && !rootStats.isSymbolicLink(),
    'bundle root is invalid',
  );
  const names = readdirSync(root).sort((left, right) =>
    left.localeCompare(right),
  );
  assert(names.length > 0, 'observed bundle is empty');
  for (const name of names) {
    assertSafeFileName(name, 'bundle entry');
    assertNoUpdaterAsset(name);
    const stats = lstatSync(path.join(root, name));
    assert(
      stats.isFile() && !stats.isSymbolicLink() && stats.size > 0,
      `bundle entry is not a non-empty regular file: ${name}`,
    );
  }

  const manifestPath = path.join(root, BUNDLE_MANIFEST);
  const checksumsPath = path.join(root, BUNDLE_CHECKSUMS);
  const warningPath = path.join(root, BUNDLE_WARNING);
  for (const required of [manifestPath, checksumsPath, warningPath]) {
    assert(
      existsSync(required),
      `observed bundle is missing ${path.basename(required)}`,
    );
  }
  const manifest = readJsonFile(manifestPath, 'observed bundle manifest');
  assertExactKeys(
    manifest,
    [
      'architecture',
      'checksumsFile',
      'distributionMode',
      'files',
      'kind',
      'platform',
      'schemaVersion',
      'sourceCommit',
      'status',
      'telemetry',
      'updater',
      'version',
      'warning',
    ],
    'observed bundle manifest',
  );
  assert(
    manifest.schemaVersion === 1 &&
      manifest.kind === 'clodex-community-observed-bundle' &&
      manifest.status === 'validated' &&
      manifest.distributionMode === COMMUNITY_OBSERVED_DISTRIBUTION_MODE &&
      manifest.sourceCommit === expected.sourceCommit &&
      manifest.version === expected.version &&
      manifest.platform === expected.platform &&
      manifest.architecture === expected.architecture &&
      manifest.checksumsFile === BUNDLE_CHECKSUMS,
    'observed bundle manifest identity is invalid',
  );
  assert(
    JSON.stringify(manifest.warning) ===
      JSON.stringify({
        code: COMMUNITY_OBSERVED_WARNING_CODE,
        fileName: BUNDLE_WARNING,
      }),
    'observed bundle warning metadata is invalid',
  );
  assert(
    JSON.stringify(manifest.telemetry) === JSON.stringify(expectedTelemetry()),
    'observed bundle telemetry contract differs',
  );
  assert(
    manifest.updater?.status === 'excluded' &&
      Array.isArray(manifest.updater?.excludedAssets),
    'observed bundle updater exclusion is invalid',
  );

  assert(Array.isArray(manifest.files), 'observed bundle files are missing');
  const expectedKinds = new Map([
    ...expectedInstallerNames(expected.version, spec).map((name) => [
      name,
      'installer',
    ]),
    ...expectedSbomNames(expected.version, spec).map((name) => [name, 'sbom']),
    [`validation-${platformKey(spec)}-${expected.version}.json`, 'validation'],
    [BUNDLE_WARNING, 'warning'],
  ]);
  const expectedRecords = [...expectedKinds.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  assert(
    manifest.files.length === expectedRecords.length,
    'observed bundle file count differs',
  );
  const records = manifest.files.map((record) => {
    assertExactKeys(
      record,
      ['bytes', 'fileName', 'kind', 'sha256'],
      'bundle file record',
    );
    const fileName = assertSafeFileName(record.fileName, 'bundle file record');
    assert(
      expectedKinds.get(fileName) === record.kind &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes > 0 &&
        SHA256_PATTERN.test(record.sha256),
      `bundle file record is invalid: ${fileName}`,
    );
    const actual = fileRecord(path.join(root, fileName), record.kind);
    assert(
      actual.bytes === record.bytes && actual.sha256 === record.sha256,
      `bundle file bytes differ from manifest: ${fileName}`,
    );
    return record;
  });
  assert(
    JSON.stringify(records.map(({ fileName }) => fileName)) ===
      JSON.stringify(expectedRecords),
    'observed bundle files are not in canonical order',
  );

  const actualNames = [
    ...expectedRecords,
    BUNDLE_MANIFEST,
    BUNDLE_CHECKSUMS,
  ].sort((left, right) => left.localeCompare(right));
  assert(
    JSON.stringify(names) === JSON.stringify(actualNames),
    'observed bundle has extra entries',
  );

  const checksumRecords = parseChecksums(
    readFileSync(checksumsPath, 'utf8'),
    'bundle SHA256SUMS',
  );
  const checksumNames = [...expectedRecords, BUNDLE_MANIFEST].sort(
    (left, right) => left.localeCompare(right),
  );
  assert(
    JSON.stringify(checksumRecords.map(({ fileName }) => fileName)) ===
      JSON.stringify(checksumNames),
    'bundle SHA256SUMS has the wrong file set',
  );
  for (const record of checksumRecords) {
    assert(
      sha256File(path.join(root, record.fileName)) === record.sha256,
      `bundle SHA256SUMS mismatch: ${record.fileName}`,
    );
  }

  const warning = readFileSync(warningPath, 'utf8');
  for (const claim of [
    expected.sourceCommit,
    expected.version,
    COMMUNITY_OBSERVED_DISTRIBUTION_MODE,
    'no trusted operating-system distribution signature',
    'Auto-update metadata and updater payloads are intentionally excluded',
  ]) {
    assert(
      warning.includes(claim),
      `bundle warning is missing claim: ${claim}`,
    );
  }

  const validationFileName = `validation-${platformKey(spec)}-${expected.version}.json`;
  const validation = readJsonFile(
    path.join(root, validationFileName),
    'observed validation manifest',
  );
  validateBoundaryEvidence(validation, { ...expected, ...spec });
  const publicationEvidence = new Map(
    validation.publication.assets.map((entry) => [entry?.fileName, entry]),
  );
  for (const record of records.filter(({ kind }) =>
    ['installer', 'sbom'].includes(kind),
  )) {
    const evidence = publicationEvidence.get(record.fileName);
    assert(
      evidence?.bytes === record.bytes && evidence?.sha256 === record.sha256,
      `validated publication evidence differs: ${record.fileName}`,
    );
    if (record.kind === 'sbom') {
      validateSbom(path.join(root, record.fileName), record.fileName);
    }
  }
  return {
    bundleManifest: fileRecord(manifestPath, 'bundle-manifest'),
    entries: [
      ...records,
      fileRecord(manifestPath, 'bundle-manifest'),
      fileRecord(checksumsPath, 'checksums'),
    ].sort((left, right) => left.fileName.localeCompare(right.fileName)),
    manifest,
    validation,
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function updateCrc32(initial, bytes) {
  let crc = initial;
  for (const byte of bytes)
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function inspectFileWithCrc(filePath) {
  const stats = statSync(filePath);
  assertPositiveBytes(stats.size, `ZIP input ${path.basename(filePath)} size`);
  const hash = createHash('sha256');
  const descriptor = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  let crc = 0xffffffff;
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      crc = updateCrc32(crc, chunk);
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    bytes: stats.size,
    crc32: (crc ^ 0xffffffff) >>> 0,
    sha256: hash.digest('hex'),
  };
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
}

function copyIntoDescriptor(sourcePath, destination) {
  const source = openSync(sourcePath, 'r');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  try {
    while (true) {
      const observed = readSync(source, buffer, 0, buffer.length, null);
      if (observed === 0) break;
      writeAll(destination, buffer.subarray(0, observed));
    }
  } finally {
    closeSync(source);
  }
}

function localZipHeader({ bytes, crc32, fileNameBytes }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(ZIP_DOS_TIME, 10);
  header.writeUInt16LE(ZIP_DOS_DATE, 12);
  header.writeUInt32LE(crc32, 14);
  header.writeUInt32LE(bytes, 18);
  header.writeUInt32LE(bytes, 22);
  header.writeUInt16LE(fileNameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralZipHeader({ bytes, crc32, fileNameBytes, localOffset }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP_VERSION_MADE_BY, 4);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(ZIP_DOS_TIME, 12);
  header.writeUInt16LE(ZIP_DOS_DATE, 14);
  header.writeUInt32LE(crc32, 16);
  header.writeUInt32LE(bytes, 20);
  header.writeUInt32LE(bytes, 24);
  header.writeUInt16LE(fileNameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(ZIP_EXTERNAL_FILE_ATTRIBUTES, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralBytes, centralOffset) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralBytes, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

export function createDeterministicZip(zipPath, inputDirectory, entries) {
  const canonicalEntries = [...entries].sort((left, right) =>
    (left.archivePath ?? left.fileName).localeCompare(
      right.archivePath ?? right.fileName,
    ),
  );
  assert(
    canonicalEntries.length > 0 && canonicalEntries.length <= 128,
    'ZIP entry count is invalid',
  );
  const records = canonicalEntries.map((entry) => {
    const fileName = assertSafeArchivePath(
      entry.archivePath ?? entry.fileName,
      'ZIP entry',
    );
    const filePath = entry.sourcePath ?? path.join(inputDirectory, fileName);
    assertNoSymlinkComponents(filePath, 'ZIP input path');
    const stats = lstatSync(filePath);
    assert(
      stats.isFile() && !stats.isSymbolicLink(),
      `ZIP input is invalid: ${fileName}`,
    );
    return {
      fileName,
      fileNameBytes: Buffer.from(fileName, 'utf8'),
      filePath,
      ...inspectFileWithCrc(filePath),
    };
  });
  assert(
    new Set(records.map(({ fileName }) => fileName.toLowerCase())).size ===
      records.length,
    'ZIP names collide portably',
  );
  const descriptor = openSync(zipPath, 'wx', 0o600);
  const central = [];
  let offset = 0;
  try {
    for (const record of records) {
      assert(
        record.bytes <= MAX_UINT32 && offset <= MAX_UINT32,
        'ZIP32 limit exceeded',
      );
      const local = localZipHeader(record);
      writeAll(descriptor, local);
      writeAll(descriptor, record.fileNameBytes);
      copyIntoDescriptor(record.filePath, descriptor);
      central.push({ ...record, localOffset: offset });
      offset += local.length + record.fileNameBytes.length + record.bytes;
    }
    const centralOffset = offset;
    for (const record of central) {
      const header = centralZipHeader(record);
      writeAll(descriptor, header);
      writeAll(descriptor, record.fileNameBytes);
      offset += header.length + record.fileNameBytes.length;
    }
    const centralBytes = offset - centralOffset;
    assert(
      offset <= MAX_UINT32 && centralBytes <= MAX_UINT32,
      'ZIP central directory exceeds ZIP32',
    );
    writeAll(
      descriptor,
      endOfCentralDirectory(records.length, centralBytes, centralOffset),
    );
  } finally {
    closeSync(descriptor);
  }
  return fileRecord(zipPath, 'platform-bundle');
}

export function safeExtractZip(archivePath, outputDirectory) {
  assert(existsSync(safeExtractorPath), 'safe ZIP extractor is missing');
  const result = spawnSync(
    'python3',
    [
      safeExtractorPath,
      `--archive=${path.resolve(archivePath)}`,
      `--output=${path.resolve(outputDirectory)}`,
      '--max-entries=128',
      `--max-total-bytes=${8 * 1024 ** 3}`,
      `--max-file-bytes=${MAX_ARTIFACT_BYTES}`,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  assert(
    result.status === 0,
    `safe ZIP extraction failed: ${(result.stderr || result.stdout).trim()}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('safe ZIP extractor returned invalid JSON');
  }
}

function evidenceReadme({
  repository,
  runAttempt,
  runId,
  sourceCommit,
  version,
}) {
  return `# CLODEx Community Observed evidence

This archive contains release validation manifests, payload SBOMs, Community
Observed warnings, per-platform bundle manifests and their internal checksums.
Installer bytes are deliberately published as separate release assets and are
bound by the root byte-audit report and release \`${COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS}\`.

- Version: \`${version}\`
- Source: \`${sourceCommit}\`
- Actions run: \`https://github.com/${repository}/actions/runs/${runId}\`
- Run attempt: \`${runAttempt}\`

No updater metadata or updater payload is included.
`;
}

function releaseNotesMarkdown({
  assets,
  repository,
  runAttempt,
  runId,
  sourceCommit,
  tag,
  version,
}) {
  const assetLines = assets
    .filter(
      ({ fileName }) => fileName !== COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS,
    )
    .map((asset) => `- \`${asset.fileName}\` — SHA-256 \`${asset.sha256}\``)
    .join('\n');
  return `## CLODEx Community Observed ${version}

Unsigned, non-official test prerelease built from exact canonical source
\`${sourceCommit}\` by [Actions run ${runId}](https://github.com/${repository}/actions/runs/${runId}), attempt ${runAttempt}.

Tag: \`${tag}\`

### Assets

${assetLines}
- \`${COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS}\` — canonical checksum file (self-excluded)

The checksum file covers the five unchanged installer assets and the evidence
archive. The evidence archive contains validation manifests, SBOMs, warnings,
internal bundle checksums and the byte-audit report.

These packages are unsigned/ad-hoc and not notarized. This prerelease is
excluded from the updater and official preview/canary/stable acceptance.
`;
}

function expectedInstallerAssets(version) {
  return PLATFORM_SPECS.flatMap((spec) =>
    expectedInstallerNames(version, spec).map((fileName) => ({
      architecture: spec.architecture,
      fileName,
      platform: spec.platform,
    })),
  ).sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function checksumContents(records) {
  return `${[...records]
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map(({ fileName, sha256 }) => `${sha256}  ${fileName}`)
    .join('\n')}\n`;
}

function assertSafeNewOutput(outputDirectory, inputRoot) {
  const output = assertNoSymlinkComponents(
    outputDirectory,
    'publication output',
  );
  const input = assertNoSymlinkComponents(inputRoot, 'artifact input');
  const relative = path.relative(input, output);
  assert(
    output !== path.parse(output).root,
    'publication output cannot be a filesystem root',
  );
  assert(
    output !== input &&
      (relative.startsWith('..') || path.isAbsolute(relative)),
    'publication output overlaps artifact input',
  );
  assert(!existsSync(output), 'publication output already exists');
  mkdirSync(output, { mode: 0o700, recursive: false });
  return output;
}

function byteAuditReport({
  actionsArtifacts,
  evidenceDirectories,
  installers,
  repository,
  runAttempt,
  runId,
  runNumber,
  sourceCommit,
  tag,
  version,
}) {
  return {
    schemaVersion: 1,
    artifactKind: COMMUNITY_OBSERVED_PUBLICATION_KIND,
    status: 'validated',
    distributionMode: COMMUNITY_OBSERVED_DISTRIBUTION_MODE,
    source: { repository, ref: SOURCE_REF, commit: sourceCommit },
    workflow: {
      name: EXPECTED_WORKFLOW_NAME,
      path: EXPECTED_WORKFLOW_PATH,
      runId,
      runNumber,
      runAttempt,
      url: `https://github.com/${repository}/actions/runs/${runId}`,
    },
    release: {
      version,
      tag,
      name: releaseName(version),
      draft: false,
      prerelease: true,
      makeLatest: false,
      official: false,
      assetContract: 'five-installers-evidence-checksums-v1',
      updateFeed: 'excluded',
      promotionEvidence: 'excluded',
    },
    actionsArtifacts,
    installers,
    evidence: {
      fileName: evidenceFileName(version),
      directories: evidenceDirectories,
      readmeFileName: COMMUNITY_OBSERVED_EVIDENCE_README,
    },
    checksums: {
      fileName: COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS,
      selfExcluded: true,
    },
  };
}

function copyBoundFile(sourcePath, destinationPath, expected) {
  assertNoSymlinkComponents(sourcePath, 'validated source asset');
  const source = fileRecord(sourcePath, expected.kind);
  assert(
    source.bytes === expected.bytes && source.sha256 === expected.sha256,
    `validated source bytes differ: ${expected.fileName}`,
  );
  copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  const copied = fileRecord(destinationPath, expected.kind);
  assert(
    copied.bytes === expected.bytes && copied.sha256 === expected.sha256,
    `copied bytes differ: ${expected.fileName}`,
  );
  return copied;
}

export function assemblePublicationCandidate({
  artifacts,
  inputRoot,
  outputDirectory,
  repository,
  runAttempt,
  runId,
  runNumber,
  sourceCommit,
  tag,
  version,
}) {
  assertRepository(repository);
  assertPositiveInteger(runId, 'run ID');
  assertPositiveInteger(runNumber, 'run number');
  assertPositiveInteger(runAttempt, 'run attempt');
  assertSourceCommit(sourceCommit);
  assertCanonicalVersion(version, runNumber);
  assertCanonicalTag(tag, version);
  assert(
    Array.isArray(artifacts) && artifacts.length === 4,
    'exactly four current-attempt Actions artifacts are required',
  );
  const root = assertNoSymlinkComponents(inputRoot, 'artifact input root');
  const output = assertSafeNewOutput(outputDirectory, root);
  const assetsDirectory = path.join(output, 'release-assets');
  const evidenceTree = path.join(output, '.evidence-staging');
  mkdirSync(assetsDirectory, { mode: 0o700 });
  mkdirSync(evidenceTree, { mode: 0o700 });
  const installers = [];
  const evidenceDirectories = [];
  try {
    for (const spec of PLATFORM_SPECS) {
      const sourceArtifactName = expectedArtifactName(
        spec,
        sourceCommit,
        runAttempt,
      );
      const artifact = artifacts.find(
        (candidate) => candidate.name === sourceArtifactName,
      );
      assert(artifact, `missing exact Actions artifact: ${sourceArtifactName}`);
      assertPositiveInteger(artifact.id, 'Actions artifact ID');
      assertPositiveBytes(artifact.sizeInBytes, 'Actions artifact size');
      assertSha256(artifact.digest, 'Actions artifact digest');
      const bundleDirectory = path.join(root, sourceArtifactName);
      const verification = validateObservedBundle(bundleDirectory, {
        ...spec,
        runNumber,
        sourceCommit,
        version,
      });
      const platformDirectoryName = platformKey(spec);
      const platformEvidenceDirectory = path.join(
        evidenceTree,
        platformDirectoryName,
      );
      mkdirSync(platformEvidenceDirectory, { mode: 0o700 });
      const evidenceFiles = [];
      for (const entry of verification.entries) {
        const sourcePath = path.join(bundleDirectory, entry.fileName);
        if (entry.kind === 'installer') {
          const copied = copyBoundFile(
            sourcePath,
            path.join(assetsDirectory, entry.fileName),
            entry,
          );
          installers.push({
            architecture: spec.architecture,
            bytes: copied.bytes,
            fileName: copied.fileName,
            kind: 'installer',
            platform: spec.platform,
            sha256: copied.sha256,
            sourceArtifactName,
          });
        } else {
          const copied = copyBoundFile(
            sourcePath,
            path.join(platformEvidenceDirectory, entry.fileName),
            entry,
          );
          evidenceFiles.push(copied);
        }
      }
      evidenceDirectories.push({
        architecture: spec.architecture,
        files: evidenceFiles.sort((left, right) =>
          left.fileName.localeCompare(right.fileName),
        ),
        name: platformDirectoryName,
        platform: spec.platform,
      });
    }
    installers.sort((left, right) =>
      left.fileName.localeCompare(right.fileName),
    );
    const expectedInstallerNamesList = expectedInstallerAssets(version).map(
      ({ fileName }) => fileName,
    );
    assert(
      installers.length === 5 &&
        JSON.stringify(installers.map(({ fileName }) => fileName)) ===
          JSON.stringify(expectedInstallerNamesList),
      'publication does not contain the exact five unchanged installers',
    );
    evidenceDirectories.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const actionsArtifacts = artifacts
      .map((artifact) => ({
        architecture: artifact.architecture,
        digest: `sha256:${artifact.digest}`,
        id: artifact.id,
        name: artifact.name,
        platform: artifact.platform,
        sizeInBytes: artifact.sizeInBytes,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const report = byteAuditReport({
      actionsArtifacts,
      evidenceDirectories,
      installers,
      repository,
      runAttempt,
      runId,
      runNumber,
      sourceCommit,
      tag,
      version,
    });
    writeFileSync(
      path.join(evidenceTree, COMMUNITY_OBSERVED_BYTE_AUDIT_REPORT),
      canonicalJson(report),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    writeFileSync(
      path.join(evidenceTree, COMMUNITY_OBSERVED_EVIDENCE_README),
      evidenceReadme({ repository, runAttempt, runId, sourceCommit, version }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const evidenceEntries = [];
    for (const directory of evidenceDirectories) {
      for (const entry of directory.files) {
        evidenceEntries.push({
          archivePath: `${directory.name}/${entry.fileName}`,
          sourcePath: path.join(evidenceTree, directory.name, entry.fileName),
        });
      }
    }
    for (const rootFile of [
      COMMUNITY_OBSERVED_BYTE_AUDIT_REPORT,
      COMMUNITY_OBSERVED_EVIDENCE_README,
    ]) {
      evidenceEntries.push({
        archivePath: rootFile,
        sourcePath: path.join(evidenceTree, rootFile),
      });
    }
    const evidence = createDeterministicZip(
      path.join(assetsDirectory, evidenceFileName(version)),
      evidenceTree,
      evidenceEntries,
    );
    rmSync(evidenceTree, { force: true, recursive: true });
    const checksumInputs = [
      ...installers.map(({ bytes, fileName, sha256 }) => ({
        bytes,
        fileName,
        sha256,
      })),
      evidence,
    ].sort((left, right) => left.fileName.localeCompare(right.fileName));
    writeFileSync(
      path.join(assetsDirectory, COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS),
      checksumContents(checksumInputs),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const notes = releaseNotesMarkdown({
      assets: checksumInputs,
      repository,
      runAttempt,
      runId,
      sourceCommit,
      tag,
      version,
    });
    writeFileSync(path.join(output, COMMUNITY_OBSERVED_RELEASE_NOTES), notes, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const verified = verifyPublicationCandidate({
      candidateDirectory: output,
      repository,
      runId,
      sourceCommit,
      tag,
    });
    return { ...verified, outputDirectory: output };
  } catch (error) {
    rmSync(output, { force: true, recursive: true });
    throw error;
  }
}

function validateActionArtifactRecords(records, report) {
  assert(
    Array.isArray(records) && records.length === 4,
    'report must bind four Actions artifacts',
  );
  const expected = PLATFORM_SPECS.map((spec) => ({
    ...spec,
    name: expectedArtifactName(
      spec,
      report.source.commit,
      report.workflow.runAttempt,
    ),
  })).sort((left, right) => left.name.localeCompare(right.name));
  for (const [index, record] of records.entries()) {
    assertExactKeys(
      record,
      ['architecture', 'digest', 'id', 'name', 'platform', 'sizeInBytes'],
      'Actions artifact record',
    );
    const identity = expected[index];
    assert(
      record.name === identity.name &&
        record.platform === identity.platform &&
        record.architecture === identity.architecture &&
        Number.isSafeInteger(record.id) &&
        record.id > 0 &&
        /^sha256:[a-f0-9]{64}$/u.test(record.digest) &&
        Number.isSafeInteger(record.sizeInBytes) &&
        record.sizeInBytes > 0,
      'Actions artifact record identity is invalid',
    );
  }
}

export function validateByteAuditReport(report, expected) {
  assertExactKeys(
    report,
    [
      'actionsArtifacts',
      'artifactKind',
      'checksums',
      'distributionMode',
      'evidence',
      'installers',
      'release',
      'schemaVersion',
      'source',
      'status',
      'workflow',
    ],
    'byte-audit report',
  );
  assert(
    report.schemaVersion === 1 &&
      report.artifactKind === COMMUNITY_OBSERVED_PUBLICATION_KIND &&
      report.status === 'validated' &&
      report.distributionMode === COMMUNITY_OBSERVED_DISTRIBUTION_MODE,
    'byte-audit report header is invalid',
  );
  assert(
    report.source?.repository === expected.repository &&
      report.source?.ref === SOURCE_REF &&
      report.source?.commit === expected.sourceCommit,
    'byte-audit source identity differs',
  );
  assert(
    report.workflow?.name === EXPECTED_WORKFLOW_NAME &&
      report.workflow?.path === EXPECTED_WORKFLOW_PATH &&
      report.workflow?.runId === expected.runId &&
      Number.isSafeInteger(report.workflow?.runNumber) &&
      report.workflow.runNumber > 0 &&
      Number.isSafeInteger(report.workflow?.runAttempt) &&
      report.workflow.runAttempt > 0 &&
      report.workflow?.url ===
        `https://github.com/${expected.repository}/actions/runs/${expected.runId}`,
    'byte-audit workflow identity differs',
  );
  assertCanonicalVersion(report.release?.version, report.workflow.runNumber);
  assertCanonicalTag(report.release?.tag, report.release.version);
  assert(
    report.release.tag === expected.tag &&
      report.release.name === releaseName(report.release.version) &&
      report.release.draft === false &&
      report.release.prerelease === true &&
      report.release.makeLatest === false &&
      report.release.official === false &&
      report.release.assetContract ===
        'five-installers-evidence-checksums-v1' &&
      report.release.updateFeed === 'excluded' &&
      report.release.promotionEvidence === 'excluded',
    'byte-audit release identity is invalid',
  );
  validateActionArtifactRecords(report.actionsArtifacts, report);
  assert(
    report.evidence?.fileName === evidenceFileName(report.release.version) &&
      report.evidence?.readmeFileName === COMMUNITY_OBSERVED_EVIDENCE_README &&
      Array.isArray(report.evidence?.directories) &&
      report.evidence.directories.length === 4,
    'byte-audit evidence identity is invalid',
  );
  const expectedDirectories = PLATFORM_SPECS.map((spec) => ({
    ...spec,
    name: platformKey(spec),
  })).sort((left, right) => left.name.localeCompare(right.name));
  for (const [index, directory] of report.evidence.directories.entries()) {
    assertExactKeys(
      directory,
      ['architecture', 'files', 'name', 'platform'],
      'evidence directory record',
    );
    const identity = expectedDirectories[index];
    assert(
      directory.name === identity.name &&
        directory.platform === identity.platform &&
        directory.architecture === identity.architecture &&
        Array.isArray(directory.files),
      'evidence directory record identity is invalid',
    );
  }
  assert(
    report.checksums?.fileName === COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS &&
      report.checksums?.selfExcluded === true,
    'byte-audit checksum identity is invalid',
  );
  const expectedInstallers = expectedInstallerAssets(report.release.version);
  assert(
    Array.isArray(report.installers) && report.installers.length === 5,
    'byte-audit report must bind five installers',
  );
  for (const [index, installer] of report.installers.entries()) {
    const identity = expectedInstallers[index];
    assert(
      installer.fileName === identity.fileName &&
        installer.platform === identity.platform &&
        installer.architecture === identity.architecture &&
        installer.kind === 'installer' &&
        Number.isSafeInteger(installer.bytes) &&
        installer.bytes > 0 &&
        SHA256_PATTERN.test(installer.sha256) &&
        installer.sourceArtifactName ===
          expectedArtifactName(
            identity,
            report.source.commit,
            report.workflow.runAttempt,
          ),
      'byte-audit installer record is invalid',
    );
  }
  return report;
}

function validateEvidenceDirectory(
  directory,
  assetsDirectory,
  directoryRecord,
  report,
) {
  const root = assertNoSymlinkComponents(
    directory,
    'evidence platform directory',
  );
  const names = readdirSync(root).sort((left, right) =>
    left.localeCompare(right),
  );
  const records = directoryRecord.files;
  assert(
    Array.isArray(records) && records.length > 0,
    'evidence directory records are missing',
  );
  const spec = {
    platform: directoryRecord.platform,
    architecture: directoryRecord.architecture,
  };
  const expectedKinds = new Map([
    ...expectedSbomNames(report.release.version, spec).map((name) => [
      name,
      'sbom',
    ]),
    [
      `validation-${directoryRecord.name}-${report.release.version}.json`,
      'validation',
    ],
    [BUNDLE_WARNING, 'warning'],
    [BUNDLE_MANIFEST, 'bundle-manifest'],
    [BUNDLE_CHECKSUMS, 'checksums'],
  ]);
  const expectedEvidenceNames = [...expectedKinds.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  assert(
    JSON.stringify(names) === JSON.stringify(expectedEvidenceNames) &&
      JSON.stringify(records.map(({ fileName }) => fileName)) ===
        JSON.stringify(expectedEvidenceNames),
    `evidence directory file set differs: ${directoryRecord.name}`,
  );
  for (const record of records) {
    assertExactKeys(
      record,
      ['bytes', 'fileName', 'kind', 'sha256'],
      'evidence file record',
    );
    assertSafeFileName(record.fileName, 'evidence file');
    assertNoUpdaterAsset(record.fileName);
    assert(
      expectedKinds.get(record.fileName) === record.kind &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes > 0 &&
        SHA256_PATTERN.test(record.sha256),
      `evidence file record is invalid: ${record.fileName}`,
    );
    const actual = fileRecord(path.join(root, record.fileName), record.kind);
    assert(
      actual.bytes === record.bytes && actual.sha256 === record.sha256,
      `evidence bytes differ: ${directoryRecord.name}/${record.fileName}`,
    );
  }
  const manifest = readJsonFile(
    path.join(root, BUNDLE_MANIFEST),
    'evidence bundle manifest',
  );
  assert(
    manifest.sourceCommit === report.source.commit &&
      manifest.version === report.release.version &&
      manifest.platform === spec.platform &&
      manifest.architecture === spec.architecture &&
      manifest.distributionMode === COMMUNITY_OBSERVED_DISTRIBUTION_MODE &&
      manifest.status === 'validated' &&
      JSON.stringify(manifest.telemetry) ===
        JSON.stringify(expectedTelemetry()) &&
      manifest.updater?.status === 'excluded',
    'evidence bundle manifest identity is invalid',
  );
  const installerByName = new Map(
    report.installers.map((entry) => [entry.fileName, entry]),
  );
  const evidenceByName = new Map(
    records.map((entry) => [entry.fileName, entry]),
  );
  const expectedManifestNames = [
    ...expectedInstallerNames(report.release.version, spec),
    ...expectedSbomNames(report.release.version, spec),
    `validation-${directoryRecord.name}-${report.release.version}.json`,
    BUNDLE_WARNING,
  ].sort((left, right) => left.localeCompare(right));
  assert(
    Array.isArray(manifest.files) &&
      JSON.stringify(manifest.files.map(({ fileName }) => fileName)) ===
        JSON.stringify(expectedManifestNames),
    'evidence bundle manifest file set differs',
  );
  for (const record of manifest.files) {
    const bound =
      installerByName.get(record.fileName) ??
      evidenceByName.get(record.fileName);
    assert(
      bound &&
        bound.bytes === record.bytes &&
        bound.sha256 === record.sha256 &&
        bound.kind === record.kind,
      `evidence bundle manifest record differs: ${record.fileName}`,
    );
  }
  const checksumRecords = parseChecksums(
    readFileSync(path.join(root, BUNDLE_CHECKSUMS), 'utf8'),
    'evidence bundle SHA256SUMS',
  );
  assert(
    JSON.stringify(checksumRecords.map(({ fileName }) => fileName)) ===
      JSON.stringify(
        [...expectedManifestNames, BUNDLE_MANIFEST].sort((left, right) =>
          left.localeCompare(right),
        ),
      ),
    'evidence bundle checksum file set differs',
  );
  for (const checksum of checksumRecords) {
    const localPath = path.join(root, checksum.fileName);
    const installer = installerByName.get(checksum.fileName);
    const actualSha = installer
      ? sha256File(path.join(assetsDirectory, checksum.fileName))
      : sha256File(localPath);
    assert(
      actualSha === checksum.sha256,
      `evidence internal checksum mismatch: ${checksum.fileName}`,
    );
  }
  const validationName = `validation-${directoryRecord.name}-${report.release.version}.json`;
  const validation = readJsonFile(
    path.join(root, validationName),
    'evidence validation manifest',
  );
  validateBoundaryEvidence(validation, {
    ...spec,
    sourceCommit: report.source.commit,
    version: report.release.version,
  });
  for (const sbomName of expectedSbomNames(report.release.version, spec)) {
    validateSbom(path.join(root, sbomName), sbomName);
  }
  const warning = readFileSync(path.join(root, BUNDLE_WARNING), 'utf8');
  for (const claim of [
    report.source.commit,
    report.release.version,
    'no trusted operating-system distribution signature',
    'Auto-update metadata and updater payloads are intentionally excluded',
  ]) {
    assert(
      warning.includes(claim),
      `evidence warning is missing claim: ${claim}`,
    );
  }
}

export function verifyPublicationCandidate({
  candidateDirectory,
  repository,
  runId,
  sourceCommit,
  tag,
}) {
  assertRepository(repository);
  assertPositiveInteger(runId, 'run ID');
  assertSourceCommit(sourceCommit);
  const root = assertNoSymlinkComponents(
    candidateDirectory,
    'publication candidate',
  );
  const entries = readdirSync(root).sort();
  assert(
    JSON.stringify(entries) ===
      JSON.stringify(
        [COMMUNITY_OBSERVED_RELEASE_NOTES, 'release-assets'].sort(),
      ),
    'publication candidate root has unexpected entries',
  );
  const assetsDirectory = assertNoSymlinkComponents(
    path.join(root, 'release-assets'),
    'release assets',
  );
  const assetStats = lstatSync(assetsDirectory);
  assert(
    assetStats.isDirectory() && !assetStats.isSymbolicLink(),
    'release-assets is invalid',
  );
  const assetNames = readdirSync(assetsDirectory).sort((left, right) =>
    left.localeCompare(right),
  );
  assert(
    assetNames.length === 7,
    'publication candidate must contain exactly seven assets',
  );
  const checksumName = COMMUNITY_OBSERVED_PUBLICATION_CHECKSUMS;
  const evidenceName = assetNames.find((name) =>
    name.endsWith('-evidence.zip'),
  );
  assert(evidenceName, 'publication evidence archive is missing');
  for (const assetName of assetNames) {
    assertSafeFileName(assetName, 'release asset');
    if (assetName.endsWith('.zip')) {
      assert(assetName === evidenceName, 'unexpected ZIP release asset');
    } else {
      assertNoUpdaterAsset(assetName);
    }
    const stats = lstatSync(path.join(assetsDirectory, assetName));
    assert(
      stats.isFile() && !stats.isSymbolicLink() && stats.size > 0,
      `release asset is invalid: ${assetName}`,
    );
    assert(
      stats.size < 2 * 1024 ** 3,
      `release asset exceeds GitHub's 2 GiB limit: ${assetName}`,
    );
  }
  const extractionRoot = path.join(root, `.evidence-verify-${process.pid}`);
  const extraction = safeExtractZip(
    path.join(assetsDirectory, evidenceName),
    extractionRoot,
  );
  try {
    assert(extraction.entryCount > 2, 'evidence archive is unexpectedly empty');
    const report = validateByteAuditReport(
      readJsonFile(
        path.join(extractionRoot, COMMUNITY_OBSERVED_BYTE_AUDIT_REPORT),
        'byte-audit report',
      ),
      { repository, runId, sourceCommit, tag },
    );
    assert(
      evidenceName === report.evidence.fileName,
      'evidence archive name differs from report',
    );
    const expectedNames = [
      ...report.installers.map(({ fileName }) => fileName),
      report.evidence.fileName,
      checksumName,
    ].sort((left, right) => left.localeCompare(right));
    assert(
      JSON.stringify(assetNames) === JSON.stringify(expectedNames),
      'release asset set differs from the exact contract',
    );
    for (const installer of report.installers) {
      const actual = fileRecord(
        path.join(assetsDirectory, installer.fileName),
        'installer',
      );
      assert(
        actual.bytes === installer.bytes && actual.sha256 === installer.sha256,
        `installer bytes differ: ${installer.fileName}`,
      );
    }
    for (const directoryRecord of report.evidence.directories) {
      assert(
        directoryRecord.name === platformKey(directoryRecord) &&
          PLATFORM_SPECS.some(
            (spec) => platformKey(spec) === directoryRecord.name,
          ),
        'evidence directory identity is invalid',
      );
      validateEvidenceDirectory(
        path.join(extractionRoot, directoryRecord.name),
        assetsDirectory,
        directoryRecord,
        report,
      );
    }
    const readme = readFileSync(
      path.join(extractionRoot, COMMUNITY_OBSERVED_EVIDENCE_README),
      'utf8',
    );
    assert(
      readme ===
        evidenceReadme({
          repository,
          runAttempt: report.workflow.runAttempt,
          runId,
          sourceCommit,
          version: report.release.version,
        }),
      'evidence README differs',
    );
    const checksumRecords = parseChecksums(
      readFileSync(path.join(assetsDirectory, checksumName), 'utf8'),
      'publication SHA256SUMS.txt',
    );
    const coveredNames = assetNames.filter((name) => name !== checksumName);
    assert(
      JSON.stringify(checksumRecords.map(({ fileName }) => fileName)) ===
        JSON.stringify(coveredNames),
      'publication checksum file must cover exactly five installers and evidence',
    );
    for (const checksum of checksumRecords) {
      assert(
        sha256File(path.join(assetsDirectory, checksum.fileName)) ===
          checksum.sha256,
        `publication checksum mismatch: ${checksum.fileName}`,
      );
    }
    const assetsForNotes = checksumRecords.map((record) => ({ ...record }));
    const notes = readFileSync(
      path.join(root, COMMUNITY_OBSERVED_RELEASE_NOTES),
      'utf8',
    );
    const expectedNotes = releaseNotesMarkdown({
      assets: assetsForNotes,
      repository,
      runAttempt: report.workflow.runAttempt,
      runId,
      sourceCommit,
      tag,
      version: report.release.version,
    });
    assert(
      notes === expectedNotes,
      'release notes differ from canonical identity',
    );
    return {
      assetNames,
      assetsDirectory,
      manifest: report,
      notes,
      notesPath: path.join(root, COMMUNITY_OBSERVED_RELEASE_NOTES),
      releaseName: report.release.name,
      tag: report.release.tag,
      version: report.release.version,
    };
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true });
  }
}

export function validateObservedRun(
  run,
  workflow,
  { repository, runId, sourceCommit },
) {
  assertRepository(repository);
  assertPositiveInteger(runId, 'run ID');
  assertSourceCommit(sourceCommit);
  assert(
    run?.id === runId &&
      run?.repository?.full_name === repository &&
      run?.name === `Community observed build: main @ ${sourceCommit}` &&
      run?.path === EXPECTED_WORKFLOW_PATH &&
      Number.isSafeInteger(run?.workflow_id) &&
      workflow?.id === run.workflow_id &&
      workflow?.name === EXPECTED_WORKFLOW_NAME &&
      workflow?.path === EXPECTED_WORKFLOW_PATH &&
      workflow?.state === 'active' &&
      run?.event === 'workflow_dispatch' &&
      run?.head_branch === 'main' &&
      run?.head_sha === sourceCommit &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      run?.html_url ===
        `https://github.com/${repository}/actions/runs/${runId}`,
    'Actions run is not an exact successful Community Observed build',
  );
  assertPositiveInteger(run.run_number, 'run number');
  assertPositiveInteger(run.run_attempt, 'run attempt');
  return run;
}

export function normalizeObservedArtifacts(records, expected) {
  assert(Array.isArray(records), 'Actions artifact response is invalid');
  const expectedByName = new Map(
    PLATFORM_SPECS.map((spec) => [
      expectedArtifactName(spec, expected.sourceCommit, expected.runAttempt),
      spec,
    ]),
  );
  const currentAttemptRecords = records.filter((record) =>
    expectedByName.has(record?.name),
  );
  assert(
    currentAttemptRecords.length === 4,
    'successful run must expose exactly four current-attempt artifacts',
  );
  const ids = new Set();
  const digests = new Set();
  const normalized = currentAttemptRecords.map((record) => {
    const spec = expectedByName.get(record?.name);
    assert(
      spec,
      `unexpected Actions artifact: ${String(record?.name ?? '<missing>')}`,
    );
    assertPositiveInteger(record.id, 'Actions artifact ID');
    assert(!ids.has(record.id), 'duplicate Actions artifact ID');
    ids.add(record.id);
    assert(
      record.expired === false,
      `Actions artifact is expired: ${record.name}`,
    );
    assertPositiveBytes(
      record.size_in_bytes,
      `Actions artifact ${record.name} size`,
    );
    assert(
      record.archive_download_url ===
        `${API_ORIGIN}/repos/${expected.repository}/actions/artifacts/${record.id}/zip`,
      `Actions artifact download URL is not canonical: ${record.name}`,
    );
    assert(
      record.workflow_run?.id === expected.runId &&
        record.workflow_run?.head_sha === expected.sourceCommit &&
        record.workflow_run?.head_branch === 'main',
      `Actions artifact workflow identity differs: ${record.name}`,
    );
    const digestMatch = /^sha256:([a-f0-9]{64})$/u.exec(record.digest ?? '');
    assert(digestMatch, `Actions artifact digest is invalid: ${record.name}`);
    assert(
      !digests.has(digestMatch[1]),
      'Actions artifact digests unexpectedly collide',
    );
    digests.add(digestMatch[1]);
    return {
      architecture: spec.architecture,
      digest: digestMatch[1],
      id: record.id,
      name: record.name,
      platform: spec.platform,
      sizeInBytes: record.size_in_bytes,
    };
  });
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

export class GitHubActionsReadApi {
  constructor({
    fetchImpl = globalThis.fetch,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  } = {}) {
    assert(typeof fetchImpl === 'function', 'fetch implementation is required');
    assert(
      typeof token === 'string' && token.length > 0 && !/[\r\n\0]/u.test(token),
      'GH_TOKEN is required',
    );
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  async requestJson(endpoint) {
    const response = await this.fetchImpl(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'clodex-community-observed-publication-verifier',
        'X-GitHub-Api-Version': API_VERSION,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    assert(
      response.status === 200,
      `GitHub API GET failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
    try {
      return JSON.parse(text);
    } catch {
      fail('GitHub API returned invalid JSON');
    }
  }

  getRun(repository, runId) {
    return this.requestJson(
      `${API_ORIGIN}/repos/${assertRepository(repository)}/actions/runs/${assertPositiveInteger(runId, 'run ID')}`,
    );
  }

  getWorkflow(repository, workflowId) {
    return this.requestJson(
      `${API_ORIGIN}/repos/${assertRepository(repository)}/actions/workflows/${assertPositiveInteger(workflowId, 'workflow ID')}`,
    );
  }

  async listRunArtifacts(repository, runId) {
    const artifacts = [];
    for (let page = 1; page <= 100; page += 1) {
      const endpoint = new URL(
        `/repos/${assertRepository(repository)}/actions/runs/${assertPositiveInteger(runId, 'run ID')}/artifacts`,
        API_ORIGIN,
      );
      endpoint.searchParams.set('per_page', '100');
      endpoint.searchParams.set('page', String(page));
      const response = await this.requestJson(endpoint);
      assert(
        Number.isSafeInteger(response?.total_count) &&
          Array.isArray(response.artifacts),
        'Actions run artifact response is invalid',
      );
      artifacts.push(...response.artifacts);
      if (artifacts.length >= response.total_count) return artifacts;
    }
    fail('Actions artifact pagination exceeded its fail-closed limit');
  }

  async downloadArtifact(repository, artifact, destinationPath) {
    const endpoint = `${API_ORIGIN}/repos/${assertRepository(repository)}/actions/artifacts/${assertPositiveInteger(artifact.id, 'artifact ID')}/zip`;
    const redirect = await this.fetchImpl(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'clodex-community-observed-publication-verifier',
        'X-GitHub-Api-Version': API_VERSION,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    assert(
      [302, 303, 307].includes(redirect.status),
      'artifact API did not return a bounded redirect',
    );
    const location = redirect.headers.get('location');
    let target;
    try {
      target = new URL(location);
    } catch {
      fail('artifact API returned an invalid redirect URL');
    }
    assert(
      target.protocol === 'https:' &&
        !target.username &&
        !target.password &&
        !target.hash &&
        REDIRECT_HOST_PATTERNS.some((pattern) => pattern.test(target.hostname)),
      'artifact API redirect host is not allowlisted',
    );
    const response = await this.fetchImpl(target, {
      headers: {
        'User-Agent': 'clodex-community-observed-publication-verifier',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15 * 60_000),
    });
    assert(
      response.status === 200 && response.body,
      `artifact download failed with HTTP ${response.status}`,
    );
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      assert(
        Number(declaredLength) === artifact.sizeInBytes,
        'artifact Content-Length differs from API metadata',
      );
    }
    const hash = createHash('sha256');
    let observed = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        observed += chunk.length;
        if (observed > artifact.sizeInBytes) {
          callback(new Error('artifact download exceeded its API size'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
    );
    assert(
      observed === artifact.sizeInBytes,
      'artifact archive size differs from API metadata',
    );
    assert(
      hash.digest('hex') === artifact.digest,
      'artifact archive digest differs from API metadata',
    );
    return destinationPath;
  }
}

function readBaseVersion(sourceCommit) {
  let pkg;
  try {
    pkg = JSON.parse(
      execFileSync(
        'git',
        [
          'show',
          `${assertSourceCommit(sourceCommit)}:apps/browser/package.json`,
        ],
        { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      ),
    );
  } catch (error) {
    fail(
      `cannot read browser package metadata from exact source commit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assert(
    /^\d+\.\d+\.\d+$/u.test(pkg.version ?? ''),
    'browser base version is not plain SemVer',
  );
  return pkg.version;
}

export async function preparePublicationFromRun({
  api,
  outputDirectory,
  repository,
  runId,
  sourceCommit,
  tag,
}) {
  const normalizedRepository = assertRepository(repository);
  const normalizedRunId = assertPositiveInteger(runId, 'run ID');
  const normalizedSource = assertSourceCommit(sourceCommit);
  const runRecord = await api.getRun(normalizedRepository, normalizedRunId);
  const run = validateObservedRun(
    runRecord,
    await api.getWorkflow(normalizedRepository, runRecord.workflow_id),
    {
      repository: normalizedRepository,
      runId: normalizedRunId,
      sourceCommit: normalizedSource,
    },
  );
  const taggedVersion = TAG_PATTERN.exec(tag ?? '')?.[1];
  assert(taggedVersion, 'observed release tag is invalid');
  const version = taggedVersion;
  assertCanonicalVersion(version, run.run_number);
  assertCanonicalTag(tag, version);
  assert(
    version ===
      `${readBaseVersion(normalizedSource)}-communityobserved${run.run_number}`,
    'observed tag version differs from exact source package metadata and run number',
  );
  const artifactRecords = normalizeObservedArtifacts(
    await api.listRunArtifacts(normalizedRepository, normalizedRunId),
    {
      repository: normalizedRepository,
      runAttempt: run.run_attempt,
      runId: normalizedRunId,
      sourceCommit: normalizedSource,
    },
  );
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'clodex-observed-publication-'),
  );
  try {
    for (const artifact of artifactRecords) {
      const archivePath = path.join(temporaryRoot, `${artifact.name}.zip`);
      const extractionPath = path.join(temporaryRoot, artifact.name);
      await api.downloadArtifact(normalizedRepository, artifact, archivePath);
      safeExtractZip(archivePath, extractionPath);
      rmSync(archivePath, { force: true });
    }
    return assemblePublicationCandidate({
      artifacts: artifactRecords,
      inputRoot: temporaryRoot,
      outputDirectory,
      repository: normalizedRepository,
      runAttempt: run.run_attempt,
      runId: normalizedRunId,
      runNumber: run.run_number,
      sourceCommit: normalizedSource,
      tag,
      version,
    });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function parseArguments(values) {
  const [command, ...argumentsList] = values;
  assert(
    ['prepare', 'verify'].includes(command),
    'command must be prepare or verify',
  );
  const options = { command };
  const allowed = new Set([
    'candidate',
    'github-output',
    'output',
    'repository',
    'run-id',
    'source-commit',
    'tag',
  ]);
  for (const value of argumentsList) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(value);
    assert(match && allowed.has(match[1]), `invalid argument: ${value}`);
    const [, name, optionValue] = match;
    assert(optionValue.length > 0, `missing value for --${name}`);
    assert(!Object.hasOwn(options, name), `duplicate argument: --${name}`);
    options[name] = optionValue;
  }
  return options;
}

async function writeOutputs(outputPath, result) {
  if (!outputPath) return;
  await appendFile(
    path.resolve(outputPath),
    [
      `release_name=${result.releaseName}`,
      `release_tag=${result.tag}`,
      `version=${result.version}`,
      `asset_count=${result.assetNames.length}`,
      '',
    ].join('\n'),
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repository = options.repository ?? EXPECTED_REPOSITORY;
  const runId = Number(options['run-id']);
  const sourceCommit = options['source-commit'];
  const tag = options.tag;
  let result;
  if (options.command === 'prepare') {
    for (const required of ['output', 'run-id', 'source-commit', 'tag']) {
      assert(options[required], `--${required} is required`);
    }
    result = await preparePublicationFromRun({
      api: new GitHubActionsReadApi(),
      outputDirectory: path.resolve(options.output),
      repository,
      runId,
      sourceCommit,
      tag,
    });
  } else {
    for (const required of ['candidate', 'run-id', 'source-commit', 'tag']) {
      assert(options[required], `--${required} is required`);
    }
    result = verifyPublicationCandidate({
      candidateDirectory: path.resolve(options.candidate),
      repository,
      runId,
      sourceCommit,
      tag,
    });
  }
  await writeOutputs(options['github-output'], result);
  console.log(
    `[community-observed-publication] verified ${result.assetNames.length} release assets for ${result.tag}`,
  );
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(
      `[community-observed-publication] FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
