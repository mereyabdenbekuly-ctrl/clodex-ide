import {
  applyModelFabricEvaluationPriors,
  extractModelRetryAfterMs,
  ModelExecutionReplayGuard,
  ModelEndpointHealthRegistry,
  resolveModelRouteBeforeExecution,
  type ModelFabricCandidate,
} from './index';

describe('Model Fabric conformance', () => {
  it('permits automatic fallback only before execution and never after tool dispatch', async () => {
    const attempts: string[] = [];
    const resolution = await resolveModelRouteBeforeExecution(
      {
        primary: { modelId: 'primary' },
        fallbacks: [{ modelId: 'fallback' }],
        replaySafety: 'safe-before-tool-dispatch',
        reasons: [],
      },
      async (route) => {
        attempts.push(route.modelId);
        if (route.modelId === 'primary') throw new Error('resolution failed');
        return route.modelId;
      },
    );
    expect(attempts).toEqual(['primary', 'fallback']);
    expect(resolution).toMatchObject({
      route: { modelId: 'fallback' },
      usedFallback: true,
    });

    const guard = new ModelExecutionReplayGuard('safe-before-tool-dispatch');
    guard.mark('tool-dispatch');
    expect(guard.snapshot()).toMatchObject({
      effective: 'never-replay',
      canReplay: false,
      toolDispatched: true,
    });
  });

  it('restores provider backoff, caps hostile retry metadata, and admits no work during the window', () => {
    let now = 1_000;
    const registry = new ModelEndpointHealthRegistry({ now: () => now });
    const retryAfterMs = extractModelRetryAfterMs(
      { headers: { 'retry-after-ms': '999999999999' } },
      { now, maximumMs: 60_000 },
    );
    expect(retryAfterMs).toBe(60_000);
    registry.seedRateLimit('official:provider', now + retryAfterMs!);
    expect(registry.tryAcquire('official:provider')).toBeNull();
    now += 60_000;
    expect(registry.tryAcquire('official:provider')).not.toBeNull();
  });

  it('keeps sparse or endpoint-ambiguous evaluation data out of scoring inputs', () => {
    const candidates = [
      candidate('shared', 'endpoint-a'),
      candidate('shared', 'endpoint-b'),
      candidate('sparse', 'endpoint-c'),
    ];
    const calibrated = applyModelFabricEvaluationPriors(candidates, [
      {
        modelId: 'shared',
        requestCount: 100,
        pricedRequestCount: 100,
        successCount: 100,
        failureCount: 0,
        rateLimitedCount: 0,
        averageLatencyMs: 1,
        averageEstimatedCostUsd: 0,
      },
      {
        modelId: 'sparse',
        requestCount: 2,
        pricedRequestCount: 2,
        successCount: 2,
        failureCount: 0,
        rateLimitedCount: 0,
        averageLatencyMs: 1,
        averageEstimatedCostUsd: 0,
      },
    ]);
    expect(calibrated).toEqual(candidates);
  });
});

function candidate(modelId: string, endpointKey: string): ModelFabricCandidate {
  return {
    route: { modelId, endpointId: endpointKey },
    providerId: 'provider',
    local: false,
    contextTokens: 128_000,
    outputTokens: 16_384,
    toolCalling: true,
    strictToolSchema: true,
    reasoning: true,
    structuredOutput: true,
    inputModalities: ['text'],
    quality: 0.8,
    estimatedLatencyMs: 1_000,
    estimatedCostUsd: 1,
    privacy: 0.8,
    health: {
      endpointKey,
      circuitState: 'closed',
      consecutiveFailures: 0,
      inFlight: 0,
      maxConcurrency: 4,
      rateLimitedUntil: null,
      openedUntil: null,
      latencyEwmaMs: null,
      successCount: 0,
      failureCount: 0,
      generation: 0,
      available: true,
    },
  };
}
