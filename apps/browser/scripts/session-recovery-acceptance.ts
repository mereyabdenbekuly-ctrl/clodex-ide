import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createSessionRecoveryAcceptanceEvidence,
  parseSessionRecoveryPhaseArtifact,
  SESSION_RECOVERY_ACCEPTANCE_ARTIFACT_DIRECTORY,
  SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER,
  SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER_CONTENT,
  SESSION_RECOVERY_ACCEPTANCE_SWITCH,
  type SessionRecoveryAcceptancePhase,
  type SessionRecoverySeedArtifact,
  type SessionRecoveryVerifyArtifact,
} from '../src/shared/session-recovery-acceptance';

const PACKAGED_ACCEPTANCE_MUTEX =
  process.platform === 'darwin'
    ? '/private/tmp/clodex-packaged-acceptance.lock'
    : path.join(os.tmpdir(), 'clodex-packaged-acceptance.lock');
const DEFAULT_PHASE_TIMEOUT_MS = 180_000;
const DEFAULT_MUTEX_TIMEOUT_MS = 180_000;
const MAX_CAPTURED_OUTPUT_BYTES = 10 * 1024 * 1024;

interface HarnessOptions {
  executablePath: string;
  outputPath: string;
  phaseTimeoutMs: number;
  mutexTimeoutMs: number;
}

interface PhaseRun<TArtifact> {
  artifact: TArtifact;
  durationMs: number;
}

void runHarness().catch((error: unknown) => {
  console.error(
    `[session-recovery-acceptance] failed reason=${classifyHarnessFailure(error)}`,
  );
  process.exitCode = 1;
});

