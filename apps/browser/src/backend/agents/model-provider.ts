import type { TelemetryService } from '@/services/telemetry';
import type { ModelAlias, ModelId } from '@shared/available-models';
import type {
  ModelProvider,
  ApiSpec,
  CustomModel,
  CustomEndpoint,
  ModelThinkingOverride,
} from '@shared/karton-contracts/ui/shared-types';
import type { ReasoningSignatureSource } from '@shared/karton-contracts/ui/agent/metadata';
import {
  createReasoningSignatureSource,
  getSemanticProviderForApiSpec,
  type ProviderMode,
} from './reasoning-signatures';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import {
  availableModels,
  getAvailableModel,
  getModelAlias,
} from '@shared/available-models';
import { CODING_PLANS } from '@shared/coding-plans';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAzure } from '@ai-sdk/azure';
import { createVertex } from '@ai-sdk/google-vertex';
import { createClodex } from './clodex-provider';
import { createBedrockProvider } from './bedrock-provider';
import type { AuthService, AuthState } from '@/services/auth';
import type { PreferencesService } from '@/services/preferences';
import type { CredentialsService } from '@/services/credentials';
import { AIProviderRegistry, type AIModelInfo } from '@shared/ai-provider';
import { createBuiltInProviderAdapters } from './providers/built-in-adapters';
import type { streamText, LanguageModelMiddleware } from 'ai';
import { wrapLanguageModel } from 'ai';
import {
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
  type ModelTaskRole,
  type ModelTaskRoutingRequest,
} from '@clodex/agent-core/host';
import {
  createThinkingProviderOptionsPatch,
  supportsNativeThinkingProviderProfile,
  type ThinkingCapableModel,
} from '@shared/model-thinking-capabilities';
import { getModelThinkingOverride } from '@shared/model-effort-routing';
import { resolveModelContextWindow } from '@shared/model-context-window';

type ProviderOptions = Parameters<typeof streamText>[0]['providerOptions'];
type BuiltInModelSettings = (typeof availableModels)[number];
type ThinkingModelSettings = ThinkingCapableModel;
type ClodexAuthModel = NonNullable<AuthState['models']>[number];

// Conservative internal budgets only. The UI deliberately reports unknown
// when no provider/catalog capability is available instead of presenting
// either fallback as a model-declared context window.
const CLODEX_UNKNOWN_MODEL_CONTEXT_WINDOW_BUDGET = 200_000;
const PROVIDER_PROFILE_UNKNOWN_CONTEXT_WINDOW_BUDGET = 128_000;
const CLODEX_BUILT_IN_SAME_PROVIDER_FALLBACKS: Partial<
  Record<ModelProvider, readonly string[]>
> = {
  google: ['gemini-3.5-flash'],
};

function getBareModelId(modelId: string): string {
  return modelId.split('/').pop() ?? modelId;
}

