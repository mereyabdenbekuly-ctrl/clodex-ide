import { randomUUID } from 'node:crypto';
import type {
  ModelExecutionIntent,
  ModelReplaySafety,
  ModelRouteCandidate,
  ModelRouteDecision,
} from '../../host/models';

export * from './budget';

export type ModelEndpointCircuitState = 'closed' | 'open' | 'half-open';
export type ModelEndpointOutcome =
  | 'success'
  | 'provider-error'
  | 'rate-limited'
  | 'cancelled';

export interface ModelEndpointHealthSnapshot {
  endpointKey: string;
  circuitState: ModelEndpointCircuitState;
  consecutiveFailures: number;
  inFlight: number;
  maxConcurrency: number;
  rateLimitedUntil: number | null;
  openedUntil: number | null;
  latencyEwmaMs: number | null;
  successCount: number;
  failureCount: number;
  generation: number;
  available: boolean;
}

export interface ModelEndpointLease {
  id: string;
  endpointKey: string;
  mode: 'normal' | 'probe';
  generation: number;
  acquiredAt: number;
}

export interface ModelEndpointHealthRegistryOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  latencyEwmaAlpha?: number;
  now?: () => number;
  idGenerator?: () => string;
}

export interface ModelEndpointHealthPrior {
  successCount: number;
  failureCount: number;
  latencyMs?: number | null;
}

interface EndpointState {
  consecutiveFailures: number;
  inFlight: number;
  maxConcurrency: number;
  rateLimitedUntil: number | null;
  openedUntil: number | null;
  latencyEwmaMs: number | null;
  successCount: number;
  failureCount: number;
  generation: number;
  probeInFlight: boolean;
}

/**
 * Content-free, deterministic health and capacity registry for model endpoints.
 *
 * A lease is admission only; it never retries or replays an execution. Callers
 * must record exactly one terminal outcome so concurrency capacity is released.
 */
export class ModelEndpointHealthRegistry {
  private readonly states = new Map<string, EndpointState>();
  private readonly activeLeases = new Map<string, ModelEndpointLease>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly latencyEwmaAlpha: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  public constructor(options: ModelEndpointHealthRegistryOptions = {}) {
    this.failureThreshold = normalizePositiveInteger(
      options.failureThreshold ?? 3,
      'failureThreshold',
    );
    this.cooldownMs = normalizeNonNegativeNumber(
      options.cooldownMs ?? 30_000,
      'cooldownMs',
    );
    const alpha = options.latencyEwmaAlpha ?? 0.25;
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
      throw new Error('latencyEwmaAlpha must be in the range (0, 1]');
    }
    this.latencyEwmaAlpha = alpha;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  public configureEndpoint(endpointKey: string, maxConcurrency: number): void {
    const state = this.getState(endpointKey);
    state.maxConcurrency = normalizePositiveInteger(
      maxConcurrency,
      'maxConcurrency',
    );
  }

  /**
   * Seeds a newly created endpoint state from content-free persisted outcomes.
   *
   * Live observations always win: a state that already has outcomes or active
   * leases is never overwritten by startup calibration.
   */
  public seedEndpoint(
    endpointKey: string,
    prior: ModelEndpointHealthPrior,
  ): ModelEndpointHealthSnapshot {
    const state = this.getState(endpointKey);
    if (
      state.successCount > 0 ||
      state.failureCount > 0 ||
      state.inFlight > 0
    ) {
      return this.snapshot(endpointKey);
    }
    state.successCount = normalizeNonNegativeInteger(
      prior.successCount,
      'successCount',
    );
    state.failureCount = normalizeNonNegativeInteger(
      prior.failureCount,
      'failureCount',
    );
    if (prior.latencyMs != null) {
      state.latencyEwmaMs = normalizeNonNegativeNumber(
        prior.latencyMs,
        'latencyMs',
      );
    }
    return this.snapshot(endpointKey);
  }

