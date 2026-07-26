import { describe, expect, it, vi } from 'vitest';
import type {
  AgentTurnHostHandlers,
  IsolatedAgentModelCallResult,
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

const fileEditRequest: IsolatedAgentTurnRequest = {
  ...request,
  systemPrompt: 'Edit files when requested.',
  tools: [
    ...request.tools,
    {
      name: 'write',
      description: 'Write a file',
      inputSchema: { type: 'object' },
    },
    {
      name: 'multiEdit',
      description: 'Edit a file',
      inputSchema: { type: 'object' },
    },
  ],
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

  it('starts adjacent file edits together and commits results in model order', async () => {
    let modelCall = 0;
    const resolveTool = new Map<string, (result: { output: string }) => void>();
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(async (): Promise<IsolatedAgentModelCallResult> => {
        modelCall++;
        return modelCall === 1
          ? {
              text: '',
              reasoning: '',
              toolCalls: [
                {
                  toolCallId: 'tool-1',
                  toolName: 'write',
                  input: { path: 'one.md', content: 'one' },
                },
                {
                  toolCallId: 'tool-2',
                  toolName: 'multiEdit',
                  input: { path: 'two.md', edits: [] },
                },
              ],
              finishReason: 'tool-calls',
              usage: {},
            }
          : {
              text: 'done',
              reasoning: '',
              toolCalls: [],
              finishReason: 'stop',
              usage: {},
            };
      }),
      callTool: vi.fn(
        async ({ call }) =>
          await new Promise<{ output: string }>((resolve) => {
            resolveTool.set(call.toolCallId, resolve);
          }),
      ),
    };
    const events: IsolatedAgentTurnEvent[] = [];

    const execution = executeIsolatedAgentTurn(fileEditRequest, {
      handlers,
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(handlers.callTool).toHaveBeenCalledTimes(2));
    const firstRequest = vi.mocked(handlers.callTool).mock.calls[0]?.[0];
    const secondRequest = vi.mocked(handlers.callTool).mock.calls[1]?.[0];
    expect(firstRequest?.fileEditBatch).toEqual({
      batchId: 'trace-1:1:0:2',
      memberId: '0',
      members: [
        { memberId: '0', toolCallId: 'tool-1' },
        { memberId: '1', toolCallId: 'tool-2' },
      ],
    });
    expect(secondRequest?.fileEditBatch).toEqual({
      batchId: 'trace-1:1:0:2',
      memberId: '1',
      members: [
        { memberId: '0', toolCallId: 'tool-1' },
        { memberId: '1', toolCallId: 'tool-2' },
      ],
    });

    resolveTool.get('tool-2')?.({ output: 'two' });
    await Promise.resolve();
    expect(handlers.callModel).toHaveBeenCalledOnce();
    resolveTool.get('tool-1')?.({ output: 'one' });

    const result = await execution;
    expect(result.steps[0]?.toolResults).toEqual([
      { toolCallId: 'tool-1', toolName: 'write', output: 'one' },
      { toolCallId: 'tool-2', toolName: 'multiEdit', output: 'two' },
    ]);
    expect(
      events
        .filter((event) => event.type === 'tool-result')
        .map((event) => event.toolCallId),
    ).toEqual(['tool-1', 'tool-2']);
  });

  it('keeps non-file tools sequential', async () => {
    let modelCall = 0;
    const resolveTool = new Map<string, (result: { output: string }) => void>();
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(async () => {
        modelCall++;
        return modelCall === 1
          ? {
              text: '',
              reasoning: '',
              toolCalls: [
                {
                  toolCallId: 'read-1',
                  toolName: 'read',
                  input: { path: 'one.md' },
                },
                {
                  toolCallId: 'read-2',
                  toolName: 'read',
                  input: { path: 'two.md' },
                },
              ],
              finishReason: 'tool-calls',
              usage: {},
            }
          : {
              text: 'done',
              reasoning: '',
              toolCalls: [],
              finishReason: 'stop',
              usage: {},
            };
      }),
      callTool: vi.fn(
        async ({ call }) =>
          await new Promise<{ output: string }>((resolve) => {
            resolveTool.set(call.toolCallId, resolve);
          }),
      ),
    };

    const execution = executeIsolatedAgentTurn(request, { handlers });
    await vi.waitFor(() => expect(handlers.callTool).toHaveBeenCalledOnce());
    expect(resolveTool.has('read-2')).toBe(false);
    resolveTool.get('read-1')?.({ output: 'one' });
    await vi.waitFor(() => expect(handlers.callTool).toHaveBeenCalledTimes(2));
    resolveTool.get('read-2')?.({ output: 'two' });

    const result = await execution;
    expect(result.steps[0]?.toolResults.map((item) => item.toolCallId)).toEqual(
      ['read-1', 'read-2'],
    );
  });

  it('rejects tool calls that were not declared by the main process', async () => {
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(
        async (): Promise<IsolatedAgentModelCallResult> => ({
          text: '',
          reasoning: '',
          toolCalls: [
            {
              toolCallId: 'tool-allowed',
              toolName: 'read',
              input: { path: 'README.md' },
            },
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
        }),
      ),
      callTool: vi.fn(),
    };

    await expect(
      executeIsolatedAgentTurn(request, { handlers }),
    ).rejects.toThrow('undeclared isolated tool "write"');
    expect(handlers.callTool).not.toHaveBeenCalled();
  });

  it('rejects duplicate provider tool-call ids before any local effect', async () => {
    const handlers: AgentTurnHostHandlers = {
      callModel: vi.fn(
        async (): Promise<IsolatedAgentModelCallResult> => ({
          text: '',
          reasoning: '',
          toolCalls: [
            {
              toolCallId: 'duplicate-id',
              toolName: 'read',
              input: { path: 'one.md' },
            },
            {
              toolCallId: 'duplicate-id',
              toolName: 'read',
              input: { path: 'two.md' },
            },
          ],
          finishReason: 'tool-calls',
          usage: {},
        }),
      ),
      callTool: vi.fn(async () => ({ output: 'must not run' })),
    };
    const events: IsolatedAgentTurnEvent[] = [];

    const result = await executeIsolatedAgentTurn(request, {
      handlers,
      onEvent: (event) => events.push(event),
    });

    expect(handlers.callTool).not.toHaveBeenCalled();
    expect(result.steps[0]?.toolCalls).toEqual([]);
    expect(result.steps[0]?.rejectedToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'duplicate-id',
        toolName: 'read',
        kind: 'invalid-input',
        message: expect.stringContaining('reused a tool-call identifier'),
      }),
    ]);
    expect(events.filter((event) => event.type === 'tool-call')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'tool-error')).toHaveLength(
      1,
    );
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
