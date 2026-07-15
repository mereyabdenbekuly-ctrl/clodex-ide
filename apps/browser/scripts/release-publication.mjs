import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VALIDATION_MANIFEST_NAME = 'validation-manifest.json';
const ASSET_DIRECTORY_NAME = 'assets';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const PUBLICATION_REPORT_FILE_NAME = 'clodex-release-publication.json';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256Json(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function sha256FileSync(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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

function assertRegularFile(filePath, label) {
  if (!existsSync(filePath))
    throw new Error(`${label} is missing: ${filePath}`);
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(
      `${label} is empty, not regular, or not a file: ${filePath}`,
    );
  }
  return stats;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function safeFileName(value) {
  const fileName = String(value ?? '');
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName !== path.basename(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new Error(
      `Unsafe release asset filename: ${fileName || '<missing>'}`,
    );
  }
  return fileName;
}

function portableBaseName(value) {
  return (
    String(value ?? '')
      .replaceAll('\\', '/')
      .split('/')
      .at(-1) ?? ''
  );
}

function isNormalizedReleasePlanPath(value) {
  return (
    typeof value === 'string' &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    value.startsWith('.release-notes/') &&
    value.endsWith('.json')
  );
}

export function inspectPublicationManifest(
  manifestPath,
  { requireTrustedBinding = false } = {},
) {
  assertRegularFile(manifestPath, 'Release validation manifest');
  const manifest = readJson(manifestPath, 'Release validation manifest');
  if (manifest.schemaVersion !== 2 || manifest.status !== 'passed') {
    throw new Error(
      `Release validation manifest is not a passed schemaVersion 2 result: ${manifestPath}`,
    );
  }
  const build = manifest.build;
  if (
    !build ||
    !['macos', 'windows', 'linux'].includes(build.platform) ||
    !['arm64', 'x64'].includes(build.arch) ||
    typeof build.version !== 'string' ||
    !build.version ||
    typeof build.channel !== 'string' ||
    !build.channel
  ) {
    throw new Error(
      `Release validation build identity is incomplete: ${manifestPath}`,
    );
  }
  if (
    requireTrustedBinding &&
    (!/^[a-f0-9]{40}$/.test(String(build.sourceCommit ?? '')) ||
      typeof build.tag !== 'string' ||
      !build.tag ||
      !isNormalizedReleasePlanPath(build.releasePlanPath) ||
      !SHA256_PATTERN.test(String(build.releasePlanSha256 ?? '')))
  ) {
    throw new Error(
      `Release validation build is not source/plan/tag bound: ${manifestPath}`,
    );
  }
  const canonicalManifestFileName = safeFileName(
    `${build.platform}-${build.arch}-${build.version}.json`,
  );
  const observedManifestFileName = path.basename(manifestPath);
  if (
    requireTrustedBinding &&
    observedManifestFileName !== VALIDATION_MANIFEST_NAME &&
    observedManifestFileName !== canonicalManifestFileName
  ) {
    throw new Error(
      `Release validation manifest filename is not canonical: ${manifestPath}`,
    );
  }
  if (
    manifest.publication?.status !== 'validated' ||
    !Array.isArray(manifest.publication.assets) ||
    manifest.publication.assets.length === 0
  ) {
    throw new Error(
      `Release validation manifest has no validated publication assets: ${manifestPath}`,
    );
  }
  const artifactEvidence = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : manifest.artifacts && typeof manifest.artifacts === 'object'
      ? Object.values(manifest.artifacts).filter(
          (artifact) =>
            artifact &&
            typeof artifact.path === 'string' &&
            typeof artifact.sha256 === 'string',
        )
      : null;
  if (!artifactEvidence) {
    throw new Error(
      `Release validation manifest has no artifact evidence: ${manifestPath}`,
    );
  }

  const artifactByFileName = new Map();
  for (const artifact of artifactEvidence) {
    const fileName = safeFileName(portableBaseName(artifact?.path));
    if (artifactByFileName.has(fileName)) {
      throw new Error(`Duplicate artifact evidence filename: ${fileName}`);
    }
    artifactByFileName.set(fileName, artifact);
  }

  const fileNames = new Set();
  const assets = manifest.publication.assets.map((asset) => {
    const fileName = safeFileName(asset?.fileName);
    if (fileNames.has(fileName)) {
      throw new Error(`Duplicate publication asset filename: ${fileName}`);
    }
    fileNames.add(fileName);
    if (
      !Number.isSafeInteger(asset?.bytes) ||
      asset.bytes <= 0 ||
      !SHA256_PATTERN.test(String(asset?.sha256 ?? ''))
    ) {
      throw new Error(`Invalid publication size or SHA-256 for ${fileName}`);
    }
    const artifact = artifactByFileName.get(fileName);
    if (
      !artifact ||
      artifact.bytes !== asset.bytes ||
      artifact.sha256 !== asset.sha256
    ) {
      throw new Error(
        `Publication asset is not bound to matching validator artifact evidence: ${fileName}`,
      );
    }
    return {
      bytes: asset.bytes,
      fileName,
      sha256: asset.sha256,
      sourcePath: String(artifact.path),
    };
  });

  if (assets.length !== artifactEvidence.length) {
    throw new Error(
      `Validator artifact evidence contains non-publication files: ${manifestPath}`,
    );
  }
  return {
    assets,
    build,
    manifest,
    manifestPath,
    validationReceipt: {
      checksSha256: sha256Json(manifest.checks ?? null),
      manifestFileName: canonicalManifestFileName,
      manifestSha256: sha256FileSync(manifestPath),
      signatureSha256: manifest.signature
        ? sha256Json(manifest.signature)
        : null,
      status: manifest.status,
      trustSha256: manifest.trust ? sha256Json(manifest.trust) : null,
    },
  };
}

async function verifyAsset(filePath, expected, label) {
  const stats = assertRegularFile(filePath, label);
  if (stats.size !== expected.bytes) {
    throw new Error(
      `${label} size mismatch for ${expected.fileName}: ${stats.size} != ${expected.bytes}`,
    );
  }
  const actualHash = await sha256File(filePath);
  if (actualHash !== expected.sha256) {
    throw new Error(
      `${label} SHA-256 mismatch for ${expected.fileName}: ${actualHash} != ${expected.sha256}`,
    );
  }
}

export async function stageValidatedReleaseAssets({
  manifestPath,
  outputDirectory,
  requireTrustedBinding = false,
}) {
  const inspected = inspectPublicationManifest(manifestPath, {
    requireTrustedBinding,
  });
  rmSync(outputDirectory, { force: true, recursive: true });
  const assetsDirectory = path.join(outputDirectory, ASSET_DIRECTORY_NAME);
  mkdirSync(assetsDirectory, { recursive: true });
  const validatedOutputRoot = path.resolve(path.dirname(manifestPath), '..');
  const realValidatedOutputRoot = realpathSync(validatedOutputRoot);

  for (const asset of inspected.assets) {
    const sourcePath = path.isAbsolute(asset.sourcePath)
      ? asset.sourcePath
      : path.resolve(path.dirname(manifestPath), asset.sourcePath);
    const realSourcePath = realpathSync(sourcePath);
    if (
      !realSourcePath.startsWith(`${realValidatedOutputRoot}${path.sep}`) ||
      realSourcePath === realValidatedOutputRoot
    ) {
      throw new Error(
        `Validated source asset escapes the release output root: ${sourcePath}`,
      );
    }
    await verifyAsset(realSourcePath, asset, 'Validated source asset');
    const destinationPath = path.join(assetsDirectory, asset.fileName);
    copyFileSync(realSourcePath, destinationPath, 0);
    await verifyAsset(destinationPath, asset, 'Staged release asset');
  }
  copyFileSync(
    manifestPath,
    path.join(outputDirectory, VALIDATION_MANIFEST_NAME),
  );
  const evidenceDirectory = path.join(outputDirectory, 'evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  copyFileSync(
    manifestPath,
    path.join(evidenceDirectory, path.basename(manifestPath)),
  );
  const checksumPath = manifestPath.replace(/\.json$/, '.sha256');
  if (checksumPath !== manifestPath && existsSync(checksumPath)) {
    assertRegularFile(checksumPath, 'Release validation checksum evidence');
    copyFileSync(
      checksumPath,
      path.join(evidenceDirectory, path.basename(checksumPath)),
    );
  }
  return {
    assetCount: inspected.assets.length,
    build: inspected.build,
    outputDirectory,
  };
}

function findValidationManifests(inputDirectory) {
  const results = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name === VALIDATION_MANIFEST_NAME) {
        results.push(entryPath);
      }
    }
  };
  visit(inputDirectory);
  return results.sort();
}

