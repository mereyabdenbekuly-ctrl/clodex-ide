import { describe, expect, it } from 'vitest';
import { getQualifiedBuiltInThinkingPresentation } from './model-select-thinking';

const thinkingModel = {
  modelId: 'gpt-5.6-sol',
  modelDisplayName: 'GPT-5.6 Sol',
  officialProvider: 'openai' as const,
  providerOptions: {},
  thinkingEnabled: true,
};

describe('qualified built-in model thinking presentation', () => {
  it.each([
    'ollama',
    'openrouter',
    'openai-compatible',
  ])('keeps %s fallback reasoning non-editable when discovery is empty', (profileProviderType) => {
    expect(
      getQualifiedBuiltInThinkingPresentation({
        profileProviderType,
        qualifiedModelId: `${profileProviderType}:gpt-5.6-sol`,
        thinkingEnabled: true,
        thinkingLabel: 'Medium',
        computedThinkingLabel: 'Ultra',
        isAlias: false,
        thinkingModel,
      }),
    ).toEqual({
      thinkingLabel: 'Reasoning',
      thinkingModel: undefined,
      thinkingOverrideKey: undefined,
    });
  });

  it('preserves native OpenAI effort editing for the qualified fallback', () => {
    expect(
      getQualifiedBuiltInThinkingPresentation({
        profileProviderType: 'openai',
        qualifiedModelId: 'openai-main:gpt-5.6-sol',
        thinkingEnabled: true,
        thinkingLabel: 'Medium',
        computedThinkingLabel: 'Ultra',
        isAlias: false,
        thinkingModel,
      }),
    ).toEqual({
      thinkingLabel: 'Ultra',
      thinkingModel,
      thinkingOverrideKey: 'openai-main:gpt-5.6-sol',
    });
  });
});