  /**
   * Restores a provider quota deadline persisted by the local accounting
   * plane. Expired windows are ignored and a later live deadline always wins.
   */
  public seedRateLimit(
    endpointKey: string,
    rateLimitedUntil: number,
  ): ModelEndpointHealthSnapshot {
    const state = this.getState(endpointKey);
    const deadline = normalizeNonNegativeNumber(
      rateLimitedUntil,
      'rateLimitedUntil',
    );
    if (deadline > this.now()) {
      state.rateLimitedUntil = Math.max(state.rateLimitedUntil ?? 0, deadline);
      state.openedUntil = Math.max(state.openedUntil ?? 0, deadline);
    }
    return this.snapshot(endpointKey);
  }

  public snapshot(endpointKey: string): ModelEndpointHealthSnapshot {
    const key = normalizeEndpointKey(endpointKey);
    const state = this.getState(key);
    const now = this.now();
    const circuitState = resolveCircuitState(state, now);
    return {
      endpointKey: key,
      circuitState,
      consecutiveFailures: state.consecutiveFailures,
      inFlight: state.inFlight,
      maxConcurrency: state.maxConcurrency,
      rateLimitedUntil: activeDeadline(state.rateLimitedUntil, now),
      openedUntil: activeDeadline(state.openedUntil, now),
      latencyEwmaMs: state.latencyEwmaMs,
      successCount: state.successCount,
      failureCount: state.failureCount,
      generation: state.generation,
      available:
        !isDeadlineActive(state.rateLimitedUntil, now) &&
        state.inFlight < state.maxConcurrency &&
        (circuitState === 'closed' ||
          (circuitState === 'half-open' && !state.probeInFlight)),
    };
  }

  public listSnapshots(): ModelEndpointHealthSnapshot[] {
    return [...this.states.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((endpointKey) => this.snapshot(endpointKey));
  }

  public tryAcquire(endpointKey: string): ModelEndpointLease | null {
    const key = normalizeEndpointKey(endpointKey);
    const state = this.getState(key);
    const now = this.now();
    if (
      isDeadlineActive(state.rateLimitedUntil, now) ||
      state.inFlight >= state.maxConcurrency
    ) {
      return null;
    }
    const circuitState = resolveCircuitState(state, now);
    if (circuitState === 'open') return null;
    const mode = circuitState === 'half-open' ? 'probe' : 'normal';
    if (mode === 'probe') {
      if (state.probeInFlight) return null;
      state.probeInFlight = true;
    }
    state.inFlight += 1;
    const lease: ModelEndpointLease = {
      id: this.idGenerator(),
      endpointKey: key,
      mode,
      generation: state.generation,
      acquiredAt: now,
    };
    this.activeLeases.set(lease.id, lease);
    return lease;
  }

  public recordOutcome(
    lease: ModelEndpointLease,
    outcome: ModelEndpointOutcome,
    options: { latencyMs?: number; retryAfterMs?: number } = {},
  ): ModelEndpointHealthSnapshot {
    const active = this.activeLeases.get(lease.id);
    if (
      !active ||
      active.endpointKey !== lease.endpointKey ||
      active.generation !== lease.generation
    ) {
      throw new Error('Model endpoint lease is unknown or already completed');
    }
    this.activeLeases.delete(lease.id);
    const state = this.getState(lease.endpointKey);
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (lease.mode === 'probe') state.probeInFlight = false;
    const now = this.now();

    if (outcome === 'success') {
      state.successCount += 1;
      state.consecutiveFailures = 0;
      state.openedUntil = null;
      state.rateLimitedUntil = null;
      if (options.latencyMs !== undefined) {
        const latency = normalizeNonNegativeNumber(
          options.latencyMs,
          'latencyMs',
        );
        state.latencyEwmaMs =
          state.latencyEwmaMs === null
            ? latency
            : this.latencyEwmaAlpha * latency +
              (1 - this.latencyEwmaAlpha) * state.latencyEwmaMs;
      }
      if (lease.mode === 'probe') state.generation += 1;
    } else if (outcome === 'provider-error') {
      state.failureCount += 1;
      state.consecutiveFailures += 1;
      if (
        lease.mode === 'probe' ||
        state.consecutiveFailures >= this.failureThreshold
      ) {
        state.openedUntil = now + this.cooldownMs;
        state.generation += 1;
      }
    } else if (outcome === 'rate-limited') {
      state.failureCount += 1;
      state.consecutiveFailures += 1;
      const retryAfterMs = normalizeNonNegativeNumber(
        options.retryAfterMs ?? this.cooldownMs,
        'retryAfterMs',
      );
      state.rateLimitedUntil = now + retryAfterMs;
      state.openedUntil = Math.max(
        state.openedUntil ?? 0,
        state.rateLimitedUntil,
      );
      state.generation += 1;
    }
    return this.snapshot(lease.endpointKey);
  }

  /**
   * Records health feedback for compatibility traffic that was not admitted
   * through a Fabric lease. Shadow mode must never block the active route, so
   * it observes the outcome without changing concurrency counters.
   */
  public recordObservation(
    endpointKey: string,
    outcome: ModelEndpointOutcome,
    options: { latencyMs?: number; retryAfterMs?: number } = {},
  ): ModelEndpointHealthSnapshot {
    const state = this.getState(endpointKey);
    const now = this.now();
    const wasRecovering =
      state.openedUntil !== null || state.rateLimitedUntil !== null;
    if (outcome === 'success') {
      state.successCount += 1;
      state.consecutiveFailures = 0;
      state.openedUntil = null;
      state.rateLimitedUntil = null;
      if (options.latencyMs !== undefined) {
        const latency = normalizeNonNegativeNumber(
          options.latencyMs,
          'latencyMs',
        );
        state.latencyEwmaMs =
          state.latencyEwmaMs === null
            ? latency
            : this.latencyEwmaAlpha * latency +
              (1 - this.latencyEwmaAlpha) * state.latencyEwmaMs;
      }
      if (wasRecovering) state.generation += 1;
    } else if (outcome === 'provider-error') {
      state.failureCount += 1;
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= this.failureThreshold) {
        state.openedUntil = now + this.cooldownMs;
        state.generation += 1;
      }
    } else if (outcome === 'rate-limited') {
      state.failureCount += 1;
      state.consecutiveFailures += 1;
      const retryAfterMs = normalizeNonNegativeNumber(
        options.retryAfterMs ?? this.cooldownMs,
        'retryAfterMs',
      );
      state.rateLimitedUntil = now + retryAfterMs;
      state.openedUntil = Math.max(
        state.openedUntil ?? 0,
        state.rateLimitedUntil,
      );
      state.generation += 1;
    }
    return this.snapshot(endpointKey);
  }

