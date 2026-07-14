import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import { HooksService } from './hooks';

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe('HooksService', () => {
  let root: string;
  let store: AgentOsStateStore;
  let service: HooksService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-os-hooks-'));
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
    service = new HooksService(store, new DebugInspectorService(store));
  });

  afterEach(async () => {
    if (process.platform === 'win32') {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      return;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does nothing for disabled hooks', async () => {
    await service.create({
      name: 'Disabled prompt',
      trigger: 'before-turn',
      kind: 'prompt',
      body: 'Do not include this',
      enabled: false,
      timeoutMs: 1_000,
    });

    await expect(service.run('before-turn')).resolves.toEqual({
      promptText: '',
      runs: [],
    });
  });

  it('returns enabled prompt hooks as turn context', async () => {
    await service.create({
      name: 'Prompt context',
      trigger: 'before-turn',
      kind: 'prompt',
      body: 'Prefer focused changes.',
      enabled: true,
      timeoutMs: 1_000,
    });

    const result = await service.run('before-turn');

    expect(result.promptText).toBe('Prefer focused changes.');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe('succeeded');
  });

  it('skips command hooks without explicit approval and workspace trust', async () => {
    await service.create({
      name: 'Protected command',
      trigger: 'before-command',
      kind: 'command',
      body: nodeCommand("process.stdout.write('ran')"),
      enabled: true,
      timeoutMs: 1_000,
    });

    const result = await service.run('before-command');

    expect(result.runs[0]?.status).toBe('skipped');
    expect(result.runs[0]?.error).toContain('explicit approval');
  });

  it('uses a sanitized environment for approved command hooks', async () => {
    process.env.AGENT_OS_TEST_SECRET = 'must-not-leak';
    await service.create({
      name: 'Safe env',
      trigger: 'before-command',
      kind: 'command',
      body: nodeCommand(
        "process.stdout.write(process.env.AGENT_OS_TEST_SECRET || 'clean')",
      ),
      enabled: true,
      timeoutMs: 2_000,
    });

    const result = await service.run('before-command', {
      commandApproved: true,
      workspaceTrusted: true,
      workspacePath: root,
    });

    delete process.env.AGENT_OS_TEST_SECRET;
    expect(result.runs[0]?.status).toBe('succeeded');
    expect(result.runs[0]?.output).toBe('clean');
  });

  it('records timeout failures without throwing from the hook runner', async () => {
    await service.create({
      name: 'Timeout',
      trigger: 'after-command',
      kind: 'command',
      body: nodeCommand('setTimeout(() => {}, 1000)'),
      enabled: true,
      timeoutMs: 100,
    });

    const result = await service.run('after-command', {
      commandApproved: true,
      workspaceTrusted: true,
      workspacePath: root,
    });

    expect(result.runs[0]?.status).toBe('failed');
    expect(result.runs[0]?.error).toContain('timed out');
  });
});
