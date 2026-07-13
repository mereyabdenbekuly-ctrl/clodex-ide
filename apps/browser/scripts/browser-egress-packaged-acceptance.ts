import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  chromium,
  type Browser,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import { readNetworkPolicyAuditLedger } from '../src/backend/services/network-policy/audit-ledger';
import {
  serializeBrowserEgressPackagedAcceptanceManifest,
  type BrowserEgressPackagedAcceptanceManifest,
} from '../src/shared/browser-egress-packaged-acceptance';

const ACCEPTANCE_LOCK_PATH = '/private/tmp/clodex-packaged-acceptance.lock';
const DEFAULT_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_MS = 10 * 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const STARTUP_ATTEMPT_TIMEOUT_MS = 75_000;
const FIXTURE_MARKER = '[data-clodex-browser-egress-acceptance="allowed"]';
const FIXTURE_HOST = '127.0.0.1';

type EligibleReleaseChannel = 'prerelease' | 'nightly';
type BrowserSignal =
  | 'proxy-denial-response'
  | 'load-error-page'
  | 'navigation-failed';

interface Arguments {
  appPath: string;
  outputPath: string;
  timeoutMs: number;
}

interface PackagedAppMetadata {
  executablePath: string;
  releaseChannel: EligibleReleaseChannel;
  version: string;
}

interface FixtureCounters {
  connections: number;
  requests: number;
  bodyBytes: number;
}

interface FixtureServer {
  counters: FixtureCounters;
  port: number;
  close(): Promise<void>;
}

interface ScenarioResult {
  browserSignal: BrowserSignal;
  localFixtureRequests: number;
  allowedAuditDecisions: number;
  deniedAuditDecisions: number;
  sinkConnections: 0;
  sinkRequests: 0;
  sinkBodyBytes: 0;
  unexpectedAllows: 0;
  policyHash: string;
  terminalEventHash: string;
}

class AcceptanceError extends Error {
  public constructor(public readonly reasonCode: string) {
    super(reasonCode);
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const metadata = await readPackagedAppMetadata(args.appPath);
  const releaseLock = await acquirePackagedAcceptanceLock();
  let temporaryRoot: string | undefined;
  let result: ScenarioResult | undefined;
  let cleanupSucceeded = false;
  try {
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-browser-egress-acceptance.'),
    );
    await fs.chmod(temporaryRoot, 0o700);
    result = await runScenario(metadata, temporaryRoot, args.timeoutMs);
  } finally {
    const rootToRemove = temporaryRoot;
    const profileRemoved = rootToRemove
      ? await runBoundedCleanup(() =>
          fs.rm(rootToRemove, { recursive: true, force: true }),
        )
      : true;
    const lockReleased = await runBoundedCleanup(releaseLock);
    cleanupSucceeded = profileRemoved && lockReleased;
  }

  if (!result || !cleanupSucceeded) {
    throw new AcceptanceError('content-free-cleanup-failed');
  }

  const manifest: BrowserEgressPackagedAcceptanceManifest = {
    schemaVersion: 1,
    kind: 'browser-egress-packaged-acceptance',
    createdAt: new Date().toISOString(),
    result: 'passed',
    app: {
      platform: 'darwin',
      architecture: process.arch === 'x64' ? 'x64' : 'arm64',
      releaseChannel: metadata.releaseChannel,
      version: metadata.version,
    },
    enforcement: {
      outcome: 'fail-closed',
      browserSignal: result.browserSignal,
      promptObserved: false,
      allowReasonCode: 'exact-destination-grant',
      denyReasonCode: 'loopback-denied',
    },
    checks: {
      packagedAppLaunched: true,
      realUiBrowserTabOpened: true,
      localNavigationSucceeded: true,
      auditChainVerified: true,
      blockedAttemptFailClosed: true,
      zeroSinkConnections: true,
      zeroSinkRequests: true,
      zeroSinkBodyBytes: true,
    },
    counts: {
      localFixtureRequests: result.localFixtureRequests,
      allowedAuditDecisions: result.allowedAuditDecisions,
      deniedAuditDecisions: result.deniedAuditDecisions,
      sinkConnections: result.sinkConnections,
      sinkRequests: result.sinkRequests,
      sinkBodyBytes: result.sinkBodyBytes,
      unexpectedAllows: result.unexpectedAllows,
    },
    audit: {
      verified: true,
      policyHash: result.policyHash,
      terminalEventHash: result.terminalEventHash,
    },
    retention: {
      rawLogs: false,
      rawAudit: false,
      networkAddresses: false,
      responseBodies: false,
      screenshots: false,
      profileData: false,
      inheritedSecrets: false,
    },
  };

