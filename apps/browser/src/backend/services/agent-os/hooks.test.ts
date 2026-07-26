import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import { HooksService, sanitizeRendererHookRunContext } from './hooks';

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
    const hook = await service.create({
      name: 'Protected command',
      trigger: 'before-command',
      kind: 'command',
      body: nodeCommand("process.stdout.write('ran')"),
      enabled: false,
      timeoutMs: 1_000,
    });

    const result = await service.run('before-command', {
      manualHookId: hook.id,
    });

    expect(result.runs[0]?.status).toBe('skipped');
    expect(result.runs[0]?.error).toContain('explicit approval');
  });

  it('uses a sanitized environment for approved command hooks', async () => {
    process.env.AGENT_OS_TEST_SECRET = 'must-not-leak';
    const hook = await service.create({
      name: 'Safe env',
      trigger: 'before-command',
      kind: 'command',
      body: nodeCommand(
        "process.stdout.write(process.env.AGENT_OS_TEST_SECRET || 'clean')",
      ),
      enabled: false,
      timeoutMs: 2_000,
    });

    const result = await service.run('before-command', {
      commandApproved: true,
      workspaceTrusted: true,
      workspacePath: root,
      manualHookId: hook.id,
    });

    delete process.env.AGENT_OS_TEST_SECRET;
    expect(result.runs[0]?.status).toBe('succeeded');
    expect(result.runs[0]?.output).toBe('clean');
  });

  it('records timeout failures without throwing from the hook runner', async () => {
    const hook = await service.create({
      name: 'Timeout',
      trigger: 'after-command',
      kind: 'command',
      body: nodeCommand('setTimeout(() => {}, 1000)'),
      enabled: false,
      timeoutMs: 100,
    });

    const result = await service.run('after-command', {
      commandApproved: true,
      workspaceTrusted: true,
      workspacePath: root,
      manualHookId: hook.id,
    });

    expect(result.runs[0]?.status).toBe('failed');
    expect(result.runs[0]?.error).toContain('timed out');
  });

  it('tests exactly one disabled hook instead of every hook with the trigger', async () => {
    const selected = await service.create({
      name: 'Selected',
      trigger: 'before-turn',
      kind: 'prompt',
      body: 'selected output',
      enabled: false,
      timeoutMs: 1_000,
    });
    await service.create({
      name: 'Enabled sibling',
      trigger: 'before-turn',
      kind: 'prompt',
      body: 'sibling output',
      enabled: true,
      timeoutMs: 1_000,
    });

    const result = await service.run('before-turn', {
      manualHookId: selected.id,
    });

    expect(result.promptText).toBe('selected output');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.hookId).toBe(selected.id);
  });

  it('does not manufacture zero-duration skips for an unavailable helper runner', async () => {
    const hook = await service.create({
      name: 'Legacy helper',
      trigger: 'after-turn',
      kind: 'agent',
      body: 'Review the completed turn.',
      enabled: false,
      timeoutMs: 1_000,
    });

    await expect(service.update(hook.id, { enabled: true })).rejects.toThrow(
      'no trusted runner is configured',
    );
    await expect(
      service.run('after-turn', { manualHookId: hook.id }),
    ).rejects.toThrow('runner is not configured');
    await expect(service.run('after-turn')).resolves.toEqual({
      promptText: '',
      runs: [],
    });
    expect(store.snapshot().hookRuns).toEqual([]);
  });

  it('runs helper-agent hooks only through the configured trusted seam', async () => {
    const hook = await service.create({
      name: 'Turn reviewer',
      trigger: 'after-turn',
      kind: 'agent',
      body: 'Review the completed turn.',
      enabled: false,
      timeoutMs: 1_000,
    });
    const runner = vi.fn(async () => 'helper started');
    await service.setHelperAgentRunner(runner);
    await service.update(hook.id, { enabled: true });

    const result = await service.run('after-turn', {
      values: { agentInstanceId: 'agent-1' },
    });

    expect(store.snapshot().hookRuntime.helperAgentRunnerConfigured).toBe(true);
    expect(result.runs[0]).toMatchObject({
      hookId: hook.id,
      status: 'succeeded',
      output: 'helper started',
    });
    expect(runner).toHaveBeenCalledWith({
      hook: expect.objectContaining({ id: hook.id }),
      mode: 'automatic',
      context: {
        workspacePath: undefined,
        commandApproved: undefined,
        workspaceTrusted: undefined,
        values: { agentInstanceId: 'agent-1' },
        trustedLifecycle: undefined,
      },
    });

    const restartedStore = await AgentOsStateStore.create(
      path.join(root, 'state.json'),
    );
    expect(
      restartedStore.snapshot().hookRuntime.helperAgentRunnerConfigured,
    ).toBe(false);
  });

  it('keeps before-turn helper observers manual-only', async () => {
    const hook = await service.create({
      name: 'Background observer',
      trigger: 'before-turn',
      kind: 'agent',
      body: 'Review the previous state.',
      enabled: false,
      timeoutMs: 1_000,
    });
    const runner = vi.fn(async () => 'manual review');
    await service.setHelperAgentRunner(runner);

    await expect(service.update(hook.id, { enabled: true })).rejects.toThrow(
      'no safe automatic executor',
    );
    await expect(service.run('before-turn')).resolves.toEqual({
      promptText: '',
      runs: [],
    });
    await expect(
      service.run('before-turn', {
        manualHookId: hook.id,
        values: { agentInstanceId: 'agent-1' },
      }),
    ).resolves.toMatchObject({
      runs: [expect.objectContaining({ output: 'manual review' })],
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'manual' }),
    );
  });

  it('coalesces awaited helper bursts to the newest revocable lifecycle event', async () => {
    const hook = await service.create({
      name: 'Terminal observer',
      trigger: 'after-turn',
      kind: 'agent',
      body: 'Review the terminal state.',
      enabled: false,
      timeoutMs: 30_000,
    });
    const finishRunners: Array<(output: string) => void> = [];
    const runner = vi.fn(
      async (input: { context: { values?: Record<string, unknown> } }) =>
        await new Promise<string>((resolve) => {
          finishRunners.push((output) =>
            resolve(`${String(input.context.values?.sequence)}:${output}`),
          );
        }),
    );
    await service.setHelperAgentRunner(runner);
    await service.update(hook.id, { enabled: true });

    const first = service.run('after-turn', {
      values: { agentInstanceId: 'agent-1', sequence: 1 },
    });
    const superseded = service.run('after-turn', {
      values: { agentInstanceId: 'agent-1', sequence: 2 },
    });
    const latest = service.run('after-turn', {
      values: { agentInstanceId: 'agent-1', sequence: 3 },
    });

    await expect(superseded).resolves.toEqual({ promptText: '', runs: [] });
    expect(runner).toHaveBeenCalledOnce();

    finishRunners[0]?.('FIRST');
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    expect(runner.mock.calls[1]?.[0]).toMatchObject({
      context: { values: { sequence: 3 } },
    });
    finishRunners[1]?.('LATEST');
    await expect(first).resolves.toMatchObject({
      runs: [expect.objectContaining({ output: '1:FIRST' })],
    });
    await expect(latest).resolves.toMatchObject({
      runs: [expect.objectContaining({ output: '3:LATEST' })],
    });
    expect(store.snapshot().hookRuns.map((run) => run.output)).toEqual([
      '1:FIRST',
      '3:LATEST',
    ]);
  });

  it('drops a queued review when its exact provider route is revoked', async () => {
    const hook = await service.create({
      name: 'Revocable route observer',
      trigger: 'after-turn',
      kind: 'agent',
      body: 'Review the terminal state.',
      enabled: false,
      timeoutMs: 30_000,
    });
    const finishRunners: Array<(output: string) => void> = [];
    const runner = vi.fn(
      async () =>
        await new Promise<string>((resolve) => finishRunners.push(resolve)),
    );
    let routeValid = true;
    const modelWithOptions = {
      routeLease: { isValid: () => routeValid },
    } as never;
    await service.setHelperAgentRunner(runner);
    await service.update(hook.id, { enabled: true });
    const context = (sequence: number) => ({
      values: { agentInstanceId: 'agent-1', sequence },
      trustedLifecycle: {
        modelId: 'originating-model',
        modelWithOptions,
        snapshot: `snapshot-${sequence}`,
      },
    });

    const first = service.run('after-turn', context(1));
    const queued = service.run('after-turn', context(2));
    expect(runner).toHaveBeenCalledOnce();

    routeValid = false;
    finishRunners[0]?.('FIRST');
    await expect(first).resolves.toMatchObject({
      runs: [expect.objectContaining({ output: 'FIRST' })],
    });
    await expect(queued).resolves.toEqual({ promptText: '', runs: [] });
    expect(runner).toHaveBeenCalledOnce();
  });

  it('serializes same-hook mutations so a stale edit cannot re-enable it', async () => {
    const hook = await service.create({
      name: 'Revocable observer',
      trigger: 'after-turn',
      kind: 'agent',
      body: 'Review the terminal state.',
      enabled: false,
      timeoutMs: 30_000,
    });
    const runner = vi.fn(async () => 'OK');
    await service.setHelperAgentRunner(runner);
    await service.update(hook.id, { enabled: true });

    await Promise.all([
      service.update(hook.id, { enabled: false }),
      service.update(hook.id, { name: 'Renamed safely' }),
    ]);
    expect(store.snapshot().hooks).toContainEqual(
      expect.objectContaining({
        id: hook.id,
        enabled: false,
        name: 'Renamed safely',
      }),
    );
    await expect(
      service.run('after-turn', {
        values: { agentInstanceId: 'agent-1' },
      }),
    ).resolves.toEqual({ promptText: '', runs: [] });
    expect(runner).not.toHaveBeenCalled();
  });

  it('strips forged renderer command authority before hook dispatch', async () => {
    const hook = await service.create({
      name: 'Must stay blocked',
      trigger: 'before-command',
      kind: 'command',
      body: nodeCommand("process.stdout.write('should-not-run')"),
      enabled: false,
      timeoutMs: 1_000,
    });
    const sanitized = sanitizeRendererHookRunContext({
      manualHookId: hook.id,
      values: {
        agentInstanceId: 'agent-1',
        lifecycleSource: 'forged',
        modelId: 'forged-model',
        outcome: 'done',
        providerMode: 'custom',
      },
      trustedLifecycle: {
        modelId: 'forged-model',
        modelWithOptions: null,
        snapshot: 'forged snapshot',
      },
      workspacePath: '/trusted-looking',
      commandApproved: true,
      workspaceTrusted: true,
    });

    expect(sanitized).toEqual({
      manualHookId: hook.id,
      values: { agentInstanceId: 'agent-1' },
    });
    await expect(
      service.run('before-command', sanitized),
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          status: 'skipped',
          error: expect.stringContaining('explicit approval'),
        }),
      ],
    });
  });
});
