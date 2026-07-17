import { supportsNativeThinkingProviderProfile } from '@shared/model-thinking-capabilities';
import type { ModelForThinking } from '@ui/utils/model-thinking';

export type QualifiedBuiltInThinkingPresentation = {
  thinkingLabel: string | undefined;
  thinkingModel: ModelForThinking | undefined;
  thinkingOverrideKey: string | undefined;
};

export function getQualifiedBuiltInThinkingPresentation({
  profileProviderType,
  qualifiedModelId,
  thinkingEnabled,
  thinkingLabel,
  computedThinkingLabel,
  isAlias,
  thinkingModel,
}: {
  profileProviderType: string;
  qualifiedModelId: string;
  thinkingEnabled: boolean;
  thinkingLabel: string | undefined;
  computedThinkingLabel: string | undefined;
  isAlias: boolean | undefined;
  thinkingModel: ModelForThinking | undefined;
}): QualifiedBuiltInThinkingPresentation {
  if (!supportsNativeThinkingProviderProfile(profileProviderType)) {
    return {
      thinkingLabel: thinkingEnabled ? 'Reasoning' : undefined,
      thinkingModel: undefined,
      thinkingOverrideKey: undefined,
    };
  }

  return {
    thinkingLabel: isAlias ? thinkingLabel : computedThinkingLabel,
    thinkingModel,
    thinkingOverrideKey: thinkingModel ? qualifiedModelId : undefined,
  };
}
