import {
  normalizeProviderError,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentProviderStreamEvent,
  type AIModelInfo,
  type AIProviderAdapter,
  type AIProviderConfig,
  type AIProviderType,
  type ProviderUsage,
} from '@shared/ai-provider';

export type ProviderApiKeyResolver = (
  reference: string,
) => string | null | undefined;

export interface OpenAICompatibleAdapterOptions {
  id: string;
  name: string;
  type: AIProviderType;
  defaultBaseUrl: string;
  resolveApiKey: ProviderApiKeyResolver;
  fetch?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function toUsage(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  return {
    inputTokens:
      typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : typeof usage.input_tokens === 'number'
          ? usage.input_tokens
          : undefined,
    outputTokens:
      typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : typeof usage.output_tokens === 'number'
          ? usage.output_tokens
          : undefined,
    totalTokens:
      typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
    cost: typeof usage.cost === 'number' ? usage.cost : undefined,
    currency: typeof usage.currency === 'string' ? usage.currency : undefined,
  };
}

export class OpenAICompatibleProviderAdapter implements AIProviderAdapter {
  public readonly id: string;
  public readonly name: string;
  public readonly type: AIProviderType;
  private readonly defaultBaseUrl: string;
  private readonly resolveApiKey: ProviderApiKeyResolver;
  private readonly request: typeof fetch;

  public constructor(options: OpenAICompatibleAdapterOptions) {
    this.id = options.id;
    this.name = options.name;
    this.type = options.type;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.resolveApiKey = options.resolveApiKey;
    this.request = options.fetch ?? fetch;
  }

  public async validate(
    config: AIProviderConfig,
  ): Promise<{ success: boolean; status?: number; message?: string }> {
    try {
      const response = await this.request(
        joinUrl(this.baseUrl(config), 'models'),
        { headers: this.headers(config) },
      );
      return {
        success: response.ok,
        status: response.status,
        message: response.ok ? undefined : await response.text(),
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return {
        success: false,
        status: normalized.status,
        message: normalized.message,
      };
    }
  }

  public async listModels(config: AIProviderConfig): Promise<AIModelInfo[]> {
    const response = await this.request(
      joinUrl(this.baseUrl(config), 'models'),
      {
        headers: this.headers(config),
      },
    );
    if (!response.ok) throw await this.responseError(response);
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .filter((entry): entry is { id: string } => typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        displayName: entry.id,
        providerId: config.id,
        capabilities: {
          text: true,
          images: false,
          streaming: true,
          functionTools: true,
          customTools: true,
          reasoning: false,
        },
      }));
  }

  public async createResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): Promise<AgentProviderResponse> {
    const responsesProtocol = config.protocol === 'openai-responses';
    const response = await this.request(
      joinUrl(
        this.baseUrl(config),
        responsesProtocol ? 'responses' : 'chat/completions',
      ),
      {
        method: 'POST',
        headers: this.headers(config, true),
        body: JSON.stringify({
          model: request.modelId,
          ...(responsesProtocol
            ? { input: request.messages }
            : { messages: request.messages }),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.providerOptions ?? {}),
        }),
        signal: request.abortSignal,
      },
    );
    if (!response.ok) throw await this.responseError(response);
    const body = (await response.json()) as Record<string, unknown>;
    return {
      content: body.output ?? body.choices ?? body,
      usage: toUsage(body.usage),
      providerMetadata:
        body.provider_metadata &&
        typeof body.provider_metadata === 'object' &&
        !Array.isArray(body.provider_metadata)
          ? (body.provider_metadata as Record<string, unknown>)
          : undefined,
    };
  }

  public async *streamResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): AsyncIterable<AgentProviderStreamEvent> {
    const responsesProtocol = config.protocol === 'openai-responses';
    const response = await this.request(
      joinUrl(
        this.baseUrl(config),
        responsesProtocol ? 'responses' : 'chat/completions',
      ),
      {
        method: 'POST',
        headers: this.headers(config, true),
        body: JSON.stringify({
          model: request.modelId,
          stream: true,
          ...(responsesProtocol
            ? { input: request.messages }
            : { messages: request.messages }),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.providerOptions ?? {}),
        }),
        signal: request.abortSignal,
      },
    );
    if (!response.ok) throw await this.responseError(response);
    if (!response.body) throw new Error('Provider returned no response body.');

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const chunk = JSON.parse(data) as Record<string, unknown>;
        const delta =
          (
            chunk.choices as
              | Array<{ delta?: { content?: unknown } }>
              | undefined
          )?.[0]?.delta?.content ??
          (typeof chunk.delta === 'string' ? chunk.delta : undefined);
        if (typeof delta === 'string' && delta) {
          yield { type: 'text-delta', text: delta };
        }
        const usage = toUsage(chunk.usage);
        if (usage) yield { type: 'usage', usage };
      }
    }
    yield { type: 'finish' };
  }

  public normalizeError(error: unknown) {
    return normalizeProviderError(error);
  }

  private baseUrl(config: AIProviderConfig): string {
    return config.baseUrl?.trim() || this.defaultBaseUrl;
  }

  private headers(
    config: AIProviderConfig,
    json = false,
  ): Record<string, string> {
    const apiKey = config.apiKeyReference
      ? this.resolveApiKey(config.apiKeyReference)
      : undefined;
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(config.customHeaders ?? {}),
    };
  }

  private async responseError(
    response: Response,
  ): Promise<Error & { status: number }> {
    const body = await response.text().catch(() => '');
    return Object.assign(
      new Error(
        body.slice(0, 1_000) || `Provider returned HTTP ${response.status}.`,
      ),
      { status: response.status },
    );
  }
}
