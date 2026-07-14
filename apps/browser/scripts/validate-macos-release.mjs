import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  lstatSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectDeveloperIdSignature,
  inspectUpdateServerOrigin,
  parseCodesignAuthorities,
} from '../../../scripts/release/signing-readiness.mjs';
import {
  ATTRIBUTION_DIRECTORY_NAME,
  inspectPackagedAttribution,
  writeFinalArtifactSbom,
} from './release-attribution.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(browserDirectory, '../..');
const electronFuseSentinel = Buffer.from(
  'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX',
  'ascii',
);
const fuseStateNames = new Map([
  [0x30, 'disabled'],
  [0x31, 'enabled'],
  [0x72, 'removed'],
  [0x90, 'inherit'],
]);
const fuseNames = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];
const requiredFuseStates = new Map([
  ['RunAsNode', 'disabled'],
  ['EnableCookieEncryption', 'enabled'],
  ['EnableNodeOptionsEnvironmentVariable', 'disabled'],
  ['EnableNodeCliInspectArguments', 'disabled'],
  ['EnableEmbeddedAsarIntegrityValidation', 'enabled'],
  ['OnlyLoadAppFromAsar', 'enabled'],
]);

const channelConfig = {
  dev: {
    baseName: 'clodex-dev',
    bundleIdentifier: 'xyz.clodex.agentic-ide.dev',
    displayName: 'Clodex Agentic IDE (Dev-Build)',
  },
  nightly: {
    baseName: 'clodex-nightly',
    bundleIdentifier: 'xyz.clodex.agentic-ide.nightly',
    displayName: 'Clodex Agentic IDE Nightly',
  },
  prerelease: {
    baseName: 'clodex-prerelease',
    bundleIdentifier: 'xyz.clodex.agentic-ide.prerelease',
    displayName: 'Clodex Agentic IDE (Pre-Release)',
  },
  release: {
    baseName: 'clodex',
    bundleIdentifier: 'xyz.clodex.agentic-ide',
    displayName: 'Clodex Agentic IDE',
  },
};

const help = `
Validate a packaged macOS Clodex release and its DMG/ZIP artifacts.

Usage:
  node scripts/validate-macos-release.mjs [options]

Options:
  --channel=<dev|nightly|prerelease|release>  Build channel (default: release)
  --arch=<arm64|x64>                          Target architecture
  --version=<semver>                          Package version override
  --skip-make                                 Validate existing artifacts
  --allow-adhoc                               Accept an ad-hoc local signature
  --ui-launch                                 Launch the full copied application
  --output=<path>                             JSON manifest output path
  --help                                      Show this message
`;