  await writeManifestAtomically(
    args.outputPath,
    serializeBrowserEgressPackagedAcceptanceManifest(manifest),
  );
  process.stdout.write('[browser-egress-packaged] passed\n');
}

async function runScenario(
  metadata: PackagedAppMetadata,
  temporaryRoot: string,
  timeoutMs: number,
): Promise<ScenarioResult> {
  const deadline = Date.now() + timeoutMs;
  const localFixture = await createFixtureServer();
  const profilePath = path.join(temporaryRoot, 'profile');
  const auditPath = path.join(
    profilePath,
    'clodex',
    'user-data',
    'agent-os',
    'audit',
    'network-policy.jsonl',
  );
  let blockedSink: FixtureServer | undefined;
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let result: ScenarioResult | undefined;
  let cleanupSucceeded = false;
  let stage = 'setup';
  try {
    await writeIsolatedProfile(profilePath, localFixture.port);
    for (let attempt = 1; attempt <= 2 && !browser; attempt += 1) {
      const cdpPort = await reserveLoopbackPort();
      const candidate = spawn(
        metadata.executablePath,
        [
          `--user-data-dir=${profilePath}`,
          '--remote-debugging-address=127.0.0.1',
          `--remote-debugging-port=${cdpPort}`,
          '--remote-allow-origins=*',
          '--disable-gpu',
          '--no-first-run',
        ],
        {
          detached: true,
          env: createSecretFreeChildEnvironment(),
          stdio: 'ignore',
        },
      );
      appProcess = candidate;
      const attemptDeadline = Math.min(
        deadline,
        Date.now() + STARTUP_ATTEMPT_TIMEOUT_MS,
      );
      try {
        stage = `cdp-ready-attempt-${attempt}`;
        await waitForCdp(cdpPort, candidate, attemptDeadline);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
          timeout: remaining(attemptDeadline),
        });
      } catch (error) {
        await stopOwnedProcess(candidate);
        appProcess = undefined;
        if (attempt === 2) throw error;
      }
    }
    if (!browser || !appProcess) {
      throw new AcceptanceError('packaged-app-cdp-not-ready');
    }
    stage = 'main-ui-ready';
    const mainPage = await waitForMainUiPage(browser, deadline);

    stage = 'open-browser-tab';
    await mainPage
      .getByRole('button', { name: 'Open new browser tab' })
      .click({ force: true, timeout: remaining(deadline) });
    const omnibox = mainPage.getByPlaceholder('Search or type a URL');
    await omnibox.waitFor({ state: 'visible', timeout: remaining(deadline) });

    stage = 'allowed-navigation';
    await navigateFromRealUi(
      omnibox,
      `http://${FIXTURE_HOST}:${localFixture.port}/`,
      deadline,
    );
    stage = 'allowed-fixture';
    const contentPage = await waitForFixturePage(browser, deadline);
    await waitForCondition(
      () => localFixture.counters.requests > 0,
      deadline,
      'local-navigation-not-observed',
    );

    // Omnibox suggestions discover already-listening localhost ports. Fill the
    // denied URL while its reserved port is still closed, let that scan settle,
    // then bind the sink immediately before the real Enter submission. This
    // keeps product-owned health probes out of the zero-connection proof.
    stage = 'blocked-navigation-prepare';
    const blockedPort = await reserveLoopbackPort();
    await fillFromRealUi(
      omnibox,
      `https://${FIXTURE_HOST}:${blockedPort}/`,
      deadline,
    );
    await delay(1_000);
    const deniedSink = await createBlockedSinkServer(blockedPort);
    blockedSink = deniedSink;
    let proxyDenialObserved = false;
    let navigationFailureObserved = false;
    const onResponse = (response: Response) => {
      if (
        response.status() === 403 &&
        response.request().isNavigationRequest() &&
        response.request().frame() === contentPage.mainFrame()
      ) {
        proxyDenialObserved = true;
      }
    };
    const onRequestFailed = (request: Request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === contentPage.mainFrame()
      ) {
        navigationFailureObserved = true;
      }
    };
    contentPage.on('response', onResponse);
    contentPage.on('requestfailed', onRequestFailed);
    stage = 'blocked-navigation-submit';
    await omnibox.press('Enter', { timeout: remaining(deadline) });

    stage = 'sanitized-audit';
    const records = await waitForAuditDecisions(
      auditPath,
      localFixture.port,
      deniedSink.port,
      deniedSink.counters,
      deadline,
    );
    stage = 'browser-fail-closed-signal';
    const browserSignal = await waitForBrowserSignal(
      contentPage,
      () => proxyDenialObserved,
      () => navigationFailureObserved,
      deadline,
    );
    contentPage.off('response', onResponse);
    contentPage.off('requestfailed', onRequestFailed);

    stage = 'zero-sink-proof';
    await delay(500);
    if (deniedSink.counters.bodyBytes !== 0) {
      throw new AcceptanceError('blocked-sink-received-body-bytes');
    }
    if (deniedSink.counters.requests !== 0) {
      throw new AcceptanceError('blocked-sink-received-http-request');
    }
    if (deniedSink.counters.connections !== 0) {
      throw new AcceptanceError('blocked-sink-received-tcp-connection');
    }

    const allowed = records.filter(
      (record) =>
        record.principalKind === 'browser' &&
        record.destinationPort === localFixture.port &&
        record.decision === 'allow' &&
        record.reason === 'exact-destination-grant',
    );
    const denied = records.filter(
      (record) =>
        record.principalKind === 'browser' &&
        record.destinationPort === deniedSink.port &&
        record.decision === 'deny' &&
        record.reason === 'loopback-denied',
    );
    const unexpectedAllows = records.filter(
      (record) =>
        record.principalKind === 'browser' &&
        record.destinationPort === deniedSink.port &&
        record.decision === 'allow',
    );
    const policyHash = denied.at(-1)?.policyHash;
    const terminalEventHash = records
      .filter((record) => record.principalKind === 'browser')
      .at(-1)?.eventHash;
    if (
      allowed.length === 0 ||
      denied.length === 0 ||
      unexpectedAllows.length > 0 ||
      !policyHash ||
      !terminalEventHash
    ) {
      throw new AcceptanceError('sanitized-audit-proof-incomplete');
    }

    stage = 'manifest-observations';
    result = {
      browserSignal,
      localFixtureRequests: localFixture.counters.requests,
      allowedAuditDecisions: allowed.length,
      deniedAuditDecisions: denied.length,
      sinkConnections: 0,
      sinkRequests: 0,
      sinkBodyBytes: 0,
      unexpectedAllows: 0,
      policyHash,
      terminalEventHash,
    };
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    throw new AcceptanceError(`stage-${stage}-failed`);
  } finally {
    const appToStop = appProcess;
    const processStopped = appToStop
      ? await runBoundedCleanup(() => stopOwnedProcess(appToStop))
      : true;
    const browserToClose = browser;
    const browserClosed = browserToClose
      ? await runBoundedCleanup(() => browserToClose.close())
      : true;
    const fixturesClosed = await runBoundedCleanup(() =>
      Promise.all([
        localFixture.close(),
        blockedSink?.close() ?? Promise.resolve(),
      ]).then(() => undefined),
    );
    cleanupSucceeded = browserClosed && processStopped && fixturesClosed;
  }
  if (!result || !cleanupSucceeded) {
    throw new AcceptanceError('packaged-acceptance-cleanup-failed');
  }
  return result;
}

