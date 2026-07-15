import {
  PROMOTION_ASSESSMENT_KIND,
  PROMOTION_ASSESSMENT_VERSION,
  type PromotionAssessment,
} from '@clodex/promotion';
import {
  PRODUCTION_ADAPTER_ATTESTATION_KIND,
  PRODUCTION_AUTHORITY_VERSION,
  PRODUCTION_DEPLOYMENT_BINDING_KIND,
  PRODUCTION_GATE_DECISION_KIND,
  PRODUCTION_PROTECTED_HEAD_KIND,
  PRODUCTION_RECOVERY_ADMISSION_KIND,
  PRODUCTION_RECOVERY_PROFILE_KIND,
  type ProductionAdapterConfinementAttestation,
  type ProductionDeploymentBinding,
  type ProductionOperationMembership,
  type ProductionProtectedRegistryHeadProfile,
  type ProductionRecoveryAdmission,
  type ProductionRecoveryBarrierProfile,
  type ProductionReviewedGateDecision,
} from './production-model.js';

export const NOW = '2026-07-15T12:00:00Z';
export const ISSUED_AT = '2026-07-15T11:00:00Z';
export const EXPIRES_AT = '2026-07-15T13:00:00Z';

export function digest(character: string): string {
  return character.repeat(64);
}

export function deploymentFixture(): ProductionDeploymentBinding {
  return {
    kind: PRODUCTION_DEPLOYMENT_BINDING_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    deploymentId: 'deployment:one',
    workspaceId: 'workspace:repo',
    taskId: 'task:one',
    rootObjectId: 'root:workspace',
    environmentDigest: digest('a'),
    platformDigest: digest('b'),
    buildDigest: digest('c'),
    configurationDigest: digest('d'),
    policyDigest: digest('e'),
    evidencePolicyDigest: digest('f'),
    adapterAuthorityProfileDigest: digest('1'),
    adapterRegistryManifestHash: digest('2'),
    runnerRegistryManifestHash: digest('3'),
    effectRegistryManifestHash: digest('4'),
    promotionProfileDigest: digest('5'),
    targetGateId: 'gate:production',
    controlPlaneStorageAdapterId: 'storage:durable-v1',
  };
}

