import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ptyHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    writes: string[];
    emitData(data: string): void;
    emitExit(exitCode?: number): void;
  }>,
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let onData: (data: string) => void = () => {};
    let onExit: (event: { exitCode: number; signal?: number }) => void =
      () => {};
    const instance = {
      pid: 4242,
      process: 'mock-shell',
      cols: 120,
      rows: 24,
      writes: [] as string[],
      write(data: string) {
        this.writes.push(data);
      },
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      onData(listener: (data: string) => void) {
        onData = listener;
        return { dispose: vi.fn() };
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        onExit = listener;
        return { dispose: vi.fn() };
      },
      emitData(data: string) {
        onData(data);
      },
      emitExit(exitCode = 0) {
        onExit({ exitCode });
      },
    };
    ptyHarness.instances.push(instance);
    return instance;
  }),
}));

import { SessionManager } from './session-manager';
import type { DetectedShell } from './types';

const osc = (marker: string, param?: string) =>
  `\x1b]133;${marker}${param == null ? '' : `;${param}`}\x07`;

function createHarness(type: DetectedShell['type']) {
  const manager = new SessionManager({ type, path: `mock-${type}` });
  const sessionId = manager.createSession('agent-test', process.cwd(), {});
  const session = manager.getSession(sessionId);
  const pty = ptyHarness.instances.at(-1);
  if (!session || !pty || !session.parser.boundaryToken) {
    throw new Error('Failed to create mocked shell session');
  }
  return {
    manager,
    sessionId,
    pty,
    boundaryToken: session.parser.boundaryToken,
  };
}

async function startCommand(
  harness: ReturnType<typeof createHarness>,
  command: string,
) {
  harness.pty.emitData(osc('A'));
  const result = harness.manager.executeCommand(harness.sessionId, {
    command,
    waitUntil: { idleMs: 0, timeoutMs: 1_000 },
  });
  await vi.waitFor(() => {
    expect(harness.pty.writes.at(-1)).toBe(`${command}\r`);
  });
  return { result };
}

describe('SessionManager OSC command lifecycle', () => {
  const managers: SessionManager[] = [];

  beforeEach(() => {
    ptyHarness.instances.length = 0;
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.killAll();
  });

  it('ignores a stale Bash command-end marker until the pending command starts', async () => {
    const harness = createHarness('bash');
    managers.push(harness.manager);

    // Integration is detected from B, but the init script has not reached a
    // prompt yet. A command requested in this split-chunk window must remain
    // queued rather than being written into the still-running init cycle.
    harness.pty.emitData(osc('B'));
    const command = 'echo CURRENT_COMMAND';
    const resultPromise = harness.manager.executeCommand(harness.sessionId, {
      command,
      waitUntil: { idleMs: 0, timeoutMs: 1_000 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.pty.writes).not.toContain(`${command}\r`);

    // The init C/D/A cycle reaches a real prompt, opening readiness and
    // allowing executeCommand to write the queued user command.
    harness.pty.emitData(
      `${osc('C')}${osc('D', `0;${harness.boundaryToken}`)}${osc('A')}`,
    );
    await vi.waitFor(() => {
      expect(harness.pty.writes.at(-1)).toBe(`${command}\r`);
    });
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    // A further stale completion can arrive in a separate PTY chunk after
    // readiness. It still must not resolve the pending command before its C.
    harness.pty.emitData(
      `${osc('D', `0;${harness.boundaryToken}`)}${osc('A')}`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    harness.pty.emitData(
      `${osc('C')}CURRENT_COMMAND${osc('D', `0;${harness.boundaryToken}`)}${osc('A')}`,
    );

    await expect(resultPromise).resolves.toMatchObject({
      output: 'CURRENT_COMMAND',
      exitCode: 0,
      resolvedBy: 'exit',
    });
  });

  it('lets raw input attach to an already-started Bash command', async () => {
    const harness = createHarness('bash');
    managers.push(harness.manager);
    harness.pty.emitData(`${osc('A')}${osc('C')}WAITING_FOR_INPUT`);

    const input = 'yes\r';
    const resultPromise = harness.manager.executeCommand(harness.sessionId, {
      command: input,
      rawInput: true,
      waitUntil: { idleMs: 0, timeoutMs: 1_000 },
    });
    await vi.waitFor(() => {
      expect(harness.pty.writes.at(-1)).toBe(input);
    });

    harness.pty.emitData(
      `${osc('D', `0;${harness.boundaryToken}`)}${osc('A')}`,
    );

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      resolvedBy: 'exit',
    });
  });

  it('preserves the PowerShell D-only completion fallback', async () => {
    const harness = createHarness('powershell');
    managers.push(harness.manager);
    const { result: resultPromise } = await startCommand(harness, 'Get-Date');

    harness.pty.emitData(osc('D', `0;${harness.boundaryToken}`));

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      resolvedBy: 'exit',
    });
  });

  it('keeps sentinel completion independent from the OSC start gate', async () => {
    const harness = createHarness('sh');
    managers.push(harness.manager);
    const resultPromise = harness.manager.executeCommand(harness.sessionId, {
      command: 'echo SENTINEL_COMMAND',
      waitUntil: { idleMs: 0, timeoutMs: 1_000 },
    });
    await vi.waitFor(() => {
      expect(harness.pty.writes.at(-1)).toContain('__STAGE_DONE_');
    });
    const commandId = harness.pty.writes
      .at(-1)
      ?.match(/__STAGE_DONE_([a-zA-Z0-9_-]+)_/)?.[1];
    expect(commandId).toBeTruthy();

    harness.pty.emitData(`__STAGE_DONE_${commandId}_0__`);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      resolvedBy: 'exit',
    });
  });
});
