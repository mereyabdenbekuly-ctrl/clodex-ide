import { describe, expect, it, vi } from 'vitest';
import type { EvidenceMemoryEvent } from './index';
import {
  buildRecursiveEvidenceSummaries,
  EVIDENCE_MEMORY_LONG_SUMMARY_WINDOW_MS,
  EVIDENCE_MEMORY_SHORT_SUMMARY_WINDOW_MS,
} from './recursive-summarizer';

const event = (
  id: string,
  timestamp: number,
  type: EvidenceMemoryEvent['type'] = 'decision_recorded',
): EvidenceMemoryEvent => ({
  id,
  taskId: 'task-a',
  workspaceId: '/workspace',
  type,
  timestamp,
  messageId: null,
  repositoryRevision: null,
  source: null,
  sourceIdHash: null,
  ingestionKeyHash: null,
  payloadHash: `hash-${id}`,
  contentHash: null,
  payload: { id },
  createdAt: timestamp,
});

describe('buildRecursiveEvidenceSummaries', () => {
  it('builds 10-minute summaries and recursively compacts them into 6-hour summaries', async () => {
    const result = await buildRecursiveEvidenceSummaries({
      events: [
        event('first', 1),
        event('second', EVIDENCE_MEMORY_SHORT_SUMMARY_WINDOW_MS + 1),
        event('third', EVIDENCE_MEMORY_LONG_SUMMARY_WINDOW_MS + 1),
      ],
    });

    expect(result.short).toHaveLength(3);
    expect(result.long).toHaveLength(2);
    expect(result.long[0]?.sourceEventIds).toEqual(['first', 'second']);
    expect(result.long[1]?.sourceEventIds).toEqual(['third']);
    expect(result.short[0]?.markdown).toContain('decision_recorded');
    expect(result.short[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ignores retrieval telemetry and preserves provenance for custom summarizers', async () => {
    const summarize = vi.fn(async ({ tier, entries }) => {
      return `${tier}:${entries.map((entry) => entry.id).join(',')}`;
    });
    const result = await buildRecursiveEvidenceSummaries({
      events: [
        event('material', 1),
        event('telemetry', 2, 'context_pack_built'),
      ],
      summarize,
    });

    expect(result.short[0]?.sourceEventIds).toEqual(['material']);
    expect(result.short[0]?.markdown).toBe('10m:material');
    expect(result.long[0]?.sourceEventIds).toEqual(['material']);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('skips open windows and summaries that already cover the same source set', async () => {
    const first = await buildRecursiveEvidenceSummaries({
      events: [event('material', 1)],
      closedBeforeOrAt: EVIDENCE_MEMORY_SHORT_SUMMARY_WINDOW_MS,
    });
    const existing = new Set([
      `10m:${first.short[0]?.windowStartedAt}:${first.short[0]?.sourceHash}`,
    ]);
    const result = await buildRecursiveEvidenceSummaries({
      events: [event('material', 1)],
      closedBeforeOrAt: EVIDENCE_MEMORY_SHORT_SUMMARY_WINDOW_MS,
      existingSourceHashes: existing,
    });

    expect(first.short).toHaveLength(1);
    expect(result.short).toHaveLength(0);
    expect(result.long).toHaveLength(0);
  });
});
