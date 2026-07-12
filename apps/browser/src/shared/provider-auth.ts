import type {
  ModelProvider,
  ProviderEndpointMode,
  UserPreferences,
} from './karton-contracts/ui/shared-types';

export type ProviderAuthMethod = 'api-key' | 'oauth' | 'web-auth';

const PREVIEW_PROVIDER_AUTH_METHODS: Readonly<
  Record<ModelProvider, readonly ProviderAuthMethod[]>
> = {
  anthropic: ['api-key'],
  openai: ['api-key'],
  google: ['api-key'],
  moonshotai: ['api-key'],
  alibaba: ['api-key'],
  deepseek: ['api-key'],
  'z-ai': ['api-key'],
  minimax: ['api-key'],
  'xiaomi-mimo': ['api-key'],
  mistral: ['api-key'],
};

export function supportsProviderAuthMethod(
  provider: ModelProvider,
  method: ProviderAuthMethod,
): boolean {
  return PREVIEW_PROVIDER_AUTH_METHODS[provider].includes(method);
}

export type ProviderConnectionOption = {
  value: ProviderEndpointMode;
  label: string;
  authMethod: 'clodex-account' | 'api-key' | 'custom-endpoint';
};

export function getProviderConnectionOptions(
  provider: ModelProvider,
  displayName: string,
): ProviderConnectionOption[] {
  const options: ProviderConnectionOption[] = [
    {
      value: 'clodex',
      label: 'Use my Clodex account',
      authMethod: 'clodex-account',
    },
  ];

  if (supportsProviderAuthMethod(provider, 'api-key')) {
    options.push({
      value: 'official',
      label: `Use own API key with ${displayName} API`,
      authMethod: 'api-key',
    });
  }

  options.push({
    value: 'custom',
    label: 'Use custom provider',
    authMethod: 'custom-endpoint',
  });
  return options;
}

/**
 * Determine whether a provider has a configured API key without exposing key
 * material to the renderer. OpenAI and Anthropic use provider profiles backed
 * by the encrypted credential store; other providers retain the one-release
 * legacy encrypted preference field.
 */
export function isProviderApiKeyConnected(
  preferences: Pick<UserPreferences, 'providerConfigs' | 'providerProfiles'>,
  provider: ModelProvider,
): boolean {
  const config = preferences.providerConfigs[provider];
  if (config.mode !== 'official') return false;
  if (config.encryptedApiKey) return true;
  if (provider !== 'openai' && provider !== 'anthropic') return false;

  const profileId = `official-${provider}`;
  return preferences.providerProfiles.some(
    (profile) =>
      profile.id === profileId &&
      profile.providerType === provider &&
      profile.enabled &&
      Boolean(profile.apiKeyReference),
  );
}
