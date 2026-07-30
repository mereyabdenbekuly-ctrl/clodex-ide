import type { AgentMessage } from '../../types/agent';
import { estimateMessageTokens } from './history-compression';

export type StepTokenUsage = {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

function normalizedTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : 0;
}

/**
 * Estimate the model-visible history when a provider omits usage entirely.
 * Messages before the latest compressed-history boundary are not rendered
 * into the next prompt and therefore must not inflate the fallback estimate.
 */
export function estimateEffectiveHistoryTokens(
  history: readonly AgentMessage[],
): number {
  let effectiveStart = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const compressedHistory = history[index]?.metadata?.compressedHistory;
    if (typeof compressedHistory === 'string' && compressedHistory.length > 0) {
      effectiveStart = index;
      break;
    }
  }

  let estimatedTokens = 0;
  for (let index = effectiveStart; index < history.length; index += 1) {
    const message = history[index];
    if (message) estimatedTokens += estimateMessageTokens(message);
  }
  return estimatedTokens;
}

/**
 * Resolve current context occupancy from inconsistent provider usage shapes.
 * `totalTokens` is preferred, but the component sum wins when it is larger;
 * providers that emit zeros/undefined fall back to a local history estimate
 * so automatic compression cannot be disabled accidentally.
 */
export function resolveContextOccupancyTokens(
  usage: StepTokenUsage,
  history: readonly AgentMessage[],
): number {
  const totalTokens = normalizedTokenCount(usage.totalTokens);
  const componentTokens =
    normalizedTokenCount(usage.inputTokens) +
    normalizedTokenCount(usage.outputTokens);
  const locallyEstimatedTokens = estimateEffectiveHistoryTokens(history);
  return Math.max(totalTokens, componentTokens, locallyEstimatedTokens);
}
