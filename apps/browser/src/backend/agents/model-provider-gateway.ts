import type { LanguageModelMiddleware } from 'ai';
import type { ModelProvider } from '@shared/karton-contracts/ui/shared-types';
import { CLODEX_ACCOUNT_PROVIDER_PROFILE_ID } from '@shared/karton-contracts/ui/shared-types';
import type { ProviderProfile } from '@shared/karton-contracts/ui/shared-types';

const DEFAULT_CLODEX_LLM_RELAY_URL = 'https://clodex.xyz/v1';

export function getClodexLlmRelayUrl(): string {
  return (
    process.env.CLODEX_LLM_RELAY_URL ||
    process.env.LLM_PROXY_URL ||
    DEFAULT_CLODEX_LLM_RELAY_URL
  );
}

export const CLODEX_UNKNOWN_MODEL_CONTEXT_WINDOW_BUDGET = 200_000;
export const PROVIDER_PROFILE_UNKNOWN_CONTEXT_WINDOW_BUDGET = 128_000;
export const CLODEX_BUILT_IN_SAME_PROVIDER_FALLBACKS: Partial<
  Record<ModelProvider, readonly string[]>
> = {
  google: ['gemini-3.5-flash'],
};

/**
 * Middleware that tells the SDK all HTTP(S) URLs are natively supported by the
 * clodex gateway. Without this the SDK downloads every image/file URL and
 * inlines the content as base64, causing "payload too large" errors.
 */
export const clodexUrlPassthroughMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  overrideSupportedUrls: () => ({
    '*': [/^https?:\/\//i],
  }),
};

export function resolveProviderProfileBaseUrl(
  profile: Pick<ProviderProfile, 'id' | 'providerType' | 'baseUrl'>,
): string | undefined {
  if (profile.id === CLODEX_ACCOUNT_PROVIDER_PROFILE_ID) {
    return getClodexLlmRelayUrl();
  }
  if (profile.providerType === 'ollama') {
    return `${(profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/v1`;
  }
  return profile.baseUrl;
}