  private getState(endpointKey: string): EndpointState {
    const key = normalizeEndpointKey(endpointKey);
    let state = this.states.get(key);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        inFlight: 0,
        maxConcurrency: 1,
        rateLimitedUntil: null,
        openedUntil: null,
        latencyEwmaMs: null,
        successCount: 0,
        failureCount: 0,
        generation: 0,
        probeInFlight: false,
      };
      this.states.set(key, state);
    }
    return state;
  }
}

export interface ModelFabricCandidate {
  route: ModelRouteCandidate;
  providerId: string;
  local: boolean;
  contextTokens: number;
  outputTokens: number;
  toolCalling: boolean;
  strictToolSchema: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  inputModalities: readonly ('text' | 'image' | 'audio' | 'video' | 'file')[];
  quality: number;
  estimatedLatencyMs: number;
  estimatedCostUsd: number;
  privacy: number;
  health: ModelEndpointHealthSnapshot;
  evaluationPrior?: {
    resolvedObservations: number;
    pricedObservations: number;
    reliability: number;
    confidence: number;
  };
}

export interface ModelFabricEvaluationPrior {
  modelId: string;
  requestCount: number;
  pricedRequestCount: number;
  successCount: number;
  failureCount: number;
  rateLimitedCount: number;
  averageLatencyMs: number | null;
  averageEstimatedCostUsd: number | null;
}

export interface ModelFabricEvaluationPriorOptions {
  minimumObservations?: number;
  priorWeight?: number;
  maximumEmpiricalWeight?: number;
  maximumQualityAdjustment?: number;
}

/**
 * Applies bounded, Bayesian-shrunk content-free evaluation priors.
 *
 * Model-ID statistics are used only when that ID maps to one catalog route,
 * preventing observations from one provider profile from contaminating a
 * different endpoint with the same model name.
 */
