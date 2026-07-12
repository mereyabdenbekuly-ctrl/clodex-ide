import type {
  AgentTurnHostHandlers,
  IsolatedAgentConversationMessage,
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

      options.onEvent?.({ type: 'tool-call', step, call });
      const result = await options.handlers.callTool(
        {
          agentInstanceId: request.agentInstanceId,
          call,
          messages,
        },
        {
          signal: requireSignal(options.signal),
        },
      );
      throwIfAborted(options.signal);

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
        continue;
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
        continue;
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

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Isolated agent turn was aborted', 'AbortError');
  }
}
