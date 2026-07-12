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
      responseJson({ data: [{ id: 'openai/example' }] }),
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
        id: 'openai/example',
        providerId: 'openrouter-main',
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
