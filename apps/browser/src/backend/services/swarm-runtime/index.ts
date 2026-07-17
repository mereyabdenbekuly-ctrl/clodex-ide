import {
  DynamicSwarmOrchestrator,
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
  type PendingEditService,
  SwarmRunner,
  createBattleSwarmPlan,
  createFallbackSwarmPlan,
  updateAgentInstanceState,
  type AgentMessage,
  type AgentStore,
  type HostModels,
  type ModelTaskRole,
  type SwarmTaskRole,
} from '@clodex/agent-core';
import type { AttachmentsService } from '@clodex/agent-core/attachments';
import type {
  AgentStepExecution,
  AgentStepExecutionRequest,
} from '@clodex/agent-core/agents';
import {
  generateText,
  stepCountIs,
  type AsyncIterableStream,
  type InferUIMessageChunk,
  type ModelMessage,
  type StepResult,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamOptions,
} from 'ai';
import type { AgentManagerService } from '../agent-manager';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import { BrowserSwarmStore } from '../swarm-orchestrator';
import type { ToolboxService } from '../toolbox';
import {
  getActiveGptThinkingProviderMode,
  getModelThinkingOverride,
  getThinkingOverrideModelId,
  resolveSubmitSwarmRoute,
} from '@shared/model-effort-routing';
import type {
  ModelThinkingOverride,
  ProviderEndpointMode,
} from '@shared/karton-contracts/ui/shared-types';

export type SwarmRunMode = 'standard' | 'battle';

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';

const createAbortError = (signal?: AbortSignal): Error => {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Swarm execution was aborted',
    reason instanceof Error ? { cause: reason } : undefined,
  );
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createAbortError(signal);
};

export interface SwarmRuntimeDependencies {
  uiKarton: KartonService;
  agentStore: AgentStore;
  models: Pick<HostModels, 'getWithOptions' | 'selectModelForTask'>;
  attachments: Pick<AttachmentsService, 'read'>;
  logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
  toolboxService: Pick<ToolboxService, 'getTool' | 'getWorkspaceSnapshot'>;
  pendingEditService: PendingEditService;
  agentManagerService: Pick<
    AgentManagerService,
    'setSwarmSubmitHandler' | 'setAutomaticSwarmStepHandler'
  >;
  assertLocalExecutionAllowed?: (agentInstanceId: string) => void;
}

export interface SwarmRuntime {
  browserSwarmStore: BrowserSwarmStore;
  runSwarmWorkflow: (
    agentInstanceId: string,
    prompt: string,
    mode?: SwarmRunMode,
  ) => Promise<string>;
  runForcedSwarmPreview: (
    agentInstanceId: string,
    prompt: string,
  ) => Promise<string>;
}

const stringifyErrorPart = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const getSwarmErrorSearchText = (
  error: unknown,
  seen = new WeakSet<object>(),
): string => {
  if (error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  if (seen.has(error)) return '';
  seen.add(error);

  const record = error as Record<string, unknown>;
  const parts = [
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : undefined,
    record.message,
    record.statusText,
    record.responseBody,
    record.body,
    record.data,
    record.error,
    record.errors,
    record.cause,
  ];

  return parts
    .flatMap((part) => [
      stringifyErrorPart(part),
      getSwarmErrorSearchText(part, seen),
    ])
    .filter(Boolean)
    .join('\n');
};

export const isUnavailableGatewayChannelError = (error: unknown): boolean =>
  /no available channel/i.test(getSwarmErrorSearchText(error));

export const isRetryableGeminiGatewayError = (
  error: unknown,
  preferredModelId: string | undefined,
): boolean => {
  if (!preferredModelId?.startsWith('gemini-')) return false;
  const errorSearchText = getSwarmErrorSearchText(error);
  return (
    /no available channel/i.test(errorSearchText) ||
    /openai[_-]?error/i.test(errorSearchText) ||
    /empty visible response/i.test(errorSearchText)
  );
};

type SwarmSubmitHandler = Parameters<
  AgentManagerService['setSwarmSubmitHandler']
>[0];

type AutomaticSwarmStepHandler = Parameters<
  AgentManagerService['setAutomaticSwarmStepHandler']
>[0];

type ModelThinkingSubmitContext = {
  modelId: string | null;
  override: ModelThinkingOverride | undefined;
  providerMode: ProviderEndpointMode | undefined;
};

export function createSwarmSubmitHandler({
  logger,
}: {
  logger: Pick<Logger, 'debug'>;
}): SwarmSubmitHandler {
  return async (agentInstanceId, message) => {
    const metadata = message.metadata as AgentMessage['metadata'] & {
      swarmMode?: boolean;
      swarmModeVariant?: 'standard' | 'battle';
    };
    logger.debug('[SwarmRun] pre-admission guard deferred to step executor', {
      agentInstanceId,
      swarmMode: metadata?.swarmMode,
      swarmModeVariant: metadata?.swarmModeVariant,
      executionTarget: metadata?.executionTarget,
    });
    return false;
  };
}

const SAFE_AUTOMATIC_SWARM_METADATA_KEYS = new Set([
  'createdAt',
  'partsMetadata',
  'swarmMode',
  'swarmModeVariant',
  'executionTarget',
  'attachments',
  'textClipAttachments',
  'mentions',
  'pathReferences',
  'envState',
]);

const AUTOMATIC_SWARM_CURRENT_REQUEST_MAX_CHARS = 16_000;
const AUTOMATIC_SWARM_RECENT_CONTEXT_MAX_CHARS = 32_000;
const AUTOMATIC_SWARM_SYSTEM_CONTEXT_MAX_CHARS = 8_000;
const AUTOMATIC_SWARM_MESSAGE_MAX_CHARS = 8_000;

const hasArrayValues = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

function truncateAutomaticSwarmContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLength = Math.floor(maxChars * 0.6);
  const tailLength = Math.max(0, maxChars - headLength - 36);
  return `${text.slice(0, headLength)}\n...[context truncated]...\n${text.slice(-tailLength)}`;
}

function stringifyAutomaticSwarmValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

function renderAutomaticSwarmToolResultOutput(output: unknown): string | null {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return null;
  }

  const record = output as Record<string, unknown>;
  if (
    (record.type === 'text' || record.type === 'error-text') &&
    typeof record.value === 'string'
  ) {
    return record.value;
  }
  if (record.type !== 'content' || !Array.isArray(record.value)) return null;

  const textParts: string[] = [];
  for (const part of record.value) {
    if (
      typeof part !== 'object' ||
      part === null ||
      Array.isArray(part) ||
      (part as Record<string, unknown>).type !== 'text' ||
      typeof (part as Record<string, unknown>).text !== 'string'
    ) {
      return null;
    }
    textParts.push((part as { text: string }).text);
  }
  return textParts.join('\n\n');
}

function renderAutomaticSwarmModelContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const sections: string[] = [];
  for (const part of content) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      return null;
    }
    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'text' && typeof record.text === 'string') {
      sections.push(record.text);
      continue;
    }
    // Provider reasoning/signature payloads are intentionally not replayed
    // into Swarm prompts.
    if (type === 'reasoning' || type === 'redacted-reasoning') continue;
    if (type === 'tool-call') {
      const toolName =
        typeof record.toolName === 'string' ? record.toolName : 'unknown';
      const input = stringifyAutomaticSwarmValue(record.input);
      if (input === null) return null;
      sections.push(`[tool-call ${toolName}] ${input}`);
      continue;
    }
    if (type === 'tool-result') {
      const toolName =
        typeof record.toolName === 'string' ? record.toolName : 'unknown';
      const output = renderAutomaticSwarmToolResultOutput(record.output);
      if (output === null) return null;
      sections.push(`[tool-result ${toolName}] ${output}`);
      continue;
    }
    return null;
  }
  return sections.join('\n\n');
}

