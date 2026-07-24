import { describe, expect, it, vi } from 'vitest';
import type { ModelWithOptions } from '../host';
import { BaseAgent } from './base-agent';

type Settlement = 'completed' | 'failed' | 'superseded';
type SettlementResult = {
  outcome: Settlement;
  state: { marker: string };
};

type SettlementHarness = {
  state: { get: () => { marker: string } };
  _activeStepRun: {
    settled: Promise<SettlementResult>;
  } | null;
  waitForCurrentStepSettlement: () => Promise<
    SettlementResult | { outcome: 'idle'; state: { marker: string } }
  >;
};

function createHarness(): SettlementHarness {
  const agent = Object.create(BaseAgent.prototype) as SettlementHarness;
  agent.state = { get: () => ({ marker: 'idle-snapshot' }) };
  agent._activeStepRun = null;
  return agent;
}

describe('BaseAgent.waitForCurrentStepSettlement', () => {
  it('returns idle when no step is active', async () => {
    await expect(
      createHarness().waitForCurrentStepSettlement(),
    ).resolves.toEqual({
      outcome: 'idle',
      state: { marker: 'idle-snapshot' },
    });
  });

  it('waits for the step captured at call time', async () => {
    const agent = createHarness();
    let settle!: (settlement: SettlementResult) => void;
    agent._activeStepRun = {
      settled: new Promise<SettlementResult>((resolve) => {
        settle = resolve;
      }),
    };
    const observer = vi.fn();
    const waiting = agent.waitForCurrentStepSettlement().then(observer);

    await Promise.resolve();
    expect(observer).not.toHaveBeenCalled();

    settle({ outcome: 'failed', state: { marker: 'settled-snapshot' } });
    await waiting;
    expect(observer).toHaveBeenCalledWith({
      outcome: 'failed',
      state: { marker: 'settled-snapshot' },
    });
  });
});

describe('BaseAgent lifecycle notification provenance', () => {
  it('passes the exact resolved model route without serializing or re-resolving it', () => {
    const modelWithOptions = {
      model: { modelId: 'originating-model' },
      providerOptions: {},
      headers: { authorization: 'in-process-only' },
      contextWindowSize: 200_000,
      providerMode: 'custom',
    } as unknown as ModelWithOptions;
    const notificationEventHandler = vi.fn();
    const agent = Object.create(BaseAgent.prototype) as {
      instanceId: string;
      state: { get: () => { activeModelId: string } };
      host: { logger: { debug: ReturnType<typeof vi.fn> } };
      notificationEventHandler: typeof notificationEventHandler;
      _stepResolvedModelId: string;
      _stepModelWithOptions: ModelWithOptions | null;
      emitNotificationEvent: (event: 'done') => void;
    };
    agent.instanceId = 'agent-1';
    agent.state = { get: () => ({ activeModelId: 'newer-selection' }) };
    agent.host = { logger: { debug: vi.fn() } };
    agent.notificationEventHandler = notificationEventHandler;
    agent._stepResolvedModelId = 'originating-model';
    agent._stepModelWithOptions = modelWithOptions;

    agent.emitNotificationEvent('done');

    expect(notificationEventHandler).toHaveBeenCalledWith('done', 'agent-1', {
      modelId: 'originating-model',
      modelWithOptions,
    });
  });
});
