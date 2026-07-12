import { randomUUID } from 'node:crypto';
import {
  GUARDIAN_POLICY_VERSION,
  guardianActionKindSchema,
  guardianAssessmentRequestSchema,
  guardianAssessmentSchema,
  guardianShadowClassificationSchema,
  type GuardianAssessment,
  type GuardianAssessmentRequest,
  type GuardianCapability,
  type GuardianEvidenceCode,
  type GuardianRiskLevel,
  type GuardianAssessmentObservation,
  type GuardianDecision,
  type GuardianUserAuthorization,
  type GuardianShadowClassifier,
} from '@shared/guardian';
import type { FeatureGateId } from '@shared/feature-gates';
import type { TelemetryService } from '@/services/telemetry';

export interface GuardianAuditMetadata extends GuardianAssessmentObservation {
  evidenceCount: number;
  capabilityCount: number;
}

export interface GuardianServiceOptions {
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  telemetry?: Pick<TelemetryService, 'capture'>;
  recordAudit?: (metadata: GuardianAuditMetadata) => void;
  shadowClassifier?: GuardianShadowClassifier;
  recordShadowAudit?: (metadata: GuardianShadowAuditMetadata) => void;
}

export interface GuardianShadowAuditMetadata {
  assessmentId: string;
  policyVersion: number;
  createdAt: number;
  kind: GuardianAssessment['kind'];
  deterministicRisk: GuardianRiskLevel;
  deterministicDecision: GuardianDecision;
  shadowRisk: GuardianRiskLevel | null;
  shadowDecision: GuardianDecision | null;
  riskAgreement: boolean;
  decisionAgreement: boolean;
  success: boolean;
  latencyMs: number;
}

const HIGH_RISK_CAPABILITIES = new Set<GuardianCapability>([
  'remote-execution',
  'file-transfer',
  'credential-access',
  'privileged-access',
  'policy-change',
  'arbitrary-code',
]);

const SIDE_EFFECT_CAPABILITIES = new Set<GuardianCapability>([
  'write',
  'delete',
  'execute',
  'network',
  ...HIGH_RISK_CAPABILITIES,
]);

/**
 * Content-free policy assessor. It has no shell, network, MCP, sandbox,
 * model-provider or credential dependencies, so it cannot execute the action
 * it is reviewing or expand its own permissions.
 */
export class GuardianService {
  public constructor(private readonly options: GuardianServiceOptions) {}

  public async assess(request: unknown): Promise<GuardianAssessment | null> {
    if (!this.options.isFeatureEnabled('multi-agent-guardian')) return null;

    const startedAt = Date.now();
    const parsed = guardianAssessmentRequestSchema.safeParse(request);
    const assessment = parsed.success
      ? assessValidRequest(parsed.data)
      : createFailClosedAssessment(request);
    const completedAt = Date.now();
    const metadata: GuardianAuditMetadata = {
      assessmentId: randomUUID(),
      policyVersion: GUARDIAN_POLICY_VERSION,
      createdAt: completedAt,
      kind: assessment.kind,
      risk: assessment.risk,
      decision: assessment.decision,
      irreversible: assessment.irreversible,
      readOnly: parsed.success ? parsed.data.readOnly : false,
      userAuthorization: parsed.success
        ? (parsed.data.userAuthorization ?? 'unknown')
        : 'unknown',
      narrowlyScoped: parsed.success
        ? (parsed.data.narrowlyScoped ??
          (parsed.data.context.resourceScope === 'agent' ||
            parsed.data.context.resourceScope === 'workspace'))
        : false,
      resourceScope: parsed.success
        ? parsed.data.context.resourceScope
        : 'unknown',
      evidenceCount: assessment.evidence.length,
      capabilityCount: parsed.success
        ? new Set(parsed.data.context.capabilities).size
        : 0,
      latencyMs: completedAt - startedAt,
      validContext: parsed.success,
    };

    try {
      this.options.telemetry?.capture('guardian-assessed', {
        policy_version: metadata.policyVersion,
        action_kind: metadata.kind,
        risk_level: metadata.risk,
        decision: metadata.decision,
        irreversible: metadata.irreversible,
        read_only: metadata.readOnly,
        user_authorization: metadata.userAuthorization,
        narrowly_scoped: metadata.narrowlyScoped,
        resource_scope: metadata.resourceScope,
        evidence_count: metadata.evidenceCount,
        capability_count: metadata.capabilityCount,
        latency_ms: metadata.latencyMs,
        valid_context: metadata.validContext,
      });
    } catch {
      // Audit transport must never change or suppress the policy decision.
    }
    try {
      this.options.recordAudit?.(metadata);
    } catch {
      // Debug-inspector availability must not affect authorization.
    }
    if (
      parsed.success &&
      this.options.shadowClassifier &&
      this.options.isFeatureEnabled('guardian-model-shadow')
    ) {
      void this.runShadowClassification(
        parsed.data,
        assessment,
        metadata.assessmentId,
      );
    }

    return assessment;
  }