async function navigateFromRealUi(
  omnibox: ReturnType<Page['getByPlaceholder']>,
  value: string,
  deadline: number,
): Promise<void> {
  await fillFromRealUi(omnibox, value, deadline);
  await omnibox.press('Enter', { timeout: remaining(deadline) });
}

async function fillFromRealUi(
  omnibox: ReturnType<Page['getByPlaceholder']>,
  value: string,
  deadline: number,
): Promise<void> {
  await omnibox.fill(value, { timeout: remaining(deadline) });
}

async function waitForMainUiPage(
  browser: Browser,
  deadline: number,
): Promise<Page> {
  let matched: Page | undefined;
  await waitForCondition(
    async () => {
      for (const page of allPages(browser)) {
        try {
          if (
            (await page
              .getByRole('button', { name: 'Open new browser tab' })
              .count()) > 0
          ) {
            matched = page;
            return true;
          }
        } catch {
          // Targets may disappear while the packaged app is starting.
        }
      }
      return false;
    },
    deadline,
    'main-ui-not-ready',
  );
  if (!matched) throw new AcceptanceError('main-ui-not-ready');
  return matched;
}

async function waitForFixturePage(
  browser: Browser,
  deadline: number,
): Promise<Page> {
  let matched: Page | undefined;
  await waitForCondition(
    async () => {
      for (const page of allPages(browser)) {
        try {
          if ((await page.locator(FIXTURE_MARKER).count()) > 0) {
            matched = page;
            return true;
          }
        } catch {
          // Navigation can replace the target execution context.
        }
      }
      return false;
    },
    deadline,
    'local-fixture-dom-not-observed',
  );
  if (!matched) throw new AcceptanceError('local-fixture-dom-not-observed');
  return matched;
}

