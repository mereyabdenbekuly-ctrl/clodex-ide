import {
  findToolCallRecoverySignal,
  localAgentStepExecutor,
  type AgentStepExecution,
  type AgentStepExecutionRequest,
  type AgentStepExecutor,
} from '@clodex/agent-core/agents';
import {
  asSchema,
  streamText,
  type AsyncIterableStream,
  type FinishReason,
  type InferUIMessageChunk,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
  type StepResult,
  type Tool,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamOptions,
} from 'ai';
import { createHash, randomUUID } from 'node:crypto';
import type {
  FileEditBatchParticipant,
  FileEditBatchTerminalOutcome,
} from '@clodex/agent-core/types';
import type {
  AgentStepRuntimeSelectionReason,
  AgentStepRuntimeTelemetryEvents,
  AgentStepRuntimeTelemetrySink,
} from '@shared/agent-runtime-telemetry';
import type { Logger } from '../services/logger';
import type {
  AgentTurnHostHandlers,
  AgentTurnJsonObject,
  AgentTurnJsonValue,
  IsolatedAgentConversationMessage,
  IsolatedAgentFileEditBatchMetadata,
  IsolatedAgentModelCallResult,
  IsolatedAgentRejectedToolCall,
  IsolatedAgentToolCall,
  IsolatedAgentTurnEvent,
  IsolatedAgentTurnRequest,
  IsolatedAgentTurnResult,
  IsolatedAgentTurnStepResult,
  IsolatedAgentUsage,
} from './isolated-agent-turn';
import {
  createIsolatedToolCallRejectionMessage,
  isAgentTurnJsonValue,
  rejectDuplicateIsolatedToolCallIds,
} from './isolated-agent-turn';
import {
  FileEditBatchCoordinator,
  terminalOutcomeForToolResult,
} from './file-edit-batch-coordinator';
import {
  IsolatedAgentRuntimeCircuitBreaker,
  type IsolatedAgentRuntimeAdmission,
  type IsolatedAgentRuntimeCircuitBreakerOptions,
  type IsolatedAgentRuntimeCircuitBreakerTransition,
  type IsolatedAgentRuntimeOutcome,
} from './isolated-agent-runtime-circuit-breaker';

const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

interface IsolatedAgentTurnProcess {
  readonly canExecuteAgentWorkloads: boolean;
  executeAgentTurn(
    request: IsolatedAgentTurnRequest,
    options: {
      signal?: AbortSignal;
      onEvent?: (event: IsolatedAgentTurnEvent) => void;
      handlers?: AgentTurnHostHandlers;
    },
  ): Promise<IsolatedAgentTurnResult>;
}

export interface BrowserAgentStepExecutorOptions {
  process: IsolatedAgentTurnProcess | null;
  logger: Pick<Logger, 'debug' | 'warn'>;
  isEnabled: () => boolean;
  isKillSwitchActive?: () => boolean;
  assertLocalExecutionAllowed?: (agentInstanceId: string) => void;
  telemetry?: AgentStepRuntimeTelemetrySink;
  circuitBreaker?: Partial<IsolatedAgentRuntimeCircuitBreakerOptions>;
  localExecutor?: AgentStepExecutor;
  streamTextFn?: typeof streamText;
}

interface PreparedRemoteStep {
  request: IsolatedAgentTurnRequest;
  handlers: AgentTurnHostHandlers;
}

class UnsupportedRemoteStepError extends Error {
  public constructor(
    public readonly reason: AgentStepRuntimeSelectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedRemoteStepError';
  }
}

/**
 * Browser-owned `BaseAgent` step executor.
 *
 * The utility process owns the model/tool orchestration. Models and tool
 * executors are deliberately retained in the main process as per-turn RPC
 * handlers because they contain non-transferable provider clients and host
 * capabilities. A step that cannot be represented without loss falls back
 * before dispatch; a dispatched step is never replayed locally.
 */
export class BrowserAgentStepExecutor implements AgentStepExecutor {
  private readonly process: IsolatedAgentTurnProcess | null;
  private readonly logger: Pick<Logger, 'debug' | 'warn'>;
  private readonly isEnabled: () => boolean;
  private readonly isKillSwitchActive: () => boolean;
  private readonly assertLocalExecutionAllowed: (
    agentInstanceId: string,
  ) => void;
  private readonly telemetry: AgentStepRuntimeTelemetrySink | undefined;
  private readonly circuitBreaker: IsolatedAgentRuntimeCircuitBreaker;
  private readonly localExecutor: AgentStepExecutor;
  private readonly streamTextFn: typeof streamText;

  public constructor({
    process,
    logger,
    isEnabled,
    isKillSwitchActive = () => false,
    assertLocalExecutionAllowed = () => {
      throw new Error('Local-execution ownership fence is unavailable');
    },
    telemetry,
    circuitBreaker,
    localExecutor = localAgentStepExecutor,
    streamTextFn = streamText,
  }: BrowserAgentStepExecutorOptions) {
    this.process = process;
    this.logger = logger;
    this.isEnabled = isEnabled;
    this.isKillSwitchActive = isKillSwitchActive;
    this.assertLocalExecutionAllowed = assertLocalExecutionAllowed;
    this.telemetry = telemetry;
    this.circuitBreaker = new IsolatedAgentRuntimeCircuitBreaker({
      failureThreshold:
        circuitBreaker?.failureThreshold ??
        DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      cooldownMs:
        circuitBreaker?.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
      now: circuitBreaker?.now,
    });
    this.localExecutor = localExecutor;
    this.streamTextFn = streamTextFn;
  }

