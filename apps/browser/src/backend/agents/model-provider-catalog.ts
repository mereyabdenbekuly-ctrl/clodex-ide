import type { ModelProvider } from '@shared/karton-contracts/ui/shared-types';
import { availableModels } from '@shared/available-models';
import type {
  BuiltInModelSettings,
  ThinkingModelSettings,
} from './model-provider-types';

export function getBareModelId(modelId: string): string {
  return modelId.split('/').pop() ?? modelId;
}

export function getUnambiguousAvailableModelByBareId(
  modelId: string,
): BuiltInModelSettings | undefined {
  const bareModelId = getBareModelId(modelId);
  const matches = availableModels.filter(
    (candidate) => getBareModelId(candidate.modelId) === bareModelId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function getExplicitQualifiedRouteProvider(
  modelId: string,
): ModelProvider | undefined {
  const separator = modelId.indexOf('/');
  if (separator <= 0) return undefined;
  const prefix = modelId.slice(0, separator).toLowerCase();
  switch (prefix) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
    case 'gemini':
      return 'google';
    case 'moonshotai':
    case 'moonshot':
    case 'kimi':
      return 'moonshotai';
    case 'alibaba':
    case 'qwen':
    case 'dashscope':
      return 'alibaba';
    case 'deepseek':
      return 'deepseek';
    case 'z-ai':
    case 'zai':
    case 'glm':
      return 'z-ai';
    case 'minimax':
      return 'minimax';
    case 'xiaomi-mimo':
    case 'xiaomi':
    case 'mimo':
      return 'xiaomi-mimo';
    case 'mistral':
    case 'mistralai':
      return 'mistral';
    default:
      return undefined;
  }
}

export function parseQualifiedModelId(
  value: string,
): { providerProfileId: string; modelId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    providerProfileId: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export function getDynamicGpt5ThinkingModel(
  modelId: string,
  semanticProvider: ModelProvider,
): ThinkingModelSettings | undefined {
  const bareModelId = getBareModelId(modelId).toLowerCase();
  if (semanticProvider !== 'openai' || !/^gpt-5(?:\.|$)/.test(bareModelId)) {
    return undefined;
  }

  return {
    modelId,
    officialProvider: 'openai',
    thinkingEnabled: true,
    providerOptions: {
      clodex: { reasoning: { effort: 'medium' } },
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
    },
  };
}

function normalizeProviderName(provider: string | undefined): string {
  return (
    provider
      ?.trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-') ?? ''
  );
}

export function toSemanticProvider(
  provider: string | undefined,
  modelId: string,
): ModelProvider {
  switch (normalizeProviderName(provider)) {
    case 'anthropic':
    case 'anthropic-compatible':
    case 'claude':
      return 'anthropic';
    case 'google':
    case 'google-compatible':
    case 'gemini':
      return 'google';
    case 'moonshotai':
    case 'moonshot':
    case 'kimi':
      return 'moonshotai';
    case 'alibaba':
    case 'qwen':
    case 'dashscope':
      return 'alibaba';
    case 'deepseek':
      return 'deepseek';
    case 'z-ai':
    case 'zai':
    case 'glm':
      return 'z-ai';
    case 'minimax':
      return 'minimax';
    case 'xiaomi-mimo':
    case 'xiaomi':
    case 'mimo':
      return 'xiaomi-mimo';
    case 'mistral':
    case 'mistralai':
      return 'mistral';
    case 'openai':
    case 'openai-compatible':
    default:
      break;
  }

  const bareModelId = getBareModelId(modelId).toLowerCase();
  if (bareModelId.startsWith('claude-')) return 'anthropic';
  if (bareModelId.startsWith('gemini-')) return 'google';
  if (bareModelId.startsWith('kimi-')) return 'moonshotai';
  if (bareModelId.startsWith('qwen')) return 'alibaba';
  if (bareModelId.startsWith('deepseek-')) return 'deepseek';
  if (bareModelId.startsWith('glm-')) return 'z-ai';
  if (bareModelId.startsWith('minimax-')) return 'minimax';
  if (bareModelId.startsWith('mimo-')) return 'xiaomi-mimo';
  if (bareModelId.startsWith('mistral-')) return 'mistral';
  return 'openai';
}

/**
 * Converts an OpenRouter-style Anthropic model ID (dots in version, e.g.
 * `claude-opus-4.8`) to the native Anthropic API format (hyphens, e.g.
 * `claude-opus-4-8`). Idempotent on IDs that already use hyphens.
 */
export function toNativeAnthropicModelId(modelId: string): string {
  return modelId.replace(/\./g, '-');
}

export function toClodexGatewayModelId(
  provider: ModelProvider | undefined,
  modelId: string,
): string {
  if (provider === 'anthropic') return toNativeAnthropicModelId(modelId);
  return modelId;
}

export function toNativeMiniMaxModelId(modelId: string): string {
  if (modelId === 'minimax-m3') return 'MiniMax-M3';
  return modelId;
}
