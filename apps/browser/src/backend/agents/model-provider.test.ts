import { describe, expect, it, vi } from 'vitest';
import {
  defaultUserPreferences,
  type ProviderProfile,
} from '@shared/karton-contracts/ui/shared-types';
import { MODEL_REQUEST_PURPOSE_METADATA_KEY } from '@clodex/agent-core/host';
import { ModelProviderService } from './model-provider';
import {
  reasoningSignatureSourceSchema,
  type ReasoningSignatureSource,
} from '@shared/karton-contracts/ui/agent/metadata';
import {
  createReasoningSignatureSource,
  getSemanticProviderForApiSpec,
  reasoningSourcesMatch,
} from './reasoning-signatures';

function createTestModelProviderService({
  providerModes = {},
  connectedCodingPlanIds = {},
  modelThinkingOverrides = {},
  customEndpoints = [],
  providerProfiles = [],
  authService,
  providerApiKeys = {},
}: {
  providerModes?: Record<string, 'clodex' | 'official' | 'custom'>;
  connectedCodingPlanIds?: Record<string, string | undefined>;
  modelThinkingOverrides?: Record<
    string,
    {
      enabled?: boolean;
      value?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    }
  >;
  customEndpoints?: typeof defaultUserPreferences.customEndpoints;
  providerProfiles?: typeof defaultUserPreferences.providerProfiles;
  authService?: unknown;
  providerApiKeys?: Record<string, string>;
} = {}) {
  const preferences = structuredClone(defaultUserPreferences);
  preferences.agent.modelThinkingOverrides = modelThinkingOverrides;
  preferences.customEndpoints = customEndpoints;
  preferences.providerProfiles = providerProfiles;
  for (const [provider, mode] of Object.entries(providerModes)) {
    const config =
      preferences.providerConfigs[
        provider as keyof typeof preferences.providerConfigs
      ];
    config.mode = mode;
    if (mode === 'custom') config.customProviderId = `${provider}-custom`;
  }
  for (const [provider, connectedCodingPlanId] of Object.entries(
    connectedCodingPlanIds,
  )) {
    preferences.providerConfigs[
      provider as keyof typeof preferences.providerConfigs
    ].connectedCodingPlanId = connectedCodingPlanId as any;
  }

  return new ModelProviderService(
    {
      withTracing: vi.fn((model) => model),
      captureException: vi.fn(),
    } as any,
    (authService ?? {
      accessToken: 'clodex-token',
      modelAccessToken: 'ide-model-token',
      ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
      authState: { models: [] },
    }) as any,
    {
      get: vi.fn(() => preferences),
      decryptProviderApiKey: vi.fn(() => 'provider-api-key'),
      cacheProviderProfileModels: vi.fn(),
    } as any,
    {
      getProviderApiKey: vi.fn(
        (reference: string) => providerApiKeys[reference] ?? null,
      ),
    } as any,
  );
}

