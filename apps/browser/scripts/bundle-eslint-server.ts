#!/usr/bin/env tsx

/**
 * Builds the bundled vscode-eslint language server from an immutable upstream
 * archive and emits a provenance manifest for final-artifact verification.
 */

import { createHash } from 'node:crypto';
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
const tempDirectory = path.join(
  os.tmpdir(),
  `clodex-eslint-build-${component.source.immutableRevision}`,
);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
    const packageBytes = new Uint8Array(await packageResponse.arrayBuffer());
    if (packageBytes.byteLength > 25 * 1024 * 1024) {
      throw new Error(
        `Embedded dependency archive exceeds 25 MiB: ${dependency.name}@${dependency.version}`,
      );
    }
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

async function assertExistingBundleIsReviewed(): Promise<boolean> {
  const serverPath = path.join(bundleDirectory, 'eslintServer.cjs');
  const provenancePath = path.join(bundleDirectory, 'provenance.json');
  const licensePath = path.join(bundleDirectory, 'License.txt');
  const anyExists = await Promise.all(
    [serverPath, provenancePath, licensePath].map(fileExists),
  );
  if (!anyExists.some(Boolean)) return false;
  try {
    inspectBundledComponentArtifacts({
      applicationDirectory: browserDirectory,
      component,
      resourcesDirectory: browserDirectory,
    });
  } catch (error) {
    throw new Error(
      `Existing vscode-eslint bundle is incomplete or stale; remove ${bundleDirectory} before rebuilding: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}

async function main() {
  log('\n===========================================', colors.cyan);
  log('  Bundling pinned ESLint LSP Server', colors.cyan);
  log('===========================================\n', colors.cyan);

  if (await assertExistingBundleIsReviewed()) {
    log(
      'Reviewed ESLint server bundle already exists; skipping.\n',
      colors.green,
    );
    return;
  }

  await fs.rm(tempDirectory, { recursive: true, force: true });
  await fs.mkdir(tempDirectory, { recursive: true });
  try {
    log('Downloading immutable vscode-eslint source archive...', colors.blue);
    const response = await fetch(component.source.url);
    if (!response.ok) {
      throw new Error(
        `Failed to download vscode-eslint: ${response.status} ${response.statusText}`,
      );
    }
    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    const archiveVerification = verifyBundledComponentSourceBytes({
      bytes: archiveBytes,
      component,
    });
    const archivePath = path.join(tempDirectory, 'vscode-eslint.zip');
    await fs.writeFile(archivePath, archiveBytes);
    log(`  Verified SHA-256 ${archiveVerification.sha256}\n`, colors.green);

    log('Extracting verified archive...', colors.blue);
    execFileSync('unzip', ['-q', archivePath, '-d', tempDirectory], {
      stdio: 'inherit',
    });
    const extractedDirectory = path.join(
      tempDirectory,
      `vscode-eslint-${component.source.immutableRevision}`,
    );
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
      npmCommand,
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: extractedDirectory, stdio: 'inherit' },
    );
    execFileSync(
      npmCommand,
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
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

    await fs.rm(bundleDirectory, { recursive: true, force: true });
    await copyDirectory(outputDirectory, bundleDirectory);
    const javascriptPath = path.join(bundleDirectory, 'eslintServer.js');
    const commonJsPath = path.join(bundleDirectory, 'eslintServer.cjs');
    if (!(await fileExists(javascriptPath))) {
      throw new Error(
        'Pinned vscode-eslint build produced no eslintServer.js.',
      );
    }
    await fs.rename(javascriptPath, commonJsPath);
    await fs.copyFile(
      upstreamLicensePath,
      path.join(bundleDirectory, 'License.txt'),
    );

    const artifacts = await collectGeneratedArtifacts(bundleDirectory);
    if (!artifacts.some((artifact) => artifact.path === 'eslintServer.cjs')) {
      throw new Error('Generated ESLint provenance has no eslintServer.cjs.');
    }
    await fs.writeFile(
      path.join(bundleDirectory, 'provenance.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          componentId: component.id,
          name: component.name,
          version: component.version,
          reviewStatus: component.reviewStatus,
          source: component.source,
          buildTransforms: component.buildTransforms,
          embeddedDependencyLock: component.embeddedDependencyLock,
          embeddedDependencies,
          licenseEvidence: component.licenseEvidence,
          artifacts,
        },
        null,
        2,
      )}\n`,
    );

    const report = inspectBundledComponentArtifacts({
      applicationDirectory: browserDirectory,
      component,
      resourcesDirectory: browserDirectory,
    });
    log(
      `  Verified ${report.files.length} packaged provenance artifact(s).\n`,
      colors.green,
    );
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }

  log('===========================================', colors.cyan);
  log('  ESLint LSP Server bundled successfully!', colors.green);
  log('===========================================\n', colors.cyan);
  log(`Location: ${bundleDirectory}`, colors.blue);
}

main().catch((error) => {
  log(`\nFailed to bundle ESLint server: ${error}`, colors.red);
  process.exit(1);
});