function parseArguments(values) {
  const options = {
    allowAdhoc: false,
    arch: process.arch,
    channel: process.env.RELEASE_CHANNEL ?? 'release',
    output: undefined,
    skipMake: false,
    uiLaunch: false,
    version: process.env.APP_VERSION_OVERRIDE,
  };

  for (const value of values) {
    if (value === '--') {
      continue;
    } else if (value === '--allow-adhoc') {
      options.allowAdhoc = true;
    } else if (value === '--skip-make') {
      options.skipMake = true;
    } else if (value === '--ui-launch') {
      options.uiLaunch = true;
    } else if (value === '--help') {
      console.log(help.trim());
      process.exit(0);
    } else if (value.startsWith('--arch=')) {
      options.arch = value.slice('--arch='.length);
    } else if (value.startsWith('--channel=')) {
      options.channel = value.slice('--channel='.length);
    } else if (value.startsWith('--output=')) {
      options.output = value.slice('--output='.length);
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
    throw new Error(`Unsupported macOS architecture: ${options.arch}`);
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
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}\n${output}`,
    );
  }

  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function printStep(message) {
  console.log(`\n[release-validation] ${message}`);
}

function readPlistValue(plistPath, key) {
  return run('/usr/libexec/PlistBuddy', [
    '-c',
    `Print :${key}`,
    plistPath,
  ]).stdout.trim();
}

function readPlistJson(plistPath, key) {
  const args = key
    ? ['-extract', key, 'json', '-o', '-', plistPath]
    : ['-convert', 'json', '-o', '-', plistPath];
  return JSON.parse(run('/usr/bin/plutil', args).stdout);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function readAsarHeaderString(asarPath) {
  const descriptor = openSync(asarPath, 'r');
  let header;
  try {
    const sizeBuffer = Buffer.alloc(8);
    if (readSync(descriptor, sizeBuffer, 0, sizeBuffer.length, 0) !== 8) {
      throw new Error('Packaged ASAR is too small to contain a valid header');
    }

    const headerSize = sizeBuffer.readUInt32LE(4);
    if (headerSize < 8 || headerSize > statSync(asarPath).size - 8) {
      throw new Error(
        `Packaged ASAR has an invalid header size: ${headerSize}`,
      );
    }

    header = Buffer.alloc(headerSize);
    if (readSync(descriptor, header, 0, headerSize, 8) !== headerSize) {
      throw new Error('Packaged ASAR header could not be read completely');
    }
  } finally {
    closeSync(descriptor);
  }

  const headerStringLength = header.readInt32LE(4);
  const headerStringOffset = 8;
  const headerStringEnd = headerStringOffset + headerStringLength;
  if (headerStringLength < 0 || headerStringEnd > header.length) {
    throw new Error(
      `Packaged ASAR has an invalid header string length: ${headerStringLength}`,
    );
  }

  return header.subarray(headerStringOffset, headerStringEnd).toString('utf8');
}

function inspectSignature(appPath) {
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ]);
  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
    allowFailure: true,
  });
  const output = `${details.stdout}\n${details.stderr}`;
  const value = (name) =>
    output.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? null;

  const codeDirectory =
    output.match(/^CodeDirectory\s+(.+)$/m)?.[1]?.trim() ??
    value('CodeDirectory');
  return {
    authorities: parseCodesignAuthorities(output),
    codeDirectory,
    hardenedRuntime: /\bruntime\b/.test(codeDirectory ?? ''),
    identifier: value('Identifier'),
    isAdhoc:
      value('Signature') === 'adhoc' ||
      (value('CodeDirectory')?.includes('(adhoc)') ?? false),
    signature: value('Signature'),
    teamIdentifier: value('TeamIdentifier'),
  };
}

function assertSignatureSecurity(signature, allowAdhoc, label) {
  if (allowAdhoc && signature.isAdhoc) return;
  if (signature.isAdhoc) {
    throw new Error(`${label} has an ad-hoc signature`);
  }
  if (!signature.hardenedRuntime) {
    throw new Error(`${label} is not signed with hardened runtime`);
  }
  if (!signature.teamIdentifier || signature.teamIdentifier === 'not set') {
    throw new Error(`${label} does not have a signing team identifier`);
  }
  const developerId = inspectDeveloperIdSignature(signature);
  if (!developerId.ok) {
    throw new Error(
      `${label} is not a valid Developer ID Application signature [${developerId.code}]`,
    );
  }
}

function inspectElectronFuses(appPath) {
  const fuseBinaryPath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  );
  if (!existsSync(fuseBinaryPath)) {
    throw new Error(`Electron fuse binary not found: ${fuseBinaryPath}`);
  }
  const executable = readFileSync(fuseBinaryPath);
  const wires = [];
  let searchOffset = 0;

  while (searchOffset < executable.length) {
    const sentinelOffset = executable.indexOf(
      electronFuseSentinel,
      searchOffset,
    );
    if (sentinelOffset === -1) break;

    const wireOffset = sentinelOffset + electronFuseSentinel.length;
    const version = executable[wireOffset];
    const length = executable[wireOffset + 1];
    if (version === undefined || length === undefined) {
      throw new Error('Electron fuse wire is truncated');
    }

    const states = {};
    for (let index = 0; index < length; index += 1) {
      const rawState = executable[wireOffset + 2 + index];
      const name = fuseNames[index] ?? `UnknownFuse${index}`;
      const state = fuseStateNames.get(rawState);
      if (!state) {
        throw new Error(
          `Electron fuse ${name} has an unknown state byte: ${rawState}`,
        );
      }
      states[name] = state;
    }

    for (const [name, expectedState] of requiredFuseStates) {
      if (states[name] !== expectedState) {
        throw new Error(
          `Electron fuse ${name} is ${states[name] ?? 'missing'} (expected ${expectedState})`,
        );
      }
    }

    wires.push({ length, states, version });
    searchOffset = sentinelOffset + electronFuseSentinel.length;
  }

  if (wires.length === 0) {
    throw new Error('Electron fuse sentinel was not found in the executable');
  }

  return {
    binaryPath: path.relative(appPath, fuseBinaryPath),
    required: Object.fromEntries(requiredFuseStates),
    wires,
  };
}

async function inspectAsarIntegrity(appPath, infoPlistPath) {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const unpackedAppPath = path.join(resourcesPath, 'app');
  if (!existsSync(asarPath) || !statSync(asarPath).isFile()) {
    throw new Error(`Packaged ASAR not found: ${asarPath}`);
  }
  if (existsSync(unpackedAppPath)) {
    throw new Error(
      `Unpacked application source is present: ${unpackedAppPath}`,
    );
  }

  const integrity = readPlistJson(infoPlistPath, 'ElectronAsarIntegrity');
  const entry = integrity['Resources/app.asar'];
  if (!entry || entry.algorithm !== 'SHA256') {
    throw new Error(
      'Info.plist does not contain SHA256 ElectronAsarIntegrity for Resources/app.asar',
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.hash ?? '')) {
    throw new Error('ElectronAsarIntegrity contains an invalid SHA256 hash');
  }

  const headerString = readAsarHeaderString(asarPath);
  const headerHash = createHash('sha256').update(headerString).digest('hex');
  if (headerHash.toLowerCase() !== entry.hash.toLowerCase()) {
    throw new Error(
      `ASAR header integrity hash mismatch: ${headerHash} (expected ${entry.hash})`,
    );
  }

  return {
    algorithm: entry.algorithm,
    bytes: statSync(asarPath).size,
    fileSha256: await sha256(asarPath),
    headerHash,
    unpackedSourceAbsent: true,
  };
}

function inspectSignedEntitlements(appPath, temporaryRoot) {
  const extractedPath = path.join(temporaryRoot, 'signed-entitlements.plist');
  const result = run('/usr/bin/codesign', [
    '--display',
    '--entitlements',
    ':-',
    appPath,
  ]);
  if (!result.stdout.trim()) {
    throw new Error('Signed application does not expose entitlements');
  }
  writeFileSync(extractedPath, result.stdout);

  const configuredPath = path.join(
    browserDirectory,
    'etc',
    'macos',
    'entitlements.plist',
  );
  const configured = readPlistJson(configuredPath);
  const signed = readPlistJson(extractedPath);
  for (const [name, expectedValue] of Object.entries(configured)) {
    if (signed[name] !== expectedValue) {
      throw new Error(
        `Signed entitlement ${name} is ${String(signed[name])} (expected ${String(expectedValue)})`,
      );
    }
  }

  return {
    configuredKeys: Object.keys(configured).sort(),
    signedKeys: Object.keys(signed).sort(),
  };
}

function assessGatekeeper(appPath) {
  const result = run(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=4', appPath],
    { allowFailure: true },
  );
  return {
    exitCode: result.status,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    passed: result.status === 0,
  };
}

function assessDiskImage(dmgPath) {
  const result = run(
    '/usr/sbin/spctl',
    [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=4',
      dmgPath,
    ],
    { allowFailure: true },
  );
  return {
    exitCode: result.status,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    passed: result.status === 0,
  };
}

function validateStapler(targetPath) {
  const result = run('/usr/bin/xcrun', ['stapler', 'validate', targetPath], {
    allowFailure: true,
  });
  return {
    exitCode: result.status,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    passed: result.status === 0,
  };
}

function waitForProcess(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timed out after ${timeoutMs} ms`));
      } else {
        resolve({ code, signal });
      }
    });
  });
}