const agentStepMetadata = {
  [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'agent-step',
};

describe('provider-qualified model routing', () => {
  it('routes an Ollama model without contacting Clodex auth', async () => {
    const ensureModelAccessTokenForRoute = vi.fn();
    const service = createTestModelProviderService({
      providerProfiles: [
        {
          id: 'ollama-local',
          providerType: 'ollama',
          displayName: 'Local Ollama',
          baseUrl: 'http://localhost:11434',
          protocol: 'ollama',
          customHeaders: {},
          enabled: true,
        },
      ],
      authService: {
        modelAccessToken: undefined,
        ensureModelAccessTokenForRoute,
        authState: { models: [] },
      },
    });

    const result = await service.getModelWithOptionsAsync(
      'ollama-local:qwen3-coder:latest',
      'trace-local',
    );

    expect(result.providerMode).toBe('custom');
    expect(getModelRequestUrl(result)).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(ensureModelAccessTokenForRoute).not.toHaveBeenCalled();
  });

  it.each([
    ['ollama', 'ollama', false],
    ['openai-compatible', 'openai-chat', false],
    ['openrouter', 'openai-chat', true],
  ] as const)('does not attach OpenAI provider options to qualified %s GPT slugs', (providerType, protocol, needsKey) => {
    const profile: ProviderProfile = {
      id: `${providerType}-profile`,
      providerType,
      displayName: providerType,
      baseUrl: 'http://localhost:11434',
      ...(needsKey
        ? { apiKeyReference: `provider.${providerType}-profile` }
        : {}),
      protocol,
      customHeaders: {},
      enabled: true,
    };
    const service = createTestModelProviderService({
      providerProfiles: [profile],
      providerApiKeys: needsKey
        ? { [`provider.${providerType}-profile`]: 'test-secret' }
        : {},
    });

    const result = service.getModelWithOptions(
      `${profile.id}:gpt-5.6-sol`,
      `trace-${providerType}`,
      agentStepMetadata,
    );

    expect(result.providerOptions).toEqual({});
  });

  it('uses the credential reference for an OpenRouter model', () => {
    const service = createTestModelProviderService({
      providerProfiles: [
        {
          id: 'openrouter-main',
          providerType: 'openrouter',
          displayName: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyReference: 'provider.openrouter-main',
          protocol: 'openai-chat',
          customHeaders: {},
          enabled: true,
        },
      ],
      providerApiKeys: {
        'provider.openrouter-main': 'or-secret',
      },
    });

    expect(service.modelExists('openrouter-main:openai/example')).toBe(true);
    expect(
      service.getModelWithOptions(
        'openrouter-main:openai/example',
        'trace-openrouter',
      ).providerMode,
    ).toBe('custom');
  });

  it('maps direct OpenAI Terra Ultra to provider Max', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: {
        'openai-main:gpt-5.6-terra': { value: 'ultra' },
      },
      providerProfiles: [
        {
          id: 'openai-main',
          providerType: 'openai',
          displayName: 'OpenAI',
          apiKeyReference: 'provider.openai-main',
          protocol: 'openai-responses',
          customHeaders: {},
          enabled: true,
        },
      ],
      providerApiKeys: {
        'provider.openai-main': 'openai-secret',
      },
    });

    const result = service.getModelWithOptions(
      'openai-main:gpt-5.6-terra',
      'trace-openai-terra',
      agentStepMetadata,
    );

    expect(result.providerMode).toBe('official');
    expect(result.providerOptions).toMatchObject({
      openai: { reasoningEffort: 'max' },
    });
  });

  it('keeps qualified OpenAI and Clodex effort overrides isolated', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: {
        'openai-main:gpt-5.6-sol': { value: 'ultra' },
        'clodex-main:gpt-5.6-sol': { value: 'high' },
      },
      providerProfiles: [
        {
          id: 'openai-main',
          providerType: 'openai',
          displayName: 'OpenAI',
          apiKeyReference: 'provider.openai-main',
          protocol: 'openai-responses',
          customHeaders: {},
          enabled: true,
        },
        {
          id: 'clodex-main',
          providerType: 'clodex',
          displayName: 'Clodex',
          apiKeyReference: 'provider.clodex-main',
          protocol: 'openai-chat',
          customHeaders: {},
          enabled: true,
        },
      ],
      providerApiKeys: {
        'provider.openai-main': 'openai-secret',
        'provider.clodex-main': 'clodex-secret',
      },
    });

    expect(
      service.getModelWithOptions(
        'openai-main:gpt-5.6-sol',
        'trace-openai-sol',
        agentStepMetadata,
      ).providerOptions,
    ).toMatchObject({ openai: { reasoningEffort: 'max' } });
    expect(
      service.getModelWithOptions(
        'clodex-main:gpt-5.6-sol',
        'trace-clodex-sol',
        agentStepMetadata,
      ).providerOptions,
    ).toMatchObject({ clodex: { reasoning: { effort: 'high' } } });
  });

  it('keeps OpenAI chat-completions profiles on conservative effort values', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: {
        'gpt-5.6-sol': { value: 'ultra' },
      },
      providerProfiles: [
        {
          id: 'openai-chat',
          providerType: 'openai',
          displayName: 'OpenAI Chat',
          apiKeyReference: 'provider.openai-chat',
          protocol: 'openai-chat',
          customHeaders: {},
          enabled: true,
        },
      ],
      providerApiKeys: {
        'provider.openai-chat': 'openai-secret',
      },
    });

    const result = service.getModelWithOptions(
      'openai-chat:gpt-5.6-sol',
      'trace-openai-chat-sol',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      openai: { reasoningEffort: 'medium' },
    });
  });

  it('sanitizes legacy reasoning.enabled for Clodex provider profiles', () => {
    const service = createTestModelProviderService({
      providerProfiles: [
        {
          id: 'clodex-main',
          providerType: 'clodex',
          displayName: 'Clodex',
          apiKeyReference: 'provider.clodex-main',
          protocol: 'openai-chat',
          customHeaders: {},
          enabled: true,
        },
      ],
      providerApiKeys: {
        'provider.clodex-main': 'clodex-secret',
      },
    });

    const result = service.getModelWithOptions(
      'clodex-main:gpt-5.5',
      'trace-clodex-profile',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'medium' } },
    });
    expect(result.providerOptions?.clodex?.reasoning).not.toHaveProperty(
      'enabled',
    );
  });
});

