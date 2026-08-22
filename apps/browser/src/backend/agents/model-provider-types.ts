import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { streamText } from 'ai';
import type { availableModels } from '@shared/available-models';
import type { ReasoningSignatureSource } from '@shared/karton-contracts/ui/agent/metadata';
import type { ThinkingCapableModel } from '@shared/model-thinking-capabilities';
import type { AuthState } from '@/services/auth';
import type { ProviderMode } from './reasoning-signatures';

export type ProviderOptions = Parameters<
  typeof streamText
>[0]['providerOptions'];
export type BuiltInModelSettings = (typeof availableModels)[number];
export type ThinkingModelSettings = ThinkingCapableModel;
export type ClodexAuthModel = NonNullable<AuthState['models']>[number];
export type ManagedCredentialState = { rejected: boolean };

export type ModelWithOptions = {
  model: LanguageModelV3;
  providerOptions: Parameters<typeof streamText>[0]['providerOptions'];
  headers: Record<string, string>;
  contextWindowSize: number;
  providerMode: ProviderMode;
  connectedCodingPlanId?: string;
  reasoningSignatureSource: ReasoningSignatureSource;
  /**
   * When true, the agent must strip the `strict` field from every tool
   * definition before passing them to `streamText`. Required for providers
   * whose backend rejects unknown fields on the tool payload — notably
   * Bedrock-on-Anthropic, where `strict` surfaces as
   * `tools.0.custom.strict: Extra inputs are not permitted`.
   */
  stripStrictFromTools?: boolean;
  routeLease?: {
    isValid(): boolean;
    forkTrace?(
      traceId: string,
      metadata?: Record<string, unknown>,
    ): ModelWithOptions;
  };
};

export interface OfficialOpenAIRealtimeEndpoint {
  apiKey: string;
  baseURL: 'https://api.openai.com/v1';
}
