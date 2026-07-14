import {
  AgentStore,
  AgentTypes,
  type AgentMessage,
  type AgentSystemState,
} from '@clodex/agent-core';
import type { AppState } from '@shared/karton-contracts/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import { BrowserSwarmStore } from '../swarm-orchestrator';
import {
  createSwarmRuntime,
  createSwarmSubmitHandler,
  getSwarmErrorSearchText,
  isRetryableGeminiGatewayError,
  isUnavailableGatewayChannelError,
  type SwarmRuntimeDependencies,
} from './index';

type SwarmSubmitHandler = Parameters<
  SwarmRuntimeDependencies['agentManagerService']['setSwarmSubmitHandler']
>[0];

type UserSwarmMessage = Parameters<SwarmSubmitHandler>[1];

function createAgentStore(): AgentStore {
  const initialState: AgentSystemState = {
    agents: {
      instances: {
        'agent-1': {
          type: AgentTypes.CHAT,
          canSelectModel: true,
          requiredModelCapabilities: {},
          allowUserInput: true,
          parentAgentInstanceId: null,
          state: {
            title: 'Swarm test agent',
            isWorking: false,
            history: [],
            queuedMessages: [],
            activeModelId: 'model-a',
            toolApprovalMode: 'alwaysAsk',
            pendingApprovals: {},
            inputState: '',
            usedTokens: 0,
          },
        },
      },
    },
    toolbox: {},
  };
  return new AgentStore(initialState);
}

function createUserMessage(
  metadata: Record<string, unknown>,
): UserSwarmMessage {
  return {
    id: 'message-1',
    role: 'user',
    parts: [],
    metadata: {
      createdAt: new Date(0),
      partsMetadata: [],
      ...metadata,
    },
  } as UserSwarmMessage;
}

function getText(message: AgentMessage): string {
  return message.parts
    .filter(
      (part): part is { type: 'text'; text: string } => part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

function createHarness() {
  const swarmState: Pick<AppState, 'swarmRuns'> = { swarmRuns: {} };
  const uiKarton = {
    setState: vi.fn((recipe: (draft: Pick<AppState, 'swarmRuns'>) => void) =>
      recipe(swarmState),
    ),
  } as unknown as KartonService;
  const agentStore = createAgentStore();
  let submitHandler: SwarmSubmitHandler | undefined;
  const setSwarmSubmitHandler = vi.fn((handler: SwarmSubmitHandler) => {
    submitHandler = handler;
  });
  const getWorkspaceSnapshot = vi.fn(() => ({ mounts: [] }));
  const getAllMountedPaths = vi.fn(() => new Set<string>());
  const getTool = vi.fn(async () => null);
  const resolveNewAgentMountPath = vi.fn(
    async (workspacePath: string) => workspacePath,
  );
  const handleMountWorkspace = vi.fn(async () => undefined);
  const getStoredAgentInstanceById = vi.fn(async () => null);
  const getLastNonEmptyChatWorkspacePaths = vi.fn(async () => null);
  const getLastChatWorkspacePaths = vi.fn(async () => null);
  const getRecentlyOpenedWorkspaces = vi.fn(async () => []);
  const selectModelForTask = vi.fn();
  const getWithOptions = vi.fn(async () => {
    throw new Error('model resolution should not run in this test');
  });
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const dependencies = {
    uiKarton,
    agentStore,
    models: { selectModelForTask, getWithOptions },
    attachments: { read: vi.fn() },
    logger,
    toolboxService: {
      getWorkspaceSnapshot,
      getAllMountedPaths,
      getTool,
      resolveNewAgentMountPath,
      handleMountWorkspace,
    },
    agentDb: {
      getStoredAgentInstanceById,
      getLastNonEmptyChatWorkspacePaths,
      getLastChatWorkspacePaths,
    },
    userExperienceService: { getRecentlyOpenedWorkspaces },
    pendingEditService: { releaseLocksForOwner: vi.fn() },
    agentManagerService: { setSwarmSubmitHandler },
    assertLocalExecutionAllowed: vi.fn(),
  } as unknown as SwarmRuntimeDependencies;

  return {
    agentStore,
    dependencies,
    getLastChatWorkspacePaths,
    getLastNonEmptyChatWorkspacePaths,
    getRecentlyOpenedWorkspaces,
    getStoredAgentInstanceById,
    getWithOptions,
    logger,
    selectModelForTask,
    setSwarmSubmitHandler,
    submitHandler: () => submitHandler,
    swarmState,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSwarmRuntime', () => {
  it('registers the submit handler and returns the exact runtime contract', () => {
    const harness = createHarness();

    const runtime = createSwarmRuntime(harness.dependencies);

    expect(Object.keys(runtime)).toEqual([
      'browserSwarmStore',
      'runSwarmWorkflow',
      'runForcedSwarmPreview',
    ]);
    expect(runtime.browserSwarmStore).toBeInstanceOf(BrowserSwarmStore);
    expect(runtime.runSwarmWorkflow).toEqual(expect.any(Function));
    expect(runtime.runForcedSwarmPreview).toEqual(expect.any(Function));
    expect(harness.setSwarmSubmitHandler).toHaveBeenCalledOnce();
    expect(harness.submitHandler()).toEqual(expect.any(Function));
  });

  it('runs the forced high-complexity preview through the browser swarm store', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const runtime = createSwarmRuntime(harness.dependencies);

    const previewPromise = runtime.runForcedSwarmPreview(
      'agent-1',
      'Preview target',
    );
    await vi.runAllTimersAsync();
    const runId = await previewPromise;

    const run = harness.swarmState.swarmRuns[runId];
    expect(run).toMatchObject({
      id: runId,
      agentInstanceId: 'agent-1',
      description: 'Swarm workflow for: Preview target',
      taskComplexity: 'high',
      status: 'completed',
    });
    expect(run?.phases).toHaveLength(5);
    const tasks = run?.phases.flatMap((phase) => phase.tasks) ?? [];
    expect(tasks).toHaveLength(8);
    for (const task of tasks) {
      expect(task).toMatchObject({
        status: 'completed',
        metrics: { tokens: 120, toolsUsed: 1 },
        output: `${task.name} completed preview for: ${task.prompt}`,
      });
    }
  });

  it('appends the user and localized failure message before returning no-workspace', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const runtime = createSwarmRuntime(harness.dependencies);

    const runPromise = runtime.runSwarmWorkflow('agent-1', 'Implement it');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(runPromise).resolves.toBe('no-workspace');
    const history =
      harness.agentStore.get().agents.instances['agent-1']?.state.history ?? [];
    expect(history.map((message) => [message.role, getText(message)])).toEqual([
      ['user', 'Implement it'],
      [
        'assistant',
        [
          'I did not start the Swarm because no workspace folder is mounted for this agent yet.',
          '',
          'I waited for workspace mounts before launching workers, but the mount manager still returned an empty list. Connect or reconnect the project folder and try again.',
        ].join('\n'),
      ],
    ]);
    expect(harness.selectModelForTask).not.toHaveBeenCalled();
    expect(harness.getWithOptions).not.toHaveBeenCalled();
  });
});