function getModelRequestUrl(
  result: ReturnType<ModelProviderService['getModelWithOptions']>,
) {
  const model = result.model as unknown as {
    config?: { url?: (options: { path: string }) => URL };
  };
  return model.config?.url?.({ path: '/chat/completions' }).toString();
}

describe('dictation model routing', () => {
  it('exposes only a first-party OpenAI endpoint for transcription', () => {
    const official = createTestModelProviderService({
      providerModes: { openai: 'official' },
    });
    const codingPlan = createTestModelProviderService({
      providerModes: { openai: 'official' },
      connectedCodingPlanIds: { openai: 'github-copilot' },
    });

    expect(official.getOfficialOpenAITranscriptionEndpoint()).toEqual({
      apiKey: 'provider-api-key',
      baseURL: 'https://api.openai.com/v1',
    });
    expect(codingPlan.getOfficialOpenAITranscriptionEndpoint()).toBeNull();
  });

  it('discovers enabled audio-capable account models dynamically', () => {
    const service = createTestModelProviderService({
      authService: {
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            { id: 'gpt-5.4', provider: 'openai', enabled: true },
            { id: 'mimo-v2.5', provider: 'xiaomi-mimo', enabled: true },
          ],
        },
      },
    });

    expect(service.getAudioCapableModelIds()).toEqual(['mimo-v2.5']);
  });
});

describe('model alias routing', () => {
  it('accepts alias IDs as built-in models', () => {
    const service = createTestModelProviderService();

    expect(service.modelExists('default')).toBe(true);
    expect(service.modelExists('quick')).toBe(true);
    expect(service.modelExists('smart')).toBe(true);
  });

  it.each([
    ['default', 'deepseek', 'deepseek-v4-pro'],
    ['quick', 'google', 'gemini-3.5-flash'],
    ['smart', 'z-ai', 'glm-5.2'],
  ] as const)('routes %s through the target built-in model', (aliasId, provider, targetModelId) => {
    const service = createTestModelProviderService();

    const result = service.getModelWithOptions(aliasId, 'trace-1');

    expect(result.contextWindowSize).toBeGreaterThan(0);
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider,
      modelId: targetModelId,
    });
  });

  it('uses fixed preset reasoning for alias requests', () => {
    const service = createTestModelProviderService();

    const defaultResult = service.getModelWithOptions(
      'default',
      'trace-1',
      agentStepMetadata,
    );
    const quickResult = service.getModelWithOptions(
      'quick',
      'trace-1',
      agentStepMetadata,
    );
    const smartResult = service.getModelWithOptions(
      'smart',
      'trace-1',
      agentStepMetadata,
    );

    expect(defaultResult.providerOptions).toMatchObject({
      clodex: {
        reasoning: { effort: 'medium' },
        provider: { require_parameters: true },
      },
    });
    expect(quickResult.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'low' } },
    });
    expect(smartResult.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'xhigh' } },
    });
  });

  it('ignores target model thinking overrides for alias requests', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: {
        'deepseek-v4-pro': { value: 'high' },
      },
    });

    const result = service.getModelWithOptions(
      'default',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: {
        reasoning: { effort: 'medium' },
        provider: { require_parameters: true },
      },
    });
  });

  it('keeps target model thinking overrides for concrete requests', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: {
        'deepseek-v4-pro': { value: 'high' },
      },
    });

    const result = service.getModelWithOptions(
      'deepseek-v4-pro',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: {
        reasoning: { effort: 'high' },
        provider: { require_parameters: true },
      },
    });
  });
});

describe('official provider endpoint resolution', () => {
  it('routes connected GLM Coding Plan requests through the coding endpoint', () => {
    const service = createTestModelProviderService({
      providerModes: { 'z-ai': 'official' },
      connectedCodingPlanIds: { 'z-ai': 'glm-coding-plan' },
    });

    const result = service.getModelWithOptions('glm-5.2', 'trace-1');

    expect(result.providerMode).toBe('official');
    expect(getModelRequestUrl(result)).toBe(
      'https://api.z.ai/api/coding/paas/v4/chat/completions',
    );
  });

  it('keeps normal official Z.ai requests on the general endpoint', () => {
    const service = createTestModelProviderService({
      providerModes: { 'z-ai': 'official' },
    });

    const result = service.getModelWithOptions('glm-5.2', 'trace-1');

    expect(result.providerMode).toBe('official');
    expect(getModelRequestUrl(result)).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions',
    );
  });
});