async function runHarness(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  let mutexNonce: string | null = null;
  let profilePath: string | null = null;

  try {
    await assertPackagedExecutable(options.executablePath);
    const executableDigest = await hashFile(options.executablePath);
    profilePath = await mkdtemp(
      path.join(os.tmpdir(), 'clodex-session-recovery-acceptance-'),
    );
    await writeFile(
      path.join(profilePath, SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER),
      SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER_CONTENT,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );

    mutexNonce = await acquirePackagedAcceptanceMutex(options.mutexTimeoutMs);

    const seed = await runPhase<SessionRecoverySeedArtifact>(
      'seed',
      options,
      profilePath,
    );
    const verify = await runPhase<SessionRecoveryVerifyArtifact>(
      'verify',
      options,
      profilePath,
    );
    if ((await hashFile(options.executablePath)) !== executableDigest) {
      throw new Error('packaged-executable-changed');
    }
    const evidence = createSessionRecoveryAcceptanceEvidence({
      seed: seed.artifact,
      verify: verify.artifact,
      seedDurationMs: seed.durationMs,
      verifyDurationMs: verify.durationMs,
    });
    await writeJsonAtomically(options.outputPath, evidence);
    console.log(
      `[session-recovery-acceptance] passed seed=${Math.round(seed.durationMs)}ms verify=${Math.round(verify.durationMs)}ms`,
    );
    console.log('[session-recovery-acceptance] content-free evidence written');
  } finally {
    if (profilePath) {
      await rm(profilePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    if (mutexNonce) {
      await releasePackagedAcceptanceMutex(mutexNonce);
    }
  }
}

async function runPhase<
  TArtifact extends SessionRecoverySeedArtifact | SessionRecoveryVerifyArtifact,
>(
  phase: SessionRecoveryAcceptancePhase,
  options: HarnessOptions,
  profilePath: string,
): Promise<PhaseRun<TArtifact>> {
  const output: Buffer[] = [];
  let capturedBytes = 0;
  const startedAt = performance.now();
  const child = spawn(
    options.executablePath,
    [
      `--user-data-dir=${profilePath}`,
      '--disable-gpu',
      `--${SESSION_RECOVERY_ACCEPTANCE_SWITCH}=${phase}`,
    ],
    {
      cwd: path.dirname(options.executablePath),
      env: createSanitizedAcceptanceEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk: Buffer) => {
    capturedBytes += chunk.byteLength;
    if (capturedBytes <= MAX_CAPTURED_OUTPUT_BYTES) output.push(chunk);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  const exit = await waitForProcess(child, options.phaseTimeoutMs);
  const text = Buffer.concat(output).toString('utf8');
  assertGracefulPhaseExit(phase, exit, text, capturedBytes);

  const artifactPath = path.join(
    profilePath,
    SESSION_RECOVERY_ACCEPTANCE_ARTIFACT_DIRECTORY,
    `${phase}.json`,
  );
  const artifact = parseSessionRecoveryPhaseArtifact(
    JSON.parse(await readFile(artifactPath, 'utf8')),
  );
  if (artifact.phase !== phase) {
    throw new Error(`Session recovery ${phase} artifact phase mismatch`);
  }
  return {
    artifact: artifact as TArtifact,
    durationMs: performance.now() - startedAt,
  };
}

function assertGracefulPhaseExit(
  phase: SessionRecoveryAcceptancePhase,
  exit: { code: number | null; signal: NodeJS.Signals | null },
  output: string,
  capturedBytes: number,
): void {
  const requiredMarkers = [
    `[session-recovery-acceptance] phase=${phase} status=passed`,
    '[AgentManager] Tail-flush complete:',
    '[Main] Services shut down',
  ];
  const forbiddenMarkers = [
    'Shutdown budget of',
    'Final saveState failed',
    'Failed to teardown agentManagerService',
    '[Clodex] Startup failed',
    '[Process] Uncaught exception',
    '[Process] Unhandled rejection',
  ];
  const missing = requiredMarkers.filter((marker) => !output.includes(marker));
  const forbidden = forbiddenMarkers.filter((marker) =>
    output.includes(marker),
  );
  if (
    exit.code !== 0 ||
    exit.signal !== null ||
    capturedBytes > MAX_CAPTURED_OUTPUT_BYTES ||
    missing.length > 0 ||
    !/\[AgentManager\] Tail-flush complete:.*\(0 failed\)/u.test(output) ||
    forbidden.length > 0
  ) {
    throw new Error(
      [
        `Packaged session recovery ${phase} phase failed`,
        `exit=${exit.code ?? 'null'} signal=${exit.signal ?? 'none'}`,
        missing.length > 0 ? `missing=${missing.join(',')}` : '',
        forbidden.length > 0 ? `forbidden=${forbidden.join(',')}` : '',
        capturedBytes > MAX_CAPTURED_OUTPUT_BYTES
          ? 'output=capture-limit-exceeded'
          : '',
        !/\[AgentManager\] Tail-flush complete:.*\(0 failed\)/u.test(output)
          ? 'tail-flush=failed-or-missing'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

async function waitForProcess(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `Packaged session recovery phase timed out after ${timeoutMs}ms`,
          ),
        );
        return;
      }
      resolve({ code, signal });
    });
  });
}

async function acquirePackagedAcceptanceMutex(
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let backoffMs = 250;
  while (true) {
    const nonce = randomUUID();
    try {
      await mkdir(PACKAGED_ACCEPTANCE_MUTEX, { mode: 0o700 });
      await writeFile(
        path.join(PACKAGED_ACCEPTANCE_MUTEX, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, nonce, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      return nonce;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(PACKAGED_ACCEPTANCE_MUTEX, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        throw error;
      }
      if (await reclaimAbandonedPackagedAcceptanceMutex()) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for packaged acceptance mutex after ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 2_000);
    }
  }
}

async function reclaimAbandonedPackagedAcceptanceMutex(): Promise<boolean> {
  const ownerPath = path.join(PACKAGED_ACCEPTANCE_MUTEX, 'owner.json');
  const owner = await readFile(ownerPath, 'utf8')
    .then((value) => JSON.parse(value) as { pid?: unknown })
    .catch(() => null);
  if (!owner || !Number.isInteger(owner.pid) || Number(owner.pid) < 1) {
    const lockStat = await stat(PACKAGED_ACCEPTANCE_MUTEX).catch(() => null);
    if (!lockStat || Date.now() - lockStat.mtimeMs < 60_000) return false;
  } else {
    try {
      process.kill(Number(owner.pid), 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  }

  const abandonedPath = `${PACKAGED_ACCEPTANCE_MUTEX}.abandoned-${randomUUID()}`;
  try {
    await rename(PACKAGED_ACCEPTANCE_MUTEX, abandonedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  await rm(abandonedPath, { recursive: true, force: true });
  return true;
}

async function releasePackagedAcceptanceMutex(nonce: string): Promise<void> {
  const owner = await readFile(
    path.join(PACKAGED_ACCEPTANCE_MUTEX, 'owner.json'),
    'utf8',
  )
    .then((value) => JSON.parse(value) as { nonce?: unknown })
    .catch(() => null);
  if (owner?.nonce !== nonce) return;
  await rm(PACKAGED_ACCEPTANCE_MUTEX, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

async function assertPackagedExecutable(executablePath: string): Promise<void> {
  const executable = await stat(executablePath).catch(() => null);
  if (!executable?.isFile()) {
    throw new Error(`Packaged executable not found: ${executablePath}`);
  }
}

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseOptions(args: string[]): HarnessOptions {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  pnpm smoke:session-recovery -- --executable /path/to/packaged/clodex [options]

Options:
  --output PATH              Content-free evidence output
  --phase-timeout-ms N       Per-launch timeout (default: 180000)
  --mutex-timeout-ms N       Cross-session mutex wait (default: 180000)`);
    process.exit(0);
  }

  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') continue;
    if (!argument.startsWith('--')) {
      throw new Error(`Unknown positional argument: ${argument}`);
    }
    const separatorIndex = argument.indexOf('=');
    if (separatorIndex !== -1) {
      values.set(
        argument.slice(2, separatorIndex),
        argument.slice(separatorIndex + 1),
      );
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    values.set(argument.slice(2), value);
    index += 1;
  }

  const known = new Set([
    'executable',
    'output',
    'phase-timeout-ms',
    'mutex-timeout-ms',
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`Unknown option: --${key}`);
  }
  const executable = values.get('executable')?.trim();
  if (!executable) throw new Error('--executable is required');
  const phaseTimeoutMs = parsePositiveInteger(
    values.get('phase-timeout-ms'),
    DEFAULT_PHASE_TIMEOUT_MS,
    '--phase-timeout-ms',
  );
  const mutexTimeoutMs = parsePositiveInteger(
    values.get('mutex-timeout-ms'),
    DEFAULT_MUTEX_TIMEOUT_MS,
    '--mutex-timeout-ms',
  );
  return {
    executablePath: path.resolve(executable),
    outputPath: path.resolve(
      values.get('output') ??
        path.join(
          os.tmpdir(),
          `clodex-session-recovery-${process.platform}-${process.arch}-${process.pid}.json`,
        ),
    ),
    phaseTimeoutMs,
    mutexTimeoutMs,
  };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function createSanitizedAcceptanceEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = [
    'APPDATA',
    'COMSPEC',
    'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'LOGNAME',
    'PATH',
    'PATHEXT',
    'PROGRAMDATA',
    'SHELL',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USER',
    'USERPROFILE',
    'WAYLAND_DISPLAY',
    'WINDIR',
    'XDG_RUNTIME_DIR',
  ] as const;
  return Object.fromEntries(
    allowedKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function classifyHarnessFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('mutex')) return 'mutex-unavailable';
  if (message.includes('executable')) return 'packaged-build-unavailable';
  if (message.includes('timed out')) return 'phase-timeout';
  if (message.includes('phase failed')) return 'phase-failed';
  if (
    message.includes('option') ||
    message.includes('argument') ||
    message.includes('--executable')
  ) {
    return 'invalid-arguments';
  }
  return 'acceptance-failed';
}
