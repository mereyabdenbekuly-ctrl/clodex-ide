import { describe, expect, it, vi } from 'vitest';
import type { CredentialsService } from '@/services/credentials';
import type { AIProviderConfig } from '@shared/ai-provider';
import { createBuiltInProviderAdapters } from './built-in-adapters';

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('built-in provider adapters', () => {
  it('does not contact Clodex before the user selects or invokes it', () => {
    const request = vi.fn<typeof fetch>();
    createBuiltInProviderAdapters(
      {
        getProviderApiKey: vi.fn(() => null),
      } as unknown as CredentialsService,
      request,
    );

    expect(request).not.toHaveBeenCalled();
  });

  it('discovers OpenRouter models using the selected profile credentials', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      responseJson({
        data: [
          {
            id: 'moonshotai/kimi-k2.5',
            context_length: 262_144,
            top_provider: { max_completion_tokens: 32_768 },
          },
        ],
      }),
    );
    const adapters = createBuiltInProviderAdapters(
      {
        getProviderApiKey: vi.fn(() => 'or-secret'),
      } as unknown as CredentialsService,
      request,
    );
    const adapter = adapters.find(
      (candidate) => candidate.id === 'openrouter',
    )!;
    const config: AIProviderConfig = {
      id: 'openrouter-main',
      providerType: 'openrouter',
      displayName: 'OpenRouter',
      apiKeyReference: 'provider.openrouter-main',
      protocol: 'openai-chat',
      enabled: true,
    };

    await expect(adapter.listModels(config)).resolves.toEqual([
      expect.objectContaining({
        id: 'moonshotai/kimi-k2.5',
        providerId: 'openrouter-main',
        capabilities: expect.objectContaining({
          contextWindow: 262_144,
          maxOutputTokens: 32_768,
        }),
      }),
    ]);
    expect(request).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer or-secret',
        }),
      }),
    );
  });

  it('preserves common context-window fields from OpenAI-compatible model catalogs', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      responseJson({
        data: [
          { id: 'context-window', context_window: 131_072 },
          { id: 'camel-case', contextWindow: 262_144 },
          { id: 'vllm', max_model_len: 1_048_576 },
          { id: 'unknown', context_length: 0 },
        ],
      }),
    );
    const adapter = createBuiltInProviderAdapters(
      {
        getProviderApiKey: vi.fn(() => null),
      } as unknown as CredentialsService,
      request,
    ).find((candidate) => candidate.id === 'openai-compatible')!;
    const config: AIProviderConfig = {
      id: 'local-compatible',
      providerType: 'openai-compatible',
      displayName: 'Local compatible',
      baseUrl: 'http://localhost:8000/v1',
      protocol: 'openai-chat',
      enabled: true,
    };

    const models = await adapter.listModels(config);

    expect(models.map((model) => model.capabilities.contextWindow)).toEqual([
      131_072,
      262_144,
      1_048_576,
      undefined,
    ]);
  });

  it('discovers Ollama models without an API key', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      responseJson({ models: [{ name: 'qwen3-coder' }] }),
    );
    const adapters = createBuiltInProviderAdapters(
      {
        getProviderApiKey: vi.fn(() => null),
      } as unknown as CredentialsService,
      request,
    );
    const adapter = adapters.find((candidate) => candidate.id === 'ollama')!;
    const config: AIProviderConfig = {
      id: 'ollama-local',
      providerType: 'ollama',
      displayName: 'Local Ollama',
      baseUrl: 'http://localhost:11434',
      protocol: 'ollama',
      enabled: true,
    };

    await expect(adapter.listModels(config)).resolves.toEqual([
      expect.objectContaining({
        id: 'qwen3-coder',
        providerId: 'ollama-local',
      }),
    ]);
    expect(request).toHaveBeenCalledWith('http://localhost:11434/api/tags');
  });
});
