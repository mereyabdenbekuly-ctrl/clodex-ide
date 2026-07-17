import type {
  ModelThinkingOverride,
  ProviderEndpointMode,
  UserPreferences,
} from '@shared/karton-contracts/ui/shared-types';
import { isGpt56UltraThinkingSelected } from '@shared/model-thinking-capabilities';

export type SubmitSwarmRoute = {
  enabled: boolean;
  variant: 'standard' | 'battle';
  automaticUltra: boolean;
};

export function getThinkingOverrideModelId(
  activeModelId: string | null | undefined,
): string | null {
  if (!activeModelId) return null;
  const separator = activeModelId.indexOf(':');
  return separator > 0 ? activeModelId.slice(separator + 1) : activeModelId;
}

export function getModelThinkingOverride(
  overrides: Record<string, ModelThinkingOverride>,
  activeModelId: string | null | undefined,
): ModelThinkingOverride | undefined {
  if (!activeModelId) return undefined;
  if (Object.hasOwn(overrides, activeModelId)) {
    return overrides[activeModelId];
  }

  const rawModelId = getThinkingOverrideModelId(activeModelId);
  return rawModelId && rawModelId !== activeModelId
    ? overrides[rawModelId]
    : undefined;
}

export function getThinkingOverrideStorageKey(
  activeModelId: string | null | undefined,
): string | null {
  return activeModelId ?? null;
}

export function getActiveGptThinkingProviderMode(
  activeModelId: string | null | undefined,
  preferences: Pick<
    UserPreferences,
    | 'providerProfiles'
    | 'defaultProviderProfileId'
    | 'providerConfigs'
    | 'customModels'
    | 'customEndpoints'
  >,
): ProviderEndpointMode | undefined {
  const separator = activeModelId?.indexOf(':') ?? -1;
  if (separator > 0) {
    const qualifiedProfileId = activeModelId?.slice(0, separator);
    const qualifiedProfile = preferences.providerProfiles.find(
      (profile) => profile.id === qualifiedProfileId && profile.enabled,
    );
    if (qualifiedProfile?.providerType === 'clodex') return 'clodex';
    if (qualifiedProfile?.providerType === 'openai') {
      return qualifiedProfile.protocol === 'openai-responses'
        ? 'official'
        : 'custom';
    }
    return undefined;
  }

  const legacyCustomModel = preferences.customModels.find(
    (model) => model.modelId === activeModelId,
  );
  if (legacyCustomModel) {
    if (legacyCustomModel.endpointId === 'openai') return 'official';
    const endpoint = preferences.customEndpoints.find(
      (candidate) => candidate.id === legacyCustomModel.endpointId,
    );
    // `official` here means native OpenAI Responses effort semantics for
    // Ultra routing. The endpoint itself remains a user-managed custom route.
    return endpoint?.apiSpec === 'openai-responses' ? 'official' : 'custom';
  }

  const activeProfile = preferences.providerProfiles.find(
    (profile) =>
      profile.id === preferences.defaultProviderProfileId && profile.enabled,
  );
  if (activeProfile?.providerType === 'clodex') return 'clodex';
  if (activeProfile?.providerType === 'openai') {
    return activeProfile.protocol === 'openai-responses'
      ? 'official'
      : 'custom';
  }
  if (activeProfile) return undefined;

  const openAiConfig = preferences.providerConfigs.openai;
  if (openAiConfig.mode !== 'custom') return openAiConfig.mode;
  const endpoint = preferences.customEndpoints.find(
    (candidate) => candidate.id === openAiConfig.customProviderId,
  );
  return endpoint?.apiSpec === 'openai-responses' ? 'official' : 'custom';
}

export function resolveSubmitSwarmRoute({
  modelId,
  override,
  providerMode,
  manualModeActive,
  manualModeVariant,
  executionTarget,
}: {
  modelId: string | null | undefined;
  override: ModelThinkingOverride | undefined;
  providerMode: ProviderEndpointMode | undefined;
  manualModeActive: boolean;
  manualModeVariant: 'standard' | 'battle' | null;
  executionTarget?: 'local' | 'cloud';
}): SubmitSwarmRoute {
  if (executionTarget === 'cloud') {
    return {
      enabled: false,
      variant: 'standard',
      automaticUltra: false,
    };
  }

  const automaticUltra = isGpt56UltraThinkingSelected({
    modelId,
    override,
    providerMode,
  });

  return {
    enabled: manualModeActive || automaticUltra,
    variant: manualModeActive ? (manualModeVariant ?? 'standard') : 'standard',
    automaticUltra,
  };
}