  public async execute(
    request: AgentStepExecutionRequest,
  ): Promise<AgentStepExecution> {
    const preparationStartedAt = Date.now();
    if (this.isKillSwitchActive()) {
      return await this.executeLocal(
        request,
        'kill-switch-active',
        preparationStartedAt,
      );
    }
    if (!this.isEnabled()) {
      return await this.executeLocal(
        request,
        'gate-disabled',
        preparationStartedAt,
      );
    }
    if (request.context.isApprovalContinuation) {
      return await this.executeLocal(
        request,
        'approval-continuation',
        preparationStartedAt,
      );
    }
    if (!this.process?.canExecuteAgentWorkloads) {
      return await this.executeLocal(
        request,
        'worker-unavailable',
        preparationStartedAt,
      );
    }
    if (!this.circuitBreaker.canAttempt()) {
      return await this.executeLocal(
        request,
        'circuit-breaker-open',
        preparationStartedAt,
      );
    }

    try {
      const prepared = await prepareRemoteStep(
        request,
        this.streamTextFn,
        this.assertLocalExecutionAllowed,
      );
      const acquisition = this.circuitBreaker.tryAcquire();
      if (!acquisition) {
        return await this.executeLocal(
          request,
          'circuit-breaker-open',
          preparationStartedAt,
        );
      }
      if (acquisition.transition) {
        this.captureCircuitBreakerTransition(acquisition.transition);
      }
      this.captureTelemetry('agent-step-runtime-selected', {
        agent_type: request.context.agentType,
        model_id: request.context.resolvedModelId,
        runtime: 'isolated',
        reason: 'compatible',
        preparation_duration_ms: elapsedMs(preparationStartedAt),
      });
      return new RemoteAgentStepExecution(
        this.process,
        request,
        prepared,
        this.assertLocalExecutionAllowed,
        (eventName, properties) => this.captureTelemetry(eventName, properties),
        (outcome) => this.recordRemoteOutcome(acquisition.admission, outcome),
      );
    } catch (error) {
      if (error instanceof UnsupportedRemoteStepError) {
        this.logger.debug(
          `[BrowserAgentStepExecutor] Using local step for ${request.context.agentInstanceId}: ${error.message}`,
        );
        return await this.executeLocal(
          request,
          error.reason,
          preparationStartedAt,
        );
      }
      this.logger.warn(
        '[BrowserAgentStepExecutor] Remote step preparation failed; using local executor',
        error,
      );
      return await this.executeLocal(
        request,
        'preparation-error',
        preparationStartedAt,
      );
    }
  }

  private async executeLocal(
    request: AgentStepExecutionRequest,
    reason: AgentStepRuntimeSelectionReason,
    preparationStartedAt: number,
  ): Promise<AgentStepExecution> {
    this.assertLocalExecutionAllowed(request.context.agentInstanceId);
    this.captureTelemetry('agent-step-runtime-selected', {
      agent_type: request.context.agentType,
      model_id: request.context.resolvedModelId,
      runtime: 'local',
      reason,
      preparation_duration_ms: elapsedMs(preparationStartedAt),
    });
    return await this.localExecutor.execute(
      fenceLocalToolExecutors(request, this.assertLocalExecutionAllowed),
    );
  }

  private captureTelemetry<T extends keyof AgentStepRuntimeTelemetryEvents>(
    eventName: T,
    properties: AgentStepRuntimeTelemetryEvents[T],
  ): void {
    try {
      this.telemetry?.capture(eventName, properties);
    } catch (error) {
      this.logger.debug(
        `[BrowserAgentStepExecutor] Failed to capture ${eventName}: ${normalizeError(error).message}`,
      );
    }
  }

  private recordRemoteOutcome(
    admission: IsolatedAgentRuntimeAdmission,
    outcome: IsolatedAgentRuntimeOutcome,
  ): void {
    const transition = this.circuitBreaker.recordOutcome(admission, outcome);
    if (transition) this.captureCircuitBreakerTransition(transition);
  }

  private captureCircuitBreakerTransition(
    transition: IsolatedAgentRuntimeCircuitBreakerTransition,
  ): void {
    this.captureTelemetry('agent-step-runtime-circuit-breaker', {
      state: transition.state,
      trigger: transition.trigger,
      consecutive_failures: transition.consecutiveFailures,
      failure_threshold: transition.failureThreshold,
      cooldown_ms: transition.cooldownMs,
    });
  }
}

function fenceLocalToolExecutors(
  request: AgentStepExecutionRequest,
  assertLocalExecutionAllowed: (agentInstanceId: string) => void,
): AgentStepExecutionRequest {
  const tools = request.options.tools as ToolSet | undefined;
  if (!tools) return request;

  const fencedTools: ToolSet = {};
  for (const [name, resolvedTool] of Object.entries(tools)) {
    const execute = resolvedTool.execute;
    if (typeof execute !== 'function') {
      fencedTools[name] = resolvedTool;
      continue;
    }
    fencedTools[name] = {
      ...resolvedTool,
      execute(input, options) {
        assertLocalExecutionAllowed(request.context.agentInstanceId);
        return execute(input, options);
      },
    } as ToolSet[string];
  }

  return {
    ...request,
    options: {
      ...request.options,
      tools: fencedTools,
    },
  };
}

export function createBrowserAgentStepExecutor(
  options: BrowserAgentStepExecutorOptions,
): AgentStepExecutor {
  return new BrowserAgentStepExecutor(options);
}

class RemoteAgentStepExecution implements AgentStepExecution {
  public readonly modelRouteBinding = 'request-model' as const;
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private started = false;

