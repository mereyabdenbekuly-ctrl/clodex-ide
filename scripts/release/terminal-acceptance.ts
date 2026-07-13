#!/usr/bin/env tsx

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import {
  createInitialTerminalAcceptanceManifest,
  serializeTerminalAcceptanceManifest,
  type TerminalAcceptanceManifest,
} from './terminal-acceptance-evidence.js';

export const PACKAGED_ACCEPTANCE_LOCK_PATH =
  '/private/tmp/clodex-packaged-acceptance.lock';
export const TERMINAL_COMMAND = "printf 'CLODEX_TERMINAL_OK\\n'";

const OUTPUT_MARKER = 'CLODEX_TERMINAL_OK';
const READY_TITLE = 'CLODEX_TERMINAL_ACCEPTANCE_READY';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 100;
const MAX_LOG_TAIL_LENGTH = 1024 * 1024;

export interface TerminalAcceptanceCliOptions {
  lockTimeoutMs: number;
  outputPath?: string;
  packagedAppPath: string;
  timeoutMs: number;
}

interface RunOptions extends TerminalAcceptanceCliOptions {
  lockPath?: string;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface DevToolsTarget {
  type?: unknown;
  webSocketDebuggerUrl?: unknown;
}

export interface DevToolsEndpoint {
  browserWebSocketUrl: string;
  httpEndpoint: string;
}

interface CdpResponse {
  error?: { code: number; message: string };
  id?: number;
  result?: unknown;
}

interface Point {
  x: number;
  y: number;
}

class TerminalAcceptanceError extends Error {
  public constructor(public readonly reasonCode: string) {
    super(reasonCode);
  }
}

function usage(): string {
  return `
Run packaged Terminal acceptance against an isolated Clodex profile.

Usage:
  node --import tsx scripts/release/terminal-acceptance.ts \\
    --packaged-app=<path-to-clodex.app> [--output=<path>] [options]

Options:
  --packaged-app=<path>    packaged macOS application to exercise
  --output=<path>          write a content-free JSON evidence manifest
  --timeout-ms=<number>    per-stage timeout (default: ${DEFAULT_TIMEOUT_MS})
  --lock-timeout-ms=<n>    packaged-app mutex wait (default: ${DEFAULT_LOCK_TIMEOUT_MS})
  --help                   show this help

The evidence manifest never contains commands, terminal output, environment
values, profile paths, packaged-app paths, or raw application logs.
`.trim();
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TerminalAcceptanceError(`${option}-invalid`);
  }
  return parsed;
}

export function parseTerminalAcceptanceArguments(
  values: readonly string[],
): TerminalAcceptanceCliOptions {
  let packagedAppPath: string | undefined;
  let outputPath: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;

  for (const value of values) {
    if (value === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (value.startsWith('--packaged-app=')) {
      packagedAppPath = value.slice('--packaged-app='.length);
      continue;
    }
    if (value.startsWith('--output=')) {
      outputPath = value.slice('--output='.length);
      continue;
    }
    if (value.startsWith('--timeout-ms=')) {
      timeoutMs = parsePositiveInteger(
        value.slice('--timeout-ms='.length),
        'timeout-ms',
      );
      continue;
    }
    if (value.startsWith('--lock-timeout-ms=')) {
      lockTimeoutMs = parsePositiveInteger(
        value.slice('--lock-timeout-ms='.length),
        'lock-timeout-ms',
      );
      continue;
    }
    throw new TerminalAcceptanceError('argument-unknown');
  }

  if (!packagedAppPath) {
    throw new TerminalAcceptanceError('packaged-app-required');
  }

  return {
    lockTimeoutMs,
    ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
    packagedAppPath: path.resolve(packagedAppPath),
    timeoutMs,
  };
}

function durationSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForCondition<T>(
  probe: () =>
    | T
    | null
    | undefined
    | false
    | Promise<T | null | undefined | false>,
  options: { reasonCode: string; timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = performance.now() + options.timeoutMs;
  let lastError: unknown;

  while (performance.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error instanceof TerminalAcceptanceError) throw error;
      lastError = error;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(
      Math.min(options.intervalMs ?? POLL_INTERVAL_MS, Math.ceil(remaining)),
    );
  }

  throw new TerminalAcceptanceError(
    lastError instanceof TerminalAcceptanceError
      ? lastError.reasonCode
      : options.reasonCode,
  );
}

export async function acquirePackagedAcceptanceLock(options: {
  lockPath?: string;
  timeoutMs: number;
}): Promise<() => void> {
  const lockPath = options.lockPath ?? PACKAGED_ACCEPTANCE_LOCK_PATH;
  const token = randomUUID();
  const ownerPath = path.join(lockPath, 'owner.json');
  const deadline = performance.now() + options.timeoutMs;
  let backoffMs = 100;

  while (performance.now() < deadline) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(
          ownerPath,
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          'utf8',
        );
      } catch {
        rmSync(lockPath, { force: true, recursive: true });
        throw new TerminalAcceptanceError('packaged-acceptance-lock-failed');
      }

      let released = false;
      return () => {
        if (released) return;
        try {
          const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
            token?: unknown;
          };
          if (owner.token !== token) return;
          rmSync(lockPath, { recursive: true });
          released = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            released = true;
            return;
          }
          throw new TerminalAcceptanceError(
            'packaged-acceptance-lock-release-failed',
          );
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new TerminalAcceptanceError('packaged-acceptance-lock-failed');
      }
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(backoffMs, Math.ceil(remaining)));
    backoffMs = Math.min(backoffMs * 2, 1000);
  }

  throw new TerminalAcceptanceError('packaged-acceptance-lock-timeout');
}