describe('Clodex IDE model token refresh', () => {
  it('refreshes the IDE model token before resolving a clodex model asynchronously', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'fresh-ide-model-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'fresh-ide-model-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: { models: [] },
      },
    });

    const result = await service.getModelWithOptionsAsync('gpt-5.5', 'trace-1');

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
    expect(result.providerMode).toBe('clodex');
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
  });

  it('does not block a route-tokened built-in model on a stale active-key allow list', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'generic-ide-model-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'openai-route-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: {
          models: [
            {
              id: 'claude-opus-4.8',
              name: 'Claude Opus 4.8',
              provider: 'anthropic',
              enabled: true,
            },
          ],
        },
      },
    });

    const result = await service.getModelWithOptionsAsync(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
    expect(result.providerMode).toBe('clodex');
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
  });

  it('routes selected Clodex key models with the exact model id returned by Clodex', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'fresh-ide-model-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'fresh-ide-model-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: {
          models: [
            {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              provider: 'openai',
              enabled: true,
            },
          ],
        },
      },
    });

    const result = await service.getModelWithOptionsAsync('gpt-5.5', 'trace-1');

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
    expect(result.providerMode).toBe('clodex');
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
  });

  it('routes explicit preferred swarm models through a provider-matched Clodex key', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'active-gpt-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'anthropic-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: {
          models: [
            {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              provider: 'openai',
              enabled: true,
            },
          ],
        },
      },
    });

    const result = await service.getModelWithOptionsAsync(
      'claude-opus-4.8',
      'trace-1',
      {
        ...agentStepMetadata,
        preferred_model_id: 'claude-opus-4.8',
      },
    );

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'anthropic',
      modelId: 'claude-opus-4.8',
    });
    expect(result.providerMode).toBe('clodex');
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    });
  });

  it('routes explicit preferred Gemini battle models through a Google-matched Clodex key', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'active-gpt-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'google-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: { models: [] },
      },
    });

    const result = await service.getModelWithOptionsAsync(
      'gemini-3.1-pro-preview',
      'trace-1',
      {
        ...agentStepMetadata,
        preferred_model_id: 'gemini-3.1-pro-preview',
      },
    );

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
    });
    expect(result.providerMode).toBe('clodex');
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
    });
  });

  it('uses route-specific runtime tokens for the active ALL key before calling the gateway', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'active-all-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'google-route-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: {
          keys: [
            {
              id: 'all-key',
              name: 'ALL',
              group: 'ALL',
              isDefault: true,
              modelLimitsEnabled: false,
            },
          ],
          activeKeyId: 'all-key',
          models: [],
        },
      },
    });

    const result = await service.getModelWithOptionsAsync(
      'gemini-3.1-pro-preview',
      'trace-1',
      {
        ...agentStepMetadata,
        preferred_model_id: 'gemini-3.1-pro-preview',
      },
    );

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
    });
    expect(result.providerMode).toBe('clodex');
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
    });
  });

  it('allows a universal default Clodex key to route non-OpenAI battle models', async () => {
    let token: string | undefined;
    const ensureModelAccessToken = vi.fn(async () => {
      token = 'active-default-token';
      return token;
    });
    const ensureModelAccessTokenForRoute = vi.fn(async () => {
      token = 'active-default-token';
      return token;
    });
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        get modelAccessToken() {
          return token;
        },
        ensureModelAccessToken,
        ensureModelAccessTokenForRoute,
        authState: {
          keys: [
            {
              id: 'default-key',
              name: 'Default',
              group: 'GPT',
              isDefault: true,
              modelLimitsEnabled: false,
            },
          ],
          activeKeyId: 'default-key',
          models: [],
        },
      },
    });

    const result = await service.getModelWithOptionsAsync(
      'claude-opus-4.8',
      'trace-1',
      {
        ...agentStepMetadata,
        preferred_model_id: 'claude-opus-4.8',
      },
    );

    expect(ensureModelAccessToken).not.toHaveBeenCalled();
    expect(ensureModelAccessTokenForRoute).toHaveBeenCalledWith({
      provider: 'anthropic',
      modelId: 'claude-opus-4.8',
    });
    expect(result.reasoningSignatureSource).toMatchObject({
      providerMode: 'clodex',
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    });
  });
});

