import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTypeRegistry } from '../../agents/agents-registry';
import { CommandRegistry } from '../../commands/command-registry';
import { createTestAgentHost } from '../../host/test-utils';
import type { AgentRuntimeProgress } from '../../agents/runtime-progress';
import { AgentManager } from './agent-manager';

function createManager(options: {
  canRunAgentWork?: () => boolean;
  isNetworkOnline?: () => boolean;
  storeState?: unknown;
}) {
  const store = {
    get: vi.fn(() =>
      options.storeState
        ? structuredClone(options.storeState)
        : { agents: { instances: {} }, toolbox: {} },
    ),
    update: vi.fn(),
  };
  const toolbox = {
    handleMountWorkspace: vi.fn(async () => undefined),
    cancelQuestion: vi.fn(),
    getWorkspaceSnapshotForPersistence: vi.fn(() => []),
    setWorkspaceMdContent: vi.fn(),
    acceptAllPendingEditsForAgent: vi.fn(async () => undefined),
    getEditedFilePathsForAgent: vi.fn(async () => []),
  };
  const manager = new AgentManager({
    host: createTestAgentHost(),
    commandRegistry: new CommandRegistry(),
    agentTypeRegistry: new AgentTypeRegistry(),
    startupPolicy: { kind: 'none' },
    state: { store: store as never },
    storage: {
      persistenceDb: {} as never,
      attachments: {} as never,
      fileReadCache: {} as never,
    },
    tools: {
      managerToolbox: toolbox as never,
      agentToolbox: toolbox as never,
    },
    hooks: {
      canRunAgentWork: options.canRunAgentWork,
      isNetworkOnline: options.isNetworkOnline,
    },
  });
  return { manager, store };
}

function seedNetworkFailedAgent(manager: AgentManager) {
  const retryLastUserMessage = vi.fn(async () => undefined);
  (
    manager as unknown as {
      activeAgents: Map<string, unknown>;
    }
  ).activeAgents.set('agent-1', { retryLastUserMessage });
  return retryLastUserMessage;
}

const networkFailedStoreState = {
  agents: {
    instances: {
      'agent-1': {
        state: {
          isWorking: false,
          history: [],
          error: { message: 'network timeout' },
        },
      },
    },
  },
  toolbox: { 'agent-1': {} },
};

