import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mcpPackagedAcceptanceReportSchema,
  MCP_PACKAGED_ACCEPTANCE_MARKER,
} from '../src/shared/mcp-packaged-acceptance';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const ACCEPTANCE_LOCK_PATH = '/private/tmp/clodex-packaged-acceptance.lock';
const ACCEPTANCE_LOCK_WAIT_MS = 120_000;
const ACCEPTANCE_LOCK_BACKOFF_MS = 250;
const PACKAGED_CHILD_ENV_ALLOWLIST = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
] as const;

interface CliOptions {
  appPath: string;
  outputPath?: string;
  timeoutMs: number;
}

void main().catch(() => {
  process.stderr.write(
    'MCP_PACKAGED_ACCEPTANCE_LAUNCHER status=failed reason=launcher-error\n',
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let lockAcquired = false;
  let temporaryRoot: string | null = null;

  try {
    await acquireAcceptanceLock();
    lockAcquired = true;
    const executable = await resolvePackagedExecutable(options.appPath);
    const fixturePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/mcp-acceptance-fixture.mjs',
    );
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-mcp-packaged-acceptance.'),
    );
    const result = await runPackagedApp({
      executable,
      fixturePath,
      profilePath: path.join(temporaryRoot, 'profile'),
      timeoutMs: options.timeoutMs,
    });
    if (result.timedOut) {
      throw new LauncherFailure('app-timeout');
    }
    const markerLine = findLastMarkerLine(result.stdout);
    if (!markerLine) throw new LauncherFailure('report-missing');
    const report = mcpPackagedAcceptanceReportSchema.parse(
      JSON.parse(markerLine.slice(MCP_PACKAGED_ACCEPTANCE_MARKER.length)),
    );
    if (result.exitCode !== (report.status === 'passed' ? 0 : 1)) {
      throw new LauncherFailure('exit-status-mismatch');
    }
    const encoded = `${JSON.stringify(report)}\n`;
    if (options.outputPath) {
      await writeOwnerOnly(path.resolve(options.outputPath), encoded);
    }
    process.stdout.write(`${MCP_PACKAGED_ACCEPTANCE_MARKER}${encoded}`);
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    const reason =
      error instanceof LauncherFailure ? error.reason : 'invalid-report';
    process.stderr.write(
      `MCP_PACKAGED_ACCEPTANCE_LAUNCHER status=failed reason=${reason}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (temporaryRoot) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
    if (lockAcquired) {
      await fs.rm(ACCEPTANCE_LOCK_PATH, { recursive: true, force: true });
    }
  }
}

async function acquireAcceptanceLock(): Promise<void> {
  const deadline = Date.now() + ACCEPTANCE_LOCK_WAIT_MS;
  while (true) {
    try {
      await fs.mkdir(ACCEPTANCE_LOCK_PATH);
      return;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (Date.now() >= deadline) throw new LauncherFailure('lock-timeout');
      await new Promise((resolve) =>
        setTimeout(resolve, ACCEPTANCE_LOCK_BACKOFF_MS),
      );
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function findLastMarkerLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith(MCP_PACKAGED_ACCEPTANCE_MARKER)) return line;
  }
  return undefined;
}

function parseArgs(args: string[]): CliOptions {
  let appPath = '';
  let outputPath: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (const argument of args) {
    if (argument === '--') {
      continue;
    }
    if (argument.startsWith('--app=')) {
      appPath = argument.slice('--app='.length);
    } else if (argument.startsWith('--output=')) {
      outputPath = argument.slice('--output='.length);
    } else if (argument.startsWith('--timeout-ms=')) {
      timeoutMs = Number(argument.slice('--timeout-ms='.length));
    } else {
      throw new LauncherFailure('invalid-arguments');
    }
  }
  if (!appPath || !Number.isInteger(timeoutMs) || timeoutMs < 5_000) {
    throw new LauncherFailure('invalid-arguments');
  }
  return { appPath: path.resolve(appPath), outputPath, timeoutMs };
}

async function resolvePackagedExecutable(appPath: string): Promise<string> {
  const stat = await fs.stat(appPath);
  if (stat.isFile()) return appPath;
  if (!stat.isDirectory() || !appPath.endsWith('.app')) {
    throw new LauncherFailure('app-not-found');
  }
  const macosDirectory = path.join(appPath, 'Contents', 'MacOS');
  const candidates = await fs.readdir(macosDirectory, { withFileTypes: true });
  const executable = candidates.find((entry) => entry.isFile());
  if (!executable) throw new LauncherFailure('app-not-found');
  return path.join(macosDirectory, executable.name);
}

async function runPackagedApp(input: {
  executable: string;
  fixturePath: string;
  profilePath: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; timedOut: boolean }> {
  await fs.mkdir(input.profilePath, { recursive: true });
  return await new Promise((resolve, reject) => {
    const child = spawn(
      input.executable,
      [
        `--user-data-dir=${input.profilePath}`,
        '--disable-gpu',
        '--mcp-packaged-acceptance-local',
        `--mcp-acceptance-node=${process.execPath}`,
        `--mcp-acceptance-fixture=${input.fixturePath}`,
      ],
      {
        env: createSanitizedChildEnvironment(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let timedOut = false;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout = capCapture(stdout + chunk);
    });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      resolve({ exitCode, stdout, timedOut });
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 2_000);
      forceKillTimeout.unref();
    }, input.timeoutMs);
    timeout.unref();
  });
}

function createSanitizedChildEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PACKAGED_CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function capCapture(value: string): string {
  if (Buffer.byteLength(value, 'utf-8') <= MAX_CAPTURE_BYTES) return value;
  return value.slice(-MAX_CAPTURE_BYTES);
}

async function writeOwnerOnly(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}

class LauncherFailure extends Error {
  public constructor(public readonly reason: string) {
    super(reason);
  }
}
