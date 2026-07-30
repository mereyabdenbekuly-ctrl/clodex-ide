import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../types/agent';
import {
  estimateEffectiveHistoryTokens,
  resolveContextOccupancyTokens,
  resolvePostCompactionOccupancyTokens,
} from './context-usage';

function message(id: string, text: string): AgentMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { createdAt: new Date(), partsMetadata: [{}] },
  };
}

describe('context occupancy resolution', () => {
  it('uses the largest consistent provider-reported count', () => {
    expect(
      resolveContextOccupancyTokens(
        { totalTokens: 100, inputTokens: 90, outputTokens: 20 },
        [],
      ),
    ).toBe(110);
  });

  it('falls back to input plus output when totalTokens is omitted or zero', () => {
    expect(
      resolveContextOccupancyTokens(
        { totalTokens: 0, inputTokens: 80_000, outputTokens: 5_000 },
        [],
      ),
    ).toBe(85_000);
  });

  it('locally estimates usage when the provider reports no usable counts', () => {
    const history = [message('before', 'x'.repeat(8_000))];
    const estimate = estimateEffectiveHistoryTokens(history);

    expect(resolveContextOccupancyTokens({}, history)).toBe(estimate);
    expect(estimate).toBeGreaterThan(0);
  });

  it('lets a large newly-recorded tool result exceed stale provider usage', () => {
    const history = [message('large-result', 'x'.repeat(400_000))];

    expect(
      resolveContextOccupancyTokens(
        { totalTokens: 10_000, inputTokens: 9_000, outputTokens: 1_000 },
        history,
      ),
    ).toBe(estimateEffectiveHistoryTokens(history));
  });

  it('ignores archived messages before the latest compression boundary', () => {
    const archived = message('archived', 'x'.repeat(40_000));
    const boundary = message('boundary', 'recent');
    boundary.metadata!.compressedHistory = 'compact briefing';
    const latest = message('latest', 'new work');

    const effective = estimateEffectiveHistoryTokens([
      archived,
      boundary,
      latest,
    ]);
    const withoutArchived = estimateEffectiveHistoryTokens([boundary, latest]);

    expect(effective).toBe(withoutArchived);
  });

  it('preserves inferred non-history overhead when rebasing after compaction', () => {
    const archived = message('archived', 'x'.repeat(40_000));
    const boundary = message('boundary', 'recent');
    const before = [archived, boundary];
    const previousHistoryTokens = estimateEffectiveHistoryTokens(before);
    const providerOverhead = 2_000;

    boundary.metadata!.compressedHistory = 'compact briefing';
    const after = [archived, boundary];

    expect(
      resolvePostCompactionOccupancyTokens(
        previousHistoryTokens + providerOverhead,
        previousHistoryTokens,
        after,
      ),
    ).toBe(estimateEffectiveHistoryTokens(after) + providerOverhead);
  });
});
