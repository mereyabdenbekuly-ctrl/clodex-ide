import { describe, expect, it } from 'vitest';
import {
  createThinkingProviderOptionsPatch,
  getEffectiveThinkingSelection,
  getProviderProfileModelThinkingSupport,
  getSupportedThinkingOptions,
  isGpt56UltraThinkingSelected,
  supportsNativeThinkingProviderProfile,
  type ThinkingCapableModel,
} from './model-thinking-capabilities';

const openAiModel: ThinkingCapableModel = {
  modelId: 'gpt-5.5',
  officialProvider: 'openai',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { enabled: true, effort: 'medium' } },
    openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
  },
};

const gpt56SolModel: ThinkingCapableModel = {
  modelId: 'gpt-5.6-sol',
  officialProvider: 'openai',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { effort: 'medium' } },
  },
};

const gpt56TerraModel: ThinkingCapableModel = {
  modelId: 'gpt-5.6-terra',
  officialProvider: 'openai',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { effort: 'medium' } },
  },
};

const googleProModel: ThinkingCapableModel = {
  modelId: 'gemini-3.1-pro-preview',
  officialProvider: 'google',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { enabled: true, effort: 'medium' } },
    google: {
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
    },
  },
};

const googleFlashModel: ThinkingCapableModel = {
  modelId: 'gemini-3-flash-preview',
  officialProvider: 'google',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { enabled: true, effort: 'medium' } },
    google: {
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
    },
  },
};

const anthropicOpusModel: ThinkingCapableModel = {
  modelId: 'claude-opus-4.8',
  officialProvider: 'anthropic',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { enabled: true, effort: 'medium' } },
    anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
  },
};

const anthropicConservativeModel: ThinkingCapableModel = {
  modelId: 'claude-opus-4.6',
  officialProvider: 'anthropic',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { enabled: true, effort: 'medium' } },
    anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
  },
};

const glm52Model: ThinkingCapableModel = {
  modelId: 'glm-5.2',
  officialProvider: 'z-ai',
  thinkingEnabled: true,
  providerOptions: {
    clodex: { reasoning: { enabled: true, effort: 'xhigh' } },
    openai: { reasoningEffort: 'xhigh' },
  },
};