export function applyModelFabricEvaluationPriors(
  candidates: readonly ModelFabricCandidate[],
  priors: readonly ModelFabricEvaluationPrior[],
  options: ModelFabricEvaluationPriorOptions = {},
): ModelFabricCandidate[] {
  const minimumObservations = normalizeNonNegativeInteger(
    options.minimumObservations ?? 5,
    'minimumObservations',
  );
  const priorWeight = normalizePositiveInteger(
    options.priorWeight ?? 20,
    'priorWeight',
  );
  const maximumEmpiricalWeight = normalizeUnitInterval(
    options.maximumEmpiricalWeight ?? 0.75,
    'maximumEmpiricalWeight',
  );
  const maximumQualityAdjustment = normalizeUnitInterval(
    options.maximumQualityAdjustment ?? 0.1,
    'maximumQualityAdjustment',
  );
  const routeCounts = new Map<string, number>();
  for (const candidate of candidates) {
    routeCounts.set(
      candidate.route.modelId,
      (routeCounts.get(candidate.route.modelId) ?? 0) + 1,
    );
  }
  const priorByModelId = new Map(priors.map((prior) => [prior.modelId, prior]));

  return candidates.map((candidate) => {
    if (routeCounts.get(candidate.route.modelId) !== 1) return candidate;
    const prior = priorByModelId.get(candidate.route.modelId);
    if (!prior) return candidate;
    const successCount = normalizeNonNegativeInteger(
      prior.successCount,
      'successCount',
    );
    const resolvedObservations =
      successCount +
      normalizeNonNegativeInteger(prior.failureCount, 'failureCount') +
      normalizeNonNegativeInteger(prior.rateLimitedCount, 'rateLimitedCount');
    if (resolvedObservations < minimumObservations) return candidate;
    const confidence = Math.min(
      maximumEmpiricalWeight,
      resolvedObservations / (resolvedObservations + priorWeight),
    );
    const reliability = (successCount + 2) / (resolvedObservations + 4);
    const baseQuality = clamp01(candidate.quality);
    const targetQuality = clamp01(baseQuality * 0.75 + reliability * 0.25);
    const qualityDelta = Math.max(
      -maximumQualityAdjustment,
      Math.min(maximumQualityAdjustment, targetQuality - baseQuality),
    );
    const requestCount = normalizeNonNegativeInteger(
      prior.requestCount,
      'requestCount',
    );
    const pricedRequestCount = normalizeNonNegativeInteger(
      prior.pricedRequestCount,
      'pricedRequestCount',
    );
    const latencyConfidence =
      requestCount < minimumObservations
        ? 0
        : Math.min(
            maximumEmpiricalWeight,
            requestCount / (requestCount + priorWeight),
          );
    const costConfidence =
      pricedRequestCount < minimumObservations
        ? 0
        : Math.min(
            maximumEmpiricalWeight,
            pricedRequestCount / (pricedRequestCount + priorWeight),
          );
    const empiricalLatency = normalizeOptionalFiniteNonNegative(
      prior.averageLatencyMs,
    );
    const empiricalCost = normalizeOptionalFiniteNonNegative(
      prior.averageEstimatedCostUsd,
    );
    return {
      ...candidate,
      quality: clamp01(baseQuality + qualityDelta * confidence),
      estimatedLatencyMs:
        empiricalLatency === null
          ? candidate.estimatedLatencyMs
          : blend(
              candidate.estimatedLatencyMs,
              empiricalLatency,
              latencyConfidence,
            ),
      estimatedCostUsd:
        empiricalCost === null
          ? candidate.estimatedCostUsd
          : blend(candidate.estimatedCostUsd, empiricalCost, costConfidence),
      evaluationPrior: {
        resolvedObservations,
        pricedObservations: pricedRequestCount,
        reliability,
        confidence,
      },
    };
  });
}

export interface ModelFabricRankedCandidate {
  route: ModelRouteCandidate;
  endpointKey: string;
  score: number;
  reasons: string[];
}

export interface ModelFabricShadowDecision {
  active: ModelRouteCandidate;
  proposed: ModelRouteCandidate | null;
  ranked: ModelFabricRankedCandidate[];
  excluded: Array<{ route: ModelRouteCandidate; reasons: string[] }>;
}

export interface ModelFabricActiveRoutingPolicy {
  minimumScoreAdvantage?: number;
  minimumObservations?: number;
  maximumFailureRate?: number;
  allowUnobservedLocal?: boolean;
}

