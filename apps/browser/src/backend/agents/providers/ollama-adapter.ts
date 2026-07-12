import {
  normalizeProviderError,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentProviderStreamEvent,
  type AIModelInfo,
  type AIProviderAdapter,
  type AIProviderConfig,
} from '@shared/ai-provider';

function baseUrl(config: AIProviderConfig): string {
  return (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
}

export class OllamaProviderAdapter implements AIProviderAdapter {
  public readonly id = 'ollama';
  public readonly name = 'Ollama';
  public readonly type = 'ollama' as const;

  public constructor(private readonly request: typeof fetch = fetch) {}

  public async validate(config: AIProviderConfig) {
    try {
      const response = await this.request(`${baseUrl(config)}/api/tags`);
      return { success: response.ok, status: response.status };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return { success: false, message: normalized.message };
    }
  }

  public async listModels(config: AIProviderConfig): Promise<AIModelInfo[]> {
    const response = await this.request(`${baseUrl(config)}/api/tags`);
    if (!response.ok) {
      throw Object.assign(
        new Error(`Ollama returned HTTP ${response.status}.`),
        {
          status: response.status,
        },
      );
    }
    const body = (await response.json()) as {
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    return (body.models ?? [])
      .map((model) =>
        typeof model.name === 'string'
          ? model.name
          : typeof model.model === 'string'
            ? model.model
            : null,
      )
      .filter((model): model is string => Boolean(model))
      .map((model) => ({
        id: model,
        displayName: model,
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
    const response = await this.request(`${baseUrl(config)}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.customHeaders ?? {}),
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        tools: request.tools,
        stream: false,
        options: request.providerOptions,
      }),
      signal: request.abortSignal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(await response.text()), {
        status: response.status,
      });
    }
    const body = (await response.json()) as Record<string, unknown>;
    return {
      content: body.message ?? body.response ?? body,
      usage: {
        inputTokens:
          typeof body.prompt_eval_count === 'number'
            ? body.prompt_eval_count
            : undefined,
        outputTokens:
          typeof body.eval_count === 'number' ? body.eval_count : undefined,
      },
    };
  }

  public async *streamResponse(
    request: AgentProviderRequest,
    config: AIProviderConfig,
  ): AsyncIterable<AgentProviderStreamEvent> {
    const response = await this.request(`${baseUrl(config)}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.customHeaders ?? {}),
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        tools: request.tools,
        stream: true,
        options: request.providerOptions,
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
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as {
          message?: { content?: unknown };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        if (typeof chunk.message?.content === 'string') {
          yield { type: 'text-delta', text: chunk.message.content };
        }
        if (chunk.done) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.prompt_eval_count,
              outputTokens: chunk.eval_count,
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