describe('Clodex task routing', () => {
  function createClodexRoutingService() {
    return createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: 'claude-opus-4.7',
              name: 'Opus 4.7',
              provider: 'anthropic',
              enabled: true,
            },
            {
              id: 'gemini-3.5-flash',
              name: 'Gemini 3.5 Flash',
              provider: 'google',
              enabled: true,
            },
            {
              id: 'glm-5.2',
              name: 'GLM 5.2',
              provider: 'z-ai',
              enabled: true,
            },
            {
              id: 'disabled-mini',
              name: 'Disabled mini',
              provider: 'openai',
              enabled: false,
            },
          ],
        },
      },
    });
  }

  it('routes analysis and review steps to the cheapest fast enabled model', () => {
    const service = createClodexRoutingService();

    expect(
      service.selectModelForTask({
        currentModelId: 'claude-opus-4.7',
        taskRole: 'analysis',
        agentType: 'chat',
        traceId: 'trace-1',
      }),
    ).toBe('gemini-3.5-flash');
    expect(
      service.selectModelForTask({
        currentModelId: 'claude-opus-4.7',
        taskRole: 'review',
        agentType: 'chat',
        traceId: 'trace-1',
      }),
    ).toBe('gemini-3.5-flash');
  });

  it('routes coding steps to the strongest enabled model', () => {
    const service = createClodexRoutingService();

    expect(
      service.selectModelForTask({
        currentModelId: 'gemini-3.5-flash',
        taskRole: 'coding',
        agentType: 'chat',
        traceId: 'trace-1',
      }),
    ).toBe('claude-opus-4.7');
  });

  it('routes unavailable preferred Battle models to an enabled same-provider model', () => {
    const service = createClodexRoutingService();

    expect(
      service.selectModelForTask({
        currentModelId: 'gpt-5.5',
        preferredModelId: 'gemini-3.1-pro-preview',
        taskRole: 'analysis',
        agentType: 'swarm',
        traceId: 'trace-1',
      }),
    ).toBe('gemini-3.5-flash');
  });

  it('keeps the exact preferred Battle model when the selected key exposes it', () => {
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: 'gemini-3.1-pro-preview',
              name: 'Gemini 3.1 Pro Preview',
              provider: 'google',
              enabled: true,
            },
            {
              id: 'gemini-3.5-flash',
              name: 'Gemini 3.5 Flash',
              provider: 'google',
              enabled: true,
            },
          ],
        },
      },
    });

    expect(
      service.selectModelForTask({
        currentModelId: 'gpt-5.5',
        preferredModelId: 'gemini-3.1-pro-preview',
        taskRole: 'analysis',
        agentType: 'swarm',
        traceId: 'trace-1',
      }),
    ).toBe('gemini-3.1-pro-preview');
  });

  it('routes a runtime-unavailable preferred Battle model to same-provider fallback', () => {
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: 'gemini-3.1-pro-preview',
              name: 'Gemini 3.1 Pro Preview',
              provider: 'google',
              enabled: true,
            },
            {
              id: 'gemini-3.5-flash',
              name: 'Gemini 3.5 Flash',
              provider: 'google',
              enabled: true,
            },
          ],
        },
      },
    });

    expect(
      service.selectModelForTask({
        currentModelId: 'gpt-5.5',
        preferredModelId: 'gemini-3.1-pro-preview',
        unavailableModelIds: ['gemini-3.1-pro-preview'],
        taskRole: 'analysis',
        agentType: 'swarm',
        traceId: 'trace-1',
      }),
    ).toBe('gemini-3.5-flash');
  });

  it('uses a built-in Gemini fallback when the selected key only lists the failed preview model', () => {
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: 'gemini-3.1-pro-preview',
              name: 'Gemini 3.1 Pro Preview',
              provider: 'google',
              enabled: true,
            },
          ],
        },
      },
    });

    expect(
      service.selectModelForTask({
        currentModelId: 'gpt-5.5',
        preferredModelId: 'gemini-3.1-pro-preview',
        unavailableModelIds: ['gemini-3.1-pro-preview'],
        taskRole: 'analysis',
        agentType: 'swarm',
        traceId: 'trace-1',
      }),
    ).toBe('gemini-3.5-flash');
  });

  it('does not route non-Clodex or unavailable selected models', () => {
    const service = createClodexRoutingService();

    expect(
      service.selectModelForTask({
        currentModelId: 'not-in-selected-key',
        taskRole: 'analysis',
        agentType: 'chat',
        traceId: 'trace-1',
      }),
    ).toBe('not-in-selected-key');
  });

  it('prefers Clodex task metadata over model-name heuristics', () => {
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: 'tiny-coder',
              name: 'Tiny Coder',
              provider: 'openai',
              enabled: true,
              costTier: 'low',
              taskRoles: ['analysis', 'review'],
              contextWindow: 64_000,
            },
            {
              id: 'boring-model',
              name: 'Boring Model',
              provider: 'openai',
              enabled: true,
              costTier: 'high',
              taskRoles: ['coding', 'general'],
              contextWindow: 200_000,
            },
          ],
        },
      },
    });

    expect(
      service.selectModelForTask({
        currentModelId: 'tiny-coder',
        taskRole: 'coding',
        agentType: 'chat',
        traceId: 'trace-1',
      }),
    ).toBe('boring-model');
    expect(
      service.selectModelForTask({
        currentModelId: 'boring-model',
        taskRole: 'analysis',
        agentType: 'chat',
        traceId: 'trace-1',
      }),
    ).toBe('tiny-coder');
  });

  it('uses Clodex context metadata for key-scoped models', () => {
    const service = createTestModelProviderService({
      authService: {
        accessToken: 'clodex-session-token',
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: 'custom-long-context',
              name: 'Custom long context',
              provider: 'openai',
              enabled: true,
              contextWindow: 1_048_576,
            },
          ],
        },
      },
    });

    const result = service.getModelWithOptions(
      'custom-long-context',
      'trace-1',
    );

    expect(result.contextWindowSize).toBe(1_048_576);
  });
});

