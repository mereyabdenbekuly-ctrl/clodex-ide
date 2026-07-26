import type { LanguageModel, streamText } from 'ai';
import type { ModelCapabilities } from '../types/models';
import type { ReasoningSignatureSource } from '../types/metadata';

/**
 * The host-specific provider routing mode for a resolved model.
 *
 * - `clodex` — routed through the clodex LLM gateway.
 * - `official` — routed through the vendor's official API using user-
 *   supplied credentials.
 * - `custom` — routed through a user-configured custom endpoint.
 */
export type ProviderMode = 'clodex' | 'official' | 'custom';

/**
 * Purpose for a host model resolution request.
 *
 * Hosts may use this metadata to decide whether user-facing runtime
 * preferences should affect the returned provider options. Missing purpose
 * should be treated as `internal` for backward compatibility.
 */
export type ModelRequestPurpose = 'agent-step' | 'internal';

export const MODEL_REQUEST_PURPOSE_METADATA_KEY = '$model_request_purpose';

export type ModelTaskRole = 'analysis' | 'coding' | 'review';

export const MODEL_TASK_ROLE_METADATA_KEY = '$model_task_role';

/**
 * Stable, provider-neutral purpose for one model execution.
 *
 * Unlike a concrete model ID, the purpose describes why Agent OS needs model
 * capacity. Hosts may use it to select different execution resources for
 * interactive work and prompt-inert background operations.
 */
export type ModelExecutionPurpose =
  | 'agent-step'
  | 'history-compression'
  | 'claim-extraction'
  | 'reranking'
  | 'embedding'
  | 'title-generation'
  | 'vision'
  | 'internal';

export type ModelReplaySafety =
  | 'safe'
  | 'safe-before-first-token'
  | 'safe-before-output-commit'
  | 'safe-before-tool-dispatch'
  | 'never-replay';

export interface ModelExecutionRequirements {
  contextTokens?: number;
  outputTokens?: number;
  toolCalling?: boolean;
  strictToolSchema?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  inputModalities?: readonly ('text' | 'image' | 'audio' | 'video' | 'file')[];
}

/**
 * Relative routing priorities. Values are expected in the inclusive 0..1
 * range, but hosts must normalize defensively because this is a cross-host
 * contract rather than a runtime validation boundary.
 */
export interface ModelExecutionPriorities {
  quality?: number;
  latency?: number;
  cost?: number;
  privacy?: number;
}

export interface ModelExecutionConstraints {
  allowedProviders?: readonly string[];
  localOnly?: boolean;
  maxCostUsd?: number;
  maxLatencyMs?: number;
}

/**
 * Declarative request for model capacity.
 *
 * The first rollout intentionally mirrors {@link ModelTaskRoutingRequest}.
 * This lets hosts introduce the provider-neutral seam without changing the
 * concrete model selected for existing agent steps.
 */
export interface ModelExecutionIntent {
  purpose: ModelExecutionPurpose;
  currentModelId: string;
  taskRole?: ModelTaskRole;
  agentType: string;
  traceId: string;
  preferredModelId?: string;
  unavailableModelIds?: readonly string[];
  requirements?: ModelExecutionRequirements;
  priorities?: ModelExecutionPriorities;
  constraints?: ModelExecutionConstraints;
  replaySafety: ModelReplaySafety;
}

export interface ModelRouteCandidate {
  modelId: string;
  providerProfileId?: string;
  endpointId?: string;
}

/**
 * Auditable output of provider-neutral model routing.
 *
 * Provider and endpoint IDs are optional during the compatibility phase:
 * legacy hosts currently resolve those details lazily in `getWithOptions`.
 */
export interface ModelRouteDecision {
  primary: ModelRouteCandidate;
  fallbacks: ModelRouteCandidate[];
  replaySafety: ModelReplaySafety;
  reasons: string[];
  /**
   * Opaque host admission token for the selected endpoint. Core only echoes
   * it in the terminal outcome receipt; it never interprets or persists it.
   */
  routeAttemptId?: string;
}

export type ModelExecutionOutcome =
  | 'success'
  | 'provider-error'
  | 'rate-limited'
  | 'cancelled';

export interface ModelExecutionOutcomeReport {
  traceId?: string;
  purpose: ModelExecutionPurpose;
  modelId: string;
  providerMode?: ProviderMode;
  taskRole?: ModelTaskRole;
  latencyMs: number;
  outcome: ModelExecutionOutcome;
  replaySafety: ModelReplaySafety;
  toolDispatched: boolean;
  /** False only when route/model resolution failed before generation began. */
  executionStarted?: boolean;
  retryAfterMs?: number;
  routeAttemptId?: string;
}

export type ModelTaskRoutingRequest = {
  currentModelId: string;
  taskRole: ModelTaskRole;
  agentType: string;
  traceId: string;
  /**
   * Optional model requested by an orchestrated task. Hosts may return this
   * exact model when available, or a same-provider substitute when the
   * selected account/key does not expose the requested concrete model ID.
   */
  preferredModelId?: string;
  /**
   * Concrete model IDs that already failed for this task at runtime. Hosts
   * should avoid returning them when selecting a same-provider substitute.
   */
  unavailableModelIds?: string[];
};

/**
 * Fully-resolved model with all the options `BaseAgent` needs to
 * invoke `streamText` / `generateText`.
 *
 * Produced by `HostModels.getWithOptions`. The concrete shape mirrors
 * the host's `ModelProviderService.getModelWithOptions` return value
 * so hosts do not have to repack the data.
 */