describe('AgentManager host execution gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suspends automatic network retry scans until the gate opens', async () => {
    let allowed = false;
    const isNetworkOnline = vi.fn(() => true);
    const { manager } = createManager({
      canRunAgentWork: () => allowed,
      isNetworkOnline,
      storeState: networkFailedStoreState,
    });
    seedNetworkFailedAgent(manager);

    await manager.retryNetworkFailedAgentsNow('blocked');
    expect(isNetworkOnline).not.toHaveBeenCalled();

    allowed = true;
    await manager.retryNetworkFailedAgentsNow('allowed');
    expect(isNetworkOnline).toHaveBeenCalledTimes(1);
    await manager.teardown();
  });

  it('suspends interrupted-run recovery until the gate opens', async () => {
    let allowed = false;
    const { manager } = createManager({
      canRunAgentWork: () => allowed,
      storeState: {
        agents: {
          instances: {
            'agent-1': { state: { isWorking: true, history: [] } },
          },
        },
        toolbox: { 'agent-1': {} },
      },
    });
    const recoverInterruptedRun = vi.fn(async () => undefined);
    (
      manager as unknown as { activeAgents: Map<string, unknown> }
    ).activeAgents.set('agent-1', { recoverInterruptedRun });

    await manager.recoverInterruptedActiveAgents('system-resumed');
    expect(recoverInterruptedRun).not.toHaveBeenCalled();

    allowed = true;
    await manager.recoverInterruptedActiveAgents('system-resumed');
    expect(recoverInterruptedRun).toHaveBeenCalledTimes(1);
    await manager.teardown();
  });

  it('suspends logical-inactivity recovery until the gate opens', async () => {
    let allowed = false;
    const { manager } = createManager({
      canRunAgentWork: () => allowed,
    });
    const expected = {
      phase: 'waiting-model',
      lastProgressAt: 1_000,
      stepGeneration: 7,
      effectBoundary: 'pre-effect',
    } satisfies AgentRuntimeProgress;
    const recoverLogicalInactivity = vi.fn(async () => 'retried' as const);
    (
      manager as unknown as { activeAgents: Map<string, unknown> }
    ).activeAgents.set('agent-1', { recoverLogicalInactivity });

    await expect(
      manager.recoverLogicalInactivity('agent-1', expected),
    ).resolves.toBe('ignored');
    expect(recoverLogicalInactivity).not.toHaveBeenCalled();

    allowed = true;
    await expect(
      manager.recoverLogicalInactivity('agent-1', expected),
    ).resolves.toBe('retried');
    expect(recoverLogicalInactivity).toHaveBeenCalledTimes(1);
    expect(recoverLogicalInactivity).toHaveBeenCalledWith(expected);
    await manager.teardown();
  });

  it('publishes exact runtime snapshots without reading durable store state', async () => {
    const { manager, store } = createManager({});
    const first = {
      phase: 'streaming-model',
      lastProgressAt: 2_000,
      stepGeneration: 3,
      effectBoundary: 'pre-effect',
    } satisfies AgentRuntimeProgress;
    const second = {
      phase: 'tool-running',
      lastProgressAt: 3_000,
      stepGeneration: 4,
      effectBoundary: 'uncertain',
    } satisfies AgentRuntimeProgress;
    const getFirst = vi.fn(() => ({ ...first }));
    const getSecond = vi.fn(() => ({ ...second }));
    const activeAgents = (
      manager as unknown as { activeAgents: Map<string, unknown> }
    ).activeAgents;
    activeAgents.set('agent-1', { getRuntimeProgress: getFirst });
    activeAgents.set('agent-2', { getRuntimeProgress: getSecond });
    store.get.mockClear();

    expect(manager.getActiveRuntimeProgress()).toEqual([
      { agentInstanceId: 'agent-1', progress: first },
      { agentInstanceId: 'agent-2', progress: second },
    ]);
    expect(getFirst).toHaveBeenCalledTimes(1);
    expect(getSecond).toHaveBeenCalledTimes(1);
    expect(store.get).not.toHaveBeenCalled();
    await manager.teardown();
  });

  it('ignores logical-inactivity observations for agents that are no longer live', async () => {
    const { manager } = createManager({});
    const expected = {
      phase: 'post-step',
      lastProgressAt: 4_000,
      stepGeneration: 5,
      effectBoundary: 'post-effect',
    } satisfies AgentRuntimeProgress;

    await expect(
      manager.recoverLogicalInactivity('deleted-agent', expected),
    ).resolves.toBe('ignored');
    await manager.teardown();
  });

  it('does not misclassify logical-inactivity errors as network retries', async () => {
    const isNetworkOnline = vi.fn(() => false);
    const { manager } = createManager({
      isNetworkOnline,
      storeState: {
        agents: {
          instances: {
            'agent-1': {
              state: {
                isWorking: false,
                history: [],
                error: {
                  message: 'Agent stopped after a logical-inactivity timeout.',
                  reasonCode: 'logical-inactivity',
                },
              },
            },
          },
        },
        toolbox: { 'agent-1': {} },
      },
    });
    const retryLastUserMessage = vi.fn(async () => undefined);
    (
      manager as unknown as { activeAgents: Map<string, unknown> }
    ).activeAgents.set('agent-1', { retryLastUserMessage });

    await manager.retryNetworkFailedAgentsNow('logical-inactivity');

    expect(isNetworkOnline).not.toHaveBeenCalled();
    expect(retryLastUserMessage).not.toHaveBeenCalled();
    await manager.teardown();
  });

  it('keeps automatic work enabled when the host omits the gate', async () => {
    const isNetworkOnline = vi.fn(() => true);
    const { manager } = createManager({
      isNetworkOnline,
      storeState: networkFailedStoreState,
    });
    seedNetworkFailedAgent(manager);

    await manager.retryNetworkFailedAgentsNow('default-open');

    expect(isNetworkOnline).toHaveBeenCalledTimes(1);
    await manager.teardown();
  });
});