  private async runShadowClassification(
    request: GuardianAssessmentRequest,
    deterministic: GuardianAssessment,
    assessmentId: string,
  ): Promise<void> {
    const startedAt = Date.now();
    let shadowRisk: GuardianRiskLevel | null = null;
    let shadowDecision: GuardianDecision | null = null;
    let success = false;
    try {
      const classification = guardianShadowClassificationSchema.parse(
        await this.options.shadowClassifier?.(request),
      );
      shadowRisk = classification.risk;
      shadowDecision = applyProductApprovalBoundary(
        decideGuardianOutcome({
          risk: classification.risk,
          userAuthorization: request.userAuthorization ?? 'unknown',
          narrowlyScoped: classification.narrowlyScoped,
        }),
        request.requiresHumanApproval === true,
      );
      success = true;
    } catch {
      // Shadow review is observational and must never delay or alter policy.
    }
    const metadata: GuardianShadowAuditMetadata = {
      assessmentId,
      policyVersion: GUARDIAN_POLICY_VERSION,
      createdAt: Date.now(),
      kind: deterministic.kind,
      deterministicRisk: deterministic.risk,
      deterministicDecision: deterministic.decision,
      shadowRisk,
      shadowDecision,
      riskAgreement: shadowRisk === deterministic.risk,
      decisionAgreement: shadowDecision === deterministic.decision,
      success,
      latencyMs: Date.now() - startedAt,
    };
    try {
      this.options.telemetry?.capture('guardian-shadow-classified', {
        policy_version: metadata.policyVersion,
        action_kind: metadata.kind,
        deterministic_risk: metadata.deterministicRisk,
        deterministic_decision: metadata.deterministicDecision,
        shadow_risk: metadata.shadowRisk,
        shadow_decision: metadata.shadowDecision,
        risk_agreement: metadata.riskAgreement,
        decision_agreement: metadata.decisionAgreement,
        success: metadata.success,
        latency_ms: metadata.latencyMs,
      });
    } catch {
      // Telemetry availability must not affect deterministic authorization.
    }
    try {
      this.options.recordShadowAudit?.(metadata);
    } catch {
      // Local dogfood sinks are also non-authoritative.
    }
  }
}

function assessValidRequest(
  request: GuardianAssessmentRequest,
): GuardianAssessment {
  const capabilities = new Set(request.context.capabilities);
  const evidence = collectEvidence(request, capabilities);
  const deny =
    (request.irreversible &&
      request.context.resourceScope === 'host' &&
      capabilities.has('delete')) ||
    (capabilities.has('policy-change') &&
      capabilities.has('privileged-access'));
  const risk = deriveRisk(request, capabilities, deny);
  const matrixDecision = decideGuardianOutcome({
    risk,
    userAuthorization: request.userAuthorization ?? 'unknown',
    narrowlyScoped:
      request.narrowlyScoped ??
      (request.context.resourceScope === 'agent' ||
        request.context.resourceScope === 'workspace'),
  });
  const decision = applyProductApprovalBoundary(
    matrixDecision,
    request.requiresHumanApproval === true,
  );

  return guardianAssessmentSchema.parse({
    kind: request.kind,
    summary: request.summary,
    risk,
    decision,
    irreversible: request.irreversible,
    evidence,
    explanation: buildExplanation(decision, risk, request.irreversible),
  });
}

function createFailClosedAssessment(request: unknown): GuardianAssessment {
  const candidateKind =
    request && typeof request === 'object' && 'kind' in request
      ? (request as { kind?: unknown }).kind
      : undefined;
  const parsedKind = guardianActionKindSchema.safeParse(candidateKind);

  return guardianAssessmentSchema.parse({
    kind: parsedKind.success ? parsedKind.data : 'sandbox',
    summary: 'Review action with invalid Guardian context',
    risk: 'critical',
    decision: 'deny',
    irreversible: false,
    evidence: ['unknown-context'],
    explanation:
      'Guardian context was invalid, so the action was denied fail-closed.',
  });
}