function parseExpectedBuilds(value) {
  const identities = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (identities.length === 0) {
    throw new Error('At least one expected platform:arch build is required');
  }
  const expected = new Set();
  for (const identity of identities) {
    if (!/^(?:macos|windows|linux):(arm64|x64)$/.test(identity)) {
      throw new Error(`Invalid expected release build identity: ${identity}`);
    }
    if (expected.has(identity)) {
      throw new Error(`Duplicate expected release build identity: ${identity}`);
    }
    expected.add(identity);
  }
  return expected;
}

function deriveAcceptanceChecks(inspectedManifests) {
  const macos = inspectedManifests.filter(
    (inspected) => inspected.build.platform === 'macos',
  );
  const windows = inspectedManifests.find(
    (inspected) => inspected.build.platform === 'windows',
  );
  if (macos.length !== 2 || !windows) {
    throw new Error(
      'Acceptance requires both macOS and the Windows validation manifests',
    );
  }
  const allManifestPassed = inspectedManifests.every(
    (inspected) => inspected.manifest.status === 'passed',
  );
  const smokePassed = macos.every(
    ({ manifest }) =>
      manifest.checks?.smoke?.exitCode === 0 &&
      manifest.checks.smoke.successMarker === true &&
      Array.isArray(manifest.checks.smoke.fatalLines) &&
      manifest.checks.smoke.fatalLines.length === 0,
  );
  const launchPassed = macos.every(
    ({ manifest }) =>
      manifest.checks?.cleanProfileUiLaunch?.startupComplete === true &&
      manifest.checks.cleanProfileUiLaunch.windowShown === true &&
      Array.isArray(manifest.checks.cleanProfileUiLaunch.fatalLines) &&
      manifest.checks.cleanProfileUiLaunch.fatalLines.length === 0,
  );
  const iconPassed = macos.every(
    ({ manifest }) =>
      Number.isSafeInteger(manifest.metadata?.icon?.bytes) &&
      manifest.metadata.icon.bytes > 0,
  );
  const macosDistributionTrustPassed = macos.every(({ manifest }) => {
    const signature = manifest.signature;
    const trust = manifest.trust;
    return (
      signature?.requiredMode === 'developer-id' &&
      signature.packaged?.isAdhoc === false &&
      signature.mounted?.isAdhoc === false &&
      signature.copied?.isAdhoc === false &&
      signature.zip?.isAdhoc === false &&
      trust?.applicationGatekeeper?.passed === true &&
      trust.applicationStapler?.passed === true &&
      trust.copiedApplicationGatekeeper?.passed === true &&
      trust.copiedApplicationStapler?.passed === true &&
      trust.dmgGatekeeper?.passed === true &&
      trust.dmgStapler?.passed === true
    );
  });
  const windowsDistributionTrustPassed = [
    windows.manifest.checks?.packagedExecutableAuthenticode,
    windows.manifest.checks?.setupAuthenticode,
  ].every(
    (signature) =>
      signature?.checked === true &&
      signature.passed === true &&
      signature.status === 'Valid',
  );
  const checks = [
    ['artifact.validation-manifest', allManifestPassed],
    ['artifact.packaged-smoke', smokePassed],
    ['artifact.clean-profile-launch', launchPassed],
    ['artifact.app-icon', iconPassed],
    [
      'security.distribution-trust',
      macosDistributionTrustPassed && windowsDistributionTrustPassed,
    ],
  ].map(([id, passed]) => ({
    id,
    reasonCode: passed
      ? 'attested-publication-validation'
      : 'publication-validation-failed',
    status: passed ? 'pass' : 'fail',
  }));
  const failed = checks.filter((check) => check.status !== 'pass');
  if (failed.length > 0) {
    throw new Error(
      `Release publication acceptance receipts failed: ${failed.map((check) => check.id).join(', ')}`,
    );
  }
  return checks;
}

