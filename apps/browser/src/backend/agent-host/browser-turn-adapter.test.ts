import type { AgentHost } from '@clodex/agent-core/host';
import { tool, type Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createBrowserIsolatedAgentTurnHandlers,
  getBrowserIsolatedReadOnlyToolDefinitions,
} from './browser-turn-adapter';
import type { IsolatedAgentModelCallRequest } from './isolated-agent-turn';

const modelRequest: IsolatedAgentModelCallRequest = {
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
      content: 'Read README.md',
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
      },
    },
  ],
};

describe('browser isolated agent turn adapter', () => {
  it('streams normalized model events and tool calls', async () => {
    const getWithOptions = vi.fn(async () => ({
      model: {},
      providerOptions: {
        test: {
          option: true,
        },
      },
      headers: {
        'x-test': 'yes',
      },
      contextWindowSize: 10_000,
      providerMode: 'custom' as const,
    }));
    const streamTextFn = vi.fn(() => ({
      fullStream: createStream([
        {
          type: 'text-delta',
          id: 'text-1',
          text: 'Checking.',
        },
        {
          type: 'reasoning-delta',
          id: 'reasoning-1',
          text: 'Need the file.',
        },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'read',
          input: {
            path: 'README.md',
          },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          rawFinishReason: undefined,
          totalUsage: {
            inputTokens: 10,
            outputTokens: 3,
            totalTokens: 13,
          },
        },
      ]),
    })) as unknown as typeof import('ai').streamText;
    const handlers = createBrowserIsolatedAgentTurnHandlers({
      host: {
        models: {
          getWithOptions,
        } as unknown as AgentHost['models'],
      },
      toolbox: {
        getTool: vi.fn(),
      },
      streamTextFn,
    });
    const events: unknown[] = [];

    const result = await handlers.callModel(modelRequest, {
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({
      text: 'Checking.',
      reasoning: 'Need the file.',
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
    });
    expect(events).toEqual([
      {
        type: 'text-delta',
        text: 'Checking.',
      },
      {
        type: 'reasoning-delta',
        text: 'Need the file.',
      },
    ]);
    expect(getWithOptions).toHaveBeenCalledWith(
      'test-model',
      'trace-1',
      modelRequest.metadata,
    );
  });

  it('describes and executes only allowlisted read-only tools', async () => {
    const execute = vi.fn(async () => ({
      content: '# Project',
    }));
    const readTool = tool({
      description: 'Read a file',
      inputSchema: z.object({
        path: z.string(),
      }),
      execute,
    });
    const getTool = vi.fn(async (toolName: string) =>
      toolName === 'read' ? readTool : null,
    );
    const toolbox = {
      getTool: getTool as (
        toolName: string,
        agentInstanceId: string,
      ) => Promise<Tool | null>,
    };

    const definitions = await getBrowserIsolatedReadOnlyToolDefinitions(
      toolbox,
      'agent-1',
      ['read'],
    );
    expect(definitions).toMatchObject([
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
    ]);

    const handlers = createBrowserIsolatedAgentTurnHandlers({
      host: {
        models: {} as AgentHost['models'],
      },
      toolbox,
      allowedToolNames: ['read'],
    });
    await expect(
      handlers.callTool(
        {
          agentInstanceId: 'agent-1',
          call: {
            toolCallId: 'tool-1',
            toolName: 'read',
            input: {
              path: 'README.md',
            },
          },
          messages: modelRequest.messages,
        },
        {
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({
      output: {
        content: '# Project',
      },
    });
    expect(execute).toHaveBeenCalledWith(
      {
        path: 'README.md',
      },
      expect.objectContaining({
        toolCallId: 'tool-1',
        abortSignal: expect.any(AbortSignal),
      }),
    );

    await expect(
      handlers.callTool(
        {
          agentInstanceId: 'agent-1',
          call: {
            toolCallId: 'tool-2',
            toolName: 'write',
            input: {},
          },
          messages: modelRequest.messages,
        },
        {
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('not allowed');
  });

  it('rejects tools that request approval', async () => {
    const readTool = tool({
      inputSchema: z.object({
        path: z.string(),
      }),
      needsApproval: true,
      execute: vi.fn(),
    });
    const handlers = createBrowserIsolatedAgentTurnHandlers({
      host: {
        models: {} as AgentHost['models'],
      },
      toolbox: {
        getTool: vi.fn(async () => readTool),
      },
      allowedToolNames: ['read'],
    });

    await expect(
      handlers.callTool(
        {
          agentInstanceId: 'agent-1',
          call: {
            toolCallId: 'tool-1',
            toolName: 'read',
            input: {
              path: 'README.md',
            },
          },
          messages: modelRequest.messages,
        },
        {
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('requires approval');
  });
});

function createStream(parts: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  };
}
