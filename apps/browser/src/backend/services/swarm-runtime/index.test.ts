import {
  AgentStore,
  AgentTypes,
  type AgentMessage,
  type AgentSystemState,
} from '@clodex/agent-core';
import type {
  AgentStepExecutionRequest,
  AgentStepExecution,
} from '@clodex/agent-core/agents';
import type { AppState } from '@shared/karton-contracts/ui';
import { defaultUserPreferences } from '@shared/karton-contracts/ui/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import { BrowserSwarmStore } from '../swarm-orchestrator';
import {
  buildAutomaticSwarmModelContext,
  createAdmittedSwarmStepHandler,
  createSwarmRuntime,
  createSwarmSubmitHandler,
  getAutomaticUltraSwarmPrompt,
  getSwarmErrorSearchText,
  isRetryableGeminiGatewayError,
  isUnavailableGatewayChannelError,
  type SwarmRuntimeDependencies,
} from './index';

type SwarmSubmitHandler = Parameters<
  SwarmRuntimeDependencies['agentManagerService']['setSwarmSubmitHandler']
>[0];

type UserSwarmMessage = Parameters<SwarmSubmitHandler>[1];

type AutomaticSwarmStepHandler = Parameters<
  SwarmRuntimeDependencies['agentManagerService']['setAutomaticSwarmStepHandler']
>[0];

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
            fileEditApprovalMode: 'manual',
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
  parts: UserSwarmMessage['parts'] = [],
): UserSwarmMessage {
  return {
    id: 'message-1',
    role: 'user',
    parts,
    metadata: {
      createdAt: new Date(0),
      partsMetadata: [],
      ...metadata,
    },
  } as UserSwarmMessage;
}

function createStepRequest(
  overrides: Partial<AgentStepExecutionRequest['options']> = {},
): AgentStepExecutionRequest {
  return {
    context: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      traceId: 'trace-1',
      requestedModelId: 'gpt-5.6-sol',
      resolvedModelId: 'gpt-5.6-sol',
      isApprovalContinuation: false,
      executionTarget: 'local',
      metadata: {},
    },
    options: {
      model: {} as AgentStepExecutionRequest['options']['model'],
      messages: [],
      ...overrides,
    },
  } as AgentStepExecutionRequest;
}

async function drainAutomaticExecution(
  execution: AgentStepExecution,
): Promise<number> {
  const uiStream = execution.toUIMessageStream();
  let chunks = 0;
  await Promise.all([
    (async () => {
      for await (const _chunk of uiStream) {
        chunks += 1;
      }
    })(),
    execution.consumeStream(),
  ]);
  return chunks;
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
  const preferences = structuredClone(defaultUserPreferences);
  const swarmState: Pick<AppState, 'swarmRuns' | 'preferences'> = {
    swarmRuns: {},
    preferences,
  };
  const uiKarton = {
    state: swarmState,
    setState: vi.fn(
      (recipe: (draft: Pick<AppState, 'swarmRuns' | 'preferences'>) => void) =>
        recipe(swarmState),
    ),
  } as unknown as KartonService;
  const agentStore = createAgentStore();
  let submitHandler: SwarmSubmitHandler | undefined;
  let automaticStepHandler: AutomaticSwarmStepHandler | undefined;
  const setSwarmSubmitHandler = vi.fn((handler: SwarmSubmitHandler) => {
    submitHandler = handler;
  });
  const setAutomaticSwarmStepHandler = vi.fn(
    (handler: AutomaticSwarmStepHandler) => {
      automaticStepHandler = handler;
    },
  );
  const getWorkspaceSnapshot = vi.fn<() => { mounts: any[] }>(() => ({
    mounts: [],
  }));
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
    preferences,
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
    agentManagerService: {
      setSwarmSubmitHandler,
      setAutomaticSwarmStepHandler,
    },
    assertLocalExecutionAllowed: vi.fn(),
  } as unknown as SwarmRuntimeDependencies;

  return {
    agentStore,
    dependencies,
    getLastChatWorkspacePaths,
    getLastNonEmptyChatWorkspacePaths,
    getRecentlyOpenedWorkspaces,
    getStoredAgentInstanceById,
    getWorkspaceSnapshot,
    getWithOptions,
    logger,
    selectModelForTask,
    setAutomaticSwarmStepHandler,
    setSwarmSubmitHandler,
    automaticStepHandler: () => automaticStepHandler,
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
    expect(harness.setAutomaticSwarmStepHandler).toHaveBeenCalledOnce();
    expect(harness.automaticStepHandler()).toEqual(expect.any(Function));
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
  it('never bypasses durable BaseAgent admission, including explicit Battle', async () => {
    const logger = { debug: vi.fn() };
    const handler = createSwarmSubmitHandler({ logger });
    const message = createUserMessage({
      swarmMode: true,
      swarmModeVariant: 'battle',
    });

    await expect(handler('agent-1', message)).resolves.toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      '[SwarmRun] pre-admission guard deferred to step executor',
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        swarmMode: true,
        swarmModeVariant: 'battle',
      }),
    );
  });
});