  public constructor(
    private readonly process: IsolatedAgentTurnProcess,
    private readonly executionRequest: AgentStepExecutionRequest,
    private readonly prepared: PreparedRemoteStep,
    private readonly assertLocalExecutionAllowed: (
      agentInstanceId: string,
    ) => void,
    private readonly captureTelemetry: <
      T extends keyof AgentStepRuntimeTelemetryEvents,
    >(
      eventName: T,
      properties: AgentStepRuntimeTelemetryEvents[T],
    ) => void,
    private readonly onOutcome: (outcome: IsolatedAgentRuntimeOutcome) => void,
  ) {
    this.completion = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  public consumeStream(options?: {
    onError?: (error: unknown) => void;
  }): PromiseLike<void> {
    return this.completion.catch((error) => {
      options?.onError?.(error);
    });
  }

  public toUIMessageStream<UI_MESSAGE extends UIMessage>(
    options: UIMessageStreamOptions<UI_MESSAGE> = {},
  ): AsyncIterableStream<InferUIMessageChunk<UI_MESSAGE>> {
    if (this.started) {
      throw new Error('Remote agent step UI stream can only be consumed once');
    }
    this.started = true;

    const stream = new ReadableStream<InferUIMessageChunk<UI_MESSAGE>>({
      start: (controller) => {
        void this.run(controller, options);
      },
    });
    return toAsyncIterableStream(stream);
  }

  private async run<UI_MESSAGE extends UIMessage>(
    controller: ReadableStreamDefaultController<
      InferUIMessageChunk<UI_MESSAGE>
    >,
    uiOptions: UIMessageStreamOptions<UI_MESSAGE>,
  ): Promise<void> {
    const executionStartedAt = Date.now();
    let outcome: IsolatedAgentRuntimeOutcome = 'failed';
    const options = this.executionRequest.options as StepCallbacks;
    const state = new Map<number, StreamedStepState>();
    const steps: IsolatedAgentTurnStepResult[] = [];
    const sendStart = uiOptions.sendStart !== false;
    const sendFinish = uiOptions.sendFinish !== false;
    const timeoutController = new AbortController();
    const totalTimeoutMs = getTotalTimeoutMs(
      this.executionRequest.options.timeout,
    );
    const timeout =
      totalTimeoutMs === undefined
        ? null
        : setTimeout(() => {
            timeoutController.abort(
              new DOMException(
                `Isolated agent step timed out after ${totalTimeoutMs}ms`,
                'AbortError',
              ),
            );
          }, totalTimeoutMs);
    timeout?.unref?.();

    const write = (chunk: InferUIMessageChunk<UI_MESSAGE>) => {
      try {
        controller.enqueue(chunk);
      } catch {
        // The UI consumer may have been cancelled after the host callback
        // completed. Cancellation must not cause local replay.
      }
    };

    try {
      if (sendStart) {
        write({
          type: 'start',
          messageId: uiOptions.generateMessageId?.(),
        } as InferUIMessageChunk<UI_MESSAGE>);
      }

      this.assertLocalExecutionAllowed(
        this.executionRequest.context.agentInstanceId,
      );
      const result = await this.process.executeAgentTurn(
        this.prepared.request,
        {
          signal: combineAbortSignals(
            this.executionRequest.options.abortSignal,
            timeoutController.signal,
          ),
          handlers: this.prepared.handlers,
          onEvent: (event) => {
            handleRemoteEvent(event, state, write);
          },
        },
      );
      steps.push(...result.steps);

      const finalStep = result.steps.at(-1);
      if (!finalStep) {
        throw new Error('Isolated agent turn completed without a step result');
      }
      closeOpenParts(finalStep.index, state, write);

      const stepResult = createStepResult(finalStep, this.executionRequest);
      await options.onFinish?.({
        ...stepResult,
        steps: [stepResult],
        totalUsage: stepResult.usage,
      });

      if (sendFinish) {
        write({
          type: 'finish',
          finishReason: stepResult.finishReason,
        } as InferUIMessageChunk<UI_MESSAGE>);
      }
      outcome = 'completed';
    } catch (error) {
      const normalized = normalizeError(error);
      if (isAbortError(normalized)) {
        outcome = 'aborted';
        await options.onAbort?.({
          steps: steps.map((step) =>
            createStepResult(step, this.executionRequest),
          ),
        });
        write({
          type: 'abort',
          reason: normalized.message,
        } as InferUIMessageChunk<UI_MESSAGE>);
      } else {
        outcome = 'failed';
        await options.onError?.({ error: normalized });
        write({
          type: 'error',
          errorText: normalized.message,
        } as InferUIMessageChunk<UI_MESSAGE>);
      }
    } finally {
      this.onOutcome(outcome);
      this.captureTelemetry('agent-step-runtime-finished', {
        agent_type: this.executionRequest.context.agentType,
        model_id: this.executionRequest.context.resolvedModelId,
        runtime: 'isolated',
        outcome,
        duration_ms: elapsedMs(executionStartedAt),
      });
      if (timeout) clearTimeout(timeout);
      try {
        controller.close();
      } catch {}
      this.resolveCompletion();
    }
  }
}

interface StepCallbacks {
  onFinish?: (
    result: StepResult<ToolSet> & {
      steps: StepResult<ToolSet>[];
      totalUsage: LanguageModelUsage;
    },
  ) => void | PromiseLike<void>;
  onError?: (event: { error: unknown }) => void | PromiseLike<void>;
  onAbort?: (event: {
    steps: StepResult<ToolSet>[];
  }) => void | PromiseLike<void>;
}

interface StreamedStepState {
  textStarted: boolean;
  reasoningStarted: boolean;
}

async function prepareRemoteStep(
  executionRequest: AgentStepExecutionRequest,
  streamTextFn: typeof streamText,
  assertLocalExecutionAllowed: (agentInstanceId: string) => void = () => {
    throw new Error('Local-execution ownership fence is unavailable');
  },
): Promise<PreparedRemoteStep> {
  const options = executionRequest.options;
  if (
    options.prompt !== undefined ||
    options.system !== undefined ||
    !Array.isArray(options.messages)
  ) {
    throw new UnsupportedRemoteStepError(
      'unsupported-prompt-shape',
      'only explicit ModelMessage[] prompts are supported',
    );
  }
  if (
    options.output !== undefined ||
    options.experimental_output !== undefined ||
    options.prepareStep !== undefined
  ) {
    throw new UnsupportedRemoteStepError(
      'unsupported-structured-output',
      'structured output and prepareStep are not supported',
    );
  }
  if (
    options.experimental_onStart ||
    options.experimental_onStepStart ||
    options.experimental_onToolCallStart ||
    options.experimental_onToolCallFinish ||
    options.onChunk ||
    options.onStepFinish
  ) {
    throw new UnsupportedRemoteStepError(
      'unsupported-callback',
      'additional stream lifecycle callbacks are not supported',
    );
  }

  const { systemPrompt, messages } = serializeModelMessages(options.messages);
  const tools = (options.tools ?? {}) as ToolSet;
  const { definitions, modelTools } = await prepareTools(tools);
  const metadata = toAgentTurnJsonObject(executionRequest.context.metadata);
  const settings: IsolatedAgentTurnRequest['settings'] = {};
  if (options.maxOutputTokens !== undefined) {
    settings.maxOutputTokens = options.maxOutputTokens;
  }
  if (options.temperature !== undefined) {
    settings.temperature = options.temperature;
  }

  const request: IsolatedAgentTurnRequest = {
    agentInstanceId: executionRequest.context.agentInstanceId,
    modelId: executionRequest.context.resolvedModelId,
    traceId: executionRequest.context.traceId,
    metadata,
    systemPrompt,
    messages,
    tools: definitions,
    // BaseAgent intentionally owns continuation and persistence one step at
    // a time. The utility process owns this step's model/tool loop.
    maxSteps: 1,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };

  const handlers = createPerTurnHandlers({
    executionRequest,
    modelTools,
    tools,
    streamTextFn,
    assertLocalExecutionAllowed,
  });
  return { request, handlers };
}

/**
 * Serializes the host-owned model/tool step into the same bounded protocol
 * used by the isolated runtime. Cloud adapters reuse this contract rather
 * than attempting to serialize executable tool functions directly.
 */
export async function serializeAgentStepExecutionRequestForRemote(
  executionRequest: AgentStepExecutionRequest,
): Promise<IsolatedAgentTurnRequest> {
  return (await prepareRemoteStep(executionRequest, streamText)).request;
}

function createPerTurnHandlers({
  executionRequest,
  modelTools,
  tools,
  streamTextFn,
  assertLocalExecutionAllowed,
}: {
  executionRequest: AgentStepExecutionRequest;
  modelTools: ToolSet;
  tools: ToolSet;
  streamTextFn: typeof streamText;
  assertLocalExecutionAllowed: (agentInstanceId: string) => void;
}): AgentTurnHostHandlers {
  const originalOptions = executionRequest.options;
  const toolMessages = (originalOptions.messages as ModelMessage[]).filter(
    (message) => message.role !== 'system',
  );
  const fileEditBatchCoordinator = new FileEditBatchCoordinator();
  let latestModelToolCalls: IsolatedAgentToolCall[] = [];
  const claimedModelToolCallIds = new Set<string>();

  return {
    async callModel(_request, { signal, onEvent }) {
      // A new model call revokes every prior per-call admission immediately,
      // including when the provider request later fails.
      latestModelToolCalls = [];
      claimedModelToolCallIds.clear();
      const {
        onAbort: _onAbort,
        onError: _onError,
        onFinish: _onFinish,
        tools: _tools,
        abortSignal: originalSignal,
        ...modelOptions
      } = originalOptions;
      assertLocalExecutionAllowed(executionRequest.context.agentInstanceId);
      const result = streamTextFn({
        ...modelOptions,
        tools: modelTools,
        abortSignal: combineAbortSignals(originalSignal, signal),
      });

      let text = '';
      let reasoning = '';
      let finishReason = 'other';
      let rawFinishReason: string | undefined;
      let usage: IsolatedAgentUsage = {};
      let providerMetadata: AgentTurnJsonObject | undefined;
      const toolCalls: IsolatedAgentModelCallResult['toolCalls'] = [];
      const rejectedToolCalls: IsolatedAgentRejectedToolCall[] = [];

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text;
            onEvent({ type: 'text-delta', text: part.text });
            break;
          case 'reasoning-delta':
            reasoning += part.text;
            onEvent({ type: 'reasoning-delta', text: part.text });
            break;
          case 'tool-call':
            if (part.invalid) {
              const kind =
                findToolCallRecoverySignal([part])?.kind ?? 'invalid-input';
              rejectedToolCalls.push({
                toolCallId: part.toolCallId,
                toolName: Object.hasOwn(modelTools, part.toolName)
                  ? part.toolName
                  : 'unknown',
                kind,
                message: createIsolatedToolCallRejectionMessage(kind),
              });
              break;
            }
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: toAgentTurnJsonValue(part.input),
            });
            break;
          case 'tool-error':
            // The matching invalid tool-call is represented above as a
            // non-executable rejection. Never promote the SDK's tool-error
            // companion into an isolated callTool request.
            break;
          case 'finish-step':
            finishReason = String(part.finishReason);
            rawFinishReason = part.rawFinishReason;
            usage = normalizeUsage(part.usage);
            providerMetadata = toOptionalAgentTurnJsonObject(
              part.providerMetadata,
            );
            break;
          case 'finish':
            finishReason = String(part.finishReason);
            rawFinishReason = part.rawFinishReason;
            usage = normalizeUsage(part.totalUsage);
            break;
          case 'abort':
            throw new DOMException(
              part.reason ?? 'Isolated model call was aborted',
              'AbortError',
            );
          case 'error':
            throw normalizeError(part.error);
        }
      }

      const normalizedCalls = rejectDuplicateIsolatedToolCallIds(
        toolCalls,
        rejectedToolCalls,
        new Set(Object.keys(modelTools)),
      );
      latestModelToolCalls = normalizedCalls.toolCalls;

      return {
        text,
        reasoning,
        toolCalls: normalizedCalls.toolCalls,
        ...(normalizedCalls.rejectedToolCalls.length > 0
          ? { rejectedToolCalls: normalizedCalls.rejectedToolCalls }
          : {}),
        finishReason,
        rawFinishReason,
        usage,
        providerMetadata,
      };
    },

    async callTool(request, { signal }) {
      let fileEditBatchParticipant: FileEditBatchParticipant | undefined;
      let terminalOutcome: FileEditBatchTerminalOutcome = 'error';
      try {
        const admittedCall = latestModelToolCalls.find(
          (call) => call.toolCallId === request.call.toolCallId,
        );
        if (
          !admittedCall ||
          claimedModelToolCallIds.has(request.call.toolCallId) ||
          admittedCall.toolName !== request.call.toolName ||
          JSON.stringify(admittedCall.input) !==
            JSON.stringify(request.call.input)
        ) {
          throw new Error(
            'Isolated tool call was not uniquely admitted by the current model step',
          );
        }
        // Claim before approval checks or execution. A replay after any
        // terminal outcome must never reach tool lifecycle callbacks twice.
        claimedModelToolCallIds.add(request.call.toolCallId);

        if (request.fileEditBatch) {
          fileEditBatchParticipant = fileEditBatchCoordinator.getParticipant(
            request.fileEditBatch,
          );
          try {
            assertExactFileEditBatchMetadata(
              request.fileEditBatch,
              request.call,
              latestModelToolCalls,
            );
          } catch (error) {
            fileEditBatchCoordinator.abort(request.fileEditBatch.batchId);
            throw error;
          }
        }

        assertLocalExecutionAllowed(executionRequest.context.agentInstanceId);
        const resolvedTool = tools[request.call.toolName] as Tool | undefined;
        if (!resolvedTool?.execute) {
          return {
            status: 'error',
            message: `Tool "${request.call.toolName}" is unavailable or has no executor`,
          };
        }

        const executionOptions = {
          toolCallId: request.call.toolCallId,
          messages: toolMessages,
          abortSignal: combineAbortSignals(originalOptions.abortSignal, signal),
          experimental_context: originalOptions.experimental_context,
          fileEditBatchParticipant,
        };

        await resolvedTool.onInputStart?.(executionOptions);
        await resolvedTool.onInputDelta?.({
          ...executionOptions,
          inputTextDelta: JSON.stringify(request.call.input),
        });
        await resolvedTool.onInputAvailable?.({
          ...executionOptions,
          input: request.call.input,
        });

        const needsApproval =
          typeof resolvedTool.needsApproval === 'function'
            ? await resolvedTool.needsApproval(
                request.call.input,
                executionOptions,
              )
            : resolvedTool.needsApproval === true;
        if (needsApproval) {
          terminalOutcome = 'approval-required';
          return {
            status: 'approval-required',
            approvalId: randomUUID(),
          };
        }

        assertLocalExecutionAllowed(executionRequest.context.agentInstanceId);
        const output = await collectToolOutput(
          resolvedTool.execute(request.call.input, executionOptions),
        );
        const completed = {
          status: 'completed',
          output: toAgentTurnJsonValue(output),
        } as const;
        terminalOutcome = terminalOutcomeForToolResult(
          completed,
          signal.aborted,
        );
        return completed;
      } catch (error) {
        const normalized = normalizeError(error);
        terminalOutcome =
          signal.aborted || isAbortError(normalized) ? 'aborted' : 'error';
        return {
          status: 'error',
          message: normalized.message,
        };
      } finally {
        fileEditBatchParticipant?.settle(terminalOutcome);
      }
    },
  };
}