describe('model thinking capabilities', () => {
  it('limits editable profile thinking to native provider integrations', () => {
    expect(
      ['openai', 'anthropic', 'clodex'].every(
        supportsNativeThinkingProviderProfile,
      ),
    ).toBe(true);
    expect(
      ['ollama', 'openrouter', 'openai-compatible'].some(
        supportsNativeThinkingProviderProfile,
      ),
    ).toBe(false);
  });

  it.each([
    'gpt-5.6-sol',
    'openai/gpt-5.6-terra',
  ])('infers %s reasoning for direct OpenAI Responses catalogs', (modelId) => {
    expect(
      getProviderProfileModelThinkingSupport({
        providerType: 'openai',
        protocol: 'openai-responses',
        modelId,
        discoveredReasoning: false,
      }),
    ).toEqual({ thinkingEnabled: true, editable: true });
  });

  it('keeps inferred OpenAI Chat Sol/Terra reasoning editable', () => {
    expect(
      getProviderProfileModelThinkingSupport({
        providerType: 'openai',
        protocol: 'openai-chat',
        modelId: 'gpt-5.6-sol',
        discoveredReasoning: false,
      }),
    ).toEqual({ thinkingEnabled: true, editable: true });
  });

  it.each([
    'ollama',
    'openrouter',
    'openai-compatible',
  ])('keeps %s catalog reasoning non-editable', (providerType) => {
    expect(
      getProviderProfileModelThinkingSupport({
        providerType,
        protocol: 'openai-responses',
        modelId: 'gpt-5.6-terra',
        discoveredReasoning: true,
      }),
    ).toEqual({ thinkingEnabled: true, editable: false });
  });

  it('does not infer unknown OpenAI model reasoning', () => {
    expect(
      getProviderProfileModelThinkingSupport({
        providerType: 'openai',
        protocol: 'openai-responses',
        modelId: 'gpt-5.6-luna',
        discoveredReasoning: false,
      }),
    ).toEqual({ thinkingEnabled: false, editable: false });
    expect(
      getProviderProfileModelThinkingSupport({
        providerType: 'anthropic',
        protocol: 'anthropic-messages',
        modelId: 'gpt-5.6-sol',
        discoveredReasoning: false,
      }),
    ).toEqual({ thinkingEnabled: false, editable: false });
  });

  it('labels known generic-profile reasoning without making it editable', () => {
    expect(
      getProviderProfileModelThinkingSupport({
        providerType: 'openai-compatible',
        protocol: 'openai-responses',
        modelId: 'gpt-5.6-sol',
        discoveredReasoning: false,
      }),
    ).toEqual({ thinkingEnabled: true, editable: false });
  });

  it('coerces unsupported OpenAI minimal away from provider options', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: openAiModel,
        route: { providerMode: 'official', modelProvider: 'openai' },
        override: { enabled: true, provider: 'openai', value: 'minimal' },
      }),
    ).toEqual({ openai: { reasoningEffort: 'medium' } });
  });

  it('emits OpenAI none when gpt-5.5 thinking is disabled', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: openAiModel,
        route: { providerMode: 'official', modelProvider: 'openai' },
        override: { enabled: false, provider: 'openai', value: 'high' },
      }),
    ).toEqual({
      openai: { reasoningEffort: 'none', reasoningSummary: undefined },
    });
  });

  it('emits OpenAI xhigh for gpt-5.5 extra high', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: openAiModel,
        route: { providerMode: 'official', modelProvider: 'openai' },
        override: { enabled: true, provider: 'openai', value: 'xhigh' },
      }),
    ).toEqual({ openai: { reasoningEffort: 'xhigh' } });
  });

  it.each([
    gpt56SolModel,
    gpt56TerraModel,
  ])('exposes Clodex Max and Ultra presets for $modelId', (model) => {
    expect(
      getSupportedThinkingOptions(model, {
        providerMode: 'clodex',
        modelProvider: 'openai',
      }).map((option) => [option.value, option.label]),
    ).toEqual([
      ['minimal', 'Minimal'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
      ['max', 'Max'],
      ['ultra', 'Ultra'],
    ]);
  });

  it.each([
    [gpt56SolModel, 'max', 'max'],
    [gpt56SolModel, 'ultra', 'max'],
    [gpt56TerraModel, 'max', 'max'],
    [gpt56TerraModel, 'ultra', 'max'],
  ] as const)('normalizes the Clodex %s selection to provider effort %s', (model, selection, providerEffort) => {
    expect(
      createThinkingProviderOptionsPatch({
        model,
        route: { providerMode: 'clodex', modelProvider: 'openai' },
        override: { enabled: true, provider: 'clodex', value: selection },
      }),
    ).toEqual({ clodex: { reasoning: { effort: providerEffort } } });
  });

  it('exposes provider Max plus orchestration Ultra on direct OpenAI routes', () => {
    expect(
      getSupportedThinkingOptions(gpt56SolModel, {
        providerMode: 'official',
        modelProvider: 'openai',
      }).map((option) => option.value),
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

    expect(
      createThinkingProviderOptionsPatch({
        model: gpt56SolModel,
        route: { providerMode: 'official', modelProvider: 'openai' },
        override: { enabled: true, provider: 'openai', value: 'ultra' },
      }),
    ).toEqual({ openai: { reasoningEffort: 'max' } });
  });

  it('keeps OpenAI chat-completions routes conservative for Sol/Terra', () => {
    const route = {
      providerMode: 'custom' as const,
      modelProvider: 'openai' as const,
      customEndpointApiSpec: 'openai-chat-completions' as const,
    };

    expect(
      getSupportedThinkingOptions(gpt56TerraModel, route).map(
        (option) => option.value,
      ),
    ).toEqual(['low', 'medium', 'high']);
    expect(
      createThinkingProviderOptionsPatch({
        model: gpt56TerraModel,
        route,
        override: { enabled: true, value: 'ultra' },
      }),
    ).toEqual({ openai: { reasoningEffort: 'medium' } });
  });

  it('recognizes Ultra only for active Sol/Terra routes', () => {
    expect(
      isGpt56UltraThinkingSelected({
        modelId: 'gpt-5.6-sol',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
      }),
    ).toBe(true);
    expect(
      isGpt56UltraThinkingSelected({
        modelId: 'openai/gpt-5.6-terra',
        override: { enabled: true, provider: 'openai', value: 'ultra' },
        providerMode: 'official',
      }),
    ).toBe(true);
    expect(
      isGpt56UltraThinkingSelected({
        modelId: 'gpt-5.6-sol',
        override: { enabled: false, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
      }),
    ).toBe(false);
    expect(
      isGpt56UltraThinkingSelected({
        modelId: 'gpt-5.6-luna',
        override: { enabled: true, provider: 'clodex', value: 'ultra' },
        providerMode: 'clodex',
      }),
    ).toBe(false);
  });

  it('uses model-specific Google thinking option sets', () => {
    expect(
      getSupportedThinkingOptions(googleProModel, {
        providerMode: 'official',
        modelProvider: 'google',
      }).map((option) => option.value),
    ).toEqual(['low', 'medium', 'high']);

    expect(
      getSupportedThinkingOptions(googleFlashModel, {
        providerMode: 'official',
        modelProvider: 'google',
      }).map((option) => option.value),
    ).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('never emits Google xhigh', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: googleProModel,
        route: { providerMode: 'official', modelProvider: 'google' },
        override: { enabled: true, provider: 'google', value: 'xhigh' },
      }),
    ).toEqual({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
      },
    });
  });

  it('filters Anthropic advanced values by model family', () => {
    expect(
      getSupportedThinkingOptions(anthropicOpusModel, {
        providerMode: 'official',
        modelProvider: 'anthropic',
      }).map((option) => option.value),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    expect(
      getSupportedThinkingOptions(anthropicConservativeModel, {
        providerMode: 'official',
        modelProvider: 'anthropic',
      }).map((option) => option.value),
    ).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('emits Anthropic max for supported adaptive models', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: anthropicOpusModel,
        route: { providerMode: 'official', modelProvider: 'anthropic' },
        override: { enabled: true, provider: 'anthropic', value: 'max' },
      }),
    ).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } });
  });

  it('uses gateway-supported options for Clodex-routed Claude models', () => {
    expect(
      getSupportedThinkingOptions(anthropicOpusModel, {
        providerMode: 'clodex',
        modelProvider: 'anthropic',
      }).map((option) => option.value),
    ).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('emits gateway patches for Clodex-routed Claude overrides', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: anthropicOpusModel,
        route: { providerMode: 'clodex', modelProvider: 'anthropic' },
        override: { enabled: true, provider: 'clodex', value: 'high' },
      }),
    ).toEqual({ clodex: { reasoning: { effort: 'high' } } });
  });

  it('applies valid legacy Clodex overrides in Clodex provider-native mode', () => {
    expect(
      getEffectiveThinkingSelection(
        anthropicOpusModel,
        { enabled: true, provider: 'clodex', value: 'high' },
        { providerMode: 'clodex', modelProvider: 'anthropic' },
      ),
    ).toMatchObject({ provider: 'clodex', value: 'high' });
  });

  it('falls back for invalid legacy Clodex overrides in provider-native mode', () => {
    expect(
      getEffectiveThinkingSelection(
        anthropicOpusModel,
        { enabled: true, provider: 'clodex', value: 'minimal' },
        { providerMode: 'clodex', modelProvider: 'anthropic' },
      ),
    ).toMatchObject({ provider: 'clodex', value: 'minimal' });
  });

  it('uses conservative values for OpenAI-compatible providers', () => {
    expect(
      getSupportedThinkingOptions('kimi-k2-thinking', {
        providerMode: 'official',
        modelProvider: 'moonshotai',
      }).map((option) => option.value),
    ).toEqual(['low', 'medium', 'high']);
  });

  it('exposes max-labeled xhigh reasoning for GLM 5.2 on OpenAI-compatible routes', () => {
    const options = getSupportedThinkingOptions(glm52Model, {
      providerMode: 'official',
      modelProvider: 'z-ai',
    });

    expect(options.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(options.at(-1)).toMatchObject({ value: 'xhigh', label: 'Max' });
  });

  it('emits OpenAI-compatible xhigh for GLM 5.2 max reasoning', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: glm52Model,
        route: { providerMode: 'official', modelProvider: 'z-ai' },
        override: {
          enabled: true,
          provider: 'openai-compatible',
          value: 'xhigh',
        },
      }),
    ).toEqual({ openai: { reasoningEffort: 'xhigh' } });
  });

  it('coerces legacy GLM 5.2 max overrides to OpenAI-compatible xhigh', () => {
    expect(
      createThinkingProviderOptionsPatch({
        model: glm52Model,
        route: { providerMode: 'official', modelProvider: 'z-ai' },
        override: {
          enabled: true,
          provider: 'openai-compatible',
          value: 'max',
        },
      }),
    ).toEqual({ openai: { reasoningEffort: 'xhigh' } });
  });

  it('uses OpenAI-compatible values for custom chat completions endpoints', () => {
    expect(
      getSupportedThinkingOptions('gpt-5.5', {
        providerMode: 'custom',
        modelProvider: 'openai',
        customEndpointApiSpec: 'openai-chat-completions',
      }).map((option) => option.value),
    ).toEqual(['low', 'medium', 'high']);
  });
});
