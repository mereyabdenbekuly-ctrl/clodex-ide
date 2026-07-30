import { generateText, type UITools } from 'ai';
import type { AgentMessage } from '../../../types/agent';
import type { AgentHost } from '../../../host/host';
import {
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  type HostModels,
} from '../../../host/models';

/**
 * Wide AgentMessage type accepting any tool set and any metadata shape.
 * See `serialization.ts` for the rationale — this module mirrors the
 * same widening so host-side message shapes (browser, CLI) can be
 * passed in without TypeScript variance issues.
 */
type WideAgentMessage = AgentMessage<UITools, any>;

// Import for local use + re-export so existing imports keep working.
import {
  convertAgentMessagesToCompactMessageHistoryString,
  estimateMessageTokens,
} from './serialization';
export {
  convertAgentMessagesToCompactMessageHistoryString,
  estimateMessageTokens,
};

// Re-export prompt pieces so existing imports from this module keep working.
import {
  COMPRESSION_SYSTEM_PROMPT,
  COMPRESSION_TARGET_CHARS,
  buildCompressionUserMessage,
} from './prompt';
export {
  COMPRESSION_SYSTEM_PROMPT,
  COMPRESSION_TARGET_CHARS,
  buildCompressionUserMessage,
};

// Typed builder for host-side tool part serializer registries.
export {
  defineToolPartSerializers,
  type TypedToolPartSerializers,
} from './define-tool-part-serializers';

/**
 * Ordered list of model IDs to try for history compression.
 * The first model is the primary; subsequent entries are fallbacks
 * tried in order when the previous one fails or times out.
 */
const HISTORY_COMPRESSION_MODELS = [
  'gemini-3.1-flash-lite',
  'gpt-5.4-nano',
  'claude-haiku-4.5',
] as const;

/** Maximum time (ms) allowed for a single history compression attempt. */
const HISTORY_COMPRESSION_TIMEOUT_MS = 75_000;

/**
 * Hard wall-clock budget across preferred models and the active-model
 * fallback. A provider outage must not hold the post-step admission barrier
 * indefinitely.
 */
const HISTORY_COMPRESSION_TOTAL_BUDGET_MS = 150_000;

/**
 * 30k target characters are roughly 7.5k tokens for typical briefing text.
 * Align the request ceiling with that target instead of inviting the old
 * 20k-token response, while retaining the established memory-fidelity budget.
 */
const HISTORY_COMPRESSION_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Grace period after aborting a timed-out compression request.
 *
 * If the provider/SDK does not settle the original request within this
 * window, stop the cascade instead of starting overlapping fallback
 * requests that can continue billing in the background.
 */
const HISTORY_COMPRESSION_ABORT_GRACE_MS = 2_000;

/** Minimum acceptable compression length; shorter results trigger a fallback. */
const COMPRESSION_MIN_LENGTH = 30;

export class HistoryCompressionUnsettledTimeoutError extends Error {
  constructor(modelId: string) {
    super(
      `History compression request for ${modelId} timed out and did not settle after abort`,
    );
    this.name = 'HistoryCompressionUnsettledTimeoutError';
  }
}

class HistoryCompressionTimeoutError extends Error {
  constructor(modelId: string, timeoutMs: number) {
    super(
      `History compression request for ${modelId} timed out after ${timeoutMs}ms`,
    );
    this.name = 'HistoryCompressionTimeoutError';
  }
}

class HistoryCompressionBudgetExceededError extends Error {
  constructor() {
    super(
      `History compression exhausted its ${HISTORY_COMPRESSION_TOTAL_BUDGET_MS}ms total generation budget`,
    );
    this.name = 'HistoryCompressionBudgetExceededError';
  }
}

function getExternalAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('History compression was aborted', 'AbortError');
}

function throwIfExternallyAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw getExternalAbortError(signal);
}

function asProviderRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Compression is summarization, not deliberation. Remove catalog/user
 * reasoning budgets so they cannot consume the bounded generation window
 * before any briefing text is emitted.
 */
function compressionProviderOptions(
  base: Parameters<typeof generateText>[0]['providerOptions'],
): Parameters<typeof generateText>[0]['providerOptions'] {
  const root = asProviderRecord(base);
  const { reasoning: _clodexReasoning, ...clodex } = asProviderRecord(
    root.clodex,
  );
  const {
    reasoningEffort: _openaiReasoningEffort,
    reasoningSummary: _openaiReasoningSummary,
    ...openai
  } = asProviderRecord(root.openai);
  const { thinkingConfig: _googleThinkingConfig, ...google } = asProviderRecord(
    root.google,
  );
  const {
    thinking: _anthropicThinking,
    effort: _anthropicEffort,
    ...anthropic
  } = asProviderRecord(root.anthropic);

  return {
    ...root,
    clodex,
    openai: {
      ...openai,
      reasoningEffort: 'none',
    },
    google: {
      ...google,
      thinkingConfig: { includeThoughts: false },
    },
    anthropic: {
      ...anthropic,
      thinking: { type: 'disabled' },
    },
  } as Parameters<typeof generateText>[0]['providerOptions'];
}

/**
 * Attempts a single compression call against the given model.
 * Returns the compressed text on success, or throws on failure.
 */
