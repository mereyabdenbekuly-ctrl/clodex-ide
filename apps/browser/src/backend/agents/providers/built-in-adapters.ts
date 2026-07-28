import type { AIProviderAdapter } from '@shared/ai-provider';
import type { CredentialsService } from '@/services/credentials';
import { OllamaProviderAdapter } from './ollama-adapter';
import { OpenAICompatibleProviderAdapter } from './openai-compatible-adapter';
import { AnthropicProviderAdapter } from './anthropic-adapter';

const DEFAULT_CLODEX_LLM_RELAY_URL = 'https://clodex.xyz/v1';

function getClodexLlmRelayUrl(): string {
  return (
    process.env.CLODEX_LLM_RELAY_URL ||
    process.env.LLM_PROXY_URL ||
    DEFAULT_CLODEX_LLM_RELAY_URL
  );
}

export function createBuiltInProviderAdapters(
  credentials: CredentialsService,
  request: typeof fetch = fetch,
): AIProviderAdapter[] {
  const resolveApiKey = (reference: string) =>
    credentials.getProviderApiKey(reference);
  return [
    new OpenAICompatibleProviderAdapter({
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      resolveApiKey,
      fetch: request,
    }),
    new AnthropicProviderAdapter(resolveApiKey, request),
    new OpenAICompatibleProviderAdapter({
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      resolveApiKey,
      fetch: request,
    }),
    new OpenAICompatibleProviderAdapter({
      id: 'clodex',
      name: 'Clodex Cloud',
      type: 'clodex',
      defaultBaseUrl: getClodexLlmRelayUrl(),
      resolveApiKey,
      fetch: request,
    }),
    new OpenAICompatibleProviderAdapter({
      id: 'openai-compatible',
      name: 'OpenAI-compatible',
      type: 'openai-compatible',
      defaultBaseUrl: 'http://localhost:8000/v1',
      resolveApiKey,
      fetch: request,
    }),
    new OllamaProviderAdapter(request),
  ];
}
