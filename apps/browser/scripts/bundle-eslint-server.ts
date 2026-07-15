#!/usr/bin/env tsx

/**
 * Builds the bundled vscode-eslint language server from an immutable upstream
 * archive and emits a provenance manifest for final-artifact verification.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectBundledComponentArtifacts,
  loadBundledComponentRegistry,
  verifyBundledComponentSourceBytes,
  verifyBundledEmbeddedDependencySourceBytes,
} from './release-attribution.mjs';
import { buildNpmCliInvocation } from './npm-cli-invocation.mjs';
import { extractVerifiedZipArchive } from './safe-zip-extractor.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(browserDirectory, '../..');
const registryPath = path.join(
  repositoryDirectory,
  'docs/provenance/BUNDLED_COMPONENTS.json',
);
const bundledRegistry = loadBundledComponentRegistry({
  registryPath,
  strict: true,
});
const component = (() => {
  const reviewedComponent = bundledRegistry.components.find(
    (entry) => entry.id === 'vscode-eslint-server',
  );
  if (!reviewedComponent) {
    throw new Error(
      'Reviewed bundled-component registry has no vscode-eslint-server record.',
    );
  }
  return reviewedComponent;
})();
if (component.source.type !== 'git-archive') {
  throw new Error('vscode-eslint-server must use an immutable Git archive.');
}
const immutableRevision = (() => {
  const revision = component.source.immutableRevision;
  if (!revision) {
    throw new Error('vscode-eslint-server has no immutable Git revision.');
  }
  return revision;
})();
const webpackTransform = (() => {
  const reviewedTransform = component.buildTransforms?.find(
    (entry) => entry.id === 'node22-ts-loader-transpile-only',
  );
  if (!reviewedTransform) {
    throw new Error(
      'vscode-eslint-server has no reviewed Node 22 webpack transform.',
    );
  }
  return reviewedTransform;
})();

const bundleDirectory = path.join(browserDirectory, 'bundled', 'eslint-server');
const bundleParentDirectory = path.dirname(bundleDirectory);
const bundleWorkDirectory = path.join(browserDirectory, '.eslint-server-work');
const buildLockPath = path.join(bundleWorkDirectory, 'build.lock');
const npmInvocation = buildNpmCliInvocation();
const maximumSourceArchiveBytes = 64 * 1024 * 1024;
const maximumDependencyArchiveBytes = 25 * 1024 * 1024;

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      throw new Error(`${label} declares more than ${maximumBytes} bytes.`);
    }
  }
  if (!response.body) {
    throw new Error(`${label} response has no body.`);
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maximumBytes) {
        await reader
          .cancel(`${label} exceeds ${maximumBytes} bytes.`)
          .catch(() => undefined);
        throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function copyDirectory(source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Upstream build output contains a symlink: ${sourcePath}`,
      );
    }
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(
        `Upstream build output contains a non-regular file: ${sourcePath}`,
      );
    }
  }
}

async function collectGeneratedArtifacts(directory: string) {
  const artifacts: Array<{
    bytes: number;
    path: string;
    role: string;
    sha256: string;
  }> = [];
  const visit = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Generated ESLint bundle contains a symlink: ${entryPath}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const relativePath = path
          .relative(directory, entryPath)
          .split(path.sep)
          .join('/');
        if (['License.txt', 'provenance.json'].includes(relativePath)) continue;
        const bytes = await fs.readFile(entryPath);
        artifacts.push({
          bytes: bytes.byteLength,
          path: relativePath,
          role: relativePath.endsWith('.map') ? 'source-map' : 'server-bundle',
          sha256: sha256(bytes),
        });
      } else {
        throw new Error(
          `Generated ESLint bundle contains a non-regular file: ${entryPath}`,
        );
      }
    }
  };
  await visit(directory);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function embeddedDependencyProvenance() {
  return (component.embeddedDependencies ?? []).map(
    ({ licenseText: _licenseText, ...dependency }) => dependency,
  );
}

async function verifyEmbeddedDependencies(serverDirectory: string) {
  if (
    !component.embeddedDependencyLock ||
    !component.embeddedDependencies?.length
  ) {
    throw new Error(
      'vscode-eslint-server has no reviewed embedded dependency lock/inventory.',
    );
  }
  const lockPath = path.join(serverDirectory, 'package-lock.json');
  const lockBytes = await fs.readFile(lockPath);
  const lockSha256 = sha256(lockBytes);
  if (lockSha256 !== component.embeddedDependencyLock.sha256) {
    throw new Error(
      `vscode-eslint server lock hash mismatch: ${lockSha256} != ${component.embeddedDependencyLock.sha256}`,
    );
  }
  const lock = JSON.parse(lockBytes.toString('utf8')) as {
    packages?: Record<
      string,
      { dev?: boolean; integrity?: string; resolved?: string; version?: string }
    >;
  };
  for (const dependency of component.embeddedDependencies) {
    const packageResponse = await fetch(dependency.packageSource.tarball);
    if (!packageResponse.ok) {
      throw new Error(
        `Failed to download embedded dependency ${dependency.name}@${dependency.version}: ${packageResponse.status} ${packageResponse.statusText}`,
      );
    }
    const packageBytes = await readBoundedResponseBytes(
      packageResponse,
      maximumDependencyArchiveBytes,
      `Embedded dependency archive ${dependency.name}@${dependency.version}`,
    );
    verifyBundledEmbeddedDependencySourceBytes({
      bytes: packageBytes,
      componentId: component.id,
      dependency,
    });
    const packagePath = `node_modules/${dependency.name}`;
    const locked = lock.packages?.[packagePath];
    if (
      !locked ||
      locked.dev === true ||
      locked.version !== dependency.version ||
      locked.resolved !== dependency.packageSource.tarball ||
      locked.integrity !== dependency.packageSource.integrity
    ) {
      throw new Error(
        `vscode-eslint embedded dependency lock mismatch for ${dependency.name}@${dependency.version}`,
      );
    }
    const packageDirectory = path.join(
      serverDirectory,
      'node_modules',
      ...dependency.name.split('/'),
    );
    const packageManifest = JSON.parse(
      await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
    ) as { license?: string; name?: string; version?: string };
    if (
      packageManifest.name !== dependency.name ||
      packageManifest.version !== dependency.version ||
      packageManifest.license !== dependency.license
    ) {
      throw new Error(
        `vscode-eslint embedded dependency metadata mismatch for ${dependency.name}@${dependency.version}`,
      );
    }
    const packageLicensePath = path.join(
      packageDirectory,
      dependency.licenseEvidence.packagePath,
    );
    const packageLicense = await fs.readFile(packageLicensePath);
    const packageLicenseSha256 = sha256(packageLicense);
    if (packageLicenseSha256 !== dependency.licenseEvidence.sha256) {
      throw new Error(
        `vscode-eslint embedded dependency license hash mismatch for ${dependency.name}@${dependency.version}: ${packageLicenseSha256} != ${dependency.licenseEvidence.sha256}`,
      );
    }
  }
  return embeddedDependencyProvenance();
}

async function verifyBundledModuleCoverage(sourceMapPath: string) {
  const sourceMap = JSON.parse(await fs.readFile(sourceMapPath, 'utf8')) as {
    sources?: unknown;
  };
  if (!Array.isArray(sourceMap.sources)) {
    throw new Error('Generated ESLint source map has no sources array.');
  }
  const actualNames = new Set<string>();
  for (const value of sourceMap.sources) {
    if (typeof value !== 'string') {
      throw new Error(
        'Generated ESLint source map contains a non-string source.',
      );
    }
    const normalized = value.replaceAll('\\', '/');
    const marker = '/node_modules/';
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const packagePath = normalized.slice(markerIndex + marker.length);
    const segments = packagePath.split('/');
    const packageName = packagePath.startsWith('@')
      ? `${segments[0]}/${segments[1]}`
      : segments[0];
    if (!packageName || packageName.endsWith('/undefined')) {
      throw new Error(`Unable to identify bundled package from ${value}`);
    }
    actualNames.add(packageName);
  }
  const expectedNames = (component.embeddedDependencies ?? [])
    .filter((dependency) => dependency.bundleScope === 'embedded')
    .map((dependency) => dependency.name)
    .sort();
  const observedNames = [...actualNames].sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Generated ESLint bundle dependency set changed: expected ${expectedNames.join(', ')}; got ${observedNames.join(', ')}`,
    );
  }
  return observedNames;
}

async function installVerifiedBundleDirectory(
  stagedBundleDirectory: string,
  stagedReport: ReturnType<typeof inspectBundledComponentArtifacts>,
) {
  const backupDirectory = path.join(
    bundleWorkDirectory,
    `backup-${randomUUID()}`,
  );
  const hadExistingBundle = await fileExists(bundleDirectory);
  let installedStagedBundle = false;
  let movedExistingBundle = false;
  let installedReport: ReturnType<typeof inspectBundledComponentArtifacts>;
  try {
    if (hadExistingBundle) {
      await fs.rename(bundleDirectory, backupDirectory);
      movedExistingBundle = true;
    }
    await fs.rename(stagedBundleDirectory, bundleDirectory);
    installedStagedBundle = true;
    installedReport = inspectBundledComponentArtifacts({
      applicationDirectory: browserDirectory,
      component,
      resourcesDirectory: browserDirectory,
    });
    if (JSON.stringify(installedReport) !== JSON.stringify(stagedReport)) {
      throw new Error(
        'Installed ESLint bundle report differs from the verified staged report.',
      );
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (installedStagedBundle) {
      await fs
        .rm(bundleDirectory, { force: true, recursive: true })
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (movedExistingBundle) {
      await fs
        .rename(backupDirectory, bundleDirectory)
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Failed to install and fully roll back the verified ESLint bundle.',
      );
    }
    throw error;
  }
  if (movedExistingBundle) {
    try {
      await fs.rm(backupDirectory, { recursive: true });
    } catch (error) {
      throw new Error(
        `Verified ESLint bundle is installed, but the old backup could not be removed from ${backupDirectory}; refusing to continue until it is inspected and removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return installedReport;
}

async function main() {
  log('\n===========================================', colors.cyan);
  log('  Bundling pinned ESLint LSP Server', colors.cyan);
  log('===========================================\n', colors.cyan);

  await fs.mkdir(bundleParentDirectory, { recursive: true });
  await fs.mkdir(bundleWorkDirectory, { mode: 0o700, recursive: true });
  const buildLock = await fs.open(buildLockPath, 'wx', 0o600).catch((error) => {
    throw new Error(
      `Another ESLint bundle build is active or left a stale lock at ${buildLockPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let operationError: unknown;
  let stagingRoot: string | undefined;
  let tempDirectory: string | undefined;
  try {
    const staleWorkEntries = (await fs.readdir(bundleWorkDirectory)).filter(
      (entry) => entry !== path.basename(buildLockPath),
    );
    if (staleWorkEntries.length > 0) {
      throw new Error(
        `Stale ESLint bundle work state must be inspected and removed before building: ${staleWorkEntries.join(', ')}`,
      );
    }
    tempDirectory = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `clodex-eslint-build-${immutableRevision.slice(0, 12)}-`,
      ),
    );
    stagingRoot = await fs.mkdtemp(path.join(bundleWorkDirectory, 'stage-'));
    log('Downloading immutable vscode-eslint source archive...', colors.blue);
    const response = await fetch(component.source.url);
    if (!response.ok) {
      throw new Error(
        `Failed to download vscode-eslint: ${response.status} ${response.statusText}`,
      );
    }
    const archiveBytes = await readBoundedResponseBytes(
      response,
      maximumSourceArchiveBytes,
      'vscode-eslint source archive',
    );
    const archiveVerification = verifyBundledComponentSourceBytes({
      bytes: archiveBytes,
      component,
    });
    log(`  Verified SHA-256 ${archiveVerification.sha256}\n`, colors.green);

    log('Safely extracting verified archive bytes...', colors.blue);
    const extractedDirectory = path.join(tempDirectory, 'source');
    await extractVerifiedZipArchive({
      allowedSymlinks: component.source.materializedSymlinks ?? [],
      archiveBytes,
      archiveRoot: `vscode-eslint-${immutableRevision}`,
      destination: extractedDirectory,
    });
    const serverDirectory = path.join(extractedDirectory, 'server');
    const upstreamManifest = JSON.parse(
      await fs.readFile(path.join(extractedDirectory, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string };
    if (
      upstreamManifest.name !== component.name ||
      upstreamManifest.version !== component.version
    ) {
      throw new Error(
        `vscode-eslint archive identity mismatch: ${String(upstreamManifest.name)}@${String(upstreamManifest.version)}`,
      );
    }
    const upstreamLicensePath = path.join(extractedDirectory, 'License.txt');
    const upstreamLicense = await fs.readFile(upstreamLicensePath);
    const upstreamLicenseSha256 = sha256(upstreamLicense);
    if (upstreamLicenseSha256 !== component.licenseEvidence.sha256) {
      throw new Error(
        `vscode-eslint license hash mismatch: ${upstreamLicenseSha256} != ${component.licenseEvidence.sha256}`,
      );
    }

    log('Installing exact upstream npm lockfiles...', colors.blue);
    execFileSync(
      npmInvocation.command,
      [
        ...npmInvocation.arguments,
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: extractedDirectory, stdio: 'inherit' },
    );
    execFileSync(
      npmInvocation.command,
      [
        ...npmInvocation.arguments,
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: serverDirectory, stdio: 'inherit' },
    );
    const embeddedDependencies =
      await verifyEmbeddedDependencies(serverDirectory);

    log(
      'Patching ts-loader to transpile the pinned source on Node 22...',
      colors.blue,
    );
    const sharedWebpackPath = path.join(
      extractedDirectory,
      webpackTransform.targetPath,
    );
    const sharedWebpackBytes = await fs.readFile(sharedWebpackPath);
    const sharedWebpackSha256 = sha256(sharedWebpackBytes);
    if (sharedWebpackSha256 !== webpackTransform.beforeSha256) {
      throw new Error(
        `Pinned vscode-eslint webpack input hash mismatch: ${sharedWebpackSha256} != ${webpackTransform.beforeSha256}`,
      );
    }
    const sharedWebpackSource = sharedWebpackBytes.toString('utf8');
    const patchedWebpackSource = sharedWebpackSource.replace(
      /loader:\s*'ts-loader',\s*options:\s*\{/g,
      "loader: 'ts-loader', options: { transpileOnly: true,",
    );
    if (patchedWebpackSource === sharedWebpackSource) {
      throw new Error(
        'Pinned vscode-eslint webpack patch target was not found; refusing to build changed source.',
      );
    }
    const patchedWebpackBytes = Buffer.from(patchedWebpackSource, 'utf8');
    const patchedWebpackSha256 = sha256(patchedWebpackBytes);
    if (patchedWebpackSha256 !== webpackTransform.afterSha256) {
      throw new Error(
        `Pinned vscode-eslint webpack output hash mismatch: ${patchedWebpackSha256} != ${webpackTransform.afterSha256}`,
      );
    }
    await fs.writeFile(sharedWebpackPath, patchedWebpackBytes);

    log(
      'Building ESLint server with the exact archived toolchain...',
      colors.blue,
    );
    const outputDirectory = path.join(serverDirectory, 'out');
    await fs.rm(outputDirectory, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      [
        path.join(extractedDirectory, 'node_modules/webpack/bin/webpack.js'),
        '--mode',
        'production',
        '--config',
        path.join(serverDirectory, 'webpack.config.js'),
      ],
      { cwd: serverDirectory, stdio: 'inherit' },
    );

    const stagedResourcesDirectory = path.join(stagingRoot, 'resources');
    const stagedBundleDirectory = path.join(
      stagedResourcesDirectory,
      'bundled',
      'eslint-server',
    );
    await copyDirectory(outputDirectory, stagedBundleDirectory);
    const javascriptPath = path.join(stagedBundleDirectory, 'eslintServer.js');
    const commonJsPath = path.join(stagedBundleDirectory, 'eslintServer.cjs');
    if (!(await fileExists(javascriptPath))) {
      throw new Error(
        'Pinned vscode-eslint build produced no eslintServer.js.',
      );
    }
    await fs.rename(javascriptPath, commonJsPath);
    await fs.copyFile(
      upstreamLicensePath,
      path.join(stagedBundleDirectory, 'License.txt'),
    );

    const embeddedModuleNames = await verifyBundledModuleCoverage(
      path.join(stagedBundleDirectory, 'eslintServer.js.map'),
    );
    const artifacts = await collectGeneratedArtifacts(stagedBundleDirectory);
    if (!artifacts.some((artifact) => artifact.path === 'eslintServer.cjs')) {
      throw new Error('Generated ESLint provenance has no eslintServer.cjs.');
    }
    await fs.writeFile(
      path.join(stagedBundleDirectory, 'provenance.json'),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          componentId: component.id,
          name: component.name,
          version: component.version,
          reviewStatus: component.reviewStatus,
          source: component.source,
          buildTransforms: component.buildTransforms,
          embeddedDependencyLock: component.embeddedDependencyLock,
          embeddedDependencies,
          embeddedModuleNames,
          licenseEvidence: component.licenseEvidence,
          artifacts,
        },
        null,
        2,
      )}\n`,
    );

    const stagedReport = inspectBundledComponentArtifacts({
      applicationDirectory: stagedResourcesDirectory,
      component,
      resourcesDirectory: stagedResourcesDirectory,
    });
    const report = await installVerifiedBundleDirectory(
      stagedBundleDirectory,
      stagedReport,
    );
    log(
      `  Verified ${report.files.length} packaged provenance artifact(s).\n`,
      colors.green,
    );
  } catch (error) {
    operationError = error;
  }
  const cleanupResults = await Promise.allSettled([
    tempDirectory
      ? fs.rm(tempDirectory, { recursive: true, force: true })
      : Promise.resolve(),
    stagingRoot
      ? fs.rm(stagingRoot, { recursive: true, force: true })
      : Promise.resolve(),
    buildLock.close(),
  ]);
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  try {
    await fs.rm(buildLockPath, { force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError) {
    if (cleanupErrors.length > 0) {
      log(
        `Cleanup after failed ESLint bundle build also failed: ${cleanupErrors.map(String).join('; ')}`,
        colors.red,
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Verified ESLint bundle installed, but temporary build state could not be cleaned up.',
    );
  }

  log('===========================================', colors.cyan);
  log('  ESLint LSP Server bundled successfully!', colors.green);
  log('===========================================\n', colors.cyan);
  log(`Location: ${bundleDirectory}`, colors.blue);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    log(`\nFailed to bundle ESLint server: ${error}`, colors.red);
    process.exit(1);
  });
}
