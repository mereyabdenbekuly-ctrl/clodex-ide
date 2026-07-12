import { describe, expect, it } from 'vitest';
import { defaultUserPreferences } from './karton-contracts/ui/shared-types';
import {
  getProviderConnectionOptions,
  isProviderApiKeyConnected,
  supportsProviderAuthMethod,
} from './provider-auth';

function createPreferences() {
  return structuredClone(defaultUserPreferences);
}

describe('preview provider authentication scope', () => {
  it.each([
    'openai',
    'anthropic',
  ] as const)('exposes API-key authentication only for %s', (provider) => {
    expect(supportsProviderAuthMethod(provider, 'api-key')).toBe(true);
    expect(supportsProviderAuthMethod(provider, 'oauth')).toBe(false);
    expect(supportsProviderAuthMethod(provider, 'web-auth')).toBe(false);

    const options = getProviderConnectionOptions(
      provider,
      provider === 'openai' ? 'OpenAI' : 'Anthropic',
    );
    expect(options.map((option) => option.authMethod)).toEqual([
      'clodex-account',
      'api-key',
      'custom-endpoint',
    ]);
    expect(
      options.find((option) => option.value === 'official')?.label,
    ).toContain('API key');
    expect(options.map((option) => option.label).join(' ')).not.toMatch(
      /oauth|web\s*auth|subscription/i,
    );
  });
});

describe('provider API-key connection state', () => {
  it.each([
    'openai',
    'anthropic',
  ] as const)('recognizes a credential-backed official %s profile', (provider) => {
    const preferences = createPreferences();
    preferences.providerConfigs[provider].mode = 'official';
    preferences.providerProfiles.push({
      id: `official-${provider}`,
      providerType: provider,
      displayName: provider === 'openai' ? 'OpenAI' : 'Anthropic',
      apiKeyReference: `provider.official-${provider}`,
      protocol:
        provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      customHeaders: {},
      enabled: true,
    });

    expect(isProviderApiKeyConnected(preferences, provider)).toBe(true);
    expect(JSON.stringify(preferences)).not.toContain('sk-');
  });

  it('retains the legacy encrypted preference compatibility path', () => {
    const preferences = createPreferences();
    preferences.providerConfigs.google = {
      mode: 'official',
      encryptedApiKey: 'opaque-encrypted-value',
    };

    expect(isProviderApiKeyConnected(preferences, 'google')).toBe(true);
  });

  it('does not report disabled, reference-less, or non-official profiles', () => {
    const preferences = createPreferences();
    preferences.providerConfigs.openai.mode = 'official';
    preferences.providerProfiles.push({
      id: 'official-openai',
      providerType: 'openai',
      displayName: 'OpenAI',
      apiKeyReference: 'provider.official-openai',
      protocol: 'openai-responses',
      customHeaders: {},
      enabled: false,
    });

    expect(isProviderApiKeyConnected(preferences, 'openai')).toBe(false);
    preferences.providerProfiles[0]!.enabled = true;
    preferences.providerProfiles[0]!.apiKeyReference = undefined;
    expect(isProviderApiKeyConnected(preferences, 'openai')).toBe(false);
    preferences.providerProfiles[0]!.apiKeyReference =
      'provider.official-openai';
    preferences.providerConfigs.openai.mode = 'clodex';
    expect(isProviderApiKeyConnected(preferences, 'openai')).toBe(false);
  });
});
