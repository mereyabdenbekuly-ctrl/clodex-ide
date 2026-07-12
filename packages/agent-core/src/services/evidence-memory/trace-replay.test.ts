import { describe, expect, it } from 'vitest';
import {
  createEvidenceMemoryTraceReplayFixture,
  evaluateEvidenceMemoryTraceReplay,
  toEvidenceMemoryTraceReplayReceipt,
} from './trace-replay';

describe('Evidence Memory trace replay', () => {
  it('promotes a deterministic paired replay cohort', () => {
    const report = evaluateEvidenceMemoryTraceReplay(
      createEvidenceMemoryTraceReplayFixture(),
    );

    expect(report.inputObservationCount).toBe(100);
    expect(report.replayedObservationCount).toBe(100);
    expect(report.invalidObservationCount).toBe(0);
    expect(report.duplicateObservationCount).toBe(0);
    expect(report.missingObservedAtCount).toBe(100);
    expect(report.distinctTaskCount).toBe(3);
    expect(report.guardedMemoryRecall).toBe(1);
    expect(report.compressedHistoryRecall).toBe(0.8);
    expect(report.recallLift).toBeCloseTo(0.2);
    expect(report.guardedMemoryStaleLeakageRate).toBe(0);
    expect(report.promotionReady).toBe(true);
    expect(report.promotionBlockers).toEqual([]);
    expect(report.traceSetHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed on invalid and duplicate observations', () => {
    const fixture = createEvidenceMemoryTraceReplayFixture();
    const first = fixture.observations[0];
    const report = evaluateEvidenceMemoryTraceReplay({
      ...fixture,
      observations: [...fixture.observations, first, { invalid: true }],
    });

    expect(report.inputObservationCount).toBe(102);
    expect(report.replayedObservationCount).toBe(100);
    expect(report.invalidObservationCount).toBe(1);
    expect(report.duplicateObservationCount).toBe(1);
    expect(report.promotionReady).toBe(false);
    expect(report.promotionBlockers).toEqual(
      expect.arrayContaining([
        'invalid-trace-observations',
        'duplicate-trace-observations',
      ]),
    );
  });

  it('produces a content-free promotion receipt', () => {
    const fixture = createEvidenceMemoryTraceReplayFixture();
    const report = evaluateEvidenceMemoryTraceReplay(fixture);
    const receipt = toEvidenceMemoryTraceReplayReceipt(report);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toEqual(
      expect.objectContaining({
        promotionReady: true,
        replayedObservationCount: 100,
      }),
    );
    expect(serialized).not.toContain(
      String(
        (fixture.observations[0] as { scenarioIdHash: string }).scenarioIdHash,
      ),
    );
    expect(serialized).not.toContain('sourceTaskHash');
  });

  it('rejects malformed top-level bundles', () => {
    expect(() =>
      evaluateEvidenceMemoryTraceReplay({
        format: 'wrong',
        version: 1,
        observations: [],
      }),
    ).toThrow(/malformed/u);
  });

  it('requires timestamps for external promotion traces', () => {
    const report = evaluateEvidenceMemoryTraceReplay(
      createEvidenceMemoryTraceReplayFixture(),
      {},
      Date.now(),
      { requireObservedAt: true },
    );

    expect(report.promotionReady).toBe(false);
    expect(report.promotionBlockers).toContain('missing-trace-timestamps');
  });
});
