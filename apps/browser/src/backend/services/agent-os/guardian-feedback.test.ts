import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GuardianAssessmentObservation,
  GuardianShadowAssessmentObservation,
} from '@shared/guardian';
import { AgentOsStateStore } from './state-store';
import { GuardianFeedbackService } from './guardian-feedback';

const baseObservation: GuardianAssessmentObservation = {
  assessmentId: 'assessment-1',
  policyVersion: 1,
  createdAt: 100,
  kind: 'shell',
  risk: 'low',
  decision: 'approve',
  irreversible: false,
  readOnly: true,
  userAuthorization: 'unknown',
  narrowlyScoped: true,
  resourceScope: 'workspace',
  latencyMs: 4,
  validContext: true,
};

const baseShadowObservation: GuardianShadowAssessmentObservation = {
  assessmentId: 'shadow-1',
  policyVersion: 1,
  createdAt: 100,
  kind: 'shell',
  deterministicRisk: 'low',
  deterministicDecision: 'approve',
  shadowRisk: 'low',
  shadowDecision: 'approve',
  riskAgreement: true,
  decisionAgreement: true,
  success: true,
  latencyMs: 4,
};

describe('GuardianFeedbackService', () => {
  let root: string;
  let store: AgentOsStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-feedback-'));
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists a content-free assessment and updates distribution counters', async () => {
    const service = new GuardianFeedbackService(store);

    await service.recordAssessment(baseObservation);
    await service.recordAssessment({
      ...baseObservation,
      assessmentId: 'assessment-2',
      kind: 'sandbox',
      risk: 'high',
      decision: 'escalate',
    });

    expect(store.snapshot().guardian).toMatchObject({
      distribution: {
        total: 2,
        approve: 1,
        escalate: 1,
        low: 1,
        high: 1,
        shell: 1,
        sandbox: 1,
      },
    });
    expect(store.snapshot().guardian.recentAssessments).toHaveLength(2);
    expect(store.snapshot().guardian.policyCohorts['1']).toMatchObject({
      policyVersion: 1,
      startedAt: 100,
      lastAssessmentAt: 100,
      distribution: {
        total: 2,
        approve: 1,
        escalate: 1,
        shell: 1,
        sandbox: 1,
      },
    });
    expect(
      JSON.stringify(store.snapshot().guardian.recentAssessments),
    ).not.toContain('command');
  });

  it('deduplicates repeated assessment ids', async () => {
    const service = new GuardianFeedbackService(store);

    await service.recordAssessment(baseObservation);
    await service.recordAssessment(baseObservation);

    expect(store.snapshot().guardian.distribution.total).toBe(1);
    expect(store.snapshot().guardian.recentAssessments).toHaveLength(1);
  });

  it('aggregates content-free Guardian shadow quality and latency', async () => {
    const service = new GuardianFeedbackService(store);

    await service.recordShadowAssessment(baseShadowObservation);
    await service.recordShadowAssessment({
      ...baseShadowObservation,
      assessmentId: 'shadow-2',
      createdAt: 200,
      deterministicRisk: 'critical',
      deterministicDecision: 'deny',
      shadowRisk: 'high',
      shadowDecision: 'escalate',
      riskAgreement: false,
      decisionAgreement: false,
      latencyMs: 9,
    });
    await service.recordShadowAssessment({
      ...baseShadowObservation,
      assessmentId: 'shadow-3',
      createdAt: 150,
      shadowRisk: null,
      shadowDecision: null,
      riskAgreement: false,
      decisionAgreement: false,
      success: false,
      latencyMs: 11,
    });

    expect(store.snapshot().guardian.shadow).toEqual({
      total: 3,
      success: 2,
      failure: 1,
      riskAgreement: 1,
      decisionAgreement: 1,
      criticalRiskDisagreements: 1,
      totalLatencyMs: 24,
      lastAssessmentAt: 200,
    });
  });

  it('supports labeling and relabeling without double-counting', async () => {
    const onFeedback = vi.fn();
    const service = new GuardianFeedbackService(store, onFeedback);
    await service.recordAssessment(baseObservation);

    await expect(
      service.submitFeedback('assessment-1', 'false-negative'),
    ).resolves.toMatchObject({
      feedback: 'false-negative',
    });
    await expect(
      service.submitFeedback('assessment-1', 'correct'),
    ).resolves.toMatchObject({
      feedback: 'correct',
    });
    await service.submitFeedback('assessment-1', 'correct');

    expect(store.snapshot().guardian.feedback).toEqual({
      labeled: 1,
      correct: 1,
      falsePositive: 0,
      falseNegative: 0,
    });
    expect(store.snapshot().guardian.policyCohorts['1']).toMatchObject({
      feedback: {
        labeled: 1,
        correct: 1,
        falsePositive: 0,
        falseNegative: 0,
      },
      feedbackByKind: {
        shell: {
          labeled: 1,
          correct: 1,
        },
      },
      feedbackByDecision: {
        approve: {
          labeled: 1,
          correct: 1,
        },
      },
    });
    expect(onFeedback).toHaveBeenCalledTimes(2);
    expect(onFeedback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        readiness: expect.objectContaining({
          policyVersion: 1,
          labeled: 1,
          approvedLabeled: 1,
          falseNegative: 0,
        }),
      }),
    );
    expect(onFeedback).toHaveBeenLastCalledWith({
      assessment: expect.objectContaining({ feedback: 'correct' }),
      previousFeedback: 'false-negative',
      readiness: expect.any(Object),
    });
  });

  it('returns null for an expired assessment and preserves aggregate stats when clearing recent items', async () => {
    const service = new GuardianFeedbackService(store);
    await service.recordAssessment(baseObservation);

    await expect(
      service.submitFeedback('missing', 'false-positive'),
    ).resolves.toBeNull();
    await service.clearRecent();

    expect(store.snapshot().guardian.recentAssessments).toEqual([]);
    expect(store.snapshot().guardian.distribution.total).toBe(1);
    expect(
      store.snapshot().guardian.policyCohorts['1']?.distribution.total,
    ).toBe(1);
  });

  it('rejects labels that cannot be scored for the recorded decision', async () => {
    const service = new GuardianFeedbackService(store);
    await service.recordAssessment(baseObservation);

    await expect(
      service.submitFeedback('assessment-1', 'false-positive'),
    ).rejects.toThrow(
      'Feedback false-positive is incompatible with Guardian decision approve',
    );
    await expect(
      service.submitFeedback('assessment-1', 'correct'),
    ).resolves.toMatchObject({ feedback: 'correct' });
    expect(store.snapshot().guardian.feedback.correct).toBe(1);
  });

  it('excludes incompatible legacy labels from release-readiness cohorts', async () => {
    await store.update((draft) => {
      draft.guardian.recentAssessments.push({
        ...baseObservation,
        feedback: 'false-positive',
        feedbackAt: 150,
      });
      draft.guardian.feedback = {
        labeled: 1,
        correct: 0,
        falsePositive: 1,
        falseNegative: 0,
      };
      draft.guardian.policyCohortsInitialized = false;
    });
    const service = new GuardianFeedbackService(store);

    await service.submitFeedback('assessment-1', 'false-negative');

    expect(store.snapshot().guardian.policyCohorts['1']).toMatchObject({
      feedback: {
        labeled: 1,
        correct: 0,
        falsePositive: 0,
        falseNegative: 1,
      },
      feedbackByDecision: {
        approve: {
          labeled: 1,
          falsePositive: 0,
          falseNegative: 1,
        },
      },
    });
    expect(store.snapshot().guardian.feedback).toEqual({
      labeled: 1,
      correct: 0,
      falsePositive: 0,
      falseNegative: 1,
    });
  });

  it('backfills policy cohorts from a pre-readiness recent ledger once', async () => {
    await store.update((draft) => {
      draft.guardian.recentAssessments.push({
        ...baseObservation,
        feedback: 'false-negative',
        feedbackAt: 150,
      });
      draft.guardian.distribution.total = 1;
      draft.guardian.distribution.approve = 1;
      draft.guardian.distribution.low = 1;
      draft.guardian.distribution.shell = 1;
      draft.guardian.feedback = {
        labeled: 1,
        correct: 0,
        falsePositive: 0,
        falseNegative: 1,
      };
      draft.guardian.policyCohorts = {};
      draft.guardian.policyCohortsInitialized = false;
    });
    const service = new GuardianFeedbackService(store);

    await service.initialize();

    expect(store.snapshot().guardian.policyCohorts['1']).toMatchObject({
      distribution: {
        total: 1,
        approve: 1,
        shell: 1,
      },
      feedback: {
        labeled: 1,
        falseNegative: 1,
      },
      feedbackByDecision: {
        approve: {
          labeled: 1,
          falseNegative: 1,
        },
      },
    });
    expect(store.snapshot().guardian.recentAssessments).toHaveLength(1);
  });
});
