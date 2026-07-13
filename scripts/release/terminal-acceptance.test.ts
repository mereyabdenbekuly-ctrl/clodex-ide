import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInitialTerminalAcceptanceManifest,
  serializeTerminalAcceptanceManifest,
} from './terminal-acceptance-evidence.js';
import {
  acquirePackagedAcceptanceLock,
  AppLogObserver,
  hasExactTerminalRow,
  inspectablePageWebSocketUrls,
  normalizeTerminalRow,
  parseDevToolsVersion,
  parseTerminalAcceptanceArguments,
  seedIsolatedProfile,
  TERMINAL_COMMAND,
  waitForCondition,
  writeTerminalAcceptanceManifest,
} from './terminal-acceptance.js';

describe('packaged terminal acceptance', () => {
  it('parses required paths and bounded timeouts', () => {
    const options = parseTerminalAcceptanceArguments([
      '--packaged-app=dist/clodex.app',
      '--output=evidence.json',
      '--timeout-ms=1000',
      '--lock-timeout-ms=2000',
    ]);

    expect(options).toEqual({
      lockTimeoutMs: 2000,
      outputPath: path.resolve('evidence.json'),
      packagedAppPath: path.resolve('dist/clodex.app'),
      timeoutMs: 1000,
    });
    expect(() => parseTerminalAcceptanceArguments([])).toThrow(
      'packaged-app-required',
    );
  });

  it('does not retry definitive acceptance failures', async () => {
    let probes = 0;
    await expect(
      waitForCondition(
        () => {
          probes++;
          return parseTerminalAcceptanceArguments([]);
        },
        { reasonCode: 'unexpected-timeout', timeoutMs: 1000 },
      ),
    ).rejects.toThrow('packaged-app-required');
    expect(probes).toBe(1);
  });

  it('seeds only the isolated profile and shell prerequisites', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-profile-test.'));
    try {
      const seeded = seedIsolatedProfile(root);
      expect(seeded).toEqual({
        homePath: path.join(root, 'home'),
        profilePath: path.join(root, 'profile'),
      });
      expect(
        JSON.parse(
          readFileSync(
            path.join(root, 'profile/clodex/onboarding-state.json'),
            'utf8',
          ),
        ),
      ).toEqual({ hasSeenOnboardingFlow: true });
      expect(
        JSON.parse(
          readFileSync(
            path.join(root, 'profile/clodex/tutorial-state.json'),
            'utf8',
          ),
        ),
      ).toEqual({ 'general-ui-experience': 4 });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('parses the loopback DevTools contract and page targets', () => {
    expect(
      parseDevToolsVersion(
        {
          webSocketDebuggerUrl:
            'ws://127.0.0.1:49152/devtools/browser/acceptance-id',
        },
        'http://127.0.0.1:49152',
      ),
    ).toEqual({
      browserWebSocketUrl:
        'ws://127.0.0.1:49152/devtools/browser/acceptance-id',
      httpEndpoint: 'http://127.0.0.1:49152',
    });
    expect(parseDevToolsVersion({}, 'http://127.0.0.1:49152')).toBeNull();
    expect(
      inspectablePageWebSocketUrls([
        { type: 'browser', webSocketDebuggerUrl: 'ws://browser' },
        { type: 'page', webSocketDebuggerUrl: 'ws://main' },
        { type: 'other', webSocketDebuggerUrl: 'ws://view' },
        { type: 'page' },
      ]),
    ).toEqual(['ws://main', 'ws://view']);
  });

  it('requires the exact rendered output row, not an echoed command', () => {
    expect(TERMINAL_COMMAND).toBe("printf 'CLODEX_TERMINAL_OK\\n'");
    expect(
      hasExactTerminalRow([
        "$ printf 'CLODEX_TERMINAL_OK\\n'",
        'CLODEX_TERMINAL_OK\u00a0\u00a0',
      ]),
    ).toBe(true);
    expect(hasExactTerminalRow(["$ printf 'CLODEX_TERMINAL_OK\\n'"])).toBe(
      false,
    );
    expect(normalizeTerminalRow('ok\u00a0  ')).toBe('ok');
  });

  it('recognizes split terminal lifecycle and shutdown log records', () => {
    const observer = new AppLogObserver();
    observer.append('[TerminalService] Created term');
    observer.append('inal term-7 in an isolated directory\n');
    observer.append('[TerminalService] PTY term-7 exited with co');
    observer.append('de 0\n[Main] Services shut down\n');

    expect(observer.firstCreatedIdNotIn(new Set())).toBe('term-7');
    expect(observer.exitCode('term-7')).toBe(0);
    expect(observer.hasShutdownComplete()).toBe(true);
    expect(observer.hasFatalStartupOutput()).toBe(false);
  });

  it('serializes deterministic content-free evidence', () => {
    const manifest = createInitialTerminalAcceptanceManifest();
    manifest.status = 'passed';
    for (const check of Object.values(manifest.checks)) check.status = 'pass';
    manifest.checks.packagedLaunch.cdpConnected = true;
    manifest.checks.packagedLaunch.isolatedProfile = true;
    manifest.checks.terminalUi.inputFocused = true;
    manifest.checks.terminalUi.openedViaUi = true;
    manifest.checks.command.enteredViaUi = true;
    manifest.checks.command.outputObserved = true;
    manifest.checks.ptyExit.exitCode = 0;
    manifest.checks.ptyExit.terminalRemoved = true;
    manifest.checks.appShutdown.exitCode = 0;
    manifest.checks.appShutdown.servicesShutDown = true;

    const first = serializeTerminalAcceptanceManifest(manifest);
    const second = serializeTerminalAcceptanceManifest(manifest);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual(manifest);
    expect(first).not.toContain(TERMINAL_COMMAND);
    expect(first).not.toContain('CLODEX_TERMINAL_OK');
    expect(first).not.toContain('/private/');
    expect(first).not.toContain('API_KEY');
  });

  it('replaces evidence with an owner-only file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-evidence-test.'));
    const outputPath = path.join(root, 'evidence.json');
    try {
      writeFileSync(outputPath, 'old evidence', { mode: 0o644 });
      writeTerminalAcceptanceManifest(
        createInitialTerminalAcceptanceManifest(),
        outputPath,
      );

      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
        contentFree: true,
        schemaVersion: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('holds the inter-session mutex until its owner releases it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-lock-test.'));
    const lockPath = path.join(root, 'acceptance.lock');
    try {
      const release = await acquirePackagedAcceptanceLock({
        lockPath,
        timeoutMs: 1000,
      });
      expect(existsSync(lockPath)).toBe(true);
      await expect(
        acquirePackagedAcceptanceLock({ lockPath, timeoutMs: 25 }),
      ).rejects.toThrow('packaged-acceptance-lock-timeout');

      release();
      expect(existsSync(lockPath)).toBe(false);
      const releaseAgain = await acquirePackagedAcceptanceLock({
        lockPath,
        timeoutMs: 1000,
      });
      releaseAgain();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
