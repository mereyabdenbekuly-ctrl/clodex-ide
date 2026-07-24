import {
  streamText,
  type AsyncIterableStream,
  type InferUIMessageChunk,
  type UIMessage,
  type UIMessageStreamOptions,
} from 'ai';
import { createHash } from 'node:crypto';
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
  /**
   * Attests whether this execution actually used the model object supplied in
   * `AgentStepExecutionRequest.options`. Missing/`external` provenance is
   * fail-closed for lifecycle observers that would otherwise replay a
   * transcript through the wrong provider route.
   */
  readonly modelRouteBinding?: 'request-model' | 'external';
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

export const TOOL_CAPABILITY_CURRENT_SCOPE_CONTEXT_KEY =
  'toolCapabilityCurrentScopeId';
export const TOOL_CAPABILITY_APPROVAL_ORIGIN_SCOPE_CONTEXT_KEY =
  'toolCapabilityApprovalOriginScopeId';

/**
 * Creates a host-owned scope for tool effects. Approval continuations retain
 * the originating scope; ordinary later steps receive a distinct scope.
 * Only host-generated identifiers are hashed, never prompt or tool content.
 */
export function resolveAgentToolCapabilityScopes(input: {
  agentInstanceId: string;
  stepGeneration: number;
  historyMessageIds: readonly string[];
  isApprovalContinuation: boolean;
  pendingApprovalScopeId: string | null;
}): {
  currentScopeId: string;
  approvalOriginScopeId: string | null;
} {
  const approvalOriginScopeId =
    input.isApprovalContinuation &&
    typeof input.pendingApprovalScopeId === 'string' &&
    /^[a-f0-9]{64}$/.test(input.pendingApprovalScopeId)
      ? input.pendingApprovalScopeId
      : null;

  const currentScopeId = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        agentInstanceId: input.agentInstanceId,
        stepGeneration: input.stepGeneration,
        historyMessageIds: input.historyMessageIds,
      }),
    )
    .digest('hex');
  return { currentScopeId, approvalOriginScopeId };
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
    const execution = this.streamTextFn(request.options);
    return {
      modelRouteBinding: 'request-model',
      consumeStream: (options) => execution.consumeStream(options),
      toUIMessageStream<UI_MESSAGE extends UIMessage>(
        options?: UIMessageStreamOptions<UI_MESSAGE>,
      ) {
        return execution.toUIMessageStream<UI_MESSAGE>(options);
      },
    };
  }
}

export const localAgentStepExecutor: AgentStepExecutor =
  new LocalAgentStepExecutor();