export interface ModelWithOptions {
  /** Ready-to-stream `ai-sdk` language model with any host middleware applied. */
  model: LanguageModel;
  /**
   * Provider-keyed options (e.g. `{ anthropic: {…}, clodex: {…} }`),
   * passed through to `streamText` as-is. Callers may layer further
   * overrides via `deepMergeProviderOptions`.
   */
  providerOptions: Parameters<typeof streamText>[0]['providerOptions'];
  /** Request headers the host wants applied to every call. */
  headers: Record<string, string>;
  /** Total context window size in tokens for this model. */
  contextWindowSize: number;
  /** Host-specific routing mode that produced this model. */
  providerMode: ProviderMode;
  /**
   * Host-specific identifier for a connected coding/subscription plan
   * (e.g. `'glm-coding-plan'`). Only populated when `providerMode ===
   * 'official'` and the user connected via a coding plan rather than a
   * plain API key. Core stays agnostic — passes the string through to
   * telemetry.
   */
  connectedCodingPlanId?: string;
  /**
   * Semantic owner of any signed `reasoning_details` this route produces.
   * Threaded through the step so capture tags the metadata and conversion
   * re-injects signatures only for matching future routes. Optional: hosts
   * that don't track reasoning signatures may omit it (capture/replay then
   * no-op). See {@link ReasoningSignatureSource}.
   */
  reasoningSignatureSource?: ReasoningSignatureSource;
  /**
   * When true, the agent must strip the `strict` field from every tool
   * definition before passing them to `streamText`. Required for
   * providers whose backend rejects unknown fields on the tool payload
   * — notably Bedrock-on-Anthropic, where `strict` surfaces as
   * `tools.0.custom.strict: Extra inputs are not permitted`.
   */
  stripStrictFromTools?: boolean;
  /**
   * Host-owned revocation check for delayed in-process uses of this exact
   * route. It is never serialized; credential/endpoint/auth changes should
   * invalidate it.
   */
  routeLease?: {
    isValid(): boolean;
    /**
     * Rebuilds the same admitted provider route with a fresh host-owned trace.
     * The host must reject the fork after revocation. This lets delayed
     * internal observers retain exact route provenance without reusing the
     * originating user-facing request's tracing middleware.
     */
    forkTrace?(
      traceId: string,
      metadata?: Record<string, unknown>,
    ): ModelWithOptions;
  };
}

/**
 * Model-retrieval contract supplied by the host.
 *
 * agent-core consumes ready-to-stream `ai-sdk` language models; the
 * host is responsible for auth, provider routing, endpoint selection,
 * and any telemetry/tracing middleware wrapped around the model.
 *
 * `getWithOptions` is the primary entry point used by `BaseAgent`. The
 * lighter `get` variant exists as a convenience for call sites that
 * only need the model itself and is implemented in terms of
 * `getWithOptions` by default adapters.
 */
export interface HostModels {
  /**
   * Returns a fully-resolved {@link ModelWithOptions} for `modelId`,
   * with auth, provider routing, and telemetry middleware already
   * applied.
   *
   * Rejects with an `Error` whose `.message` names the missing model
   * when `modelId` is unknown, or whose `.message` describes the
   * upstream failure when provider resolution or auth fails.
   *
   * `traceId` is passed through so the host can attach it to any
   * telemetry/middleware it wraps around the returned model.
   * `metadata` carries optional host-specific trace properties
   * (currently used for PostHog). Hosts may also read the reserved
   * {@link MODEL_REQUEST_PURPOSE_METADATA_KEY} key to distinguish
   * user-facing agent steps from internal utility calls. Missing purpose
   * must be treated as `internal` for backward compatibility.
   */
  getWithOptions(
    modelId: string,
    traceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<ModelWithOptions>;

  /**
   * Optionally resolves the concrete model that should handle a task role.
   *
   * Hosts can use this to route analysis/research, coding, and review/checking
   * through different models while keeping `AgentState.activeModelId` as the
   * user's selected chat model. Returning `undefined` or `currentModelId`
   * disables routing for that step.
   */
  selectModelForTask?(
    request: ModelTaskRoutingRequest,
  ): string | undefined | Promise<string | undefined>;

  /**
   * Provider-neutral routing seam.
   *
   * The compatibility implementation may delegate to
   * {@link selectModelForTask}; future Model Fabric implementations can also
   * account for endpoint health, quota, cost, privacy, and capability fit.
   * Resolving an intent must not dispatch a provider request.
   */
  resolveForIntent?(
    intent: ModelExecutionIntent,
  ): ModelRouteDecision | Promise<ModelRouteDecision>;
  /**
   * Content-free health feedback. Hosts may use it to update endpoint health
   * and future routing scores; it must never trigger an execution replay.
   */
  reportExecutionOutcome?(
    report: ModelExecutionOutcomeReport,
  ): void | Promise<void>;

  /**
   * Convenience shortcut for `getWithOptions(...).then(r => r.model)`.
   * Intended for sites that only need the `LanguageModel`.
   */
  get(modelId: string, traceId: string): Promise<LanguageModel>;

  /**
   * Synchronous existence check. Cheap; intended for UI-facing
   * fallbacks ("model unavailable, use default?").
   */
  has(modelId: string): boolean;

  /**
   * Returns the {@link ModelCapabilities} for `modelId` (input/output
   * modalities, per-modality constraints, tool-calling support).
   *
   * Cheap, synchronous, and side-effect free: capabilities are static
   * metadata sourced from the host's model catalog (built-in plus any
   * user-defined custom models). Hosts that resolve capabilities over
   * a wire should cache aggressively or pre-load on boot so this method
   * remains synchronous from the core's perspective.
   *
   * Falls back to a text-only capability set when the model is unknown
   * (e.g. a deleted custom model) so callers never have to handle a
   * missing-model branch separately.
   */
  getCapabilities(modelId: string): ModelCapabilities;
}
