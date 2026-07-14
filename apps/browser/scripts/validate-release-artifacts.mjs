import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { toSquirrelInternalVersion } from '../etc/squirrel-version.mjs';
import {
  ATTRIBUTION_DIRECTORY_NAME,
  inspectPackagedAttribution,
  REQUIRED_ATTRIBUTION_PATHS,
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

const help = `
Validate Windows or Linux Clodex release artifacts.

Usage:
  node scripts/validate-release-artifacts.mjs [options]

Options:
  --platform=<windows|linux>                  Target platform
  --channel=<dev|nightly|prerelease|release> Build channel (default: release)
  --arch=<arm64|x64>                         Target architecture
  --version=<semver>                         Package version
  --allow-unsigned                           Accept unsigned Windows binaries
  --output=<path>                            JSON manifest output path
  --help                                     Show this message
`;

function parseArguments(values) {
  const options = {
    allowUnsigned: false,
    arch: process.arch,
    channel: process.env.RELEASE_CHANNEL ?? 'release',
    output: undefined,
    platform: process.platform === 'win32' ? 'windows' : 'linux',
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
    } else if (value.startsWith('--output=')) {
      options.output = value.slice('--output='.length);
    } else if (value.startsWith('--platform=')) {
      options.platform = value.slice('--platform='.length);
    } else if (value.startsWith('--version=')) {
      options.version = value.slice('--version='.length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!(options.channel in channelConfig)) {
    throw new Error(`Unsupported release channel: ${options.channel}`);
  }
  if (!['arm64', 'x64'].includes(options.arch)) {
    throw new Error(`Unsupported architecture: ${options.arch}`);
  }
  if (!['windows', 'linux'].includes(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}`);
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
  makeDirectory,
  outputRoot,
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
  const packagedExecutable = path.join(
    outputRoot,
    `${baseName}-win32-${arch}`,
    `${baseName}.exe`,
  );

  const setupStats = assertFile(setupPath, 'Squirrel setup executable');
  const nupkgStats = assertFile(nupkgPath, 'Squirrel full nupkg');
  assertFile(releasesPath, 'Squirrel RELEASES manifest');
  assertFile(packagedExecutable, 'Packaged Windows executable');

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
  return {
    artifacts: [setupPath, nupkgPath, releasesPath],
    checks: {
      nupkg,
      squirrelInternalVersion: internalVersion,
      packagedExecutableAuthenticode: verifyAuthenticode(
        packagedExecutable,
        allowUnsigned,
      ),
      releasesEntry: {
        fileName: expectedName,
        sha1: actualSha1,
        size: nupkgStats.size,
      },
      setupAuthenticode: verifyAuthenticode(setupPath, allowUnsigned),
      setupBytes: setupStats.size,
    },
  };
}

function normalizeLinuxVersion(value) {
  return value.trim().replaceAll('~', '-').replaceAll('.', '-');
}

async function validateLinux({
  arch,
  baseName,
  makeDirectory,
  outputRoot,
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
  const packagedExecutable = path.join(
    outputRoot,
    `${baseName}-linux-${arch}`,
    baseName,
  );
  assertFile(packagedExecutable, 'Packaged Linux executable');

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
  if (
    !normalizeLinuxVersion(rpmVersion).startsWith(
      normalizeLinuxVersion(version),
    )
  ) {
    throw new Error(`Unexpected RPM version: ${rpmVersion}`);
  }
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

  return {
    artifacts: [debPath, rpmPath],
    checks: {
      debian: {
        architecture: debArchitecture,
        package: debPackage,
        version: debVersion,
      },
      rpm: {
        architecture: rpmArchitecture,
        package: rpmPackage,
        version: rpmVersion,
      },
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
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
  const { baseName } = channelConfig[options.channel];
  const outputRoot = path.join(browserDirectory, 'out', options.channel);
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

  const validation =
    options.platform === 'windows'
      ? await validateWindows({
          ...options,
          baseName,
          makeDirectory,
          outputRoot,
          version,
        })
      : await validateLinux({
          ...options,
          baseName,
          makeDirectory,
          outputRoot,
          version,
        });

  const packagedPlatform = options.platform === 'windows' ? 'win32' : 'linux';
  const packagedRoot = path.join(
    outputRoot,
    `${baseName}-${packagedPlatform}-${options.arch}`,
  );
  const resourcesDirectory = path.join(packagedRoot, 'resources');
  const attribution = inspectPackagedAttribution({
    attributionDirectory: path.join(
      resourcesDirectory,
      ATTRIBUTION_DIRECTORY_NAME,
    ),
    requireReady: options.channel !== 'dev',
  });
  const sbomPath = path.join(
    validationDirectory,
    `${options.platform}-${options.arch}-${version}.cdx.json`,
  );
  const sbom = await writeFinalArtifactSbom({
    applicationDirectory: packagedRoot,
    appName: baseName,
    appVersion: version,
    arch: options.arch,
    attribution,
    outputPath: sbomPath,
    platform: options.platform,
    resourcesDirectory,
  });
  validation.checks.attribution = {
    dependencyCount: attribution.dependencyCount,
    manifestSha256: attribution.manifestSha256,
    noticePaths: attribution.noticePaths,
    status: attribution.manifest.status,
  };
  validation.checks.sbom = sbom;
  validation.artifacts.push(sbomPath);

  const artifacts = [];
  for (const artifactPath of validation.artifacts) {
    const stats = assertFile(artifactPath, 'Release artifact');
    artifacts.push({
      bytes: stats.size,
      path: artifactPath,
      sha256: await hashFile(artifactPath, 'sha256'),
    });
  }
  const manifest = {
    schemaVersion: 1,
    status: 'passed',
    generatedAt: new Date().toISOString(),
    build: {
      arch: options.arch,
      channel: options.channel,
      nodeVersion: actualNodeVersion,
      platform: options.platform,
      version,
    },
    checks: validation.checks,
    artifacts,
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
}

main().catch((error) => {
  console.error(
    `[release-artifacts] ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