export interface ModelFabricActiveAdmission {
  admitted: boolean;
  primary: ModelRouteCandidate;
  fallback: ModelRouteCandidate;
  endpointKey: string | null;
  reasons: string[];
}

export interface ModelRouteResolution<T> {
  route: ModelRouteCandidate;
  value: T;
  attemptIndex: number;
  usedFallback: boolean;
}

export type ModelReplayBoundary =
  | 'first-token'
  | 'output-commit'
  | 'tool-dispatch';

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * Extracts a bounded provider retry window without retaining error payloads.
 *
 * Supports the standard `Retry-After` header, common millisecond/seconds
 * variants, absolute reset timestamps, and nested AI SDK error wrappers.
 * Invalid values are ignored and excessively distant values are capped rather
 * than allowing an upstream response to disable an endpoint indefinitely.
 */
export function extractModelRetryAfterMs(
  error: unknown,
  options: { now?: number; maximumMs?: number } = {},
): number | undefined {
  const now = options.now ?? Date.now();
  const maximumMs = normalizeNonNegativeNumber(
    options.maximumMs ?? MAX_RETRY_AFTER_MS,
    'maximumMs',
  );
  let frame: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isUnknownRecord(frame)) break;
    const directMs = firstFiniteNumber(
      frame.retryAfterMs,
      frame.retry_after_ms,
    );
    if (directMs !== undefined) {
      return boundRetryAfterMs(directMs, maximumMs);
    }
    const directSeconds = firstFiniteNumber(
      frame.retryAfter,
      frame.retry_after,
    );
    if (directSeconds !== undefined) {
      return boundRetryAfterMs(directSeconds * 1_000, maximumMs);
    }

    const headers =
      frame.headers ??
      frame.responseHeaders ??
      (isUnknownRecord(frame.response) ? frame.response.headers : undefined);
    const retryAfterMs = readHeader(headers, 'retry-after-ms');
    if (retryAfterMs !== undefined) {
      const parsed = parseFiniteNumber(retryAfterMs);
      if (parsed !== undefined) return boundRetryAfterMs(parsed, maximumMs);
    }
    const retryAfter = readHeader(headers, 'retry-after');
    if (retryAfter !== undefined) {
      const parsed = parseRetryAfterValue(retryAfter, now);
      if (parsed !== undefined) return boundRetryAfterMs(parsed, maximumMs);
    }
    for (const headerName of [
      'x-ratelimit-reset-after',
      'x-rate-limit-reset-after',
    ]) {
      const value = readHeader(headers, headerName);
      const parsed = value === undefined ? undefined : parseFiniteNumber(value);
      if (parsed !== undefined) {
        return boundRetryAfterMs(parsed * 1_000, maximumMs);
      }
    }
    for (const headerName of [
      'x-ratelimit-reset',
      'x-rate-limit-reset',
      'anthropic-ratelimit-requests-reset',
      'anthropic-ratelimit-tokens-reset',
    ]) {
      const value = readHeader(headers, headerName);
      if (value === undefined) continue;
      const parsed = parseAbsoluteResetValue(value, now);
      if (parsed !== undefined) return boundRetryAfterMs(parsed, maximumMs);
    }

    frame =
      frame.lastError instanceof Error
        ? frame.lastError
        : frame.cause instanceof Error
          ? frame.cause
          : undefined;
  }
  return undefined;
}

/**
 * Monotonic replay-safety state machine.
 *
 * Boundaries can only advance. Once a tool is dispatched the effective policy
 * is permanently `never-replay`, preventing a fallback controller from
 * duplicating an external side effect even if later callbacks race.
 */
export class ModelExecutionReplayGuard {
  private firstTokenObserved = false;
  private outputCommitted = false;
  private toolDispatched = false;

  public constructor(private readonly declared: ModelReplaySafety) {}

  public mark(boundary: ModelReplayBoundary): void {
    if (boundary === 'first-token') {
      this.firstTokenObserved = true;
      return;
    }
    if (boundary === 'output-commit') {
      this.firstTokenObserved = true;
      this.outputCommitted = true;
      return;
    }
    this.firstTokenObserved = true;
    this.outputCommitted = true;
    this.toolDispatched = true;
  }