async function prepareTools(tools: ToolSet): Promise<{
  definitions: IsolatedAgentTurnRequest['tools'];
  modelTools: ToolSet;
}> {
  const definitions: IsolatedAgentTurnRequest['tools'] = [];
  const modelTools: ToolSet = {};

  for (const [name, resolvedTool] of Object.entries(tools)) {
    if (resolvedTool.type === 'provider' || resolvedTool.type === 'dynamic') {
      throw new UnsupportedRemoteStepError(
        'unsupported-tool-type',
        `tool "${name}" uses unsupported type "${resolvedTool.type}"`,
      );
    }
    if (!resolvedTool.execute) {
      throw new UnsupportedRemoteStepError(
        'tool-without-executor',
        `tool "${name}" has no main-host executor`,
      );
    }

    let schema: unknown;
    try {
      schema = await asSchema(resolvedTool.inputSchema).jsonSchema;
    } catch (error) {
      throw new UnsupportedRemoteStepError(
        'schema-serialization-failed',
        `tool "${name}" input schema could not be serialized: ${normalizeError(error).message}`,
      );
    }
    const inputSchema = toAgentTurnJsonValue(schema);
    if (
      inputSchema === null ||
      Array.isArray(inputSchema) ||
      typeof inputSchema !== 'object'
    ) {
      throw new UnsupportedRemoteStepError(
        'schema-serialization-failed',
        `tool "${name}" produced a non-object JSON schema`,
      );
    }
    definitions.push({
      name,
      description: resolvedTool.description,
      inputSchema: inputSchema as AgentTurnJsonObject,
      strict: resolvedTool.strict,
    });

    const {
      execute: _execute,
      needsApproval: _needsApproval,
      toModelOutput: _toModelOutput,
      onInputStart: _onInputStart,
      onInputDelta: _onInputDelta,
      onInputAvailable: _onInputAvailable,
      outputSchema: _outputSchema,
      ...definitionOnlyTool
    } = resolvedTool;
    modelTools[name] = definitionOnlyTool as ToolSet[string];
  }

  return { definitions, modelTools };
}

