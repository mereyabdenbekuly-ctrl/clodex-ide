import { z } from 'zod';

export const GUARDIAN_POLICY_VERSION = 1;

export const guardianActionKindSchema = z.enum([
  'shell',
  'network',
  'mcp',
  'sandbox',
]);
export type GuardianActionKind = z.infer<typeof guardianActionKindSchema>;

export const guardianRiskLevelSchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);
export type GuardianRiskLevel = z.infer<typeof guardianRiskLevelSchema>;

export const guardianUserAuthorizationSchema = z.enum([
  'unknown',
  'low',
  'medium',
  'high',
]);
export type GuardianUserAuthorization = z.infer<
  typeof guardianUserAuthorizationSchema
>;

export const guardianDecisionSchema = z.enum(['approve', 'deny', 'escalate']);
export type GuardianDecision = z.infer<typeof guardianDecisionSchema>;

export const guardianCapabilitySchema = z.enum([
  'read',
  'write',
  'delete',
  'execute',
  'network',
  'remote-execution',
  'file-transfer',
  'credential-access',
  'privileged-access',
  'policy-change',
  'arbitrary-code',
]);
export type GuardianCapability = z.infer<typeof guardianCapabilitySchema>;

export const guardianResourceScopeSchema = z.enum([
  'agent',
  'workspace',
  'host',
  'remote',
  'unknown',
]);
export type GuardianResourceScope = z.infer<typeof guardianResourceScopeSchema>;

export const guardianTargetTrustSchema = z.enum([
  'local',
  'known-remote',
  'unknown',
]);
export type GuardianTargetTrust = z.infer<typeof guardianTargetTrustSchema>;

export const guardianOperationClassSchema = z.enum([
  'inspect',
  'modify',
  'execute',
  'transfer',
  'admin',
]);
export type GuardianOperationClass = z.infer<
  typeof guardianOperationClassSchema
>;

/**
 * Guardian deliberately receives a small, fixed-shape, read-only context.
 * Raw commands, scripts, MCP arguments, origins, prompts and file contents
 * are classified by the owning adapter and must never be added here.
 */
export const guardianContextSchema = z
  .object({
    resourceScope: guardianResourceScopeSchema,
    targetTrust: guardianTargetTrustSchema,
    operation: guardianOperationClassSchema,
    capabilities: z.array(guardianCapabilitySchema).max(8),
  })
  .strict();
export type GuardianContext = z.infer<typeof guardianContextSchema>;

export const guardianAssessmentRequestSchema = z
  .object({
    kind: guardianActionKindSchema,
    summary: z.string().min(3).max(120),
    readOnly: z.boolean(),
    irreversible: z.boolean(),
    userAuthorization: guardianUserAuthorizationSchema.optional(),
    narrowlyScoped: z.boolean().optional(),
    requiresHumanApproval: z.boolean().optional(),
    context: guardianContextSchema,
  })
  .strict();
export type GuardianAssessmentRequest = z.infer<
  typeof guardianAssessmentRequestSchema
>;

export const guardianEvidenceCodeSchema = z.enum([
  'read-only',
  'bounded-scope',
  'workspace-scoped',
  'remote-target',
  'external-side-effect',
  'destructive',
  'irreversible',
  'arbitrary-code',
  'credential-access',
  'privileged-access',
  'policy-change',
  'unknown-context',
]);
export type GuardianEvidenceCode = z.infer<typeof guardianEvidenceCodeSchema>;

export const guardianAssessmentSchema = z
  .object({
    kind: guardianActionKindSchema,
    summary: z.string().min(3).max(120),
    risk: guardianRiskLevelSchema,
    decision: guardianDecisionSchema,
    irreversible: z.boolean(),
    evidence: z.array(guardianEvidenceCodeSchema).max(8),
    explanation: z.string().min(10).max(200),
  })
  .strict();
export type GuardianAssessment = z.infer<typeof guardianAssessmentSchema>;

export const guardianShadowClassificationSchema = z
  .object({
    risk: guardianRiskLevelSchema,
    narrowlyScoped: z.boolean(),
  })
  .strict();
export type GuardianShadowClassification = z.infer<
  typeof guardianShadowClassificationSchema
>;

export type GuardianShadowClassifier = (
  request: GuardianAssessmentRequest,
) => Promise<GuardianShadowClassification>;

export const guardianFeedbackLabelSchema = z.enum([
  'correct',
  'false-positive',
  'false-negative',
]);
export type GuardianFeedbackLabel = z.infer<typeof guardianFeedbackLabelSchema>;

export function isGuardianFeedbackAllowedForDecision(
  decision: GuardianDecision,
  feedback: GuardianFeedbackLabel,
): boolean {
  if (feedback === 'correct') return true;
  return decision === 'approve'
    ? feedback === 'false-negative'
    : feedback === 'false-positive';
}

export const guardianAssessmentObservationSchema = z
  .object({
    assessmentId: z.string().min(1),
    policyVersion: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    kind: guardianActionKindSchema,
    risk: guardianRiskLevelSchema,
    decision: guardianDecisionSchema,
    irreversible: z.boolean(),
    readOnly: z.boolean(),
    userAuthorization: guardianUserAuthorizationSchema.default('unknown'),
    narrowlyScoped: z.boolean().default(false),
    resourceScope: guardianResourceScopeSchema.default('unknown'),
    latencyMs: z.number().int().nonnegative(),
    validContext: z.boolean(),
  })
  .strict();
