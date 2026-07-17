import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { toSquirrelInternalVersion } from '../etc/squirrel-version.mjs';
import { inspectCommunityObservedTelemetryAsar } from './community-observed-telemetry-validator.mjs';
import {
  ATTRIBUTION_DIRECTORY_NAME,
  inspectPackagedAttribution,
  REQUIRED_ATTRIBUTION_PATHS,
  resolveElectronRuntimeNoticePaths,
  writeFinalArtifactSbom,
} from './release-attribution.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(browserDirectory, '../..');

const channelConfig = {
  dev: { baseName: 'clodex-dev' },
  nightly: { baseName: 'clodex-nightly' },
  prerelease: { baseName: 'clodex-prerelease' },
  release: { baseName: 'clodex' },
};

const distributionConfig = {
  official: {
    outputDirectoryName: null,
  },
  'community-unsigned': {
    baseName: 'clodex-community-unsigned',
    outputDirectoryName: 'community-unsigned',
  },
  'community-observed': {
    baseName: 'clodex-community-observed',
    outputDirectoryName: 'community-observed',
  },
};

function isCommunityDistributionMode(value) {
  return value === 'community-unsigned' || value === 'community-observed';
}

const help = `
Validate Windows or Linux Clodex release artifacts.

Usage:
  node scripts/validate-release-artifacts.mjs [options]

Options:
  --platform=<windows|linux>                  Target platform
  --channel=<dev|nightly|prerelease|release>             Build channel (default: release)
  --distribution-mode=<official|community-unsigned|community-observed> Distribution trust mode (default: official)
  --arch=<arm64|x64>                                    Target architecture
  --version=<semver>                                    Package version
  --allow-unsigned                                      Accept unsigned Windows binaries (legacy dev-only escape hatch)
  --output=<path>                                       JSON manifest output path
  --require-trusted-binding                             Require source/tag/plan binding
  --source-commit=<sha>                                 Exact source commit (required for community distributions)
  --help                                                Show this message
`;