export function parseQualifiedModelId(
  value: string,
): { providerProfileId: string; modelId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    providerProfileId: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

function getDynamicGpt5ThinkingModel(
  modelId: string,
  semanticProvider: ModelProvider,
): ThinkingModelSettings | undefined {
  const bareModelId = getBareModelId(modelId).toLowerCase();
  if (semanticProvider !== 'openai' || !/^gpt-5(?:\.|$)/.test(bareModelId)) {
    return undefined;
  }

  return {
    modelId,
    officialProvider: 'openai',
    thinkingEnabled: true,
    providerOptions: {
      clodex: { reasoning: { effort: 'medium' } },
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
    },
  };
}

function sanitizeClodexProviderOptions(
  providerOptions: ProviderOptions,
): ProviderOptions {
  if (!providerOptions || typeof providerOptions !== 'object') {
    return providerOptions;
  }

  const clodex = providerOptions.clodex;
  if (!isPlainObject(clodex)) return providerOptions;
  const reasoning = clodex.reasoning;
  if (!isPlainObject(reasoning) || !('enabled' in reasoning)) {
    return providerOptions;
  }

  const { enabled: _enabled, ...safeReasoning } = reasoning;
  return {
    ...providerOptions,
    clodex: {
      ...clodex,
      ...(Object.keys(safeReasoning).length > 0
        ? { reasoning: safeReasoning }
        : { reasoning: undefined }),
    },
  } as ProviderOptions;
}

function normalizeProviderName(provider: string | undefined): string {
  return (
    provider
      ?.trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-') ?? ''
  );
}

function toSemanticProvider(
  provider: string | undefined,
  modelId: string,
): ModelProvider {
  switch (normalizeProviderName(provider)) {
    case 'anthropic':
    case 'anthropic-compatible':
    case 'claude':
      return 'anthropic';
    case 'google':
    case 'google-compatible':
    case 'gemini':
      return 'google';
    case 'moonshotai':
    case 'moonshot':
    case 'kimi':
      return 'moonshotai';
    case 'alibaba':
    case 'qwen':
    case 'dashscope':
      return 'alibaba';
    case 'deepseek':
      return 'deepseek';
    case 'z-ai':
    case 'zai':
    case 'glm':
      return 'z-ai';
    case 'minimax':
      return 'minimax';
    case 'xiaomi-mimo':
    case 'xiaomi':
    case 'mimo':
      return 'xiaomi-mimo';
    case 'mistral':
    case 'mistralai':
      return 'mistral';
    case 'openai':
    case 'openai-compatible':
    default:
      break;
  }

  const bareModelId = getBareModelId(modelId).toLowerCase();
  if (bareModelId.startsWith('claude-')) return 'anthropic';
  if (bareModelId.startsWith('gemini-')) return 'google';
  if (bareModelId.startsWith('kimi-')) return 'moonshotai';
  if (bareModelId.startsWith('qwen')) return 'alibaba';
  if (bareModelId.startsWith('deepseek-')) return 'deepseek';
  if (bareModelId.startsWith('glm-')) return 'z-ai';
  if (bareModelId.startsWith('minimax-')) return 'minimax';
  if (bareModelId.startsWith('mimo-')) return 'xiaomi-mimo';
  if (bareModelId.startsWith('mistral-')) return 'mistral';
  return 'openai';
}

/**
 * Converts an OpenRouter-style Anthropic model ID (dots in version, e.g.
 * `claude-opus-4.8`) to the native Anthropic API format (hyphens, e.g.
 * `claude-opus-4-8`). Idempotent on IDs that already use hyphens.
 */
function toNativeAnthropicModelId(modelId: string): string {
  return modelId.replace(/\./g, '-');
}

function toClodexGatewayModelId(
  provider: ModelProvider | undefined,
  modelId: string,
): string {
  if (provider === 'anthropic') return toNativeAnthropicModelId(modelId);
  return modelId;
}

function toNativeMiniMaxModelId(modelId: string): string {
  if (modelId === 'minimax-m3') return 'MiniMax-M3';
  return modelId;
}

/**
 * Middleware that tells the SDK all HTTP(S) URLs are natively supported by the
 * clodex gateway. Without this the SDK downloads every image/file URL and
 * inlines the content as base64, causing "payload too large" errors.
 */
const clodexUrlPassthroughMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  overrideSupportedUrls: () => ({
    '*': [/^https?:\/\//i],
  }),
};

export type { ProviderMode } from './reasoning-signatures';

export type ModelWithOptions = {
  model: LanguageModelV3;
  providerOptions: Parameters<typeof streamText>[0]['providerOptions'];
  headers: Record<string, string>;
  contextWindowSize: number;
  providerMode: ProviderMode;
  connectedCodingPlanId?: string;
  reasoningSignatureSource: ReasoningSignatureSource;
  /**
   * When true, the agent must strip the `strict` field from every tool
   * definition before passing them to `streamText`. Required for providers
   * whose backend rejects unknown fields on the tool payload — notably
   * Bedrock-on-Anthropic, where `strict` surfaces as
   * `tools.0.custom.strict: Extra inputs are not permitted`.
   */
  stripStrictFromTools?: boolean;
};

export interface OfficialOpenAIRealtimeEndpoint {
  apiKey: string;
  baseURL: 'https://api.openai.com/v1';
}

/**
 * This class offers a getter for a model that is traced with the telemetry service.
 *
 * Routing logic:
 *   - Built-in models default to the **clodex gateway** unless the user has
 *     configured the model's `officialProvider` to use `official` or `custom` mode.
 *   - Custom models route through their configured endpoint.
 *   - Provider options on each model definition already use per-provider keys
 *     (e.g. `{ anthropic: { … }, clodex: { … } }`) and are passed through as-is.
 */
export class ModelProviderService {
  private readonly telemetryService: TelemetryService;
  private readonly authService: AuthService;
  private readonly preferencesService: PreferencesService;
  private readonly credentialsService?: CredentialsService;
  private readonly providerRegistry = new AIProviderRegistry();

  public constructor(
    telemetryService: TelemetryService,
    authService: AuthService,
    preferencesService: PreferencesService,
    credentialsService?: CredentialsService,
  ) {
    this.telemetryService = telemetryService;
    this.authService = authService;
    this.preferencesService = preferencesService;
    this.credentialsService = credentialsService;
    if (credentialsService) {
      for (const adapter of createBuiltInProviderAdapters(credentialsService)) {
        this.providerRegistry.register(adapter);
      }
    }
  }

  public async validateProviderProfile(profileId: string) {
    const profile = this.preferencesService
      .get()
      .providerProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Provider profile ${profileId} not found`);
    return this.providerRegistry
      .require(profile.providerType)
      .validate(profile);
  }

  public async listProviderProfileModels(
    profileId: string,
  ): Promise<AIModelInfo[]> {
    const profile = this.preferencesService
      .get()
      .providerProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Provider profile ${profileId} not found`);
    const models = await this.providerRegistry
      .require(profile.providerType)
      .listModels(profile);
    await this.preferencesService.cacheProviderProfileModels(
      profile.id,
      models,
    );
    return models;
  }

  /**
   * Returns credentials only for the first-party OpenAI endpoint.
   *
   * Realtime WebRTC negotiation must not silently route through the Clodex
   * relay, a coding-plan endpoint, or an arbitrary OpenAI-compatible custom
   * endpoint because those endpoints are not guaranteed to implement
   * `/v1/realtime/calls`.
   */
  public getOfficialOpenAIRealtimeEndpoint(): OfficialOpenAIRealtimeEndpoint | null {
    return this.getOfficialOpenAIEndpoint();
  }

  /**
   * Returns credentials for the first-party OpenAI transcription endpoint.
   *
   * Batch transcription has the same trust boundary as realtime negotiation:
   * it must not silently use a coding-plan or arbitrary compatible endpoint
   * that may not implement `/v1/audio/transcriptions`.
   */
  public getOfficialOpenAITranscriptionEndpoint(): OfficialOpenAIRealtimeEndpoint | null {
    return this.getOfficialOpenAIEndpoint();
  }

  private getOfficialOpenAIEndpoint(): OfficialOpenAIRealtimeEndpoint | null {
    const config = this.preferencesService.get().providerConfigs.openai;
    if (config.mode !== 'official' || config.connectedCodingPlanId) return null;
    const profile = this.preferencesService
      .get()
      .providerProfiles.find(
        (candidate) =>
          candidate.id === 'official-openai' &&
          candidate.enabled &&
          candidate.providerType === 'openai',
      );
    const apiKey =
      (profile?.apiKeyReference
        ? this.credentialsService?.getProviderApiKey(profile.apiKeyReference)
        : undefined) ??
      this.preferencesService.decryptProviderApiKey(config.encryptedApiKey);
    if (!apiKey) return null;
    return {
      apiKey,
      baseURL: 'https://api.openai.com/v1',
    };
  }

  private report(
    error: Error,
    operation: string,
    extra?: Record<string, unknown>,
  ) {
    this.telemetryService.captureException(error, {
      service: 'model-provider',
      operation,
      ...extra,
    });
  }

  private getClodexGatewayApiKey(apiKeyOverride?: string): string {
    if (apiKeyOverride) return apiKeyOverride;
    const profile = this.preferencesService
      .get()
      .providerProfiles.find(
        (candidate) => candidate.enabled && candidate.providerType === 'clodex',
      );
    const profileKey = profile?.apiKeyReference
      ? this.credentialsService?.getProviderApiKey(profile.apiKeyReference)
      : undefined;
    if (profileKey) return profileKey;
    const token = this.authService.modelAccessToken;
    if (!token) {
      throw new Error(
        'Clodex IDE model token is not available. Sign in to Clodex again.',
      );
    }
    return token;
  }

  private getAllowedClodexModelIds(): Set<string> | null {
    const models = this.getEnabledClodexModels();
    if (models.length === 0) return null;
    return new Set(
      models.flatMap((model) => [model.id, getBareModelId(model.id)]),
    );
  }

  private getEnabledClodexModels(): ClodexAuthModel[] {
    return (this.authService.authState.models ?? []).filter(
      (model) => model.enabled !== false,
    );
  }

  private getClodexModel(modelId: string): ClodexAuthModel | undefined {
    const models = this.getEnabledClodexModels();
    if (models.length === 0) return undefined;

    const alias = getModelAlias(modelId);
    const requestedIds = new Set([
      modelId,
      getBareModelId(modelId),
      ...(alias
        ? [alias.targetModelId, getBareModelId(alias.targetModelId)]
        : []),
    ]);

    for (const model of models) {
      if (requestedIds.has(model.id)) return model;
    }

    for (const model of models) {
      if (requestedIds.has(getBareModelId(model.id))) return model;
    }

    for (const model of models) {
      const provider = model.provider;
      if (
        provider &&
        requestedIds.has(`${provider}/${getBareModelId(model.id)}`)
      ) {
        return model;
      }
    }

    return undefined;
  }

  private getBestSameProviderClodexModel(
    modelId: string,
    taskRole: ModelTaskRole,
    currentModelId: string,
    unavailableModelIds: readonly string[] = [],
  ): ClodexAuthModel | BuiltInModelSettings | undefined {
    const requestedProvider = toSemanticProvider(undefined, modelId);
    const unavailableIds = new Set(
      unavailableModelIds.flatMap((id) => [id, getBareModelId(id)]),
    );

    const builtInFallbacks =
      CLODEX_BUILT_IN_SAME_PROVIDER_FALLBACKS[requestedProvider] ?? [];
    for (const fallbackId of builtInFallbacks) {
      const builtIn = getAvailableModel(fallbackId);
      if (!builtIn) continue;
      if (builtIn.officialProvider !== requestedProvider) continue;
      if (
        unavailableIds.has(builtIn.modelId) ||
        unavailableIds.has(getBareModelId(builtIn.modelId))
      ) {
        continue;
      }
      if (!this.providerUsesClodexGateway(requestedProvider)) continue;
      return builtIn;
    }

    if (requestedProvider === 'google') return undefined;

    const models = this.getEnabledClodexModels().filter(
      (model) =>
        toSemanticProvider(model.provider, model.id) === requestedProvider &&
        !unavailableIds.has(model.id) &&
        !unavailableIds.has(getBareModelId(model.id)),
    );
    const hasTaskRoleMetadata = models.some((model) =>
      model.taskRoles?.includes(taskRole),
    );
    const ranked = models
      .map((model) => ({
        model,
        score: hasTaskRoleMetadata
          ? scoreClodexModelMetadataForTask(model, taskRole, currentModelId)
          : scoreClodexModelForTask(model, taskRole, currentModelId),
      }))
      .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return getClodexModelLabel(a.model).localeCompare(
          getClodexModelLabel(b.model),
        );
      })[0]?.model;
    if (ranked) return ranked;

    return undefined;
  }

  public selectModelForTask({
    currentModelId,
    taskRole,
    preferredModelId,
    unavailableModelIds,
  }: ModelTaskRoutingRequest): string {
    if (preferredModelId) {
      const preferred = this.getClodexModel(preferredModelId);
      const isUnavailablePreferred =
        unavailableModelIds?.some(
          (id) =>
            id === preferredModelId ||
            getBareModelId(id) === getBareModelId(preferredModelId),
        ) ?? false;
      if (preferred && !isUnavailablePreferred) {
        return preferred.id;
      }

      const sameProviderFallback = this.getBestSameProviderClodexModel(
        preferredModelId,
        taskRole,
        currentModelId,
        [
          preferred?.id,
          preferredModelId,
          ...(unavailableModelIds ?? []),
        ].filter((id): id is string => Boolean(id)),
      );
      if (sameProviderFallback) {
        return 'modelId' in sameProviderFallback
          ? sameProviderFallback.modelId
          : sameProviderFallback.id;
      }

      return preferredModelId;
    }

    const current = this.getClodexModel(currentModelId);
    const models = this.getEnabledClodexModels();
    if (!current || models.length <= 1) return currentModelId;

    const hasTaskRoleMetadata = models.some((model) =>
      model.taskRoles?.includes(taskRole),
    );
    const ranked = models
      .map((model) => ({
        model,
        score: hasTaskRoleMetadata
          ? scoreClodexModelMetadataForTask(model, taskRole, currentModelId)
          : scoreClodexModelForTask(model, taskRole, currentModelId),
      }))
      .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return getClodexModelLabel(a.model).localeCompare(
          getClodexModelLabel(b.model),
        );
      });

    return ranked[0]?.model.id ?? currentModelId;
  }

  private getServiceFallbackClodexModel(
    requestMetadata?: Record<string, unknown>,
  ): ClodexAuthModel | undefined {
    if (
      requestMetadata?.[MODEL_REQUEST_PURPOSE_METADATA_KEY] === 'agent-step'
    ) {
      return undefined;
    }

    const models = this.getEnabledClodexModels();
    if (models.length === 0) return undefined;
    return (
      models.find((model) => getAvailableModel(model.id)) ??
      models.find((model) => getAvailableModel(getBareModelId(model.id))) ??
      models[0]
    );
  }

  private modelMatchesAllowedList(
    modelSettings: BuiltInModelSettings,
    allowed: Set<string> | null,
  ): boolean {
    if (!allowed) return true;
    if (allowed.has(modelSettings.modelId)) return true;
    const provider = modelSettings.officialProvider;
    return provider
      ? allowed.has(`${provider}/${modelSettings.modelId}`)
      : false;
  }

  private isExplicitPreferredModelRequest(
    modelId: string,
    requestMetadata?: Record<string, unknown>,
  ): boolean {
    const preferredModelId = requestMetadata?.preferred_model_id;
    if (typeof preferredModelId !== 'string') return false;
    return (
      preferredModelId === modelId ||
      getBareModelId(preferredModelId) === getBareModelId(modelId)
    );
  }

  private assertModelAllowed(modelSettings: BuiltInModelSettings): void {
    if (
      !this.modelMatchesAllowedList(
        modelSettings,
        this.getAllowedClodexModelIds(),
      )
    ) {
      throw new Error(
        `Model ${modelSettings.modelId} is not enabled for the current Clodex key.`,
      );
    }
  }

  /**
   * Resolve credentials and base URL for a given provider
   * based on the user's endpoint-mode preference.
   */
  private resolveProviderEndpoint(
    provider: ModelProvider,
    clodexApiKeyOverride?: string,
  ): {
    apiKey: string;
    baseURL: string | undefined;
    mode: 'clodex' | 'official' | 'custom';
    connectedCodingPlanId?: string;
    customEndpoint?: CustomEndpoint;
  } {
    const prefs = this.preferencesService.get();
    const config = prefs.providerConfigs[provider];
    const proxyBaseUrl =
      process.env.CLODEX_LLM_RELAY_URL ||
      process.env.LLM_PROXY_URL ||
      'https://clodex.xyz/v1';

    switch (config.mode) {
      case 'clodex':
        return {
          apiKey: this.getClodexGatewayApiKey(clodexApiKeyOverride),
          baseURL: proxyBaseUrl,
          mode: 'clodex',
        };
      case 'official': {
        const connectedCodingPlan = config.connectedCodingPlanId
          ? CODING_PLANS[config.connectedCodingPlanId]
          : undefined;
        const profile = prefs.providerProfiles.find(
          (candidate) =>
            candidate.id === `official-${provider}` && candidate.enabled,
        );
        return {
          apiKey:
            (profile?.apiKeyReference
              ? this.credentialsService?.getProviderApiKey(
                  profile.apiKeyReference,
                )
              : undefined) ??
            this.preferencesService.decryptProviderApiKey(
              config.encryptedApiKey,
            ),
          baseURL:
            profile?.baseUrl ??
            (connectedCodingPlan?.provider === provider
              ? connectedCodingPlan.baseUrl
              : undefined),
          mode: 'official',
          connectedCodingPlanId: config.connectedCodingPlanId,
        };
      }
      case 'custom': {
        const endpoint = prefs.customEndpoints.find(
          (ep) => ep.id === config.customProviderId,
        );
        if (!endpoint) {
          return {
            apiKey: this.getClodexGatewayApiKey(clodexApiKeyOverride),
            baseURL: proxyBaseUrl,
            mode: 'clodex',
          };
        }
        return {
          apiKey: (() => {
            const profile = prefs.providerProfiles.find(
              (candidate) =>
                candidate.id === `custom-${endpoint.id}` && candidate.enabled,
            );
            return (
              (profile?.apiKeyReference
                ? this.credentialsService?.getProviderApiKey(
                    profile.apiKeyReference,
                  )
                : undefined) ??
              this.preferencesService.decryptProviderApiKey(
                endpoint.encryptedApiKey,
              )
            );
          })(),
          baseURL: endpoint.baseUrl || undefined,
          mode: 'custom',
          customEndpoint: endpoint,
        };
      }
    }
  }

  /**
   * Resolve credentials for a custom model's endpoint reference
   * (which can be a built-in provider name or a custom endpoint id).
   */
  private resolveCustomEndpoint(endpointId: string): {
    apiKey: string;
    baseURL: string | undefined;
    apiSpec: ApiSpec;
    endpoint?: CustomEndpoint;
  } {
    if (
      endpointId === 'anthropic' ||
      endpointId === 'openai' ||
      endpointId === 'google' ||
      endpointId === 'moonshotai' ||
      endpointId === 'alibaba' ||
      endpointId === 'deepseek' ||
      endpointId === 'z-ai' ||
      endpointId === 'minimax' ||
      endpointId === 'xiaomi-mimo' ||
      endpointId === 'mistral'
    ) {
      const { apiKey, baseURL } = this.resolveProviderEndpoint(endpointId);
      const apiSpecMap: Record<ModelProvider, ApiSpec> = {
        anthropic: 'anthropic',
        openai: 'openai-responses',
        google: 'google',
        moonshotai: 'openai-chat-completions',
        alibaba: 'openai-chat-completions',
        deepseek: 'openai-chat-completions',
        'z-ai': 'openai-chat-completions',
        minimax: 'openai-chat-completions',
        'xiaomi-mimo': 'openai-chat-completions',
        mistral: 'openai-chat-completions',
      };
      return { apiKey, baseURL, apiSpec: apiSpecMap[endpointId] };
    }

    const endpoint = this.preferencesService
      .get()
      .customEndpoints.find((ep) => ep.id === endpointId);
    if (!endpoint) throw new Error(`Custom endpoint ${endpointId} not found`);

    return {
      apiKey: (() => {
        const profile = this.preferencesService
          .get()
          .providerProfiles.find(
            (candidate) =>
              candidate.id === `custom-${endpoint.id}` && candidate.enabled,
          );
        return (
          (profile?.apiKeyReference
            ? this.credentialsService?.getProviderApiKey(
                profile.apiKeyReference,
              )
            : undefined) ??
          this.preferencesService.decryptProviderApiKey(
            endpoint.encryptedApiKey,
          )
        );
      })(),
      baseURL: endpoint.baseUrl || undefined,
      apiSpec: endpoint.apiSpec,
      endpoint,
    };
  }

  /**
   * Build an Amazon Bedrock provider for a custom endpoint based on its
   * configured auth mode:
   *
   * - `access-keys` (default, back-compat): static access key + secret.
   * - `profile`: named profile from `~/.aws/config` / `~/.aws/credentials`.
   *   Handles static, session-token, assume-role, and SSO profiles via the
   *   AWS SDK's standard refresh machinery. SSO profiles whose token has
   *   expired will surface an error at signing time — users must re-run
   *   `aws sso login --profile <name>`.
   * - `default-chain`: Node provider chain (env vars, shared credentials,
   *   EC2/ECS instance roles, IMDS).
   *
   * Region resolution is fail-closed before provider construction:
   * UI override, the selected profile's service region, and the standard
   * AWS region environment variables are considered in mode-specific order.
   * Static access keys retain the historical `us-east-1` fallback.
   */
  private buildBedrockProvider(endpoint: CustomEndpoint, apiKey: string) {
    const authMode = endpoint.awsAuthMode ?? 'access-keys';
    const secretAccessKey =
      authMode === 'access-keys'
        ? this.preferencesService.decryptProviderApiKey(
            endpoint.encryptedSecretKey,
          )
        : undefined;
    return createBedrockProvider({
      authMode,
      regionOverride: endpoint.region,
      profileName: endpoint.awsProfileName,
      accessKeyId: apiKey,
      secretAccessKey,
    });
  }

  /**
   * Check whether a model ID exists (built-in or custom).
   */
  public modelExists(modelId: ModelId): boolean {
    const qualified = parseQualifiedModelId(modelId);
    if (qualified) {
      return this.preferencesService
        .get()
        .providerProfiles.some(
          (profile) =>
            profile.id === qualified.providerProfileId && profile.enabled,
        );
    }
    if (this.getClodexModel(modelId)) return true;

    const builtIn = getAvailableModel(modelId);
    if (builtIn) {
      return this.modelMatchesAllowedList(
        builtIn,
        this.getAllowedClodexModelIds(),
      );
    }
    return this.preferencesService
      .get()
      .customModels.some((m) => m.modelId === modelId);
  }

  /**
   * Lists currently usable models whose catalog metadata explicitly declares
   * audio input support. Unknown account/custom models are intentionally not
   * guessed to be audio-capable.
   */
  public getAudioCapableModelIds(): string[] {
    const modelIds = new Set<string>();

    for (const clodexModel of this.getEnabledClodexModels()) {
      const builtIn =
        getAvailableModel(clodexModel.id) ??
        getAvailableModel(getBareModelId(clodexModel.id));
      if (builtIn?.capabilities.inputModalities.audio === true) {
        modelIds.add(clodexModel.id);
      }
    }

    for (const builtIn of availableModels) {
      if (
        builtIn.capabilities.inputModalities.audio === true &&
        this.modelExists(builtIn.modelId)
      ) {
        modelIds.add(builtIn.modelId);
      }
    }

    for (const customModel of this.preferencesService.get().customModels) {
      const builtIn = getAvailableModel(customModel.modelId);
      if (builtIn?.capabilities.inputModalities.audio === true) {
        modelIds.add(customModel.modelId);
      }
    }

    return [...modelIds];
  }

  /**
   * Get a model usable by AI-SDK alongside provider options and headers.
   *
   * Provider options from the model definition are returned as-is — they
   * already carry per-provider keys (e.g. `{ anthropic: {…}, clodex: {…} }`).
   * Call-sites should use `deepMergeProviderOptions` to layer additional overrides.
   */
  public getModelWithOptions(
    modelId: ModelId,
    traceId: string,
    otherPostHogProperties?: Record<string, unknown>,
  ): ModelWithOptions {
    try {
      return this.createModelWithOptions(
        modelId,
        traceId,
        otherPostHogProperties,
      );
    } catch (error) {
      this.report(error as Error, 'getModelWithOptions', { modelId });
      throw error;
    }
  }

  public async getModelWithOptionsAsync(
    modelId: ModelId,
    traceId: string,
    otherPostHogProperties?: Record<string, unknown>,
  ): Promise<ModelWithOptions> {
    try {
      const clodexApiKeyOverride =
        await this.prepareClodexGatewayApiKeyForModel(
          modelId,
          otherPostHogProperties,
        );
      return this.createModelWithOptions(
        modelId,
        traceId,
        otherPostHogProperties,
        clodexApiKeyOverride,
      );
    } catch (error) {
      this.report(error as Error, 'getModelWithOptionsAsync', { modelId });
      throw error;
    }
  }

  private async prepareClodexGatewayApiKeyForModel(
    modelId: ModelId,
    requestMetadata?: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (parseQualifiedModelId(modelId)) return undefined;
    const builtIn = getAvailableModel(modelId);
    const alias = getModelAlias(modelId);
    const aliasTarget = alias
      ? getAvailableModel(alias.targetModelId)
      : undefined;
    const clodexModel = this.getClodexModel(modelId);
    const routeModelId =
      builtIn?.modelId ??
      aliasTarget?.modelId ??
      clodexModel?.id ??
      (typeof requestMetadata?.preferred_model_id === 'string'
        ? requestMetadata.preferred_model_id
        : modelId);
    const routeProvider =
      builtIn?.officialProvider ??
      aliasTarget?.officialProvider ??
      clodexModel?.provider;

    if (
      routeProvider &&
      !clodexModel &&
      !this.providerUsesClodexGateway(routeProvider as ModelProvider)
    ) {
      return undefined;
    }

    if (this.authService.ensureModelAccessTokenForRoute) {
      const routeAwareToken =
        await this.authService.ensureModelAccessTokenForRoute({
          provider: routeProvider,
          modelId: routeModelId,
        });
      if (routeAwareToken) return routeAwareToken;
      throw new Error(
        `Clodex did not issue a route-specific IDE token for ${routeProvider ?? 'unknown'} model ${routeModelId}.`,
      );
    }

    return this.authService.ensureModelAccessToken();
  }

  private providerUsesClodexGateway(provider: ModelProvider): boolean {
    const prefs = this.preferencesService.get();
    const config = prefs.providerConfigs[provider];
    if (config.mode === 'official') return false;
    if (config.mode === 'custom') {
      return !prefs.customEndpoints.some(
        (ep) => ep.id === config.customProviderId,
      );
    }
    return true;
  }

  private createModelWithOptions(
    modelId: ModelId,
    traceId: string,
    otherPostHogProperties?: Record<string, unknown>,
    clodexApiKeyOverride?: string,
  ): ModelWithOptions {
    const qualified = parseQualifiedModelId(modelId);
    if (qualified) {
      return this.createProviderProfileModelWithOptions(
        qualified.providerProfileId,
        qualified.modelId,
        traceId,
        otherPostHogProperties,
      );
    }
    const clodexModel = this.getClodexModel(modelId);
    if (clodexModel) {
      const builtIn =
        getAvailableModel(modelId) ??
        getAvailableModel(clodexModel.id) ??
        getAvailableModel(getBareModelId(clodexModel.id));
      const alias = getModelAlias(modelId);
      return this.createClodexModelWithOptions(
        clodexModel,
        traceId,
        builtIn,
        alias,
        alias
          ? {
              ...otherPostHogProperties,
              requestedModelId: alias.modelId,
            }
          : otherPostHogProperties,
        clodexApiKeyOverride,
      );
    }

    const builtIn = getAvailableModel(modelId);
    if (builtIn) {
      const alias = getModelAlias(modelId);
      const hasRouteSpecificClodexToken =
        Boolean(clodexApiKeyOverride) &&
        Boolean(
          builtIn.officialProvider &&
            this.providerUsesClodexGateway(
              builtIn.officialProvider as ModelProvider,
            ),
        );
      if (
        !hasRouteSpecificClodexToken &&
        !this.isExplicitPreferredModelRequest(
          modelId,
          otherPostHogProperties,
        ) &&
        !this.modelMatchesAllowedList(builtIn, this.getAllowedClodexModelIds())
      ) {
        const fallback = this.getServiceFallbackClodexModel(
          otherPostHogProperties,
        );
        if (fallback) {
          return this.createClodexModelWithOptions(
            fallback,
            traceId,
            getAvailableModel(fallback.id) ??
              getAvailableModel(getBareModelId(fallback.id)),
            undefined,
            {
              ...otherPostHogProperties,
              requestedModelId: modelId,
              fallbackModelId: fallback.id,
            },
            clodexApiKeyOverride,
          );
        }

        this.assertModelAllowed(builtIn);
      }
      return this.createBuiltInModelWithOptions(
        builtIn,
        traceId,
        alias,
        alias
          ? {
              ...otherPostHogProperties,
              requestedModelId: alias.modelId,
            }
          : otherPostHogProperties,
        clodexApiKeyOverride,
      );
    }

    const custom = this.preferencesService
      .get()
      .customModels.find((m) => m.modelId === modelId);
    if (custom) {
      return this.createCustomModelWithOptions(
        custom,
        traceId,
        otherPostHogProperties,
      );
    }

    const fallback = this.getServiceFallbackClodexModel(otherPostHogProperties);
    if (fallback) {
      return this.createClodexModelWithOptions(
        fallback,
        traceId,
        getAvailableModel(fallback.id) ??
          getAvailableModel(getBareModelId(fallback.id)),
        undefined,
        {
          ...otherPostHogProperties,
          requestedModelId: modelId,
          fallbackModelId: fallback.id,
        },
        clodexApiKeyOverride,
      );
    }

    throw new Error(`Model ${modelId} not found`);
  }

  private createProviderProfileModelWithOptions(
    profileId: string,
    modelId: string,
    traceId: string,
    requestMetadata?: Record<string, unknown>,
  ): ModelWithOptions {
    const preferences = this.preferencesService.get();
    const profile = preferences.providerProfiles.find(
      (candidate) => candidate.id === profileId && candidate.enabled,
    );
    if (!profile)
      throw new Error(`Enabled provider profile ${profileId} not found`);
    const apiKey = profile.apiKeyReference
      ? this.credentialsService?.getProviderApiKey(profile.apiKeyReference)
      : undefined;
    if (
      profile.providerType !== 'ollama' &&
      !apiKey &&
      profile.providerType !== 'openai-compatible'
    ) {
      throw new Error(`API key is not configured for ${profile.displayName}`);
    }

    const baseURL =
      profile.providerType === 'ollama'
        ? `${(profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/v1`
        : profile.baseUrl;
    let model: LanguageModelV3;
    let providerMode: ProviderMode;

    if (profile.providerType === 'anthropic') {
      const provider = createAnthropic({
        apiKey: apiKey ?? '',
        baseURL,
        headers: profile.customHeaders,
      });
      model = provider(modelId as any);
      providerMode = 'official';
    } else if (profile.providerType === 'openai') {
      const provider = createOpenAI({
        apiKey: apiKey ?? '',
        baseURL,
        headers: profile.customHeaders,
      });
      model =
        profile.protocol === 'openai-chat'
          ? provider.chat(modelId as any)
          : provider.responses(modelId as any);
      providerMode = 'official';
    } else if (profile.providerType === 'clodex') {
      const provider = createClodex({
        apiKey: apiKey ?? '',
        baseURL:
          baseURL ||
          process.env.CLODEX_LLM_RELAY_URL ||
          'https://clodex.xyz/v1',
      });
      model = wrapLanguageModel({
        model: provider.chatModel(modelId),
        middleware: clodexUrlPassthroughMiddleware,
      });
      providerMode = 'clodex';
    } else {
      const provider = createOpenAICompatible({
        name: profile.id,
        apiKey: apiKey ?? 'local-no-key',
        baseURL:
          baseURL ||
          (profile.providerType === 'openrouter'
            ? 'https://openrouter.ai/api/v1'
            : 'http://localhost:8000/v1'),
        headers: profile.customHeaders,
      });
      model = provider.chatModel(modelId);
      providerMode = 'custom';
    }

    const semanticProvider =
      providerMode === 'custom'
        ? profile.protocol === 'anthropic-messages'
          ? 'anthropic'
          : 'openai'
        : toSemanticProvider(
            profile.providerType === 'anthropic' ||
              profile.providerType === 'openai'
              ? profile.providerType
              : undefined,
            modelId,
          );
    const supportsNativeThinking = supportsNativeThinkingProviderProfile(
      profile.providerType,
    );
    const catalogModel = supportsNativeThinking
      ? getAvailableModel(modelId)
      : undefined;
    const compatibleCatalogModel =
      catalogModel &&
      (profile.providerType === 'clodex' ||
        catalogModel.officialProvider === semanticProvider)
        ? catalogModel
        : undefined;
    const thinkingModelSettings = supportsNativeThinking
      ? (compatibleCatalogModel ??
        getDynamicGpt5ThinkingModel(modelId, semanticProvider))
      : undefined;
    const thinkingApiSpec =
      profile.providerType === 'openai'
        ? profile.protocol === 'openai-chat'
          ? 'openai-chat-completions'
          : profile.protocol === 'openai-responses'
            ? 'openai-responses'
            : undefined
        : undefined;
    const thinkingProviderMode =
      profile.providerType === 'openai' && profile.protocol === 'openai-chat'
        ? 'custom'
        : providerMode;
    const baseProviderOptions = (thinkingModelSettings?.providerOptions ??
      {}) as Record<string, unknown>;
    const thinkingOverride = thinkingModelSettings
      ? getModelThinkingOverride(
          this.preferencesService.get().agent.modelThinkingOverrides,
          `${profileId}:${modelId}`,
        )
      : undefined;
    const providerOptions = thinkingModelSettings
      ? resolveThinkingProviderOptions({
          baseProviderOptions,
          modelSettings: thinkingModelSettings,
          override: thinkingOverride,
          providerMode: thinkingProviderMode,
          semanticProvider,
          customEndpointApiSpec: thinkingApiSpec,
          requestMetadata,
        })
      : {};
    const contextWindowSize =
      resolveModelContextWindow({
        modelId: `${profileId}:${modelId}`,
        providerProfiles: preferences.providerProfiles,
        providerModelCatalogs: preferences.providerModelCatalogs,
        clodexModels: this.getEnabledClodexModels(),
      })?.tokens ??
      (profile.providerType === 'clodex'
        ? CLODEX_UNKNOWN_MODEL_CONTEXT_WINDOW_BUDGET
        : PROVIDER_PROFILE_UNKNOWN_CONTEXT_WINDOW_BUDGET);
    return {
      model: this.telemetryService.withTracing(model, {
        posthogTraceId: traceId,
        posthogProperties: {
          modelId,
          providerProfileId: profile.id,
          providerType: profile.providerType,
        },
      }),
      providerOptions:
        providerMode === 'clodex'
          ? sanitizeClodexProviderOptions(providerOptions)
          : providerOptions,
      headers: profile.customHeaders,
      contextWindowSize,
      providerMode,
      reasoningSignatureSource:
        providerMode === 'custom'
          ? createReasoningSignatureSource(
              'custom',
              semanticProvider,
              modelId,
              {
                apiSpec:
                  profile.protocol === 'anthropic-messages'
                    ? 'anthropic'
                    : profile.protocol === 'openai-responses'
                      ? 'openai-responses'
                      : 'openai-chat-completions',
                endpointId: profile.id,
              },
            )
          : createReasoningSignatureSource(
              providerMode,
              semanticProvider,
              modelId,
            ),
    };
  }

  private createClodexModelWithOptions(
    clodexModel: ClodexAuthModel,
    traceId: string,
    modelSettings?: BuiltInModelSettings,
    alias?: ModelAlias,
    otherPostHogProperties?: Record<string, unknown>,
    clodexApiKeyOverride?: string,
  ): ModelWithOptions {
    const proxyBaseUrl =
      process.env.CLODEX_LLM_RELAY_URL ||
      process.env.LLM_PROXY_URL ||
      'https://clodex.xyz/v1';
    const semanticProvider = toSemanticProvider(
      clodexModel.provider ?? modelSettings?.officialProvider,
      clodexModel.id,
    );
    const thinkingModelSettings =
      modelSettings ??
      getDynamicGpt5ThinkingModel(clodexModel.id, semanticProvider);
    const posthogProperties = omitModelRequestMetadata(otherPostHogProperties);
    const posthogConfig = {
      posthogTraceId: traceId,
      posthogProperties: {
        posthogTraceId: traceId,
        modelId: clodexModel.id,
        clodexProvider: clodexModel.provider,
        ...posthogProperties,
      },
    };

    const clodexProvider = createClodex({
      apiKey: this.getClodexGatewayApiKey(clodexApiKeyOverride),
      baseURL: proxyBaseUrl,
    });
    const model = wrapLanguageModel({
      model: clodexProvider.chatModel(clodexModel.id),
      middleware: clodexUrlPassthroughMiddleware,
    });
    const baseProviderOptions = (thinkingModelSettings?.providerOptions ??
      {}) as Record<string, unknown>;
    const thinkingOverride =
      alias?.thinkingPreset ??
      (thinkingModelSettings
        ? this.preferencesService.get().agent.modelThinkingOverrides[
            thinkingModelSettings.modelId
          ]
        : undefined);
    const providerOptions = thinkingModelSettings
      ? resolveThinkingProviderOptions({
          baseProviderOptions,
          modelSettings: thinkingModelSettings,
          override: thinkingOverride,
          providerMode: 'clodex',
          semanticProvider,
          requestMetadata: otherPostHogProperties,
        })
      : {};

    return {
      model: this.telemetryService.withTracing(model, posthogConfig),
      headers: modelSettings?.headers ?? {},
      providerOptions: sanitizeClodexProviderOptions(providerOptions),
      contextWindowSize:
        clodexModel.contextWindow ??
        modelSettings?.modelContextRaw ??
        CLODEX_UNKNOWN_MODEL_CONTEXT_WINDOW_BUDGET,
      providerMode: 'clodex',
      reasoningSignatureSource: createReasoningSignatureSource(
        'clodex',
        semanticProvider,
        clodexModel.id,
      ),
    };
  }

  private createBuiltInModelWithOptions(
    modelSettings: BuiltInModelSettings,
    traceId: string,
    alias?: ModelAlias,
    otherPostHogProperties?: Record<string, unknown>,
    clodexApiKeyOverride?: string,
  ): ModelWithOptions {
    const officialProvider = modelSettings.officialProvider as
      | ModelProvider
      | undefined;
    const resolved = officialProvider
      ? this.resolveProviderEndpoint(officialProvider, clodexApiKeyOverride)
      : { apiKey: '', baseURL: undefined, mode: 'clodex' as const };
    const { apiKey, baseURL, mode, connectedCodingPlanId } = resolved;
    const headers = modelSettings.headers ?? {};
    const baseProviderOptions = modelSettings.providerOptions as Record<
      string,
      unknown
    >;
    const posthogProperties = omitModelRequestMetadata(otherPostHogProperties);
    const thinkingOverride =
      alias?.thinkingPreset ??
      this.preferencesService.get().agent.modelThinkingOverrides[
        modelSettings.modelId
      ];

    const posthogConfig = {
      posthogTraceId: traceId,
      posthogProperties: {
        posthogTraceId: traceId,
        modelId: modelSettings.modelId,
        ...posthogProperties,
      },
    };

    if (mode === 'clodex') {
      if (!officialProvider) {
        throw new Error(
          `Model ${modelSettings.modelId} has no officialProvider set`,
        );
      }
      const proxyBaseUrl =
        process.env.CLODEX_LLM_RELAY_URL ||
        process.env.LLM_PROXY_URL ||
        'https://clodex.xyz/v1';
      const gatewayModelId = toClodexGatewayModelId(
        officialProvider,
        modelSettings.modelId,
      );
      const clodexProvider = createClodex({
        apiKey: this.getClodexGatewayApiKey(clodexApiKeyOverride),
        baseURL: proxyBaseUrl,
      });

      const model = wrapLanguageModel({
        model: clodexProvider.chatModel(gatewayModelId),
        middleware: clodexUrlPassthroughMiddleware,
      });

      return {
        model: this.telemetryService.withTracing(model, posthogConfig),
        headers,
        providerOptions: sanitizeClodexProviderOptions(
          resolveThinkingProviderOptions({
            baseProviderOptions,
            modelSettings,
            override: thinkingOverride,
            providerMode: 'clodex',
            semanticProvider: officialProvider,
            requestMetadata: otherPostHogProperties,
          }),
        ),
        contextWindowSize: modelSettings.modelContextRaw,
        providerMode: 'clodex',
        reasoningSignatureSource: createReasoningSignatureSource(
          'clodex',
          officialProvider,
          gatewayModelId,
        ),
      };
    }

    if (mode === 'custom' && resolved.customEndpoint) {
      const incompatibleSpecs = new Set([
        'azure',
        'amazon-bedrock',
        'google-vertex',
      ]);
      const defaultModelId =
        officialProvider === 'minimax'
          ? toNativeMiniMaxModelId(modelSettings.modelId)
          : modelSettings.modelId;
      const remappedModelId =
        resolved.customEndpoint.modelIdMapping?.[modelSettings.modelId] ??
        defaultModelId;
      if (
        incompatibleSpecs.has(resolved.customEndpoint.apiSpec) &&
        remappedModelId === modelSettings.modelId
      ) {
        throw new Error(
          `Built-in model "${modelSettings.modelId}" cannot be routed through a ${resolved.customEndpoint.apiSpec} endpoint because it requires provider-specific model IDs. ` +
            `Add a model ID mapping on the custom endpoint, or create a custom model with the correct ${resolved.customEndpoint.apiSpec} model identifier instead.`,
        );
      }
      return {
        ...this.createModelViaEndpoint(
          resolved.customEndpoint,
          remappedModelId,
          resolveThinkingProviderOptions({
            baseProviderOptions,
            modelSettings,
            override: thinkingOverride,
            providerMode: 'custom',
            semanticProvider: getSemanticProviderForApiSpec(
              resolved.customEndpoint.apiSpec,
            ),
            customEndpointApiSpec: resolved.customEndpoint.apiSpec,
            requestMetadata: otherPostHogProperties,
          }) as Record<string, unknown>,
          headers,
          modelSettings.modelContextRaw,
          posthogConfig,
        ),
        providerMode: 'custom',
      };
    }

    // Official mode — use native AI-SDK provider with the officialProvider
    if (!officialProvider) {
      throw new Error(
        `Model ${modelSettings.modelId} has no officialProvider set`,
      );
    }

    return {
      ...this.createOfficialModel(
        officialProvider,
        apiKey,
        baseURL,
        modelSettings.modelId,
        resolveThinkingProviderOptions({
          baseProviderOptions,
          modelSettings,
          override: thinkingOverride,
          providerMode: 'official',
          semanticProvider: officialProvider,
          requestMetadata: otherPostHogProperties,
        }) as Record<string, unknown>,
        headers,
        modelSettings.modelContextRaw,
        posthogConfig,
      ),
      providerMode: 'official',
      connectedCodingPlanId,
    };
  }

  /**
   * Create a model using the official AI-SDK provider for the given provider key.
   */
  private createOfficialModel(
    provider: ModelProvider,
    apiKey: string,
    baseURL: string | undefined,
    modelId: string,
    providerOptions: Record<string, unknown>,
    headers: Record<string, string>,
    contextWindowSize: number,
    posthogConfig: {
      posthogTraceId: string;
      posthogProperties: Record<string, unknown>;
    },
  ): Omit<ModelWithOptions, 'providerMode'> {
    const reasoningSignatureSource = createReasoningSignatureSource(
      'official',
      provider,
      modelId,
    );

    switch (provider) {
      case 'anthropic': {
        const p = createAnthropic({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            p(toNativeAnthropicModelId(modelId) as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'openai': {
        const p = createOpenAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            p(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'google': {
        const p = createGoogleGenerativeAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            p(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'moonshotai': {
        const p = createOpenAI({
          apiKey,
          baseURL: baseURL ?? 'https://api.moonshot.ai/v1',
        });
        return {
          model: this.telemetryService.withTracing(
            // Moonshot's native API speaks Chat Completions, not Responses.
            // `createOpenAI()(id)` defaults to Responses — must use `.chat()`.
            p.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'alibaba': {
        const p = createOpenAI({
          apiKey,
          baseURL:
            baseURL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        });
        return {
          model: this.telemetryService.withTracing(
            // Alibaba's DashScope speaks Chat Completions — use `.chat()`.
            p.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'deepseek': {
        const p = createOpenAI({
          apiKey,
          baseURL: baseURL ?? 'https://api.deepseek.com/v1',
        });
        return {
          model: this.telemetryService.withTracing(
            // DeepSeek's native API speaks Chat Completions — use `.chat()`.
            p.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'z-ai': {
        const p = createOpenAI({
          apiKey,
          baseURL: baseURL ?? 'https://api.z.ai/api/paas/v4',
        });
        return {
          model: this.telemetryService.withTracing(
            // Z.AI's OpenAI-compatible endpoint speaks Chat Completions.
            p.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'minimax': {
        const p = createOpenAI({
          apiKey,
          baseURL: baseURL ?? 'https://api.minimax.io/v1',
        });
        return {
          model: this.telemetryService.withTracing(
            // MiniMax's OpenAI-compatible endpoint speaks Chat Completions.
            p.chat(toNativeMiniMaxModelId(modelId) as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'xiaomi-mimo': {
        const p = createOpenAI({
          apiKey,
          baseURL: baseURL ?? 'https://api.xiaomimimo.com/v1',
        });
        return {
          model: this.telemetryService.withTracing(
            // Xiaomi MiMo's OpenAI-compatible endpoint speaks Chat
            // Completions. Internal model IDs already match native API IDs.
            p.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      case 'mistral': {
        const p = createOpenAI({
          apiKey,
          baseURL: baseURL ?? 'https://api.mistral.ai/v1',
        });
        return {
          model: this.telemetryService.withTracing(
            // Mistral's OpenAI-compatible endpoint speaks Chat
            // Completions. Internal model IDs already match native API IDs.
            p.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: providerOptions as Parameters<
            typeof streamText
          >[0]['providerOptions'],
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      default: {
        const _exhaustive: never = provider;
        throw new Error(`Unsupported official provider: ${_exhaustive}`);
      }
    }
  }

  /**
   * Create a model routed through a specific custom endpoint config.
   */
  private createModelViaEndpoint(
    endpoint: CustomEndpoint,
    modelId: string,
    modelProviderOptions: Record<string, unknown>,
    headers: Record<string, string>,
    contextWindowSize: number,
    posthogConfig: {
      posthogTraceId: string;
      posthogProperties: Record<string, unknown>;
    },
  ): Omit<ModelWithOptions, 'providerMode'> {
    const apiKey = this.preferencesService.decryptProviderApiKey(
      endpoint.encryptedApiKey,
    );
    const baseURL = endpoint.baseUrl || undefined;
    const { apiSpec } = endpoint;
    const reasoningSignatureSource = createReasoningSignatureSource(
      'custom',
      getSemanticProviderForApiSpec(apiSpec),
      modelId,
      { apiSpec, endpointId: endpoint.id },
    );

    switch (apiSpec) {
      case 'anthropic': {
        const provider = createAnthropic({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider(toNativeAnthropicModelId(modelId) as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'openai-chat-completions': {
        const provider = createOpenAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider.chat(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'openai-responses': {
        const provider = createOpenAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider.responses(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'google': {
        const provider = createGoogleGenerativeAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'azure': {
        const azureProvider = createAzure({
          apiKey,
          baseURL,
          resourceName: endpoint.resourceName,
          apiVersion: endpoint.apiVersion,
        });
        return {
          model: this.telemetryService.withTracing(
            azureProvider(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'amazon-bedrock': {
        const bedrockProvider = this.buildBedrockProvider(endpoint, apiKey);
        return {
          model: this.telemetryService.withTracing(
            bedrockProvider(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
          stripStrictFromTools: true,
        };
      }

      case 'google-vertex': {
        const vertexProvider = createVertex({
          project: endpoint.projectId ?? '',
          location: endpoint.location ?? 'us-central1',
          googleAuthOptions: endpoint.encryptedGoogleCredentials
            ? {
                credentials: JSON.parse(
                  this.preferencesService.decryptProviderApiKey(
                    endpoint.encryptedGoogleCredentials,
                  ),
                ),
              }
            : undefined,
        });
        return {
          model: this.telemetryService.withTracing(
            vertexProvider(modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions: modelProviderOptions as any,
          contextWindowSize,
          reasoningSignatureSource,
        };
      }
      default: {
        const _exhaustive: never = apiSpec;
        throw new Error(`Unsupported API spec: ${_exhaustive}`);
      }
    }
  }

  private createCustomModelWithOptions(
    customModel: CustomModel,
    traceId: string,
    otherPostHogProperties?: Record<string, unknown>,
  ): ModelWithOptions {
    const result = this.createCustomModelBase(
      customModel,
      traceId,
      otherPostHogProperties,
    );
    return { ...result, providerMode: 'custom' };
  }

  private createCustomModelBase(
    customModel: CustomModel,
    traceId: string,
    otherPostHogProperties?: Record<string, unknown>,
  ): Omit<ModelWithOptions, 'providerMode'> {
    const { apiKey, baseURL, apiSpec, endpoint } = this.resolveCustomEndpoint(
      customModel.endpointId,
    );
    const headers = customModel.headers ?? {};
    const posthogProperties = omitModelRequestMetadata(otherPostHogProperties);

    const posthogConfig = {
      posthogTraceId: traceId,
      posthogProperties: {
        posthogTraceId: traceId,
        modelId: customModel.modelId,
        isCustomModel: true,
        ...posthogProperties,
      },
    };

    if (
      endpoint &&
      (apiSpec === 'azure' ||
        apiSpec === 'amazon-bedrock' ||
        apiSpec === 'google-vertex')
    ) {
      return this.createModelViaEndpoint(
        endpoint,
        customModel.modelId,
        customModel.providerOptions,
        headers,
        customModel.contextWindowSize,
        posthogConfig,
      );
    }

    const providerKey = apiSpec.startsWith('openai-') ? 'openai' : apiSpec;
    const reasoningSignatureSource = createReasoningSignatureSource(
      'custom',
      getSemanticProviderForApiSpec(apiSpec),
      customModel.modelId,
      { apiSpec, endpointId: endpoint?.id ?? customModel.endpointId },
    );
    const providerOptions =
      Object.keys(customModel.providerOptions).length > 0
        ? ({ [providerKey]: customModel.providerOptions } as any)
        : {};

    switch (apiSpec) {
      case 'anthropic': {
        const provider = createAnthropic({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider(toNativeAnthropicModelId(customModel.modelId) as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'openai-chat-completions': {
        const provider = createOpenAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider.chat(customModel.modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'openai-responses': {
        const provider = createOpenAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider.responses(customModel.modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'google': {
        const provider = createGoogleGenerativeAI({ apiKey, baseURL });
        return {
          model: this.telemetryService.withTracing(
            provider(customModel.modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'azure': {
        const ep = endpoint ?? ({} as CustomEndpoint);
        const azureProvider = createAzure({
          apiKey,
          baseURL,
          resourceName: ep.resourceName,
          apiVersion: ep.apiVersion,
        });
        return {
          model: this.telemetryService.withTracing(
            azureProvider(customModel.modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
        };
      }

      case 'amazon-bedrock': {
        const ep = endpoint ?? ({} as CustomEndpoint);
        const bedrockProvider = this.buildBedrockProvider(ep, apiKey);
        return {
          model: this.telemetryService.withTracing(
            bedrockProvider(customModel.modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
          stripStrictFromTools: true,
        };
      }

      case 'google-vertex': {
        const ep = endpoint ?? ({} as CustomEndpoint);
        const vertexProvider = createVertex({
          project: ep.projectId ?? '',
          location: ep.location ?? 'us-central1',
          googleAuthOptions: ep.encryptedGoogleCredentials
            ? {
                credentials: JSON.parse(
                  this.preferencesService.decryptProviderApiKey(
                    ep.encryptedGoogleCredentials,
                  ),
                ),
              }
            : undefined,
        });
        return {
          model: this.telemetryService.withTracing(
            vertexProvider(customModel.modelId as any),
            posthogConfig,
          ),
          headers,
          providerOptions,
          contextWindowSize: customModel.contextWindowSize,
          reasoningSignatureSource,
        };
      }
    }
  }
}

// =============================================================================
// Thinking override utilities
// =============================================================================

type ThinkingProviderOptionsInput = {
  baseProviderOptions: Record<string, unknown>;
  modelSettings: ThinkingModelSettings;
  override?: ModelThinkingOverride;
  providerMode: ProviderMode;
  semanticProvider: ModelProvider;
  customEndpointApiSpec?: ApiSpec;
  requestMetadata?: Record<string, unknown>;
};

function resolveThinkingProviderOptions({
  baseProviderOptions,
  modelSettings,
  override,
  providerMode,
  semanticProvider,
  customEndpointApiSpec,
  requestMetadata,
}: ThinkingProviderOptionsInput): ProviderOptions {
  if (requestMetadata?.[MODEL_REQUEST_PURPOSE_METADATA_KEY] !== 'agent-step') {
    return baseProviderOptions as ProviderOptions;
  }

  if (!modelSettings.thinkingEnabled || !override) {
    return baseProviderOptions as ProviderOptions;
  }

  const patch = createThinkingProviderOptionsPatch({
    model: modelSettings,
    override,
    route: {
      providerMode,
      modelProvider: semanticProvider,
      customEndpointApiSpec,
    },
  });

  if (!patch) return baseProviderOptions as ProviderOptions;

  return deepMergeProviderOptions(baseProviderOptions, patch);
}

function omitModelRequestMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (
    !metadata ||
    (!(MODEL_REQUEST_PURPOSE_METADATA_KEY in metadata) &&
      !(MODEL_TASK_ROLE_METADATA_KEY in metadata))
  ) {
    return metadata;
  }

  const {
    [MODEL_REQUEST_PURPOSE_METADATA_KEY]: _purpose,
    [MODEL_TASK_ROLE_METADATA_KEY]: _taskRole,
    ...telemetry
  } = metadata;
  return telemetry;
}

function getClodexModelLabel(model: ClodexAuthModel): string {
  return `${model.provider ?? ''} ${model.id} ${model.name ?? ''}`.toLowerCase();
}

function getKnownPriceRank(model: ClodexAuthModel): number | undefined {
  const builtIn =
    getAvailableModel(model.id) ?? getAvailableModel(getBareModelId(model.id));
  return builtIn?.pricing?.relativeMultiplier;
}

function scoreClodexModelMetadataForTask(
  model: ClodexAuthModel,
  taskRole: ModelTaskRole,
  currentModelId: string,
): number {
  if (!model.taskRoles?.includes(taskRole)) return Number.NEGATIVE_INFINITY;

  const currentBonus =
    model.id === currentModelId ||
    getBareModelId(model.id) === getBareModelId(currentModelId)
      ? 3
      : 0;
  const contextBonus =
    typeof model.contextWindow === 'number'
      ? Math.min(10, Math.floor(model.contextWindow / 200_000))
      : 0;

  if (taskRole === 'coding') {
    const tierScore = tierScoreForStrongModel(model.costTier);
    return 100 + tierScore + contextBonus + currentBonus;
  }

  const tierScore = tierScoreForEfficientModel(model.costTier);
  return 100 + tierScore + currentBonus;
}

function tierScoreForStrongModel(
  tier: ClodexAuthModel['costTier'] | undefined,
): number {
  switch (tier) {
    case 'high':
      return 40;
    case 'medium':
      return 25;
    case 'low':
      return 10;
    case 'free':
      return 5;
    default:
      return 15;
  }
}

function tierScoreForEfficientModel(
  tier: ClodexAuthModel['costTier'] | undefined,
): number {
  switch (tier) {
    case 'free':
      return 45;
    case 'low':
      return 40;
    case 'medium':
      return 20;
    case 'high':
      return 5;
    default:
      return 15;
  }
}

function scoreClodexModelForTask(
  model: ClodexAuthModel,
  taskRole: ModelTaskRole,
  currentModelId: string,
): number {
  const label = getClodexModelLabel(model);
  const priceRank = getKnownPriceRank(model);
  const lowerPriceBonus =
    priceRank === undefined ? 0 : Math.max(-30, 30 - priceRank * 8);
  const higherPriceBonus =
    priceRank === undefined ? 0 : Math.min(30, priceRank * 6);
  const currentBonus =
    model.id === currentModelId ||
    getBareModelId(model.id) === getBareModelId(currentModelId)
      ? 3
      : 0;
  const hasAny = (...needles: string[]) =>
    needles.some((needle) => label.includes(needle));

  if (taskRole === 'analysis') {
    let score = 50 + lowerPriceBonus + currentBonus;
    if (hasAny('flash', 'lite', 'mini', 'haiku', 'quick', 'fast')) score += 35;
    if (hasAny('deepseek', 'qwen', 'glm', 'gemini')) score += 12;
    if (hasAny('opus', 'fable', 'sonnet', 'pro', 'max')) score -= 18;
    return score;
  }

  if (taskRole === 'review') {
    let score = 45 + lowerPriceBonus + currentBonus;
    if (hasAny('flash', 'lite', 'mini', 'haiku', 'quick', 'fast')) score += 30;
    if (hasAny('deepseek', 'qwen', 'glm', 'gemini')) score += 10;
    if (hasAny('opus', 'fable')) score -= 15;
    return score;
  }

  let score = 55 + higherPriceBonus + currentBonus;
  if (
    hasAny(
      'opus',
      'fable',
      'sonnet',
      'gpt-5',
      'gpt-4.1',
      'glm-5',
      'deepseek-v4-pro',
    )
  ) {
    score += 35;
  }
  if (hasAny('mini', 'lite', 'haiku', 'flash')) score -= 20;
  if (hasAny('coding', 'coder', 'code')) score += 18;
  return score;
}

// =============================================================================
// Deep-merge utility for provider options
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively deep-merges multiple plain objects. Later sources win on
 * primitive conflicts; nested objects are merged recursively.
 *
 * Exported so call-sites (streamText / generateText) can layer overrides:
 * ```ts
 * streamText({
 *   providerOptions: deepMergeProviderOptions(
 *     modelWithOptions.providerOptions,
 *     { anthropic: { thinking: { type: 'disabled' } } },
 *   ),
 * })
 * ```
 */
export function deepMergeProviderOptions(
  ...sources: (Record<string, unknown> | undefined | null)[]
): ProviderOptions {
  const result: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        delete result[key];
      } else if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = deepMergeProviderOptions(
          result[key] as Record<string, unknown>,
          value,
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result as ProviderOptions;
}