async function waitForBrowserSignal(
  contentPage: Page,
  proxyDenied: () => boolean,
  navigationFailed: () => boolean,
  deadline: number,
): Promise<BrowserSignal> {
  let signal: BrowserSignal | undefined;
  await waitForCondition(
    () => {
      if (proxyDenied()) {
        signal = 'proxy-denial-response';
        return true;
      }
      if (contentPage.url().includes('/error/page-load-failed')) {
        signal = 'load-error-page';
        return true;
      }
      if (navigationFailed()) {
        signal = 'navigation-failed';
        return true;
      }
      return false;
    },
    deadline,
    'browser-fail-closed-signal-not-observed',
  );
  if (!signal) {
    throw new AcceptanceError('browser-fail-closed-signal-not-observed');
  }
  return signal;
}

async function waitForAuditDecisions(
  auditPath: string,
  allowedPort: number,
  deniedPort: number,
  deniedSink: FixtureCounters,
  deadline: number,
) {
  let records: Awaited<ReturnType<typeof readNetworkPolicyAuditLedger>> = [];
  await waitForCondition(
    async () => {
      if (deniedSink.connections > 0 || deniedSink.bodyBytes > 0) {
        throw new AcceptanceError('blocked-sink-connected-before-audit-deny');
      }
      try {
        records = await readNetworkPolicyAuditLedger(auditPath);
        return (
          records.some(
            (record) =>
              record.principalKind === 'browser' &&
              record.destinationPort === allowedPort &&
              record.decision === 'allow' &&
              record.reason === 'exact-destination-grant',
          ) &&
          records.some(
            (record) =>
              record.principalKind === 'browser' &&
              record.destinationPort === deniedPort &&
              record.decision === 'deny' &&
              record.reason === 'loopback-denied',
          )
        );
      } catch {
        return false;
      }
    },
    deadline,
    'sanitized-audit-decisions-not-observed',
  );
  return records;
}

