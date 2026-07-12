import type { JSONObject, SharedV3ProviderMetadata } from '@ai-sdk/provider';
import {
  createOpenAICompatible,
  type MetadataExtractor,
  type OpenAICompatibleProvider,
} from '@ai-sdk/openai-compatible';
import { deepMergeProviderOptions } from './model-provider';

declare const __APP_VERSION__: string;

/**
 * Creates a fetch wrapper that attaches the clodex client identifier
 * header for observability / request logging on the API server.
 */
function createClientFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Clodex-Client', `electron/${__APP_VERSION__}`);
    return globalThis.fetch(input, {
      ...init,
      headers,
      body: sanitizeClodexRequestBody(init?.body),
    });
  };
}

/**
 * Last-line validation for requests sent to the Clodex gateway.
 *
 * Some catalog entries and older persisted provider options still contain the
 * OpenRouter-style `reasoning.enabled` field. The Clodex API accepts
 * `reasoning.effort` but rejects `reasoning.enabled`, so strip it from the
 * actual serialized HTTP body even if an upstream merge reintroduces it.
 */
export function sanitizeClodexRequestBody(
  body: BodyInit | null | undefined,
): BodyInit | null | undefined {
  if (typeof body !== 'string') return body;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return body;
    }

    const request = parsed as Record<string, unknown>;
    const reasoning = request.reasoning;
    if (
      reasoning == null ||
      typeof reasoning !== 'object' ||
      Array.isArray(reasoning) ||
      !('enabled' in reasoning)
    ) {
      return body;
    }

    const { enabled: _enabled, ...safeReasoning } = reasoning as Record<
      string,
      unknown
    >;
    if (Object.keys(safeReasoning).length === 0) {
      delete request.reasoning;
    } else {
      request.reasoning = safeReasoning;
    }
    return JSON.stringify(request);
  } catch {
    return body;
  }
}

/**
 * One reasoning-details entry as emitted by OpenRouter.
 * The exact field set is provider-defined — we keep the shape loose so
 * unknown keys are preserved verbatim for forward compatibility
 * (new Anthropic/Google fields, etc.).
 *
 * Common fields we round-trip today:
 *  - Anthropic: `{ type: 'reasoning.text', text, signature }`
 *  - Google:    `{ type: 'reasoning.text' | 'reasoning.encrypted',
 *                  text?, format?, thought_signature? }`
 */
export type ClodexReasoningDetail = Record<string, unknown>;

/**
 * Typed shape of the `providerMetadata` the clodex extractor emits.
 * Kept in sync with what `base-agent` consumes in
 * `populateReasoningDetailsOnAssistantMessage`.
 */
export type ClodexProviderMetadata = {
  openaiCompatible?: {
    reasoningDetails?: ClodexReasoningDetail[];
  };
  clodex?: Record<string, unknown>;
};

type RecordOrUndefined = Record<string, unknown> | undefined;

/**
 * Merge a single incoming reasoning-details chunk into the accumulated
 * entry at the same index.
 *
 *  - `text` is concatenated (streaming deltas arrive split into chunks).
 *  - Every other field (`type`, `signature`, `thought_signature`,
 *    `format`, and any unknown keys) is overwritten with the incoming
 *    value if it is non-null/non-undefined; otherwise the existing value
 *    is kept. This matches how OR streams the fields: the signature
 *    arrives once on a terminal chunk while earlier chunks carry only
 *    text deltas.
 *
 * Exported so it can be unit-tested independently of the streaming
 * extractor and re-used elsewhere if needed.
 */
export function mergeReasoningDetailChunk(
  acc: ClodexReasoningDetail | undefined,
  incoming: Record<string, unknown>,
): ClodexReasoningDetail {
  const base: ClodexReasoningDetail = { ...(acc ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'index') continue;
    if (key === 'text') {
      if (typeof value === 'string' && value.length > 0) {
        const prev = typeof base.text === 'string' ? base.text : '';
        base.text = prev + value;
      }
      continue;
    }
    if (value != null) {
      base[key] = value;
    }
  }
  return base;
}

/**
 * Read reasoning_details array from a non-streaming response message.
 * Tolerant of the field being absent or a non-array value.
 */
