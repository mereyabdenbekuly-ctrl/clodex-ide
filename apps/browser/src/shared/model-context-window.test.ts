import { describe, expect, it } from 'vitest';
import {
  formatModelContextWindow,
  resolveModelContextWindow,
} from './model-context-window';

describe('resolveModelContextWindow', () => {
  it('prefers authoritative Clodex account metadata over the built-in catalog', () => {
    expect(
      resolveModelContextWindow({
        modelId: 'kimi-k2.5',
        clodexModels: [{ id: 'moonshotai/kimi-k2.5', contextWindow: 300_000 }],
      }),
    ).toEqual({ tokens: 300_000, source: 'clodex-account' });
  });

  it('uses provider catalog metadata for qualified OpenAI-compatible models', () => {
    expect(
      resolveModelContextWindow({
        modelId: 'openrouter-main:moonshotai/kimi-k2.5',
        providerProfiles: [
          { id: 'openrouter-main', providerType: 'openrouter' },
        ],
        providerModelCatalogs: {
          'openrouter-main': [
            {
              id: 'moonshotai/kimi-k2.5',
              capabilities: { contextWindow: 262_144 },
            },
          ],
        },
      }),
    ).toEqual({ tokens: 262_144, source: 'provider-catalog' });
  });

  it('uses account metadata for qualified Clodex profiles', () => {
    expect(
      resolveModelContextWindow({
        modelId: 'clodex-account:z-ai/glm-5.2',
        providerProfiles: [{ id: 'clodex-account', providerType: 'clodex' }],
        clodexModels: [{ id: 'z-ai/glm-5.2', contextWindow: 1_200_000 }],
        providerModelCatalogs: {
          'clodex-account': [
            {
              id: 'z-ai/glm-5.2',
              capabilities: { contextWindow: 1_048_576 },
            },
          ],
        },
      }),
    ).toEqual({ tokens: 1_200_000, source: 'clodex-account' });
  });

  it('falls back to built-in metadata for provider-qualified known models', () => {
    expect(
      resolveModelContextWindow({
        modelId: 'openrouter-main:moonshotai/kimi-k2.5',
        providerProfiles: [
          { id: 'openrouter-main', providerType: 'openrouter' },
        ],
      }),
    ).toEqual({ tokens: 250_000, source: 'built-in' });
  });

  it('uses explicitly configured custom-model context windows', () => {
    expect(
      resolveModelContextWindow({
        modelId: 'qwen-local',
        customModels: [{ modelId: 'qwen-local', contextWindowSize: 1_048_576 }],
      }),
    ).toEqual({ tokens: 1_048_576, source: 'custom-model' });
  });

  it('does not turn an unknown model into a fake 200k capability', () => {
    expect(
      resolveModelContextWindow({
        modelId: 'openrouter-main:vendor/unknown-model',
        providerProfiles: [
          { id: 'openrouter-main', providerType: 'openrouter' },
        ],
      }),
    ).toBeUndefined();
    expect(formatModelContextWindow()).toBe('Context unknown');
  });
});
