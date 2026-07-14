import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTypeRegistry } from '../../agents/agents-registry';
import { CommandRegistry } from '../../commands/command-registry';
import { createTestAgentHost } from '../../host/test-utils';
import { AgentTypes } from '../../types/agent';
import {
  legacyMountPrefixForPath,
  mountPrefixForPath,
} from '../mount-manager/mount-registry';
import { AgentManager } from './agent-manager';

function createHarness(isWorking = false) {
  const registry = new CommandRegistry();
  const instances = {
    'source-task': {
      type: AgentTypes.CHAT,
      state: { isWorking, usedTokens: 250, goal: null },
    },
  };
  const storeState = { agents: { instances }, toolbox: {} };
  const persistenceDb = {
    forkAgentInstance: vi.fn(async () => {}),
    deleteAgentInstance: vi.fn(async () => {}),
    setAgentArchived: vi.fn(async () => true),
    getStoredAgentInstanceById: vi.fn(async () => null),
  };
  const attachments = {
    copyAgentBlobs: vi.fn(async () => {}),
    deleteAgentBlobs: vi.fn(async () => {}),
  };
  const toolbox = {
    handleMountWorkspace: vi.fn(async () => {}),
    cancelQuestion: vi.fn(),
    getWorkspaceSnapshotForPersistence: vi.fn(() => []),
    setWorkspaceMdContent: vi.fn(),
    acceptAllPendingEditsForAgent: vi.fn(async () => {}),
    getEditedFilePathsForAgent: vi.fn(async () => []),
  };
  const manager = new AgentManager({
    host: createTestAgentHost(),
    commandRegistry: registry,
    agentTypeRegistry: new AgentTypeRegistry(),
    startupPolicy: { kind: 'none' },
    state: {
      store: {
        get: vi.fn(() => storeState),
        update: vi.fn((recipe) => recipe(storeState)),
      } as any,
    },
    storage: {
      persistenceDb: persistenceDb as any,
      attachments: attachments as any,
      fileReadCache: {} as any,
    },
    tools: {
      managerToolbox: toolbox as any,
      agentToolbox: toolbox as any,
    },
  });

  return { registry, manager, persistenceDb, attachments, toolbox };
}

