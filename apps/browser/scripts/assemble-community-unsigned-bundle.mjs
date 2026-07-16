#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMUNITY_UNSIGNED_DISTRIBUTION_MODE = 'community-unsigned';
export const COMMUNITY_UNSIGNED_WARNING_CODE =
  'CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST';
export const COMMUNITY_UNSIGNED_WARNING_FILE = 'COMMUNITY-UNSIGNED-WARNING.md';
export const COMMUNITY_UNSIGNED_MANIFEST_FILE =
  'community-unsigned-manifest.json';
export const COMMUNITY_UNSIGNED_CHECKSUMS_FILE = 'SHA256SUMS';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDirectory = path.resolve(scriptDirectory, '..');
const defaultSourceRoot = path.join(
  browserDirectory,
  'out',
  COMMUNITY_UNSIGNED_DISTRIBUTION_MODE,
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const COMMUNITY_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-community(?:0|[1-9]\d*)$/u;
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/u;
const SUPPORTED_PLATFORMS = new Set(['linux', 'macos', 'windows']);
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);

const FORBIDDEN_UPDATER_PATTERNS = Object.freeze([
  { code: 'macos-update-zip', pattern: /\.zip$/iu },
  { code: 'squirrel-package', pattern: /\.nupkg$/iu },
  { code: 'squirrel-releases', pattern: /^RELEASES(?:-|$)/u },
  { code: 'electron-updater-blockmap', pattern: /\.blockmap$/iu },
  {
    code: 'electron-updater-channel-manifest',
    pattern: /^(?:latest|app-update)(?:[-.].*)?\.ya?ml$/iu,
  },
  { code: 'delta-update', pattern: /(?:^|[-_.])delta(?:[-_.]|$)/iu },
]);

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is not readable JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertSafeFileName(value, label = 'file') {
  const fileName = String(value ?? '');
  if (
    !fileName ||
    fileName !== path.basename(fileName) ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    !SAFE_FILE_NAME_PATTERN.test(fileName)
  ) {
    throw new Error(
      `${label} has an unsafe filename: ${fileName || '<empty>'}`,
    );
  }
  return fileName;
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertRegularSourceFile(filePath, allowedSourceRoot, label) {
  if (!existsSync(filePath))
    throw new Error(`${label} is missing: ${filePath}`);
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file: ${filePath}`);
  }
  const realFilePath = realpathSync(filePath);
  const realSourceRoot = realpathSync(allowedSourceRoot);
  if (!isPathWithin(realSourceRoot, realFilePath)) {
    throw new Error(
      `${label} escapes the community build output root: ${filePath}`,
    );
  }
  return { filePath: realFilePath, stats };
}

function normalizeArtifactEvidence(manifest) {
  const candidates = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : isObject(manifest.artifacts)
      ? Object.values(manifest.artifacts)
      : [];
  const byFileName = new Map();
  for (const artifact of candidates) {
    if (
      !isObject(artifact) ||
      typeof artifact.path !== 'string' ||
      !SHA256_PATTERN.test(String(artifact.sha256 ?? '')) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0
    ) {
      continue;
    }
    const fileName = assertSafeFileName(
      path.basename(artifact.path.replaceAll('\\', '/')),
      'artifact evidence',
    );
    if (byFileName.has(fileName)) {
      throw new Error(`Duplicate artifact evidence filename: ${fileName}`);
    }
    byFileName.set(fileName, {
      bytes: artifact.bytes,
      fileName,
      path: artifact.path,
      sha256: artifact.sha256,
    });
  }
  return byFileName;
}

function inspectPublicationAssets(manifest) {
  if (
    manifest.publication?.status !== 'validated' ||
    !Array.isArray(manifest.publication.assets) ||
    manifest.publication.assets.length === 0
  ) {
    throw new Error('Validation manifest has no validated publication assets');
  }
  const evidence = normalizeArtifactEvidence(manifest);
  const names = new Set();
  return manifest.publication.assets.map((asset) => {
    if (!isObject(asset))
      throw new Error('Publication asset record is invalid');
    const fileName = assertSafeFileName(asset.fileName, 'publication asset');
    if (names.has(fileName)) {
      throw new Error(`Duplicate publication asset filename: ${fileName}`);
    }
    names.add(fileName);
    if (
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !SHA256_PATTERN.test(String(asset.sha256 ?? ''))
    ) {
      throw new Error(`Publication asset metadata is invalid: ${fileName}`);
    }
    const artifact = evidence.get(fileName);
    if (
      !artifact ||
      artifact.bytes !== asset.bytes ||
      artifact.sha256 !== asset.sha256
    ) {
      throw new Error(
        `Publication asset is not bound to matching artifact evidence: ${fileName}`,
      );
    }
    return artifact;
  });
}

function updaterExclusion(fileName) {
  return FORBIDDEN_UPDATER_PATTERNS.find(({ pattern }) =>
    pattern.test(fileName),
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function classifyAsset({ architecture, platform, version }, fileName) {
  const excluded = updaterExclusion(fileName);
  if (excluded) return { kind: 'excluded-updater', reason: excluded.code };
  const baseName = 'clodex-community-unsigned';
  const escapedBase = escapeRegex(baseName);
  const escapedVersion = escapeRegex(version);
  const escapedArch = escapeRegex(architecture);
  if (platform === 'macos') {
    if (fileName === `${baseName}-${version}-${architecture}.dmg`) {
      return { kind: 'installer' };
    }
    if (fileName === `macos-${architecture}-${version}.cdx.json`) {
      return { kind: 'sbom' };
    }
  } else if (platform === 'windows') {
    if (fileName === `${baseName}-${version}-${architecture}-setup.exe`) {
      return { kind: 'installer' };
    }
    if (fileName === `windows-${architecture}-${version}-nupkg.cdx.json`) {
      return { kind: 'sbom' };
    }
  } else {
    const debArch = architecture === 'x64' ? 'amd64' : 'arm64';
    const rpmArch = architecture === 'x64' ? 'x86_64' : 'aarch64';
    if (
      new RegExp(
        `^${escapedBase}_${escapedVersion}_${escapeRegex(debArch)}\\.deb$`,
        'u',
      ).test(fileName) ||
      new RegExp(
        `^${escapedBase}-${escapedVersion}-[1-9][0-9]*\\.${escapeRegex(rpmArch)}\\.rpm$`,
        'u',
      ).test(fileName)
    ) {
      return { kind: 'installer' };
    }
    if (
      new RegExp(
        `^linux-${escapedArch}-${escapedVersion}-(?:deb|rpm)\\.cdx\\.json$`,
        'u',
      ).test(fileName)
    ) {
      return { kind: 'sbom' };
    }
  }
  throw new Error(
    `Unexpected community publication asset for ${platform}: ${fileName}`,
  );
}

function assertExpectedAssetSet(platform, selectedAssets) {
  const installers = selectedAssets.filter(
    (asset) => asset.kind === 'installer',
  );
  const sboms = selectedAssets.filter((asset) => asset.kind === 'sbom');
  if (platform === 'linux') {
    const extensions = installers.map(({ fileName }) =>
      path.extname(fileName).toLowerCase(),
    );
    if (
      installers.length !== 2 ||
      !extensions.includes('.deb') ||
      !extensions.includes('.rpm') ||
      sboms.length !== 2
    ) {
      throw new Error(
        'Linux community bundle requires exactly one DEB, one RPM, and two payload SBOMs',
      );
    }
    return;
  }
  if (installers.length !== 1 || sboms.length !== 1) {
    throw new Error(
      `${platform} community bundle requires exactly one installer and one payload SBOM`,
    );
  }
}

function assertReadyAttribution(manifest, platform) {
  const statuses =
    platform === 'macos'
      ? [
          manifest.checks?.attribution?.status,
          manifest.checks?.zip?.attribution?.status,
        ]
      : platform === 'windows'
        ? [manifest.checks?.nupkg?.payload?.attribution?.status]
        : [
            manifest.checks?.debian?.payload?.attribution?.status,
            manifest.checks?.rpm?.payload?.attribution?.status,
          ];
  if (statuses.some((status) => status !== 'READY')) {
    throw new Error(
      `community-unsigned ${platform} attribution must be strictly READY`,
    );
  }
}

function assertCommunityTrust(manifest, platform) {
  const trust = manifest.distributionTrust;
  if (
    !isObject(trust) ||
    trust.mode !== COMMUNITY_UNSIGNED_DISTRIBUTION_MODE ||
    trust.updater !== 'excluded' ||
    trust.warningCode !== COMMUNITY_UNSIGNED_WARNING_CODE
  ) {
    throw new Error(
      'Community distribution trust metadata is missing or invalid',
    );
  }
  if (platform === 'macos') {
    if (
      trust.codeSigning !== 'ad-hoc' ||
      trust.notarization !== 'absent' ||
      trust.osTrust !== 'absent' ||
      manifest.signature?.requiredMode !== 'community-ad-hoc' ||
      !['packaged', 'mounted', 'copied', 'zip'].every(
        (name) => manifest.signature?.[name]?.isAdhoc === true,
      ) ||
      [
        manifest.trust?.applicationStapler,
        manifest.trust?.copiedApplicationStapler,
        manifest.trust?.dmgStapler,
      ].some((assessment) => assessment?.passed === true)
    ) {
      throw new Error(
        'macOS community trust must prove ad-hoc signatures and absent notarization',
      );
    }
    if (manifest.build?.updateServerConfigured !== false) {
      throw new Error(
        'macOS community build must not configure an update server',
      );
    }
    return;
  }
  if (platform === 'windows') {
    const signatures = [
      manifest.checks?.packagedExecutableAuthenticode,
      manifest.checks?.setupAuthenticode,
    ];
    if (
      trust.osTrust !== 'absent' ||
      !isObject(trust.codeSigning) ||
      signatures.some(
        (signature) =>
          signature?.checked !== true ||
          signature?.passed !== false ||
          signature?.status !== 'NotSigned',
      )
    ) {
      throw new Error(
        'Windows community trust must prove both binaries are explicitly NotSigned',
      );
    }
    return;
  }
  if (
    trust.codeSigning !== 'not-applicable' ||
    trust.osTrust !== 'platform-package-unsigned'
  ) {
    throw new Error('Linux community trust metadata is invalid');
  }
}

function assertManifestIdentity(manifest, expected) {
  const build = manifest.build;
  if (
    manifest.schemaVersion !== 2 ||
    manifest.status !== 'passed' ||
    !isObject(build) ||
    build.channel !== 'release' ||
    build.distributionMode !== COMMUNITY_UNSIGNED_DISTRIBUTION_MODE ||
    build.sourceCommit !== expected.sourceCommit ||
    build.version !== expected.version ||
    build.platform !== expected.platform ||
    build.arch !== expected.architecture ||
    (build.tag !== undefined && build.tag !== null && build.tag !== '') ||
    (build.releasePlanPath !== undefined &&
      build.releasePlanPath !== null &&
      build.releasePlanPath !== '') ||
    (build.releasePlanSha256 !== undefined &&
      build.releasePlanSha256 !== null &&
      build.releasePlanSha256 !== '')
  ) {
    throw new Error('Validation manifest community identity is invalid');
  }
  assertReadyAttribution(manifest, expected.platform);
  assertCommunityTrust(manifest, expected.platform);
}

function buildWarning({ architecture, platform, sourceCommit, version }) {
  return `# CLODEx Community Unsigned Build

> **WARNING:** This package has no trusted operating-system distribution signature.

- Distribution mode: \`community-unsigned\`
- Version: \`${version}\`
- Platform: \`${platform}\`
- Architecture: \`${architecture}\`
- Exact source commit: \`${sourceCommit}\`

The macOS application is ad-hoc signed and is not Apple-notarized. Windows
binaries are not Authenticode-signed. Linux packages carry no CLODEx vendor
package signature. Operating-system trust prompts or installation blocks are
expected.

Auto-update metadata and updater payloads are intentionally excluded. Updates
must be installed manually. This package is not an official preview, canary, or
stable release and must not be counted as release acceptance evidence.

Verify every downloaded byte against \`${COMMUNITY_UNSIGNED_CHECKSUMS_FILE}\`
before installation.
`;
}

function prepareOutputDirectory(outputDirectory, allowedSourceRoot) {
  const resolvedOutput = path.resolve(outputDirectory);
  const resolvedSource = path.resolve(allowedSourceRoot);
  if (
    resolvedOutput === path.parse(resolvedOutput).root ||
    resolvedOutput === browserDirectory ||
    resolvedOutput === resolvedSource ||
    isPathWithin(resolvedOutput, resolvedSource) ||
    isPathWithin(resolvedSource, resolvedOutput)
  ) {
    throw new Error('Unsafe or overlapping community bundle output directory');
  }
  if (
    existsSync(resolvedOutput) &&
    lstatSync(resolvedOutput).isSymbolicLink()
  ) {
    throw new Error('Community bundle output directory must not be a symlink');
  }
  rmSync(resolvedOutput, { force: true, recursive: true });
  mkdirSync(resolvedOutput, { mode: 0o700, recursive: true });
  return resolvedOutput;
}

function fileRecord(filePath, kind) {
  const stats = statSync(filePath);
  return {
    bytes: stats.size,
    fileName: path.basename(filePath),
    kind,
    sha256: sha256File(filePath),
  };
}

export function assembleCommunityUnsignedBundle({
  allowedSourceRoot = defaultSourceRoot,
  architecture,
  manifestPath,
  outputDirectory,
  platform,
  sourceCommit,
  version,
}) {
  if (!SOURCE_COMMIT_PATTERN.test(String(sourceCommit ?? ''))) {
    throw new Error('sourceCommit must be an exact lowercase 40-character SHA');
  }
  if (!COMMUNITY_VERSION_PATTERN.test(String(version ?? ''))) {
    throw new Error(
      `version must be canonical community SemVer (for example 1.16.0-community42): ${version}`,
    );
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported community platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported community architecture: ${architecture}`);
  }
  const sourceRoot = path.resolve(allowedSourceRoot);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error(`Community build output root is missing: ${sourceRoot}`);
  }
  const manifestSource = assertRegularSourceFile(
    path.resolve(manifestPath),
    sourceRoot,
    'Validation manifest',
  );
  const validationManifest = readJson(
    manifestSource.filePath,
    'Validation manifest',
  );
  assertManifestIdentity(validationManifest, {
    architecture,
    platform,
    sourceCommit,
    version,
  });

  const publicationAssets = inspectPublicationAssets(validationManifest);
  const selectedAssets = [];
  const excludedUpdaterAssets = [];
  for (const artifact of publicationAssets) {
    const classification = classifyAsset(
      { architecture, platform, version },
      artifact.fileName,
    );
    const source = assertRegularSourceFile(
      path.resolve(artifact.path),
      sourceRoot,
      `Validated asset ${artifact.fileName}`,
    );
    const actualSha256 = sha256File(source.filePath);
    if (
      source.stats.size !== artifact.bytes ||
      actualSha256 !== artifact.sha256
    ) {
      throw new Error(`Validated asset bytes changed: ${artifact.fileName}`);
    }
    if (classification.kind === 'excluded-updater') {
      excludedUpdaterAssets.push({
        bytes: artifact.bytes,
        fileName: artifact.fileName,
        reason: classification.reason,
        sha256: artifact.sha256,
      });
      continue;
    }
    selectedAssets.push({
      ...artifact,
      kind: classification.kind,
      sourcePath: source.filePath,
    });
  }
  assertExpectedAssetSet(platform, selectedAssets);

  const output = prepareOutputDirectory(outputDirectory, sourceRoot);
  const bundleFiles = [];
  for (const asset of selectedAssets.sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  )) {
    const destination = path.join(output, asset.fileName);
    copyFileSync(asset.sourcePath, destination);
    const copied = fileRecord(destination, asset.kind);
    if (copied.bytes !== asset.bytes || copied.sha256 !== asset.sha256) {
      throw new Error(`Copied bundle asset bytes changed: ${asset.fileName}`);
    }
    bundleFiles.push(copied);
  }

  const validationFileName = assertSafeFileName(
    `validation-${platform}-${architecture}-${version}.json`,
    'validation evidence',
  );
  const validationDestination = path.join(output, validationFileName);
  copyFileSync(manifestSource.filePath, validationDestination);
  bundleFiles.push(fileRecord(validationDestination, 'validation'));

  const warningPath = path.join(output, COMMUNITY_UNSIGNED_WARNING_FILE);
  writeFileSync(
    warningPath,
    buildWarning({ architecture, platform, sourceCommit, version }),
    'utf8',
  );
  bundleFiles.push(fileRecord(warningPath, 'warning'));

  bundleFiles.sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
  const bundleManifest = {
    schemaVersion: 1,
    kind: 'clodex-community-unsigned-bundle',
    status: 'validated',
    distributionMode: COMMUNITY_UNSIGNED_DISTRIBUTION_MODE,
    sourceCommit,
    version,
    platform,
    architecture,
    warning: {
      code: COMMUNITY_UNSIGNED_WARNING_CODE,
      fileName: COMMUNITY_UNSIGNED_WARNING_FILE,
    },
    updater: {
      status: 'excluded',
      excludedAssets: excludedUpdaterAssets.sort((left, right) =>
        left.fileName.localeCompare(right.fileName),
      ),
    },
    files: bundleFiles,
    checksumsFile: COMMUNITY_UNSIGNED_CHECKSUMS_FILE,
  };
  const bundleManifestPath = path.join(
    output,
    COMMUNITY_UNSIGNED_MANIFEST_FILE,
  );
  writeFileSync(
    bundleManifestPath,
    `${JSON.stringify(bundleManifest, null, 2)}\n`,
    'utf8',
  );

  const checksummedFiles = [
    ...bundleFiles,
    fileRecord(bundleManifestPath, 'bundle-manifest'),
  ].sort((left, right) => left.fileName.localeCompare(right.fileName));
  const checksumsPath = path.join(output, COMMUNITY_UNSIGNED_CHECKSUMS_FILE);
  writeFileSync(
    checksumsPath,
    `${checksummedFiles
      .map((file) => `${file.sha256}  ${file.fileName}`)
      .join('\n')}\n`,
    'utf8',
  );

  const observedNames = readdirSync(output).sort();
  const expectedNames = [
    ...checksummedFiles.map((file) => file.fileName),
    COMMUNITY_UNSIGNED_CHECKSUMS_FILE,
  ].sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error('Community bundle contains an unexpected output entry');
  }
  if (observedNames.some((fileName) => updaterExclusion(fileName))) {
    throw new Error('Community bundle contains an updater payload');
  }

  return {
    bundleManifest,
    checksummedFiles,
    checksumsPath,
    excludedUpdaterAssets: bundleManifest.updater.excludedAssets,
    outputDirectory: output,
  };
}

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (value === '--') continue;
    if (value === '--help') {
      console.log(`
Assemble a fail-closed CLODEx community-unsigned bundle.

Usage:
  node apps/browser/scripts/assemble-community-unsigned-bundle.mjs \\
    --manifest=<validation.json> --output=<directory> \\
    --source-commit=<40sha> --version=<semver> \\
    --platform=<macos|windows|linux> --arch=<arm64|x64>
`);
      process.exit(0);
    }
    const match = /^--([a-z-]+)=(.*)$/u.exec(value);
    if (!match) throw new Error(`Unknown argument: ${value}`);
    const [, name, optionValue] = match;
    if (!optionValue) throw new Error(`Missing value for --${name}`);
    if (name === 'manifest') options.manifestPath = optionValue;
    else if (name === 'output') options.outputDirectory = optionValue;
    else if (name === 'source-commit') options.sourceCommit = optionValue;
    else if (name === 'version') options.version = optionValue;
    else if (name === 'platform') options.platform = optionValue;
    else if (name === 'arch') options.architecture = optionValue;
    else throw new Error(`Unknown argument: --${name}`);
  }
  for (const [name, value] of Object.entries({
    manifest: options.manifestPath,
    output: options.outputDirectory,
    'source-commit': options.sourceCommit,
    version: options.version,
    platform: options.platform,
    arch: options.architecture,
  })) {
    if (!value) throw new Error(`Missing required --${name} option`);
  }
  return options;
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  try {
    const result = assembleCommunityUnsignedBundle(
      parseArguments(process.argv.slice(2)),
    );
    console.log(
      `[community-unsigned] assembled ${result.checksummedFiles.length} checksummed files at ${result.outputDirectory}`,
    );
    console.log(
      `[community-unsigned] excluded ${result.excludedUpdaterAssets.length} updater payload(s)`,
    );
  } catch (error) {
    console.error(
      `[community-unsigned] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