function allPages(browser: Browser): Page[] {
  return browser.contexts().flatMap((context) => context.pages());
}

async function waitForCdp(
  port: number,
  child: ChildProcess,
  deadline: number,
): Promise<void> {
  await waitForCondition(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new AcceptanceError('packaged-app-exited-before-ui-ready');
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    deadline,
    'packaged-app-cdp-not-ready',
  );
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  deadline: number,
  reasonCode: string,
): Promise<void> {
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new AcceptanceError(reasonCode);
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new AcceptanceError('acceptance-timeout');
  return value;
}

async function writeIsolatedProfile(
  profilePath: string,
  allowedPort: number,
): Promise<void> {
  const dataRoot = path.join(profilePath, 'clodex');
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const allowedFixtureUrl = `http://${FIXTURE_HOST}:${allowedPort}/`;
  const preferences = {
    privacy: { telemetryLevel: 'off' },
    general: {
      newTabPage: { type: 'custom', customUrl: allowedFixtureUrl },
      startupPage: { type: 'custom', customUrl: allowedFixtureUrl },
    },
    featureGates: {
      overrides: {
        'egress-policy-engine': true,
        'egress-transparent-proxy': true,
        'egress-controlled-browser': true,
        'egress-control-center': true,
      },
    },
    networkEgress: {
      browserGrants: [
        {
          id: randomUUID(),
          scope: 'persistent',
          protocol: 'http',
          hostname: FIXTURE_HOST,
          port: allowedPort,
          createdAt: Date.now(),
          expiresAt: null,
        },
      ],
    },
  };
  await Promise.all([
    fs.writeFile(
      path.join(dataRoot, 'preferences.json'),
      JSON.stringify(preferences),
      { encoding: 'utf8', mode: 0o600 },
    ),
    fs.writeFile(
      path.join(dataRoot, 'onboarding-state.json'),
      JSON.stringify({ hasSeenOnboardingFlow: true }),
      { encoding: 'utf8', mode: 0o600 },
    ),
    fs.writeFile(
      path.join(dataRoot, 'tutorial-state.json'),
      JSON.stringify({ 'general-ui-experience': 4 }),
      { encoding: 'utf8', mode: 0o600 },
    ),
  ]);
}

async function createFixtureServer(): Promise<FixtureServer> {
  const counters: FixtureCounters = {
    connections: 0,
    requests: 0,
    bodyBytes: 0,
  };
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    counters.requests += 1;
    request.on('data', (chunk: Buffer) => {
      counters.bodyBytes += chunk.length;
    });
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    response.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>Acceptance fixture</title><link rel="icon" href="data:,"></head><body><main data-clodex-browser-egress-acceptance="allowed">ready</main></body></html>',
    );
  });
  server.on('connection', (socket) => {
    counters.connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, FIXTURE_HOST, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    counters,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createBlockedSinkServer(port: number): Promise<FixtureServer> {
  const counters: FixtureCounters = {
    connections: 0,
    requests: 0,
    bodyBytes: 0,
  };
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    counters.connections += 1;
    sockets.add(socket);
    socket.on('data', (chunk: Buffer) => {
      counters.bodyBytes += chunk.length;
    });
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, FIXTURE_HOST, resolve);
  });
  return {
    counters,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function readPackagedAppMetadata(
  rawAppPath: string,
): Promise<PackagedAppMetadata> {
  if (process.platform !== 'darwin') {
    throw new AcceptanceError('macos-packaged-app-required');
  }
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    throw new AcceptanceError('unsupported-macos-architecture');
  }
  const appPath = path.resolve(rawAppPath);
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  try {
    const stat = await fs.stat(appPath);
    if (!stat.isDirectory() || !appPath.endsWith('.app')) {
      throw new AcceptanceError('packaged-app-bundle-invalid');
    }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    throw new AcceptanceError('packaged-app-bundle-missing');
  }
  const executableName = readPlistValue(plistPath, 'CFBundleExecutable');
  const bundleId = readPlistValue(plistPath, 'CFBundleIdentifier');
  const version = readPlistValue(plistPath, 'CFBundleShortVersionString');
  const releaseChannel = inferEligibleReleaseChannel(bundleId);
  const executablePath = path.join(
    appPath,
    'Contents',
    'MacOS',
    executableName,
  );
  try {
    await fs.access(executablePath);
  } catch {
    throw new AcceptanceError('packaged-app-executable-missing');
  }
  return { executablePath, releaseChannel, version };
}