export async function collectValidatedReleaseAssets({
  channel,
  expectedBuilds,
  inputDirectory,
  outputDirectory,
  releasePlanPath,
  releasePlanSha256,
  repository,
  reportPath,
  requireTrustedBinding = false,
  runAttempt,
  sourceCommit,
  tag,
  version,
  workflowRunId,
  workflowCommit,
  workflowSourceRef,
}) {
  if (
    requireTrustedBinding &&
    (repository !== 'mereyabdenbekuly-ctrl/clodex-ide' ||
      !/^[a-f0-9]{40}$/.test(String(sourceCommit ?? '')) ||
      typeof tag !== 'string' ||
      !tag ||
      !isNormalizedReleasePlanPath(releasePlanPath) ||
      !SHA256_PATTERN.test(String(releasePlanSha256 ?? '')) ||
      !Number.isSafeInteger(workflowRunId) ||
      workflowRunId <= 0 ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt <= 0 ||
      !/^[a-f0-9]{40}$/.test(String(workflowCommit ?? '')) ||
      workflowCommit !== sourceCommit ||
      workflowSourceRef !== 'refs/heads/main')
  ) {
    throw new Error('Release publication binding is incomplete or invalid');
  }
  const expected =
    expectedBuilds instanceof Set
      ? expectedBuilds
      : parseExpectedBuilds(expectedBuilds);
  const manifestPaths = findValidationManifests(inputDirectory);
  if (manifestPaths.length !== expected.size) {
    throw new Error(
      `Expected ${expected.size} validation manifests, found ${manifestPaths.length}`,
    );
  }

  const inspectedManifests = manifestPaths.map((manifestPath) =>
    inspectPublicationManifest(manifestPath, { requireTrustedBinding }),
  );
  const observed = new Set();
  const releaseAssets = [];
  for (const inspected of inspectedManifests) {
    const identity = `${inspected.build.platform}:${inspected.build.arch}`;
    if (!expected.has(identity) || observed.has(identity)) {
      throw new Error(`Unexpected or duplicate validated build: ${identity}`);
    }
    observed.add(identity);
    if (
      inspected.build.version !== version ||
      inspected.build.channel !== channel ||
      (requireTrustedBinding &&
        (inspected.build.sourceCommit !== sourceCommit ||
          inspected.build.tag !== tag ||
          inspected.build.releasePlanPath !== releasePlanPath ||
          inspected.build.releasePlanSha256 !== releasePlanSha256))
    ) {
      throw new Error(
        `Validated build ${identity} does not match the aggregate release binding`,
      );
    }

    const assetsDirectory = path.join(
      path.dirname(inspected.manifestPath),
      ASSET_DIRECTORY_NAME,
    );
    const stagedNames = readdirSync(assetsDirectory, {
      withFileTypes: true,
    }).map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `Release bundle contains a non-regular asset: ${path.join(assetsDirectory, entry.name)}`,
        );
      }
      return entry.name;
    });
    const expectedNames = inspected.assets
      .map((asset) => asset.fileName)
      .sort();
    if (JSON.stringify(stagedNames.sort()) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `Release bundle assets do not exactly match the validated manifest for ${identity}`,
      );
    }
    for (const asset of inspected.assets) {
      const assetPath = path.join(assetsDirectory, asset.fileName);
      await verifyAsset(assetPath, asset, 'Downloaded release asset');
      releaseAssets.push({ ...asset, identity, sourcePath: assetPath });
    }
  }

  for (const identity of expected) {
    if (!observed.has(identity)) {
      throw new Error(`Missing validated release build: ${identity}`);
    }
  }
  const fileNames = new Set();
  for (const asset of releaseAssets) {
    if (fileNames.has(asset.fileName)) {
      throw new Error(
        `Release filename collides across builds: ${asset.fileName}`,
      );
    }
    fileNames.add(asset.fileName);
  }

  rmSync(outputDirectory, { force: true, recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const asset of releaseAssets) {
    const destinationPath = path.join(outputDirectory, asset.fileName);
    copyFileSync(asset.sourcePath, destinationPath, 0);
    await verifyAsset(destinationPath, asset, 'Collected release asset');
  }

  const assets = releaseAssets
    .map(({ sourcePath: _sourcePath, ...asset }) => asset)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const report = requireTrustedBinding
    ? {
        schemaVersion: 2,
        reportKind: 'release-publication',
        status: 'validated',
        generatedAt: new Date().toISOString(),
        repository,
        sourceCommit,
        tag,
        version,
        channel,
        releasePlan: {
          path: releasePlanPath,
          sha256: releasePlanSha256,
        },
        workflow: {
          commit: workflowCommit,
          runAttempt,
          runId: workflowRunId,
          sourceRef: workflowSourceRef,
        },
        builds: [...observed].sort(),
        validations: inspectedManifests
          .map((inspected) => ({
            arch: inspected.build.arch,
            platform: inspected.build.platform,
            ...inspected.validationReceipt,
          }))
          .sort((left, right) =>
            `${left.platform}:${left.arch}`.localeCompare(
              `${right.platform}:${right.arch}`,
            ),
          ),
        acceptanceChecks: deriveAcceptanceChecks(inspectedManifests),
        assets,
      }
    : {
        schemaVersion: 1,
        status: 'validated',
        version,
        channel,
        builds: [...observed].sort(),
        assets,
      };
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function parseArguments(values) {
  const [action, ...rest] = values;
  const options = { action };
  for (const value of rest) {
    if (!value.startsWith('--') || !value.includes('=')) {
      throw new Error(`Invalid release publication argument: ${value}`);
    }
    const [name, ...parts] = value.slice(2).split('=');
    options[name] = parts.join('=');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.action === 'stage') {
    if (!options.manifest || !options.output) {
      throw new Error('stage requires --manifest and --output');
    }
    const result = await stageValidatedReleaseAssets({
      manifestPath: path.resolve(options.manifest),
      outputDirectory: path.resolve(options.output),
      requireTrustedBinding: options['trusted-promotion'] === 'true',
    });
    console.log(
      `[release-publication] staged ${result.assetCount} validated assets for ${result.build.platform}:${result.build.arch}`,
    );
    return;
  }
  if (options.action === 'collect') {
    const trustedPromotion = options['trusted-promotion'] === 'true';
    const requiredOptions = [
      'input',
      'output',
      'version',
      'channel',
      'expected',
    ];
    if (trustedPromotion) {
      requiredOptions.push(
        'repository',
        'source-commit',
        'tag',
        'release-plan',
        'release-plan-sha256',
        'workflow-run-id',
        'workflow-commit',
        'workflow-source-ref',
        'run-attempt',
      );
    }
    for (const required of requiredOptions) {
      if (!options[required]) {
        throw new Error(`collect requires --${required}`);
      }
    }
    const report = await collectValidatedReleaseAssets({
      channel: options.channel,
      expectedBuilds: options.expected,
      inputDirectory: path.resolve(options.input),
      outputDirectory: path.resolve(options.output),
      releasePlanPath: options['release-plan'],
      releasePlanSha256: options['release-plan-sha256'],
      repository: options.repository,
      reportPath: options.report ? path.resolve(options.report) : undefined,
      requireTrustedBinding: trustedPromotion,
      runAttempt: Number.parseInt(options['run-attempt'], 10),
      sourceCommit: options['source-commit'],
      tag: options.tag,
      version: options.version,
      workflowRunId: Number.parseInt(options['workflow-run-id'], 10),
      workflowCommit: options['workflow-commit'],
      workflowSourceRef: options['workflow-source-ref'],
    });
    console.log(
      `[release-publication] collected ${report.assets.length} manifest-bound release assets`,
    );
    return;
  }
  throw new Error('Usage: release-publication.mjs <stage|collect> [options]');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      `[release-publication] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
