import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentMessage } from '../../types/agent';
import type { AgentHost } from '../../host/host';
import { createTestAgentHost } from '../../host/test-utils';
import type { HostModels, ModelWithOptions } from '../../host/models';

// ---------------------------------------------------------------------------
// Mock `ai` module
// ---------------------------------------------------------------------------
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import {
  COMPRESSION_TARGET_CHARS,
  generateSimpleCompressedHistory,
  generateDeterministicCompressedHistory,
  convertAgentMessagesToCompactMessageHistoryString,
  estimateMessageTokens,
} from './history-compression';

const generateTextMock = vi.mocked(generateText);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `Message ${i}` }],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as AgentMessage);
  }
  return msgs;
}

function makeEmergencyHost(
  serializers: Record<
    string,
    (ctx: {
      input: any;
      output: any;
      err: string | undefined;
    }) => string | undefined
  >,
): AgentHost {
  const host = createTestAgentHost();
  host.registerToolPartSerializers(serializers);
  return host;
}

function makeMockHostModels(): HostModels {
  const getWithOptions = vi.fn(
    async (): Promise<ModelWithOptions> => ({
      model: { id: 'mock-model' } as unknown as ModelWithOptions['model'],
      providerOptions: {},
      headers: {},
      contextWindowSize: 100_000,
      providerMode: 'clodex',
      reasoningSignatureSource: {
        providerMode: 'clodex',
        provider: 'anthropic',
        modelId: 'anthropic/claude-sonnet-4.6',
      },
    }),
  );
  return {
    getWithOptions,
    get: vi.fn(),
    has: vi.fn().mockReturnValue(true),
  } as unknown as HostModels;
}

// ---------------------------------------------------------------------------
// convertAgentMessagesToCompactMessageHistoryString
// ---------------------------------------------------------------------------

