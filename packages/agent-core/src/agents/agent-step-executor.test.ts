import { describe, expect, it, vi } from 'vitest';
import { LocalAgentStepExecutor } from './agent-step-executor';

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

    expect(result).toBe(execution);
    expect(streamTextFn).toHaveBeenCalledOnce();
    expect(streamTextFn).toHaveBeenCalledWith(options);
  });
});
