import { describe, expect, it, vi } from 'vitest';
import {
  LocalAgentStepExecutor,
  resolveAgentToolCapabilityScopes,
} from './agent-step-executor';

describe('LocalAgentStepExecutor', () => {
  it('delegates to streamText without changing the options object', () => {
    const execution = {
      consumeStream: vi.fn(),
      toUIMessageStream: vi.fn(),
    };
    const streamTextFn = vi.fn(() => execution);
    const executor = new LocalAgentStepExecutor(streamTextFn as never);
    const options = {
      model: {} as never,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };

    const result = executor.execute({
      context: {
        agentInstanceId: 'agent-1',
        agentType: 'chat',
        traceId: 'trace-1',
        requestedModelId: 'selected-model',
        resolvedModelId: 'routed-model',
        isApprovalContinuation: false,
        metadata: {},
      },
      options,
    });

    expect(result.modelRouteBinding).toBe('request-model');
    expect(result.consumeStream).not.toBe(execution.consumeStream);
    result.consumeStream();
    expect(execution.consumeStream).toHaveBeenCalledOnce();
    expect(streamTextFn).toHaveBeenCalledOnce();
    expect(streamTextFn).toHaveBeenCalledWith(options);
  });

  it('keeps approval continuation scope stable and later scopes distinct', () => {
    const initial = resolveAgentToolCapabilityScopes({
      agentInstanceId: 'agent-1',
      stepGeneration: 11,
      historyMessageIds: ['user-1'],
      isApprovalContinuation: false,
      pendingApprovalScopeId: null,
    });
    const continuation = resolveAgentToolCapabilityScopes({
      agentInstanceId: 'agent-1',
      stepGeneration: 12,
      historyMessageIds: ['user-1', 'assistant-approval'],
      isApprovalContinuation: true,
      pendingApprovalScopeId: initial.currentScopeId,
    });
    const laterResponse = resolveAgentToolCapabilityScopes({
      agentInstanceId: 'agent-1',
      stepGeneration: 13,
      historyMessageIds: ['user-1', 'assistant-approval', 'user-2'],
      isApprovalContinuation: false,
      pendingApprovalScopeId: null,
    });

    expect(continuation.approvalOriginScopeId).toBe(initial.currentScopeId);
    expect(continuation.currentScopeId).not.toBe(initial.currentScopeId);
    expect(laterResponse.currentScopeId).not.toBe(continuation.currentScopeId);
    expect(initial.currentScopeId).toMatch(/^[a-f0-9]{64}$/);
  });
});
