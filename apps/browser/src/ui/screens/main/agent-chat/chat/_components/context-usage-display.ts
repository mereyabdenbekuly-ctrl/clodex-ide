export function shouldShowContextUsageRing(
  maxTokens: number | undefined,
): maxTokens is number {
  return (
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
  );
}

export function calculateContextUsedPercentage(
  usedTokens: number,
  maxTokens: number | undefined,
): number {
  if (!shouldShowContextUsageRing(maxTokens)) return 0;
  return Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 100)));
}