describe('createSwarmSubmitHandler', () => {
  it('forwards battle mode and applies the exact default prompt in standard mode', async () => {
    const extractSwarmPromptFromMessage = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Battle task');
    const runSwarmWorkflow = vi.fn(async () => 'run-id');
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
    };
    const handler = createSwarmSubmitHandler({
      extractSwarmPromptFromMessage,
      runSwarmWorkflow,
      logger,
    });

    await expect(
      handler('agent-1', createUserMessage({ swarmMode: true })),
    ).resolves.toBe(true);
    await expect(
      handler(
        'agent-1',
        createUserMessage({
          swarmMode: true,
          swarmModeVariant: 'battle',
        }),
      ),
    ).resolves.toBe(true);

    expect(runSwarmWorkflow).toHaveBeenNthCalledWith(
      1,
      'agent-1',
      'Run Dynamic Swarm.',
      'standard',
    );
    expect(runSwarmWorkflow).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      'Battle task',
      'battle',
    );
  });

  it('keeps workflow failures in the background and preserves the non-swarm guard', async () => {
    const error = new Error('background failure');
    const runSwarmWorkflow = vi.fn(async () => {
      throw error;
    });
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
    };
    const handler = createSwarmSubmitHandler({
      extractSwarmPromptFromMessage: vi.fn(async () => 'Task'),
      runSwarmWorkflow,
      logger,
    });

    await expect(
      handler('agent-1', createUserMessage({ swarmMode: true })),
    ).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        '[SwarmRun] Background workflow failed',
        { agentInstanceId: 'agent-1', error },
      );
    });

    await expect(
      handler('agent-1', createUserMessage({ swarmMode: false })),
    ).resolves.toBe(false);
    expect(runSwarmWorkflow).toHaveBeenCalledOnce();
  });
});

describe('swarm gateway error classifiers', () => {
  it('searches nested and cyclic errors without losing retry classification', () => {
    const unavailable = new Error('outer') as Error & {
      cause?: unknown;
    };
    unavailable.cause = {
      responseBody: { error: 'No available channel for this route' },
    };
    expect(getSwarmErrorSearchText(unavailable)).toContain(
      'No available channel for this route',
    );
    expect(isUnavailableGatewayChannelError(unavailable)).toBe(true);
    expect(isRetryableGeminiGatewayError(unavailable, 'gemini-3.5-flash')).toBe(
      true,
    );
    expect(isRetryableGeminiGatewayError(unavailable, 'gpt-5.5')).toBe(false);

    expect(
      isRetryableGeminiGatewayError(
        { data: { error: 'openai_error: upstream closed' } },
        'gemini-3.5-flash',
      ),
    ).toBe(true);
    expect(
      isRetryableGeminiGatewayError(
        { body: 'empty visible response' },
        'gemini-3.5-flash',
      ),
    ).toBe(true);
    expect(
      isRetryableGeminiGatewayError(
        { body: 'ordinary provider failure' },
        'gemini-3.5-flash',
      ),
    ).toBe(false);

    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(() => getSwarmErrorSearchText(cyclic)).not.toThrow();
  });
});