describe('automatic Ultra admitted-step routing', () => {
  const textMessage = createUserMessage({ swarmMode: false }, [
    { type: 'text', text: 'Implement safely' },
  ]);

  it('accepts one text-only admitted turn and rejects ambiguous or non-text context', () => {
    expect(getAutomaticUltraSwarmPrompt([textMessage])).toBe(
      'Implement safely',
    );
    expect(
      getAutomaticUltraSwarmPrompt([
        textMessage,
        createUserMessage({ swarmMode: false }, [
          { type: 'text', text: 'Second queued request' },
        ]),
      ]),
    ).toBeNull();
    expect(
      getAutomaticUltraSwarmPrompt([
        createUserMessage({ swarmMode: false }, [
          { type: 'text', text: 'Inspect this' },
          { type: 'file', mediaType: 'image/png', url: 'data:image/png,x' },
        ] as UserSwarmMessage['parts']),
      ]),
    ).toBeNull();
    expect(
      getAutomaticUltraSwarmPrompt([
        createUserMessage(
          {
            swarmMode: false,
            attachments: [{ path: 'att/context.textclip' }],
          },
          [{ type: 'text', text: 'Use the attachment' }],
        ),
      ]),
    ).toBeNull();
    expect(
      getAutomaticUltraSwarmPrompt([
        createUserMessage(
          {
            swarmMode: false,
            envState: {
              shell: {
                schemaVersion: 1,
                state: {},
                renderedState:
                  '<environment_context>cwd=/repo</environment_context>',
                renderedStateChange: '',
              },
            },
          },
          [{ type: 'text', text: 'Use current shell context' }],
        ),
      ]),
    ).toBe(
      'Use current shell context\n\n<environment_context>cwd=/repo</environment_context>',
    );
  });

  it('returns a synthetic execution only for effective Ultra and never calls the normal runner itself', async () => {
    const onFinish = vi.fn();
    const onError = vi.fn();
    const runSwarmWorkflow = vi.fn(async () => 'run-id');
    const extractSwarmPromptFromMessage = vi.fn(async () => 'manual prompt');
    const getModelThinkingSubmitContext = vi.fn(() => ({
      modelId: 'gpt-5.6-sol',
      override: {
        enabled: true,
        provider: 'clodex' as const,
        value: 'ultra',
      },
      providerMode: 'clodex' as const,
    }));
    const handler = createAdmittedSwarmStepHandler({
      getAgentHistory: () => [textMessage],
      getModelThinkingSubmitContext,
      extractSwarmPromptFromMessage,
      runSwarmWorkflow,
      logger: { debug: vi.fn() },
    });
    const request = createStepRequest({ onFinish, onError });

    const execution = await handler(request);
    expect(execution).not.toBeNull();
    expect(execution?.modelRouteBinding).toBe('external');
    expect(runSwarmWorkflow).not.toHaveBeenCalled();
    await expect(drainAutomaticExecution(execution!)).resolves.toBe(0);

    expect(runSwarmWorkflow).toHaveBeenCalledWith(
      'agent-1',
      'Implement safely',
      'standard',
      {
        appendUserMessage: false,
        rethrowFailure: true,
        abortSignal: undefined,
        forceSwarmOnDirect: true,
      },
    );
    expect(extractSwarmPromptFromMessage).not.toHaveBeenCalled();
    expect(getModelThinkingSubmitContext).toHaveBeenCalledWith(
      request.context.requestedModelId,
    );
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves prior conversation and resolved slash-command context for automatic Ultra', async () => {
    const modelMessages = [
      {
        role: 'system',
        content: 'Evidence memory: the accepted target is src/worker.ts.',
      },
      {
        role: 'assistant',
        content: 'The active plan changes src/worker.ts and its tests.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<slash-command id="implement">Implement the active plan now.</slash-command>',
          },
        ],
      },
    ] as NonNullable<AgentStepExecutionRequest['options']['messages']>;
    const context = buildAutomaticSwarmModelContext(modelMessages);
    expect(context).toContain('Evidence memory');
    expect(context).toContain('src/worker.ts and its tests');
    expect(context).toContain('Implement the active plan now.');

    const rawImplementMessage = createUserMessage({ swarmMode: false }, [
      {
        type: 'text',
        text: '[/implement](slash:command:implement)',
      },
    ]);
    const runSwarmWorkflow = vi.fn(
      async (
        _agentInstanceId: string,
        _prompt: string,
        _mode: 'standard' | 'battle',
        _options: unknown,
      ) => 'run-id',
    );
    const handler = createAdmittedSwarmStepHandler({
      getAgentHistory: () => [rawImplementMessage],
      getModelThinkingSubmitContext: () => ({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
      }),
      extractSwarmPromptFromMessage: vi.fn(async () => 'manual prompt'),
      runSwarmWorkflow,
      logger: { debug: vi.fn() },
    });

    const execution = await handler(
      createStepRequest({ messages: modelMessages }),
    );
    expect(execution).not.toBeNull();
    await drainAutomaticExecution(execution!);
    expect(runSwarmWorkflow).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('Implement the active plan now.'),
      'standard',
      expect.objectContaining({ appendUserMessage: false }),
    );
    expect(runSwarmWorkflow.mock.calls[0]?.[1]).toContain(
      'src/worker.ts and its tests',
    );
  });

  it('fails closed for every unsupported converted message part', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Do not silently drop the next part.' },
          { type: 'future-provider-part', payload: 'unsupported' },
        ],
      },
    ] as unknown as NonNullable<
      AgentStepExecutionRequest['options']['messages']
    >;

    expect(buildAutomaticSwarmModelContext(messages)).toBeNull();
  });

  it('preserves text-only tool results and rejects nested media, URLs, and non-text output', () => {
    const buildToolResultContext = (output: unknown) =>
      buildAutomaticSwarmModelContext([
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'inspect',
              output,
            },
          ],
        },
        { role: 'user', content: 'Continue from the tool result.' },
      ] as unknown as NonNullable<
        AgentStepExecutionRequest['options']['messages']
      >);

    const exactText = '  first line\nsecond line  ';
    expect(
      buildToolResultContext({
        type: 'content',
        value: [{ type: 'text', text: exactText }],
      }),
    ).toContain(`[tool-result inspect] ${exactText}`);

    for (const output of [
      {
        type: 'content',
        value: [{ type: 'image-data', data: 'base64', mediaType: 'image/png' }],
      },
      {
        type: 'content',
        value: [{ type: 'file-data', data: 'base64', mediaType: 'text/plain' }],
      },
      {
        type: 'content',
        value: [{ type: 'image-url', url: 'https://example.test/image.png' }],
      },
      {
        type: 'content',
        value: [{ type: 'file-url', url: 'https://example.test/file.txt' }],
      },
      { type: 'json', value: { result: 'not a textual variant' } },
    ]) {
      expect(buildToolResultContext(output)).toBeNull();
    }
  });

  it('preserves 9-16k current requests exactly and declines larger automatic context', () => {
    const supportedRequest = `begin-${'x'.repeat(9_000)}-end`;
    const supportedContext = buildAutomaticSwarmModelContext([
      { role: 'user', content: supportedRequest },
    ]);
    expect(supportedContext).toContain(supportedRequest);

    const oversizedRequest = 'x'.repeat(16_001);
    expect(
      buildAutomaticSwarmModelContext([
        { role: 'user', content: oversizedRequest },
      ]),
    ).toBeNull();
  });

  it('falls back to the normal admitted step when context cannot be preserved', async () => {
    const runSwarmWorkflow = vi.fn(async () => 'run-id');
    const handler = createAdmittedSwarmStepHandler({
      getAgentHistory: () => [
        createUserMessage(
          { swarmMode: false, mentions: [{ providerType: 'tab' }] },
          [{ type: 'text', text: 'Read the mentioned tab' }],
        ),
      ],
      getModelThinkingSubmitContext: () => ({
        modelId: 'gpt-5.6-terra',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode: 'official',
      }),
      extractSwarmPromptFromMessage: vi.fn(async () => 'manual prompt'),
      runSwarmWorkflow,
      logger: { debug: vi.fn() },
    });

    await expect(handler(createStepRequest())).resolves.toBeNull();
    expect(runSwarmWorkflow).not.toHaveBeenCalled();
  });

  it('delegates automatic Ultra when no workspace is mounted', async () => {
    const runSwarmWorkflow = vi.fn(async () => 'run-id');
    const handler = createAdmittedSwarmStepHandler({
      getAgentHistory: () => [textMessage],
      getModelThinkingSubmitContext: () => ({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
      }),
      hasWorkspaceMounts: () => false,
      extractSwarmPromptFromMessage: vi.fn(async () => 'manual prompt'),
      runSwarmWorkflow,
      logger: { debug: vi.fn() },
    });

    await expect(handler(createStepRequest())).resolves.toBeNull();
    expect(runSwarmWorkflow).not.toHaveBeenCalled();
  });

  it('delegates when a text follow-up depends on prior multimodal context', () => {
    expect(
      buildAutomaticSwarmModelContext([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Remember this screenshot.' },
            {
              type: 'image',
              image: new Uint8Array([1, 2, 3]),
              mediaType: 'image/png',
            },
          ],
        },
        { role: 'assistant', content: 'I can see it.' },
        { role: 'user', content: 'What is on that screenshot?' },
      ]),
    ).toBeNull();
  });

  it('routes explicit Battle after admission and keeps it above Ultra', async () => {
    const battleMessage = createUserMessage(
      { swarmMode: true, swarmModeVariant: 'battle' },
      [{ type: 'text', text: 'Debate this plan' }],
    );
    const extractSwarmPromptFromMessage = vi.fn(
      async () => 'Battle prompt with explicit context',
    );
    const runSwarmWorkflow = vi.fn(async () => 'run-id');
    const handler = createAdmittedSwarmStepHandler({
      getAgentHistory: () => [battleMessage],
      getModelThinkingSubmitContext: () => ({
        modelId: 'gpt-5.6-terra',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode: 'official',
      }),
      extractSwarmPromptFromMessage,
      runSwarmWorkflow,
      logger: { debug: vi.fn() },
    });

    const execution = await handler(createStepRequest());
    expect(execution).not.toBeNull();
    await expect(drainAutomaticExecution(execution!)).resolves.toBe(0);
    expect(extractSwarmPromptFromMessage).toHaveBeenCalledWith(
      'agent-1',
      battleMessage,
    );
    expect(runSwarmWorkflow).toHaveBeenCalledWith(
      'agent-1',
      'Battle prompt with explicit context',
      'battle',
      {
        appendUserMessage: false,
        rethrowFailure: true,
        abortSignal: undefined,
        forceSwarmOnDirect: false,
      },
    );
  });

  it('keeps Ultra context and forced standard Swarm above a manual-standard flag', async () => {
    const manualStandardMessage = createUserMessage(
      { swarmMode: true, swarmModeVariant: 'standard' },
      [{ type: 'text', text: 'Implement from the current plan' }],
    );
    const runSwarmWorkflow = vi.fn(async () => 'run-id');
    const extractSwarmPromptFromMessage = vi.fn(async () => 'legacy prompt');
    const handler = createAdmittedSwarmStepHandler({
      getAgentHistory: () => [manualStandardMessage],
      getModelThinkingSubmitContext: () => ({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
      }),
      extractSwarmPromptFromMessage,
      runSwarmWorkflow,
      logger: { debug: vi.fn() },
    });

    const execution = await handler(createStepRequest());
    expect(execution).not.toBeNull();
    await drainAutomaticExecution(execution!);
    expect(extractSwarmPromptFromMessage).not.toHaveBeenCalled();
    expect(runSwarmWorkflow).toHaveBeenCalledWith(
      'agent-1',
      'Implement from the current plan',
      'standard',
      expect.objectContaining({ forceSwarmOnDirect: true }),
    );
  });

  it('does not duplicate the already-admitted user message in AgentStore', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const instance =
      harness.agentStore.get().agents.instances['agent-1']?.state;
    if (!instance) throw new Error('Missing test agent');
    instance.activeModelId = 'gpt-5.6-sol';
    instance.history.push(textMessage);
    harness.getWorkspaceSnapshot.mockReturnValue({
      mounts: [
        { prefix: 'repo', path: '/repo', permissions: ['read', 'write'] },
      ],
    });
    harness.swarmState.preferences.agent.modelThinkingOverrides['gpt-5.6-sol'] =
      { enabled: true, provider: 'clodex', value: 'ultra' };
    createSwarmRuntime(harness.dependencies);

    const onFinish = vi.fn();
    const onError = vi.fn();
    const execution = await harness.automaticStepHandler()?.(
      createStepRequest({ onFinish, onError }),
    );
    expect(execution).not.toBeNull();
    const drainPromise = drainAutomaticExecution(execution!);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(drainPromise).resolves.toBe(1);

    const history =
      harness.agentStore.get().agents.instances['agent-1']?.state.history ?? [];
    expect(history.filter((message) => message.role === 'user')).toHaveLength(
      1,
    );
    expect(history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(getText(history[1]!)).toContain('Swarm workflow failed.');
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('aborts an admitted Swarm without appending a post-stop assistant message', async () => {
    const harness = createHarness();
    const instance =
      harness.agentStore.get().agents.instances['agent-1']?.state;
    if (!instance) throw new Error('Missing test agent');
    instance.activeModelId = 'gpt-5.6-sol';
    instance.history.push(textMessage);
    harness.getWorkspaceSnapshot.mockReturnValue({
      mounts: [
        { prefix: 'repo', path: '/repo', permissions: ['read', 'write'] },
      ],
    });
    harness.swarmState.preferences.agent.modelThinkingOverrides['gpt-5.6-sol'] =
      { enabled: true, provider: 'clodex', value: 'ultra' };
    createSwarmRuntime(harness.dependencies);

    const abortController = new AbortController();
    const onAbort = vi.fn();
    const onFinish = vi.fn();
    const onError = vi.fn();
    const execution = await harness.automaticStepHandler()?.(
      createStepRequest({
        abortSignal: abortController.signal,
        onAbort,
        onFinish,
        onError,
      }),
    );
    expect(execution).not.toBeNull();
    const drainPromise = drainAutomaticExecution(execution!);
    abortController.abort();
    await expect(drainPromise).resolves.toBe(0);

    const history =
      harness.agentStore.get().agents.instances['agent-1']?.state.history ?? [];
    expect(history.map((message) => message.role)).toEqual(['user']);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
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
