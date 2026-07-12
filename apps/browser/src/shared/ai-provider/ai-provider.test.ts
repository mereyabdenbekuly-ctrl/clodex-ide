import { describe, expect, it } from 'vitest';
import { normalizeProviderError } from './errors';
import { AIProviderRegistry } from './registry';
import { toQualifiedModelId, type AIProviderAdapter } from './types';
import { normalizeProviderUsage } from './usage';

function fakeAdapter(
  id: string,
  type: AIProviderAdapter['type'] = 'openai-compatible',
): AIProviderAdapter {
  return {
    id,
    name: id,
    type,
    validate: async () => ({ success: true }),
    listModels: async () => [],
    createResponse: async () => ({ content: '' }),
    async *streamResponse() {
      yield { type: 'finish' };
    },
    normalizeError: normalizeProviderError,
  };
}

describe('AIProviderRegistry', () => {
  it('registers, filters and removes adapters', () => {
    const registry = new AIProviderRegistry();
    registry.register(fakeAdapter('custom'));
    registry.register(fakeAdapter('clodex', 'clodex'));

    expect(registry.require('custom').id).toBe('custom');
    expect(registry.list('clodex').map((adapter) => adapter.id)).toEqual([
      'clodex',
    ]);
    expect(registry.unregister('custom')).toBe(true);
    expect(registry.get('custom')).toBeUndefined();
  });

  it('rejects duplicate adapter IDs', () => {
    const registry = new AIProviderRegistry();
    registry.register(fakeAdapter('same'));
    expect(() => registry.register(fakeAdapter('same'))).toThrow(
      'already registered',
    );
  });
});

describe('provider-neutral helpers', () => {
  it('uses provider-qualified model IDs', () => {
    expect(toQualifiedModelId('ollama', 'qwen3-coder')).toBe(
      'ollama:qwen3-coder',
    );
  });

  it('normalizes rate limits and redacts credentials', () => {
    expect(
      normalizeProviderError({
        status: 429,
        message: 'Authorization=Bearer-secret rate limited',
        response: { headers: { 'retry-after': '2' } },
      }),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: 2_000,
      message: 'Authorization: [REDACTED] rate limited',
    });
  });

  it('prefers provider cost over a local estimate', () => {
    expect(
      normalizeProviderUsage(
        {
          inputTokens: 1_000,
          outputTokens: 500,
          cost: 0.42,
          currency: 'USD',
        },
        { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      ),
    ).toMatchObject({
      totalTokens: 1_500,
      estimatedCost: 0.42,
      source: 'provider',
    });
  });

  it('labels catalog pricing as an estimate', () => {
    expect(
      normalizeProviderUsage(
        { inputTokens: 1_000, outputTokens: 500, cachedTokens: 200 },
        {
          inputPerMillion: 1,
          cachedInputPerMillion: 0.5,
          outputPerMillion: 2,
          currency: 'USD',
        },
      ),
    ).toMatchObject({
      totalTokens: 1_500,
      estimatedCost: 0.0019,
      currency: 'USD',
      source: 'local-estimate',
    });
  });
});
