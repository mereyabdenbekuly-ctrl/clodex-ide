import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(browserDirectory, '../..');

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

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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

  return {
    identifier: value('Identifier'),
    isAdhoc:
      value('Signature') === 'adhoc' ||
      (value('CodeDirectory')?.includes('(adhoc)') ?? false),
    signature: value('Signature'),
    teamIdentifier: value('TeamIdentifier'),
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

  const exit = await waitForProcess(child, 120_000);
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
    const text = Buffer.concat(output).toString('utf8');
    writeFileSync(logPath, text);
    throw new Error(
      `Clean-profile UI launch failed (startup=${startupComplete}, window=${windowShown}, exit=${child.exitCode})\n${text}`,
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

  const packageJson = JSON.parse(
    readFileSync(path.join(browserDirectory, 'package.json'), 'utf8'),
  );
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

  const updateServerConfigured = Boolean(
    process.env.UPDATE_SERVER_ORIGIN?.trim(),
  );
  if (
    !options.allowAdhoc &&
    options.channel !== 'dev' &&
    !updateServerConfigured
  ) {
    throw new Error(
      'UPDATE_SERVER_ORIGIN must be configured for distributable builds',
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
      run('pnpm', ['make', `--arch=${options.arch}`], {
        env: buildEnvironment,
        inherit: true,
      });
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
    const metadata = {
      architecture: run('/usr/bin/file', [
        path.join(appPath, 'Contents', 'MacOS', config.baseName),
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
    if (!options.allowAdhoc && packageSignature.isAdhoc) {
      throw new Error('Distributable build has an ad-hoc signature');
    }

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
      mountedSignature = inspectSignature(mountedAppPath);
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

    const manifest = {
      schemaVersion: 1,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      build: {
        arch: options.arch,
        channel: options.channel,
        nodeVersion: actualNodeVersion,
        pnpmVersion: run('pnpm', ['--version']).stdout.trim(),
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
        cleanProfileUiLaunch: uiLaunch,
        dmgVerified: true,
        smoke,
        zipVerified: true,
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
