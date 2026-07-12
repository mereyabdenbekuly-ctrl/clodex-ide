import {
  admitModelFabricActiveRoute,
  applyModelFabricEvaluationPriors,
  extractModelRetryAfterMs,
  ModelExecutionReplayGuard,
  ModelEndpointHealthRegistry,
  resolveModelRouteBeforeExecution,
  scoreModelFabricShadowRoutes,
  type ModelFabricCandidate,
} from './index';

describe('extractModelRetryAfterMs', () => {
  it('reads standard seconds and HTTP-date retry windows', () => {
    expect(
      extractModelRetryAfterMs(
        { headers: { 'retry-after': '2.5' } },
        { now: 1_000 },
      ),
    ).toBe(2_500);
    expect(
      extractModelRetryAfterMs(
        { responseHeaders: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:05 GMT' } },
        { now: 1_000 },
      ),
    ).toBe(4_000);
  });

  it('unwraps provider errors and caps hostile reset windows', () => {
    expect(
      extractModelRetryAfterMs(
        {
          lastError: Object.assign(new Error('rate limited'), {
            headers: { 'retry-after-ms': '1250' },
          }),
        },
        { now: 10 },
      ),
    ).toBe(1_250);
    expect(
      extractModelRetryAfterMs(
        { headers: { 'x-ratelimit-reset': '9999999999999' } },
        { now: 10, maximumMs: 60_000 },
      ),
    ).toBe(60_000);
  });

  it('ignores malformed retry metadata', () => {
    expect(
      extractModelRetryAfterMs({
        retryAfterMs: -1,
        headers: { 'retry-after': 'not-a-date' },
      }),
    ).toBeUndefined();
  });
});

describe('ModelEndpointHealthRegistry', () => {
  it('seeds content-free persisted priors without overwriting live outcomes', () => {
    const registry = new ModelEndpointHealthRegistry();
    expect(
      registry.seedEndpoint('persisted-route', {
        successCount: 8,
        failureCount: 2,
        latencyMs: 240,
      }),
    ).toMatchObject({
      successCount: 8,
      failureCount: 2,
      latencyEwmaMs: 240,
    });
    expect(
      registry.seedEndpoint('persisted-route', {
        successCount: 100,
        failureCount: 0,
        latencyMs: 1,
      }),
    ).toMatchObject({
      successCount: 8,
      failureCount: 2,
      latencyEwmaMs: 240,
    });
  });

  it('enforces concurrency and opens after repeated provider failures', () => {
    let now = 1_000;
    let id = 0;
    const registry = new ModelEndpointHealthRegistry({
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => now,
      idGenerator: () => `lease-${++id}`,
    });
    registry.configureEndpoint('official-openai', 1);

    const first = registry.tryAcquire('official-openai');
    expect(first).not.toBeNull();
    expect(registry.tryAcquire('official-openai')).toBeNull();
    registry.recordOutcome(first!, 'provider-error');

    const second = registry.tryAcquire('official-openai');
    expect(second).not.toBeNull();
    expect(registry.recordOutcome(second!, 'provider-error').circuitState).toBe(
      'open',
    );
    expect(registry.tryAcquire('official-openai')).toBeNull();

    now += 100;
    const probe = registry.tryAcquire('official-openai');
    expect(probe?.mode).toBe('probe');
    expect(registry.tryAcquire('official-openai')).toBeNull();
    expect(
      registry.recordOutcome(probe!, 'success', { latencyMs: 250 })
        .circuitState,
    ).toBe('closed');
  });

  it('honors rate-limit windows and rejects duplicate lease completion', () => {
    let now = 10;
    const registry = new ModelEndpointHealthRegistry({ now: () => now });
    const lease = registry.tryAcquire('clodex');
    registry.recordOutcome(lease!, 'rate-limited', { retryAfterMs: 50 });
    expect(registry.snapshot('clodex')).toMatchObject({
      available: false,
      rateLimitedUntil: 60,
    });
    expect(() => registry.recordOutcome(lease!, 'success')).toThrow(
      'already completed',
    );
    now = 60;
    expect(registry.tryAcquire('clodex')?.mode).toBe('probe');
  });

  it('restores only active persisted quota deadlines and preserves later live windows', () => {
    let now = 100;
    const registry = new ModelEndpointHealthRegistry({ now: () => now });

    expect(registry.seedRateLimit('official:openai', 90)).toMatchObject({
      available: true,
      rateLimitedUntil: null,
    });
    expect(registry.seedRateLimit('official:openai', 200)).toMatchObject({
      available: false,
      rateLimitedUntil: 200,
    });
    registry.seedRateLimit('official:openai', 150);
    expect(registry.snapshot('official:openai').rateLimitedUntil).toBe(200);

    now = 200;
    expect(registry.snapshot('official:openai')).toMatchObject({
      available: true,
      rateLimitedUntil: null,
    });
  });

  it('learns from compatibility traffic without consuming admission capacity', () => {
    let now = 100;
    const registry = new ModelEndpointHealthRegistry({
      failureThreshold: 1,
      cooldownMs: 50,
      now: () => now,
    });
    registry.configureEndpoint('legacy-route', 1);

    expect(
      registry.recordObservation('legacy-route', 'provider-error'),
    ).toMatchObject({
      circuitState: 'open',
      inFlight: 0,
      failureCount: 1,
    });
    now = 150;
    expect(
      registry.recordObservation('legacy-route', 'success', {
        latencyMs: 25,
      }),
    ).toMatchObject({
      circuitState: 'closed',
      available: true,
      inFlight: 0,
      latencyEwmaMs: 25,
      successCount: 1,
    });
  });
});

describe('applyModelFabricEvaluationPriors', () => {
  it('shrinks empirical reliability, latency, and cost into catalog baselines', () => {
    const baseline = candidate('model-a', 'openai', 'official:openai', {
      local: false,
      quality: 0.8,
      latency: 1_000,
      cost: 1,
      toolCalling: true,
    });
    const [calibrated] = applyModelFabricEvaluationPriors(
      [baseline],
      [
        {
          modelId: 'model-a',
          requestCount: 20,
          pricedRequestCount: 20,
          successCount: 18,
          failureCount: 1,
          rateLimitedCount: 1,
          averageLatencyMs: 500,
          averageEstimatedCostUsd: 0.5,
        },
      ],
      { priorWeight: 20 },
    );

    expect(calibrated).not.toBe(baseline);
    expect(calibrated!.quality).toBeGreaterThan(0.8);
    expect(calibrated!.quality).toBeLessThanOrEqual(0.85);
    expect(calibrated!.estimatedLatencyMs).toBe(750);
    expect(calibrated!.estimatedCostUsd).toBe(0.75);
    expect(calibrated!.evaluationPrior).toMatchObject({
      resolvedObservations: 20,
      pricedObservations: 20,
      confidence: 0.5,
    });
  });

  it('ignores sparse and ambiguous model-id observations', () => {
    const first = candidate('shared-model', 'openai', 'endpoint-a', {
      local: false,
      quality: 0.8,
      latency: 1_000,
      cost: 1,
      toolCalling: true,
    });
    const second = candidate('shared-model', 'openai', 'endpoint-b', {
      local: false,
      quality: 0.7,
      latency: 2_000,
      cost: 2,
      toolCalling: true,
    });
    const sparse = candidate('sparse-model', 'openai', 'endpoint-c', {
      local: false,
      quality: 0.7,
      latency: 2_000,
      cost: 2,
      toolCalling: true,
    });
    const priors = [
      {
        modelId: 'shared-model',
        requestCount: 100,
        pricedRequestCount: 100,
        successCount: 100,
        failureCount: 0,
        rateLimitedCount: 0,
        averageLatencyMs: 10,
        averageEstimatedCostUsd: 0,
      },
      {
        modelId: 'sparse-model',
        requestCount: 2,
        pricedRequestCount: 2,
        successCount: 2,
        failureCount: 0,
        rateLimitedCount: 0,
        averageLatencyMs: 10,
        averageEstimatedCostUsd: 0,
      },
    ];

    expect(
      applyModelFabricEvaluationPriors([first, second, sparse], priors),
    ).toEqual([first, second, sparse]);
  });
});

describe('scoreModelFabricShadowRoutes', () => {
  it('filters by capabilities and proposes a route without changing active', () => {
    const registry = new ModelEndpointHealthRegistry();
    registry.configureEndpoint('local', 2);
    registry.configureEndpoint('cloud', 2);
    const candidates: ModelFabricCandidate[] = [
      candidate('local-model', 'ollama', 'local', {
        local: true,
        quality: 0.7,
        latency: 100,
        cost: 0,
        toolCalling: false,
      }),
      candidate('cloud-model', 'openai', 'cloud', {
        local: false,
        quality: 0.95,
        latency: 500,
        cost: 0.1,
        toolCalling: true,
      }),
    ];
    candidates[0]!.health = registry.snapshot('local');
    candidates[1]!.health = registry.snapshot('cloud');

    const active = { modelId: 'existing-model' };
    const decision = scoreModelFabricShadowRoutes(
      {
        purpose: 'agent-step',
        currentModelId: active.modelId,
        agentType: 'chat',
        traceId: 'trace',
        requirements: { toolCalling: true },
        priorities: { quality: 1 },
        replaySafety: 'safe-before-tool-dispatch',
      },
      active,
      candidates,
    );
    expect(decision.active).toEqual(active);
    expect(decision.proposed?.modelId).toBe('cloud-model');
    expect(decision.excluded).toEqual([
      expect.objectContaining({ reasons: ['missing-toolCalling'] }),
    ]);
  });
});

describe('admitModelFabricActiveRoute', () => {
  it('admits a materially better healthy route with sufficient evidence', () => {
    const active = { modelId: 'active' };
    const proposed = { modelId: 'proposed', endpointId: 'endpoint-b' };
    const candidateB = candidate('proposed', 'openai', 'endpoint-b', {
      local: false,
      quality: 0.95,
      latency: 100,
      cost: 0.01,
      toolCalling: true,
    });
    candidateB.health.successCount = 9;
    candidateB.health.failureCount = 1;
    const admission = admitModelFabricActiveRoute(
      {
        active,
        proposed,
        ranked: [
          {
            route: proposed,
            endpointKey: 'endpoint-b',
            score: 0.9,
            reasons: [],
          },
          {
            route: active,
            endpointKey: 'endpoint-a',
            score: 0.7,
            reasons: [],
          },
        ],
        excluded: [],
      },
      [candidateB],
    );
    expect(admission).toMatchObject({
      admitted: true,
      primary: proposed,
      fallback: active,
      endpointKey: 'endpoint-b',
    });
  });

  it('denies unobserved cloud routes but permits explicit local dogfood', () => {
    const active = { modelId: 'active' };
    const proposed = { modelId: 'local', endpointId: 'local' };
    const local = candidate('local', 'ollama', 'local', {
      local: true,
      quality: 0.95,
      latency: 50,
      cost: 0,
      toolCalling: true,
    });
    const decision = {
      active,
      proposed,
      ranked: [
        {
          route: proposed,
          endpointKey: 'local',
          score: 0.9,
          reasons: [],
        },
        {
          route: active,
          endpointKey: 'active',
          score: 0.5,
          reasons: [],
        },
      ],
      excluded: [],
    };
    expect(admitModelFabricActiveRoute(decision, [local]).admitted).toBe(false);
    expect(
      admitModelFabricActiveRoute(decision, [local], {
        allowUnobservedLocal: true,
      }).admitted,
    ).toBe(true);
  });
});

describe('resolveModelRouteBeforeExecution', () => {
  it('falls back only during the pre-execution resolution phase', async () => {
    const failures: string[] = [];
    const resolved = await resolveModelRouteBeforeExecution(
      {
        primary: { modelId: 'primary' },
        fallbacks: [{ modelId: 'fallback' }, { modelId: 'fallback' }],
        replaySafety: 'safe-before-tool-dispatch',
        reasons: [],
      },
      async (route) => {
        if (route.modelId === 'primary') throw new Error('primary unavailable');
        return `resolved:${route.modelId}`;
      },
      ({ route }) => {
        failures.push(route.modelId);
      },
    );
    expect(resolved).toEqual({
      route: { modelId: 'fallback' },
      value: 'resolved:fallback',
      attemptIndex: 1,
      usedFallback: true,
    });
    expect(failures).toEqual(['primary']);
  });

  it('does not invent a runtime replay after all routes fail resolution', async () => {
    await expect(
      resolveModelRouteBeforeExecution(
        {
          primary: { modelId: 'primary' },
          fallbacks: [{ modelId: 'fallback' }],
          replaySafety: 'never-replay',
          reasons: [],
        },
        async (route) => {
          throw new Error(`failed:${route.modelId}`);
        },
      ),
    ).rejects.toThrow('failed:fallback');
  });
});

describe('ModelExecutionReplayGuard', () => {
  it('honors declared boundaries and permanently closes after tool dispatch', () => {
    const beforeOutput = new ModelExecutionReplayGuard(
      'safe-before-output-commit',
    );
    expect(beforeOutput.canReplay()).toBe(true);
    beforeOutput.mark('first-token');
    expect(beforeOutput.canReplay()).toBe(true);
    beforeOutput.mark('output-commit');
    expect(beforeOutput.canReplay()).toBe(false);

    const beforeTool = new ModelExecutionReplayGuard(
      'safe-before-tool-dispatch',
    );
    beforeTool.mark('output-commit');
    expect(beforeTool.canReplay()).toBe(true);
    beforeTool.mark('tool-dispatch');
    expect(beforeTool.snapshot()).toMatchObject({
      effective: 'never-replay',
      toolDispatched: true,
      canReplay: false,
    });
  });

  it('never opens a route declared never-replay', () => {
    const guard = new ModelExecutionReplayGuard('never-replay');
    expect(guard.canReplay()).toBe(false);
    expect(guard.effectivePolicy()).toBe('never-replay');
  });
});

function candidate(
  modelId: string,
  providerId: string,
  endpointKey: string,
  input: {
    local: boolean;
    quality: number;
    latency: number;
    cost: number;
    toolCalling: boolean;
  },
): ModelFabricCandidate {
  return {
    route: { modelId, endpointId: endpointKey },
    providerId,
    local: input.local,
    contextTokens: 128_000,
    outputTokens: 16_000,
    toolCalling: input.toolCalling,
    strictToolSchema: input.toolCalling,
    reasoning: true,
    structuredOutput: true,
    inputModalities: ['text'],
    quality: input.quality,
    estimatedLatencyMs: input.latency,
    estimatedCostUsd: input.cost,
    privacy: input.local ? 1 : 0.5,
    health: {
      endpointKey,
      circuitState: 'closed',
      consecutiveFailures: 0,
      inFlight: 0,
      maxConcurrency: 1,
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