function readPlistValue(plistPath: string, key: string): string {
  try {
    return execFileSync(
      '/usr/bin/plutil',
      ['-extract', key, 'raw', '-o', '-', plistPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    throw new AcceptanceError('packaged-app-metadata-invalid');
  }
}

function inferEligibleReleaseChannel(bundleId: string): EligibleReleaseChannel {
  if (bundleId.endsWith('.prerelease')) return 'prerelease';
  if (bundleId.endsWith('.nightly')) return 'nightly';
  throw new AcceptanceError('controlled-egress-gates-unavailable');
}

async function acquirePackagedAcceptanceLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let backoffMs = 250;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(ACCEPTANCE_LOCK_PATH, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AcceptanceError('packaged-acceptance-lock-failed');
      }
      await delay(backoffMs);
      backoffMs = Math.min(2_000, Math.ceil(backoffMs * 1.5));
      continue;
    }
    try {
      await fs.writeFile(
        path.join(ACCEPTANCE_LOCK_PATH, 'owner.json'),
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
        { encoding: 'utf8', mode: 0o600 },
      );
      return async () => {
        await fs.rm(ACCEPTANCE_LOCK_PATH, { recursive: true, force: true });
      };
    } catch {
      await fs.rm(ACCEPTANCE_LOCK_PATH, { recursive: true, force: true });
      throw new AcceptanceError('packaged-acceptance-lock-failed');
    }
  }
  throw new AcceptanceError('packaged-acceptance-lock-timeout');
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalOwnedProcessTree(child, 'SIGTERM');
  await Promise.race([waitForExit(child), delay(5_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalOwnedProcessTree(child, 'SIGKILL');
  await Promise.race([waitForExit(child), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new AcceptanceError('owned-packaged-app-did-not-exit');
  }
}

function signalOwnedProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group already exited.
    }
  }
  child.kill(signal);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function writeManifestAtomically(
  outputPath: string,
  content: string,
): Promise<void> {
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporaryPath = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, resolved);
    await fs.chmod(resolved, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

function parseArguments(argv: string[]): Arguments {
  let appPath: string | undefined;
  let outputPath = path.resolve(
    process.cwd(),
    '../../.release-evidence/browser-egress-packaged.json',
  );
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (const value of argv) {
    if (value === '--') {
      continue;
    }
    if (value.startsWith('--app=')) {
      appPath = value.slice('--app='.length);
    } else if (value.startsWith('--output=')) {
      outputPath = value.slice('--output='.length);
    } else if (value.startsWith('--timeout-ms=')) {
      timeoutMs = Number(value.slice('--timeout-ms='.length));
    } else {
      throw new AcceptanceError('acceptance-argument-invalid');
    }
  }
  if (!appPath) throw new AcceptanceError('packaged-app-argument-required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000) {
    throw new AcceptanceError('acceptance-timeout-invalid');
  }
  return {
    appPath: path.resolve(appPath),
    outputPath: path.resolve(outputPath),
    timeoutMs,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runBoundedCleanup(
  action: () => Promise<void>,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new AcceptanceError('cleanup-timeout')),
          CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createSecretFreeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME',
    'PATH',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    '__CF_USER_TEXT_ENCODING',
  ]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

main().catch((error: unknown) => {
  const reasonCode =
    error instanceof AcceptanceError
      ? error.reasonCode
      : 'unexpected-acceptance-error';
  process.stderr.write(`[browser-egress-packaged] failed:${reasonCode}\n`);
  process.exitCode = 1;
});