export function seedIsolatedProfile(rootDirectory: string): {
  homePath: string;
  profilePath: string;
} {
  const homePath = path.join(rootDirectory, 'home');
  const profilePath = path.join(rootDirectory, 'profile');
  const dataRoot = path.join(profilePath, 'clodex');
  mkdirSync(homePath, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    path.join(dataRoot, 'onboarding-state.json'),
    `${JSON.stringify({ hasSeenOnboardingFlow: true })}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(dataRoot, 'tutorial-state.json'),
    `${JSON.stringify({ 'general-ui-experience': 4 })}\n`,
    'utf8',
  );
  return { homePath, profilePath };
}

function childEnvironment(homePath: string): NodeJS.ProcessEnv {
  const allowedNames = ['LANG', 'LC_ALL', 'LOGNAME', 'TMPDIR', 'USER'] as const;
  const environment: NodeJS.ProcessEnv = {
    HISTFILE: '/dev/null',
    HOME: os.homedir(),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    ZDOTDIR: homePath,
  };
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

export function parseDevToolsVersion(
  value: unknown,
  httpEndpoint: string,
): DevToolsEndpoint | null {
  if (!value || typeof value !== 'object') return null;
  const browserWebSocketUrl = (value as { webSocketDebuggerUrl?: unknown })
    .webSocketDebuggerUrl;
  if (
    typeof browserWebSocketUrl !== 'string' ||
    !browserWebSocketUrl.startsWith('ws://')
  )
    return null;
  return {
    browserWebSocketUrl,
    httpEndpoint,
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new TerminalAcceptanceError('cdp-port-reservation-failed'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function readDevToolsEndpoint(
  httpEndpoint: string,
): Promise<DevToolsEndpoint | null> {
  const response = await fetch(`${httpEndpoint}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) return null;
  return parseDevToolsVersion(await response.json(), httpEndpoint);
}

function resolvePackagedExecutable(appPath: string): string {
  if (process.platform !== 'darwin') {
    throw new TerminalAcceptanceError('macos-required');
  }
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) {
    throw new TerminalAcceptanceError('packaged-info-plist-missing');
  }
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleExecutable', plistPath],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const executableName = result.stdout.trim();
  if (result.status !== 0 || !executableName) {
    throw new TerminalAcceptanceError('packaged-executable-name-missing');
  }
  const executablePath = path.join(
    appPath,
    'Contents',
    'MacOS',
    executableName,
  );
  if (!existsSync(executablePath)) {
    throw new TerminalAcceptanceError('packaged-executable-missing');
  }
  return executablePath;
}

export class AppLogObserver {
  private tail = '';
  private readonly createdTerminalIds = new Set<string>();
  private readonly ptyExitCodes = new Map<string, number>();
  private fatalStartupOutput = false;
  private shutdownComplete = false;

