import type { GuardianAssessmentObservation } from '@shared/guardian';
import type { GuardianAuditMetadata } from './index';

export function toGuardianAssessmentObservation(
  metadata: GuardianAuditMetadata,
): GuardianAssessmentObservation {
  return {
    assessmentId: metadata.assessmentId,
    policyVersion: metadata.policyVersion,
    createdAt: metadata.createdAt,
    kind: metadata.kind,
    risk: metadata.risk,
    decision: metadata.decision,
    irreversible: metadata.irreversible,
    readOnly: metadata.readOnly,
    userAuthorization: metadata.userAuthorization,
    narrowlyScoped: metadata.narrowlyScoped,
    resourceScope: metadata.resourceScope,
    latencyMs: metadata.latencyMs,
    validContext: metadata.validContext,
  };
}
