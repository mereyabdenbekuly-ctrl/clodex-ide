import type { AgentState } from '@clodex/agent-core/types/agent';
import type { ModelWithOptions } from '@clodex/agent-core/host';
import { AGENT_OS_LIMITS } from '@shared/agent-os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
}));

import {
  createHelperAgentHookRunner,
  renderHelperAgentSnapshot,
} from './helper-agent-runner';

function makeState(): AgentState {
  return {
    title: 'Observed agent',
    isWorking: false,
    history: [
      {
        id: 'user-1',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: `Review token api_key=supersecret123 and ${'x'.repeat(20_000)}`,
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'write',
            toolCallId: 'call-1',
            state: 'output-error',
            input: {},
            errorText: 'authorization=anothersecret123',
          },
        ],
        metadata: { createdAt: new Date(), partsMetadata: [] },
      },
    ],
    queuedMessages: [],
    activeModelId: 'test-model',
    toolApprovalMode: 'alwaysAsk',
    fileEditApprovalMode: 'manual',
    pendingApprovals: {},
    inputState: '',
    usedTokens: 0,
    goal: null,
    error: { message: 'Bearer abcdefghijklmnopqrstuvwxyz' },
  } as AgentState;
}

function makeModelWithOptions(modelId = 'test-model'): ModelWithOptions {
  return {
    model: { modelId } as never,
    providerOptions: {
      test: { mode: 'review' },
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 10_000 },
        effort: 'high',
      },
    },
    headers: { 'x-test': '1' },
    contextWindowSize: 200_000,
    providerMode: 'official',
  };
}

beforeEach(() => {
  aiMocks.generateText.mockReset();
});