function deriveRisk(
  request: GuardianAssessmentRequest,
  capabilities: Set<GuardianCapability>,
  deny: boolean,
): GuardianRiskLevel {
  if (deny) return 'critical';
  const readOnlyNetworkInspection =
    request.readOnly &&
    request.context.operation === 'inspect' &&
    [...capabilities].every(
      (capability) => capability === 'read' || capability === 'network',
    );
  if (readOnlyNetworkInspection) return 'low';
  if (
    request.irreversible &&
    request.context.resourceScope === 'host' &&
    (capabilities.has('delete') || capabilities.has('privileged-access'))
  ) {
    return 'critical';
  }
  if (
    request.irreversible ||
    [...capabilities].some((capability) =>
      HIGH_RISK_CAPABILITIES.has(capability),
    )
  ) {
    return 'high';
  }
  if (
    request.context.resourceScope === 'unknown' ||
    [...capabilities].some((capability) =>
      SIDE_EFFECT_CAPABILITIES.has(capability),
    )
  ) {
    const boundedExecution =
      capabilities.size === 1 &&
      capabilities.has('execute') &&
      (request.context.resourceScope === 'agent' ||
        request.context.resourceScope === 'workspace');
    return boundedExecution ? 'low' : 'medium';
  }
  return request.readOnly &&
    capabilities.has('read') &&
    (request.context.resourceScope === 'agent' ||
      request.context.resourceScope === 'workspace')
    ? 'low'
    : 'medium';
}

const USER_AUTHORIZATION_SCORE: Record<GuardianUserAuthorization, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Deterministic policy boundary. Models or adapters may classify evidence,
 * but they cannot override this risk × authorization matrix.
 */
export function decideGuardianOutcome(input: {
  risk: GuardianRiskLevel;
  userAuthorization: GuardianUserAuthorization;
  narrowlyScoped: boolean;
}): GuardianDecision {
  if (input.risk === 'critical') return 'deny';
  if (input.risk === 'low' || input.risk === 'medium') return 'approve';
  return input.narrowlyScoped &&
    USER_AUTHORIZATION_SCORE[input.userAuthorization] >=
      USER_AUTHORIZATION_SCORE.medium
    ? 'approve'
    : 'escalate';
}

function applyProductApprovalBoundary(
  decision: GuardianDecision,
  requiresHumanApproval: boolean,
): GuardianDecision {
  return decision !== 'deny' && requiresHumanApproval ? 'escalate' : decision;
}

function collectEvidence(
  request: GuardianAssessmentRequest,
  capabilities: Set<GuardianCapability>,
): GuardianEvidenceCode[] {
  const evidence = new Set<GuardianEvidenceCode>();
  if (request.readOnly) evidence.add('read-only');
  if (
    request.context.resourceScope === 'agent' ||
    request.context.resourceScope === 'workspace'
  ) {
    evidence.add('bounded-scope');
  }
  if (request.context.resourceScope === 'workspace') {
    evidence.add('workspace-scoped');
  }
  if (
    request.context.resourceScope === 'remote' ||
    request.context.targetTrust === 'known-remote'
  ) {
    evidence.add('remote-target');
  }
  if (
    [...capabilities].some((capability) =>
      SIDE_EFFECT_CAPABILITIES.has(capability),
    ) &&
    !(capabilities.size === 1 && capabilities.has('execute'))
  ) {
    evidence.add('external-side-effect');
  }
  if (capabilities.has('delete')) evidence.add('destructive');
  if (request.irreversible) evidence.add('irreversible');
  if (capabilities.has('arbitrary-code')) evidence.add('arbitrary-code');
  if (capabilities.has('credential-access')) {
    evidence.add('credential-access');
  }
  if (capabilities.has('privileged-access')) {
    evidence.add('privileged-access');
  }
  if (capabilities.has('policy-change')) evidence.add('policy-change');
  if (
    request.context.resourceScope === 'unknown' ||
    request.context.targetTrust === 'unknown'
  ) {
    evidence.add('unknown-context');
  }
  return [...evidence].slice(0, 8);
}

function buildExplanation(
  decision: GuardianAssessment['decision'],
  risk: GuardianRiskLevel,
  irreversible: boolean,
): string {
  if (decision === 'deny') {
    return 'Guardian blocked an unbounded destructive or policy-changing action.';
  }
  if (decision === 'escalate' && irreversible) {
    return 'This action may be irreversible and requires explicit human approval.';
  }
  if (decision === 'escalate') {
    return `Guardian rated this action ${risk} risk and requires human review.`;
  }
  return 'Guardian found only bounded, reversible low-risk capabilities.';
}