describe('AgentManager task lifecycle handlers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects forking a running task before touching persistence', async () => {
    const harness = createHarness(true);

    await expect(
      harness.registry.dispatch('agents.fork', { callerId: 'test' }, [
        'source-task',
      ]),
    ).rejects.toThrow('Cannot fork a task while it is running');
    expect(harness.persistenceDb.forkAgentInstance).not.toHaveBeenCalled();
    expect(harness.attachments.copyAgentBlobs).not.toHaveBeenCalled();

    await harness.manager.teardown();
  });

  it('forks persistence and attachments, resumes the fork, and returns its id', async () => {
    const resumeSpy = vi
      .spyOn(AgentManager.prototype, 'resumeAgent')
      .mockResolvedValue({ instanceId: 'forked-task' } as any);
    const harness = createHarness(false);

    const forkId = await harness.registry.dispatch<unknown[], string>(
      'agents.fork',
      { callerId: 'test' },
      ['source-task', 'message-2'],
    );

    expect(forkId).toEqual(expect.any(String));
    expect(harness.persistenceDb.forkAgentInstance).toHaveBeenCalledWith(
      'source-task',
      forkId,
      'message-2',
    );
    expect(harness.attachments.copyAgentBlobs).toHaveBeenCalledWith(
      'source-task',
      forkId,
    );
    expect(resumeSpy).toHaveBeenCalledWith(forkId);

    await harness.manager.teardown();
  });

  it('archives and restores persisted top-level tasks through RPC commands', async () => {
    const harness = createHarness(false);

    await harness.registry.dispatch('agents.archive', { callerId: 'test' }, [
      'source-task',
    ]);
    await harness.registry.dispatch('agents.unarchive', { callerId: 'test' }, [
      'source-task',
    ]);

    expect(harness.persistenceDb.setAgentArchived).toHaveBeenNthCalledWith(
      1,
      'source-task',
      true,
    );
    expect(harness.persistenceDb.setAgentArchived).toHaveBeenNthCalledWith(
      2,
      'source-task',
      false,
    );

    await harness.manager.teardown();
  });

  it('requires an archived task to be restored before resume', async () => {
    const harness = createHarness(false);
    harness.persistenceDb.getStoredAgentInstanceById.mockResolvedValue({
      id: 'source-task',
      parentAgentInstanceId: null,
      archivedAt: new Date('2026-07-11T00:00:00.000Z'),
    } as any);
    const createSpy = vi.spyOn(AgentManager.prototype, 'createAgent');

    await expect(harness.manager.resumeAgent('source-task')).rejects.toThrow(
      'must be restored before it can be resumed',
    );
    expect(createSpy).not.toHaveBeenCalled();

    await harness.manager.teardown();
  });

  it('migrates legacy mount prefixes before restoring persisted history', async () => {
    const harness = createHarness(false);
    const workspacePath = '/tmp/persisted-prefix-workspace';
    const legacyPrefix = legacyMountPrefixForPath(workspacePath);
    const currentPrefix = mountPrefixForPath(workspacePath);
    harness.persistenceDb.getStoredAgentInstanceById.mockResolvedValue({
      id: 'source-task',
      type: AgentTypes.CHAT,
      instanceConfig: {},
      title: 'Persisted task',
      titleLockedByUser: false,
      history: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: `Read ${legacyPrefix}/src/app.ts` }],
        },
      ],
      queuedMessages: [
        {
          id: 'message-2',
          role: 'user',
          parts: [{ type: 'text', text: `Test ${legacyPrefix}/src/app.ts` }],
        },
      ],
      activeModelId: '',
      toolApprovalMode: null,
      inputState: `Open ${legacyPrefix}/README.md`,
      usedTokens: 42,
      goal: null,
      parentAgentInstanceId: null,
      archivedAt: null,
      mountedWorkspaces: [{ path: workspacePath, permissions: ['read'] }],
    } as any);
    const createSpy = vi
      .spyOn(harness.manager, 'createAgent')
      .mockResolvedValue({ instanceId: 'source-task' } as any);

    await harness.manager.resumeAgent('source-task');

    const initialState = createSpy.mock.calls[0]?.[3];
    expect(initialState?.history?.[0]?.parts).toEqual([
      { type: 'text', text: `Read ${currentPrefix}/src/app.ts` },
    ]);
    expect(initialState?.queuedMessages?.[0]?.parts).toEqual([
      { type: 'text', text: `Test ${currentPrefix}/src/app.ts` },
    ]);
    expect(initialState?.inputState).toBe(`Open ${currentPrefix}/README.md`);
    expect(harness.toolbox.handleMountWorkspace).toHaveBeenCalledWith(
      'source-task',
      workspacePath,
      ['read'],
    );

    await harness.manager.teardown();
  });

  it('creates and updates a persisted task goal through RPC commands', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const persistSpy = vi
      .spyOn(AgentManager.prototype as any, 'persistAgentState')
      .mockResolvedValue(undefined);
    const harness = createHarness(false);

    await harness.registry.dispatch('agents.setGoal', { callerId: 'test' }, [
      'source-task',
      'Ship task goals',
      20_000,
      3_600,
    ]);

    const state = (harness.manager as any).agentStore.get().agents.instances[
      'source-task'
    ].state;
    expect(state.goal).toMatchObject({
      objective: 'Ship task goals',
      status: 'active',
      tokenBudget: 20_000,
      timeBudgetSeconds: 3_600,
      startedUsedTokens: 250,
      accumulatedActiveMs: 0,
      activeStartedAt: 1_000,
      createdAt: 1_000,
    });

    vi.setSystemTime(11_000);
    await harness.registry.dispatch(
      'agents.setGoalStatus',
      { callerId: 'test' },
      ['source-task', 'blocked'],
    );
    expect(state.goal).toMatchObject({
      status: 'blocked',
      accumulatedActiveMs: 10_000,
      activeStartedAt: null,
    });

    vi.setSystemTime(12_000);
    await harness.registry.dispatch('agents.setGoal', { callerId: 'test' }, [
      'source-task',
      'Ship task goals safely',
      30_000,
      7_200,
    ]);
    expect(state.goal).toMatchObject({
      objective: 'Ship task goals safely',
      status: 'blocked',
      tokenBudget: 30_000,
      timeBudgetSeconds: 7_200,
      startedUsedTokens: 250,
      accumulatedActiveMs: 10_000,
      activeStartedAt: null,
      createdAt: 1_000,
      updatedAt: 12_000,
    });

    vi.setSystemTime(15_000);
    await harness.registry.dispatch(
      'agents.setGoalStatus',
      { callerId: 'test' },
      ['source-task', 'active'],
    );
    expect(state.goal.activeStartedAt).toBe(15_000);

    vi.setSystemTime(20_000);
    await harness.registry.dispatch(
      'agents.setGoalStatus',
      { callerId: 'test' },
      ['source-task', 'completed'],
    );
    expect(state.goal).toMatchObject({
      status: 'completed',
      accumulatedActiveMs: 15_000,
      activeStartedAt: null,
    });

    await harness.registry.dispatch('agents.clearGoal', { callerId: 'test' }, [
      'source-task',
    ]);
    expect(state.goal).toBeNull();
    expect(persistSpy).toHaveBeenCalledTimes(6);

    await harness.manager.teardown();
  });

  it('rejects invalid time budgets', async () => {
    const harness = createHarness(false);

    await expect(
      harness.registry.dispatch('agents.setGoal', { callerId: 'test' }, [
        'source-task',
        'Invalid goal',
        null,
        31_536_001,
      ]),
    ).rejects.toThrow('Goal time budget');

    await harness.manager.teardown();
  });
});