export function attestationFixture(
  deployment = deploymentFixture(),
): ProductionAdapterConfinementAttestation {
  return {
    kind: PRODUCTION_ADAPTER_ATTESTATION_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    attestationId: 'attestation:one',
    verifierId: 'verifier:platform',
    verificationEvidenceDigest: digest('6'),
    deploymentId: deployment.deploymentId,
    workspaceId: deployment.workspaceId,
    taskId: deployment.taskId,
    rootObjectId: deployment.rootObjectId,
    environmentDigest: deployment.environmentDigest,
    platformDigest: deployment.platformDigest,
    buildDigest: deployment.buildDigest,
    configurationDigest: deployment.configurationDigest,
    policyDigest: deployment.policyDigest,
    profileId: 'profile:linux-v1',
    profileDigest: deployment.adapterAuthorityProfileDigest,
    platform: 'linux',
    descriptorRelativeFilesystem: true,
    openat2BeneathNoSymlinksNoMagicLinksNoMountEscape: true,
    exactStateCas: true,
    fileAndDirectoryFsync: true,
    gitNoShellHooksPagerExternalDiffTextconvCredentialsOrNetwork: true,
    gitBoundedOutputAndTimeout: true,
    testDigestPinnedPullNever: true,
    testNetworkAndCredentialsDisabled: true,
    testReadOnlyWorkspaceAndDisposableScratch: true,
    testCapabilitiesDroppedAndNoNewPrivileges: true,
    finalAuthorityFenceInsideSerializedDispatch: true,
    arbitraryHostFilesystemApi: false,
    arbitraryCommandApi: false,
    featureGateDefault: false,
    verifiedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
}

export function protectedHeadFixture(
  deployment = deploymentFixture(),
): ProductionProtectedRegistryHeadProfile {
  return {
    kind: PRODUCTION_PROTECTED_HEAD_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    serviceId: 'registry-head:protected',
    deploymentId: deployment.deploymentId,
    environmentDigest: deployment.environmentDigest,
    platformDigest: deployment.platformDigest,
    trustRootDigest: digest('7'),
    linearizable: true,
    durable: true,
    multiProcess: true,
    independentlyProtected: true,
    antiRollback: true,
    synchronousFinalFence: true,
  };
}

export function recoveryProfileFixture(
  deployment = deploymentFixture(),
): ProductionRecoveryBarrierProfile {
  return {
    kind: PRODUCTION_RECOVERY_PROFILE_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    barrierId: 'recovery-barrier:one',
    deploymentId: deployment.deploymentId,
    environmentDigest: deployment.environmentDigest,
    buildDigest: deployment.buildDigest,
    configurationDigest: deployment.configurationDigest,
    policyDigest: deployment.policyDigest,
    restartScanBeforeAuthority: true,
    evidenceReceiptReverification: true,
    uncertainEffectReconciliation: true,
    effectReplayForbidden: true,
    authorityPublicationSerialized: true,
    synchronousFinalFence: true,
  };
}

export function recoveryAdmissionFixture(
  deployment = deploymentFixture(),
  profile = recoveryProfileFixture(deployment),
): ProductionRecoveryAdmission {
  return {
    kind: PRODUCTION_RECOVERY_ADMISSION_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    admissionId: 'recovery-admission:one',
    barrierId: profile.barrierId,
    deploymentId: deployment.deploymentId,
    recordSetDigest: digest('8'),
    recordCount: 2,
    recoveredMutationCount: 1,
    uncertainRecordCount: 0,
    unresolvedRecordCount: 0,
    terminalEvidenceComplete: true,
    deliveryReceiptsReverified: true,
    uncertainEffectsReconciledOrQuarantined: true,
    effectReplayAttempted: false,
    admittedAt: NOW,
  };
}

export function promotionAssessmentFixture(
  deployment = deploymentFixture(),
): PromotionAssessment {
  return {
    kind: PROMOTION_ASSESSMENT_KIND,
    version: PROMOTION_ASSESSMENT_VERSION,
    profileId: 'promotion-profile:one',
    profileDigest: deployment.promotionProfileDigest,
    targetGateId: deployment.targetGateId,
    evaluatedAt: NOW,
    evidenceBundleDigest: digest('9'),
    eligibility: 'eligible-for-reviewed-decision',
    automaticEnablement: false,
    blockers: [],
    assessmentDigest: digest('a'),
  };
}

export function reviewedDecisionFixture(
  deployment = deploymentFixture(),
  assessment = promotionAssessmentFixture(deployment),
): ProductionReviewedGateDecision {
  return {
    kind: PRODUCTION_GATE_DECISION_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    decisionId: 'reviewed-decision:one',
    deploymentId: deployment.deploymentId,
    targetGateId: deployment.targetGateId,
    enabled: true,
    promotionProfileDigest: deployment.promotionProfileDigest,
    promotionAssessmentDigest: assessment.assessmentDigest,
    evidenceBundleDigest: assessment.evidenceBundleDigest,
    environmentDigest: deployment.environmentDigest,
    platformDigest: deployment.platformDigest,
    buildDigest: deployment.buildDigest,
    configurationDigest: deployment.configurationDigest,
    policyDigest: deployment.policyDigest,
    evidencePolicyDigest: deployment.evidencePolicyDigest,
    adapterRegistryManifestHash: deployment.adapterRegistryManifestHash,
    runnerRegistryManifestHash: deployment.runnerRegistryManifestHash,
    effectRegistryManifestHash: deployment.effectRegistryManifestHash,
    reviewerSetDigest: digest('b'),
    reviewReceiptDigest: digest('c'),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
}

export function membershipFixture(): ProductionOperationMembership {
  return {
    operation: 'filesystem.create',
    adapter: {
      kind: 'adapter',
      adapterId: 'adapter:filesystem',
      adapterDigest: digest('d'),
      operation: 'filesystem.create',
      argumentSchemaDigest: digest('e'),
      effectId: 'effect:filesystem.create',
      runnerId: null,
      runnerDigest: null,
    },
    effect: {
      kind: 'effect',
      effectId: 'effect:filesystem.create',
      adapterId: 'adapter:filesystem',
      adapterDigest: digest('d'),
      operation: 'filesystem.create',
      argumentSchemaDigest: digest('e'),
      effectClass: 'local.reversible',
      commitProtocol: 'one-shot-commit-permit',
      idempotency: 'forbidden-retry',
      observerStrength: 'local_state_reconciled',
      reconciliation: 'required-on-uncertain',
      approval: 'canonical-review-required',
      secretHandling: 'forbidden',
    },
    runner: null,
  };
}