const tryCompressWithModel = async (
  modelId: string,
  hostModels: HostModels,
  agentInstanceId: string,
  compactHistory: string,
  previousBriefingChars: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<string> => {
  throwIfExternallyAborted(externalSignal);
  const modelWithOptions = await hostModels.getWithOptions(
    modelId,
    `${agentInstanceId}`,
    {
      $ai_span_name: 'history-compression',
      $ai_parent_id: `${agentInstanceId}`,
      [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'internal',
    },
  );
  throwIfExternallyAborted(externalSignal);

  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortGraceTimeout: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbortListener: (() => void) | undefined;

  try {
    const externalAbortPromise = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const abortFromExternal = () => {
            const abortError = getExternalAbortError(externalSignal);
            abortController.abort(abortError);
            reject(abortError);
          };
          externalSignal.addEventListener('abort', abortFromExternal, {
            once: true,
          });
          removeExternalAbortListener = () =>
            externalSignal.removeEventListener('abort', abortFromExternal);
          if (externalSignal.aborted) abortFromExternal();
        })
      : null;

    const generationPromise = generateText({
      model: modelWithOptions.model,
      providerOptions: compressionProviderOptions(
        modelWithOptions.providerOptions,
      ),
      headers: modelWithOptions.headers,
      abortSignal: abortController.signal,
      messages: [
        {
          role: 'system',
          content: COMPRESSION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: buildCompressionUserMessage(
            compactHistory,
            previousBriefingChars,
          ),
        },
      ],
      temperature: 0.1,
      maxOutputTokens: HISTORY_COMPRESSION_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
    }).then((result) => {
      if (result.finishReason === 'length') {
        throw new Error(
          `History compression from ${modelId} was truncated at ${HISTORY_COMPRESSION_MAX_OUTPUT_TOKENS} output tokens`,
        );
      }
      return result.text.trim();
    });

    const timeoutResult = Symbol('history-compression-timeout');
    const timeoutError = new HistoryCompressionTimeoutError(modelId, timeoutMs);
    const timeoutPromise = new Promise<typeof timeoutResult>((resolve) => {
      timeout = setTimeout(() => {
        abortController.abort(timeoutError);
        resolve(timeoutResult);
      }, timeoutMs);
    });

    const racedResult = await Promise.race([
      generationPromise,
      timeoutPromise,
      ...(externalAbortPromise ? [externalAbortPromise] : []),
    ]);

    const compactionResult =
      racedResult === timeoutResult
        ? await Promise.race([
            generationPromise.then(
              (result) => ({ status: 'fulfilled' as const, result }),
              (error) => ({ status: 'rejected' as const, error }),
            ),
            new Promise<{ status: 'pending' }>((resolve) => {
              abortGraceTimeout = setTimeout(
                () => resolve({ status: 'pending' }),
                HISTORY_COMPRESSION_ABORT_GRACE_MS,
              );
            }),
          ]).then((settled) => {
            if (settled.status === 'fulfilled') return settled.result;
            if (settled.status === 'rejected') throw timeoutError;
            throw new HistoryCompressionUnsettledTimeoutError(modelId);
          })
        : racedResult;

    if (compactionResult.length < COMPRESSION_MIN_LENGTH) {
      throw new Error(
        `Compression too short (${compactionResult.length} chars)`,
      );
    }

    return compactionResult;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortGraceTimeout) clearTimeout(abortGraceTimeout);
    removeExternalAbortListener?.();
  }
};

export const generateSimpleCompressedHistory = async (
  messages: WideAgentMessage[],
  hostModels: HostModels,
  agentInstanceId: string,
  fallbackModelId?: string,
  host?: AgentHost,
  externalSignal?: AbortSignal,
): Promise<string> => {
  throwIfExternallyAborted(externalSignal);
  const compactConvertedChatHistory =
    convertAgentMessagesToCompactMessageHistoryString(messages, host);

  // Find the previous briefing length (if any) so we can inject a dynamic
  // budget hint into the user message.
  const previousBriefingChars =
    [...messages].reverse().find((m) => m.metadata?.compressedHistory)?.metadata
      ?.compressedHistory?.length ?? 0;

  let lastError: Error | undefined;
  const deadline = Date.now() + HISTORY_COMPRESSION_TOTAL_BUDGET_MS;

  const tryWithinBudget = async (modelId: string): Promise<string> => {
    throwIfExternallyAborted(externalSignal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new HistoryCompressionBudgetExceededError();
    return await tryCompressWithModel(
      modelId,
      hostModels,
      agentInstanceId,
      compactConvertedChatHistory,
      previousBriefingChars,
      Math.min(HISTORY_COMPRESSION_TIMEOUT_MS, remainingMs),
      externalSignal,
    );
  };

  const candidates = [
    ...(fallbackModelId ? [fallbackModelId] : []),
    ...HISTORY_COMPRESSION_MODELS,
  ].filter((modelId, index, all) => all.indexOf(modelId) === index);

  for (const modelId of candidates) {
    try {
      return await tryWithinBudget(modelId);
    } catch (e) {
      lastError = e as Error;
      if (externalSignal?.aborted) throw getExternalAbortError(externalSignal);
      if (lastError instanceof HistoryCompressionUnsettledTimeoutError) {
        throw lastError;
      }
      if (lastError instanceof HistoryCompressionBudgetExceededError) {
        throw lastError;
      }
      // Continue to the next fallback model
    }
  }

  // All models failed — rethrow the last error so the caller can handle it
  throw lastError ?? new Error('All history compression models failed');
};
