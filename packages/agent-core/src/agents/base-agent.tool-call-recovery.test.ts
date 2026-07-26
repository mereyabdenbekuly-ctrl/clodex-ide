import { describe, expect, it, vi } from 'vitest';
import {
  readUIMessageStream,
  simulateReadableStream,
  streamText,
  tool,
  type ModelMessage,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { BaseAgent } from './base-agent';

type RecoveryState = {
  activeModelId: string;
  queuedMessages: unknown[];
  history: Array<{
    id: string;
    role: 'user' | 'assistant';
    metadata?: {
      partsMetadata: Array<{ startedAt?: Date }>;
    };
  }>;
};

type RecoveryContinuation = {
  reason: 'tool-call-recovery';
  kind: 'truncated-input' | 'invalid-input' | 'unknown-tool';
  toolNames: readonly string[];
  attempt: number;
  maxAttempts: number;
} | null;

type RecoveryHarness = {
  instanceId: string;
  agentType: string;
  config: { maxSteps?: number; maxTime?: number };
  host: {
    logger: {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
  };
  state: {
    get: () => RecoveryState;
    commands: {
      recordStepError: ReturnType<typeof vi.fn>;
    };
  };
  _stepGeneration: number;
  _stepResolvedModelId: string;
  _toolCallRecoveryTurnId: string | null;
  _toolCallRecoveryAttempts: number;
  _pendingContinue: boolean | null;
  _pendingSyntheticContinuation: RecoveryContinuation;
  _pendingToolCallRecoveryExhaustion: { message: string } | null;
  onIdle: ReturnType<typeof vi.fn>;
  emitNotificationEvent: ReturnType<typeof vi.fn>;
  shouldRunNewStep: (result: unknown, userWantsToContinue: boolean) => boolean;
  appendSyntheticContinuationIfNeeded: (
    messages: ModelMessage[],
  ) => ModelMessage[];
  settleStepContinuation: (
    stepGeneration: number,
    stepHasApprovalRequest: boolean,
  ) => boolean;
};

function invalidToolResult(
  kind: 'truncated-input' | 'invalid-input' = 'truncated-input',
  includeApproval = false,
) {
  return {
    finishReason: 'stop',
    toolCalls: [{ toolName: 'write' }],
    content: [
      {
        type: 'tool-call',
        invalid: true,
        toolName: 'write',
        error: `Recoverable tool call rejection (${kind}): rejected before execution`,
      },
      ...(includeApproval
        ? [{ type: 'tool-approval-request', approvalId: 'approval-1' }]
        : []),
    ],
  };
}

function createRecoveryHarness() {
  const state: RecoveryState = {
    activeModelId: 'test-model',
    queuedMessages: [],
    history: [{ id: 'user-1', role: 'user' }],
  };
  const agent = Object.create(BaseAgent.prototype) as RecoveryHarness;
  Object.defineProperties(agent, {
    config: { value: {} },
    agentType: { value: 'chat' },
  });
  agent.instanceId = 'agent-1';
  agent.host = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
  agent.state = {
    get: () => state,
    commands: { recordStepError: vi.fn() },
  };
  agent._stepGeneration = 7;
  agent._stepResolvedModelId = 'test-model';
  agent._toolCallRecoveryTurnId = null;
  agent._toolCallRecoveryAttempts = 0;
  agent._pendingContinue = null;
  agent._pendingSyntheticContinuation = null;
  agent._pendingToolCallRecoveryExhaustion = null;
  agent.onIdle = vi.fn();
  agent.emitNotificationEvent = vi.fn();

  return { agent, state };
}

describe('BaseAgent bounded tool-call recovery', () => {
  it('forces compact/chunk retry for provider stop and exhausts after two attempts', () => {
    const { agent } = createRecoveryHarness();

    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(true);
    expect(agent._pendingSyntheticContinuation).toMatchObject({
      reason: 'tool-call-recovery',
      kind: 'truncated-input',
      attempt: 1,
      maxAttempts: 2,
    });

    const firstRetryContext = agent.appendSyntheticContinuationIfNeeded([
      { role: 'tool', content: [] },
    ]);
    expect(firstRetryContext.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining(
        'Split the intended operation into smaller independent tool calls',
      ),
    });
    expect(String(firstRetryContext.at(-1)?.content)).toContain(
      'recovery does not pre-approve any tool call',
    );
    expect(String(firstRetryContext.at(-1)?.content)).toContain(
      'previous call to "unknown"',
    );
    expect(String(firstRetryContext.at(-1)?.content)).not.toContain('"write"');

    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(true);
    expect(agent._pendingSyntheticContinuation).toMatchObject({ attempt: 2 });
    agent.appendSyntheticContinuationIfNeeded([{ role: 'tool', content: [] }]);

    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(false);
    expect(agent._pendingSyntheticContinuation).toBeNull();
    expect(agent._pendingToolCallRecoveryExhaustion?.message).toContain(
      'stopped after 2 attempts',
    );
  });

  it('resets the bounded budget for a new visible user turn', () => {
    const { agent, state } = createRecoveryHarness();

    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(true);
    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(true);
    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(false);

    state.history.push({ id: 'user-2', role: 'user' });
    agent._pendingToolCallRecoveryExhaustion = null;

    expect(agent.shouldRunNewStep(invalidToolResult(), true)).toBe(true);
    expect(agent._pendingSyntheticContinuation).toMatchObject({ attempt: 1 });
  });

  it('never bypasses an open approval to perform autonomous recovery', () => {
    const { agent } = createRecoveryHarness();

    expect(
      agent.shouldRunNewStep(invalidToolResult('truncated-input', true), true),
    ).toBe(false);
    expect(agent._toolCallRecoveryAttempts).toBe(0);
    expect(agent._pendingSyntheticContinuation).toBeNull();
  });

  it('publishes an error rather than a done event when retry budget is exhausted', () => {
    const { agent, state } = createRecoveryHarness();
    state.history.push({ id: 'assistant-1', role: 'assistant' });
    agent._pendingContinue = false;
    agent._pendingToolCallRecoveryExhaustion = {
      message: 'Automatic recovery exhausted',
    };

    expect(agent.settleStepContinuation(7, false)).toBe(true);
    expect(agent.state.commands.recordStepError).toHaveBeenCalledWith({
      error: { message: 'Automatic recovery exhausted' },
      markUnread: 'mark-unread',
    });
    expect(agent.onIdle).toHaveBeenCalledOnce();
    expect(agent.emitNotificationEvent).toHaveBeenCalledWith('error');
    expect(agent.emitNotificationEvent).not.toHaveBeenCalledWith('done');
  });
});

describe('BaseAgent rejected tool evidence', () => {
  type ToolOccurrence = {
    id: string;
    providerToolCallId: string;
    durationMs?: number;
  };
  type DuplicateRejection = {
    executionToolCallId: string;
    providerToolCallId: string;
  };
  type ToolEvidenceHarness = {
    instanceId: string;
    agentType: string;
    host: {
      telemetry: { level: 'full'; capture: ReturnType<typeof vi.fn> };
    };
    state: { get: () => { activeModelId: string } };
    _stepResolvedModelId: string;
    _stepRequestedModelId: string;
    _stepTaskRole: 'analysis';
    _stepModelWithOptions: null;
    _toolCallExecutions: Map<string, ToolOccurrence>;
    _toolCallAdmissions: Map<string, unknown>;
    _toolCallProviderIds: Map<string, string>;
    _preRejectedToolCalls: Map<string, Error>;
    _duplicateToolCallRejectionsByError: WeakMap<object, DuplicateRejection>;
    _duplicateToolCallRejectionsByMessage: Map<string, DuplicateRejection>;
    recordEvidenceEvent: ReturnType<typeof vi.fn>;
    wrapToolsWithTiming: (tools: Record<string, unknown>) => Record<
      string,
      {
        onInputAvailable: (options: {
          toolCallId: string;
          input: unknown;
        }) => Promise<void>;
        needsApproval?: (
          input: unknown,
          options: { toolCallId: string },
        ) => Promise<boolean>;
        execute: (
          input: unknown,
          options: { toolCallId: string },
        ) => Promise<unknown>;
      }
    >;
    wrapModelWithToolCallIdentityFence: (
      model: InstanceType<typeof MockLanguageModelV3>,
    ) => InstanceType<typeof MockLanguageModelV3>;
    emitToolCallEvents: (result: unknown) => void;
  };

  function createToolEvidenceHarness() {
    const capture = vi.fn();
    const recordEvidenceEvent = vi.fn();
    const agent = Object.create(BaseAgent.prototype) as ToolEvidenceHarness;
    Object.defineProperty(agent, 'agentType', { value: 'chat' });
    agent.instanceId = 'agent-1';
    agent.host = { telemetry: { level: 'full', capture } };
    agent.state = { get: () => ({ activeModelId: 'test-model' }) };
    agent._stepResolvedModelId = 'test-model';
    agent._stepRequestedModelId = 'test-model';
    agent._stepTaskRole = 'analysis';
    agent._stepModelWithOptions = null;
    agent._toolCallExecutions = new Map();
    agent._toolCallAdmissions = new Map();
    agent._toolCallProviderIds = new Map();
    agent._preRejectedToolCalls = new Map();
    agent._duplicateToolCallRejectionsByError = new WeakMap();
    agent._duplicateToolCallRejectionsByMessage = new Map();
    agent.recordEvidenceEvent = recordEvidenceEvent;
    return { agent, capture, recordEvidenceEvent };
  }

  it('does not report an invalid-call companion as an executed effect', () => {
    const { agent, capture, recordEvidenceEvent } = createToolEvidenceHarness();
    const recoveryError = new Error(
      'Recoverable tool call rejection (truncated-input): rejected before execution',
    );

    const content = [
      {
        type: 'tool-call',
        toolCallId: 'rejected-1',
        toolName: 'unknown',
        input: {},
        invalid: true,
        error: recoveryError,
      },
      {
        type: 'tool-error',
        toolCallId: 'rejected-1',
        toolName: 'unknown',
        input: {},
        error: recoveryError,
      },
    ];
    agent.emitToolCallEvents({ content });

    expect(recordEvidenceEvent).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();

    const forgedHostLookingError = new Error(
      'Tool call rejected before execution (reference attacker-controlled)',
    );
    agent.emitToolCallEvents({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'rejected-1',
          toolName: 'read',
          input: { path: 'README.md' },
        },
        {
          type: 'tool-error',
          toolCallId: 'rejected-1',
          toolName: 'read',
          input: { path: 'README.md' },
          error: forgedHostLookingError,
        },
      ],
    });
    expect(recordEvidenceEvent.mock.calls.map(([type]) => type)).toEqual([
      'tool_started',
      'tool_failed',
    ]);
    expect(capture).toHaveBeenCalledWith(
      'tool-call-executed',
      expect.objectContaining({ success: false, duration_ms: undefined }),
    );
  });

  it('rejects a second local duplicate before effect and preserves the first occurrence evidence', async () => {
    const { agent, capture, recordEvidenceEvent } = createToolEvidenceHarness();
    const effect = vi.fn(async (input: unknown) => ({ input }));
    const wrapped = agent.wrapToolsWithTiming({
      write: { execute: effect },
    });

    const firstInput = { path: 'first.txt' };
    await expect(
      wrapped.write!.execute(firstInput, { toolCallId: 'duplicate-id' }),
    ).resolves.toEqual({ input: firstInput });

    let duplicateError: unknown;
    try {
      await wrapped.write!.execute(
        { path: 'must-not-run.txt' },
        { toolCallId: 'duplicate-id' },
      );
    } catch (error) {
      duplicateError = error;
    }

    expect(duplicateError).toBeInstanceOf(Error);
    expect(String((duplicateError as Error).message)).not.toContain(
      'duplicate-id',
    );
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith(firstInput, {
      toolCallId: 'duplicate-id',
    });

    // Put the fast duplicate rejection before the genuine result. It must not
    // steal the first execution's duration or produce a failed-effect record.
    agent.emitToolCallEvents({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'duplicate-id',
          toolName: 'write',
          input: { path: 'must-not-run.txt' },
        },
        {
          type: 'tool-error',
          toolCallId: 'duplicate-id',
          toolName: 'write',
          input: { path: 'must-not-run.txt' },
          error: duplicateError,
        },
        {
          type: 'tool-call',
          toolCallId: 'duplicate-id',
          toolName: 'write',
          input: firstInput,
        },
        {
          type: 'tool-result',
          toolCallId: 'duplicate-id',
          toolName: 'write',
          input: firstInput,
          output: { ok: true },
        },
      ],
    });

    expect(recordEvidenceEvent.mock.calls.map(([type]) => type)).toEqual([
      'tool_started',
      'tool_completed',
      'file_written',
    ]);
    const completed = recordEvidenceEvent.mock.calls.find(
      ([type]) => type === 'tool_completed',
    );
    expect(completed?.[1]).toMatchObject({
      toolCallId: 'duplicate-id',
      providerToolCallId: 'duplicate-id',
      toolOccurrenceId: expect.stringMatching(/^tool-occurrence:/),
      durationMs: expect.any(Number),
    });
    expect(completed?.[2]).toMatchObject({
      source: 'tool_call',
      sourceId: completed?.[1].toolOccurrenceId,
      ingestionKey: `tool:${String(completed?.[1].toolOccurrenceId)}:completed`,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      'tool-call-executed',
      expect.objectContaining({
        success: true,
        duration_ms: expect.any(Number),
      }),
    );
  });

  it('rejects a duplicate before needsApproval can restage a capability', async () => {
    const { agent } = createToolEvidenceHarness();
    const stageCapability = vi.fn(async () => false);
    const effect = vi.fn(async () => ({ ok: true }));
    const wrapped = agent.wrapToolsWithTiming({
      shell: {
        needsApproval: stageCapability,
        execute: effect,
      },
    });
    const firstInput = { command: 'printf first' };
    const duplicateInput = { command: 'printf duplicate' };

    await wrapped.shell!.onInputAvailable({
      toolCallId: 'reused-shell-id',
      input: firstInput,
    });
    await expect(
      wrapped.shell!.needsApproval?.(firstInput, {
        toolCallId: 'reused-shell-id',
      }),
    ).resolves.toBe(false);

    await expect(
      wrapped.shell!.onInputAvailable({
        toolCallId: 'reused-shell-id',
        input: duplicateInput,
      }),
    ).resolves.toBeUndefined();
    await expect(
      wrapped.shell!.needsApproval?.(duplicateInput, {
        toolCallId: 'reused-shell-id',
      }),
    ).resolves.toBe(false);

    await expect(
      wrapped.shell!.execute(firstInput, {
        toolCallId: 'reused-shell-id',
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      wrapped.shell!.execute(duplicateInput, {
        toolCallId: 'reused-shell-id',
      }),
    ).rejects.toThrow('Tool call rejected before execution');

    expect(stageCapability).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith(firstInput, {
      toolCallId: 'reused-shell-id',
    });
  });

  it('turns duplicate streamed calls into a tool error without a global provider error', async () => {
    const { agent } = createToolEvidenceHarness();
    const stageCapability = vi.fn(async () => false);
    const effect = vi.fn(async (input: unknown) => ({ input }));
    const tools = agent.wrapToolsWithTiming({
      shell: tool({
        description: 'Duplicate lifecycle integration fixture',
        inputSchema: z.object({ command: z.string() }),
        needsApproval: stageCapability,
        execute: effect,
      }),
    });
    const onError = vi.fn();
    const onFinish = vi.fn();
    const model = agent.wrapModelWithToolCallIdentityFence(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'provider-duplicate-id',
                toolName: 'shell',
                input: JSON.stringify({ command: 'printf first' }),
              },
              {
                type: 'tool-call',
                toolCallId: 'provider-duplicate-id',
                toolName: 'shell',
                input: JSON.stringify({ command: 'printf duplicate' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
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
    );
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Run the fixture.' }],
      tools: tools as never,
      stopWhen: () => true,
      onError,
      onFinish,
    });

    let finalUiMessage: { parts: Array<Record<string, unknown>> } | undefined;
    await Promise.all([
      (async () => {
        for await (const message of readUIMessageStream({
          stream: result.toUIMessageStream(),
        })) {
          finalUiMessage = message as unknown as typeof finalUiMessage;
        }
      })(),
      result.consumeStream(),
    ]);

    expect(onError).not.toHaveBeenCalled();
    expect(stageCapability).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledOnce();
    const finished = onFinish.mock.calls[0]?.[0];
    expect(finished).toMatchObject({
      finishReason: 'tool-calls',
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-result',
          toolCallId: 'provider-duplicate-id',
        }),
        expect.objectContaining({
          type: 'tool-error',
          toolCallId: expect.stringMatching(/^clodex_[0-9a-f]{32}$/),
          error: expect.objectContaining({
            message: expect.stringContaining(
              'Tool call rejected before execution',
            ),
          }),
        }),
      ]),
    });
    const terminalParts = (finalUiMessage?.parts ?? []).filter(
      (part) =>
        (part.state === 'output-available' || part.state === 'output-error') &&
        typeof part.toolCallId === 'string',
    );
    expect(terminalParts).toHaveLength(2);
    expect(new Set(terminalParts.map((part) => part.toolCallId)).size).toBe(2);
    expect(terminalParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'output-available',
          input: { command: 'printf first' },
        }),
        expect.objectContaining({
          state: 'output-error',
          input: { command: 'printf duplicate' },
        }),
      ]),
    );
  });

  it('rejects a provider id reused by a later model request in the same step', async () => {
    const { agent } = createToolEvidenceHarness();
    const stageCapability = vi.fn(async () => false);
    const effect = vi.fn(async (input: unknown) => ({ input }));
    const tools = agent.wrapToolsWithTiming({
      shell: tool({
        description: 'Cross-request duplicate lifecycle fixture',
        inputSchema: z.object({ command: z.string() }),
        needsApproval: stageCapability,
        execute: effect,
      }),
    });
    let requestIndex = 0;
    const model = agent.wrapModelWithToolCallIdentityFence(
      new MockLanguageModelV3({
        doStream: async () => {
          const command =
            requestIndex++ === 0 ? 'printf first' : 'printf duplicate';
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 'provider-cross-request-id',
                  toolName: 'shell',
                  input: JSON.stringify({ command }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
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
          };
        },
      }),
    );
    const onError = vi.fn();
    const runRequest = async () => {
      const result = streamText({
        model,
        messages: [{ role: 'user', content: 'Run one request.' }],
        tools: tools as never,
        stopWhen: () => true,
        onError,
      });
      let finalUiMessage: { parts: Array<Record<string, unknown>> } | undefined;
      await Promise.all([
        (async () => {
          for await (const message of readUIMessageStream({
            stream: result.toUIMessageStream(),
          })) {
            finalUiMessage = message as unknown as typeof finalUiMessage;
          }
        })(),
        result.consumeStream(),
      ]);
      return finalUiMessage;
    };

    const first = await runRequest();
    const duplicate = await runRequest();

    expect(onError).not.toHaveBeenCalled();
    expect(stageCapability).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledOnce();
    expect(first?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'provider-cross-request-id',
          state: 'output-available',
          input: { command: 'printf first' },
        }),
      ]),
    );
    expect(duplicate?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: expect.stringMatching(/^clodex_[0-9a-f]{32}$/),
          state: 'output-error',
          input: { command: 'printf duplicate' },
        }),
      ]),
    );
  });

  it.each([
    'fifo',
    'lifo',
  ] as const)('fails closed for %s final-call order after overlapping duplicate inputs', async (finalOrder) => {
    const { agent } = createToolEvidenceHarness();
    const stageCapability = vi.fn(async () => false);
    const effect = vi.fn(async (input: unknown) => ({ input }));
    const tools = agent.wrapToolsWithTiming({
      shell: tool({
        description: 'Interleaved duplicate lifecycle fixture',
        inputSchema: z.object({ command: z.string() }),
        needsApproval: stageCapability,
        execute: effect,
      }),
    });
    const onError = vi.fn();
    const finalInputs =
      finalOrder === 'fifo'
        ? ['printf safe', 'printf dangerous']
        : ['printf dangerous', 'printf safe'];
    const model = agent.wrapModelWithToolCallIdentityFence(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-input-start',
                id: 'provider-interleaved-id',
                toolName: 'shell',
              },
              {
                type: 'tool-input-delta',
                id: 'provider-interleaved-id',
                delta: '{"command":"printf safe"}',
              },
              {
                type: 'tool-input-end',
                id: 'provider-interleaved-id',
              },
              {
                type: 'tool-input-start',
                id: 'provider-interleaved-id',
                toolName: 'shell',
              },
              {
                type: 'tool-input-delta',
                id: 'provider-interleaved-id',
                delta: '{"command":"printf dangerous"}',
              },
              {
                type: 'tool-input-end',
                id: 'provider-interleaved-id',
              },
              ...finalInputs.map((command) => ({
                type: 'tool-call' as const,
                toolCallId: 'provider-interleaved-id',
                toolName: 'shell',
                input: JSON.stringify({ command }),
              })),
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
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
    );
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Run the interleaved fixture.' }],
      tools: tools as never,
      stopWhen: () => true,
      onError,
    });

    let finalUiMessage: { parts: Array<Record<string, unknown>> } | undefined;
    await Promise.all([
      (async () => {
        for await (const message of readUIMessageStream({
          stream: result.toUIMessageStream(),
        })) {
          finalUiMessage = message as unknown as typeof finalUiMessage;
        }
      })(),
      result.consumeStream(),
    ]);

    expect(onError).not.toHaveBeenCalled();
    expect(stageCapability).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    const toolParts = (finalUiMessage?.parts ?? []).filter(
      (part) =>
        typeof part.toolCallId === 'string' &&
        String(part.type).startsWith('tool-'),
    );
    expect(toolParts).toHaveLength(2);
    expect(toolParts.every((part) => part.state === 'output-error')).toBe(true);
    expect(new Set(toolParts.map((part) => part.toolCallId)).size).toBe(2);
  });

  it.each([
    'fifo',
    'lifo',
  ] as const)('suppresses %s delayed provider approvals after duplicate id reuse', async (approvalOrder) => {
    const { agent } = createToolEvidenceHarness();
    const tools = {
      shell: tool({
        description: 'Provider approval identity fixture',
        inputSchema: z.object({ command: z.string() }),
      }),
    };
    const onError = vi.fn();
    const uiOnError = vi.fn();
    const onFinish = vi.fn();
    const approvalIds =
      approvalOrder === 'fifo'
        ? ['provider-approval-safe', 'provider-approval-dangerous']
        : ['provider-approval-dangerous', 'provider-approval-safe'];
    const model = agent.wrapModelWithToolCallIdentityFence(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'provider-approval-duplicate-id',
                toolName: 'shell',
                input: JSON.stringify({ command: 'git status' }),
                providerExecuted: true,
              },
              {
                type: 'tool-call',
                toolCallId: 'provider-approval-duplicate-id',
                toolName: 'shell',
                input: JSON.stringify({ command: 'git push --force' }),
                providerExecuted: true,
              },
              ...approvalIds.map((approvalId) => ({
                type: 'tool-approval-request' as const,
                approvalId,
                toolCallId: 'provider-approval-duplicate-id',
              })),
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
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
    );
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Run provider approvals.' }],
      tools,
      stopWhen: () => true,
      onError,
      onFinish,
    });

    let finalUiMessage: { parts: Array<Record<string, unknown>> } | undefined;
    await Promise.all([
      (async () => {
        for await (const message of readUIMessageStream({
          stream: result.toUIMessageStream({
            onError: () => 'Ambiguous provider approval rejected',
          }),
          onError: uiOnError,
        })) {
          finalUiMessage = message as unknown as typeof finalUiMessage;
        }
      })(),
      result.consumeStream(),
    ]);

    expect(onError).toHaveBeenCalled();
    expect(uiOnError).toHaveBeenCalled();
    expect(
      (finalUiMessage?.parts ?? []).some(
        (part) => part.state === 'approval-requested',
      ),
    ).toBe(false);
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('keeps the primary approval actionable when a duplicate id is rejected', async () => {
    const { agent } = createToolEvidenceHarness();
    const stageCapability = vi.fn(async () => true);
    const effect = vi.fn(async () => ({ ok: true }));
    const tools = agent.wrapToolsWithTiming({
      shell: tool({
        description: 'Duplicate approval integration fixture',
        inputSchema: z.object({ command: z.string() }),
        needsApproval: stageCapability,
        execute: effect,
      }),
    });
    const model = agent.wrapModelWithToolCallIdentityFence(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'provider-approval-id',
                toolName: 'shell',
                input: JSON.stringify({ command: 'git status' }),
              },
              {
                type: 'tool-call',
                toolCallId: 'provider-approval-id',
                toolName: 'shell',
                input: JSON.stringify({ command: 'git push --force' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
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
    );
    const onError = vi.fn();
    const onFinish = vi.fn();
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Run the approval fixture.' }],
      tools: tools as never,
      stopWhen: () => true,
      onError,
      onFinish,
    });

    let finalUiMessage: { parts: Array<Record<string, unknown>> } | undefined;
    await Promise.all([
      (async () => {
        for await (const message of readUIMessageStream({
          stream: result.toUIMessageStream(),
        })) {
          finalUiMessage = message as unknown as typeof finalUiMessage;
        }
      })(),
      result.consumeStream(),
    ]);

    expect(onError).not.toHaveBeenCalled();
    expect(stageCapability).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
    const finished = onFinish.mock.calls[0]?.[0];
    expect(finished?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-approval-request',
          toolCall: expect.objectContaining({
            toolCallId: 'provider-approval-id',
            input: { command: 'git status' },
          }),
        }),
        expect.objectContaining({
          type: 'tool-error',
          toolCallId: expect.stringMatching(/^clodex_[0-9a-f]{32}$/),
          input: { command: 'git push --force' },
        }),
      ]),
    );
    const approvalPart = (finalUiMessage?.parts ?? []).find(
      (part) => part.state === 'approval-requested',
    );
    const duplicatePart = (finalUiMessage?.parts ?? []).find(
      (part) => part.state === 'output-error',
    );
    expect(approvalPart).toMatchObject({
      toolCallId: 'provider-approval-id',
      state: 'approval-requested',
      input: { command: 'git status' },
      approval: { id: expect.any(String) },
    });
    expect(duplicatePart).toMatchObject({
      toolCallId: expect.stringMatching(/^clodex_[0-9a-f]{32}$/),
      state: 'output-error',
      input: { command: 'git push --force' },
    });
    expect(duplicatePart?.toolCallId).not.toBe(approvalPart?.toolCallId);
  });

  it('reuses durable evidence keys when an external completion is replayed', () => {
    const { agent, capture, recordEvidenceEvent } = createToolEvidenceHarness();
    const namespace = 'a'.repeat(64);
    const content = [
      {
        type: 'tool-result',
        toolCallId: `clodex-external:${namespace}:call:0`,
        providerToolCallId: 'provider-reused-id',
        toolName: 'write',
        input: { path: 'one.txt' },
        output: { ok: true },
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: `clodex-external:${namespace}:call:1`,
        providerToolCallId: 'provider-reused-id',
        toolName: 'write',
        input: { path: 'two.txt' },
        output: { ok: true },
        providerExecuted: true,
      },
    ];

    agent.emitToolCallEvents({ content });
    agent.emitToolCallEvents({ content });

    const completed = recordEvidenceEvent.mock.calls.filter(
      ([type]) => type === 'tool_completed',
    );
    expect(completed).toHaveLength(4);
    const firstPayload = completed[0]?.[1];
    const secondPayload = completed[1]?.[1];
    const firstOptions = completed[0]?.[2];
    const secondOptions = completed[1]?.[2];
    expect(firstPayload).toMatchObject({
      providerToolCallId: 'provider-reused-id',
      toolOccurrenceId: expect.stringMatching(/^tool-occurrence:/),
    });
    expect(secondPayload).toMatchObject({
      providerToolCallId: 'provider-reused-id',
      toolOccurrenceId: expect.stringMatching(/^tool-occurrence:/),
    });
    expect(firstPayload.toolOccurrenceId).not.toBe(
      secondPayload.toolOccurrenceId,
    );
    expect(firstOptions.sourceId).not.toBe(secondOptions.sourceId);
    expect(firstOptions.ingestionKey).not.toBe(secondOptions.ingestionKey);
    expect(completed[2]?.[1]).toEqual(firstPayload);
    expect(completed[3]?.[1]).toEqual(secondPayload);
    expect(completed[2]?.[2]).toMatchObject({
      sourceId: firstOptions.sourceId,
      ingestionKey: firstOptions.ingestionKey,
    });
    expect(completed[3]?.[2]).toMatchObject({
      sourceId: secondOptions.sourceId,
      ingestionKey: secondOptions.ingestionKey,
    });
    const firstPassKeys = recordEvidenceEvent.mock.calls
      .slice(0, 6)
      .map(([, , options]) => options.ingestionKey);
    const replayKeys = recordEvidenceEvent.mock.calls
      .slice(6)
      .map(([, , options]) => options.ingestionKey);
    expect(replayKeys).toEqual(firstPassKeys);
    expect(new Set(firstPassKeys).size).toBe(6);
    expect(capture).toHaveBeenCalledTimes(4);
  });
});
