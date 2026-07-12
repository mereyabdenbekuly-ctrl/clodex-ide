import {
  createGuardianPolicyCohort,
  guardianAssessmentObservationSchema,
  guardianShadowAssessmentObservationSchema,
  guardianFeedbackLabelSchema,
  isGuardianFeedbackAllowedForDecision,
  type GuardianAssessmentObservation,
  type GuardianDogfoodAssessment,
  type GuardianDogfoodState,
  type GuardianFeedbackCounter,
  type GuardianFeedbackLabel,
  type GuardianPolicyCohort,
  type GuardianShadowAssessmentObservation,
} from '@shared/guardian';
import {
  evaluateGuardianReleaseReadiness,
  type GuardianReleaseReadiness,
} from '@shared/guardian-release-readiness';
import { AGENT_OS_LIMITS } from '@shared/agent-os';
import type { AgentOsStateStore } from './state-store';

export interface GuardianFeedbackSubmission {
  assessment: GuardianDogfoodAssessment;
  previousFeedback: GuardianFeedbackLabel | null;
  readiness: GuardianReleaseReadiness;
}

export class GuardianFeedbackService {
  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly onFeedback?: (
      submission: GuardianFeedbackSubmission,
    ) => void,
  ) {}

  public async initialize(): Promise<void> {
    await this.store.update((draft) => {
      initializePolicyCohorts(draft.guardian);
    });
  }

  public async recordAssessment(
    observation: GuardianAssessmentObservation,
  ): Promise<void> {
    const parsed = guardianAssessmentObservationSchema.parse(observation);
    await this.store.update((draft) => {
      initializePolicyCohorts(draft.guardian);
      if (
        draft.guardian.recentAssessments.some(
          (assessment) => assessment.assessmentId === parsed.assessmentId,
        )
      ) {
        return;
      }

      draft.guardian.recentAssessments.push({
        ...parsed,
        feedback: null,
        feedbackAt: null,
      });
      incrementDistribution(draft.guardian.distribution, parsed);
      const cohort = getOrCreatePolicyCohort(
        draft.guardian,
        parsed.policyVersion,
        parsed.createdAt,
      );
      incrementDistribution(cohort.distribution, parsed);
      cohort.startedAt = Math.min(cohort.startedAt, parsed.createdAt);
      cohort.lastAssessmentAt = Math.max(
        cohort.lastAssessmentAt,
        parsed.createdAt,
      );
      if (
        draft.guardian.recentAssessments.length >
        AGENT_OS_LIMITS.maxGuardianAssessments
      ) {
        draft.guardian.recentAssessments.splice(
          0,
          draft.guardian.recentAssessments.length -
            AGENT_OS_LIMITS.maxGuardianAssessments,
        );
      }
    });
  }

  public async submitFeedback(
    assessmentId: string,
    feedback: GuardianFeedbackLabel,
  ): Promise<GuardianDogfoodAssessment | null> {
    const parsedFeedback = guardianFeedbackLabelSchema.parse(feedback);
    let result: GuardianDogfoodAssessment | null = null;
    let previousFeedback: GuardianFeedbackLabel | null = null;
    let incompatibleDecision: GuardianDogfoodAssessment['decision'] | null =
      null;
    let changed = false;

    await this.store.update((draft) => {
      initializePolicyCohorts(draft.guardian);
      const assessment = draft.guardian.recentAssessments.find(
        (candidate) => candidate.assessmentId === assessmentId,
      );
      if (!assessment) return;
      if (
        !isGuardianFeedbackAllowedForDecision(
          assessment.decision,
          parsedFeedback,
        )
      ) {
        incompatibleDecision = assessment.decision;
        return;
      }

      previousFeedback = assessment.feedback;
      if (previousFeedback === parsedFeedback) {
        result = structuredClone(assessment);
        return;
      }

      if (previousFeedback === null) {
        draft.guardian.feedback.labeled += 1;
      } else {
        decrementFeedbackCounter(draft.guardian.feedback, previousFeedback);
      }
      incrementFeedbackCounter(draft.guardian.feedback, parsedFeedback);
      const cohort = getOrCreatePolicyCohort(
        draft.guardian,
        assessment.policyVersion,
        assessment.createdAt,
      );
      const previousCohortFeedback =
        previousFeedback !== null &&
        isGuardianFeedbackAllowedForDecision(
          assessment.decision,
          previousFeedback,
        )
          ? previousFeedback
          : null;
      if (previousCohortFeedback === null) {
        incrementLabeledCohortCounters(cohort, assessment, parsedFeedback);
      } else {
        relabelCohortCounters(
          cohort,
          assessment,
          previousCohortFeedback,
          parsedFeedback,
        );
      }
      assessment.feedback = parsedFeedback;
      assessment.feedbackAt = Date.now();
      result = structuredClone(assessment);
      changed = true;
    });

    if (incompatibleDecision !== null) {
      throw new Error(
        `Feedback ${parsedFeedback} is incompatible with Guardian decision ${incompatibleDecision}`,
      );
    }
    const persistedResult = result as GuardianDogfoodAssessment | null;
    if (persistedResult && changed) {
      try {
        this.onFeedback?.({
          assessment: persistedResult,
          previousFeedback,
          readiness: evaluateGuardianReleaseReadiness(
            this.store.snapshot().guardian,
            persistedResult.policyVersion,
          ),
        });
      } catch {
        // Feedback telemetry must not invalidate the persisted local label.
      }
    }
    return persistedResult;
  }

  public async recordShadowAssessment(
    observation: GuardianShadowAssessmentObservation,
  ): Promise<void> {
    const parsed = guardianShadowAssessmentObservationSchema.parse(observation);
    await this.store.update((draft) => {
      const shadow = draft.guardian.shadow;
      shadow.total += 1;
      shadow.success += parsed.success ? 1 : 0;
      shadow.failure += parsed.success ? 0 : 1;
      shadow.riskAgreement += parsed.riskAgreement ? 1 : 0;
      shadow.decisionAgreement += parsed.decisionAgreement ? 1 : 0;
      shadow.criticalRiskDisagreements +=
        parsed.success &&
        parsed.deterministicRisk === 'critical' &&
        parsed.shadowRisk !== 'critical'
          ? 1
          : 0;
      shadow.totalLatencyMs += parsed.latencyMs;
      shadow.lastAssessmentAt = Math.max(
        shadow.lastAssessmentAt ?? 0,
        parsed.createdAt,
      );
    });
  }

  public async clearRecent(): Promise<void> {
    await this.store.update((draft) => {
      initializePolicyCohorts(draft.guardian);
      draft.guardian.recentAssessments = [];
    });
  }
}