function serializeModelMessages(messages: ModelMessage[]): {
  systemPrompt: string;
  messages: IsolatedAgentConversationMessage[];
} {
  const systemPrompts: string[] = [];
  const serialized: IsolatedAgentConversationMessage[] = [];

  for (const message of messages) {
    if (
      message.providerOptions !== undefined &&
      !isCacheControlOnlyProviderOptions(message.providerOptions)
    ) {
      throw new UnsupportedRemoteStepError(
        'unsupported-provider-options',
        `${message.role} message contains provider options`,
      );
    }

    switch (message.role) {
      case 'system':
        systemPrompts.push(message.content);
        break;
      case 'user': {
        if (typeof message.content === 'string') {
          serialized.push({ role: 'user', content: message.content });
          break;
        }
        const text: string[] = [];
        for (const part of message.content) {
          if (part.type !== 'text') {
            throw new UnsupportedRemoteStepError(
              'unsupported-multimodal-content',
              'user message contains non-text content',
            );
          }
          if (
            part.providerOptions !== undefined &&
            !isCacheControlOnlyProviderOptions(part.providerOptions)
          ) {
            throw new UnsupportedRemoteStepError(
              'unsupported-provider-options',
              'user message contains provider-specific content',
            );
          }
          text.push(part.text);
        }
        serialized.push({ role: 'user', content: text.join('') });
        break;
      }
      case 'assistant': {
        if (typeof message.content === 'string') {
          serialized.push({
            role: 'assistant',
            text: message.content,
            toolCalls: [],
          });
          break;
        }
        let text = '';
        const toolCalls: IsolatedAgentToolCall[] = [];
        for (const part of message.content) {
          if (
            'providerOptions' in part &&
            part.providerOptions !== undefined &&
            !isCacheControlOnlyProviderOptions(part.providerOptions)
          ) {
            throw new UnsupportedRemoteStepError(
              'unsupported-provider-options',
              'assistant content contains provider options',
            );
          }
          if (part.type === 'text') {
            text += part.text;
          } else if (part.type === 'tool-call') {
            if (part.providerExecuted) {
              throw new UnsupportedRemoteStepError(
                'unsupported-tool-type',
                'provider-executed tool calls are not supported',
              );
            }
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: toAgentTurnJsonValue(part.input),
            });
          } else {
            throw new UnsupportedRemoteStepError(
              'unsupported-message-content',
              `assistant content type "${part.type}" is not supported`,
            );
          }
        }
        serialized.push({ role: 'assistant', text, toolCalls });
        break;
      }
      case 'tool':
        for (const part of message.content) {
          if (part.type !== 'tool-result') {
            throw new UnsupportedRemoteStepError(
              'unsupported-tool-content',
              'tool approvals are not supported',
            );
          }
          if (
            (part.providerOptions !== undefined &&
              !isCacheControlOnlyProviderOptions(part.providerOptions)) ||
            ('providerOptions' in part.output &&
              part.output.providerOptions !== undefined &&
              !isCacheControlOnlyProviderOptions(part.output.providerOptions))
          ) {
            throw new UnsupportedRemoteStepError(
              'unsupported-provider-options',
              'tool content contains provider options',
            );
          }
          if (part.output.type === 'text') {
            serialized.push({
              role: 'tool',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output.value,
            });
          } else if (part.output.type === 'json') {
            serialized.push({
              role: 'tool',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: toAgentTurnJsonValue(part.output.value),
            });
          } else {
            throw new UnsupportedRemoteStepError(
              'unsupported-tool-content',
              `tool result type "${part.output.type}" is not supported`,
            );
          }
        }
        break;
    }
  }

  return {
    systemPrompt: systemPrompts.join('\n\n'),
    messages: serialized,
  };
}