describe('convertAgentMessagesToCompactMessageHistoryString', () => {
  it('converts user and assistant messages to XML format', () => {
    const messages = makeMessages(4);
    const result = convertAgentMessagesToCompactMessageHistoryString(messages);

    expect(result).toContain('<user>Message 0</user>');
    expect(result).toContain('<assistant>Message 1</assistant>');
    expect(result).toContain('<user>Message 2</user>');
    expect(result).toContain('<assistant>Message 3</assistant>');
  });

  it('stops at a message with compressedHistory and includes previous history', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Old message' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Old response' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-2',
        role: 'user',
        parts: [{ type: 'text', text: 'New message' }],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          compressedHistory: 'Previous summary here',
        },
      } as AgentMessage,
      {
        id: 'msg-3',
        role: 'assistant',
        parts: [{ type: 'text', text: 'New response' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);

    // Should include previous-chat-history
    expect(result).toContain(
      '<previous-chat-history>Previous summary here</previous-chat-history>',
    );
    // Should include messages from the compressedHistory message onwards
    expect(result).toContain('<user>New message</user>');
    expect(result).toContain('<assistant>New response</assistant>');
    // Should NOT include messages before the compressedHistory boundary
    expect(result).not.toContain('Old message');
    expect(result).not.toContain('Old response');
  });

  it('serializes tool-read parts as compact one-liners', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Read the file' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: { path: 'w1/src/index.ts' },
            output: { content: 'file contents here' },
          },
          { type: 'text', text: 'I read the file.' },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[read: w1/src/index.ts]');
    expect(result).toContain('I read the file.');
  });

  it('serializes tool-multiEdit parts with edit count', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Fix the bug' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-multiEdit',
            toolCallId: 'tc-2',
            state: 'output-available',
            input: {
              path: 'w1/src/utils.ts',
              edits: [
                { old_string: 'a', new_string: 'b' },
                { old_string: 'c', new_string: 'd' },
              ],
            },
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[edited: w1/src/utils.ts (2 edits)]');
  });

  it('serializes tool-write and tool-delete as compact one-liners', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Do the work' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-write',
            toolCallId: 'tc-3',
            state: 'output-available',
            input: { path: 'w1/new-file.ts', content: '// new' },
            output: {},
          },
          {
            type: 'tool-delete',
            toolCallId: 'tc-4',
            state: 'output-available',
            input: { path: 'w1/old-file.ts' },
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[wrote: w1/new-file.ts]');
    expect(result).toContain('[deleted: w1/old-file.ts]');
  });

  it('serializes tool-grepSearch with query and file pattern', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Find usage' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-grepSearch',
            toolCallId: 'tc-6',
            state: 'output-available',
            input: {
              mount_prefix: 'w1',
              query: 'useState',
              include_file_pattern: '**/*.tsx',
            },
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[searched: "useState" in **/*.tsx]');
  });

  it('emits a generic marker for unknown tool types', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Do something' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-futureTool',
            toolCallId: 'tc-8',
            state: 'output-available',
            input: { foo: 'bar' },
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[tool-futureTool]');
  });

  // -----------------------------------------------------------------------
  // Host registry (AgentHost.toolPartSerializers)
  // -----------------------------------------------------------------------

  /**
   * Builds an `AgentHost` populated with the requested tool-part
   * serializers. Other host slots remain at their `createTestAgentHost`
   * defaults — the serializer call site only ever reads
   * `getToolPartSerializer`.
   */
  const makeHost = (
    serializers: Record<
      string,
      (ctx: {
        input: any;
        output: any;
        err: string | undefined;
      }) => string | undefined
    >,
  ): AgentHost => {
    const host = createTestAgentHost();
    host.registerToolPartSerializers(serializers);
    return host;
  };

  it('routes unknown tool parts through the host tool-part serializer registry', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Run' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-hostThing',
            toolCallId: 'tc-host',
            state: 'output-available',
            input: { label: 'do stuff' },
            output: { ok: true },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const host = makeEmergencyHost({
      hostThing: ({ input }) => `[host: ${input.label}]`,
    });

    const result = convertAgentMessagesToCompactMessageHistoryString(
      messages,
      host,
    );
    expect(result).toContain('[host: do stuff]');
    expect(result).not.toContain('[tool-hostThing]');
  });

  it('falls back to the generic marker when a host serializer returns undefined', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Run' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-skipMe',
            toolCallId: 'tc-skip',
            state: 'output-available',
            input: {},
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const host = makeEmergencyHost({
      skipMe: () => undefined,
    });

    const result = convertAgentMessagesToCompactMessageHistoryString(
      messages,
      host,
    );
    expect(result).toContain('[tool-skipMe]');
  });

  it('falls back to the generic marker when a host serializer throws', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Run' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-explodes',
            toolCallId: 'tc-boom',
            state: 'output-available',
            input: {},
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const host = makeHost({
      explodes: () => {
        throw new Error('boom');
      },
    });

    const result = convertAgentMessagesToCompactMessageHistoryString(
      messages,
      host,
    );
    expect(result).toContain('[tool-explodes]');
  });

  it('appends the ✗ error suffix to the generic marker for unknown tools', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Run' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-futureTool',
            toolCallId: 'tc-err',
            state: 'output-error',
            input: { foo: 'bar' },
            errorText: 'boom',
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[tool-futureTool ✗ boom]');
  });

  it('serializes user metadata annotations for attachments and mentions', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Fix the button' }],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          attachments: [
            {
              path: 'att/screenshot.png',
              originalFileName: 'screenshot.png',
            },
          ],
          mentions: [
            {
              providerType: 'file',
              mountedPath: 'w1/src/button.tsx',
              relativePath: 'src/button.tsx',
              mountPrefix: 'w1',
              fileName: 'button.tsx',
            },
            {
              providerType: 'tab',
              tabId: 't-1',
              url: 'http://localhost',
              title: 'Dev Server',
            },
          ],
        },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Fixed it.' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[attached: screenshot.png]');
    expect(result).toContain('[mentioned: w1/src/button.tsx, Dev Server]');
    expect(result).toContain('Fix the button');
  });

  it('handles assistant messages with only tool parts (no text)', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Check the files' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: { path: 'w1/a.ts' },
            output: {},
          },
          {
            type: 'tool-read',
            toolCallId: 'tc-2',
            state: 'output-available',
            input: { path: 'w1/b.ts' },
            output: {},
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[read: w1/a.ts]');
    expect(result).toContain('[read: w1/b.ts]');
    // Should NOT be an empty <assistant></assistant>
    expect(result).not.toContain('<assistant></assistant>');
  });

  // -----------------------------------------------------------------------
  // Output-aware serialisation
  // -----------------------------------------------------------------------

  it('overwriteFile: distinguishes created vs wrote', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Write files' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-write',
            toolCallId: 'tc-create',
            state: 'output-available',
            input: { path: 'w1/new.ts', content: '// new' },
            output: { message: 'Successfully created file: new.ts' },
          },
          {
            type: 'tool-write',
            toolCallId: 'tc-update',
            state: 'output-available',
            input: { path: 'w1/existing.ts', content: '// updated' },
            output: { message: 'Successfully updated file: existing.ts' },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[created: w1/new.ts]');
    expect(result).toContain('[wrote: w1/existing.ts]');
  });

  it('tool error states: shows ✗ marker with error text', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Do things' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as AgentMessage,
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read',
            toolCallId: 'tc-err',
            state: 'output-error',
            input: { path: 'w1/missing.ts' },
            errorText: 'File not found: w1/missing.ts',
          },
          {
            type: 'tool-multiEdit',
            toolCallId: 'tc-err2',
            state: 'output-error',
            input: { path: 'w1/locked.ts', edits: [] },
            errorText: 'Permission denied',
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      } as unknown as AgentMessage,
    ];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain(
      '[read: w1/missing.ts ✗ File not found: w1/missing.ts]',
    );
    expect(result).toContain('[edited: w1/locked.ts ✗ Permission denied]');
  });

  // -----------------------------------------------------------------------
  // Resilience / graceful-degradation
  // -----------------------------------------------------------------------

  it('survives null/undefined messages in the array', () => {
    const messages = [
      null,
      undefined,
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      null,
    ] as unknown as AgentMessage[];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('<user>Hello</user>');
  });

  it('returns empty string for non-array input', () => {
    const result = convertAgentMessagesToCompactMessageHistoryString(
      null as unknown as AgentMessage[],
    );
    expect(result).toBe('');
  });

  it('survives message.parts being null/undefined', () => {
    const messages = [
      {
        id: 'msg-0',
        role: 'user',
        parts: null,
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'msg-1',
        role: 'assistant',
        parts: undefined,
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    // Should not throw; empty parts → empty tags
    expect(result).toContain('<user>');
    expect(result).toContain('<assistant>');
  });

  it('survives part.text being null/undefined/number', () => {
    const messages = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [
          { type: 'text', text: null },
          { type: 'text', text: undefined },
          { type: 'text', text: 42 },
          { type: 'text', text: 'valid' },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('valid');
    // The non-string values should not crash; they should coerce or be skipped
    expect(result).not.toBe('');
  });

  it('survives a tool part with completely wrong shape', () => {
    const messages = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Go' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          // Totally wrong shape — no input, random properties
          { type: 'tool-read', garbage: true },
          // Input exists but path is a number
          { type: 'tool-read', input: { path: 123 } },
          // A normal part that should still serialize
          {
            type: 'tool-read',
            input: { path: 'w1/good.ts' },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    // The good part should survive
    expect(result).toContain('[read: w1/good.ts]');
    // The one with input but wrong type for path should still
    // produce something (string interpolation → "123")
    expect(result).toContain('[read: 123]');
  });

  it('survives null elements in attachments / mentions arrays', () => {
    const messages = [
      {
        id: 'msg-0',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          attachments: [
            null,
            { path: 'att/a.png', originalFileName: 'a.png' },
            undefined,
          ],
          mentions: [
            null,
            { providerType: 'file', mountedPath: 'w1/foo.ts' },
            undefined,
          ],
        },
      },
    ] as unknown as AgentMessage[];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('[attached: a.png]');
    expect(result).toContain('[mentioned: w1/foo.ts]');
  });

  it('survives a message with unknown role', () => {
    const messages = [
      {
        id: 'msg-0',
        role: 'system', // not handled by serialization
        parts: [{ type: 'text', text: 'System prompt' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Real message' }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = convertAgentMessagesToCompactMessageHistoryString(messages);
    expect(result).toContain('Real message');
    // system role should be silently skipped
    expect(result).not.toContain('System prompt');
  });
});

// ---------------------------------------------------------------------------
// generateSimpleCompressedHistory
// ---------------------------------------------------------------------------

describe('generateSimpleCompressedHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the compressed history from the first model when it succeeds', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'The user asked the assistant to help with a task.',
    } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe('The user asked the assistant to help with a task.');
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenCalledWith(
      'gemini-3.1-flash-lite',
      'agent-1',
      expect.objectContaining({
        $ai_span_name: 'history-compression',
        $model_request_purpose: 'internal',
      }),
    );
  });

  it('falls back to the second model when the first fails', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Gemini failed'))
      .mockResolvedValueOnce({
        text: 'The assistant provided a GPT-based summary of events.',
      } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe(
      'The assistant provided a GPT-based summary of events.',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      2,
      'gpt-5.4-nano',
      'agent-1',
      expect.any(Object),
    );
  });

  it('falls back to the third model when the first two fail', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Gemini failed'))
      .mockRejectedValueOnce(new Error('GPT failed'))
      .mockResolvedValueOnce({
        text: 'The assistant provided a Haiku-based summary of events.',
      } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe(
      'The assistant provided a Haiku-based summary of events.',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      3,
      'claude-haiku-4.5',
      'agent-1',
      expect.any(Object),
    );
  });

  it('throws when all three models fail', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Gemini failed'))
      .mockRejectedValueOnce(new Error('GPT failed'))
      .mockRejectedValueOnce(new Error('Haiku failed'));

    const mps = makeMockHostModels();
    await expect(
      generateSimpleCompressedHistory(makeMessages(4), mps, 'agent-1'),
    ).rejects.toThrow('Haiku failed');
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  it('falls back when the abort signal fires (simulating timeout)', async () => {
    generateTextMock.mockRejectedValueOnce(
      new DOMException('Aborted', 'AbortError'),
    );
    generateTextMock.mockResolvedValueOnce({
      text: 'The assistant provided a fallback summary of events.',
    } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe('The assistant provided a fallback summary of events.');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a hanging first model via the 75s timeout and falls back', async () => {
    generateTextMock.mockImplementationOnce(({ abortSignal }: any) => {
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    generateTextMock.mockResolvedValueOnce({
      text: 'The assistant provided a timeout fallback summary of events.',
    } as any);

    const mps = makeMockHostModels();
    const promise = generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    await vi.advanceTimersByTimeAsync(75_000);

    const result = await promise;
    expect(result).toBe(
      'The assistant provided a timeout fallback summary of events.',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      1,
      'gemini-3.1-flash-lite',
      'agent-1',
      expect.any(Object),
    );
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      2,
      'gpt-5.4-nano',
      'agent-1',
      expect.any(Object),
    );
  });

  it('does not start fallbacks when a timed-out model does not settle after abort', async () => {
    generateTextMock.mockImplementationOnce(() => new Promise(() => {}));

    const mps = makeMockHostModels();
    const promise = expect(
      generateSimpleCompressedHistory(makeMessages(4), mps, 'agent-1'),
    ).rejects.toThrow('timed out and did not settle after abort');

    await vi.advanceTimersByTimeAsync(77_000);
    await promise;
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      1,
      'gemini-3.1-flash-lite',
      'agent-1',
      expect.any(Object),
    );
  });

  it('exhausts all models via timeout and throws', async () => {
    const abortError = new DOMException(
      'The operation was aborted.',
      'AbortError',
    );
    generateTextMock
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(abortError);

    const mps = makeMockHostModels();
    await expect(
      generateSimpleCompressedHistory(makeMessages(4), mps, 'agent-1'),
    ).rejects.toThrow('aborted');
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      1,
      'gemini-3.1-flash-lite',
      'agent-1',
      expect.any(Object),
    );
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      2,
      'gpt-5.4-nano',
      'agent-1',
      expect.any(Object),
    );
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      3,
      'claude-haiku-4.5',
      'agent-1',
      expect.any(Object),
    );
  });

  it('stops immediately without model fallback when the caller aborts', async () => {
    const externalController = new AbortController();
    generateTextMock.mockImplementationOnce(({ abortSignal }: any) => {
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => reject(abortSignal.reason),
          { once: true },
        );
      });
    });

    const mps = makeMockHostModels();
    const promise = generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
      'selected-model',
      undefined,
      externalController.signal,
    );
    await vi.waitFor(() => expect(generateTextMock).toHaveBeenCalledOnce());

    externalController.abort(
      new DOMException('User stopped the agent', 'AbortError'),
    );

    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'User stopped the agent',
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenCalledWith(
      'selected-model',
      'agent-1',
      expect.any(Object),
    );
  });

  it('bounds all settled timeout fallbacks by the 150s total budget', async () => {
    generateTextMock.mockImplementation(({ abortSignal }: any) => {
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => reject(abortSignal.reason),
          { once: true },
        );
      });
    });

    const mps = makeMockHostModels();
    const rejection = generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
      'selected-model',
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(150_000);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining('150000ms total generation budget'),
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      1,
      'selected-model',
      'agent-1',
      expect.any(Object),
    );
  });

  it('falls back when the compression is shorter than 30 characters', async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: 'Too short' } as any)
      .mockResolvedValueOnce({
        text: 'This is a sufficiently long compression result for the test.',
      } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe(
      'This is a sufficiently long compression result for the test.',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('accepts compression that is exactly 30 characters', async () => {
    const exactly30 = 'a'.repeat(30);
    generateTextMock.mockResolvedValueOnce({ text: exactly30 } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe(exactly30);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('trims whitespace before checking length', async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: '   short   ' } as any)
      .mockResolvedValueOnce({
        text: 'A valid compression that is long enough to pass.',
      } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe('A valid compression that is long enough to pass.');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('never stores a summary truncated by the output-token ceiling', async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: 'This partial summary is long enough but incomplete.',
        finishReason: 'length',
      } as any)
      .mockResolvedValueOnce({
        text: 'This complete fallback summary preserves the required context.',
        finishReason: 'stop',
      } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );

    expect(result).toBe(
      'This complete fallback summary preserves the required context.',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('passes an abortSignal to generateText', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'The assistant provided a valid summary of events.',
    } as any);

    const mps = makeMockHostModels();
    await generateSimpleCompressedHistory(makeMessages(4), mps, 'agent-1');

    const callArgs = generateTextMock.mock.calls[0][0] as any;
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs.maxRetries).toBe(0);
    expect(callArgs.maxOutputTokens).toBe(8_192);
  });

  it('disables provider reasoning budgets for bounded compression', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'The assistant provided a bounded summary without hidden reasoning.',
    } as any);
    const mps = makeMockHostModels();
    vi.mocked(mps.getWithOptions).mockResolvedValueOnce({
      model: { id: 'mock-model' } as any,
      providerOptions: {
        clodex: { reasoning: { effort: 'high' }, keep: true },
        openai: { reasoningEffort: 'high', reasoningSummary: 'auto' },
        google: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
        },
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 10_000 },
          effort: 'high',
        },
      },
      headers: {},
      contextWindowSize: 100_000,
      providerMode: 'clodex',
    } as any);

    await generateSimpleCompressedHistory(makeMessages(4), mps, 'agent-1');

    const providerOptions = (generateTextMock.mock.calls[0][0] as any)
      .providerOptions;
    expect(providerOptions.clodex).toEqual({ keep: true });
    expect(providerOptions.openai).toEqual({ reasoningEffort: 'none' });
    expect(providerOptions.google).toEqual({
      thinkingConfig: { includeThoughts: false },
    });
    expect(providerOptions.anthropic).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('uses second-person "you" POV and includes key prompt elements', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'You implemented the navbar and the user was satisfied.',
    } as any);

    const mps = makeMockHostModels();
    await generateSimpleCompressedHistory(makeMessages(4), mps, 'agent-1');

    const callArgs = generateTextMock.mock.calls[0][0] as any;
    const systemMsg = callArgs.messages.find((m: any) => m.role === 'system');
    // POV: second-person for agent, third-person for user
    expect(systemMsg.content).toContain('"you"');
    expect(systemMsg.content).toContain('"the user"');
    // Should NOT use the old third-person instruction
    expect(systemMsg.content).not.toContain(
      'Refer to participants as "user" and "assistant"',
    );
    // Input format explanation for tool annotations
    expect(systemMsg.content).toContain('[read: path]');
    expect(systemMsg.content).toContain('[shell: label');
    // Structure guidance: `##` headings, recency bias
    expect(systemMsg.content).toContain('`##` headings');
    expect(systemMsg.content).toContain('Recency bias');
    // User prompt includes continuity framing
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('own memory');
  });

  it('falls back when getWithOptions throws for a model', async () => {
    const mps = makeMockHostModels();
    const getModelMock = vi.mocked(mps.getWithOptions);

    getModelMock.mockImplementationOnce(() => {
      throw new Error('Model not found');
    });
    getModelMock.mockReturnValueOnce({
      model: { id: 'gpt-mock' },
      providerOptions: {},
      headers: {},
      contextWindowSize: 100_000,
      providerMode: 'clodex',
    } as any);
    generateTextMock.mockResolvedValueOnce({
      text: 'The assistant provided a provider-fallback summary of events.',
    } as any);

    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
    );
    expect(result).toBe(
      'The assistant provided a provider-fallback summary of events.',
    );
  });

  // -----------------------------------------------------------------------
  // fallbackModelId (active chat model gets the first bounded attempt)
  // -----------------------------------------------------------------------

  it('tries the active model before generic compression fallbacks', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'The assistant provided an active-model summary of events.',
    } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
      'claude-sonnet-4.6' as any,
    );

    expect(result).toBe(
      'The assistant provided an active-model summary of events.',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      1,
      'claude-sonnet-4.6',
      'agent-1',
      expect.objectContaining({ $ai_span_name: 'history-compression' }),
    );
  });

  it('skips fallbackModelId if it matches a cheap model ID', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Haiku failed'))
      .mockRejectedValueOnce(new Error('Gemini failed'))
      .mockRejectedValueOnce(new Error('GPT failed'));

    const mps = makeMockHostModels();
    await expect(
      generateSimpleCompressedHistory(
        makeMessages(4),
        mps,
        'agent-1',
        'claude-haiku-4.5' as any,
      ),
    ).rejects.toThrow('GPT failed');
    expect(mps.getWithOptions).toHaveBeenCalledTimes(3);
    expect(mps.getWithOptions).toHaveBeenNthCalledWith(
      1,
      'claude-haiku-4.5',
      'agent-1',
      expect.any(Object),
    );
  });

  it('throws when fallback model also fails', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Sonnet failed'))
      .mockRejectedValueOnce(new Error('Gemini failed'))
      .mockRejectedValueOnce(new Error('GPT failed'))
      .mockRejectedValueOnce(new Error('Haiku failed'));

    const mps = makeMockHostModels();
    await expect(
      generateSimpleCompressedHistory(
        makeMessages(4),
        mps,
        'agent-1',
        'claude-sonnet-4.6' as any,
      ),
    ).rejects.toThrow('Haiku failed');
    expect(generateTextMock).toHaveBeenCalledTimes(4);
  });

  it('does not spend budget on generic fallbacks when the active model succeeds', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'The user asked the assistant to help with a task.',
    } as any);

    const mps = makeMockHostModels();
    const result = await generateSimpleCompressedHistory(
      makeMessages(4),
      mps,
      'agent-1',
      'claude-sonnet-4.6' as any,
    );

    expect(result).toBe('The user asked the assistant to help with a task.');
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenCalledTimes(1);
    expect(mps.getWithOptions).toHaveBeenCalledWith(
      'claude-sonnet-4.6',
      'agent-1',
      expect.any(Object),
    );
  });
});