/**
 * Serializes the already-converted model context so automatic Ultra keeps
 * prior-turn references, resolved slash commands, environment rendering and
 * bounded tool results without replaying private reasoning payloads.
 */
export function buildAutomaticSwarmModelContext(
  messages: ReadonlyArray<ModelMessage>,
): string | null {
  const rendered: Array<{ role: ModelMessage['role']; text: string }> = [];
  for (const message of messages) {
    const text = renderAutomaticSwarmModelContent(message.content);
    if (text === null) return null;
    if (text.length > 0) {
      rendered.push({
        role: message.role,
        text,
      });
    }
  }
  let currentIndex = -1;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    if (rendered[index]?.role === 'user') {
      currentIndex = index;
      break;
    }
  }
  if (currentIndex < 0) return null;

  const currentRequest = rendered[currentIndex]!.text;
  if (currentRequest.length > AUTOMATIC_SWARM_CURRENT_REQUEST_MAX_CHARS) {
    return null;
  }
  const systemContext = truncateAutomaticSwarmContext(
    rendered
      .filter((message) => message.role === 'system')
      .map((message) => message.text)
      .join('\n\n'),
    AUTOMATIC_SWARM_SYSTEM_CONTEXT_MAX_CHARS,
  );

  const recentBlocks: string[] = [];
  let recentChars = 0;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const message = rendered[index]!;
    if (message.role === 'system') continue;
    const block = `[${message.role}]\n${truncateAutomaticSwarmContext(
      message.text,
      AUTOMATIC_SWARM_MESSAGE_MAX_CHARS,
    )}`;
    if (recentChars + block.length > AUTOMATIC_SWARM_RECENT_CONTEXT_MAX_CHARS) {
      break;
    }
    recentBlocks.unshift(block);
    recentChars += block.length;
  }

  return [
    systemContext
      ? `<system-context>\n${systemContext}\n</system-context>`
      : '',
    recentBlocks.length > 0
      ? `<conversation-context>\n${recentBlocks.join('\n\n')}\n</conversation-context>`
      : '',
    `<current-request>\n${currentRequest}\n</current-request>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function getRenderedAutomaticSwarmEnvContext(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const sections: string[] = [];
  for (const entry of Object.values(value)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { renderedState?: unknown }).renderedState !== 'string'
    ) {
      return null;
    }
    const renderedState = (
      entry as { renderedState: string }
    ).renderedState.trim();
    if (renderedState) sections.push(renderedState);
  }
  return sections.join('\n\n');
}

/**
 * Automatic Ultra may only replace a normal step when every bit of the
 * admitted user turn can be represented by the Swarm string prompt. Manual
 * Swarm keeps its existing, explicit behavior.
 */
export function getAutomaticUltraSwarmPrompt(
  history: ReadonlyArray<AgentMessage>,
): string | null {
  const message = history.at(-1);
  if (!message || message.role !== 'user') return null;
  if (history.length > 1 && history.at(-2)?.role !== 'assistant') return null;

  const metadata = message.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  if (
    metadata.executionTarget === 'cloud' ||
    (metadata.swarmMode === true && metadata.swarmModeVariant === 'battle')
  ) {
    return null;
  }
  if (
    hasArrayValues(metadata.attachments) ||
    hasArrayValues(metadata.textClipAttachments) ||
    hasArrayValues(metadata.mentions) ||
    (typeof metadata.pathReferences === 'object' &&
      metadata.pathReferences !== null &&
      Object.keys(metadata.pathReferences).length > 0)
  ) {
    return null;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_AUTOMATIC_SWARM_METADATA_KEYS.has(key) && value !== undefined) {
      return null;
    }
  }

  const textParts: string[] = [];
  for (const part of message.parts) {
    if (
      part.type !== 'text' ||
      typeof (part as { text?: unknown }).text !== 'string'
    ) {
      return null;
    }
    const text = (part as { text: string }).text.trim();
    if (text) textParts.push(text);
  }
  if (textParts.length === 0) return null;

  const envContext = getRenderedAutomaticSwarmEnvContext(metadata.envState);
  if (envContext === null) return null;
  return [...textParts, envContext].filter(Boolean).join('\n\n');
}

function getSingleTrailingUserMessage(
  history: ReadonlyArray<AgentMessage>,
): (AgentMessage & { role: 'user' }) | null {
  const message = history.at(-1);
  if (!message || message.role !== 'user') return null;
  if (history.length > 1 && history.at(-2)?.role !== 'assistant') return null;
  return message as AgentMessage & { role: 'user' };
}

type AdmittedSwarmWorkflowRunner = (
  agentInstanceId: string,
  prompt: string,
  mode: SwarmRunMode,
  options: {
    appendUserMessage: false;
    rethrowFailure: true;
    abortSignal: AbortSignal | undefined;
    forceSwarmOnDirect: boolean;
  },
) => Promise<string>;

export function createAdmittedSwarmStepHandler({
  getAgentHistory,
  getModelThinkingSubmitContext,
  hasWorkspaceMounts = () => true,
  extractSwarmPromptFromMessage,
  runSwarmWorkflow,
  logger,
}: {
  getAgentHistory: (agentInstanceId: string) => ReadonlyArray<AgentMessage>;
  getModelThinkingSubmitContext: (
    requestedModelId: string,
  ) => ModelThinkingSubmitContext;
  hasWorkspaceMounts?: (agentInstanceId: string) => boolean;
  extractSwarmPromptFromMessage: (
    agentInstanceId: string,
    message: AgentMessage & { role: 'user' },
  ) => Promise<string>;
  runSwarmWorkflow: AdmittedSwarmWorkflowRunner;
  logger: Pick<Logger, 'debug'>;
}): AutomaticSwarmStepHandler {
  return async (request) => {
    const { agentInstanceId, executionTarget } = request.context;
    if (executionTarget === 'cloud') return null;

    const history = getAgentHistory(agentInstanceId);
    const message = getSingleTrailingUserMessage(history);
    if (!message) return null;
    const metadata = message.metadata as AgentMessage['metadata'] & {
      swarmMode?: boolean;
      swarmModeVariant?: 'standard' | 'battle';
    };
    const manualModeActive = metadata?.swarmMode === true;
    const admittedRoute = resolveSubmitSwarmRoute({
      ...getModelThinkingSubmitContext(request.context.requestedModelId),
      manualModeActive,
      manualModeVariant: metadata?.swarmModeVariant ?? null,
      executionTarget,
    });
    if (!admittedRoute.enabled) return null;

    // Ultra's standard orchestration remains authoritative over a stale or
    // explicit manual-standard flag. Only explicit Battle overrides it.
    const automaticUltra =
      admittedRoute.automaticUltra && admittedRoute.variant !== 'battle';
    if (automaticUltra && !hasWorkspaceMounts(agentInstanceId)) {
      logger.debug(
        '[SwarmRun] Automatic Ultra declined because no workspace is mounted',
        { agentInstanceId },
      );
      return null;
    }
    const rawAutomaticPrompt = automaticUltra
      ? getAutomaticUltraSwarmPrompt(history)
      : null;
    const convertedMessages = (request.options.messages ??
      []) as ReadonlyArray<ModelMessage>;
    const prompt = automaticUltra
      ? rawAutomaticPrompt
        ? convertedMessages.length > 0
          ? buildAutomaticSwarmModelContext(convertedMessages)
          : rawAutomaticPrompt
        : null
      : (await extractSwarmPromptFromMessage(agentInstanceId, message)) ||
        'Run Dynamic Swarm.';
    if (!prompt) {
      logger.debug(
        '[SwarmRun] Automatic Ultra declined because the admitted turn contains unsupported or ambiguous context',
        { agentInstanceId },
      );
      return null;
    }

    logger.debug('[SwarmRun] Swarm admitted after user lifecycle', {
      agentInstanceId,
      automaticUltra,
      mode: admittedRoute.variant,
      promptLength: prompt.length,
    });
    return createAutomaticSwarmStepExecution({
      request,
      run: async () => {
        await runSwarmWorkflow(agentInstanceId, prompt, admittedRoute.variant, {
          appendUserMessage: false,
          rethrowFailure: true,
          abortSignal: request.options.abortSignal,
          forceSwarmOnDirect: automaticUltra,
        });
      },
    });
  };
}

type AutomaticSwarmStepCallbacks = {
  onFinish?: (
    result: StepResult<ToolSet> & {
      steps: StepResult<ToolSet>[];
      totalUsage: StepResult<ToolSet>['usage'];
    },
  ) => void | PromiseLike<void>;
  onError?: (event: { error: unknown }) => void | PromiseLike<void>;
  onAbort?: (event: {
    steps: StepResult<ToolSet>[];
  }) => void | PromiseLike<void>;
};

function createAutomaticSwarmStepResult(
  request: AgentStepExecutionRequest,
): StepResult<ToolSet> {
  const model = request.options.model as {
    provider?: string;
    modelId?: string;
  };
  const usage: StepResult<ToolSet>['usage'] = {
    inputTokens: 0,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: 0,
    outputTokenDetails: {
      textTokens: 0,
      reasoningTokens: 0,
    },
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  return {
    stepNumber: 0,
    model: {
      provider: model.provider ?? 'clodex-swarm',
      modelId: model.modelId ?? request.context.resolvedModelId,
    },
    functionId: undefined,
    metadata: request.context.metadata,
    experimental_context: request.options.experimental_context,
    content: [],
    text: '',
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: 'stop',
    rawFinishReason: 'stop',
    usage,
    warnings: undefined,
    request: {},
    response: {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      modelId: request.context.resolvedModelId,
      messages: [],
    },
    providerMetadata: undefined,
  } as StepResult<ToolSet>;
}

export function createAutomaticSwarmStepExecution({
  request,
  run,
}: {
  request: AgentStepExecutionRequest;
  run: () => Promise<void>;
}): AgentStepExecution {
  let started = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A UI-only consumer is valid. Keep the internal completion rejection from
  // becoming an unhandled promise while still allowing consumeStream() to
  // observe and classify the same failure.
  void completion.catch(() => {});

  return {
    consumeStream(options) {
      return completion.catch((error) => {
        options?.onError?.(error);
      });
    },
    toUIMessageStream<UI_MESSAGE extends UIMessage>(
      _options: UIMessageStreamOptions<UI_MESSAGE> = {},
    ): AsyncIterableStream<InferUIMessageChunk<UI_MESSAGE>> {
      if (started) {
        throw new Error(
          'Automatic Swarm step UI stream can only be consumed once',
        );
      }
      started = true;
      const callbacks = request.options as AutomaticSwarmStepCallbacks;
      const stream = new ReadableStream<InferUIMessageChunk<UI_MESSAGE>>({
        start(controller) {
          void (async () => {
            try {
              if (request.options.abortSignal?.aborted) {
                await callbacks.onAbort?.({ steps: [] });
                return;
              }
              await run();
              throwIfAborted(request.options.abortSignal);
              const result = createAutomaticSwarmStepResult(request);
              await callbacks.onFinish?.({
                ...result,
                steps: [result],
                totalUsage: result.usage,
              });
            } catch (error) {
              if (request.options.abortSignal?.aborted || isAbortError(error)) {
                await callbacks.onAbort?.({ steps: [] });
              } else {
                controller.enqueue({
                  type: 'error',
                  errorText: stringifyErrorPart(error),
                } as InferUIMessageChunk<UI_MESSAGE>);
                rejectCompletion(error);
                // Publish the execution failure before BaseAgent's onError
                // callback aborts the shared signal. This lets the outer
                // ExecutionTargetRouter commit terminal=failed rather than
                // racing into cancelled/aborted.
                await Promise.resolve();
                await callbacks.onError?.({ error });
              }
            } finally {
              try {
                controller.close();
              } catch {
                // The BaseAgent consumer may already be cancelled by stop().
              } finally {
                resolveCompletion();
              }
            }
          })();
        },
      });
      return toAsyncIterableStream(stream);
    },
  };
}

function toAsyncIterableStream<T>(
  source: ReadableStream<T>,
): AsyncIterableStream<T> {
  const stream = source as AsyncIterableStream<T>;
  (
    stream as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<T>;
    }
  )[Symbol.asyncIterator] = () => {
    const reader = source.getReader();
    const iterator: AsyncIterator<T> & AsyncIterable<T> = {
      async next(): Promise<IteratorResult<T>> {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      },
      async return(): Promise<IteratorResult<T>> {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };
  return stream;
}

export function createSwarmRuntime({
  uiKarton,
  agentStore,
  models,
  attachments,
  logger,
  toolboxService,
  pendingEditService,
  agentManagerService,
  assertLocalExecutionAllowed = () => {
    throw new Error('Swarm local-execution ownership fence is unavailable');
  },
}: SwarmRuntimeDependencies): SwarmRuntime {
  const agentCoreSeam = { store: agentStore };
  const agentCoreHost = { models };
  const browserSwarmStore = new BrowserSwarmStore(uiKarton);
  const appendSwarmMessage = (
    agentInstanceId: string,
    message: AgentMessage,
  ): void => {
    assertLocalExecutionAllowed(agentInstanceId);
    updateAgentInstanceState(agentCoreSeam.store, agentInstanceId, (state) => {
      state.history.push(message);
    });
  };
  const createSwarmTextMessage = (
    role: 'user' | 'assistant',
    text: string,
    metadata?: Partial<AgentMessage['metadata']>,
  ): AgentMessage => ({
    id: crypto.randomUUID(),
    role,
    parts: [{ type: 'text', text }],
    metadata: {
      createdAt: new Date(),
      partsMetadata: [],
      ...metadata,
    },
  });
  type SwarmExecutionResult = Awaited<
    ReturnType<DynamicSwarmOrchestrator['execute']>
  >;
  const summarizeSwarmRun = (result: SwarmExecutionResult): string => {
    if (result.type === 'direct') {
      return [
        'Swarm triage completed.',
        '',
        `Complexity: ${result.triage.taskComplexity}.`,
        result.triage.reason
          ? `Reason: ${result.triage.reason}`
          : 'This task is small enough for the regular chat agent.',
      ].join('\n');
    }

    const completedTasks = result.run.results.length;
    const phases = result.run.plan.workflow.phases.length;
    return [
      'Swarm workflow completed successfully.',
      '',
      `Run: ${result.run.runId}`,
      `Complexity: ${result.triage.taskComplexity}`,
      `Phases: ${phases}`,
      `Tasks completed: ${completedTasks}`,
      '',
      'Check the Swarm panel above for phase and agent details.',
    ].join('\n');
  };
  const extractSwarmPromptFromMessage = async (
    agentInstanceId: string,
    message: AgentMessage,
  ): Promise<string> => {
    const textParts = message.parts
      .filter((part): part is { type: 'text'; text: string } => {
        return part.type === 'text' && typeof (part as any).text === 'string';
      })
      .map((part) => part.text.trim())
      .filter(Boolean);
    const attachmentTexts: string[] = [];
    for (const attachment of message.metadata?.attachments ?? []) {
      const originalFileName = attachment.originalFileName?.toLowerCase() ?? '';
      if (
        !attachment.path.startsWith('att/') ||
        !originalFileName.endsWith('.textclip')
      ) {
        continue;
      }
      try {
        const buffer = await attachments.read(
          agentInstanceId,
          attachment.path.slice('att/'.length),
        );
        attachmentTexts.push(buffer.toString('utf8').trim());
      } catch (error) {
        logger.warn('[SwarmRun] Failed to read textclip attachment', {
          attachmentPath: attachment.path,
          error,
        });
      }
    }

    return [...textParts, ...attachmentTexts].filter(Boolean).join('\n\n');
  };
  const resolveSwarmModel = async ({
    agentInstanceId,
    taskRole,
    traceId,
    metadata,
    preferredModelId,
    unavailableModelIds,
  }: {
    agentInstanceId: string;
    taskRole: ModelTaskRole;
    traceId: string;
    metadata: Record<string, unknown>;
    preferredModelId?: string;
    unavailableModelIds?: string[];
  }) => {
    const state =
      agentCoreSeam.store.get().agents.instances[agentInstanceId]?.state;
    const currentModelId = state?.activeModelId;
    if (!currentModelId) {
      throw new Error('Cannot run swarm: active model is missing.');
    }

    let resolvedModelId = preferredModelId ?? currentModelId;
    const usedPreferredModel = Boolean(preferredModelId);

    try {
      const routedModelId = await agentCoreHost.models.selectModelForTask?.({
        currentModelId,
        taskRole,
        agentType: 'swarm',
        traceId,
        preferredModelId,
        unavailableModelIds,
      });
      if (routedModelId) resolvedModelId = routedModelId;
    } catch (error) {
      logger.warn(
        usedPreferredModel
          ? `[SwarmRun] Preferred model routing failed for ${preferredModelId}; falling back to requested preferred model`
          : `[SwarmRun] Model routing failed for role ${taskRole}; falling back to ${currentModelId}`,
        { error },
      );
    }

    const modelMetadata = {
      $ai_parent_id: agentInstanceId,
      [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'agent-step',
      [MODEL_TASK_ROLE_METADATA_KEY]: taskRole,
      task_role: taskRole,
      requested_model_id: currentModelId,
      preferred_model_id: preferredModelId,
      routed_model_id: resolvedModelId,
      ...metadata,
    };

    let modelWithOptions: Awaited<
      ReturnType<typeof agentCoreHost.models.getWithOptions>
    >;
    try {
      modelWithOptions = await agentCoreHost.models.getWithOptions(
        resolvedModelId,
        traceId,
        modelMetadata,
      );
    } catch (error) {
      logger.warn(`[SwarmRun] Failed to resolve model ${resolvedModelId}`, {
        error,
        taskRole,
        currentModelId,
        preferredModelId,
      });
      throw error;
    }

    return { currentModelId, resolvedModelId, modelWithOptions };
  };
  const truncateSwarmReporterText = (
    text: string,
    maxChars: number,
  ): string => {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
  };
  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizeSwarmVisiblePaths = (
    text: string,
    mounts: ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts'],
  ): string => {
    let normalized = text;
    for (const mount of mounts) {
      if (!mount.prefix) continue;
      const mountPrefixPattern = new RegExp(
        `(^|[^\\w./-])${escapeRegExp(mount.prefix)}/`,
        'g',
      );
      normalized = normalized.replace(mountPrefixPattern, '$1./');
    }
    return normalized;
  };
  const formatSwarmReporterContext = (
    result: Extract<SwarmExecutionResult, { type: 'swarm' }>,
    mounts: ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts'],
  ): string =>
    [
      `<workflow description="${result.run.plan.workflow.description}">`,
      `Run ID: ${result.run.runId}`,
      `Complexity: ${result.triage.taskComplexity}`,
      `Phases: ${result.run.plan.workflow.phases.length}`,
      `Completed tasks: ${result.run.results.length}`,
      '</workflow>',
      '<worker-results>',
      ...result.run.results.map((task) =>
        [
          `<task name="${task.taskName}" role="${task.role}" modelRole="${task.modelTaskRole}">`,
          truncateSwarmReporterText(
            normalizeSwarmVisiblePaths(task.output, mounts),
            2_400,
          ),
          '</task>',
        ].join('\n'),
      ),
      '</worker-results>',
    ].join('\n');
  const generateSwarmReporterSummary = async ({
    agentInstanceId,
    prompt,
    result,
    abortSignal,
  }: {
    agentInstanceId: string;
    prompt: string;
    result: SwarmExecutionResult;
    abortSignal?: AbortSignal;
  }): Promise<string> => {
    throwIfAborted(abortSignal);
    if (result.type === 'direct') return summarizeSwarmRun(result);

    const traceId = `${agentInstanceId}:${result.run.runId}:swarm-reporter`;
    const { resolvedModelId, modelWithOptions } = await resolveSwarmModel({
      agentInstanceId,
      taskRole: 'analysis',
      traceId,
      metadata: {
        $ai_span_name: 'swarm-reporter',
        swarm_run_id: result.run.runId,
        swarm_stage: 'reporter',
      },
    });
    logger.debug(`[SwarmRun] Calling reporter with model ${resolvedModelId}`);
    const reporterMounts =
      toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts;

    assertLocalExecutionAllowed(agentInstanceId);
    const reporter = await generateText({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers: modelWithOptions.headers,
      abortSignal,
      system: [
        'You are the final reporter for a Dynamic Swarm workflow in an IDE.',
        'Tools are disabled. Write a concise Markdown answer for the user.',
        'Use the same language as the original user request.',
        'Synthesize what the swarm actually inspected, decided, changed, proposed, or could not complete.',
        'Mention concrete files or symbols when worker results provide them.',
        'Do not expose internal run IDs unless the user needs them for debugging.',
        'Never show internal workspace mount prefixes or hashes such as "w48b2/". When reporting files, use clean project-relative paths like "./index.html" or "./src/app.ts".',
        'Do not claim that files were changed unless worker results or pending edit results explicitly say so.',
        'End with the most relevant next verification step if there is one.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `<user-request>\n${prompt}\n</user-request>`,
            formatSwarmReporterContext(result, reporterMounts),
          ].join('\n\n'),
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 1_200,
      maxRetries: 1,
    });

    return reporter.text.trim() || summarizeSwarmRun(result);
  };
  const getSwarmWorkerTools = async (
    agentInstanceId: string,
    role: string,
    abortSignal?: AbortSignal,
  ): Promise<ToolSet> => {
    throwIfAborted(abortSignal);
    const readOnlyTools = [
      'searchProjectSymbols',
      'getFileSkeleton',
      'getSymbolBody',
      'read',
      'grepSearch',
      'glob',
      'ls',
    ];
    const writeTools = role === 'coder' ? ['write', 'multiEdit'] : [];
    const entries = await Promise.all(
      [...readOnlyTools, ...writeTools].map(async (toolName) => {
        const t = await toolboxService.getTool(toolName, agentInstanceId);
        return t ? ([toolName, t] as const) : null;
      }),
    );

    const availableEntries = entries.filter(
      (entry): entry is readonly [string, ToolSet[string]] => entry !== null,
    );
    throwIfAborted(abortSignal);
    return Object.fromEntries(
      availableEntries.map(([toolName, resolvedTool]) => {
        const execute = resolvedTool.execute;
        if (typeof execute !== 'function') return [toolName, resolvedTool];
        return [
          toolName,
          {
            ...resolvedTool,
            execute(input, options) {
              throwIfAborted(abortSignal);
              assertLocalExecutionAllowed(agentInstanceId);
              return execute(input, options);
            },
          } as ToolSet[string],
        ];
      }),
    ) as ToolSet;
  };
  const waitForSwarmWorkspaceMounts = async (
    agentInstanceId: string,
    timeoutMs = 5_000,
    abortSignal?: AbortSignal,
  ): Promise<
    ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts']
  > => {
    const startedAt = Date.now();
    throwIfAborted(abortSignal);
    let mounts = toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts;

    while (mounts.length === 0 && Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          abortSignal?.removeEventListener('abort', onAbort);
          callback();
        };
        const timeout = setTimeout(() => finish(resolve), 100);
        const onAbort = () => {
          clearTimeout(timeout);
          finish(() => reject(createAbortError(abortSignal)));
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        if (abortSignal?.aborted) onAbort();
      });
      throwIfAborted(abortSignal);
      mounts = toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts;
    }

    const durationMs = Date.now() - startedAt;
    const mountSummary = mounts.map((mount) => ({
      prefix: mount.prefix,
      path: mount.path,
      permissions: mount.permissions,
    }));

    if (mounts.length === 0) {
      logger.warn('[SwarmRun] Workspace mounts not ready before timeout', {
        agentInstanceId,
        durationMs,
      });
    } else {
      logger.debug('[SwarmRun] Workspace mounts ready', {
        agentInstanceId,
        durationMs,
        mounts: mountSummary,
      });
    }

    return mounts;
  };
  const ensureSwarmWorkspaceMounts = async (
    agentInstanceId: string,
    abortSignal?: AbortSignal,
  ): Promise<
    ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts']
  > => {
    // A swarm may inherit only mounts already attached to its owning agent.
    // Recent/global workspaces are ambient host state, not delegated
    // authority, so an empty scope remains empty and fails closed.
    return await waitForSwarmWorkspaceMounts(
      agentInstanceId,
      5_000,
      abortSignal,
    );
  };
  const formatSwarmWorkspaceMountContext = (
    mounts: ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts'],
  ): string => {
    if (mounts.length === 0) {
      return [
        '<workspace-mounts>',
        'No writable/readable workspace mounts are currently available.',
        '</workspace-mounts>',
      ].join('\n');
    }

    return [
      '<workspace-mounts>',
      'Use these mount prefixes exactly when calling project file tools:',
      ...mounts.map((mount) => {
        const permissions =
          mount.permissions && mount.permissions.length > 0
            ? mount.permissions.join(',')
            : 'read';
        return `- ${mount.prefix}/ -> ${mount.path} (${permissions})`;
      }),
      'Example: call read/ls/grepSearch with paths under "<prefix>/relative/path".',
      'For tool parameters named mount_prefix, pass only the bare prefix, for example "<prefix>".',
      '</workspace-mounts>',
    ].join('\n');
  };
  const formatSwarmMissingWorkspaceMessage = (prompt: string): string => {
    const isRussian = /[А-Яа-яЁё]/.test(prompt);
    if (isRussian) {
      return [
        'Не запустил Swarm: рабочая папка еще не подключилась к агенту.',
        '',
        'Я подождал workspace mounts перед стартом воркеров, но mount-manager вернул пустой список. Подключи или переподключи папку проекта и запусти задачу еще раз.',
      ].join('\n');
    }

    return [
      'I did not start the Swarm because no workspace folder is mounted for this agent yet.',
      '',
      'I waited for workspace mounts before launching workers, but the mount manager still returned an empty list. Connect or reconnect the project folder and try again.',
    ].join('\n');
  };
  const formatSwarmWorkerOutput = (result: {
    text: string;
    finishReason: string;
    steps: ReadonlyArray<{
      toolCalls: readonly unknown[];
      toolResults: readonly unknown[];
    }>;
  }): string => {
    const toolCalls = result.steps.reduce(
      (count, step) => count + step.toolCalls.length,
      0,
    );
    const text = result.text.trim() || '(No final text returned.)';
    if (toolCalls === 0) return text;
    return [
      text,
      '',
      `[Swarm worker used ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} across ${result.steps.length} step${result.steps.length === 1 ? '' : 's'}; finishReason=${result.finishReason}.]`,
    ].join('\n');
  };
  const getSwarmWorkerStepLimit = (role: string): number => {
    if (role === 'coder') return 16;
    if (role === 'reviewer') return 10;
    return 8;
  };
  const buildSwarmWorkerSystemPrompt = (role: SwarmTaskRole): string => {
    const baseRules = [
      'You are one worker inside a Dynamic Swarm workflow for Clodex IDE.',
      'Complete only your assigned task. Be concise, concrete, and preserve the language of the user request.',
      'No yapping: do not begin with greetings, apologies, or "I can help".',
      'Use searchProjectSymbols before broad directory exploration when locating existing code.',
      'Use read/getFileSkeleton/getSymbolBody/grepSearch to inspect the project before making claims.',
      'Do not claim that files were modified or commands were executed unless a tool result explicitly confirms it.',
      'After you finish using tools, you MUST write a short final textual summary. Do not end your worker turn immediately after a tool call.',
      'Return actionable findings, decisions, implementation notes, and any pending approval status for the next swarm phase.',
    ];

    const roleRules: Record<SwarmTaskRole, string[]> = {
      researcher: [
        'ROLE: Senior codebase researcher.',
        'Your job is to locate concrete files, symbols, APIs, dependencies, and constraints.',
        'You MUST use searchProjectSymbols when looking for existing components, functions, classes, routes, or APIs.',
        'Do not write code. Do not call write or multiEdit. Do not produce implementation patches.',
        'Final output: list exact files/symbols and the relevant logic that later workers should touch.',
      ],
      planner: [
        'ROLE: Senior software architect.',
        'Your job is to convert discovery context into an implementation plan for coder workers.',
        'Do not write code. Do not call write or multiEdit. Do not produce implementation patches.',
        'Final output: concrete files/functions to change, ordered steps, risk notes, and verification commands.',
      ],
      coder: [
        'ROLE: Senior implementation engineer.',
        'Your job is to apply the plan by using write or multiEdit for the smallest safe code changes.',
        'Do not stop at analysis when implementation is possible and the target files are known.',
        'If a planned file does not exist and the task requires it, create it.',
        'Before write/multiEdit, inspect the relevant current code and validate imports/syntax mentally against the surrounding project.',
        'Writes are human-approved pending edits, not direct disk writes.',
        'If a write or multiEdit result says a file is locked, switch to another file or summarize the conflict instead of retrying in a tight loop.',
      ],
      reviewer: [
        'ROLE: Strict code reviewer.',
        'Your job is to inspect proposed changes and find blocking defects before the user receives the result.',
        'Check imports, obvious type errors, missing exports, unsafe any usage, stale paths, and integration gaps.',
        'Do not write code unless the task explicitly asks the reviewer to fix a critical blocker.',
        'If the changes are acceptable, return "PASS" followed by a brief summary.',
        'If there is a critical bug, return "FAIL" followed by the exact file/symbol and the required fix.',
      ],
    };

    return [...baseRules, ...roleRules[role]].join('\n');
  };
  const needsSwarmWorkerFinalSummary = (result: {
    text: string;
    finishReason: string;
  }): boolean =>
    result.text.trim().length === 0 || result.finishReason === 'tool-calls';
  const generateSwarmWorkerFinalSummary = async ({
    agentInstanceId,
    modelWithOptions,
    headers,
    context,
    prompt,
    responseMessages,
    abortSignal,
  }: {
    agentInstanceId: string;
    modelWithOptions: Awaited<
      ReturnType<typeof resolveSwarmModel>
    >['modelWithOptions'];
    headers: Awaited<
      ReturnType<typeof resolveSwarmModel>
    >['modelWithOptions']['headers'];
    context: Parameters<
      NonNullable<
        ConstructorParameters<typeof DynamicSwarmOrchestrator>[0]['executor']
      >
    >[0];
    prompt: string;
    responseMessages: ModelMessage[];
    abortSignal: AbortSignal;
  }): Promise<{
    text: string;
    usage: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
    finishReason: string;
  }> => {
    assertLocalExecutionAllowed(agentInstanceId);
    const summary = await generateText({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers,
      abortSignal,
      system: [
        'You are finishing one Dynamic Swarm worker turn.',
        'Tools are now disabled. Do not request or mention new tool calls.',
        'Write a concise final worker report in the same language as the user request.',
        'Include: what you inspected, what you changed or proposed, files/symbols touched if known, blockers, and next verification step.',
        'If no file changes were proposed, say that clearly and summarize the useful findings.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `<user-request>\n${prompt}\n</user-request>`,
            `<worker-task name="${context.task.name}" role="${context.task.role}">`,
            context.task.prompt,
            '</worker-task>',
          ].join('\n'),
        },
        ...responseMessages,
        {
          role: 'user',
          content:
            'Now provide the final textual summary for this worker. Do not call tools.',
        },
      ],
      temperature: 0.1,
      maxOutputTokens: 900,
      maxRetries: 1,
    });

    return {
      text: summary.text.trim(),
      usage: summary.usage,
      finishReason: summary.finishReason,
    };
  };
  const runSwarmWorkflow = async (
    agentInstanceId: string,
    prompt: string,
    mode: SwarmRunMode = 'standard',
    options: {
      appendUserMessage?: boolean;
      rethrowFailure?: boolean;
      abortSignal?: AbortSignal;
      forceSwarmOnDirect?: boolean;
    } = {},
  ): Promise<string> => {
    const abortSignal = options.abortSignal;
    throwIfAborted(abortSignal);
    assertLocalExecutionAllowed(agentInstanceId);
    logger.debug(
      `[SwarmRun] Starting DynamicSwarmOrchestrator for agent ${agentInstanceId} (${mode})`,
    );
    if (options.appendUserMessage !== false) {
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage('user', prompt),
      );
    }
    const workspaceMounts = await ensureSwarmWorkspaceMounts(
      agentInstanceId,
      abortSignal,
    );
    if (workspaceMounts.length === 0) {
      throwIfAborted(abortSignal);
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage(
          'assistant',
          formatSwarmMissingWorkspaceMessage(prompt),
        ),
      );
      return 'no-workspace';
    }
    const workspaceMountContext =
      formatSwarmWorkspaceMountContext(workspaceMounts);
    const forceBattleMode = mode === 'battle';
    const getSwarmWorkerTimeoutMs = (role: SwarmTaskRole): number => {
      if (role === 'coder') return forceBattleMode ? 240_000 : 180_000;
      return forceBattleMode ? 240_000 : 120_000;
    };

    const orchestrator = new DynamicSwarmOrchestrator({
      triage: async (triagePrompt) => {
        throwIfAborted(abortSignal);
        if (forceBattleMode) {
          logger.debug(
            '[SwarmRun] Battle Agent mode forced fan-out/fan-in plan',
          );
          return {
            type: 'swarm',
            ...createBattleSwarmPlan(prompt),
          };
        }

        const traceId = `${agentInstanceId}:swarm-triage:${crypto.randomUUID()}`;
        const { resolvedModelId, modelWithOptions } = await resolveSwarmModel({
          agentInstanceId,
          taskRole: 'analysis',
          traceId,
          metadata: {
            $ai_span_name: 'swarm-triage',
            swarm_stage: 'triage',
          },
        });
        logger.debug(
          `[SwarmRun] Calling LLM triage with model ${resolvedModelId}`,
        );
        assertLocalExecutionAllowed(agentInstanceId);
        const result = await generateText({
          model: modelWithOptions.model,
          providerOptions: modelWithOptions.providerOptions,
          headers: modelWithOptions.headers,
          abortSignal,
          messages: [
            {
              role: 'user',
              content: triagePrompt,
            },
          ],
          temperature: 0.1,
          maxOutputTokens: 2400,
          maxRetries: 1,
        });
        logger.debug(
          `[SwarmRun] LLM triage completed | finishReason=${result.finishReason} | totalTokens=${result.usage.totalTokens ?? 'unknown'}`,
        );
        throwIfAborted(abortSignal);
        return result.text;
      },
      executor: async (context) => {
        throwIfAborted(abortSignal);
        const traceId = `${agentInstanceId}:${context.runId}:${context.task.id}`;
        const isBattleSynthesizerTask =
          forceBattleMode &&
          context.phase.id === 'p3' &&
          context.task.id === 'p3-t1' &&
          context.task.preferredModelId === 'gemini-3.5-flash';
        const swarmWorkerTools = await getSwarmWorkerTools(
          agentInstanceId,
          context.task.role,
          abortSignal,
        );
        let { resolvedModelId, modelWithOptions } = await resolveSwarmModel({
          agentInstanceId,
          taskRole: context.modelTaskRole,
          traceId,
          preferredModelId: context.task.preferredModelId,
          metadata: {
            $ai_span_name: `swarm-${context.task.role}`,
            swarm_run_id: context.runId,
            swarm_phase_id: context.phase.id,
            swarm_task_id: context.task.id,
            swarm_task_name: context.task.name,
            preferred_model_id: context.task.preferredModelId,
          },
        });
        throwIfAborted(abortSignal);
        context.emitProgress({
          resolvedModelId,
          log: {
            level: 'info',
            message: `Resolved model ${resolvedModelId}.`,
          },
        });

        const logWorkerCall = () => {
          logger.debug(
            `[SwarmRun] Calling LLM for task ${context.task.name} (${context.modelTaskRole}) with model ${resolvedModelId}${context.task.preferredModelId ? ` preferred=${context.task.preferredModelId}` : ''} and ${Object.keys(swarmWorkerTools).length} tools`,
          );
        };
        logWorkerCall();

        const workerTimeoutMs = getSwarmWorkerTimeoutMs(context.task.role);
        const abortController = new AbortController();
        const workerAbortSignal = abortSignal
          ? AbortSignal.any([abortController.signal, abortSignal])
          : abortController.signal;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          context.emitProgress({
            log: {
              level: 'error',
              message: `Timed out after ${Math.round(workerTimeoutMs / 1000)}s on ${resolvedModelId}.`,
            },
          });
          abortController.abort();
        }, workerTimeoutMs);

        const systemPrompt = buildSwarmWorkerSystemPrompt(context.task.role);
        const workerMessages: ModelMessage[] = [
          {
            role: 'user',
            content: [
              `<user-request>\n${prompt}\n</user-request>`,
              workspaceMountContext,
              `<workflow-description>\n${context.plan.workflow.description}\n</workflow-description>`,
              `<current-phase title="${context.phase.title}">`,
              `<task name="${context.task.name}" role="${context.task.role}" modelRole="${context.modelTaskRole}">`,
              context.task.prompt,
              '</task>',
              '</current-phase>',
              context.sharedContext
                ? `<previous-swarm-results>\n${context.sharedContext}\n</previous-swarm-results>`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ];

        try {
          const runWorkerAttempt = () => {
            assertLocalExecutionAllowed(agentInstanceId);
            return generateText({
              model: modelWithOptions.model,
              providerOptions: modelWithOptions.providerOptions,
              headers: modelWithOptions.headers,
              abortSignal: workerAbortSignal,
              system: systemPrompt,
              messages: workerMessages,
              temperature: context.task.role === 'coder' ? 0.2 : 0.1,
              maxOutputTokens: 1600,
              maxRetries: 1,
              tools: swarmWorkerTools,
              stopWhen: stepCountIs(getSwarmWorkerStepLimit(context.task.role)),
              experimental_context: {
                lockOwnerId: `${context.runId}:${context.task.id}`,
                swarmRunId: context.runId,
                swarmPhaseId: context.phase.id,
                swarmTaskId: context.task.id,
                swarmTaskName: context.task.name,
              },
              experimental_onToolCallStart: ({ toolCall }) => {
                logger.debug(
                  `[SwarmRun] Tool call started for ${context.task.name}: ${toolCall.toolName}`,
                );
                context.emitProgress({
                  toolsUsed: 1,
                  log: {
                    level: 'info',
                    message: `Tool started: ${toolCall.toolName}.`,
                  },
                });
              },
              experimental_onToolCallFinish: (event) => {
                if (!event.success) {
                  logger.warn(
                    `[SwarmRun] Tool call failed for ${context.task.name}: ${event.toolCall.toolName}`,
                    { durationMs: event.durationMs, error: event.error },
                  );
                  context.emitProgress({
                    log: {
                      level: 'error',
                      message: `Tool failed: ${event.toolCall.toolName} (${Math.round(event.durationMs)}ms).`,
                    },
                  });
                } else {
                  logger.debug(
                    `[SwarmRun] Tool call finished for ${context.task.name}: ${event.toolCall.toolName} (${event.durationMs}ms)`,
                  );
                  context.emitProgress({
                    log: {
                      level: 'info',
                      message: `Tool finished: ${event.toolCall.toolName} (${Math.round(event.durationMs)}ms).`,
                    },
                  });
                }
              },
            });
          };

          const runGeminiNoToolsProbe = async (
            includeProviderOptions: boolean,
          ) => {
            const probeAbortController = new AbortController();
            const probeAbortSignal = abortSignal
              ? AbortSignal.any([probeAbortController.signal, abortSignal])
              : probeAbortController.signal;
            const probeTimeout = setTimeout(
              () => probeAbortController.abort(),
              45_000,
            );
            try {
              assertLocalExecutionAllowed(agentInstanceId);
              return await generateText({
                model: modelWithOptions.model,
                providerOptions: includeProviderOptions
                  ? modelWithOptions.providerOptions
                  : undefined,
                headers: modelWithOptions.headers,
                abortSignal: probeAbortSignal,
                system: [
                  systemPrompt,
                  'Diagnostic mode: do not call tools. If previous code-search context is present, use it. Return a concise critique for this worker task.',
                ].join('\n'),
                messages: workerMessages,
                temperature: 0.1,
                maxOutputTokens: 1000,
                maxRetries: 0,
              });
            } finally {
              clearTimeout(probeTimeout);
            }
          };

          let result: Awaited<ReturnType<typeof runWorkerAttempt>> | undefined;
          try {
            result = await runWorkerAttempt();
          } catch (error) {
            if (abortSignal?.aborted) throw createAbortError(abortSignal);
            if (timedOut || abortController.signal.aborted) {
              throw new Error(
                `${context.task.name} timed out after ${Math.round(workerTimeoutMs / 1000)}s while using ${resolvedModelId}.`,
                { cause: error },
              );
            }
            const errorSearchText = getSwarmErrorSearchText(error);
            const unavailableChannel = isUnavailableGatewayChannelError(error);
            const retryableGatewayError = isRetryableGeminiGatewayError(
              error,
              context.task.preferredModelId,
            );
            const allowBattleSynthesizerFallback =
              isBattleSynthesizerTask &&
              context.task.preferredModelId === 'gemini-3.5-flash';
            logger.warn(
              `[SwarmRun] Worker model call failed for ${context.task.name} on ${resolvedModelId}`,
              {
                preferredModelId: context.task.preferredModelId,
                unavailableChannel,
                retryableGatewayError,
                errorSearchText: errorSearchText.slice(0, 4_000),
              },
            );
            logger.warn(
              `[SwarmRun] Worker model error detail for ${context.task.name}: ${errorSearchText.slice(0, 1_500)}`,
            );
            if (
              !context.task.preferredModelId ||
              (!retryableGatewayError && !allowBattleSynthesizerFallback)
            ) {
              throw error;
            }

            const failedModelId = resolvedModelId;
            if (failedModelId.startsWith('gemini-')) {
              context.emitProgress({
                log: {
                  level: 'warn',
                  message:
                    'Gemini tools request failed; probing no-tools request with the same runtime token.',
                },
              });
              try {
                result = await runGeminiNoToolsProbe(true);
                context.emitProgress({
                  log: {
                    level: 'info',
                    message:
                      'Gemini no-tools probe passed with provider options; tool-calling payload is the failing path.',
                  },
                });
              } catch (probeError) {
                throwIfAborted(abortSignal);
                const probeDetail = getSwarmErrorSearchText(probeError);
                logger.warn(
                  `[SwarmRun] Gemini no-tools probe with provider options failed for ${context.task.name}: ${probeDetail.slice(0, 1_500)}`,
                );
                context.emitProgress({
                  log: {
                    level: 'warn',
                    message:
                      'Gemini no-tools probe with provider options failed; retrying minimal payload.',
                  },
                });
                try {
                  result = await runGeminiNoToolsProbe(false);
                  context.emitProgress({
                    log: {
                      level: 'warn',
                      message:
                        'Gemini minimal no-tools probe passed; provider options are incompatible on this route.',
                    },
                  });
                } catch (minimalProbeError) {
                  throwIfAborted(abortSignal);
                  const minimalProbeDetail =
                    getSwarmErrorSearchText(minimalProbeError);
                  logger.warn(
                    `[SwarmRun] Gemini minimal no-tools probe failed for ${context.task.name}: ${minimalProbeDetail.slice(0, 1_500)}`,
                  );
                  context.emitProgress({
                    log: {
                      level: 'error',
                      message:
                        'Gemini minimal no-tools probe failed; this is a gateway/channel connection issue.',
                    },
                  });
                }
              }
            }

            if (!result && allowBattleSynthesizerFallback) {
              let fallbackError: unknown = error;
              for (const fallbackPreferredModelId of [
                'gpt-5.5',
                'claude-opus-4.8',
              ]) {
                throwIfAborted(abortSignal);
                context.emitProgress({
                  log: {
                    level: 'warn',
                    message: `[Synthesizer] Gemini 3.5 unavailable. Falling back to ${fallbackPreferredModelId}.`,
                  },
                });
                try {
                  const fallback = await resolveSwarmModel({
                    agentInstanceId,
                    taskRole: context.modelTaskRole,
                    traceId,
                    preferredModelId: fallbackPreferredModelId,
                    unavailableModelIds: [failedModelId],
                    metadata: {
                      $ai_span_name: `swarm-${context.task.role}`,
                      swarm_run_id: context.runId,
                      swarm_phase_id: context.phase.id,
                      swarm_task_id: context.task.id,
                      swarm_task_name: context.task.name,
                      preferred_model_id: fallbackPreferredModelId,
                      fallback_from_model_id: failedModelId,
                    },
                  });
                  if (fallback.resolvedModelId === failedModelId) continue;
                  resolvedModelId = fallback.resolvedModelId;
                  modelWithOptions = fallback.modelWithOptions;
                  context.emitProgress({
                    resolvedModelId,
                    log: {
                      level: 'warn',
                      message: `[Synthesizer] Running fallback on ${resolvedModelId}.`,
                    },
                  });
                  logWorkerCall();
                  result = await runWorkerAttempt();
                  break;
                } catch (candidateError) {
                  throwIfAborted(abortSignal);
                  fallbackError = candidateError;
                  logger.warn(
                    `[SwarmRun] Battle synthesizer fallback ${fallbackPreferredModelId} failed for ${context.task.name}`,
                    {
                      errorSearchText: getSwarmErrorSearchText(
                        candidateError,
                      ).slice(0, 1_500),
                    },
                  );
                  context.emitProgress({
                    log: {
                      level: 'error',
                      message: `[Synthesizer] Fallback ${fallbackPreferredModelId} failed.`,
                    },
                  });
                }
              }

              if (!result) {
                throw fallbackError instanceof Error
                  ? fallbackError
                  : new Error(String(fallbackError));
              }
            }

            if (!result) {
              throwIfAborted(abortSignal);
              const fallback = await resolveSwarmModel({
                agentInstanceId,
                taskRole: context.modelTaskRole,
                traceId,
                preferredModelId: context.task.preferredModelId,
                unavailableModelIds: [failedModelId],
                metadata: {
                  $ai_span_name: `swarm-${context.task.role}`,
                  swarm_run_id: context.runId,
                  swarm_phase_id: context.phase.id,
                  swarm_task_id: context.task.id,
                  swarm_task_name: context.task.name,
                  preferred_model_id: context.task.preferredModelId,
                  unavailable_model_id: failedModelId,
                },
              });

              if (fallback.resolvedModelId === failedModelId) {
                logger.warn(
                  `[SwarmRun] No same-provider fallback available for ${context.task.name} after ${failedModelId} failed`,
                  {
                    preferredModelId: context.task.preferredModelId,
                    failedModelId,
                  },
                );
                context.emitProgress({
                  log: {
                    level: 'error',
                    message: `Model ${failedModelId} failed and no same-provider fallback is available.`,
                  },
                });
                throw error;
              }

              logger.warn(
                `[SwarmRun] Retrying task ${context.task.name} after gateway failure for ${failedModelId}; fallback=${fallback.resolvedModelId}`,
                { error },
              );
              resolvedModelId = fallback.resolvedModelId;
              modelWithOptions = fallback.modelWithOptions;
              context.emitProgress({
                resolvedModelId,
                log: {
                  level: 'warn',
                  message: `Model fallback: ${failedModelId} -> ${resolvedModelId}.`,
                },
              });
              logWorkerCall();
              throwIfAborted(abortSignal);
              result = await runWorkerAttempt();
            }
          }

          throwIfAborted(abortSignal);
          if (!result) {
            throw new Error(
              `Swarm worker ${context.task.name} did not return a result.`,
            );
          }

          let tokenCount =
            result.totalUsage.totalTokens ??
            result.usage.totalTokens ??
            (result.totalUsage.inputTokens ?? result.usage.inputTokens ?? 0) +
              (result.totalUsage.outputTokens ??
                result.usage.outputTokens ??
                0);

          let finalText = result.text.trim();
          let finalFinishReason: string = result.finishReason;
          if (needsSwarmWorkerFinalSummary(result)) {
            logger.debug(
              `[SwarmRun] Requesting no-tools final summary for ${context.task.name} after finishReason=${result.finishReason}`,
            );
            const summary = await generateSwarmWorkerFinalSummary({
              agentInstanceId,
              modelWithOptions,
              headers: modelWithOptions.headers,
              context,
              prompt,
              responseMessages: result.response.messages,
              abortSignal: workerAbortSignal,
            });
            finalText = summary.text;
            finalFinishReason = `${result.finishReason}+summary:${summary.finishReason}`;
            tokenCount +=
              summary.usage.totalTokens ??
              (summary.usage.inputTokens ?? 0) +
                (summary.usage.outputTokens ?? 0);
          }

          context.emitProgress({ newTokens: tokenCount });
          throwIfAborted(abortSignal);
          logger.debug(
            `[SwarmRun] LLM task completed: ${context.task.name} | finishReason=${finalFinishReason} | totalTokens=${tokenCount} | toolCalls=${result.steps.reduce((count, step) => count + step.toolCalls.length, 0)}`,
          );
          return {
            output: formatSwarmWorkerOutput({
              text: finalText,
              finishReason: finalFinishReason,
              steps: result.steps,
            }),
            modelTaskRole: context.modelTaskRole,
            resolvedModelId,
            metrics: { newTokens: tokenCount },
          };
        } finally {
          clearTimeout(timeout);
          (
            pendingEditService as PendingEditService & {
              releaseLocksForOwner?: (ownerId: string) => void;
            }
          ).releaseLocksForOwner?.(`${context.runId}:${context.task.id}`);
        }
      },
      onTriageError: (error) => {
        logger.debug(`[SwarmRun] Falling back to heuristic triage`, { error });
      },
    });

    orchestrator.on((event) => {
      logger.debug(`[SwarmRun] Event: ${event.type}`);
      browserSwarmStore.applyEvent(agentInstanceId, event);
    });

    try {
      const result = await orchestrator.execute(prompt, {
        forceSwarmOnDirect: options.forceSwarmOnDirect,
      });
      throwIfAborted(abortSignal);
      if (result.type === 'swarm') {
        browserSwarmStore.completeRunFromResult(agentInstanceId, result.run);
      }
      const summary = await generateSwarmReporterSummary({
        agentInstanceId,
        prompt,
        result,
        abortSignal,
      }).catch((error) => {
        throwIfAborted(abortSignal);
        logger.warn('[SwarmRun] Reporter failed; falling back to summary', {
          error,
        });
        return summarizeSwarmRun(result);
      });
      throwIfAborted(abortSignal);
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage('assistant', summary, {
          swarmResultRunId:
            result.type === 'swarm' ? result.run.runId : undefined,
          swarmDiffArtifact: result.type === 'swarm',
        }),
      );
      logger.debug(`[SwarmRun] Completed workflow`);
      return result.type === 'swarm' ? result.run.runId : 'direct';
    } catch (error) {
      if (abortSignal?.aborted || isAbortError(error)) {
        throw createAbortError(abortSignal);
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Swarm workflow failed unexpectedly.';
      throwIfAborted(abortSignal);
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage(
          'assistant',
          `Swarm workflow failed.\n\n${message}`,
        ),
      );
      if (options.rethrowFailure === false) return 'failed';
      throw error;
    }
  };
  agentManagerService.setSwarmSubmitHandler(
    createSwarmSubmitHandler({
      logger,
    }),
  );
  const getModelThinkingSubmitContext = (
    requestedModelId: string,
  ): ModelThinkingSubmitContext => {
    const preferences = uiKarton.state.preferences;
    return {
      modelId: getThinkingOverrideModelId(requestedModelId),
      override: getModelThinkingOverride(
        preferences.agent.modelThinkingOverrides,
        requestedModelId,
      ),
      providerMode: getActiveGptThinkingProviderMode(
        requestedModelId,
        preferences,
      ),
    };
  };
  agentManagerService.setAutomaticSwarmStepHandler(
    createAdmittedSwarmStepHandler({
      getAgentHistory: (agentInstanceId) =>
        agentCoreSeam.store.get().agents.instances[agentInstanceId]?.state
          .history ?? [],
      getModelThinkingSubmitContext,
      hasWorkspaceMounts: (agentInstanceId) =>
        toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts.length > 0,
      extractSwarmPromptFromMessage,
      runSwarmWorkflow,
      logger,
    }),
  );
  const runForcedSwarmPreview = async (
    agentInstanceId: string,
    prompt: string,
  ): Promise<string> => {
    logger.debug(
      `[SwarmPreview] Starting forced high-complexity preview for agent ${agentInstanceId}`,
    );
    const plan = createFallbackSwarmPlan(prompt, 'high');
    const runner = new SwarmRunner({
      executor: async (context) => {
        logger.debug(
          `[SwarmPreview] Task started: ${context.task.name} (${context.modelTaskRole})`,
        );
        context.emitProgress({ newTokens: 120, toolsUsed: 1 });
        await new Promise((resolve) => setTimeout(resolve, 650));
        return `${context.task.name} completed preview for: ${context.task.prompt}`;
      },
    });
    runner.on((event) => {
      logger.debug(`[SwarmPreview] Event: ${event.type}`);
      browserSwarmStore.applyEvent(agentInstanceId, event);
    });
    const result = await runner.run(plan);
    logger.debug(`[SwarmPreview] Completed run ${result.runId}`);
    return result.runId;
  };

  return {
    browserSwarmStore,
    runSwarmWorkflow,
    runForcedSwarmPreview,
  };
}
