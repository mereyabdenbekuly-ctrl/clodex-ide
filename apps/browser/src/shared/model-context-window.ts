import { getAvailableModel } from './available-models';

type ProviderProfileLike = {
  id: string;
  providerType?: string;
};

type ProviderCatalogModelLike = {
  id: string;
  capabilities?: {
    contextWindow?: number;
  };
};

type ClodexModelLike = {
  id: string;
  contextWindow?: number;
};

type CustomModelLike = {
  modelId: string;
  contextWindowSize: number;
};

export type ModelContextWindowSource =
  | 'clodex-account'
  | 'provider-catalog'
  | 'built-in'
  | 'custom-model';

export type ModelContextWindowResolution = {
  tokens: number;
  source: ModelContextWindowSource;
};

export type ResolveModelContextWindowInput = {
  modelId: string;
  providerProfiles?: readonly ProviderProfileLike[];
  providerModelCatalogs?: Readonly<
    Record<string, readonly ProviderCatalogModelLike[] | undefined>
  >;
  clodexModels?: readonly ClodexModelLike[];
  customModels?: readonly CustomModelLike[];
};

export function parseProviderQualifiedModelId(
  value: string,
): { providerProfileId: string; modelId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    providerProfileId: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export function formatModelContextWindow(contextWindow?: number): string {
  const normalized = normalizeContextWindow(contextWindow);
  return normalized === undefined
    ? 'Context unknown'
    : `${Math.round(normalized / 1000)}k context`;
}

/**
 * Resolve the context window from authoritative runtime metadata before
 * falling back to the static built-in catalog. Unknown models intentionally
 * return `undefined`: callers may use a conservative internal budget, but the
 * UI must not present that budget as a provider-declared model capability.
 */
export function resolveModelContextWindow({
  modelId,
  providerProfiles = [],
  providerModelCatalogs = {},
  clodexModels = [],
  customModels = [],
}: ResolveModelContextWindowInput): ModelContextWindowResolution | undefined {
  const qualified = parseProviderQualifiedModelId(modelId);

  if (qualified) {
    const profile = providerProfiles.find(
      (candidate) => candidate.id === qualified.providerProfileId,
    );

    if (profile?.providerType === 'clodex') {
      const accountContext = normalizeContextWindow(
        findModelById(clodexModels, qualified.modelId)?.contextWindow,
      );
      if (accountContext !== undefined) {
        return { tokens: accountContext, source: 'clodex-account' };
      }
    }

    const catalogContext = normalizeContextWindow(
      findModelById(
        providerModelCatalogs[qualified.providerProfileId] ?? [],
        qualified.modelId,
      )?.capabilities?.contextWindow,
    );
    if (catalogContext !== undefined) {
      return { tokens: catalogContext, source: 'provider-catalog' };
    }

    const builtInContext = getBuiltInContextWindow(qualified.modelId);
    return builtInContext === undefined
      ? undefined
      : { tokens: builtInContext, source: 'built-in' };
  }

  const accountContext = normalizeContextWindow(
    findModelById(clodexModels, modelId)?.contextWindow,
  );
  if (accountContext !== undefined) {
    return { tokens: accountContext, source: 'clodex-account' };
  }

  const builtInContext = getBuiltInContextWindow(modelId);
  if (builtInContext !== undefined) {
    return { tokens: builtInContext, source: 'built-in' };
  }

  const customContext = normalizeContextWindow(
    customModels.find((model) => model.modelId === modelId)?.contextWindowSize,
  );
  return customContext === undefined
    ? undefined
    : { tokens: customContext, source: 'custom-model' };
}

function normalizeContextWindow(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function getBareModelId(modelId: string): string {
  return modelId.split('/').pop() ?? modelId;
}

function getBuiltInContextWindow(modelId: string): number | undefined {
  return normalizeContextWindow(
    (getAvailableModel(modelId) ?? getAvailableModel(getBareModelId(modelId)))
      ?.modelContextRaw,
  );
}

function findModelById<T extends { id: string }>(
  models: readonly T[],
  modelId: string,
): T | undefined {
  const exact = models.find((model) => model.id === modelId);
  if (exact) return exact;

  const bareModelId = getBareModelId(modelId);
  const bareMatches = models.filter(
    (model) => getBareModelId(model.id) === bareModelId,
  );
  return bareMatches.length === 1 ? bareMatches[0] : undefined;
}
