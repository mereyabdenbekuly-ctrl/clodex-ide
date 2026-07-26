import { describe, it, expect, vi } from 'vitest';
import {
  NoSuchToolError,
  simulateReadableStream,
  streamText,
  tool,
  type Tool,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { findToolCallRecoverySignal, repairToolCall } from './repair-tool-call';

function makeFakeTool(): Tool {
  return tool({
    description: 'Fake tool for repair-handler tests',
    inputSchema: z.object({
      explanation: z.string(),
      count: z.number().int().max(10).optional(),
    }),
  });
}

function makeToolCall(toolName: string, input: string) {
  return {
    toolName,
    input,
    toolCallId: 'call_test',
    type: 'tool-call' as const,
  };
}

// The repair handler receives extra fields at runtime (messages, system,
// toolCallId, inputSchema, etc.). Our implementation only reads toolCall,
// tools, and error, so the tests construct the minimal shape it consumes.

describe('repairToolCall', () => {
  it('returns null and marks NoSuchToolError for bounded next-step recovery', async () => {
    const tools = { fake: makeFakeTool() };
    const noSuchTool = new NoSuchToolError({ toolName: 'nope' });

    const result = await repairToolCall({
      toolCall: makeToolCall('nope', '{}'),
      tools,
      error: noSuchTool,
    });

    expect(result).toBeNull();
    expect(noSuchTool.message).toMatch(
      /^Recoverable tool call rejection \(unknown-tool\):/,
    );
  });

  it('annotates valid JSON schema failures without throwing from the repair callback', async () => {
    const tools = { fake: makeFakeTool() };
    // Missing `explanation` (required) and `count` over the max.
    const invalidInput = JSON.stringify({ count: 50 });
    const error = new Error('upstream schema error');

    await expect(
      repairToolCall({
        toolCall: makeToolCall('fake', invalidInput),
        tools,
        error,
      }),
    ).resolves.toBeNull();
    expect(error.message).toMatch(
      /Recoverable tool call rejection \(invalid-input\):[\s\S]*Schema validation failed for "fake":[\s\S]*- explanation:[\s\S]*- count:/,
    );
  });

  it('lists every offending path (not just the first)', async () => {
    const tools = { fake: makeFakeTool() };
    const invalidInput = JSON.stringify({ count: 50 });
    const error = new Error('upstream');

    await repairToolCall({
      toolCall: makeToolCall('fake', invalidInput),
      tools,
      error,
    });

    expect(error.message).toContain('- explanation:');
    expect(error.message).toContain('- count:');
    expect(error.message).toContain(
      "Review the tool's parameter requirements and retry with corrected input.",
    );
  });

  it('uses the generic recoverable fallback when schema accepts the parsed input', async () => {
    const tools = { fake: makeFakeTool() };
    // Defensive edge case: AI SDK flagged it but zod says it's fine.
    const validInput = JSON.stringify({ explanation: 'ok' });
    const error = new Error('upstream schema error');

    await expect(
      repairToolCall({
        toolCall: makeToolCall('fake', validInput),
        tools,
        error,
      }),
    ).resolves.toBeNull();
    expect(error.message).toMatch(
      /Recoverable tool call rejection \(invalid-input\): Inputs for "fake" did not match the expected schema/,
    );
  });

  it('marks unparseable short input without throwing', async () => {
    const tools = { fake: makeFakeTool() };
    const error = new Error('upstream');

    await expect(
      repairToolCall({
        toolCall: makeToolCall('fake', ''),
        tools,
        error,
      }),
    ).resolves.toBeNull();
    expect(error.message).toMatch(
      /Recoverable tool call rejection \(invalid-input\):.*empty or malformed/,
    );
  });

  it('marks long truncated input for compact/chunk recovery without echoing it', async () => {
    const tools = { fake: makeFakeTool() };
    // > 10 chars, unparseable JSON (truncation scenario)
    const truncatedInput =
      '{"explanation": "this is a very long command that got cut off mid-str';
    const error = new Error('upstream');

    await expect(
      repairToolCall({
        toolCall: makeToolCall('fake', truncatedInput),
        tools,
        error,
      }),
    ).resolves.toBeNull();
    expect(error.message).toMatch(
      /Recoverable tool call rejection \(truncated-input\):.*not executed.*smaller independent calls.*chunks/,
    );
    expect(error.message).not.toContain('cut off mid-str');
  });

  it('does not rethrow when the provider supplies a frozen Error object', async () => {
    const tools = { fake: makeFakeTool() };
    const frozenError = Object.freeze(new Error('provider-owned'));

    await expect(
      repairToolCall({
        toolCall: makeToolCall(
          'fake',
          '{"explanation":"another oversized edit that was cut off',
        ),
        tools,
        error: frozenError,
      }),
    ).resolves.toBeNull();
    expect(frozenError.message).toBe('provider-owned');
    expect(
      findToolCallRecoverySignal([
        {
          type: 'tool-call',
          invalid: true,
          toolName: 'fake',
          error: frozenError,
        },
      ]),
    ).toEqual({ kind: 'truncated-input', toolNames: ['unknown'] });
  });

  it('falls back to a generic recoverable error when the target tool is missing from the map', async () => {
    const validInputForNothing = JSON.stringify({ any: 'thing' });
    const error = new Error('upstream');

    await expect(
      repairToolCall({
        toolCall: makeToolCall('missing', validInputForNothing),
        tools: {},
        error,
      }),
    ).resolves.toBeNull();
    expect(error.message).toMatch(
      /Recoverable tool call rejection \(invalid-input\): Inputs for "unknown" did not match/,
    );
  });

  it('keeps the AI SDK stream alive and returns a non-executed invalid result', async () => {
    const onError = vi.fn();
    const onFinish = vi.fn();
    const execute = vi.fn();
    const result = streamText({
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'call-truncated',
                toolName: 'fake',
                input: '{"explanation":"an oversized edit that was cut off',
              },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: {
                    total: 10,
                    noCache: 10,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 20,
                    text: 20,
                    reasoning: undefined,
                  },
                },
              },
            ],
          }),
          warnings: [],
        }),
      }),
      messages: [{ role: 'user', content: 'Make a large edit' }],
      tools: {
        fake: tool({
          description: 'Fake tool for stream recovery test',
          inputSchema: z.object({ explanation: z.string() }),
          execute,
        }),
      },
      experimental_repairToolCall: repairToolCall,
      stopWhen: () => true,
      onError,
      onFinish,
    });

    await result.consumeStream();

    expect(onError).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish.mock.calls[0]?.[0]).toMatchObject({
      finishReason: 'stop',
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-call',
          invalid: true,
          toolName: 'fake',
        }),
        expect.objectContaining({
          type: 'tool-error',
          error: expect.stringMatching(
            /^Recoverable tool call rejection \(truncated-input\):/,
          ),
        }),
      ]),
    });
  });
});