describe('helper-agent runner', () => {
  it('bounds and redacts lifecycle data before a helper model sees it', () => {
    const snapshot = renderHelperAgentSnapshot('agent-1', makeState(), {
      values: {
        outcome: 'error',
        apiKey: 'contextsecret123',
      },
    });

    expect(snapshot.length).toBeLessThanOrEqual(12_020);
    expect(snapshot).toContain('[REDACTED]');
    expect(snapshot).not.toContain('supersecret123');
    expect(snapshot).not.toContain('anothersecret123');
    expect(snapshot).not.toContain('abcdefghijklmnopqrstuv');
    expect(snapshot).not.toContain('contextsecret123');
    expect(snapshot).toContain('output-error');
  });

  it('uses the active model without tools and redacts the persisted output', async () => {
    const state = makeState();
    const getWithOptions = vi.fn(async () => makeModelWithOptions());
    aiMocks.generateText.mockResolvedValue({
      text: 'authorization=outputsecret123',
    });
    const runner = createHelperAgentHookRunner({
      models: { getWithOptions } as never,
      getAgentState: () => state,
    });

    const output = await runner({
      hook: {
        id: 'hook-1',
        name: 'Observer',
        trigger: 'after-turn',
        kind: 'agent',
        body: 'Report whether the run needs attention.',
        enabled: true,
        timeoutMs: 30_000,
        createdAt: 1,
        updatedAt: 1,
      },
      mode: 'manual',
      context: {
        values: { agentInstanceId: 'agent-1', outcome: 'done' },
      },
    });

    expect(getWithOptions).toHaveBeenCalledWith(
      'test-model',
      expect.stringMatching(/^agent-os-hook:hook-1:/),
      expect.objectContaining({
        $model_request_purpose: 'internal',
        $model_task_role: 'review',
        model_request_purpose: 'internal',
        task_role: 'review',
        hook_id: 'hook-1',
      }),
    );
    const request = aiMocks.generateText.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('tools');
    expect(request).toMatchObject({
      maxOutputTokens: 512,
      maxRetries: 0,
    });
    expect(request).not.toHaveProperty('temperature');
    expect(request?.providerOptions).toMatchObject({
      test: { mode: 'review' },
      anthropic: { thinking: { type: 'disabled' } },
    });
    expect(request?.providerOptions?.anthropic).not.toHaveProperty(
      'thinking.budgetTokens',
    );
    expect(String(request?.prompt)).not.toContain('supersecret123');
    expect(output).toBe('[REDACTED]');
  });

  it('uses the exact originating route and immutable snapshot for automatic reviews', async () => {
    const pinnedModelWithOptions = makeModelWithOptions('originating-model');
    const forkedModelWithOptions = makeModelWithOptions('originating-model');
    const forkTrace = vi.fn(() => forkedModelWithOptions);
    pinnedModelWithOptions.routeLease = {
      isValid: () => true,
      forkTrace,
    };
    forkedModelWithOptions.routeLease = {
      isValid: () => true,
      forkTrace,
    };
    const getWithOptions = vi.fn();
    const getAgentState = vi.fn(() => makeState());
    aiMocks.generateText.mockResolvedValue({ text: 'OK' });
    const runner = createHelperAgentHookRunner({
      models: { getWithOptions } as never,
      getAgentState,
    });

    await runner({
      hook: {
        id: 'hook-2',
        name: 'Pinned observer',
        trigger: 'after-turn',
        kind: 'agent',
        body: 'Review the completed turn.',
        enabled: true,
        timeoutMs: 30_000,
        createdAt: 1,
        updatedAt: 1,
      },
      mode: 'automatic',
      context: {
        values: { agentInstanceId: 'agent-1', outcome: 'done' },
        trustedLifecycle: {
          modelId: 'originating-model',
          modelWithOptions: pinnedModelWithOptions,
          snapshot: '{"marker":"immutable-turn-a"}',
        },
      },
    });

    expect(getWithOptions).not.toHaveBeenCalled();
    expect(getAgentState).not.toHaveBeenCalled();
    expect(forkTrace).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-os-hook:hook-2:/),
      expect.objectContaining({
        $model_request_purpose: 'internal',
        $model_task_role: 'review',
        model_request_purpose: 'internal',
        task_role: 'review',
        hook_id: 'hook-2',
        hook_trigger: 'after-turn',
      }),
    );
    const request = aiMocks.generateText.mock.calls[0]?.[0];
    expect(request?.model).toBe(forkedModelWithOptions.model);
    expect(request?.providerOptions).toMatchObject({
      test: { mode: 'review' },
      anthropic: { thinking: { type: 'disabled' } },
    });
    expect(request?.providerOptions?.anthropic).not.toHaveProperty(
      'thinking.budgetTokens',
    );
    expect(request?.headers).toBe(forkedModelWithOptions.headers);
    expect(String(request?.prompt)).toContain('immutable-turn-a');
  });

  it('fails closed before reading history when automatic provenance is missing', async () => {
    const getWithOptions = vi.fn();
    const getAgentState = vi.fn(() => makeState());
    const runner = createHelperAgentHookRunner({
      models: { getWithOptions } as never,
      getAgentState,
    });

    await expect(
      runner({
        hook: {
          id: 'hook-3',
          name: 'Provider guard',
          trigger: 'after-turn',
          kind: 'agent',
          body: 'Review the completed turn.',
          enabled: true,
          timeoutMs: 30_000,
          createdAt: 1,
          updatedAt: 1,
        },
        mode: 'automatic',
        context: {
          values: {
            agentInstanceId: 'agent-1',
            // Renderer-shaped route claims are inert. Only the backend-only
            // trustedLifecycle object can authorize an automatic review.
            lifecycleSource: 'agent-notification',
            modelId: 'originating-model',
            providerMode: 'official',
          },
        },
      }),
    ).rejects.toThrow('no exact model binding and immutable snapshot');
    expect(getAgentState).not.toHaveBeenCalled();
    expect(getWithOptions).not.toHaveBeenCalled();
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it('fails closed when an automatic route has no host-owned trace fork', async () => {
    const getWithOptions = vi.fn();
    const getAgentState = vi.fn(() => makeState());
    const runner = createHelperAgentHookRunner({
      models: { getWithOptions } as never,
      getAgentState,
    });
    const modelWithOptions = makeModelWithOptions('originating-model');
    modelWithOptions.routeLease = { isValid: () => true };

    await expect(
      runner({
        hook: {
          id: 'hook-no-fork',
          name: 'Provider guard',
          trigger: 'after-turn',
          kind: 'agent',
          body: 'Review the completed turn.',
          enabled: true,
          timeoutMs: 30_000,
          createdAt: 1,
          updatedAt: 1,
        },
        mode: 'automatic',
        context: {
          values: { agentInstanceId: 'agent-1' },
          trustedLifecycle: {
            modelId: 'originating-model',
            modelWithOptions,
            snapshot: '{"marker":"immutable-turn-a"}',
          },
        },
      }),
    ).rejects.toThrow('revocable host-owned trace fork');
    expect(getAgentState).not.toHaveBeenCalled();
    expect(getWithOptions).not.toHaveBeenCalled();
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it('fails closed when the fork is revoked immediately before dispatch', async () => {
    const originating = makeModelWithOptions('originating-model');
    const forked = makeModelWithOptions('originating-model');
    const forkValidity = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    originating.routeLease = {
      isValid: () => true,
      forkTrace: () => forked,
    };
    forked.routeLease = { isValid: forkValidity };
    const runner = createHelperAgentHookRunner({
      models: { getWithOptions: vi.fn() } as never,
      getAgentState: vi.fn(),
    });

    await expect(
      runner({
        hook: {
          id: 'hook-revoked-before-dispatch',
          name: 'Dispatch fence',
          trigger: 'after-turn',
          kind: 'agent',
          body: 'Review it.',
          enabled: true,
          timeoutMs: 1_000,
          createdAt: 1,
          updatedAt: 1,
        },
        mode: 'automatic',
        context: {
          values: { agentInstanceId: 'agent-1' },
          trustedLifecycle: {
            modelId: 'originating-model',
            modelWithOptions: originating,
            snapshot: '{"marker":"immutable-turn-a"}',
          },
        },
      }),
    ).rejects.toThrow('revoked before dispatch');
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it('records an empty model answer as a helper failure', async () => {
    aiMocks.generateText.mockResolvedValue({ text: '   ' });
    const runner = createHelperAgentHookRunner({
      models: {
        getWithOptions: vi.fn(async () => makeModelWithOptions()),
      } as never,
      getAgentState: () => makeState(),
    });

    await expect(
      runner({
        hook: {
          id: 'hook-empty',
          name: 'Empty guard',
          trigger: 'after-turn',
          kind: 'agent',
          body: 'Review it.',
          enabled: true,
          timeoutMs: 1_000,
          createdAt: 1,
          updatedAt: 1,
        },
        mode: 'manual',
        context: { values: { agentInstanceId: 'agent-1' } },
      }),
    ).rejects.toThrow('returned empty output');
  });

  it('hard-caps hostile provider output before persistence', async () => {
    aiMocks.generateText.mockResolvedValue({ text: 'x'.repeat(200_000) });
    const runner = createHelperAgentHookRunner({
      models: {
        getWithOptions: vi.fn(async () => makeModelWithOptions()),
      } as never,
      getAgentState: () => makeState(),
    });

    const output = await runner({
      hook: {
        id: 'hook-output-cap',
        name: 'Output cap',
        trigger: 'after-turn',
        kind: 'agent',
        body: 'Review it.',
        enabled: true,
        timeoutMs: 1_000,
        createdAt: 1,
        updatedAt: 1,
      },
      mode: 'manual',
      context: { values: { agentInstanceId: 'agent-1' } },
    });

    expect(Buffer.byteLength(output ?? '')).toBeLessThanOrEqual(
      AGENT_OS_LIMITS.maxHookOutputBytes,
    );
    expect(output).toContain('[truncated]');
  });

  it('honors the configured timeout and aborts the helper request', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      aiMocks.generateText.mockImplementation(
        (request: { abortSignal?: AbortSignal }) => {
          requestSignal = request.abortSignal;
          return new Promise(() => undefined);
        },
      );
      const runner = createHelperAgentHookRunner({
        models: {
          getWithOptions: vi.fn(async () => makeModelWithOptions()),
        } as never,
        getAgentState: () => makeState(),
      });
      const result = runner({
        hook: {
          id: 'hook-timeout',
          name: 'Timeout guard',
          trigger: 'after-turn',
          kind: 'agent',
          body: 'Review it.',
          enabled: true,
          timeoutMs: 100,
          createdAt: 1,
          updatedAt: 1,
        },
        mode: 'manual',
        context: { values: { agentInstanceId: 'agent-1' } },
      });
      const rejection = expect(result).rejects.toThrow('timed out after 100ms');

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