function findFatalStartupLines(text) {
  const patterns = [
    'uncaught exception',
    'unhandled rejection',
    'err_module_not_found',
    'module_not_found',
    'fatal error',
  ];
  return text
    .split(/\r?\n/)
    .filter((line) =>
      patterns.some((pattern) => line.toLowerCase().includes(pattern)),
    );
}

async function runSmokeTest(executablePath, profilePath, logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const output = [];
  const startedAt = performance.now();
  const child = spawn(
    executablePath,
    [`--user-data-dir=${profilePath}`, '--disable-gpu', '--smoke-test'],
    {
      cwd: path.dirname(executablePath),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));

  let exit;
  try {
    exit = await waitForProcess(child, 120_000);
  } catch (error) {
    const text = Buffer.concat(output).toString('utf8');
    writeFileSync(logPath, text);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; output saved to ${logPath}`,
      { cause: error },
    );
  }
  const text = Buffer.concat(output).toString('utf8');
  writeFileSync(logPath, text);
  const marker = '[smoke-test] App ready — all modules loaded successfully.';
  const fatalLines = findFatalStartupLines(text);
  if (exit.code !== 0 || !text.includes(marker) || fatalLines.length > 0) {
    throw new Error(
      `Packaged smoke failed (code=${exit.code}, signal=${exit.signal ?? 'none'})\n${text}`,
    );
  }

  return {
    durationMs: Math.round(performance.now() - startedAt),
    exitCode: exit.code,
    fatalLines,
    gpuDisabled: true,
    logPath,
    successMarker: true,
  };
}

async function runUiLaunch(executablePath, profilePath, logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const output = [];
  const startedAt = performance.now();
  const child = spawn(
    executablePath,
    [`--user-data-dir=${profilePath}`, '--disable-gpu'],
    {
      cwd: path.dirname(executablePath),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));

  let startupComplete = false;
  let windowShown = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const text = Buffer.concat(output).toString('utf8');
    startupComplete ||= text.includes('[Main] Startup complete');
    windowShown ||= text.includes('[WindowLayoutService] Window shown');
    if (startupComplete && windowShown) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!startupComplete || !windowShown || child.exitCode !== null) {
    child.kill('SIGTERM');
    let terminationError = null;
    try {
      await waitForProcess(child, 10_000);
    } catch (error) {
      terminationError = error;
    }
    const text = Buffer.concat(output).toString('utf8');
    writeFileSync(logPath, text);
    throw new Error(
      `Clean-profile UI launch failed (startup=${startupComplete}, window=${windowShown}, exit=${child.exitCode})${
        terminationError instanceof Error
          ? `; cleanup=${terminationError.message}`
          : ''
      }\n${text}`,
    );
  }

  child.kill('SIGTERM');
  const exit = await waitForProcess(child, 30_000);
  const text = Buffer.concat(output).toString('utf8');
  writeFileSync(logPath, text);
  const fatalLines = findFatalStartupLines(text);
  if (fatalLines.length > 0) {
    throw new Error(
      `Clean-profile UI launch reported fatal startup output:\n${fatalLines.join('\n')}`,
    );
  }

  return {
    durationMs: Math.round(performance.now() - startedAt),
    exitCode: exit.code,
    fatalLines,
    gpuDisabled: true,
    logPath,
    startupComplete,
    windowShown,
  };
}

function findMountedApplication(mountPath, expectedName) {
  const expectedPath = path.join(mountPath, `${expectedName}.app`);
  if (existsSync(expectedPath)) return expectedPath;

  const applications = readdirSync(mountPath)
    .filter((entry) => entry.endsWith('.app'))
    .map((entry) => path.join(mountPath, entry));
  if (applications.length !== 1) {
    throw new Error(
      `Expected one application in mounted DMG, found ${applications.length}`,
    );
  }
  return applications[0];
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS release validation must run on macOS');
  }

  const options = parseArguments(process.argv.slice(2));
  const pinnedNodeVersion = readFileSync(
    path.join(repositoryDirectory, '.node-version'),
    'utf8',
  ).trim();
  const actualNodeVersion = process.version.replace(/^v/, '');
  if (actualNodeVersion !== pinnedNodeVersion) {
    throw new Error(
      `Packaging runtime mismatch: expected Node ${pinnedNodeVersion}, got ${actualNodeVersion}`,
    );
  }

  const repositoryPackageJson = JSON.parse(
    readFileSync(path.join(repositoryDirectory, 'package.json'), 'utf8'),
  );
  const packageManagerMatch = /^pnpm@(.+)$/.exec(
    repositoryPackageJson.packageManager ?? '',
  );
  if (!packageManagerMatch) {
    throw new Error('Root package.json must pin pnpm via packageManager');
  }
  const pinnedPnpmVersion = packageManagerMatch[1];
  const actualPnpmVersion = run('pnpm', ['--version'], {
    cwd: repositoryDirectory,
  }).stdout.trim();
  if (actualPnpmVersion !== pinnedPnpmVersion) {
    throw new Error(
      `Packaging package-manager mismatch: expected pnpm ${pinnedPnpmVersion}, got ${actualPnpmVersion}`,
    );
  }

  const packageJsonPath = path.join(browserDirectory, 'package.json');
  const packageJsonSource = readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageJsonSource);
  const version = options.version ?? packageJson.version;
  const config = channelConfig[options.channel];
  const outputRoot = path.join(browserDirectory, 'out', options.channel);
  const validationDirectory = path.join(outputRoot, 'validation');
  mkdirSync(validationDirectory, { recursive: true });

  const manifestPath = path.resolve(
    browserDirectory,
    options.output ??
      path.join(validationDirectory, `macos-${options.arch}-${version}.json`),
  );
  const checksumPath = path.join(
    path.dirname(manifestPath),
    `macos-${options.arch}-${version}.sha256`,
  );
  const buildEnvironment = {
    ...process.env,
    APP_VERSION_OVERRIDE: version,
    RELEASE_CHANNEL: options.channel,
  };
  if (options.allowAdhoc) {
    buildEnvironment.CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD = 'true';
  }

  const updateServer = inspectUpdateServerOrigin(
    process.env.UPDATE_SERVER_ORIGIN,
  );
  const updateServerConfigured = updateServer.ok;
  if (
    !options.allowAdhoc &&
    options.channel !== 'dev' &&
    !updateServerConfigured
  ) {
    throw new Error(
      `UPDATE_SERVER_ORIGIN must be a valid HTTPS update-server URL for distributable builds [${updateServer.code}]`,
    );
  }

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-release-validation.'),
  );

  try {
    if (!options.skipMake) {
      printStep(
        `Building ${options.channel} ${options.arch} artifacts with Node ${actualNodeVersion}`,
      );
      const packageVersionOverride = packageJson.version !== version;
      try {
        if (packageVersionOverride) {
          writeFileSync(
            packageJsonPath,
            `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`,
          );
        }
        run(
          'pnpm',
          ['--dir', 'apps/browser', 'make', `--arch=${options.arch}`],
          {
            cwd: repositoryDirectory,
            env: buildEnvironment,
            inherit: true,
          },
        );
      } finally {
        if (packageVersionOverride) {
          writeFileSync(packageJsonPath, packageJsonSource);
        }
      }
    }

    const appPath = path.join(
      outputRoot,
      `${config.baseName}-darwin-${options.arch}`,
      `${config.baseName}.app`,
    );
    const dmgPath = path.join(
      outputRoot,
      'make',
      `${config.baseName}-${version}-${options.arch}.dmg`,
    );
    const zipPath = path.join(
      outputRoot,
      'make',
      'zip',
      'darwin',
      options.arch,
      `${config.baseName}-darwin-${options.arch}-${version}.zip`,
    );
    for (const artifactPath of [appPath, dmgPath, zipPath]) {
      if (!existsSync(artifactPath)) {
        throw new Error(`Expected release artifact not found: ${artifactPath}`);
      }
    }

    printStep('Verifying packaged application metadata and signature');
    const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
    const packagedExecutablePath = path.join(
      appPath,
      'Contents',
      'MacOS',
      config.baseName,
    );
    const metadata = {
      architecture: run('/usr/bin/file', [
        packagedExecutablePath,
      ]).stdout.trim(),
      bundleIdentifier: readPlistValue(infoPlistPath, 'CFBundleIdentifier'),
      displayName: readPlistValue(infoPlistPath, 'CFBundleDisplayName'),
      version: readPlistValue(infoPlistPath, 'CFBundleShortVersionString'),
    };
    if (metadata.displayName !== config.displayName) {
      throw new Error(
        `Unexpected display name: ${metadata.displayName} (expected ${config.displayName})`,
      );
    }
    if (metadata.version !== version) {
      throw new Error(
        `Unexpected packaged version: ${metadata.version} (expected ${version})`,
      );
    }
    if (metadata.bundleIdentifier !== config.bundleIdentifier) {
      throw new Error(
        `Unexpected bundle identifier: ${metadata.bundleIdentifier} (expected ${config.bundleIdentifier})`,
      );
    }
    const expectedArchitecture = options.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (!metadata.architecture.includes(expectedArchitecture)) {
      throw new Error(
        `Unexpected executable architecture: ${metadata.architecture} (expected ${expectedArchitecture})`,
      );
    }

    const packageSignature = inspectSignature(appPath);
    assertSignatureSecurity(
      packageSignature,
      options.allowAdhoc,
      'Packaged application',
    );

    printStep('Verifying ASAR integrity, Electron fuses, and entitlements');
    const asarIntegrity = await inspectAsarIntegrity(appPath, infoPlistPath);
    const packagedAttribution = inspectPackagedAttribution({
      attributionDirectory: path.join(
        appPath,
        'Contents',
        'Resources',
        ATTRIBUTION_DIRECTORY_NAME,
      ),
      requireReady: options.channel !== 'dev',
    });
    const fuses = inspectElectronFuses(appPath);
    const entitlements =
      options.allowAdhoc && packageSignature.isAdhoc
        ? { skipped: 'ad-hoc-local-build' }
        : inspectSignedEntitlements(appPath, temporaryRoot);

    printStep('Verifying DMG checksum and ZIP integrity');
    run('/usr/bin/hdiutil', ['verify', dmgPath], { inherit: true });
    run('/usr/bin/unzip', ['-t', zipPath]);
    const dmgGatekeeper = assessDiskImage(dmgPath);
    const dmgStapler = validateStapler(dmgPath);
    if (!options.allowAdhoc && !dmgGatekeeper.passed) {
      throw new Error(
        `Gatekeeper rejected distributable DMG: ${dmgGatekeeper.output}`,
      );
    }
    if (!options.allowAdhoc && !dmgStapler.passed) {
      throw new Error(
        `No valid notarization ticket is stapled to the DMG: ${dmgStapler.output}`,
      );
    }

    const mountPath = path.join(temporaryRoot, 'mount');
    const installPath = path.join(temporaryRoot, 'install');
    const profilePath = path.join(temporaryRoot, 'profile');
    mkdirSync(mountPath);
    mkdirSync(installPath);

    let mounted = false;
    let mountedSignature;
    let gatekeeper;
    let mountedStapler;
    let copiedAppPath;
    try {
      printStep('Mounting DMG read-only and copying the installed application');
      run('/usr/bin/hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        mountPath,
        dmgPath,
      ]);
      mounted = true;

      const applicationsLink = path.join(mountPath, 'Applications');
      if (
        !existsSync(applicationsLink) ||
        !lstatSync(applicationsLink).isSymbolicLink() ||
        readlinkSync(applicationsLink) !== '/Applications'
      ) {
        throw new Error(
          'Mounted DMG does not contain the expected Applications symlink',
        );
      }

      const mountedAppPath = findMountedApplication(
        mountPath,
        config.displayName,
      );
      const mountedAttribution = inspectPackagedAttribution({
        attributionDirectory: path.join(
          mountedAppPath,
          'Contents',
          'Resources',
          ATTRIBUTION_DIRECTORY_NAME,
        ),
        requireReady: options.channel !== 'dev',
      });
      if (
        mountedAttribution.manifestSha256 !== packagedAttribution.manifestSha256
      ) {
        throw new Error(
          'Mounted DMG application attribution manifest differs from the packaged application',
        );
      }
      mountedSignature = inspectSignature(mountedAppPath);
      assertSignatureSecurity(
        mountedSignature,
        options.allowAdhoc,
        'Mounted application',
      );
      gatekeeper = assessGatekeeper(mountedAppPath);
      mountedStapler = validateStapler(mountedAppPath);
      if (!options.allowAdhoc && !gatekeeper.passed) {
        throw new Error(
          `Gatekeeper rejected distributable application: ${gatekeeper.output}`,
        );
      }
      if (!options.allowAdhoc && !mountedStapler.passed) {
        throw new Error(
          `No valid notarization ticket is stapled to the application: ${mountedStapler.output}`,
        );
      }

      copiedAppPath = path.join(installPath, `${config.displayName}.app`);
      run('/usr/bin/ditto', [mountedAppPath, copiedAppPath]);
    } finally {
      if (mounted) {
        run('/usr/bin/hdiutil', ['detach', mountPath], {
          allowFailure: true,
        });
      }
    }

    const copiedSignature = inspectSignature(copiedAppPath);
    const copiedAttribution = inspectPackagedAttribution({
      attributionDirectory: path.join(
        copiedAppPath,
        'Contents',
        'Resources',
        ATTRIBUTION_DIRECTORY_NAME,
      ),
      requireReady: options.channel !== 'dev',
    });
    if (
      copiedAttribution.manifestSha256 !== packagedAttribution.manifestSha256
    ) {
      throw new Error(
        'Copied application attribution manifest differs from the packaged application',
      );
    }
    assertSignatureSecurity(
      copiedSignature,
      options.allowAdhoc,
      'Copied application',
    );
    const copiedGatekeeper = assessGatekeeper(copiedAppPath);
    const copiedStapler = validateStapler(copiedAppPath);
    if (!options.allowAdhoc && !copiedGatekeeper.passed) {
      throw new Error(
        `Gatekeeper rejected copied distributable application: ${copiedGatekeeper.output}`,
      );
    }
    if (!options.allowAdhoc && !copiedStapler.passed) {
      throw new Error(
        `Copied application lost its notarization ticket: ${copiedStapler.output}`,
      );
    }
    const executablePath = path.join(
      copiedAppPath,
      'Contents',
      'MacOS',
      config.baseName,
    );

    printStep('Running copied application smoke test on an isolated profile');
    const smoke = await runSmokeTest(
      executablePath,
      path.join(profilePath, 'smoke'),
      path.join(
        validationDirectory,
        `macos-${options.arch}-${version}-smoke.log`,
      ),
    );

    let uiLaunch = null;
    if (options.uiLaunch) {
      printStep('Running full clean-profile UI launch');
      uiLaunch = await runUiLaunch(
        executablePath,
        path.join(profilePath, 'ui'),
        path.join(
          validationDirectory,
          `macos-${options.arch}-${version}-ui.log`,
        ),
      );
    }

    const sbomPath = path.join(
      validationDirectory,
      `macos-${options.arch}-${version}.cdx.json`,
    );
    const sbom = await writeFinalArtifactSbom({
      applicationDirectory: appPath,
      appName: config.displayName,
      appVersion: version,
      arch: options.arch,
      attribution: packagedAttribution,
      outputPath: sbomPath,
      platform: 'macos',
      resourcesDirectory: path.join(appPath, 'Contents', 'Resources'),
    });

    const artifacts = {};
    for (const [name, artifactPath] of Object.entries({
      dmg: dmgPath,
      zip: zipPath,
    })) {
      artifacts[name] = {
        bytes: statSync(artifactPath).size,
        path: artifactPath,
        sha256: await sha256(artifactPath),
      };
    }
    artifacts.app = {
      bytes:
        Number(
          run('/usr/bin/du', ['-sk', appPath]).stdout.trim().split(/\s+/)[0],
        ) * 1024,
      path: appPath,
    };
    artifacts.sbom = sbom;

    const manifest = {
      schemaVersion: 1,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      build: {
        arch: options.arch,
        channel: options.channel,
        nodeVersion: actualNodeVersion,
        pnpmVersion: actualPnpmVersion,
        updateServerConfigured,
        version,
      },
      metadata,
      signature: {
        copied: copiedSignature,
        mounted: mountedSignature,
        packaged: packageSignature,
        requiredMode: options.allowAdhoc ? 'adhoc-allowed' : 'developer-id',
      },
      trust: {
        applicationGatekeeper: gatekeeper,
        applicationStapler: mountedStapler,
        copiedApplicationGatekeeper: copiedGatekeeper,
        copiedApplicationStapler: copiedStapler,
        dmgGatekeeper,
        dmgStapler,
      },
      checks: {
        attribution: {
          dependencyCount: packagedAttribution.dependencyCount,
          manifestSha256: packagedAttribution.manifestSha256,
          noticePaths: packagedAttribution.noticePaths,
          status: packagedAttribution.manifest.status,
        },
        cleanProfileUiLaunch: uiLaunch,
        dmgVerified: true,
        sbom,
        smoke,
        zipVerified: true,
      },
      security: {
        asarIntegrity,
        entitlements,
        fuses,
        hardenedRuntimeRequired: !options.allowAdhoc,
      },
      artifacts,
    };

    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      checksumPath,
      [
        `${artifacts.dmg.sha256}  ${path.basename(dmgPath)}`,
        `${artifacts.zip.sha256}  ${path.basename(zipPath)}`,
        `${artifacts.sbom.sha256}  ${path.basename(sbomPath)}`,
        '',
      ].join('\n'),
    );

    printStep('Release validation passed');
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Checksums: ${checksumPath}`);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(
    `[release-validation] FAILED: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