describe('thinking override provider option resolution', () => {
  it('returns base provider options unchanged when no override exists', () => {
    const service = createTestModelProviderService();

    const result = service.getModelWithOptions(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'medium' } },
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
    });
  });

  it('uses clodex-compatible xhigh for GLM 5.2 max reasoning', () => {
    const service = createTestModelProviderService();

    const result = service.getModelWithOptions(
      'glm-5.2',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'xhigh' } },
      openai: { reasoningEffort: 'xhigh' },
    });
  });

  it('keeps clodex-compatible xhigh when overriding GLM 5.2 effort', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { 'glm-5.2': { value: 'low' } },
    });

    const result = service.getModelWithOptions(
      'glm-5.2',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'low' } },
      openai: { reasoningEffort: 'xhigh' },
    });
  });

  it('does not apply overrides without agent-step request purpose', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { 'gpt-5.5': { value: 'high' } },
    });

    const result = service.getModelWithOptions('gpt-5.5', 'trace-1');

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'medium' } },
    });
  });

  it('applies built-in overrides for agent-step requests', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { 'gpt-5.5': { value: 'high' } },
    });

    const result = service.getModelWithOptions(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'high' } },
      openai: { reasoningEffort: 'medium' },
    });
  });

  it('produces provider-specific disabled thinking options', () => {
    const service = createTestModelProviderService({
      providerModes: { anthropic: 'official' },
      modelThinkingOverrides: { 'claude-fable-5': { enabled: false } },
    });

    const result = service.getModelWithOptions(
      'claude-fable-5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      anthropic: { thinking: { type: 'disabled' } },
    });
    expect(result.providerOptions?.anthropic).not.toHaveProperty('effort');
  });

  it('disables OpenAI thinking with the provider-native off value', () => {
    const service = createTestModelProviderService({
      providerModes: { openai: 'official' },
      modelThinkingOverrides: { 'gpt-5.5': { enabled: false } },
    });

    const result = service.getModelWithOptions(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      openai: {
        reasoningEffort: 'none',
        parallelToolCalls: true,
        strictJsonSchema: true,
      },
    });
  });

  it('disables Google thinking without leaving a thinking level', () => {
    const service = createTestModelProviderService({
      providerModes: { google: 'official' },
      modelThinkingOverrides: {
        'gemini-3.1-pro-preview': { enabled: false },
      },
    });

    const result = service.getModelWithOptions(
      'gemini-3.1-pro-preview',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      google: { thinkingConfig: { includeThoughts: false } },
    });
    expect(result.providerOptions?.google).toMatchObject({
      thinkingConfig: expect.not.objectContaining({
        thinkingLevel: expect.anything(),
      }),
    });
  });

  it('disables Clodex-routed thinking by omitting the gateway reasoning object', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { 'gpt-5.5': { enabled: false } },
    });

    const result = service.getModelWithOptions(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions?.clodex).not.toHaveProperty('reasoning');
  });

  it('treats empty override objects as no-ops', () => {
    const service = createTestModelProviderService({
      providerModes: { google: 'official' },
      modelThinkingOverrides: { 'gemini-3.1-pro-preview': {} },
    });

    const result = service.getModelWithOptions(
      'gemini-3.1-pro-preview',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'medium' } },
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
      },
    });
  });

  it('preserves unrelated clodex provider options', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { 'deepseek-v4-pro': { value: 'high' } },
    });

    const result = service.getModelWithOptions(
      'deepseek-v4-pro',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: {
        reasoning: { effort: 'high' },
        provider: { require_parameters: true },
      },
    });
  });

  it('maps OpenAI-compatible official overrides to the OpenAI provider namespace', () => {
    const service = createTestModelProviderService({
      providerModes: { deepseek: 'official' },
      modelThinkingOverrides: { 'deepseek-v4-pro': { value: 'high' } },
    });

    const result = service.getModelWithOptions(
      'deepseek-v4-pro',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions?.openai).toMatchObject({
      reasoningEffort: 'high',
    });
    expect(result.providerOptions).not.toHaveProperty('deepseek');
  });

  it('maps OpenAI official overrides while preserving unrelated options', () => {
    const service = createTestModelProviderService({
      providerModes: { openai: 'official' },
      modelThinkingOverrides: { 'gpt-5.5': { value: 'high' } },
    });

    const result = service.getModelWithOptions(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      openai: {
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        parallelToolCalls: true,
        strictJsonSchema: true,
      },
    });
  });

  it('maps Google official overrides while preserving thinking config', () => {
    const service = createTestModelProviderService({
      providerModes: { google: 'official' },
      modelThinkingOverrides: {
        'gemini-3.1-pro-preview': { value: 'low' },
      },
    });

    const result = service.getModelWithOptions(
      'gemini-3.1-pro-preview',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
      },
    });
  });

  it('uses active provider defaults when enabling without effort', () => {
    const service = createTestModelProviderService({
      providerModes: { google: 'official' },
      modelThinkingOverrides: {
        'gemini-3.1-pro-preview': { enabled: true },
      },
    });

    const result = service.getModelWithOptions(
      'gemini-3.1-pro-preview',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
      },
    });
  });

  it('maps Anthropic official overrides while preserving adaptive shape', () => {
    const service = createTestModelProviderService({
      providerModes: { anthropic: 'official' },
      modelThinkingOverrides: { 'claude-fable-5': { value: 'high' } },
    });

    const result = service.getModelWithOptions(
      'claude-fable-5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
  });

  it('maps Clodex-routed Anthropic overrides to gateway reasoning options', () => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { 'claude-opus-4.8': { value: 'high' } },
    });

    const result = service.getModelWithOptions(
      'claude-opus-4.8',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: 'high' } },
      anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
    });
  });

  it.each([
    ['gpt-5.6-sol', 'max', 'max'],
    ['gpt-5.6-sol', 'ultra', 'max'],
    ['gpt-5.6-terra', 'max', 'max'],
    ['gpt-5.6-terra', 'ultra', 'max'],
  ] as const)('maps the dynamic %s %s selection to Clodex provider effort %s', (modelId, selection, providerEffort) => {
    const service = createTestModelProviderService({
      modelThinkingOverrides: { [modelId]: { value: selection } },
      authService: {
        modelAccessToken: 'ide-model-token',
        ensureModelAccessToken: vi.fn().mockResolvedValue('ide-model-token'),
        authState: {
          models: [
            {
              id: modelId,
              provider: 'openai',
              enabled: true,
            },
          ],
        },
      },
    });

    const result = service.getModelWithOptions(
      modelId,
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      clodex: { reasoning: { effort: providerEffort } },
    });
    expect(result.providerOptions?.clodex?.reasoning).not.toHaveProperty(
      'enabled',
    );
  });

  it('uses OpenAI-compatible options for custom chat completions endpoints', () => {
    const service = createTestModelProviderService({
      providerModes: { openai: 'custom' },
      modelThinkingOverrides: { 'gpt-5.5': { value: 'xhigh' } },
      customEndpoints: [
        {
          id: 'openai-custom',
          name: 'OpenAI-compatible',
          apiSpec: 'openai-chat-completions',
          baseUrl: 'https://example.com/v1',
          awsAuthMode: 'access-keys',
        },
      ],
    });

    const result = service.getModelWithOptions(
      'gpt-5.5',
      'trace-1',
      agentStepMetadata,
    );

    expect(result.providerOptions).toMatchObject({
      openai: { reasoningEffort: 'medium' },
    });
  });
});

