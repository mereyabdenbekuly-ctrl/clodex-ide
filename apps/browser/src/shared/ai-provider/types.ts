export const AI_PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'openrouter',
  'ollama',
  'openai-compatible',
  'clodex',
] as const;

export type AIProviderType = (typeof AI_PROVIDER_TYPES)[number];

export const AI_PROVIDER_PROTOCOLS = [
  'openai-responses',
  'openai-chat',
  'anthropic-messages',
  'ollama',
] as const;

export type AIProviderProtocol = (typeof AI_PROVIDER_PROTOCOLS)[number];

/**
 * Persisted provider configuration. Secrets are referenced by ID and must be
 * resolved by the backend credential service immediately before a request.
 */
export interface AIProviderConfig {
  id: string;
  providerType: AIProviderType;
  displayName: string;
  baseUrl?: string;
  apiKeyReference?: string;
  customHeaders?: Record<string, string>;
  protocol: AIProviderProtocol;
  enabled: boolean;
}

export interface AIModelCapabilities {
  text: boolean;
  images: boolean;
  streaming: boolean;
  functionTools: boolean;
  customTools: boolean;
  reasoning: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AIModelInfo {
  id: string;
  displayName: string;
  providerId: string;
  capabilities: AIModelCapabilities;
}

export function toQualifiedModelId(
  providerId: string,
  modelId: string,
): string {
  return `${providerId}:${modelId}`;
}

export interface ProviderValidationResult {
  success: boolean;
  status?: number;
  message?: string;
}

export interface AgentProviderRequest {
  modelId: string;
  messages: unknown[];
  tools?: unknown[];
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface AgentProviderResponse {
  content: unknown;
  usage?: ProviderUsage;
  providerMetadata?: Record<string, unknown>;
}

export type AgentProviderStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCall: unknown }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'finish'; finishReason?: string }
  | { type: 'error'; error: unknown };

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
}

export interface AIProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly type: AIProviderType;

  validate(config: AIProviderConfig): Promise<ProviderValidationResult>;
  listModels(config: AIProviderConfig): Promise<AIModelInfo[]>;
  createResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): Promise<AgentProviderResponse>;
  streamResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): AsyncIterable<AgentProviderStreamEvent>;
  normalizeError(error: unknown): import('./errors').ProviderError;
}