function extractReasoningDetailsFromMessage(
  message: RecordOrUndefined,
): ClodexReasoningDetail[] | undefined {
  const details = message?.reasoning_details;
  if (!Array.isArray(details) || details.length === 0) return undefined;
  return details.filter(
    (entry): entry is ClodexReasoningDetail =>
      entry != null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

/**
 * Metadata extractor for the clodex / OpenRouter gateway.
 *
 * Captures two things:
 *
 *  1. `openaiCompatible.reasoningDetails` — the provider-signed
 *     reasoning details array OR returns on the response. Required for
 *     Anthropic (Bedrock) and Google models to validate chain-of-thought
 *     signatures on subsequent turns. The SDK does not map this field
 *     natively (see vercel/ai#11342), so we capture it here. The key is
 *     the transport hook, not the semantic owner; `base-agent` stores the
 *     current route alongside these details and only re-injects matching
 *     groups via `providerOptions.openaiCompatible` on future requests.
 *
 *  2. `clodex` — any `provider_metadata` riding on the response
 *     message/delta. Preserved as-is for existing usage-limit/plan
 *     metadata flows that read from this key.
 */
const clodexMetadataExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => {
    const body = parsedBody as RecordOrUndefined;
    const choices = body?.choices as unknown[] | undefined;
    const firstChoice = choices?.[0] as RecordOrUndefined;
    const message = firstChoice?.message as RecordOrUndefined;

    const out: SharedV3ProviderMetadata = {};

    const reasoningDetails = extractReasoningDetailsFromMessage(message);
    if (reasoningDetails && reasoningDetails.length > 0) {
      out.openaiCompatible = {
        reasoningDetails: reasoningDetails as unknown as JSONObject[],
      } as JSONObject;
    }

    // Spread `provider_metadata` keys at the root — the gateway already
    // emits `{ clodex: {...} }` (and potentially other provider keys),
    // so the SharedV3ProviderMetadata shape is identical to what the
    // server sends. The streaming path does the same; any asymmetry
    // between the two would quietly break consumers that read
    // `providerMetadata.clodex.<...>` on non-streaming responses.
    const clodexPassthrough = message?.provider_metadata as
      | Record<string, unknown>
      | undefined;
    if (clodexPassthrough != null) {
      for (const [key, value] of Object.entries(clodexPassthrough)) {
        if (value != null) out[key] = value as JSONObject;
      }
    }

    return Object.keys(out).length > 0 ? out : undefined;
  },
  createStreamExtractor: () => {
    const byIndex = new Map<number, ClodexReasoningDetail>();
    const clodexPassthrough: SharedV3ProviderMetadata = {};

    return {
      processChunk(parsedChunk: unknown) {
        const chunk = parsedChunk as RecordOrUndefined;
        const choices = chunk?.choices as unknown[] | undefined;
        const firstChoice = choices?.[0] as RecordOrUndefined;
        const delta = firstChoice?.delta as RecordOrUndefined;
        if (!delta) return;

        // ── 1. reasoning_details[] accumulation ───────────────────────
        const reasoningDetails = delta.reasoning_details as
          | unknown[]
          | undefined;
        if (Array.isArray(reasoningDetails)) {
          for (const entry of reasoningDetails) {
            if (entry == null || typeof entry !== 'object') continue;
            const record = entry as Record<string, unknown>;
            const idx = record.index;
            if (typeof idx !== 'number') continue;
            byIndex.set(
              idx,
              mergeReasoningDetailChunk(byIndex.get(idx), record),
            );
          }
        }

        // ── 2. `clodex` passthrough (deep-merged) ──────────────────
        const chunkClodex = delta.provider_metadata as
          | Record<string, unknown>
          | undefined;
        if (chunkClodex) {
          for (const [key, value] of Object.entries(chunkClodex)) {
            const current = clodexPassthrough[key];
            if (
              value != null &&
              typeof value === 'object' &&
              typeof current === 'object'
            ) {
              clodexPassthrough[key] = deepMergeProviderOptions(
                current as JSONObject,
                value as JSONObject,
              ) as JSONObject;
            } else if (value != null) {
              clodexPassthrough[key] = value as JSONObject;
            } else if (value == null) {
              delete clodexPassthrough[key];
            }
          }
        }
      },
      buildMetadata: () => {
        const out: SharedV3ProviderMetadata = {};

        if (byIndex.size > 0) {
          const sorted = [...byIndex.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);
          out.openaiCompatible = {
            reasoningDetails: sorted as unknown as JSONObject[],
          } as JSONObject;
        }

        for (const [key, value] of Object.entries(clodexPassthrough)) {
          out[key] = value;
        }

        return out;
      },
    };
  },
};

export type ClodexProviderSettings = {
  apiKey: string;
  baseURL: string;
};

/**
 * Create a clodex gateway provider that uses OpenAI-compatible
 * chat completions endpoints.
 *
 * Provider options are forwarded under the `clodex` key and
 * response metadata is extracted from gateway responses.
 *
 * Message-level metadata (e.g. `cache_control`, signed
 * `reasoning_details`) is forwarded via the built-in
 * `openaiCompatible` providerOptions transport key which the SDK spreads
 * directly onto each message in the request body. Semantic ownership for
 * signed reasoning details is tracked separately in assistant metadata.
 */
export function createClodex(
  settings: ClodexProviderSettings,
): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: 'clodex',
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    fetch: createClientFetch(),
    metadataExtractor: clodexMetadataExtractor,
    includeUsage: true,
    supportsStructuredOutputs: true,
  });
}
