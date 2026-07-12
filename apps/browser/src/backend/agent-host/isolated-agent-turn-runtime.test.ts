import { describe, expect, it, vi } from 'vitest';
import type {
  AgentTurnHostHandlers,
  IsolatedAgentTurnEvent,
  IsolatedAgentTurnRequest,
} from './isolated-agent-turn';
import { executeIsolatedAgentTurn } from './isolated-agent-turn-runtime';

const request: IsolatedAgentTurnRequest = {
  agentInstanceId: 'agent-1',
  modelId: 'test-model',
  traceId: 'trace-1',
  metadata: {
    purpose: 'test',
  },
  systemPrompt: 'Use read-only tools.',
  messages: [
    {
      role: 'user',
      content: 'Read the project README.',
    },
  ],
  tools: [
    {
      name: 'read',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
          },
        },
        required: ['path'],
      },
    },
  ],
  maxSteps: 3,
};

describe('executeIsolatedAgentTurn', () => {
  it('owns the model/tool loop and emits ordered streaming events', async () => {
    let modelCall = 0;
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(async (_request, { onEvent }) => {
        modelCall++;
        if (modelCall === 1) {
          onEvent({ type: 'text-delta', text: 'Checking. ' });
          return {
            text: 'Checking. ',
            reasoning: '',
            toolCalls: [
              {
                toolCallId: 'tool-1',
                toolName: 'read',
                input: {
                  path: 'README.md',
                },
              },
            ],
            finishReason: 'tool-calls',
            usage: {
              inputTokens: 10,
              outputTokens: 3,
              totalTokens: 13,
            },
          };
        }

        onEvent({ type: 'text-delta', text: 'The README is concise.' });
        return {
          text: 'The README is concise.',
          reasoning: '',
          toolCalls: [],
          finishReason: 'stop',
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
          },
        };
      }),
      callTool: vi.fn(async () => ({
        output: '# Project',
      })),
    };
    const events: IsolatedAgentTurnEvent[] = [];

    const result = await executeIsolatedAgentTurn(request, {
      handlers,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('Checking. The README is concise.');
    expect(result.steps).toHaveLength(2);
    expect(result.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'tool-1',
      toolName: 'read',
      output: '# Project',
    });
    expect(handlers.callModel).toHaveBeenCalledTimes(2);
    expect(handlers.callTool).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      'step-started',
      'text-delta',
      'tool-call',
      'tool-result',
      'step-finished',
      'step-started',
      'text-delta',
      'step-finished',
    ]);
  });

  it('rejects tool calls that were not declared by the main process', async () => {
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(async () => ({
        text: '',
        reasoning: '',
        toolCalls: [
          {
            toolCallId: 'tool-1',
            toolName: 'write',
            input: {
              path: 'README.md',
              content: 'changed',
            },
          },
        ],
        finishReason: 'tool-calls',
        usage: {},
      })),
      callTool: vi.fn(),
    };

    await expect(
      executeIsolatedAgentTurn(request, { handlers }),
    ).rejects.toThrow('undeclared isolated tool "write"');
    expect(handlers.callTool).not.toHaveBeenCalled();
  });

  it('pauses the turn when the main host requests tool approval', async () => {
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(async () => ({
        text: '',
        reasoning: '',
        toolCalls: [
          {
            toolCallId: 'tool-1',
            toolName: 'read',
            input: {
              path: 'README.md',
            },
          },
        ],
        finishReason: 'tool-calls',
        usage: {},
      })),
      callTool: vi.fn(async () => ({
        status: 'approval-required' as const,
        approvalId: 'approval-1',
      })),
    };
    const events: IsolatedAgentTurnEvent[] = [];

    const result = await executeIsolatedAgentTurn(request, {
      handlers,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.steps[0]?.approvalRequests).toEqual([
      {
        approvalId: 'approval-1',
        toolCallId: 'tool-1',
        toolName: 'read',
      },
    ]);
    expect(events).toContainEqual({
      type: 'tool-approval-request',
      step: 1,
      approvalId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'read',
    });
    expect(handlers.callModel).toHaveBeenCalledOnce();
  });

  it('propagates cancellation into the active host model call', async () => {
    const controller = new AbortController();
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(
        async (_request, { signal }) =>
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
      callTool: vi.fn(),
    };

    const execution = executeIsolatedAgentTurn(request, {
      handlers,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  });
});