  public append(chunk: Uint8Array | string): void {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    this.tail = `${this.tail}${text}`.slice(-MAX_LOG_TAIL_LENGTH);

    for (const match of this.tail.matchAll(
      /\[TerminalService\] Created terminal (term-\d+)\b/gu,
    )) {
      if (match[1]) this.createdTerminalIds.add(match[1]);
    }
    for (const match of this.tail.matchAll(
      /\[TerminalService\] PTY (term-\d+) exited with code (-?\d+)\b/gu,
    )) {
      if (match[1] && match[2]) {
        this.ptyExitCodes.set(match[1], Number(match[2]));
      }
    }

    this.shutdownComplete ||= this.tail.includes('[Main] Services shut down');
    const lower = this.tail.toLowerCase();
    this.fatalStartupOutput ||= [
      '[clodex] startup failed',
      'uncaught exception',
      'unhandled rejection',
      'err_module_not_found',
      'module_not_found',
      'fatal error',
    ].some((pattern) => lower.includes(pattern));
  }

  public createdIds(): ReadonlySet<string> {
    return new Set(this.createdTerminalIds);
  }

  public firstCreatedIdNotIn(previous: ReadonlySet<string>): string | null {
    for (const terminalId of this.createdTerminalIds) {
      if (!previous.has(terminalId)) return terminalId;
    }
    return null;
  }

  public exitCode(terminalId: string): number | null {
    return this.ptyExitCodes.get(terminalId) ?? null;
  }

  public hasFatalStartupOutput(): boolean {
    return this.fatalStartupOutput;
  }

  public hasShutdownComplete(): boolean {
    return this.shutdownComplete;
  }
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cdp-connection-closed'));
      }
      this.pending.clear();
    });
  }

  public static async connect(
    webSocketUrl: string,
    timeoutMs: number,
  ): Promise<CdpConnection> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new TerminalAcceptanceError('cdp-connect-timeout'));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new TerminalAcceptanceError('cdp-connect-failed'));
        },
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  public send<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TerminalAcceptanceError('cdp-command-timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  public close(): void {
    this.socket.close();
  }
}

export function inspectablePageWebSocketUrls(
  targets: readonly DevToolsTarget[],
): string[] {
  return targets
    .filter(
      (target) =>
        (target.type === 'page' ||
          target.type === 'other' ||
          target.type === 'webview') &&
        typeof target.webSocketDebuggerUrl === 'string',
    )
    .map((target) => target.webSocketDebuggerUrl as string);
}

async function runtimeEvaluate<T>(
  connection: CdpConnection,
  expression: string,
): Promise<T> {
  const response = await connection.send<{
    exceptionDetails?: unknown;
    result?: { value?: unknown };
  }>('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails || !response.result) {
    throw new TerminalAcceptanceError('renderer-evaluation-failed');
  }
  return response.result.value as T;
}

async function listDevToolsTargets(
  endpoint: string,
): Promise<DevToolsTarget[]> {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new TerminalAcceptanceError('cdp-target-list-failed');
  }
  const value = (await response.json()) as unknown;
  if (!Array.isArray(value)) {
    throw new TerminalAcceptanceError('cdp-target-list-invalid');
  }
  return value as DevToolsTarget[];
}

async function findMainRenderer(
  endpoint: string,
  timeoutMs: number,
): Promise<CdpConnection> {
  const connections = new Map<string, CdpConnection>();
  try {
    return await waitForCondition(
      async () => {
        const targets = await listDevToolsTargets(endpoint);
        for (const webSocketUrl of inspectablePageWebSocketUrls(targets)) {
          let connection = connections.get(webSocketUrl);
          if (!connection) {
            try {
              connection = await CdpConnection.connect(
                webSocketUrl,
                Math.min(timeoutMs, 5000),
              );
              connections.set(webSocketUrl, connection);
            } catch {
              continue;
            }
          }

          try {
            const isMainRenderer = await runtimeEvaluate<boolean>(
              connection,
              `Boolean(document.querySelector('[aria-label="Open new terminal tab"]'))`,
            );
            if (isMainRenderer) {
              for (const [url, otherConnection] of connections) {
                if (url !== webSocketUrl) otherConnection.close();
              }
              return connection;
            }
          } catch {
            connection.close();
            connections.delete(webSocketUrl);
          }
        }
        return null;
      },
      { reasonCode: 'main-renderer-not-found', timeoutMs },
    );
  } catch (error) {
    for (const connection of connections.values()) connection.close();
    throw error;
  }
}

async function dispatchEnter(connection: CdpConnection): Promise<void> {
  const common = {
    code: 'Enter',
    key: 'Enter',
    nativeVirtualKeyCode: 36,
    windowsVirtualKeyCode: 13,
  };
  await connection.send('Input.dispatchKeyEvent', {
    ...common,
    type: 'rawKeyDown',
  });
  await connection.send('Input.dispatchKeyEvent', {
    ...common,
    type: 'keyUp',
  });
}