  public canReplay(): boolean {
    if (this.toolDispatched || this.declared === 'never-replay') return false;
    if (this.declared === 'safe') return true;
    if (this.declared === 'safe-before-first-token') {
      return !this.firstTokenObserved;
    }
    if (this.declared === 'safe-before-output-commit') {
      return !this.outputCommitted;
    }
    return !this.toolDispatched;
  }

  public effectivePolicy(): ModelReplaySafety {
    return this.toolDispatched ? 'never-replay' : this.declared;
  }

  public snapshot(): {
    declared: ModelReplaySafety;
    effective: ModelReplaySafety;
    firstTokenObserved: boolean;
    outputCommitted: boolean;
    toolDispatched: boolean;
    canReplay: boolean;
  } {
    return {
      declared: this.declared,
      effective: this.effectivePolicy(),
      firstTokenObserved: this.firstTokenObserved,
      outputCommitted: this.outputCommitted,
      toolDispatched: this.toolDispatched,
      canReplay: this.canReplay(),
    };
  }
}

/**
 * Resolves route resources sequentially before model execution begins.
 *
 * This is the only automatic fallback phase currently permitted by core:
 * no model token, output, or tool side effect exists yet, so retrying another
 * route cannot duplicate user-visible or external effects.
 */
export async function resolveModelRouteBeforeExecution<T>(
  decision: ModelRouteDecision,
  resolve: (route: ModelRouteCandidate, attemptIndex: number) => Promise<T>,
  onAttemptFailure?: (input: {
    route: ModelRouteCandidate;
    attemptIndex: number;
    error: Error;
  }) => void | Promise<void>,
): Promise<ModelRouteResolution<T>> {
  const routes = deduplicateRoutes([decision.primary, ...decision.fallbacks]);
  let lastError: Error | null = null;
  for (let attemptIndex = 0; attemptIndex < routes.length; attemptIndex += 1) {
    const route = routes[attemptIndex]!;
    try {
      return {
        route,
        value: await resolve(route, attemptIndex),
        attemptIndex,
        usedFallback: attemptIndex > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await onAttemptFailure?.({ route, attemptIndex, error: lastError });
    }
  }
  throw (
    lastError ??
    new Error(`No model routes were available for ${decision.primary.modelId}`)
  );
}

/**
 * Converts a shadow decision into a conservative active-routing admission.
 *
 * The function is pure: endpoint capacity is acquired separately so a caller
 * can fail closed if the health snapshot changes between scoring and dispatch.
 */
export function admitModelFabricActiveRoute(
  decision: ModelFabricShadowDecision,
  candidates: readonly ModelFabricCandidate[],
  policy: ModelFabricActiveRoutingPolicy = {},
): ModelFabricActiveAdmission {
  const minimumScoreAdvantage = normalizeUnitInterval(
    policy.minimumScoreAdvantage ?? 0.05,
    'minimumScoreAdvantage',
  );
  const minimumObservations = normalizeNonNegativeInteger(
    policy.minimumObservations ?? 3,
    'minimumObservations',
  );
  const maximumFailureRate = normalizeUnitInterval(
    policy.maximumFailureRate ?? 0.25,
    'maximumFailureRate',
  );
  const proposed = decision.proposed;
  if (!proposed) {
    return deniedActiveAdmission(decision.active, 'no-proposed-route');
  }
  if (sameRouteOrModel(proposed, decision.active)) {
    return deniedActiveAdmission(decision.active, 'already-active');
  }
  const proposedCandidate = candidates.find((candidate) =>
    sameRoute(candidate.route, proposed),
  );
  if (!proposedCandidate) {
    return deniedActiveAdmission(decision.active, 'proposed-route-missing');
  }
  if (!proposedCandidate.health.available) {
    return deniedActiveAdmission(decision.active, 'endpoint-unavailable');
  }
  const proposedRank = decision.ranked.find((candidate) =>
    sameRoute(candidate.route, proposed),
  );
  if (!proposedRank) {
    return deniedActiveAdmission(decision.active, 'proposed-score-missing');
  }
  const activeRank = decision.ranked.find((candidate) =>
    sameRouteOrModel(candidate.route, decision.active),
  );
  const activeScore = activeRank?.score ?? 0;
  const scoreAdvantage = proposedRank.score - activeScore;
  if (scoreAdvantage < minimumScoreAdvantage) {
    return deniedActiveAdmission(
      decision.active,
      `score-advantage=${scoreAdvantage.toFixed(4)}`,
    );
  }
  const observations =
    proposedCandidate.health.successCount +
    proposedCandidate.health.failureCount;
  if (
    observations < minimumObservations &&
    !(policy.allowUnobservedLocal && proposedCandidate.local)
  ) {
    return deniedActiveAdmission(
      decision.active,
      `insufficient-observations=${observations}`,
    );
  }
  const failureRate =
    observations === 0
      ? 0
      : proposedCandidate.health.failureCount / observations;
  if (failureRate > maximumFailureRate) {
    return deniedActiveAdmission(
      decision.active,
      `failure-rate=${failureRate.toFixed(4)}`,
    );
  }
  return {
    admitted: true,
    primary: proposed,
    fallback: decision.active,
    endpointKey: proposedCandidate.health.endpointKey,
    reasons: [
      'active-routing-policy-admitted',
      `score-advantage=${scoreAdvantage.toFixed(4)}`,
      `observations=${observations}`,
      `failure-rate=${failureRate.toFixed(4)}`,
    ],
  };
}

/**
 * Pure shadow scorer. It never changes the active route and stores no content.
 */
export function scoreModelFabricShadowRoutes(
  intent: ModelExecutionIntent,
  active: ModelRouteCandidate,
  candidates: readonly ModelFabricCandidate[],
): ModelFabricShadowDecision {
  const ranked: ModelFabricRankedCandidate[] = [];
  const excluded: ModelFabricShadowDecision['excluded'] = [];
  for (const candidate of candidates) {
    const exclusionReasons = getExclusionReasons(intent, candidate);
    if (exclusionReasons.length > 0) {
      excluded.push({ route: candidate.route, reasons: exclusionReasons });
      continue;
    }
    const priorities = intent.priorities ?? {};
    const qualityWeight = clamp01(priorities.quality ?? 1);
    const latencyWeight = clamp01(priorities.latency ?? 0);
    const costWeight = clamp01(priorities.cost ?? 0);
    const privacyWeight = clamp01(priorities.privacy ?? 0);
    const totalWeight =
      qualityWeight + latencyWeight + costWeight + privacyWeight || 1;
    const healthPenalty =
      candidate.health.latencyEwmaMs === null
        ? 0
        : clamp01(candidate.health.latencyEwmaMs / 60_000) * 0.1;
    const score =
      (qualityWeight * clamp01(candidate.quality) +
        latencyWeight * inverseUnit(candidate.estimatedLatencyMs, 120_000) +
        costWeight * inverseUnit(candidate.estimatedCostUsd, 10) +
        privacyWeight * clamp01(candidate.privacy)) /
        totalWeight -
      healthPenalty;
    ranked.push({
      route: candidate.route,
      endpointKey: candidate.health.endpointKey,
      score,
      reasons: [
        `quality=${clamp01(candidate.quality).toFixed(3)}`,
        `latency_ms=${candidate.estimatedLatencyMs}`,
        `cost_usd=${candidate.estimatedCostUsd}`,
        `privacy=${clamp01(candidate.privacy).toFixed(3)}`,
        `health=${candidate.health.circuitState}`,
        ...(candidate.evaluationPrior
          ? [
              `evaluation_observations=${candidate.evaluationPrior.resolvedObservations}`,
              `evaluation_confidence=${candidate.evaluationPrior.confidence.toFixed(3)}`,
            ]
          : []),
      ],
    });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      routeIdentity(left.route).localeCompare(routeIdentity(right.route)),
  );
  return {
    active,
    proposed: ranked[0]?.route ?? null,
    ranked,
    excluded,
  };
}

function getExclusionReasons(
  intent: ModelExecutionIntent,
  candidate: ModelFabricCandidate,
): string[] {
  const reasons: string[] = [];
  const requirements = intent.requirements ?? {};
  const constraints = intent.constraints ?? {};
  if (!candidate.health.available) reasons.push('endpoint-unavailable');
  if (
    constraints.allowedProviders?.length &&
    !constraints.allowedProviders.includes(candidate.providerId)
  ) {
    reasons.push('provider-not-allowed');
  }
  if (constraints.localOnly && !candidate.local) reasons.push('local-required');
  if (
    constraints.maxCostUsd !== undefined &&
    candidate.estimatedCostUsd > constraints.maxCostUsd
  ) {
    reasons.push('cost-limit');
  }
  if (
    constraints.maxLatencyMs !== undefined &&
    candidate.estimatedLatencyMs > constraints.maxLatencyMs
  ) {
    reasons.push('latency-limit');
  }
  if (
    requirements.contextTokens !== undefined &&
    candidate.contextTokens < requirements.contextTokens
  ) {
    reasons.push('context-capacity');
  }
  if (
    requirements.outputTokens !== undefined &&
    candidate.outputTokens < requirements.outputTokens
  ) {
    reasons.push('output-capacity');
  }
  for (const capability of [
    'toolCalling',
    'strictToolSchema',
    'reasoning',
    'structuredOutput',
  ] as const) {
    if (requirements[capability] && !candidate[capability]) {
      reasons.push(`missing-${capability}`);
    }
  }
  if (
    requirements.inputModalities?.some(
      (modality) => !candidate.inputModalities.includes(modality),
    )
  ) {
    reasons.push('missing-input-modality');
  }
  return reasons;
}

function resolveCircuitState(
  state: EndpointState,
  now: number,
): ModelEndpointCircuitState {
  if (!isDeadlineActive(state.openedUntil, now)) {
    return state.openedUntil === null ? 'closed' : 'half-open';
  }
  return 'open';
}

function activeDeadline(value: number | null, now: number): number | null {
  return isDeadlineActive(value, now) ? value : null;
}

function isDeadlineActive(value: number | null, now: number): boolean {
  return value !== null && value > now;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseFiniteNumber(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function parseFiniteNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (isUnknownRecord(headers) && typeof headers.get === 'function') {
    const value = (headers.get as (headerName: string) => unknown)(name);
    return value == null ? undefined : String(value);
  }
  if (!isUnknownRecord(headers)) return undefined;
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName || value == null) continue;
    return Array.isArray(value) ? String(value[0] ?? '') : String(value);
  }
  return undefined;
}

