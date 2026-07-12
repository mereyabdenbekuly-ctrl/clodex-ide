import { describe, expect, it } from 'vitest';
import {
  EvidenceMemoryCanaryController,
  getEvidenceMemoryRolloutPolicy,
  isEvidenceMemoryInjectionDisabled,
} from './evidence-memory-rollout';

describe('Evidence Memory canary rollout', () => {
  it('keeps prerelease and stable in shadow/hold until promotion evidence exists', () => {
    expect(getEvidenceMemoryRolloutPolicy('prerelease')).toMatchObject({
      stage: 'shadow',
      allocationPercent: 0,
    });
    expect(getEvidenceMemoryRolloutPolicy('release')).toMatchObject({
      stage: 'hold',
      allocationPercent: 0,
    });
  });

  it('assigns tasks deterministically within the configured allocation', () => {
    const controller = new EvidenceMemoryCanaryController({
      ...getEvidenceMemoryRolloutPolicy('dev'),
      stage: 'canary-25',
      allocationPercent: 25,
    });
    const first = Array.from({ length: 1_000 }, (_, index) =>
      controller.isTaskAdmitted(`task-${index}`),
    );
    const second = Array.from({ length: 1_000 }, (_, index) =>
      controller.isTaskAdmitted(`task-${index}`),
    );

    expect(second).toEqual(first);
    expect(first.filter(Boolean).length).toBeGreaterThan(200);
    expect(first.filter(Boolean).length).toBeLessThan(300);
  });

  it('rolls back automatically on measured safety or quality regression', () => {
    const controller = new EvidenceMemoryCanaryController(
      getEvidenceMemoryRolloutPolicy('dev'),
    );
    const before = controller.isTaskAdmitted('task-a');
    const snapshot = controller.observe({
      sampleCount: 20,
      guardedMemoryRecall: 0.9,
      guardedMemoryStaleLeakageRate: 0.02,
      guardedMemoryLatencyP95Ms: 400,
      missingProvenanceAdmissionCount: 1,
      unresolvedContradictionInjectionCount: 1,
    });

    expect(before).toBe(true);
    expect(snapshot.rolledBack).toBe(true);
    expect(snapshot.rollbackReasons).toEqual([
      'recall-regression',
      'stale-memory-regression',
      'latency-regression',
      'missing-provenance-admission',
      'unresolved-contradiction-injection',
    ]);
    expect(controller.isTaskAdmitted('task-a')).toBe(false);
  });

  it('does not rollback before the minimum observation floor', () => {
    const controller = new EvidenceMemoryCanaryController(
      getEvidenceMemoryRolloutPolicy('dev'),
    );
    expect(
      controller.observe({
        sampleCount: 19,
        guardedMemoryRecall: 0,
        guardedMemoryStaleLeakageRate: 1,
        guardedMemoryLatencyP95Ms: 10_000,
        missingProvenanceAdmissionCount: 5,
        unresolvedContradictionInjectionCount: 5,
      }).rolledBack,
    ).toBe(false);
  });

  it('supports an explicit fail-closed health restore rollback', () => {
    const controller = new EvidenceMemoryCanaryController(
      getEvidenceMemoryRolloutPolicy('dev'),
    );
    const snapshot = controller.rollback('health-restore-failed');

    expect(snapshot.rolledBack).toBe(true);
    expect(controller.isTaskAdmitted('task-a')).toBe(false);
  });

  it.each([
    '1',
    'true',
    ' YES ',
    'on',
  ])('honors emergency disable value %s', (value) => {
    expect(isEvidenceMemoryInjectionDisabled(value)).toBe(true);
    const controller = new EvidenceMemoryCanaryController(
      getEvidenceMemoryRolloutPolicy('dev'),
      true,
    );
    expect(controller.isTaskAdmitted('task-a')).toBe(false);
    expect(controller.snapshot().rollbackReasons).toEqual([
      'emergency-kill-switch',
    ]);
  });
});