async function visibleElementCenter(
  connection: CdpConnection,
  selector: string,
): Promise<Point | null> {
  return runtimeEvaluate<Point | null>(
    connection,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.pointerEvents === 'none'
      ) return null;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top !== element && !element.contains(top)) return null;
      return { x, y };
    })()`,
  );
}

async function dispatchTrustedClick(
  connection: CdpConnection,
  point: Point,
): Promise<void> {
  await connection.send('Input.dispatchMouseEvent', {
    button: 'none',
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await connection.send('Input.dispatchMouseEvent', {
    button: 'left',
    clickCount: 1,
    type: 'mousePressed',
    x: point.x,
    y: point.y,
  });
  await connection.send('Input.dispatchMouseEvent', {
    button: 'left',
    clickCount: 1,
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
  });
}

async function enterTerminalLine(
  connection: CdpConnection,
  line: string,
): Promise<void> {
  const focused = await runtimeEvaluate<boolean>(
    connection,
    `(() => {
      const input = document.querySelector('.xterm-helper-textarea');
      if (!(input instanceof HTMLTextAreaElement)) return false;
      input.focus();
      return document.activeElement === input;
    })()`,
  );
  if (!focused)
    throw new TerminalAcceptanceError('terminal-input-focus-failed');
  await connection.send('Input.insertText', { text: line });
  await dispatchEnter(connection);
}

export function normalizeTerminalRow(value: string): string {
  return value.replaceAll('\u00a0', ' ').trimEnd();
}

export function hasExactTerminalRow(
  rows: readonly string[],
  marker = OUTPUT_MARKER,
): boolean {
  return rows.some((row) => normalizeTerminalRow(row) === marker);
}

async function rendererHasExactOutputRow(
  connection: CdpConnection,
): Promise<boolean> {
  return runtimeEvaluate<boolean>(
    connection,
    `Array.from(document.querySelectorAll('.xterm-rows > div')).some(
      (row) => (row.textContent ?? '').replaceAll('\\u00a0', ' ').trimEnd() === ${JSON.stringify(
        OUTPUT_MARKER,
      )}
    )`,
  );
}

function createProcessExitPromise(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForProcessExit(
  exitPromise: Promise<ProcessExit>,
  timeoutMs: number,
): Promise<ProcessExit> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TerminalAcceptanceError('app-exit-timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateOwnedProcess(
  child: ChildProcess,
  exitPromise: Promise<ProcessExit>,
): Promise<ProcessExit | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return exitPromise.catch(() => null);
  }
  child.kill('SIGTERM');
  try {
    return await waitForProcessExit(exitPromise, 10_000);
  } catch {
    child.kill('SIGKILL');
    return waitForProcessExit(exitPromise, 5000).catch(() => null);
  }
}

function setFailure(
  manifest: TerminalAcceptanceManifest,
  reasonCode: string,
): void {
  manifest.status = 'failed';
  manifest.reasonCode = reasonCode;
  for (const check of Object.values(manifest.checks)) {
    if (check.status === 'pending') check.status = 'fail';
  }
}

export function writeTerminalAcceptanceManifest(
  manifest: TerminalAcceptanceManifest,
  outputPath: string | undefined,
): void {
  const serialized = serializeTerminalAcceptanceManifest(manifest);
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serialized, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    renameSync(temporaryPath, outputPath);
  } catch {
    rmSync(temporaryPath, { force: true });
    throw new TerminalAcceptanceError('evidence-write-failed');
  }
}

export async function runTerminalAcceptance(
  options: RunOptions,
): Promise<TerminalAcceptanceManifest> {
  const manifest = createInitialTerminalAcceptanceManifest();
  let releaseLock: (() => void) | undefined;
  let temporaryDirectory: string | undefined;
  let child: ChildProcess | undefined;
  let exitPromise: Promise<ProcessExit> | undefined;
  let connection: CdpConnection | undefined;
  let failure: string | undefined;
  let cleanupPromise: Promise<string | undefined> | undefined;

  const cleanupOwnedResources = (): Promise<string | undefined> => {
    cleanupPromise ??= (async () => {
      let cleanupFailure: string | undefined;
      try {
        connection?.close();
        if (child && exitPromise) {
          await terminateOwnedProcess(child, exitPromise);
        }
        if (temporaryDirectory) {
          rmSync(temporaryDirectory, { force: true, recursive: true });
        }
      } catch {
        cleanupFailure = 'terminal-acceptance-cleanup-failed';
      } finally {
        try {
          releaseLock?.();
        } catch (error) {
          cleanupFailure =
            error instanceof TerminalAcceptanceError
              ? error.reasonCode
              : 'packaged-acceptance-lock-release-failed';
        }
      }
      return cleanupFailure;
    })();
    return cleanupPromise;
  };

  let signalCleanupStarted = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    void cleanupOwnedResources().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  try {
    releaseLock = await acquirePackagedAcceptanceLock({
      lockPath: options.lockPath,
      timeoutMs: options.lockTimeoutMs,
    });

    const executablePath = resolvePackagedExecutable(options.packagedAppPath);
    temporaryDirectory = mkdtempSync(
      path.join(os.tmpdir(), 'clodex-terminal-acceptance.'),
    );
    const { homePath, profilePath } = seedIsolatedProfile(temporaryDirectory);
    manifest.checks.packagedLaunch.isolatedProfile = true;

    const logObserver = new AppLogObserver();
    const launchStartedAt = performance.now();
    const debuggingPort = await reserveLoopbackPort();
    const httpEndpoint = `http://127.0.0.1:${debuggingPort}`;
    child = spawn(
      executablePath,
      [
        `--user-data-dir=${profilePath}`,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${debuggingPort}`,
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
      {
        cwd: homePath,
        env: childEnvironment(homePath),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    exitPromise = createProcessExitPromise(child);
    let spawnFailed = false;
    child.once('error', () => {
      spawnFailed = true;
    });
    void exitPromise.catch(() => undefined);
    child.stdout?.on('data', (chunk) => logObserver.append(chunk));
    child.stderr?.on('data', (chunk) => logObserver.append(chunk));

    const endpoint = await waitForCondition(
      () => {
        if (spawnFailed) {
          throw new TerminalAcceptanceError('packaged-app-spawn-failed');
        }
        if (child?.exitCode !== null || child?.signalCode !== null) {
          throw new TerminalAcceptanceError(
            'packaged-app-exited-during-launch',
          );
        }
        if (logObserver.hasFatalStartupOutput()) {
          throw new TerminalAcceptanceError('fatal-startup-output');
        }
        return readDevToolsEndpoint(httpEndpoint);
      },
      { reasonCode: 'devtools-endpoint-timeout', timeoutMs: options.timeoutMs },
    );

    connection = await findMainRenderer(
      endpoint.httpEndpoint,
      options.timeoutMs,
    );
    manifest.checks.packagedLaunch = {
      cdpConnected: true,
      durationMs: durationSince(launchStartedAt),
      isolatedProfile: true,
      status: 'pass',
    };

    const terminalStartedAt = performance.now();
    const existingTerminalIds = logObserver.createdIds();
    const terminalButtonCenter = await waitForCondition(
      () =>
        visibleElementCenter(
          connection!,
          '[aria-label="Open new terminal tab"]',
        ),
      {
        reasonCode: 'terminal-button-not-interactable',
        timeoutMs: options.timeoutMs,
      },
    );
    await dispatchTrustedClick(connection, terminalButtonCenter);

    const terminalId = await waitForCondition(
      () => logObserver.firstCreatedIdNotIn(existingTerminalIds),
      { reasonCode: 'terminal-create-timeout', timeoutMs: options.timeoutMs },
    );
    const terminalCenter = await waitForCondition(
      async () => {
        const rowsReady = await runtimeEvaluate<boolean>(
          connection!,
          `Boolean(document.querySelector('.xterm-rows'))`,
        );
        return rowsReady
          ? visibleElementCenter(connection!, '.xterm-screen')
          : null;
      },
      { reasonCode: 'terminal-renderer-timeout', timeoutMs: options.timeoutMs },
    );
    await dispatchTrustedClick(connection, terminalCenter);
    const inputFocused = await waitForCondition(
      () =>
        runtimeEvaluate<boolean>(
          connection!,
          `document.activeElement?.classList.contains('xterm-helper-textarea') ?? false`,
        ),
      {
        reasonCode: 'terminal-input-focus-timeout',
        timeoutMs: options.timeoutMs,
      },
    );
    manifest.checks.terminalUi = {
      durationMs: durationSince(terminalStartedAt),
      inputFocused,
      openedViaUi: true,
      status: 'pass',
    };

    const commandStartedAt = performance.now();
    await enterTerminalLine(
      connection,
      `stty -echo; printf '\\033]0;${READY_TITLE}\\007'`,
    );
    await waitForCondition(
      () =>
        runtimeEvaluate<boolean>(
          connection!,
          `Array.from(document.querySelectorAll('[role="tab"]')).some(
            (tab) => (tab.textContent ?? '').trim() === ${JSON.stringify(
              READY_TITLE,
            )}
          )`,
        ),
      {
        reasonCode: 'terminal-echo-disable-timeout',
        timeoutMs: options.timeoutMs,
      },
    );

    await enterTerminalLine(connection, TERMINAL_COMMAND);
    manifest.checks.command.enteredViaUi = true;
    await waitForCondition(() => rendererHasExactOutputRow(connection!), {
      reasonCode: 'terminal-output-timeout',
      timeoutMs: options.timeoutMs,
    });
    manifest.checks.command = {
      durationMs: durationSince(commandStartedAt),
      enteredViaUi: true,
      outputObserved: true,
      status: 'pass',
    };

    const exitStartedAt = performance.now();
    await enterTerminalLine(connection, 'stty echo; exit 0');
    const exitCode = await waitForCondition(
      () => {
        const code = logObserver.exitCode(terminalId);
        return code === null ? null : { code };
      },
      { reasonCode: 'terminal-exit-timeout', timeoutMs: options.timeoutMs },
    );
    const terminalRemoved = await waitForCondition(
      async () => {
        try {
          return await runtimeEvaluate<boolean>(
            connection!,
            `!document.querySelector('.xterm-helper-textarea') &&
              !Array.from(document.querySelectorAll('[role="tab"]')).some(
                (tab) => (tab.textContent ?? '').trim() === ${JSON.stringify(
                  READY_TITLE,
                )}
              )`,
          );
        } catch {
          return false;
        }
      },
      { reasonCode: 'terminal-removal-timeout', timeoutMs: options.timeoutMs },
    );
    manifest.checks.ptyExit = {
      durationMs: durationSince(exitStartedAt),
      exitCode: exitCode.code,
      status: exitCode.code === 0 && terminalRemoved ? 'pass' : 'fail',
      terminalRemoved,
    };
    if (manifest.checks.ptyExit.status !== 'pass') {
      throw new TerminalAcceptanceError('terminal-exit-nonzero');
    }

    const shutdownStartedAt = performance.now();
    const browserConnection = await CdpConnection.connect(
      endpoint.browserWebSocketUrl,
      Math.min(options.timeoutMs, 5000),
    );
    void browserConnection.send('Browser.close').catch(() => undefined);
    const exit = await waitForProcessExit(exitPromise, options.timeoutMs);
    const servicesShutDown = logObserver.hasShutdownComplete();
    manifest.checks.appShutdown = {
      durationMs: durationSince(shutdownStartedAt),
      exitCode: exit.code,
      servicesShutDown,
      status: exit.code === 0 && servicesShutDown ? 'pass' : 'fail',
    };
    if (manifest.checks.appShutdown.status !== 'pass') {
      throw new TerminalAcceptanceError('app-shutdown-incomplete');
    }

    if (logObserver.hasFatalStartupOutput()) {
      throw new TerminalAcceptanceError('fatal-runtime-output');
    }

    manifest.status = 'passed';
  } catch (error) {
    failure =
      error instanceof TerminalAcceptanceError
        ? error.reasonCode
        : 'terminal-acceptance-unexpected';
  } finally {
    const cleanupFailure = await cleanupOwnedResources();
    failure ??= cleanupFailure;
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
  }

  if (failure) setFailure(manifest, failure);
  return manifest;
}

async function main(): Promise<void> {
  let options: TerminalAcceptanceCliOptions;
  try {
    options = parseTerminalAcceptanceArguments(process.argv.slice(2));
  } catch (error) {
    const reasonCode =
      error instanceof TerminalAcceptanceError
        ? error.reasonCode
        : 'argument-invalid';
    console.error(`[terminal-acceptance] ${reasonCode}`);
    process.exitCode = 1;
    return;
  }

  const manifest = await runTerminalAcceptance(options);
  try {
    writeTerminalAcceptanceManifest(manifest, options.outputPath);
  } catch (error) {
    console.error(
      `[terminal-acceptance] ${
        error instanceof TerminalAcceptanceError
          ? error.reasonCode
          : 'evidence-write-failed'
      }`,
    );
    process.exitCode = 1;
    return;
  }

  if (manifest.status !== 'passed') {
    console.error(`[terminal-acceptance] ${manifest.reasonCode ?? 'failed'}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath && /terminal-acceptance\.(?:[cm]?js|ts)$/u.test(entryPath)) {
  void main();
}