export type GuardianAssessmentObservation = z.infer<
  typeof guardianAssessmentObservationSchema
>;

export const guardianShadowAssessmentObservationSchema = z
  .object({
    assessmentId: z.string().min(1),
    policyVersion: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    kind: guardianActionKindSchema,
    deterministicRisk: guardianRiskLevelSchema,
    deterministicDecision: guardianDecisionSchema,
    shadowRisk: guardianRiskLevelSchema.nullable(),
    shadowDecision: guardianDecisionSchema.nullable(),
    riskAgreement: z.boolean(),
    decisionAgreement: z.boolean(),
    success: z.boolean(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();
export type GuardianShadowAssessmentObservation = z.infer<
  typeof guardianShadowAssessmentObservationSchema
>;

export const guardianShadowMetricsSchema = z.object({
  total: z.number().int().nonnegative().default(0),
  success: z.number().int().nonnegative().default(0),
  failure: z.number().int().nonnegative().default(0),
  riskAgreement: z.number().int().nonnegative().default(0),
  decisionAgreement: z.number().int().nonnegative().default(0),
  criticalRiskDisagreements: z.number().int().nonnegative().default(0),
  totalLatencyMs: z.number().int().nonnegative().default(0),
  lastAssessmentAt: z.number().int().nonnegative().nullable().default(null),
});
export type GuardianShadowMetrics = z.infer<typeof guardianShadowMetricsSchema>;

export const guardianDogfoodAssessmentSchema =
  guardianAssessmentObservationSchema.extend({
    feedback: guardianFeedbackLabelSchema.nullable().default(null),
    feedbackAt: z.number().int().nonnegative().nullable().default(null),
  });
export type GuardianDogfoodAssessment = z.infer<
  typeof guardianDogfoodAssessmentSchema
>;

export const guardianDistributionCounterSchema = z.object({
  total: z.number().int().nonnegative().default(0),
  approve: z.number().int().nonnegative().default(0),
  deny: z.number().int().nonnegative().default(0),
  escalate: z.number().int().nonnegative().default(0),
  low: z.number().int().nonnegative().default(0),
  medium: z.number().int().nonnegative().default(0),
  high: z.number().int().nonnegative().default(0),
  critical: z.number().int().nonnegative().default(0),
  shell: z.number().int().nonnegative().default(0),
  network: z.number().int().nonnegative().default(0),
  mcp: z.number().int().nonnegative().default(0),
  sandbox: z.number().int().nonnegative().default(0),
});
export type GuardianDistributionCounter = z.infer<
  typeof guardianDistributionCounterSchema
>;

export const guardianFeedbackCounterSchema = z.object({
  labeled: z.number().int().nonnegative().default(0),
  correct: z.number().int().nonnegative().default(0),
  falsePositive: z.number().int().nonnegative().default(0),
  falseNegative: z.number().int().nonnegative().default(0),
});
export type GuardianFeedbackCounter = z.infer<
  typeof guardianFeedbackCounterSchema
>;

const guardianFeedbackByKindSchema = z.object({
  shell: guardianFeedbackCounterSchema.prefault({}),
  network: guardianFeedbackCounterSchema.prefault({}),
  mcp: guardianFeedbackCounterSchema.prefault({}),
  sandbox: guardianFeedbackCounterSchema.prefault({}),
});

const guardianFeedbackByDecisionSchema = z.object({
  approve: guardianFeedbackCounterSchema.prefault({}),
  deny: guardianFeedbackCounterSchema.prefault({}),
  escalate: guardianFeedbackCounterSchema.prefault({}),
});

export const guardianPolicyCohortSchema = z.object({
  policyVersion: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  lastAssessmentAt: z.number().int().nonnegative(),
  distribution: guardianDistributionCounterSchema.prefault({}),
  feedback: guardianFeedbackCounterSchema.prefault({}),
  feedbackByKind: guardianFeedbackByKindSchema.prefault({}),
  feedbackByDecision: guardianFeedbackByDecisionSchema.prefault({}),
});
export type GuardianPolicyCohort = z.infer<typeof guardianPolicyCohortSchema>;

export function createGuardianPolicyCohort(
  policyVersion: number,
  createdAt: number,
): GuardianPolicyCohort {
  return guardianPolicyCohortSchema.parse({
    policyVersion,
    startedAt: createdAt,
    lastAssessmentAt: createdAt,
  });
}

export const guardianDogfoodStateSchema = z.object({
  recentAssessments: z.array(guardianDogfoodAssessmentSchema).default([]),
  distribution: guardianDistributionCounterSchema.prefault({}),
  feedback: guardianFeedbackCounterSchema.prefault({}),
  policyCohorts: z.record(z.string(), guardianPolicyCohortSchema).default({}),
  policyCohortsInitialized: z.boolean().default(false),
  shadow: guardianShadowMetricsSchema.prefault({}),
});
export type GuardianDogfoodState = z.infer<typeof guardianDogfoodStateSchema>;

/**
 * A disabled Guardian returns `null`, preserving the existing approval
 * pipeline. Enabled callers must treat errors as `escalate`/fail-closed.
 */
export type GuardianPolicyChecker = (
  request: GuardianAssessmentRequest,
) => Promise<GuardianAssessment | null>;
