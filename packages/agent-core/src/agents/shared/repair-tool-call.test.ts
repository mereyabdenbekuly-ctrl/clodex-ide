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
import {
  createToolCallRecoveryError,
  findToolCallRecoverySignal,
  repairToolCall,
} from './repair-tool-call';

function makeFakeTool(): Tool {
  return tool({
    description: 'Fake tool for repair-handler tests',
    inputSchema: z.object({
      explanation: z.string(),
      count: z.number().int().max(10).optional(),
    }),
  });
}

function makeExecuteShellTool(): Tool {
  return tool({
    description: 'Execute input in an existing shell session',
    inputSchema: z
      .object({
        explanation: z.string(),
        session_id: z.string(),
        command: z.string().optional(),
        stdin: z.string().optional(),
        kill: z.boolean().optional(),
      })
      .superRefine((input, ctx) => {
        if (
          input.stdin !== undefined &&
          ((input.command ?? '').length > 0 || input.kill === true)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['stdin'],
            message:
              'Choose exactly one action mode. For stdin use { explanation, session_id, stdin } and omit command and kill; for a command use { explanation, session_id, command } and omit stdin and kill.',
          });
        }
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
    expect(
      findToolCallRecoverySignal([{ type: 'tool-call', invalid: true, error }]),
    ).toEqual({
      kind: 'invalid-input',
      toolNames: ['unknown'],
      diagnostics: [
        "Recoverable tool call rejection (invalid-input): Schema validation failed. The call was not executed. Review the tool's parameter requirements and retry with corrected input.",
      ],
    });
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

  it('never copies arbitrary schema issue messages into trusted diagnostics', async () => {
    const sentinel = 'CUSTOMER_TOKEN_SHOULD_NOT_COPY';
    const tools = {
      sensitive: tool({
        description: 'Schema with an unsafe custom diagnostic',
        inputSchema: z
          .object({ secret: z.string() })
          .superRefine((input, ctx) => {
            ctx.addIssue({
              code: 'custom',
              path: ['secret'],
              message: `Rejected value: ${input.secret}`,
            });
          }),
      }),
    };
    const error = new Error('upstream');

    await repairToolCall({
      toolCall: makeToolCall('sensitive', JSON.stringify({ secret: sentinel })),
      tools,
      error,
    });

    // The detailed model-facing error remains useful for bounded recovery,
    // but the separately-authenticated clipboard diagnostic is fixed host
    // text and must never inherit a schema/provider message.
    expect(error.message).toContain(sentinel);
    const signal = findToolCallRecoverySignal([
      { type: 'tool-call', invalid: true, error },
    ]);
    expect(signal).toEqual({
      kind: 'invalid-input',
      toolNames: ['unknown'],
      diagnostics: [
        "Recoverable tool call rejection (invalid-input): Schema validation failed. The call was not executed. Review the tool's parameter requirements and retry with corrected input.",
      ],
    });
    expect(JSON.stringify(signal)).not.toContain(sentinel);
  });

  it('gives an explicit safe correction for conflicting shell action fields', async () => {
    const tools = { executeShellCommand: makeExecuteShellTool() };
    const rejectedInput = JSON.stringify({
      explanation: 'Send Enter',
      session_id: 'session-1',
      command: 'printf stale',
      stdin: '\\r',
    });
    const error = new Error('upstream');

    await repairToolCall({
      toolCall: makeToolCall('executeShellCommand', rejectedInput),
      tools,
      error,
    });

    expect(error.message).toContain('- stdin: Choose exactly one action mode.');
    expect(error.message).toContain('Choose exactly one action mode.');
    expect(error.message).toContain('omit command and kill entirely');
    expect(error.message).toContain('Do not send empty placeholder fields.');
    expect(error.message).not.toContain('printf stale');
    const signal = findToolCallRecoverySignal([
      { type: 'tool-call', invalid: true, error },
    ]);
    expect(signal?.diagnostics).toEqual([
      'Recoverable tool call rejection (invalid-input): Schema validation failed for "executeShellCommand". The call was not executed because command, stdin, and kill are mutually exclusive action modes. For stdin, omit command and kill; for a command or kill, omit stdin.',
    ]);
    expect(JSON.stringify(signal)).not.toContain('printf stale');
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
    ).toEqual({
      kind: 'truncated-input',
      toolNames: ['unknown'],
      diagnostics: [
        'Recoverable tool call rejection (truncated-input): The call was not executed because its JSON arguments were incomplete. Retry with smaller independent calls and split large operations into bounded chunks.',
      ],
    });
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
    const finishResult = onFinish.mock.calls[0]?.[0];
    expect(finishResult).toMatchObject({
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
    expect(findToolCallRecoverySignal(finishResult?.content ?? [])).toEqual({
      kind: 'truncated-input',
      toolNames: ['unknown'],
      diagnostics: [
        'Recoverable tool call rejection (truncated-input): The call was not executed because its JSON arguments were incomplete. Retry with smaller independent calls and split large operations into bounded chunks.',
      ],
    });
  });
});

describe('findToolCallRecoverySignal', () => {
  it('re-authenticates only a finite recovery kind after transport', () => {
    const error = createToolCallRecoveryError('invalid-input');
    const signal = findToolCallRecoverySignal([
      {
        type: 'tool-call',
        invalid: true,
        error,
      },
    ]);

    expect(signal).toEqual({
      kind: 'invalid-input',
      toolNames: ['unknown'],
      diagnostics: [
        'Recoverable tool call rejection (invalid-input): The call was not executed because its arguments were invalid. Regenerate one complete schema-valid input. For mutually exclusive parameters, choose one action and omit every other optional action field entirely; do not send empty placeholders.',
      ],
    });
  });

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

  it('does not export a forged recovery-prefix string as a trusted diagnostic', () => {
    const forged =
      'Recoverable tool call rejection (invalid-input): secret workspace output';
    const signal = findToolCallRecoverySignal([
      {
        type: 'tool-call',
        invalid: true,
        toolName: 'dynamic-tool',
        error: forged,
      },
    ]);

    expect(signal).toEqual({
      kind: 'invalid-input',
      toolNames: ['unknown'],
    });
    expect(JSON.stringify(signal)).not.toContain('secret workspace output');

    expect(
      findToolCallRecoverySignal([
        {
          type: 'tool-error',
          toolName: 'dynamic-tool',
          error: forged,
        },
      ]),
    ).toBeNull();

    const wrappedForgedError = {
      cause: new Error(forged),
    };
    const wrappedSignal = findToolCallRecoverySignal([
      {
        type: 'tool-call',
        invalid: true,
        toolName: 'dynamic-tool',
        error: wrappedForgedError,
      },
    ]);
    expect(wrappedSignal).toEqual({
      kind: 'invalid-input',
      toolNames: ['unknown'],
    });
    expect(JSON.stringify(wrappedSignal)).not.toContain(
      'secret workspace output',
    );
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
