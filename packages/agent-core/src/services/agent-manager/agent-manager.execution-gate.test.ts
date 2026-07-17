import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTypeRegistry } from '../../agents/agents-registry';
import { CommandRegistry } from '../../commands/command-registry';
import { createTestAgentHost } from '../../host/test-utils';
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