function handleRemoteEvent<UI_MESSAGE extends UIMessage>(
  event: IsolatedAgentTurnEvent,
  states: Map<number, StreamedStepState>,
  write: (chunk: InferUIMessageChunk<UI_MESSAGE>) => void,
): void {
  const state = getStepState(states, event.step);

  switch (event.type) {
    case 'step-started':
      write({ type: 'start-step' } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    case 'text-delta': {
      const id = `isolated-text-${event.step}`;
      if (!state.textStarted) {
        state.textStarted = true;
        write({ type: 'text-start', id } as InferUIMessageChunk<UI_MESSAGE>);
      }
      write({
        type: 'text-delta',
        id,
        delta: event.text,
      } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    }
    case 'reasoning-delta': {
      const id = `isolated-reasoning-${event.step}`;
      if (!state.reasoningStarted) {
        state.reasoningStarted = true;
        write({
          type: 'reasoning-start',
          id,
        } as InferUIMessageChunk<UI_MESSAGE>);
      }
      write({
        type: 'reasoning-delta',
        id,
        delta: event.text,
      } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    }
    case 'tool-call':
      closeOpenParts(event.step, states, write);
      write({
        type: 'tool-input-available',
        toolCallId: event.call.toolCallId,
        toolName: event.call.toolName,
        input: event.call.input,
      } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    case 'tool-result':
      write({
        type: 'tool-output-available',
        toolCallId: event.toolCallId,
        output: event.output,
      } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    case 'tool-error':
      write({
        type: 'tool-output-error',
        toolCallId: event.toolCallId,
        errorText: event.message,
      } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    case 'tool-approval-request':
      write({
        type: 'tool-approval-request',
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
      } as InferUIMessageChunk<UI_MESSAGE>);
      break;
    case 'step-finished':
      closeOpenParts(event.step, states, write);
      write({ type: 'finish-step' } as InferUIMessageChunk<UI_MESSAGE>);
      break;
  }
}

function closeOpenParts<UI_MESSAGE extends UIMessage>(
  step: number,
  states: Map<number, StreamedStepState>,
  write: (chunk: InferUIMessageChunk<UI_MESSAGE>) => void,
): void {
  const state = getStepState(states, step);
  if (state.textStarted) {
    write({
      type: 'text-end',
      id: `isolated-text-${step}`,
    } as InferUIMessageChunk<UI_MESSAGE>);
    state.textStarted = false;
  }
  if (state.reasoningStarted) {
    write({
      type: 'reasoning-end',
      id: `isolated-reasoning-${step}`,
    } as InferUIMessageChunk<UI_MESSAGE>);
    state.reasoningStarted = false;
  }
}

function getStepState(
  states: Map<number, StreamedStepState>,
  step: number,
): StreamedStepState {
  let state = states.get(step);
  if (!state) {
    state = {
      textStarted: false,
      reasoningStarted: false,
    };
    states.set(step, state);
  }
  return state;
}

function createStepResult(
  step: IsolatedAgentTurnStepResult,
  executionRequest: AgentStepExecutionRequest,
  toolCallIdentity: 'provider' | 'external' = 'provider',
  toolCallIdentityNamespace?: string,
): StepResult<ToolSet> {
  const idBindings = bindStepToolCallIds(
    step,
    toolCallIdentity,
    toolCallIdentityNamespace,
  );
  const toolCalls = step.toolCalls.map((call, index) => ({
    type: 'tool-call' as const,
    toolCallId: idBindings.toolCallIds[index]!,
    providerToolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  }));
  const callsById = new Map(toolCalls.map((call) => [call.toolCallId, call]));
  const content: StepResult<ToolSet>['content'] = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  if (step.reasoning) {
    content.push({ type: 'reasoning', text: step.reasoning });
  }
  content.push(...toolCalls);
  for (const [index, rejected] of (step.rejectedToolCalls ?? []).entries()) {
    const error = new Error(rejected.message);
    const toolCallId = idBindings.rejectedToolCallIds[index]!;
    content.push({
      type: 'tool-call',
      toolCallId,
      providerToolCallId: rejected.toolCallId,
      toolName: rejected.toolName,
      input: {},
      invalid: true,
      error,
    } as unknown as StepResult<ToolSet>['content'][number]);
    content.push({
      type: 'tool-error',
      toolCallId,
      providerToolCallId: rejected.toolCallId,
      toolName: rejected.toolName,
      input: {},
      error,
    } as unknown as StepResult<ToolSet>['content'][number]);
  }
  for (const [index, result] of step.toolResults.entries()) {
    const toolCallId = idBindings.toolResultIds[index]!;
    content.push({
      type: 'tool-result',
      toolCallId,
      providerToolCallId: result.toolCallId,
      toolName: result.toolName,
      input:
        callsById.get(toolCallId)?.input ??
        findProviderToolCallInput(step, result.toolCallId, result.toolName) ??
        {},
      output: result.output,
    } as StepResult<ToolSet>['content'][number]);
  }
  for (const [index, result] of step.toolErrors.entries()) {
    const toolCallId = idBindings.toolErrorIds[index]!;
    content.push({
      type: 'tool-error',
      toolCallId,
      providerToolCallId: result.toolCallId,
      toolName: result.toolName,
      input:
        callsById.get(toolCallId)?.input ??
        findProviderToolCallInput(step, result.toolCallId, result.toolName) ??
        {},
      error: new Error(result.message),
    } as StepResult<ToolSet>['content'][number]);
  }
  for (const [index, approval] of step.approvalRequests.entries()) {
    const toolCall = callsById.get(idBindings.approvalRequestIds[index]!);
    if (!toolCall) continue;
    content.push({
      type: 'tool-approval-request',
      approvalId: approval.approvalId,
      toolCall,
    });
  }

  const usage = toLanguageModelUsage(step.usage);
  const providerMetadata = step.providerMetadata as
    | ProviderMetadata
    | undefined;
  const finishReason = normalizeFinishReason(step.finishReason);
  const model = executionRequest.options.model as {
    provider?: string;
    modelId?: string;
  };

  const result = {
    stepNumber: Math.max(0, step.index - 1),
    model: {
      provider: model.provider ?? 'isolated',
      modelId: model.modelId ?? executionRequest.context.resolvedModelId,
    },
    functionId: undefined,
    metadata: executionRequest.context.metadata,
    experimental_context: executionRequest.options.experimental_context,
    content,
    text: step.text,
    reasoning: step.reasoning
      ? [{ type: 'reasoning' as const, text: step.reasoning }]
      : [],
    reasoningText: step.reasoning || undefined,
    files: [],
    sources: [],
    toolCalls,
    staticToolCalls: toolCalls,
    dynamicToolCalls: [],
    toolResults: content.filter((part) => part.type === 'tool-result'),
    staticToolResults: content.filter((part) => part.type === 'tool-result'),
    dynamicToolResults: [],
    finishReason,
    rawFinishReason: step.rawFinishReason,
    usage,
    warnings: undefined,
    request: {},
    response: {
      id:
        toolCallIdentity === 'external'
          ? `clodex-external-response:${toolCallIdentityNamespace}`
          : randomUUID(),
      timestamp: new Date(),
      modelId: executionRequest.context.resolvedModelId,
      messages: [],
    },
    providerMetadata,
  };
  return result as StepResult<ToolSet>;
}

export function createAgentStepResultFromIsolatedStep(
  step: IsolatedAgentTurnStepResult,
  executionRequest: AgentStepExecutionRequest,
  identity: {
    executionId: string;
    terminalSequence: number;
    stepOrdinal: number;
  },
): StepResult<ToolSet> {
  // A cloud/external worker may already have executed effects before the
  // desktop sees its terminal result. Always replace provider ids with
  // host-owned per-result identities so duplicate or reused remote ids cannot
  // collapse Evidence Memory ingestion keys.
  return createStepResult(
    step,
    executionRequest,
    'external',
    createExternalStepResultNamespace(step, identity),
  );
}

type StepToolCallIdBindings = {
  toolCallIds: string[];
  rejectedToolCallIds: string[];
  toolResultIds: string[];
  toolErrorIds: string[];
  approvalRequestIds: string[];
};

function bindStepToolCallIds(
  step: IsolatedAgentTurnStepResult,
  identity: 'provider' | 'external',
  durableExternalNamespace?: string,
): StepToolCallIdBindings {
  const namespace =
    identity === 'external'
      ? requireDurableExternalNamespace(durableExternalNamespace)
      : randomUUID();
  const usedIds = new Set<string>();
  const claimedCallIndexes = new Set<number>();
  const providerIdCounts = new Map<string, number>();
  for (const call of step.toolCalls) {
    providerIdCounts.set(
      call.toolCallId,
      (providerIdCounts.get(call.toolCallId) ?? 0) + 1,
    );
  }

  const generatedId = (kind: string, index: number): string => {
    let attempt = 0;
    while (true) {
      const suffix = attempt === 0 ? '' : `:${attempt}`;
      const candidate = `clodex-${identity}:${namespace}:${kind}:${index}${suffix}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
      attempt++;
    }
  };
  const claimProviderOrGeneratedId = (
    providerId: string,
    kind: string,
    index: number,
  ): string => {
    if (identity === 'provider' && !usedIds.has(providerId)) {
      usedIds.add(providerId);
      return providerId;
    }
    return generatedId(kind, index);
  };

  const toolCallIds = step.toolCalls.map((call, index) => {
    if (
      identity === 'provider' &&
      providerIdCounts.get(call.toolCallId) === 1 &&
      !usedIds.has(call.toolCallId)
    ) {
      usedIds.add(call.toolCallId);
      return call.toolCallId;
    }
    return generatedId('call', index);
  });

  const resolveTerminalId = (
    providerId: string,
    toolName: string,
    kind: string,
    index: number,
  ): string => {
    let callIndex = step.toolCalls.findIndex(
      (call, candidateIndex) =>
        !claimedCallIndexes.has(candidateIndex) &&
        call.toolCallId === providerId &&
        call.toolName === toolName,
    );
    if (callIndex < 0) {
      callIndex = step.toolCalls.findIndex(
        (call, candidateIndex) =>
          !claimedCallIndexes.has(candidateIndex) &&
          call.toolCallId === providerId,
      );
    }
    if (callIndex >= 0) {
      claimedCallIndexes.add(callIndex);
      return toolCallIds[callIndex]!;
    }
    return claimProviderOrGeneratedId(providerId, kind, index);
  };

  const toolResultIds = step.toolResults.map((result, index) =>
    resolveTerminalId(
      result.toolCallId,
      result.toolName,
      'orphan-result',
      index,
    ),
  );
  const toolErrorIds = step.toolErrors.map((result, index) =>
    resolveTerminalId(
      result.toolCallId,
      result.toolName,
      'orphan-error',
      index,
    ),
  );
  const approvalRequestIds = step.approvalRequests.map((approval, index) =>
    resolveTerminalId(
      approval.toolCallId,
      approval.toolName,
      'orphan-approval',
      index,
    ),
  );
  const rejectedToolCallIds = (step.rejectedToolCalls ?? []).map(
    (rejected, index) =>
      claimProviderOrGeneratedId(rejected.toolCallId, 'rejected', index),
  );

  return {
    toolCallIds,
    rejectedToolCallIds,
    toolResultIds,
    toolErrorIds,
    approvalRequestIds,
  };
}

function createExternalStepResultNamespace(
  step: IsolatedAgentTurnStepResult,
  identity: {
    executionId: string;
    terminalSequence: number;
    stepOrdinal: number;
  },
): string {
  if (identity.executionId.trim().length === 0) {
    throw new Error('External step result execution id is unavailable');
  }
  if (
    !Number.isSafeInteger(identity.terminalSequence) ||
    identity.terminalSequence < 0
  ) {
    throw new Error('External step result terminal sequence is invalid');
  }
  if (!Number.isSafeInteger(identity.stepOrdinal) || identity.stepOrdinal < 0) {
    throw new Error('External step result ordinal is invalid');
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        executionId: identity.executionId,
        terminalSequence: identity.terminalSequence,
        stepIndex: step.index,
        stepOrdinal: identity.stepOrdinal,
      }),
    )
    .digest('hex');
}

function requireDurableExternalNamespace(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('External step result identity namespace is invalid');
  }
  return value;
}

function findProviderToolCallInput(
  step: IsolatedAgentTurnStepResult,
  providerToolCallId: string,
  toolName: string,
): AgentTurnJsonValue | undefined {
  return (
    step.toolCalls.find(
      (call) =>
        call.toolCallId === providerToolCallId && call.toolName === toolName,
    )?.input ??
    step.toolCalls.find((call) => call.toolCallId === providerToolCallId)?.input
  );
}

function normalizeFinishReason(value: string): FinishReason {
  switch (value) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
      return value;
    default:
      return 'other';
  }
}

function toLanguageModelUsage(usage: IsolatedAgentUsage): LanguageModelUsage {
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: usage.noCacheInputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheWriteInputTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: usage.textOutputTokens,
      reasoningTokens: usage.reasoningOutputTokens,
    },
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cacheReadInputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
  };
}

function normalizeUsage(value: LanguageModelUsage): IsolatedAgentUsage {
  return {
    inputTokens: finiteNonNegative(value.inputTokens),
    outputTokens: finiteNonNegative(value.outputTokens),
    totalTokens: finiteNonNegative(value.totalTokens),
    noCacheInputTokens: finiteNonNegative(
      value.inputTokenDetails.noCacheTokens,
    ),
    cacheReadInputTokens: finiteNonNegative(
      value.inputTokenDetails.cacheReadTokens,
    ),
    cacheWriteInputTokens: finiteNonNegative(
      value.inputTokenDetails.cacheWriteTokens,
    ),
    textOutputTokens: finiteNonNegative(value.outputTokenDetails.textTokens),
    reasoningOutputTokens: finiteNonNegative(
      value.outputTokenDetails.reasoningTokens,
    ),
  };
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

async function collectToolOutput(value: unknown): Promise<unknown> {
  const resolved = await value;
  if (!isAsyncIterable(resolved)) return resolved;

  let latest: unknown = null;
  for await (const item of resolved) latest = item;
  return latest;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

function getTotalTimeoutMs(
  timeout:
    | number
    | { totalMs?: number; stepMs?: number; chunkMs?: number }
    | undefined,
): number | undefined {
  return typeof timeout === 'number' ? timeout : timeout?.totalMs;
}

function toAgentTurnJsonObject(
  value: Record<string, unknown>,
): AgentTurnJsonObject {
  const converted = toAgentTurnJsonValue(value);
  if (
    converted === null ||
    Array.isArray(converted) ||
    typeof converted !== 'object'
  ) {
    throw new UnsupportedRemoteStepError(
      'metadata-serialization-failed',
      'step metadata is not JSON-serializable',
    );
  }
  return converted as AgentTurnJsonObject;
}

function toOptionalAgentTurnJsonObject(
  value: unknown,
): AgentTurnJsonObject | undefined {
  if (value === undefined) return undefined;
  const converted = toAgentTurnJsonValue(value);
  return converted !== null &&
    !Array.isArray(converted) &&
    typeof converted === 'object'
    ? (converted as AgentTurnJsonObject)
    : undefined;
}

function toAgentTurnJsonValue(value: unknown): AgentTurnJsonValue {
  if (isAgentTurnJsonValue(value)) return value;

  try {
    const serialized = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return entry.toString();
      if (entry instanceof Error) {
        return {
          name: entry.name,
          message: entry.message,
          stack: entry.stack,
        };
      }
      return entry;
    });
    if (serialized !== undefined) {
      const parsed: unknown = JSON.parse(serialized);
      if (isAgentTurnJsonValue(parsed)) return parsed;
    }
  } catch {}

  return String(value);
}

function isCacheControlOnlyProviderOptions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'anthropic' && key !== 'openaiCompatible')
  ) {
    return false;
  }

  return keys.every((key) => {
    const providerValue = value[key];
    if (!isRecord(providerValue) || Object.keys(providerValue).length !== 1) {
      return false;
    }
    const cacheControl =
      key === 'anthropic'
        ? providerValue.cacheControl
        : providerValue.cache_control;
    return (
      isRecord(cacheControl) &&
      Object.keys(cacheControl).length === 1 &&
      cacheControl.type === 'ephemeral'
    );
  });
}

function assertExactFileEditBatchMetadata(
  metadata: IsolatedAgentFileEditBatchMetadata,
  call: IsolatedAgentToolCall,
  modelToolCalls: readonly IsolatedAgentToolCall[],
): void {
  const memberIndex = Number(metadata.memberId);
  if (!Number.isSafeInteger(memberIndex) || memberIndex < 0) {
    throw new Error(`Invalid file-edit batch member ${metadata.memberId}`);
  }
  const expectedCall = modelToolCalls[memberIndex];
  if (
    !expectedCall ||
    expectedCall.toolCallId !== call.toolCallId ||
    expectedCall.toolName !== call.toolName
  ) {
    throw new Error(
      `File-edit batch member ${metadata.memberId} does not match the model tool call`,
    );
  }

  let start = memberIndex;
  while (
    start > 0 &&
    isNativeFileEditTool(modelToolCalls[start - 1]?.toolName)
  ) {
    start--;
  }
  let end = memberIndex + 1;
  while (
    end < modelToolCalls.length &&
    isNativeFileEditTool(modelToolCalls[end]?.toolName)
  ) {
    end++;
  }
  const expectedMembers = modelToolCalls
    .slice(start, end)
    .map((toolCall, index) => ({
      memberId: String(start + index),
      toolCallId: toolCall.toolCallId,
    }));
  if (
    expectedMembers.length < 2 ||
    JSON.stringify(metadata.members) !== JSON.stringify(expectedMembers)
  ) {
    throw new Error(
      `File-edit batch ${metadata.batchId} does not describe the exact adjacent model-tool run`,
    );
  }
}

function isNativeFileEditTool(toolName: string | undefined): boolean {
  return toolName === 'write' || toolName === 'multiEdit';
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError';
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
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
