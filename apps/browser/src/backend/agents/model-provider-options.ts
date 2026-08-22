import {
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
} from '@clodex/agent-core/host';
import type {
  ApiSpec,
  ModelProvider,
  ModelThinkingOverride,
} from '@shared/karton-contracts/ui/shared-types';
import { createThinkingProviderOptionsPatch } from '@shared/model-thinking-capabilities';
import type { ProviderMode } from './reasoning-signatures';
import type {
  ProviderOptions,
  ThinkingModelSettings,
} from './model-provider-types';

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively deep-merges multiple plain objects. Later sources win on
 * primitive conflicts; nested objects are merged recursively.
 *
 * Exported so call-sites (streamText / generateText) can layer overrides:
 * ```ts
 * streamText({
 *   providerOptions: deepMergeProviderOptions(
 *     modelWithOptions.providerOptions,
 *     { anthropic: { thinking: { type: 'disabled' } } },
 *   ),
 * })
 * ```
 */
export function deepMergeProviderOptions(
  ...sources: (Record<string, unknown> | undefined | null)[]
): ProviderOptions {
  const result: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        delete result[key];
      } else if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = deepMergeProviderOptions(
          result[key] as Record<string, unknown>,
          value,
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result as ProviderOptions;
}

export function sanitizeClodexProviderOptions(
  providerOptions: ProviderOptions,
): ProviderOptions {
  if (!providerOptions || typeof providerOptions !== 'object') {
    return providerOptions;
  }

  const clodex = providerOptions.clodex;
  if (!isPlainObject(clodex)) return providerOptions;
  const reasoning = clodex.reasoning;
  if (!isPlainObject(reasoning) || !('enabled' in reasoning)) {
    return providerOptions;
  }

  const { enabled: _enabled, ...safeReasoning } = reasoning;
  return {
    ...providerOptions,
    clodex: {
      ...clodex,
      ...(Object.keys(safeReasoning).length > 0
        ? { reasoning: safeReasoning }
        : { reasoning: undefined }),
    },
  } as ProviderOptions;
}

type ThinkingProviderOptionsInput = {
  baseProviderOptions: Record<string, unknown>;
  modelSettings: ThinkingModelSettings;
  override?: ModelThinkingOverride;
  providerMode: ProviderMode;
  semanticProvider: ModelProvider;
  customEndpointApiSpec?: ApiSpec;
  requestMetadata?: Record<string, unknown>;
};

export function resolveThinkingProviderOptions({
  baseProviderOptions,
  modelSettings,
  override,
  providerMode,
  semanticProvider,
  customEndpointApiSpec,
  requestMetadata,
}: ThinkingProviderOptionsInput): ProviderOptions {
  if (requestMetadata?.[MODEL_REQUEST_PURPOSE_METADATA_KEY] !== 'agent-step') {
    return baseProviderOptions as ProviderOptions;
  }

  if (!modelSettings.thinkingEnabled || !override) {
    return baseProviderOptions as ProviderOptions;
  }

  const patch = createThinkingProviderOptionsPatch({
    model: modelSettings,
    override,
    route: {
      providerMode,
      modelProvider: semanticProvider,
      customEndpointApiSpec,
    },
  });

  if (!patch) return baseProviderOptions as ProviderOptions;

  return deepMergeProviderOptions(baseProviderOptions, patch);
}

export function omitModelRequestMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (
    !metadata ||
    (!(MODEL_REQUEST_PURPOSE_METADATA_KEY in metadata) &&
      !(MODEL_TASK_ROLE_METADATA_KEY in metadata))
  ) {
    return metadata;
  }

  const {
    [MODEL_REQUEST_PURPOSE_METADATA_KEY]: _purpose,
    [MODEL_TASK_ROLE_METADATA_KEY]: _taskRole,
    ...telemetry
  } = metadata;
  return telemetry;
}