function incrementDistribution(
  distribution: GuardianPolicyCohort['distribution'],
  observation: GuardianAssessmentObservation,
): void {
  distribution.total += 1;
  distribution[observation.decision] += 1;
  distribution[observation.risk] += 1;
  distribution[observation.kind] += 1;
}

function incrementFeedbackCounter(
  counters: Pick<
    GuardianFeedbackCounter,
    'correct' | 'falsePositive' | 'falseNegative'
  >,
  feedback: GuardianFeedbackLabel,
): void {
  counters[toFeedbackCounterKey(feedback)] += 1;
}

function decrementFeedbackCounter(
  counters: Pick<
    GuardianFeedbackCounter,
    'correct' | 'falsePositive' | 'falseNegative'
  >,
  feedback: GuardianFeedbackLabel,
): void {
  const key = toFeedbackCounterKey(feedback);
  counters[key] = Math.max(0, counters[key] - 1);
}

function toFeedbackCounterKey(
  feedback: GuardianFeedbackLabel,
): 'correct' | 'falsePositive' | 'falseNegative' {
  switch (feedback) {
    case 'correct':
      return 'correct';
    case 'false-positive':
      return 'falsePositive';
    case 'false-negative':
      return 'falseNegative';
  }
}

function initializePolicyCohorts(state: GuardianDogfoodState): void {
  if (state.policyCohortsInitialized) return;

  for (const assessment of state.recentAssessments) {
    const cohort = getOrCreatePolicyCohort(
      state,
      assessment.policyVersion,
      assessment.createdAt,
    );
    incrementDistribution(cohort.distribution, assessment);
    cohort.startedAt = Math.min(cohort.startedAt, assessment.createdAt);
    cohort.lastAssessmentAt = Math.max(
      cohort.lastAssessmentAt,
      assessment.createdAt,
    );
    if (
      assessment.feedback &&
      isGuardianFeedbackAllowedForDecision(
        assessment.decision,
        assessment.feedback,
      )
    ) {
      incrementLabeledCohortCounters(cohort, assessment, assessment.feedback);
    }
  }
  state.policyCohortsInitialized = true;
}

function getOrCreatePolicyCohort(
  state: GuardianDogfoodState,
  policyVersion: number,
  createdAt: number,
): GuardianPolicyCohort {
  const key = String(policyVersion);
  state.policyCohorts[key] ??= createGuardianPolicyCohort(
    policyVersion,
    createdAt,
  );
  return state.policyCohorts[key];
}

function incrementLabeledCohortCounters(
  cohort: GuardianPolicyCohort,
  assessment: GuardianDogfoodAssessment,
  feedback: GuardianFeedbackLabel,
): void {
  for (const counters of [
    cohort.feedback,
    cohort.feedbackByKind[assessment.kind],
    cohort.feedbackByDecision[assessment.decision],
  ]) {
    counters.labeled += 1;
    incrementFeedbackCounter(counters, feedback);
  }
}

function relabelCohortCounters(
  cohort: GuardianPolicyCohort,
  assessment: GuardianDogfoodAssessment,
  previousFeedback: GuardianFeedbackLabel,
  feedback: GuardianFeedbackLabel,
): void {
  for (const counters of [
    cohort.feedback,
    cohort.feedbackByKind[assessment.kind],
    cohort.feedbackByDecision[assessment.decision],
  ]) {
    decrementFeedbackCounter(counters, previousFeedback);
    incrementFeedbackCounter(counters, feedback);
  }
}