describe('generateDeterministicCompressedHistory', () => {
  const generateEmergency = (
    messages: AgentMessage[],
    maxUtf8Bytes = 40_000,
    host?: AgentHost,
  ) =>
    generateDeterministicCompressedHistory(messages, host, {
      maxUtf8Bytes,
    });

  it('fails closed when the safety envelope would make a small prefix larger', () => {
    const messages = makeMessages(4);
    messages[0]!.parts = [
      { type: 'text', text: `Message 0 ${'context '.repeat(2_000)}` },
    ];
    expect(() => generateEmergency(messages)).toThrow(
      'did not reduce the effective history prefix',
    );
  });

  it('bounds large history while retaining the earliest goal and latest state', () => {
    const messages = makeMessages(6);
    messages[0]!.parts = [
      { type: 'text', text: `INITIAL_GOAL ${'a'.repeat(35_000)}` },
    ];
    messages[3]!.parts = [
      { type: 'text', text: `MIDDLE_DETAIL ${'b'.repeat(35_000)}` },
    ];
    messages[5]!.parts = [
      { type: 'text', text: `LATEST_STATE ${'c'.repeat(35_000)}` },
    ];

    const result = generateEmergency(messages, 8_000);

    expect(result.length).toBeLessThanOrEqual(COMPRESSION_TARGET_CHARS);
    expect(result).toContain('INITIAL_GOAL');
    expect(result).toContain('LATEST_STATE');
    expect(result).toContain('## Omitted middle history');
    expect(result).not.toContain('MIDDLE_DETAIL');
  });

  it('retains a prior briefing alongside the earliest goal and latest state', () => {
    const messages = makeMessages(4);
    messages[0]!.metadata!.compressedHistory =
      'PRIOR_DECISION: keep the public client secure and useful.';
    messages[0]!.parts = [
      { type: 'text', text: `EARLIEST_GOAL ${'a'.repeat(35_000)}` },
    ];
    messages[3]!.parts = [
      { type: 'text', text: `LATEST_STATE ${'z'.repeat(35_000)}` },
    ];

    const result = generateEmergency(messages, 4_000);

    expect(result).toContain('PRIOR_DECISION');
    expect(result).toContain('EARLIEST_GOAL');
    expect(result).toContain('LATEST_STATE');
    expect(result.length).toBeLessThanOrEqual(COMPRESSION_TARGET_CHARS);
  });

  it('retains both ends of a 20KB prior briefing, including a trailing effect receipt', () => {
    const messages = makeMessages(4);
    messages[0]!.metadata!.compressedHistory =
      `PRIOR_BRIEFING_START ${'p'.repeat(20_000)} TERMINAL_EFFECT_RECEIPT`;
    messages[0]!.parts = [
      { type: 'text', text: `EARLIEST_NEW_GOAL ${'a'.repeat(20_000)}` },
    ];
    messages[3]!.parts = [
      { type: 'text', text: `LATEST_NEW_STATE ${'z'.repeat(20_000)}` },
    ];

    const result = generateEmergency(messages, 12_000);

    expect(result).toContain('PRIOR_BRIEFING_START');
    expect(result).toContain('TERMINAL_EFFECT_RECEIPT');
    expect(result).toContain('EARLIEST_NEW_GOAL');
    expect(result).toContain('LATEST_NEW_STATE');
    expect(result).toContain('## Omitted middle of prior briefing');
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(12_000);
  });

  it('enforces the UTF-8 byte budget without splitting Unicode code points', () => {
    const messages = makeMessages(3);
    messages[0]!.parts = [
      { type: 'text', text: `UNICODE_INITIAL ${'🚀'.repeat(20_000)}` },
    ];
    messages[2]!.parts = [
      { type: 'text', text: `UNICODE_LATEST ${'🧭'.repeat(20_000)}` },
    ];

    const result = generateEmergency(messages, 6_000);

    expect(result).toContain('UNICODE_INITIAL');
    expect(result).toContain('UNICODE_LATEST');
    expect(result).not.toContain('\uFFFD');
    expect(result.length).toBeLessThanOrEqual(COMPRESSION_TARGET_CHARS);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(6_000);
  });

  it('fails closed when the byte budget cannot fit required safety metadata', () => {
    const messages = makeMessages(3);
    messages[0]!.parts = [
      { type: 'text', text: `INITIAL ${'a'.repeat(20_000)}` },
    ];

    expect(() => generateEmergency(messages, 100)).toThrow(
      'too small for required safety metadata',
    );
  });

  it('bounds retained memory to the requested excerpt while scanning a very large prefix', () => {
    const messages = makeMessages(3);
    messages[0]!.parts = [
      { type: 'text', text: `VERY_LARGE_INITIAL ${'a'.repeat(500_000)}` },
    ];
    messages[2]!.parts = [
      { type: 'text', text: `VERY_LARGE_LATEST ${'z'.repeat(500_000)}` },
    ];

    const result = generateEmergency(messages, 4_000);

    expect(result).toContain('VERY_LARGE_INITIAL');
    expect(result).toContain('VERY_LARGE_LATEST');
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(4_000);
  });

  it('refuses to discard history when nothing can be serialized', () => {
    const messages = [
      {
        id: 'system-only',
        role: 'system',
        parts: [],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    expect(() => generateEmergency(messages)).toThrow('empty history');
  });

  it.each([
    'input-streaming',
    'input-available',
    'approval-requested',
    'approval-responded',
    'unknown-state',
  ])('fails closed for a tool outcome in state %s', (state) => {
    const messages = [
      {
        id: 'assistant-with-pending-effect',
        role: 'assistant',
        parts: [
          {
            type: 'tool-write',
            toolCallId: 'write-1',
            state,
            input: { path: 'w1/src/file.ts', content: 'changed' },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    expect(() => generateEmergency(messages)).toThrow(
      'refused ambiguous tool outcome',
    );
  });

  it.each([
    ['missing toolCallId', { type: 'tool-write' }],
    ['blank toolCallId', { type: 'tool-write', toolCallId: '   ' }],
    ['NUL toolCallId', { type: 'tool-write', toolCallId: 'write\0id' }],
    ['empty static name', { type: 'tool-', toolCallId: 'write-1' }],
    [
      'blank dynamic name',
      { type: 'dynamic-tool', toolName: ' ', toolCallId: 'dynamic-1' },
    ],
  ])('fails closed for terminal tool identity with %s', (_label, identity) => {
    const messages = [
      {
        id: 'assistant-with-invalid-terminal-identity',
        role: 'assistant',
        parts: [
          {
            ...identity,
            state: 'output-available',
            input: { path: 'w1/src/file.ts', content: 'changed' },
            output: { ok: true },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    expect(() => generateEmergency(messages)).toThrow(
      'refused ambiguous tool outcome',
    );
  });

  it('ignores ambiguous tool parts older than the latest durable briefing', () => {
    const messages = [
      {
        id: 'old-ambiguous-effect',
        role: 'assistant',
        parts: [
          {
            type: 'tool-write',
            toolCallId: 'old-write',
            state: 'input-available',
            input: { path: 'w1/old.ts', content: 'unknown' },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'durable-boundary',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue from the durable briefing.' }],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          compressedHistory: 'The old tool outcome was resolved safely.',
        },
      },
      {
        id: 'recent-message',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: `Current work is still in progress. ${'context '.repeat(2_000)}`,
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = generateEmergency(messages, 4_000);

    expect(result).toContain('The old tool outcome was resolved safely.');
    expect(result).toContain('Current work is still in progress.');
    expect(result).not.toContain('w1/old.ts');
  });

  it('preserves a terminal dynamic tool effect in the emergency snapshot', () => {
    const messages = [
      {
        id: 'assistant-with-dynamic-effect',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: `Completed external operation context ${'detail '.repeat(1_000)}`,
          },
          {
            type: 'dynamic-tool',
            toolName: 'mcp_write_record',
            toolCallId: 'dynamic-1',
            state: 'output-available',
            input: { recordId: 'record-1' },
            output: { ok: true },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = generateEmergency(messages, 4_000);

    expect(result).toContain('[dynamic-tool: mcp_write_record]');
    expect(result).toContain('toolCallId=dynamic-1');
  });

  it('keeps every write, shell, and MCP receipt even when their messages fall in the omitted middle', () => {
    const host = makeEmergencyHost({
      executeShellCommand: ({ output }) =>
        `[shell: build → ${output?.exit_code === 0 ? '✓' : `exit ${output?.exit_code}`}]`,
      mcp_write_record: ({ output }) =>
        `[mcp: record ${output?.ok ? 'saved' : 'failed'}]`,
    });
    const messages = makeMessages(7);
    messages[0]!.parts = [
      { type: 'text', text: `LEDGER_INITIAL ${'a'.repeat(35_000)}` },
    ];
    messages[2] = {
      id: 'middle-write',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write',
          toolCallId: 'write-middle',
          state: 'output-available',
          input: { path: 'w1/middle.ts', content: 'changed' },
          output: { ok: true },
        },
      ],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as unknown as AgentMessage;
    messages[3] = {
      id: 'middle-shell-mcp',
      role: 'assistant',
      parts: [
        {
          type: 'tool-executeShellCommand',
          toolCallId: 'shell-middle',
          state: 'output-available',
          input: { command: 'pnpm test' },
          output: { exit_code: 0 },
        },
        {
          type: 'dynamic-tool',
          toolName: 'mcp_write_record',
          toolCallId: 'mcp-middle',
          state: 'output-available',
          input: { recordId: 'record-1' },
          output: { ok: true },
        },
      ],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as unknown as AgentMessage;
    messages[4]!.parts = [
      { type: 'text', text: `OMITTED_MIDDLE_SENTINEL ${'m'.repeat(35_000)}` },
    ];
    messages[6]!.parts = [
      { type: 'text', text: `LEDGER_LATEST ${'z'.repeat(35_000)}` },
    ];

    const result = generateEmergency(messages, 8_000, host);

    expect(result).toContain('## Terminal tool-effect ledger');
    expect(result).toContain('toolCallId=write-middle');
    expect(result).toContain('[wrote: w1/middle.ts]');
    expect(result).toContain('toolCallId=shell-middle');
    expect(result).toContain('[shell: build → ✓]');
    expect(result).toContain('toolCallId=mcp-middle');
    expect(result).toContain('[mcp: record saved]');
    expect(result).not.toContain('OMITTED_MIDDLE_SENTINEL');
  });

  it('fails closed when all mandatory terminal receipts cannot fit', () => {
    const messages = [
      {
        id: 'large-user-prefix',
        role: 'user',
        parts: [{ type: 'text', text: `PREFIX ${'a'.repeat(100_000)}` }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'many-terminal-effects',
        role: 'assistant',
        parts: Array.from({ length: 80 }, (_, index) => ({
          type: 'tool-bulkEffect',
          toolCallId: `bulk-effect-${index}`,
          state: 'output-available',
          input: { index },
          output: { ok: true },
        })),
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    expect(() => generateEmergency(messages, 2_000)).toThrow(
      'terminal-effect ledger cannot fit all receipts',
    );
  });

  it('preserves host serializer success, exit, and timeout outcomes in the mandatory ledger', () => {
    const host = makeEmergencyHost({
      executeShellCommand: ({ input, output }) => {
        const label = input.command;
        if (output?.timed_out) return `[shell: ${label} → timed out]`;
        if (output?.exit_code !== 0)
          return `[shell: ${label} → exit ${output?.exit_code}]`;
        return `[shell: ${label} → ✓]`;
      },
    });
    const messages = [
      {
        id: 'large-shell-prefix',
        role: 'user',
        parts: [{ type: 'text', text: `SHELL_PREFIX ${'a'.repeat(40_000)}` }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'shell-outcomes',
        role: 'assistant',
        parts: [
          {
            type: 'tool-executeShellCommand',
            toolCallId: 'shell-success',
            state: 'output-available',
            input: { command: 'test-success' },
            output: { exit_code: 0 },
          },
          {
            type: 'tool-executeShellCommand',
            toolCallId: 'shell-exit-1',
            state: 'output-available',
            input: { command: 'test-failure' },
            output: { exit_code: 1 },
          },
          {
            type: 'tool-executeShellCommand',
            toolCallId: 'shell-timeout',
            state: 'output-available',
            input: { command: 'test-timeout' },
            output: { timed_out: true },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'large-shell-tail',
        role: 'assistant',
        parts: [{ type: 'text', text: `SHELL_LATEST ${'z'.repeat(40_000)}` }],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = generateEmergency(messages, 7_000, host);

    expect(result).toContain('[shell: test-success → ✓]');
    expect(result).toContain('[shell: test-failure → exit 1]');
    expect(result).toContain('[shell: test-timeout → timed out]');
    expect(result).toContain('toolCallId=shell-success');
    expect(result).toContain('toolCallId=shell-exit-1');
    expect(result).toContain('toolCallId=shell-timeout');
  });

  it('fails closed for preliminary terminal-looking tool output', () => {
    const messages = [
      {
        id: 'assistant-with-preliminary-effect',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: `Write operation context ${'detail '.repeat(1_000)}`,
          },
          {
            type: 'tool-write',
            toolCallId: 'write-preliminary',
            state: 'output-available',
            preliminary: true,
            input: { path: 'w1/src/file.ts', content: 'changed' },
            output: { ok: true },
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    expect(() => generateEmergency(messages)).toThrow(
      'refused ambiguous tool outcome',
    );
  });

  it.each([
    ['output-available', undefined, '[wrote: w1/src/file.ts]'],
    ['output-error', 'write failed', '✗ write failed'],
    ['output-denied', undefined, '✗ denied'],
  ] as const)('preserves a terminal write outcome in state %s', (state, errorText, expected) => {
    const messages = [
      {
        id: `write-${state}`,
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: `Terminal write context ${'detail '.repeat(2_000)}`,
          },
          {
            type: 'tool-write',
            toolCallId: `write-${state}`,
            state,
            input: { path: 'w1/src/file.ts', content: 'changed' },
            ...(state === 'output-available'
              ? { output: { message: 'Successfully updated file' } }
              : {}),
            ...(errorText ? { errorText } : {}),
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ] as unknown as AgentMessage[];

    const result = generateEmergency(messages, 4_000);

    expect(result).toContain(expected);
    expect(result).toContain(`toolCallId=write-${state}`);
  });
});

// ---------------------------------------------------------------------------
// estimateMessageTokens
// ---------------------------------------------------------------------------

describe('estimateMessageTokens', () => {
  it('estimates user message with single text part', () => {
    const msg = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello world' }], // 11 chars → ceil(11/4) = 3
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as AgentMessage;
    // 11 chars content + 400 metadata overhead
    expect(estimateMessageTokens(msg)).toBe(Math.ceil((11 + 400) / 4));
  });

  it('estimates user message with multiple text parts', () => {
    const msg = {
      id: 'u2',
      role: 'user',
      parts: [
        { type: 'text', text: 'aaaa' }, // 4 chars
        { type: 'text', text: 'bbbbbbbb' }, // 8 chars
      ],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as AgentMessage;
    // 12 chars content + 400 metadata overhead
    expect(estimateMessageTokens(msg)).toBe(Math.ceil((12 + 400) / 4));
  });

  it('estimates assistant message with text and tool call', () => {
    const toolInput = { path: 'src/index.ts' };
    const msg = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me read that file.' },
        {
          type: 'tool-read',
          toolName: 'read',
          input: toolInput,
          output: { content: 'file contents here' },
          state: 'output-available',
        },
      ],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as unknown as AgentMessage;
    const result = estimateMessageTokens(msg);
    // Should include text + toolName + serialised input + serialised output + metadata overhead
    const expectedChars =
      'Let me read that file.'.length +
      'read'.length +
      JSON.stringify(toolInput).length +
      JSON.stringify({ content: 'file contents here' }).length +
      400; // metadata overhead
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  it('returns 0 for empty message (no parts)', () => {
    const msg = {
      id: 'e1',
      role: 'user',
      parts: [],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as AgentMessage;
    // Empty parts but still has metadata overhead
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(400 / 4));
  });

  it('returns 0 for null/undefined message', () => {
    expect(estimateMessageTokens(null as unknown as AgentMessage)).toBe(0);
    expect(estimateMessageTokens(undefined as unknown as AgentMessage)).toBe(0);
  });

  it('handles message with no parts array gracefully', () => {
    const msg = { id: 'x', role: 'user' } as unknown as AgentMessage;
    expect(estimateMessageTokens(msg)).toBe(0);
  });

  it('handles unknown part type via JSON fallback', () => {
    const msg = {
      id: 'u3',
      role: 'user',
      parts: [{ type: 'custom-widget', data: { foo: 'bar' } }],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as unknown as AgentMessage;
    const result = estimateMessageTokens(msg);
    const expectedChars =
      JSON.stringify({
        type: 'custom-widget',
        data: { foo: 'bar' },
      }).length + 400; // metadata overhead
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  it('scales proportionally with large content', () => {
    const largeText = 'x'.repeat(100_000);
    const msg = {
      id: 'u4',
      role: 'user',
      parts: [{ type: 'text', text: largeText }],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    } as AgentMessage;
    // 100k chars + 400 metadata overhead
    expect(estimateMessageTokens(msg)).toBe(Math.ceil((100_000 + 400) / 4));
  });
});
