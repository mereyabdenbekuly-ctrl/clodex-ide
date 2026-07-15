import { createAnthropic } from '@ai-sdk/anthropic';
import type { streamText } from 'ai';
import type { HostModels } from '@clodex/agent-core/host';
import type { ModelCapabilities } from '@clodex/agent-core/types/models';
import { modelCapabilitiesSchema } from '@clodex/agent-core/types/models';

const DEFAULT_CAPABILITIES: ModelCapabilities = modelCapabilitiesSchema.parse({
  toolCalling: true,
});

export interface CliHostModelOptions {
  readonly apiKey?: string;
}

export function createCliHostModels(
  defaultModelId: string,
  options: CliHostModelOptions = {},
): HostModels {
  const normalizedDefaultModelId = defaultModelId.trim();
  if (normalizedDefaultModelId.length === 0) {
    throw new Error('A non-empty default Anthropic model id is required');
  }
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const anthropic = createAnthropic({ apiKey });

  return {
    async getWithOptions(modelId: string, _traceId: string) {
      const id = modelId.trim() || normalizedDefaultModelId;
      const model = anthropic(id);
      return {
        model,
        providerOptions: {} as Parameters<
          typeof streamText
        >[0]['providerOptions'],
        headers: {},
        contextWindowSize: 200_000,
        providerMode: 'official' as const,
        stripStrictFromTools: false,
      };
    },

    async get(modelId: string, traceId: string) {
      return (await this.getWithOptions(modelId, traceId)).model;
    },

    has() {
      return true;
    },

    getCapabilities(_modelId: string): ModelCapabilities {
      return DEFAULT_CAPABILITIES;
    },
  };
}
