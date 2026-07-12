import {
  normalizeProviderError,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentProviderStreamEvent,
  type AIModelInfo,
  type AIProviderAdapter,
  type AIProviderConfig,
} from '@shared/ai-provider';
import type { ProviderApiKeyResolver } from './openai-compatible-adapter';

function baseUrl(config: AIProviderConfig): string {
  return (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
}

export class AnthropicProviderAdapter implements AIProviderAdapter {
  public readonly id = 'anthropic';
  public readonly name = 'Anthropic';
  public readonly type = 'anthropic' as const;

  public constructor(
    private readonly resolveApiKey: ProviderApiKeyResolver,
    private readonly request: typeof fetch = fetch,
  ) {}

  private headers(config: AIProviderConfig): Record<string, string> {
    const apiKey = config.apiKeyReference
      ? this.resolveApiKey(config.apiKeyReference)
      : undefined;
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(config.customHeaders ?? {}),
    };
  }

  public async validate(config: AIProviderConfig) {
    try {
      const response = await this.request(`${baseUrl(config)}/models?limit=1`, {
        headers: this.headers(config),
      });
      return {
        success: response.ok,
        status: response.status,
        message: response.ok ? undefined : await response.text(),
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return { success: false, message: normalized.message };
    }
  }

  public async listModels(config: AIProviderConfig): Promise<AIModelInfo[]> {
    const response = await this.request(`${baseUrl(config)}/models`, {
      headers: this.headers(config),
    });
    if (!response.ok) {
      throw Object.assign(new Error(await response.text()), {
        status: response.status,
      });
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; display_name?: unknown }>;
    };
    return (body.data ?? [])
      .filter(
        (model): model is { id: string; display_name?: unknown } =>
          typeof model.id === 'string',
      )
      .map((model) => ({
        id: model.id,
        displayName:
          typeof model.display_name === 'string'
            ? model.display_name
            : model.id,
        providerId: config.id,
        capabilities: {
          text: true,
          images: true,
          streaming: true,
          functionTools: true,
          customTools: true,
          reasoning: true,
        },
      }));
  }

  public async createResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): Promise<AgentProviderResponse> {
    const response = await this.request(`${baseUrl(config)}/messages`, {
      method: 'POST',
      headers: this.headers(config),
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        tools: request.tools,
        max_tokens: 4096,
        ...(request.providerOptions ?? {}),
      }),
      signal: request.abortSignal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(await response.text()), {
        status: response.status,
      });
    }
    const body = (await response.json()) as Record<string, unknown>;
    const usage =
      body.usage && typeof body.usage === 'object'
        ? (body.usage as Record<string, unknown>)
        : {};
    return {
      content: body.content ?? body,
      usage: {
        inputTokens:
          typeof usage.input_tokens === 'number'
            ? usage.input_tokens
            : undefined,
        outputTokens:
          typeof usage.output_tokens === 'number'
            ? usage.output_tokens
            : undefined,
      },
    };
  }

  public async *streamResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): AsyncIterable<AgentProviderStreamEvent> {
    const response = await this.request(`${baseUrl(config)}/messages`, {
      method: 'POST',
      headers: this.headers(config),
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        tools: request.tools,
        max_tokens: 4096,
        stream: true,
        ...(request.providerOptions ?? {}),
      }),
      signal: request.abortSignal,
    });
    if (!response.ok || !response.body) {
      throw Object.assign(new Error(await response.text()), {
        status: response.status,
      });
    }
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
        if (!data) continue;
        const event = JSON.parse(data) as {
          delta?: { text?: unknown };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (typeof event.delta?.text === 'string') {
          yield { type: 'text-delta', text: event.delta.text };
        }
        if (event.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
            },
          };
        }
      }
    }
    yield { type: 'finish' };
  }

  public normalizeError(error: unknown) {
    return normalizeProviderError(error);
  }
}