export function parseReleaseArtifactArguments(
  values,
  environment = process.env,
) {
  const options = {
    allowUnsigned: false,
    arch: process.arch,
    channel: environment.RELEASE_CHANNEL ?? 'release',
    distributionMode: environment.CLODEX_DISTRIBUTION_MODE ?? 'official',
    output: undefined,
    platform: process.platform === 'win32' ? 'windows' : 'linux',
    releasePlanPath: undefined,
    releasePlanSha256: undefined,
    requireTrustedBinding: false,
    sourceCommit: undefined,
    tag: undefined,
    version: process.env.APP_VERSION_OVERRIDE,
  };

  for (const value of values) {
    if (value === '--') continue;
    if (value === '--allow-unsigned') {
      options.allowUnsigned = true;
    } else if (value === '--help') {
      console.log(help.trim());
      process.exit(0);
    } else if (value.startsWith('--arch=')) {
      options.arch = value.slice('--arch='.length);
    } else if (value.startsWith('--channel=')) {
      options.channel = value.slice('--channel='.length);
    } else if (value.startsWith('--distribution-mode=')) {
      options.distributionMode = value.slice('--distribution-mode='.length);
    } else if (value.startsWith('--output=')) {
      options.output = value.slice('--output='.length);
    } else if (value.startsWith('--platform=')) {
      options.platform = value.slice('--platform='.length);
    } else if (value.startsWith('--release-plan=')) {
      options.releasePlanPath = value.slice('--release-plan='.length);
    } else if (value.startsWith('--release-plan-sha256=')) {
      options.releasePlanSha256 = value.slice('--release-plan-sha256='.length);
    } else if (value === '--require-trusted-binding') {
      options.requireTrustedBinding = true;
    } else if (value.startsWith('--source-commit=')) {
      options.sourceCommit = value.slice('--source-commit='.length);
    } else if (value.startsWith('--tag=')) {
      options.tag = value.slice('--tag='.length);
    } else if (value.startsWith('--version=')) {
      options.version = value.slice('--version='.length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!(options.channel in channelConfig)) {
    throw new Error(`Unsupported release channel: ${options.channel}`);
  }
  if (!(options.distributionMode in distributionConfig)) {
    throw new Error(
      `Unsupported distribution mode: ${options.distributionMode}`,
    );
  }
  if (!['arm64', 'x64'].includes(options.arch)) {
    throw new Error(`Unsupported architecture: ${options.arch}`);
  }
  if (!['windows', 'linux'].includes(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}`);
  }
  if (
    options.requireTrustedBinding &&
    (!/^[a-f0-9]{40}$/.test(String(options.sourceCommit ?? '')) ||
      typeof options.tag !== 'string' ||
      !options.tag ||
      typeof options.releasePlanPath !== 'string' ||
      !options.releasePlanPath ||
      !/^[a-f0-9]{64}$/.test(String(options.releasePlanSha256 ?? '')))
  ) {
    throw new Error(
      'Release validation requires exact source/tag/plan binding',
    );
  }
  if (isCommunityDistributionMode(options.distributionMode)) {
    if (options.channel !== 'release') {
      throw new Error(
        `${options.distributionMode} distribution must use the release feature channel`,
      );
    }
    if (!/^[a-f0-9]{40}$/.test(String(options.sourceCommit ?? ''))) {
      throw new Error(
        `${options.distributionMode} distribution requires an exact 40-character source commit`,
      );
    }
    if (options.requireTrustedBinding) {
      throw new Error(
        `${options.distributionMode} distribution cannot claim trusted release-plan binding`,
      );
    }
    if (options.releasePlanPath || options.releasePlanSha256 || options.tag) {
      throw new Error(
        `${options.distributionMode} distribution must not carry an official tag or release plan`,
      );
    }
    options.allowUnsigned = true;
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? browserDirectory,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}\n${[
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n')}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`${label} is empty or not a file: ${filePath}`);
  }
  return stats;
}

function findFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && predicate(entryPath)) matches.push(entryPath);
    }
  };
  visit(root);
  return matches.sort();
}

function requireSingleFile(root, predicate, label) {
  const matches = findFiles(root, predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${label} under ${root}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  assertFile(matches[0], label);
  return matches[0];
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeArchiveEntry(entryName, label) {
  const normalized = entryName.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Unsafe ${label} entry: ${entryName}`);
  }
  return normalized;
}

function extractZipSafely(zipPath, destinationDirectory) {
  mkdirSync(destinationDirectory, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Could not open ${zipPath}`));
        return;
      }

      let entryCount = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };
      zipFile.on('error', fail);
      zipFile.on('entry', (entry) => {
        if (entry.fileName === '.' || entry.fileName === './') {
          zipFile.readEntry();
          return;
        }
        let normalized;
        try {
          normalized = safeArchiveEntry(entry.fileName, 'ZIP');
        } catch (error) {
          fail(error);
          return;
        }
        entryCount += 1;
        totalBytes += entry.uncompressedSize;
        if (entryCount > 100_000 || totalBytes > 8 * 1024 * 1024 * 1024) {
          fail(new Error(`ZIP extraction limits exceeded: ${zipPath}`));
          return;
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          fail(
            new Error(`Encrypted ZIP entry is forbidden: ${entry.fileName}`),
          );
          return;
        }

        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) {
          fail(new Error(`Symlink ZIP entry is forbidden: ${entry.fileName}`));
          return;
        }
        const destinationPath = path.resolve(destinationDirectory, normalized);
        const destinationRoot = `${path.resolve(destinationDirectory)}${path.sep}`;
        if (!destinationPath.startsWith(destinationRoot)) {
          fail(
            new Error(`ZIP entry escapes extraction root: ${entry.fileName}`),
          );
          return;
        }
        if (normalized.endsWith('/')) {
          mkdirSync(destinationPath, { recursive: true });
          zipFile.readEntry();
          return;
        }

        mkdirSync(path.dirname(destinationPath), { recursive: true });
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`Could not read ${entry.fileName}`));
            return;
          }
          const output = createWriteStream(destinationPath, { flags: 'wx' });
          stream.on('error', fail);
          output.on('error', fail);
          output.on('close', () => {
            if (!settled) zipFile.readEntry();
          });
          stream.pipe(output);
        });
      });
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entryCount, totalBytes });
      });
      zipFile.readEntry();
    });
  });
}

function findExtractedApplication(extractionRoot, label) {
  const resourcesCandidates = findFiles(
    extractionRoot,
    (filePath) => path.basename(filePath) === 'app.asar',
  )
    .map((filePath) => path.dirname(filePath))
    .filter((resourcesDirectory) =>
      existsSync(
        path.join(
          resourcesDirectory,
          ATTRIBUTION_DIRECTORY_NAME,
          'manifest.json',
        ),
      ),
    );
  if (resourcesCandidates.length !== 1) {
    throw new Error(
      `Expected one ${label} application payload, found ${resourcesCandidates.length}: ${resourcesCandidates.join(', ')}`,
    );
  }
  const resourcesDirectory = resourcesCandidates[0];
  return {
    applicationDirectory: path.dirname(resourcesDirectory),
    resourcesDirectory,
  };
}

async function inspectExtractedApplication({
  appName,
  appVersion,
  arch,
  channel,
  electronRuntime,
  expectedPayload,
  extractionRoot,
  label,
  outputPath,
  platform,
}) {
  const payload = findExtractedApplication(extractionRoot, label);
  const attribution = inspectPackagedAttribution({
    attributionDirectory: path.join(
      payload.resourcesDirectory,
      ATTRIBUTION_DIRECTORY_NAME,
    ),
    requireReady: channel !== 'dev',
  });
  const appAsarPath = path.join(payload.resourcesDirectory, 'app.asar');
  const appAsarSha256 = await hashFile(appAsarPath, 'sha256');
  if (expectedPayload && appAsarSha256 !== expectedPayload.appAsarSha256) {
    throw new Error(
      `${label} app.asar differs from the validated packaged application`,
    );
  }
  if (
    expectedPayload &&
    attribution.manifestSha256 !== expectedPayload.attributionManifestSha256
  ) {
    throw new Error(
      `${label} attribution manifest differs from the validated packaged application`,
    );
  }
  const sbom = await writeFinalArtifactSbom({
    ...payload,
    appName,
    appVersion,
    arch,
    attribution,
    electronRuntime,
    outputPath,
    platform,
  });
  return {
    ...payload,
    appAsarSha256,
    attribution: {
      dependencyCount: attribution.dependencyCount,
      manifestSha256: attribution.manifestSha256,
      noticePaths: attribution.noticePaths,
      status: attribution.manifest.status,
    },
    extractionRoot,
    sbom,
  };
}

function inspectNupkg(nupkgPath, expectedBaseName, expectedVersion) {
  return new Promise((resolve, reject) => {
    yauzl.open(nupkgPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Could not open ${nupkgPath}`));
        return;
      }

      const entries = [];
      let nuspec = '';
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };

      zipFile.on('error', fail);
      zipFile.on('entry', (entry) => {
        const normalized = entry.fileName.replaceAll('\\', '/');
        if (
          normalized.startsWith('/') ||
          normalized.split('/').some((segment) => segment === '..')
        ) {
          fail(new Error(`Unsafe nupkg entry: ${entry.fileName}`));
          return;
        }
        entries.push(normalized);

        if (!normalized.toLowerCase().endsWith('.nuspec')) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > 2 * 1024 * 1024) {
          fail(new Error(`Unexpectedly large nuspec: ${entry.fileName}`));
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('Could not read nuspec'));
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            nuspec = Buffer.concat(chunks).toString('utf8');
            zipFile.readEntry();
          });
        });
      });
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        const lowerEntries = entries.map((entry) => entry.toLowerCase());
        const expectedExecutable = `lib/net45/${expectedBaseName}.exe`;
        if (
          !lowerEntries.some((entry) =>
            entry.endsWith(expectedExecutable.toLowerCase()),
          )
        ) {
          reject(
            new Error(
              `nupkg does not contain the expected application executable: ${expectedExecutable}`,
            ),
          );
          return;
        }
        if (!nuspec) {
          reject(new Error('nupkg does not contain a readable .nuspec'));
          return;
        }
        const missingAttributionEntries = REQUIRED_ATTRIBUTION_PATHS.filter(
          (relativePath) =>
            !lowerEntries.some((entry) =>
              entry.endsWith(
                `/resources/${ATTRIBUTION_DIRECTORY_NAME}/${relativePath}`.toLowerCase(),
              ),
            ),
        );
        if (missingAttributionEntries.length > 0) {
          reject(
            new Error(
              `nupkg is missing packaged attribution files: ${missingAttributionEntries.join(', ')}`,
            ),
          );
          return;
        }
        for (const electronNotice of ['LICENSE', 'LICENSES.chromium.html']) {
          const acceptedLocations = [
            `lib/net45/${electronNotice}`,
            `lib/net45/resources/${electronNotice}`,
          ].map((entry) => entry.toLowerCase());
          if (
            !lowerEntries.some((entry) =>
              acceptedLocations.some((location) => entry.endsWith(location)),
            )
          ) {
            reject(
              new Error(`nupkg is missing Electron notice: ${electronNotice}`),
            );
            return;
          }
        }
        if (
          !new RegExp(
            `<version>\\s*${escapeRegExp(expectedVersion)}\\s*</version>`,
            'i',
          ).test(nuspec)
        ) {
          reject(
            new Error(
              `nupkg nuspec does not declare version ${expectedVersion}`,
            ),
          );
          return;
        }
        resolve({ entries: entries.length, expectedExecutable });
      });
      zipFile.readEntry();
    });
  });
}

