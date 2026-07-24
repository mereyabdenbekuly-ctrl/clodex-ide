import type {
  AgentTurnHostHandlers,
  IsolatedAgentConversationMessage,
  IsolatedAgentFileEditBatchMetadata,
  IsolatedAgentTurnEvent,
  IsolatedAgentTurnRequest,
  IsolatedAgentTurnResult,
  IsolatedAgentTurnStepResult,
} from './isolated-agent-turn';

export interface IsolatedAgentTurnRuntimeOptions {
  signal?: AbortSignal;
  handlers: AgentTurnHostHandlers;
  onEvent?: (event: IsolatedAgentTurnEvent) => void;
}

export async function executeIsolatedAgentTurn(
  request: IsolatedAgentTurnRequest,
  options: IsolatedAgentTurnRuntimeOptions,
): Promise<IsolatedAgentTurnResult> {
  throwIfAborted(options.signal);

  const messages: IsolatedAgentConversationMessage[] = structuredClone(
    request.messages,
  );
  const steps: IsolatedAgentTurnStepResult[] = [];
  const allowedToolNames = new Set(request.tools.map((tool) => tool.name));
  let text = '';

  for (let step = 1; step <= request.maxSteps; step++) {
    throwIfAborted(options.signal);
    options.onEvent?.({ type: 'step-started', step });

    const modelResult = await options.handlers.callModel(
      {
        agentInstanceId: request.agentInstanceId,
        modelId: request.modelId,
        traceId: request.traceId,
        metadata: request.metadata,
        systemPrompt: request.systemPrompt,
        messages,
        tools: request.tools,
        settings: request.settings,
      },
      {
        signal: requireSignal(options.signal),
        onEvent: (event) => {
          options.onEvent?.({ ...event, step });
        },
      },
    );
    throwIfAborted(options.signal);

    text += modelResult.text;
    messages.push({
      role: 'assistant',
      text: modelResult.text,
      toolCalls: modelResult.toolCalls,
    });

    const stepResult: IsolatedAgentTurnStepResult = {
      index: step,
      text: modelResult.text,
      reasoning: modelResult.reasoning,
      finishReason: modelResult.finishReason,
      rawFinishReason: modelResult.rawFinishReason,
      usage: modelResult.usage,
      providerMetadata: modelResult.providerMetadata,
      toolCalls: modelResult.toolCalls,
      toolResults: [],
      toolErrors: [],
      approvalRequests: [],
    };
    steps.push(stepResult);

    for (const call of modelResult.toolCalls) {
      if (!allowedToolNames.has(call.toolName)) {
        throw new Error(
          `Model requested undeclared isolated tool "${call.toolName}"`,
        );
      }
    }

    const executeToolCall = async (
      call: (typeof modelResult.toolCalls)[number],
      signal: AbortSignal,
      fileEditBatch?: IsolatedAgentFileEditBatchMetadata,
    ) => {
      options.onEvent?.({ type: 'tool-call', step, call });
      try {
        const result = await options.handlers.callTool(
          {
            agentInstanceId: request.agentInstanceId,
            call,
            messages,
            ...(fileEditBatch ? { fileEditBatch } : {}),
          },
          { signal },
        );
        throwIfAborted(signal);
        return { call, result };
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        return {
          call,
          result: {
            status: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    };

    const commitToolExecution = (
      execution: Awaited<ReturnType<typeof executeToolCall>>,
    ) => {
      const { call, result } = execution;

      if (result.status === 'approval-required') {
        const approvalRequest = {
          approvalId: result.approvalId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        };
        stepResult.approvalRequests.push(approvalRequest);
        options.onEvent?.({
          type: 'tool-approval-request',
          step,
          ...approvalRequest,
        });
        return;
      }
      if (result.status === 'error') {
        const toolError = {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          message: result.message,
        };
        stepResult.toolErrors.push(toolError);
        messages.push({
          role: 'tool',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            error: result.message,
          },
        });
        options.onEvent?.({
          type: 'tool-error',
          step,
          ...toolError,
        });
        return;
      }

      const toolResult = {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: result.output,
      };
      stepResult.toolResults.push(toolResult);
      messages.push({
        role: 'tool',
        ...toolResult,
      });
      options.onEvent?.({
        type: 'tool-result',
        step,
        ...toolResult,
      });
    };

    // Only adjacent native text-edit proposals may start together. Running
    // arbitrary tools concurrently would reorder shell/filesystem side
    // effects and could execute them before a user has reviewed an edit.
    for (let index = 0; index < modelResult.toolCalls.length; ) {
      const call = modelResult.toolCalls[index]!;
      if (!isConcurrentFileEditTool(call.toolName)) {
        commitToolExecution(
          await executeToolCall(call, requireSignal(options.signal)),
        );
        index++;
        continue;
      }

      let end = index + 1;
      while (
        end < modelResult.toolCalls.length &&
        isConcurrentFileEditTool(modelResult.toolCalls[end]!.toolName)
      ) {
        end++;
      }

      const batchController = new AbortController();
      const abortBatch = () => batchController.abort(options.signal?.reason);
      if (options.signal?.aborted) abortBatch();
      else
        options.signal?.addEventListener('abort', abortBatch, { once: true });
      const executions = modelResult.toolCalls
        .slice(index, end)
        .map((batchCall, batchOffset, batchCalls) => {
          const members = batchCalls.map((memberCall, memberOffset) => ({
            memberId: String(index + memberOffset),
            toolCallId: memberCall.toolCallId,
          }));
          const fileEditBatch =
            batchCalls.length > 1
              ? {
                  batchId: `${request.traceId}:${step}:${index}:${end}`,
                  memberId: String(index + batchOffset),
                  members,
                }
              : undefined;
          return executeToolCall(
            batchCall,
            batchController.signal,
            fileEditBatch,
          );
        });
      try {
        const orderedExecutions = await Promise.all(executions);
        for (const execution of orderedExecutions) {
          commitToolExecution(execution);
        }
      } catch (error) {
        batchController.abort(error);
        await Promise.allSettled(executions);
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', abortBatch);
      }
      throwIfAborted(options.signal);
      index = end;
    }

    options.onEvent?.({
      type: 'step-finished',
      step,
      finishReason: modelResult.finishReason,
      usage: modelResult.usage,
    });

    if (
      modelResult.toolCalls.length === 0 ||
      stepResult.approvalRequests.length > 0
    ) {
      return {
        status: 'completed',
        text,
        messages,
        steps,
      };
    }
  }

  return {
    status: 'max-steps',
    text,
    messages,
    steps,
  };
}

function isConcurrentFileEditTool(toolName: string): boolean {
  return toolName === 'write' || toolName === 'multiEdit';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Isolated agent turn was aborted', 'AbortError');
  }
}
