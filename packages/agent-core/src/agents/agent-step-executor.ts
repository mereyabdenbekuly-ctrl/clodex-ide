import {
  streamText,
  type AsyncIterableStream,
  type InferUIMessageChunk,
  type UIMessage,
  type UIMessageStreamOptions,
} from 'ai';
import type {
  AgentExecutionTarget,
  AgentTaskSnapshotSelection,
} from './execution-target';

/**
 * Serializable identity and routing data for one agent step.
 *
 * The actual model, tools, callbacks, and abort signal remain in
 * {@link AgentStepExecutionRequest.options}; hosts may use this metadata to
 * route orchestration through another process without teaching agent-core
 * about that process.
 */
export interface AgentStepExecutionContext {
  agentInstanceId: string;
  agentType: string;
  traceId: string;
  requestedModelId: string;
  resolvedModelId: string;
  isApprovalContinuation: boolean;
  executionTarget?: AgentExecutionTarget;
  executionTaskId?: string;
  snapshotSelection?: AgentTaskSnapshotSelection;
  metadata: Record<string, unknown>;
}

export interface AgentStepExecutionRequest {
  context: AgentStepExecutionContext;
  options: Parameters<typeof streamText>[0];
}

/**
 * The subset of an AI SDK `StreamTextResult` consumed by `BaseAgent`.
 *
 * Keeping this surface narrow lets a host provide a remote implementation
 * while the default implementation remains a direct `streamText()` call.
 */
export interface AgentStepExecution {
  consumeStream(options?: {
    onError?: (error: unknown) => void;
  }): PromiseLike<void>;
  toUIMessageStream<UI_MESSAGE extends UIMessage>(
    options?: UIMessageStreamOptions<UI_MESSAGE>,
  ): AsyncIterableStream<InferUIMessageChunk<UI_MESSAGE>>;
}

export interface AgentStepExecutor {
  execute(
    request: AgentStepExecutionRequest,
  ): AgentStepExecution | PromiseLike<AgentStepExecution>;
}

/**
 * Default executor. It intentionally contains no policy and preserves the
 * existing in-process AI SDK behavior byte-for-byte.
 */
export class LocalAgentStepExecutor implements AgentStepExecutor {
  public constructor(
    private readonly streamTextFn: typeof streamText = streamText,
  ) {}

  public execute(request: AgentStepExecutionRequest): AgentStepExecution {
    return this.streamTextFn(request.options);
  }
}

export const localAgentStepExecutor: AgentStepExecutor =
  new LocalAgentStepExecutor();