function parseRetryAfterValue(value: string, now: number): number | undefined {
  const seconds = parseFiniteNumber(value);
  if (seconds !== undefined) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function parseAbsoluteResetValue(
  value: string,
  now: number,
): number | undefined {
  const numeric = parseFiniteNumber(value);
  if (numeric !== undefined) {
    const timestampMs =
      numeric >= 1_000_000_000_000 ? numeric : numeric * 1_000;
    return Math.max(0, timestampMs - now);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function boundRetryAfterMs(value: number, maximumMs: number): number {
  return Math.min(maximumMs, Math.max(0, Math.ceil(value)));
}

function normalizeEndpointKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || normalized.includes('\0')) {
    throw new Error('Invalid model endpoint key');
  }
  return normalized;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function normalizeUnitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be in the range [0, 1]`);
  }
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function inverseUnit(value: number, ceiling: number): number {
  return 1 - clamp01(value / ceiling);
}

function blend(baseline: number, empirical: number, weight: number): number {
  return baseline * (1 - weight) + empirical * weight;
}

function normalizeOptionalFiniteNonNegative(
  value: number | null,
): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function routeIdentity(route: ModelRouteCandidate): string {
  return [
    route.providerProfileId ?? '',
    route.endpointId ?? '',
    route.modelId,
  ].join('\0');
}

function sameRoute(
  left: ModelRouteCandidate,
  right: ModelRouteCandidate,
): boolean {
  return routeIdentity(left) === routeIdentity(right);
}

function sameRouteOrModel(
  left: ModelRouteCandidate,
  right: ModelRouteCandidate,
): boolean {
  return sameRoute(left, right) || left.modelId === right.modelId;
}

function deniedActiveAdmission(
  active: ModelRouteCandidate,
  reason: string,
): ModelFabricActiveAdmission {
  return {
    admitted: false,
    primary: active,
    fallback: active,
    endpointKey: null,
    reasons: ['active-routing-policy-denied', reason],
  };
}

function deduplicateRoutes(
  routes: readonly ModelRouteCandidate[],
): ModelRouteCandidate[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const identity = routeIdentity(route);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