describe('findToolCallRecoverySignal', () => {
  it('recognizes a serialized/wrapped truncation marker without exporting model names', () => {
    const signal = findToolCallRecoverySignal([
      {
        type: 'tool-call',
        invalid: true,
        toolName: `write-${'x'.repeat(500)}`,
        input: 'secret model-generated payload',
        error: {
          message: 'outer',
          cause:
            'Recoverable tool call rejection (truncated-input): retry in chunks',
        },
      },
    ]);

    expect(signal).toEqual({
      kind: 'truncated-input',
      toolNames: ['unknown'],
    });
    expect(JSON.stringify(signal)).not.toContain('secret');
    expect(JSON.stringify(signal)).not.toContain('write-');
  });

  it('never exports a model-generated unknown tool name', () => {
    expect(
      findToolCallRecoverySignal([
        {
          type: 'tool-call',
          invalid: true,
          toolName: 'sk-sensitive-looking-name',
          error: 'Recoverable tool call rejection (unknown-tool): unavailable',
        },
      ]),
    ).toEqual({ kind: 'unknown-tool', toolNames: ['unknown'] });
  });

  it('treats any SDK-invalid call as recoverable but ignores ordinary tool failures', () => {
    expect(
      findToolCallRecoverySignal([
        {
          type: 'tool-call',
          invalid: true,
          toolName: 'multiEdit',
          error: new Error('provider-specific parse failure'),
        },
        {
          type: 'tool-error',
          toolName: 'shell',
          error: 'command exited 1',
        },
      ]),
    ).toEqual({ kind: 'invalid-input', toolNames: ['unknown'] });

    expect(
      findToolCallRecoverySignal([
        {
          type: 'tool-error',
          toolName: 'shell',
          error: 'command exited 1',
        },
      ]),
    ).toBeNull();
  });
});