describe('reasoning signature source helpers', () => {
  it('maps custom endpoint API specs to semantic providers', () => {
    expect(getSemanticProviderForApiSpec('anthropic')).toBe('anthropic');
    expect(getSemanticProviderForApiSpec('amazon-bedrock')).toBe('anthropic');
    expect(getSemanticProviderForApiSpec('google')).toBe('google');
    expect(getSemanticProviderForApiSpec('google-vertex')).toBe('google');
    expect(getSemanticProviderForApiSpec('openai-chat-completions')).toBe(
      'openai',
    );
    expect(getSemanticProviderForApiSpec('openai-responses')).toBe('openai');
    expect(getSemanticProviderForApiSpec('azure')).toBe('openai');
  });

  it('creates clodex and official sources with provider and model id', () => {
    expect(
      createReasoningSignatureSource(
        'clodex',
        'anthropic',
        'anthropic/claude-sonnet-4.6',
      ),
    ).toEqual({
      providerMode: 'clodex',
      provider: 'anthropic',
      modelId: 'anthropic/claude-sonnet-4.6',
    });

    expect(
      createReasoningSignatureSource('official', 'openai', 'gpt-5.4'),
    ).toEqual({
      providerMode: 'official',
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
  });

  it('creates custom sources with API spec and endpoint id', () => {
    expect(
      createReasoningSignatureSource('custom', 'google', 'gemini-custom', {
        apiSpec: 'google-vertex',
        endpointId: 'vertex-prod',
      }),
    ).toEqual({
      providerMode: 'custom',
      provider: 'google',
      modelId: 'gemini-custom',
      apiSpec: 'google-vertex',
      endpointId: 'vertex-prod',
    });
  });

  it('rejects incomplete or inconsistent custom source construction', () => {
    expect(() =>
      createReasoningSignatureSource('custom', 'google', 'gemini-custom', {
        apiSpec: 'google-vertex',
      } as any),
    ).toThrow('apiSpec and endpointId');
    expect(() =>
      createReasoningSignatureSource('custom', 'google', 'gemini-custom', {
        endpointId: 'vertex-prod',
      } as any),
    ).toThrow('apiSpec and endpointId');
    expect(() =>
      createReasoningSignatureSource('custom', 'google', 'gemini-custom', {
        apiSpec: 'amazon-bedrock',
        endpointId: 'bedrock-prod',
      }),
    ).toThrow('provider/apiSpec mismatch');
  });

  it('matches non-custom sources by provider mode and provider only', () => {
    const a: ReasoningSignatureSource = {
      providerMode: 'clodex',
      provider: 'anthropic',
      modelId: 'anthropic/claude-a',
    };
    const b: ReasoningSignatureSource = {
      providerMode: 'clodex',
      provider: 'anthropic',
      modelId: 'anthropic/claude-b',
    };
    const c: ReasoningSignatureSource = {
      providerMode: 'official',
      provider: 'anthropic',
      modelId: 'claude-a',
    };

    expect(reasoningSourcesMatch(a, b)).toBe(true);
    expect(reasoningSourcesMatch(a, c)).toBe(false);
  });

  it('matches custom sources by provider, API spec, and endpoint id', () => {
    const base: ReasoningSignatureSource = {
      providerMode: 'custom',
      provider: 'anthropic',
      apiSpec: 'amazon-bedrock',
      endpointId: 'bedrock-prod',
      modelId: 'anthropic.claude-sonnet-4-6',
    };

    expect(
      reasoningSourcesMatch(base, {
        ...base,
        modelId: 'anthropic.claude-opus-4-7',
      }),
    ).toBe(true);
    expect(
      reasoningSourcesMatch(base, { ...base, endpointId: 'bedrock-dev' }),
    ).toBe(false);
    expect(reasoningSourcesMatch(base, { ...base, apiSpec: 'anthropic' })).toBe(
      false,
    );
    expect(reasoningSourcesMatch(base, { ...base, apiSpec: undefined })).toBe(
      false,
    );
    expect(
      reasoningSourcesMatch(base, { ...base, endpointId: undefined }),
    ).toBe(false);
  });

  it('validates reasoning signature source schema invariants', () => {
    expect(
      reasoningSignatureSourceSchema.safeParse({
        providerMode: 'clodex',
        provider: 'anthropic',
        modelId: 'anthropic/claude-sonnet-4.6',
      }).success,
    ).toBe(true);
    expect(
      reasoningSignatureSourceSchema.safeParse({
        providerMode: 'official',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4.6',
      }).success,
    ).toBe(true);
    expect(
      reasoningSignatureSourceSchema.safeParse({
        providerMode: 'clodex',
        provider: 'anthropic',
      }).success,
    ).toBe(false);
    expect(
      reasoningSignatureSourceSchema.safeParse({
        providerMode: 'custom',
        provider: 'google',
        modelId: 'gemini-custom',
        endpointId: 'vertex-prod',
      }).success,
    ).toBe(false);
    expect(
      reasoningSignatureSourceSchema.safeParse({
        providerMode: 'custom',
        provider: 'google',
        modelId: 'gemini-custom',
        apiSpec: 'google-vertex',
      }).success,
    ).toBe(false);
    expect(
      reasoningSignatureSourceSchema.safeParse({
        providerMode: 'custom',
        provider: 'google',
        modelId: 'gemini-custom',
        apiSpec: 'google-vertex',
        endpointId: 'vertex-prod',
      }).success,
    ).toBe(true);
  });
});
