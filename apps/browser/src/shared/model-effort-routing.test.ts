import { describe, expect, it } from 'vitest';
import {
  getActiveGptThinkingProviderMode,
  getModelThinkingOverride,
  getThinkingOverrideModelId,
  getThinkingOverrideStorageKey,
  resolveSubmitSwarmRoute,
} from './model-effort-routing';
import {
  customModelSchema,
  defaultUserPreferences,
} from './karton-contracts/ui/shared-types';

describe('model effort submit routing', () => {
  it('routes Sol Ultra through standard Swarm automatically', () => {
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
        manualModeActive: false,
        manualModeVariant: null,
      }),
    ).toEqual({
      enabled: true,
      variant: 'standard',
      automaticUltra: true,
    });
  });

  it('routes direct OpenAI Terra Ultra through standard Swarm', () => {
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'gpt-5.6-terra',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode: 'official',
        manualModeActive: false,
        manualModeVariant: null,
      }),
    ).toEqual({
      enabled: true,
      variant: 'standard',
      automaticUltra: true,
    });
  });

  it('preserves an explicit battle route over automatic Ultra', () => {
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
        manualModeActive: true,
        manualModeVariant: 'battle',
      }),
    ).toMatchObject({ enabled: true, variant: 'battle' });
  });

  it('does not auto-route Max, disabled Ultra, or Luna', () => {
    for (const input of [
      {
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'max' },
      },
      {
        modelId: 'gpt-5.6-terra',
        override: { enabled: false, provider: 'clodex', value: 'ultra' },
      },
      {
        modelId: 'gpt-5.6-luna',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
      },
    ] as const) {
      expect(
        resolveSubmitSwarmRoute({
          ...input,
          providerMode: 'clodex',
          manualModeActive: false,
          manualModeVariant: null,
        }).enabled,
      ).toBe(false);
    }
  });

  it('does not intercept Ultra or manual Swarm cloud handoffs', () => {
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
        manualModeActive: true,
        manualModeVariant: 'battle',
        executionTarget: 'cloud',
      }),
    ).toMatchObject({ enabled: false, automaticUltra: false });
  });

  it('uses the raw model ID as the override key for qualified profiles', () => {
    expect(getThinkingOverrideModelId('openai-prod:gpt-5.6-terra')).toBe(
      'gpt-5.6-terra',
    );
    expect(getThinkingOverrideModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('uses qualified overrides first and raw overrides only as migration fallback', () => {
    const overrides = {
      'gpt-5.6-sol': { value: 'high' },
      'openai-main:gpt-5.6-sol': { value: 'ultra' },
    };

    expect(
      getModelThinkingOverride(overrides, 'openai-main:gpt-5.6-sol'),
    ).toEqual({ value: 'ultra' });
    expect(
      getModelThinkingOverride(overrides, 'clodex-main:gpt-5.6-sol'),
    ).toEqual({ value: 'high' });
    expect(getModelThinkingOverride(overrides, 'gpt-5.6-sol')).toEqual({
      value: 'high',
    });
    expect(getThinkingOverrideStorageKey('openai-main:gpt-5.6-sol')).toBe(
      'openai-main:gpt-5.6-sol',
    );
  });

  it('allows an empty qualified override to suppress the legacy raw fallback', () => {
    expect(
      getModelThinkingOverride(
        {
          'gpt-5.6-sol': { value: 'ultra' },
          'openai-main:gpt-5.6-sol': {},
        },
        'openai-main:gpt-5.6-sol',
      ),
    ).toEqual({});
  });

  it('resolves profile-specific provider modes for Ultra routing', () => {
    const preferences = structuredClone(defaultUserPreferences);
    preferences.providerProfiles = [
      {
        id: 'openai-main',
        providerType: 'openai',
        displayName: 'OpenAI',
        protocol: 'openai-responses',
        customHeaders: {},
        enabled: true,
      },
      {
        id: 'clodex-main',
        providerType: 'clodex',
        displayName: 'Clodex',
        protocol: 'openai-chat',
        customHeaders: {},
        enabled: true,
      },
    ];

    expect(
      getActiveGptThinkingProviderMode('openai-main:gpt-5.6-sol', preferences),
    ).toBe('official');
    expect(
      getActiveGptThinkingProviderMode('clodex-main:gpt-5.6-sol', preferences),
    ).toBe('clodex');
  });

  it('activates Ultra for a legacy OpenAI Responses endpoint', () => {
    const preferences = structuredClone(defaultUserPreferences);
    preferences.providerConfigs.openai = {
      mode: 'custom',
      customProviderId: 'legacy-responses',
    };
    preferences.customEndpoints = [
      {
        id: 'legacy-responses',
        name: 'Legacy Responses',
        apiSpec: 'openai-responses',
        baseUrl: 'https://example.com/v1',
        awsAuthMode: 'access-keys',
      },
    ];

    const providerMode = getActiveGptThinkingProviderMode(
      'gpt-5.6-sol',
      preferences,
    );
    expect(providerMode).toBe('official');
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode,
        manualModeActive: false,
        manualModeVariant: null,
      }),
    ).toMatchObject({ enabled: true, automaticUltra: true });
  });

  it('activates Ultra for a legacy custom model on a Responses endpoint', () => {
    const preferences = structuredClone(defaultUserPreferences);
    preferences.providerProfiles = [
      {
        id: 'clodex-main',
        providerType: 'clodex',
        displayName: 'Clodex',
        protocol: 'openai-chat',
        customHeaders: {},
        enabled: true,
      },
    ];
    preferences.defaultProviderProfileId = 'clodex-main';
    preferences.customEndpoints = [
      {
        id: 'legacy-responses',
        name: 'Legacy Responses',
        apiSpec: 'openai-responses',
        baseUrl: 'https://example.com/v1',
        awsAuthMode: 'access-keys',
      },
    ];
    preferences.customModels = [
      customModelSchema.parse({
        modelId: 'openai/gpt-5.6-terra',
        displayName: 'Terra via legacy endpoint',
        endpointId: 'legacy-responses',
        thinkingEnabled: true,
      }),
    ];

    const providerMode = getActiveGptThinkingProviderMode(
      'openai/gpt-5.6-terra',
      preferences,
    );
    expect(providerMode).toBe('official');
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'openai/gpt-5.6-terra',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode,
        manualModeActive: false,
        manualModeVariant: null,
      }),
    ).toMatchObject({ enabled: true, automaticUltra: true });
  });

  it('does not activate Ultra for legacy Chat Completions routes', () => {
    const preferences = structuredClone(defaultUserPreferences);
    preferences.providerConfigs.openai = {
      mode: 'custom',
      customProviderId: 'legacy-chat',
    };
    preferences.customEndpoints = [
      {
        id: 'legacy-chat',
        name: 'Legacy Chat',
        apiSpec: 'openai-chat-completions',
        baseUrl: 'https://example.com/v1',
        awsAuthMode: 'access-keys',
      },
    ];

    const providerMode = getActiveGptThinkingProviderMode(
      'gpt-5.6-sol',
      preferences,
    );
    expect(providerMode).toBe('custom');
    expect(
      resolveSubmitSwarmRoute({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode,
        manualModeActive: false,
        manualModeVariant: null,
      }),
    ).toMatchObject({ enabled: false, automaticUltra: false });
  });

  it('does not fall back to Clodex Ultra for a custom Chat model', () => {
    const preferences = structuredClone(defaultUserPreferences);
    preferences.customEndpoints = [
      {
        id: 'legacy-chat',
        name: 'Legacy Chat',
        apiSpec: 'openai-chat-completions',
        baseUrl: 'https://example.com/v1',
        awsAuthMode: 'access-keys',
      },
    ];
    preferences.customModels = [
      customModelSchema.parse({
        modelId: 'gpt-5.6-sol',
        displayName: 'Sol via legacy Chat',
        endpointId: 'legacy-chat',
        thinkingEnabled: true,
      }),
    ];

    expect(getActiveGptThinkingProviderMode('gpt-5.6-sol', preferences)).toBe(
      'custom',
    );
  });
});