function verifyAuthenticode(filePath, allowUnsigned) {
  if (process.platform !== 'win32') {
    return { checked: false, reason: 'not-running-on-windows' };
  }
  const escaped = filePath.replaceAll("'", "''");
  const result = run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`,
    ],
    { allowFailure: true },
  );
  const status = result.stdout.trim();
  if (!allowUnsigned && (result.status !== 0 || status !== 'Valid')) {
    throw new Error(
      `Authenticode validation failed for ${filePath}: ${status || result.stderr.trim()}`,
    );
  }
  return { checked: true, passed: status === 'Valid', status };
}

async function validateWindows({
  allowUnsigned,
  arch,
  baseName,
  channel,
  distributionMode,
  electronRuntime,
  expectedPayload,
  makeDirectory,
  temporaryRoot,
  validationDirectory,
  version,
}) {
  const squirrelDirectory = path.join(makeDirectory, 'squirrel.windows');
  const setupPath = path.join(
    squirrelDirectory,
    `${baseName}-${version}-${arch}-setup.exe`,
  );
  const nupkgPath = path.join(
    squirrelDirectory,
    `${baseName}-${version}-${arch}-full.nupkg`,
  );
  const releasesPath = path.join(squirrelDirectory, `RELEASES-win32-${arch}`);
  const setupStats = assertFile(setupPath, 'Squirrel setup executable');
  const nupkgStats = assertFile(nupkgPath, 'Squirrel full nupkg');
  assertFile(releasesPath, 'Squirrel RELEASES manifest');

  const releaseLines = readFileSync(releasesPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const expectedName = path.basename(nupkgPath);
  const entry = releaseLines
    .map((line) => line.split(/\s+/))
    .find((parts) => parts[1] === expectedName);
  if (!entry || entry.length < 3) {
    throw new Error(`RELEASES does not reference ${expectedName}`);
  }

  const expectedSha1 = entry[0].toLowerCase();
  const actualSha1 = await hashFile(nupkgPath, 'sha1');
  if (actualSha1 !== expectedSha1) {
    throw new Error(
      `RELEASES SHA-1 mismatch for ${expectedName}: expected ${expectedSha1}, got ${actualSha1}`,
    );
  }
  if (Number(entry[2]) !== nupkgStats.size) {
    throw new Error(
      `RELEASES size mismatch for ${expectedName}: expected ${entry[2]}, got ${nupkgStats.size}`,
    );
  }

  const internalVersion = toSquirrelInternalVersion(version);
  const nupkg = await inspectNupkg(nupkgPath, baseName, internalVersion);
  const extractionRoot = path.join(temporaryRoot, 'windows-nupkg');
  const extraction = await extractZipSafely(nupkgPath, extractionRoot);
  const payload = await inspectExtractedApplication({
    appName: baseName,
    appVersion: version,
    arch,
    channel,
    electronRuntime,
    expectedPayload,
    extractionRoot,
    label: 'Windows NUPKG',
    outputPath: path.join(
      validationDirectory,
      `windows-${arch}-${version}-nupkg.cdx.json`,
    ),
    platform: 'windows',
  });
  const packagedExecutable = path.join(
    payload.applicationDirectory,
    `${baseName}.exe`,
  );
  assertFile(packagedExecutable, 'NUPKG Windows executable');
  const packagedExecutableAuthenticode = verifyAuthenticode(
    packagedExecutable,
    allowUnsigned,
  );
  const setupAuthenticode = verifyAuthenticode(setupPath, allowUnsigned);
  if (isCommunityDistributionMode(distributionMode)) {
    for (const [label, signature] of [
      ['packaged executable', packagedExecutableAuthenticode],
      ['setup executable', setupAuthenticode],
    ]) {
      if (
        signature.checked !== true ||
        signature.passed !== false ||
        signature.status !== 'NotSigned'
      ) {
        throw new Error(
          `${distributionMode} ${label} must be explicitly NotSigned; received ${signature.status || 'unknown'}`,
        );
      }
    }
  }
  return {
    artifacts: [setupPath, nupkgPath, releasesPath, payload.sbom.path],
    checks: {
      nupkg: {
        ...nupkg,
        extraction,
        payload: {
          attribution: payload.attribution,
          appAsarSha256: payload.appAsarSha256,
          resourcesPath: path.relative(
            extractionRoot,
            payload.resourcesDirectory,
          ),
          sbom: payload.sbom,
        },
      },
      packagedExecutableAuthenticode,
      releasesEntry: {
        fileName: expectedName,
        sha1: actualSha1,
        size: nupkgStats.size,
      },
      squirrelInternalVersion: internalVersion,
      setupAuthenticode,
      setupBytes: setupStats.size,
    },
  };
}

function normalizeLinuxVersion(value) {
  return value.trim().replaceAll('~', '-').replaceAll('.', '-');
}

export function expectedRpmVersionRelease(version) {
  return `${String(version).trim().replaceAll('-', '.')}-1`;
}

export function assertRpmVersionRelease(rpmVersion, version) {
  const expected = expectedRpmVersionRelease(version);
  if (rpmVersion !== expected) {
    throw new Error(
      `Unexpected RPM version: ${rpmVersion} (expected ${expected})`,
    );
  }
  return expected;
}

function extractRpm(rpmPath, destinationDirectory) {
  mkdirSync(destinationDirectory, { recursive: true });
  const env = { ...process.env, RPM_PATH: rpmPath };
  const listing = run(
    '/bin/bash',
    ['-o', 'pipefail', '-c', 'rpm2cpio "$RPM_PATH" | cpio --list --quiet'],
    { env },
  ).stdout;
  for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
    if (entry === '.' || entry === './') continue;
    safeArchiveEntry(entry, 'RPM');
  }
  run(
    '/bin/bash',
    [
      '-o',
      'pipefail',
      '-c',
      'rpm2cpio "$RPM_PATH" | cpio --extract --make-directories --no-absolute-filenames --quiet',
    ],
    { cwd: destinationDirectory, env },
  );
  return { entryCount: listing.split(/\r?\n/).filter(Boolean).length };
}

async function validateLinux({
  arch,
  baseName,
  channel,
  electronRuntime,
  expectedPayload,
  makeDirectory,
  temporaryRoot,
  validationDirectory,
  version,
}) {
  const debPath = requireSingleFile(
    makeDirectory,
    (filePath) => filePath.endsWith('.deb'),
    'Debian package',
  );
  const rpmPath = requireSingleFile(
    makeDirectory,
    (filePath) => filePath.endsWith('.rpm'),
    'RPM package',
  );
  const readDebField = (field) =>
    run('/usr/bin/dpkg-deb', ['--field', debPath, field]).stdout.trim();
  const debPackage = readDebField('Package');
  const debVersion = readDebField('Version');
  const debArchitecture = readDebField('Architecture');
  if (debPackage !== baseName) {
    throw new Error(`Unexpected Debian package name: ${debPackage}`);
  }
  if (normalizeLinuxVersion(debVersion) !== normalizeLinuxVersion(version)) {
    throw new Error(
      `Unexpected Debian version: ${debVersion} (expected ${version})`,
    );
  }
  const expectedDebArchitecture = arch === 'x64' ? 'amd64' : 'arm64';
  if (debArchitecture !== expectedDebArchitecture) {
    throw new Error(
      `Unexpected Debian architecture: ${debArchitecture} (expected ${expectedDebArchitecture})`,
    );
  }
  const debContents = run('/usr/bin/dpkg-deb', ['--contents', debPath]).stdout;
  if (!debContents.includes(`/usr/bin/${baseName}`)) {
    throw new Error(`Debian package does not install /usr/bin/${baseName}`);
  }
  for (const relativePath of REQUIRED_ATTRIBUTION_PATHS) {
    if (
      !debContents.includes(
        `/resources/${ATTRIBUTION_DIRECTORY_NAME}/${relativePath}`,
      )
    ) {
      throw new Error(
        `Debian package is missing attribution file: ${relativePath}`,
      );
    }
  }
  if (!debContents.includes('/LICENSES.chromium.html')) {
    throw new Error('Debian package is missing LICENSES.chromium.html');
  }

  const rpmQuery = run('rpm', [
    '-qp',
    '--queryformat',
    '%{NAME}\\n%{VERSION}-%{RELEASE}\\n%{ARCH}\\n',
    rpmPath,
  ])
    .stdout.trim()
    .split(/\r?\n/);
  const [rpmPackage, rpmVersion, rpmArchitecture] = rpmQuery;
  if (rpmPackage !== baseName) {
    throw new Error(`Unexpected RPM package name: ${rpmPackage}`);
  }
  assertRpmVersionRelease(rpmVersion, version);
  const expectedRpmArchitecture = arch === 'x64' ? 'x86_64' : 'aarch64';
  if (rpmArchitecture !== expectedRpmArchitecture) {
    throw new Error(
      `Unexpected RPM architecture: ${rpmArchitecture} (expected ${expectedRpmArchitecture})`,
    );
  }
  const rpmContents = run('rpm', ['-qlp', rpmPath]).stdout;
  if (!rpmContents.includes(`/usr/bin/${baseName}`)) {
    throw new Error(`RPM package does not install /usr/bin/${baseName}`);
  }
  for (const relativePath of REQUIRED_ATTRIBUTION_PATHS) {
    if (
      !rpmContents.includes(
        `/resources/${ATTRIBUTION_DIRECTORY_NAME}/${relativePath}`,
      )
    ) {
      throw new Error(
        `RPM package is missing attribution file: ${relativePath}`,
      );
    }
  }
  if (!rpmContents.includes('/LICENSES.chromium.html')) {
    throw new Error('RPM package is missing LICENSES.chromium.html');
  }

  const debExtractionRoot = path.join(temporaryRoot, 'linux-deb');
  const rpmExtractionRoot = path.join(temporaryRoot, 'linux-rpm');
  mkdirSync(debExtractionRoot, { recursive: true });
  run('/usr/bin/dpkg-deb', ['--extract', debPath, debExtractionRoot]);
  const rpmExtraction = extractRpm(rpmPath, rpmExtractionRoot);
  const debPayload = await inspectExtractedApplication({
    appName: baseName,
    appVersion: version,
    arch,
    channel,
    electronRuntime,
    expectedPayload,
    extractionRoot: debExtractionRoot,
    label: 'Debian',
    outputPath: path.join(
      validationDirectory,
      `linux-${arch}-${version}-deb.cdx.json`,
    ),
    platform: 'linux',
  });
  const rpmPayload = await inspectExtractedApplication({
    appName: baseName,
    appVersion: version,
    arch,
    channel,
    electronRuntime,
    expectedPayload,
    extractionRoot: rpmExtractionRoot,
    label: 'RPM',
    outputPath: path.join(
      validationDirectory,
      `linux-${arch}-${version}-rpm.cdx.json`,
    ),
    platform: 'linux',
  });

  return {
    artifacts: [debPath, rpmPath, debPayload.sbom.path, rpmPayload.sbom.path],
    checks: {
      debian: {
        architecture: debArchitecture,
        package: debPackage,
        payload: {
          attribution: debPayload.attribution,
          appAsarSha256: debPayload.appAsarSha256,
          resourcesPath: path.relative(
            debExtractionRoot,
            debPayload.resourcesDirectory,
          ),
          sbom: debPayload.sbom,
        },
        version: debVersion,
      },
      rpm: {
        architecture: rpmArchitecture,
        extraction: rpmExtraction,
        package: rpmPackage,
        payload: {
          attribution: rpmPayload.attribution,
          appAsarSha256: rpmPayload.appAsarSha256,
          resourcesPath: path.relative(
            rpmExtractionRoot,
            rpmPayload.resourcesDirectory,
          ),
          sbom: rpmPayload.sbom,
        },
        version: rpmVersion,
      },
    },
  };
}

async function main() {
  const options = parseReleaseArtifactArguments(process.argv.slice(2));
  const pinnedNodeVersion = readFileSync(
    path.join(repositoryDirectory, '.node-version'),
    'utf8',
  ).trim();
  const actualNodeVersion = process.version.replace(/^v/, '');
  if (actualNodeVersion !== pinnedNodeVersion) {
    throw new Error(
      `Release validation requires Node ${pinnedNodeVersion}, got ${actualNodeVersion}`,
    );
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(browserDirectory, 'package.json'), 'utf8'),
  );
  const version = options.version ?? packageJson.version;
  const distribution = distributionConfig[options.distributionMode];
  const baseName =
    distribution.baseName ?? channelConfig[options.channel].baseName;
  const outputRoot = path.join(
    browserDirectory,
    'out',
    distribution.outputDirectoryName ?? options.channel,
  );
  const makeDirectory = path.join(outputRoot, 'make');
  const validationDirectory = path.join(outputRoot, 'validation');
  mkdirSync(validationDirectory, { recursive: true });
  const manifestPath = path.resolve(
    browserDirectory,
    options.output ??
      path.join(
        validationDirectory,
        `${options.platform}-${options.arch}-${version}.json`,
      ),
  );
  const checksumPath = path.join(
    path.dirname(manifestPath),
    `${options.platform}-${options.arch}-${version}.sha256`,
  );

  const electronPackage = resolveElectronRuntimeNoticePaths({
    appDirectory: browserDirectory,
  });
  const electronRuntime = {
    license: electronPackage.license,
    name: 'electron',
    version: electronPackage.version,
  };
  const packagedPlatform = options.platform === 'windows' ? 'win32' : 'linux';
  const packagedRoot = path.join(
    outputRoot,
    `${baseName}-${packagedPlatform}-${options.arch}`,
  );
  const packagedResourcesDirectory = path.join(packagedRoot, 'resources');
  const packagedAttribution = inspectPackagedAttribution({
    attributionDirectory: path.join(
      packagedResourcesDirectory,
      ATTRIBUTION_DIRECTORY_NAME,
    ),
    requireReady:
      isCommunityDistributionMode(options.distributionMode) ||
      options.channel !== 'dev',
  });
  const telemetryTrust =
    options.distributionMode === 'community-observed'
      ? inspectCommunityObservedTelemetryAsar(
          path.join(packagedResourcesDirectory, 'app.asar'),
        )
      : undefined;
  const expectedPayload = {
    appAsarSha256: await hashFile(
      path.join(packagedResourcesDirectory, 'app.asar'),
      'sha256',
    ),
    attributionManifestSha256: packagedAttribution.manifestSha256,
  };
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-final-artifact-validation.'),
  );
  try {
    const validation =
      options.platform === 'windows'
        ? await validateWindows({
            ...options,
            baseName,
            distributionMode: options.distributionMode,
            electronRuntime,
            expectedPayload,
            makeDirectory,
            temporaryRoot,
            validationDirectory,
            version,
          })
        : await validateLinux({
            ...options,
            baseName,
            electronRuntime,
            expectedPayload,
            makeDirectory,
            temporaryRoot,
            validationDirectory,
            version,
          });

    const artifacts = [];
    for (const artifactPath of validation.artifacts) {
      const stats = assertFile(artifactPath, 'Release artifact');
      artifacts.push({
        bytes: stats.size,
        path: artifactPath,
        sha256: await hashFile(artifactPath, 'sha256'),
      });
    }
    const publicationAssets = artifacts.map((artifact) => ({
      bytes: artifact.bytes,
      fileName: path.basename(artifact.path),
      sha256: artifact.sha256,
    }));
    if (
      new Set(publicationAssets.map((asset) => asset.fileName)).size !==
      publicationAssets.length
    ) {
      throw new Error('Validated publication asset filenames are not unique');
    }
    const distributionTrust = isCommunityDistributionMode(
      options.distributionMode,
    )
      ? options.platform === 'windows'
        ? {
            codeSigning: {
              packagedExecutable:
                validation.checks.packagedExecutableAuthenticode,
              setupExecutable: validation.checks.setupAuthenticode,
            },
            mode: options.distributionMode,
            notarization: 'not-applicable',
            osTrust: 'absent',
            updater: 'excluded',
            warningCode:
              options.distributionMode === 'community-observed'
                ? 'CLODEX_COMMUNITY_OBSERVED_NO_OS_TRUST'
                : 'CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST',
          }
        : {
            codeSigning: 'not-applicable',
            mode: options.distributionMode,
            notarization: 'not-applicable',
            osTrust: 'platform-package-unsigned',
            updater: 'excluded',
            warningCode:
              options.distributionMode === 'community-observed'
                ? 'CLODEX_COMMUNITY_OBSERVED_NO_OS_TRUST'
                : 'CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST',
          }
      : {
          mode: 'official',
          osTrust:
            options.platform === 'windows'
              ? options.allowUnsigned
                ? 'unsigned-allowed-local'
                : 'authenticode-required'
              : 'platform-package-default',
        };
    const manifest = {
      schemaVersion: 2,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      build: {
        arch: options.arch,
        channel: options.channel,
        distributionMode: options.distributionMode,
        nodeVersion: actualNodeVersion,
        platform: options.platform,
        releasePlanPath: options.releasePlanPath,
        releasePlanSha256: options.releasePlanSha256,
        sourceCommit: options.sourceCommit,
        tag: options.tag,
        version,
      },
      checks: validation.checks,
      distributionTrust,
      ...(telemetryTrust ? { telemetryTrust } : {}),
      artifacts,
      publication: {
        assets: publicationAssets,
        status: 'validated',
      },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      checksumPath,
      `${artifacts
        .map(
          (artifact) =>
            `${artifact.sha256}  ${path.relative(browserDirectory, artifact.path)}`,
        )
        .join('\n')}\n`,
    );
    console.log('[release-artifacts] Validation passed');
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Checksums: ${checksumPath}`);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      `[release-artifacts] ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  });
}
