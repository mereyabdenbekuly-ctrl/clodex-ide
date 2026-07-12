import type { ProviderUsage } from './types';

export type NormalizedUsageSource =
  | 'provider'
  | 'local-estimate'
  | 'unavailable';

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  currency?: string;
  source: NormalizedUsageSource;
}

export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  currency: string;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeProviderUsage(
  usage: ProviderUsage | undefined,
  pricing?: ModelPricing,
): NormalizedUsage {
  if (!usage) return { source: 'unavailable' };

  const inputTokens = finiteNonNegative(usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const cachedTokens = finiteNonNegative(usage.cachedTokens);
  const totalTokens =
    finiteNonNegative(usage.totalTokens) ??
    (inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const providerCost = finiteNonNegative(usage.cost);

  if (providerCost != null) {
    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      estimatedCost: providerCost,
      currency: usage.currency,
      source: 'provider',
    };
  }

  if (pricing) {
    const uncachedInput = Math.max(0, (inputTokens ?? 0) - (cachedTokens ?? 0));
    const estimatedCost =
      (uncachedInput * (pricing.inputPerMillion ?? 0) +
        (cachedTokens ?? 0) * (pricing.cachedInputPerMillion ?? 0) +
        (outputTokens ?? 0) * (pricing.outputPerMillion ?? 0)) /
      1_000_000;

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      estimatedCost,
      currency: pricing.currency,
      source: 'local-estimate',
    };
  }

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
    currency: usage.currency,
    source: 'unavailable',
  };
}
