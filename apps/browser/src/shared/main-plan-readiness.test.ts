import { describe, expect, it } from 'vitest';
import {
  createMainPlanGateSnapshot,
  evaluateMainPlanReadiness,
  mainPlanEpicDefinitions,
  mainPlanEpicIds,
  type MainPlanEpicId,
  type MainPlanPromotionAssessment,
} from './main-plan-readiness';

const SOURCE = {
  commitSha: 'a'.repeat(40),
  clean: true,
};

describe('main plan readiness', () => {
  it('reports all five v1 epics code-complete and safely gated for release', () => {
    const report = evaluateMainPlanReadiness({
      generatedAt: '2026-07-12T00:00:00.000Z',
      channel: 'release',
      source: SOURCE,
    });

    expect(report.codeComplete).toBe(true);
    expect(report.buildReady).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.promotionReady).toBe(false);
    expect(report.promotableEpicCount).toBe(5);
    expect(report.epics).toHaveLength(5);
    expect(
      report.epics.every((epic) => epic.status === 'implemented-gated'),
    ).toBe(true);
  });

  it('fails closed when release defaults are enabled without promotion', () => {
    const gateStates = createMainPlanGateSnapshot('release');
    gateStates['evidence-memory-prompt-injection'] = {
      id: 'evidence-memory-prompt-injection',
      available: true,
      defaultEnabled: true,
    };
    const report = evaluateMainPlanReadiness({
      generatedAt: '2026-07-12T00:00:00.000Z',
      channel: 'release',
      source: SOURCE,
      gateStates,
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(
      'evidence-memory:release-default-enabled-without-promotion:evidence-memory-prompt-injection',
    );
  });

  it('blocks malformed or insufficient evidence even while a feature is gated', () => {
    for (const state of ['invalid', 'not-ready'] as const) {
      const report = evaluateMainPlanReadiness({
        generatedAt: '2026-07-12T00:00:00.000Z',
        channel: 'release',
        source: SOURCE,
        promotions: {
          'generated-app-capability-bridge': promotion(state),
        },
      });
      expect(report.ready).toBe(false);
      expect(report.blockers).toContain(
        `generated-app-capability-bridge:promotion-evidence-${state}`,
      );
    }
  });

  it('requires explicitly requested promotions without forcing unrelated epics on', () => {
    const requiredPromotions: MainPlanEpicId[] = [
      'evidence-memory',
      'generated-app-capability-bridge',
    ];
    const blocked = evaluateMainPlanReadiness({
      generatedAt: '2026-07-12T00:00:00.000Z',
      channel: 'release',
      source: SOURCE,
      requiredPromotions,
      promotions: {
        'evidence-memory': promotion('ready'),
      },
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.requiredPromotionReady).toBe(false);

    const ready = evaluateMainPlanReadiness({
      generatedAt: '2026-07-12T00:00:00.000Z',
      channel: 'release',
      source: SOURCE,
      requiredPromotions,
      promotions: {
        'evidence-memory': promotion('ready'),
        'generated-app-capability-bridge': promotion('ready'),
      },
    });
    expect(ready.ready).toBe(true);
    expect(ready.requiredPromotionReady).toBe(true);
    expect(ready.epics.find((epic) => epic.id === 'model-fabric')?.status).toBe(
      'implemented-gated',
    );
  });

  it('requires a clean source only when explicitly requested', () => {
    const dirtySource = { ...SOURCE, clean: false };
    expect(
      evaluateMainPlanReadiness({
        generatedAt: '2026-07-12T00:00:00.000Z',
        channel: 'release',
        source: dirtySource,
      }).ready,
    ).toBe(true);
    const strict = evaluateMainPlanReadiness({
      generatedAt: '2026-07-12T00:00:00.000Z',
      channel: 'release',
      source: dirtySource,
      requireCleanSource: true,
    });
    expect(strict.ready).toBe(false);
    expect(strict.blockers).toContain('source:working-tree-not-clean');
  });

  it('keeps the manifest unique and fully mapped to feature gates', () => {
    expect(mainPlanEpicDefinitions.map((epic) => epic.id)).toEqual(
      mainPlanEpicIds,
    );
    const gates = mainPlanEpicDefinitions.flatMap((epic) => epic.featureGates);
    expect(new Set(gates).size).toBe(gates.length);
    const snapshot = createMainPlanGateSnapshot('release');
    expect(gates.every((gate) => snapshot[gate] !== undefined)).toBe(true);
    expect(
      mainPlanEpicDefinitions.every(
        (epic) => epic.promotionContract !== 'not-yet-defined',
      ),
    ).toBe(true);
  });
});

function promotion(
  state: MainPlanPromotionAssessment['state'],
): MainPlanPromotionAssessment {
  return {
    state,
    source: 'test',
    blockers: [],
  };
}
