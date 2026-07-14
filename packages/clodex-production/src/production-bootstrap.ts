import {
  capabilityScopeEquals,
  snapshotCapabilityScope,
} from '@clodex/adapters';
import {
  validateSafeCodingAction,
  type CanonicalJsonValue,
  type SafeCodingAction,
} from '@clodex/contracts';
import {
  ExecutionControlPlane,
  isControlPlaneTerminalPhase,
  type CommitPermitAuthorityPort,
  type ControlPlaneEffectPort,
  type ControlPlaneRecoveryResult,
  type EvidenceAdmissionReceiptPort,
} from '@clodex/control-plane';
import type {
  PreparedSafeCodingAction,
  TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import {
  assessPromotion,
  validatePromotionProfile,
  type PromotionAssessment,
} from '@clodex/promotion';
import {
  ScopedRegistryService,
  type CurrentScopedRegistry,
} from '@clodex/registry';
import {
  PRODUCTION_AUTHORITY_DESCRIPTOR_KIND,
  PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND,
  PRODUCTION_AUTHORITY_VERSION,
  ProductionBootstrapError,
  type ProductionAdapterAuthorityPort,
  type ProductionAdapterCallbacks,
  type ProductionAdapterConfinementAttestation,
  type ProductionAuthorityBootstrapInput,
  type ProductionAuthorityDescriptor,
  type ProductionAuthorityDiagnostic,
  type ProductionAuthorityHandle,
  type ProductionBootstrapResult,
  type ProductionBootstrapStage,
  type ProductionControlPlaneCallbacks,
  type ProductionDeploymentBinding,
  type ProductionEffectFinalAuthorityPort,
  type ProductionHashPort,
  type ProductionOperationMembership,
  type ProductionRecoveryAdmission,
  type ProductionRecoveryPort,
  type ProductionReviewedGateDecision,
} from './production-model.js';
import {
  assertBindingMatchesMembership,
  bindingValuesEqual,
  dataValuesEqual,
  fail,
  hashProductionValue,
  pinMethod,
  readOwnData,
  requireCurrentTimestamp,
  requireSynchronousVoid,
  validateAdapterBinding,
  validateAdapterBindings,
  validateProductionAdapterAttestation,
  validateProductionDeploymentBinding,
  validateProductionOperationMemberships,
  validateProductionProtectedHeadProfile,
  validateProductionRecoveryAdmission,
  validateProductionRecoveryProfile,
  validateProductionReviewedGateDecision,
  validateRegistryExpectationForDeployment,
} from './production-validation.js';

const RECOVERY_RECORD_SET_HASH_DOMAIN =
  'clodex.production.recovery-record-set.v1';
const AUTHORITY_DESCRIPTOR_HASH_DOMAIN =
  'clodex.production.authority-descriptor.v1';

/**
 * Performs the complete admission pass before returning any authority-bearing
 * callback. All expected failures return `authority: null`; no feature gate is
 * mutated and no callback is published early.
 */
export async function bootstrapProductionAuthority(
  inputValue: ProductionAuthorityBootstrapInput,
): Promise<ProductionBootstrapResult> {
  let deploymentId: string | null = null;
  let promotionEligibility: PromotionAssessment['eligibility'] | null = null;
  let recoveryRecordCount: number | null = null;
  let recoveryUnresolvedCount: number | null = null;
  try {
    const input = snapshotBootstrapInput(inputValue);
    const deployment = validateProductionDeploymentBinding(
      input.expectedDeployment,
    );
    deploymentId = deployment.deploymentId;
    const now = pinMethod(input.clock, 'now', 'Production clock');
    const sha256 = pinMethod(input.hash, 'sha256', 'Production hash port');
    const hash = Object.freeze({ sha256 }) satisfies ProductionHashPort;

    const readDeployment = pinMethod(
      input.deployment,
      'readCurrent',
      'Deployment port',
    );
    const assertDeploymentCurrent = pinMethod(
      input.deployment,
      'assertCurrentSynchronously',
      'Deployment port',
    );
    let currentDeployment: ProductionDeploymentBinding;
    try {
      currentDeployment = validateProductionDeploymentBinding(
        await readDeployment(),
      );
    } catch (error) {
      fail(
        'deployment-unavailable',
        'deployment',
        'Current production deployment could not be admitted',
        error,
      );
    }
    if (!dataValuesEqual(currentDeployment, deployment)) {
      fail(
        'deployment-binding-mismatch',
        'deployment',
        'Current deployment differs from the pinned production deployment',
      );
    }
    invokeFence(
      () => assertDeploymentCurrent(deployment),
      'Deployment current fence',
    );

    const adapterScope = snapshotCapabilityScope(
      readOwnData(
        input.adapters,
        'capabilityScope',
        'Production adapter capability scope',
      ),
    );
    if (
      !capabilityScopeEquals(adapterScope, {
        workspaceId: deployment.workspaceId,
        taskId: deployment.taskId,
        rootObjectId: deployment.rootObjectId,
      })
    ) {
      fail(
        'adapter-binding-mismatch',
        'adapters',
        'Adapter capability scope differs from the production deployment',
      );
    }
    const readAdapterAttestation = pinMethod(
      input.adapters,
      'readConfinementAttestation',
      'Production adapter authority',
    );
    const adapterAttestation = validateProductionAdapterAttestation(
      await readAdapterAttestation(),
      deployment,
      requireCurrentTimestamp(now),
    );
    const assertAdapterCurrent = pinMethod(
      input.adapters,
      'assertConfinementCurrentSynchronously',
      'Production adapter authority',
    );
    invokeFence(
      () => assertAdapterCurrent(adapterAttestation),
      'Adapter confinement fence',
    );

    const protectedHeadProfile = validateProductionProtectedHeadProfile(
      readOwnData(
        input.registry.head,
        'protection',
        'Protected registry-head profile',
      ),
      deployment,
    );
    const assertHeadProtectionCurrent = pinMethod(
      input.registry.head,
      'assertProtectionCurrentSynchronously',
      'Protected registry head',
    );
    invokeFence(
      () => assertHeadProtectionCurrent(protectedHeadProfile),
      'Protected registry-head fence',
    );

    const adapterExpected = validateRegistryExpectationForDeployment(
      input.registry.manifests.adapter.expected,
      'adapter',
      deployment,
    );
    const runnerExpected = validateRegistryExpectationForDeployment(
      input.registry.manifests.runner.expected,
      'runner',
      deployment,
    );
    const effectExpected = validateRegistryExpectationForDeployment(
      input.registry.manifests.effect.expected,
      'effect',
      deployment,
    );
    const registryService = new ScopedRegistryService({
      hash,
      signatures: input.registry.signatures,
      head: input.registry.head,
      clock: input.clock,
    });
    let adapterRegistry: CurrentScopedRegistry;
    let runnerRegistry: CurrentScopedRegistry;
    let effectRegistry: CurrentScopedRegistry;
    try {
      adapterRegistry = (
        await registryService.admit({
          envelope: input.registry.manifests.adapter.envelope,
          expected: adapterExpected,
        })
      ).registry;
      runnerRegistry = (
        await registryService.admit({
          envelope: input.registry.manifests.runner.envelope,
          expected: runnerExpected,
        })
      ).registry;
      effectRegistry = (
        await registryService.admit({
          envelope: input.registry.manifests.effect.envelope,
          expected: effectExpected,
        })
      ).registry;
    } catch (error) {
      fail(
        'registry-admission-failed',
        'registries',
        'Signed scoped registry admission failed closed',
        error,
      );
    }

    const memberships = validateProductionOperationMemberships(
      input.registry.memberships,
    );
    assertSignedMemberships(
      memberships,
      adapterRegistry,
      runnerRegistry,
      effectRegistry,
    );
    assertRegistryTrustRoot(
      protectedHeadProfile.trustRootDigest,
      adapterRegistry,
      runnerRegistry,
      effectRegistry,
    );
    const bindings = validateAdapterBindings(
      readOwnData(input.adapters, 'bindings', 'Production adapter bindings'),
    );
    assertAdapterSetBindings(bindings, memberships, deployment);

    const promotionProfile = validatePromotionProfile(input.promotion.profile);
    if (
      input.promotion.expectedProfileDigest !==
        deployment.promotionProfileDigest ||
      promotionProfile.targetGateId !== deployment.targetGateId ||
      promotionProfile.environmentDigest !== deployment.environmentDigest ||
      promotionProfile.buildDigest !== deployment.buildDigest ||
      promotionProfile.configurationDigest !== deployment.configurationDigest ||
      promotionProfile.evidencePolicyDigest !== deployment.evidencePolicyDigest
    ) {
      fail(
        'promotion-invalid',
        'promotion',
        'Promotion profile does not match the production deployment',
      );
    }
    let promotionAssessment: PromotionAssessment;
    try {
      promotionAssessment = await assessPromotion({
        profile: promotionProfile,
        expectedProfileDigest: input.promotion.expectedProfileDigest,
        evidence: input.promotion.evidence,
        hash,
        clock: input.clock,
        trust: input.promotion.trust,
      });
    } catch (error) {
      fail(
        'promotion-invalid',
        'promotion',
        'Promotion evidence assessment failed closed',
        error,
      );
    }
    promotionEligibility = promotionAssessment.eligibility;
    if (
      promotionAssessment.eligibility !== 'eligible-for-reviewed-decision' ||
      promotionAssessment.blockers.length !== 0 ||
      promotionAssessment.automaticEnablement !== false
    ) {
      fail(
        'promotion-blocked',
        'promotion',
        'Promotion evidence is incomplete or not fully enforced',
      );
    }

    const readReviewedDecision = pinMethod(
      input.promotion.reviewedGate,
      'readReviewedDecision',
      'Reviewed production gate',
    );
    const decisionValue = await readReviewedDecision({
      deployment,
      assessment: promotionAssessment,
    });
    if (decisionValue === null) {
      fail(
        'reviewed-decision-missing',
        'reviewed-decision',
        'No explicit reviewed production gate decision is current',
      );
    }
    const reviewedDecision = validateProductionReviewedGateDecision(
      decisionValue,
      deployment,
      promotionAssessment,
      requireCurrentTimestamp(now),
    );
    const assertReviewedDecisionCurrent = pinMethod(
      input.promotion.reviewedGate,
      'assertCurrentSynchronously',
      'Reviewed production gate',
    );
    invokeFence(
      () =>
        assertReviewedDecisionCurrent(
          reviewedDecision,
          deployment,
          promotionAssessment,
        ),
      'Reviewed production gate fence',
    );

    const recoveryProfile = validateProductionRecoveryProfile(
      readOwnData(input.recovery, 'profile', 'Recovery barrier profile'),
      deployment,
    );
    const fence = createAuthorityFence({
      deployment,
      assertDeploymentCurrent,
      adapterAttestation,
      assertAdapterCurrent,
      protectedHeadProfile,
      assertHeadProtectionCurrent,
      adapterRegistry,
      runnerRegistry,
      effectRegistry,
      memberships,
      promotionAssessment,
      promotionTrust: input.promotion.trust,
      reviewedDecision,
      assertReviewedDecisionCurrent,
      recovery: input.recovery,
      now,
    });
    const controlPlane = constructControlPlane(input, fence);
    if (
      controlPlane.durability.mode !== 'adapter-declared-durable' ||
      controlPlane.durability.adapterId !==
        deployment.controlPlaneStorageAdapterId
    ) {
      fail(
        'control-plane-not-durable',
        'control-plane',
        'Production authority requires the exact durable control-plane adapter',
      );
    }

    let recoveryPass: readonly ControlPlaneRecoveryResult[];
    try {
      recoveryPass = await controlPlane.recoverAll();
    } catch (error) {
      fail(
        'recovery-failed',
        'recovery',
        'Durable control-plane recovery pass failed',
        error,
      );
    }
    const reconcile = pinMethod(
      input.recovery,
      'reconcile',
      'Production recovery port',
    );
    let recoveryAdmissionValue: unknown;
    try {
      recoveryAdmissionValue = await reconcile({
        deployment,
        recoveryPass,
        controlPlane: Object.freeze({
          scan: controlPlane.scan.bind(controlPlane),
          get: controlPlane.get.bind(controlPlane),
          deliverEvidence: controlPlane.deliverEvidence.bind(controlPlane),
        }),
      });
    } catch (error) {
      fail(
        'recovery-failed',
        'recovery',
        'Recovery reconciliation failed closed',
        error,
      );
    }
    const recoveredRecords = await controlPlane.scan();
    recoveryRecordCount = recoveredRecords.length;
    const unresolvedRecords = recoveredRecords.filter(
      (record) =>
        !isControlPlaneTerminalPhase(record.phase) ||
        record.evidenceOutbox.status !== 'DELIVERED',
    );
    recoveryUnresolvedCount = unresolvedRecords.length;
    if (unresolvedRecords.length !== 0) {
      fail(
        'recovery-unresolved',
        'recovery',
        'Authority publication is blocked by unresolved control-plane recovery',
      );
    }
    const recordSetDigest = hashProductionValue(
      RECOVERY_RECORD_SET_HASH_DOMAIN,
      recoveredRecords as unknown as CanonicalJsonValue,
      hash,
    );
    const recoveryAdmission = validateProductionRecoveryAdmission(
      recoveryAdmissionValue,
      deployment,
      recoveryProfile,
      {
        recordSetDigest,
        recordCount: recoveredRecords.length,
        recoveredMutationCount: recoveryPass.filter((item) => item.mutated)
          .length,
        uncertainRecordCount: recoveredRecords.filter(
          (record) => record.phase === 'UNCERTAIN',
        ).length,
      },
      requireCurrentTimestamp(now),
    );
    fence.armRecovery(recoveryAdmission);
    fence.assertExecutionCurrent();

    const descriptor = createAuthorityDescriptor({
      deployment,
      promotionAssessment,
      reviewedDecision,
      recoveryAdmission,
      hash,
    });
    const authority = createAuthorityHandle({
      descriptor,
      controlPlane,
      adapters: input.adapters,
      bindings,
      memberships,
      fence,
    });
    const diagnostic = readyDiagnostic(
      descriptor,
      promotionAssessment,
      recoveredRecords.length,
    );
    return Object.freeze({ authority, diagnostic });
  } catch (error) {
    const failure =
      error instanceof ProductionBootstrapError
        ? error
        : new ProductionBootstrapError(
            'unexpected-failure',
            'input',
            'Production bootstrap failed closed',
            error,
          );
    return Object.freeze({
      authority: null,
      diagnostic: disabledDiagnostic({
        failure,
        deploymentId,
        promotionEligibility,
        recoveryRecordCount,
        recoveryUnresolvedCount,
      }),
    });
  }
}

interface BootstrapInputSnapshot {
  readonly expectedDeployment: unknown;
  readonly deployment: ProductionAuthorityBootstrapInput['deployment'];
  readonly clock: ProductionAuthorityBootstrapInput['clock'];
  readonly hash: ProductionAuthorityBootstrapInput['hash'];
  readonly registry: ProductionAuthorityBootstrapInput['registry'];
  readonly adapters: ProductionAuthorityBootstrapInput['adapters'];
  readonly promotion: ProductionAuthorityBootstrapInput['promotion'];
  readonly controlPlane: ProductionAuthorityBootstrapInput['controlPlane'];
  readonly recovery: ProductionAuthorityBootstrapInput['recovery'];
}

function snapshotBootstrapInput(
  input: ProductionAuthorityBootstrapInput,
): BootstrapInputSnapshot {
  return Object.freeze({
    expectedDeployment: readOwnData(
      input,
      'expectedDeployment',
      'Expected deployment binding',
    ),
    deployment: readOwnData<ProductionAuthorityBootstrapInput['deployment']>(
      input,
      'deployment',
      'Deployment port',
    ),
    clock: readOwnData<ProductionAuthorityBootstrapInput['clock']>(
      input,
      'clock',
      'Production clock',
    ),
    hash: readOwnData<ProductionAuthorityBootstrapInput['hash']>(
      input,
      'hash',
      'Production hash port',
    ),
    registry: readOwnData<ProductionAuthorityBootstrapInput['registry']>(
      input,
      'registry',
      'Production registry input',
    ),
    adapters: readOwnData<ProductionAuthorityBootstrapInput['adapters']>(
      input,
      'adapters',
      'Production adapter authority',
    ),
    promotion: readOwnData<ProductionAuthorityBootstrapInput['promotion']>(
      input,
      'promotion',
      'Production promotion input',
    ),
    controlPlane: readOwnData<
      ProductionAuthorityBootstrapInput['controlPlane']
    >(input, 'controlPlane', 'Production control-plane input'),
    recovery: readOwnData<ProductionAuthorityBootstrapInput['recovery']>(
      input,
      'recovery',
      'Production recovery port',
    ),
  });
}

function constructControlPlane(
  input: BootstrapInputSnapshot,
  fence: AuthorityFence,
): ExecutionControlPlane {
  const basePermits = readOwnData<CommitPermitAuthorityPort>(
    input.controlPlane,
    'commitPermits',
    'COMMIT_PERMIT authority port',
  );
  const verifyPermit = pinMethod(
    basePermits,
    'verifySynchronously',
    'COMMIT_PERMIT authority port',
  );
  const assertPermitTrusted = pinMethod(
    basePermits,
    'assertTrustedSynchronously',
    'COMMIT_PERMIT authority port',
  );
  const commitPermits: CommitPermitAuthorityPort = Object.freeze({
    verifySynchronously: (
      envelope: Parameters<CommitPermitAuthorityPort['verifySynchronously']>[0],
      binding: Parameters<CommitPermitAuthorityPort['verifySynchronously']>[1],
    ) => {
      const result = verifyPermit(envelope, binding);
      fence.assertExecutionCurrent();
      return result;
    },
    assertTrustedSynchronously: (
      permit: Parameters<
        CommitPermitAuthorityPort['assertTrustedSynchronously']
      >[0],
      binding: Parameters<
        CommitPermitAuthorityPort['assertTrustedSynchronously']
      >[1],
    ) => {
      requireSynchronousVoid(
        assertPermitTrusted(permit, binding),
        'Base COMMIT_PERMIT trust fence',
      );
      fence.assertExecutionCurrent();
    },
  });
  const baseEvidence = readOwnData<EvidenceAdmissionReceiptPort>(
    input.controlPlane,
    'evidenceReceipts',
    'Evidence receipt authority port',
  );
  const verifyEvidence = pinMethod(
    baseEvidence,
    'verifySynchronously',
    'Evidence receipt authority port',
  );
  const assertEvidenceTrusted = pinMethod(
    baseEvidence,
    'assertTrustedSynchronously',
    'Evidence receipt authority port',
  );
  const evidenceReceipts: EvidenceAdmissionReceiptPort = Object.freeze({
    verifySynchronously: (
      envelope: Parameters<
        EvidenceAdmissionReceiptPort['verifySynchronously']
      >[0],
      binding: Parameters<
        EvidenceAdmissionReceiptPort['verifySynchronously']
      >[1],
    ) => verifyEvidence(envelope, binding),
    assertTrustedSynchronously: (
      receipt: Parameters<
        EvidenceAdmissionReceiptPort['assertTrustedSynchronously']
      >[0],
      binding: Parameters<
        EvidenceAdmissionReceiptPort['assertTrustedSynchronously']
      >[1],
    ) => {
      requireSynchronousVoid(
        assertEvidenceTrusted(receipt, binding),
        'Evidence receipt trust fence',
      );
    },
  });
  try {
    return new ExecutionControlPlane({
      storage: readOwnData(
        input.controlPlane,
        'storage',
        'Control-plane storage',
      ),
      clock: input.clock,
      commitPermits,
      evidenceReceipts,
    });
  } catch (error) {
    fail(
      'control-plane-construction-failed',
      'control-plane',
      'Production control plane could not be constructed',
      error,
    );
  }
}

interface AuthorityFence {
  armRecovery(admission: ProductionRecoveryAdmission): void;
  assertExecutionCurrent(): void;
}

function createAuthorityFence(input: {
  readonly deployment: ProductionDeploymentBinding;
  readonly assertDeploymentCurrent: (
    expected: ProductionDeploymentBinding,
  ) => void;
  readonly adapterAttestation: ProductionAdapterConfinementAttestation;
  readonly assertAdapterCurrent: (
    attestation: ProductionAdapterConfinementAttestation,
  ) => void;
  readonly protectedHeadProfile: ReturnType<
    typeof validateProductionProtectedHeadProfile
  >;
  readonly assertHeadProtectionCurrent: (
    expected: ReturnType<typeof validateProductionProtectedHeadProfile>,
  ) => void;
  readonly adapterRegistry: CurrentScopedRegistry;
  readonly runnerRegistry: CurrentScopedRegistry;
  readonly effectRegistry: CurrentScopedRegistry;
  readonly memberships: readonly ProductionOperationMembership[];
  readonly promotionAssessment: PromotionAssessment;
  readonly promotionTrust: ProductionAuthorityBootstrapInput['promotion']['trust'];
  readonly reviewedDecision: ProductionReviewedGateDecision;
  readonly assertReviewedDecisionCurrent: (
    decision: ProductionReviewedGateDecision,
    deployment: ProductionDeploymentBinding,
    assessment: PromotionAssessment,
  ) => void;
  readonly recovery: ProductionRecoveryPort;
  readonly now: () => string;
}): AuthorityFence {
  const assertPromotionCurrent = pinMethod(
    input.promotionTrust,
    'assertCurrent',
    'Promotion evidence trust port',
  );
  const assertRecoveryResolved = pinMethod(
    input.recovery,
    'assertResolvedSynchronously',
    'Production recovery port',
  );
  let recoveryAdmission: ProductionRecoveryAdmission | null = null;
  return Object.freeze({
    armRecovery(admission: ProductionRecoveryAdmission): void {
      if (recoveryAdmission !== null) {
        fail(
          'recovery-unresolved',
          'recovery',
          'Recovery admission can only be armed once',
        );
      }
      recoveryAdmission = admission;
    },
    assertExecutionCurrent(): void {
      const admission = recoveryAdmission;
      if (admission === null) {
        fail(
          'recovery-unresolved',
          'recovery',
          'Execution authority is unavailable before recovery admission',
        );
      }
      validateProductionAdapterAttestation(
        input.adapterAttestation,
        input.deployment,
        requireCurrentTimestamp(input.now),
      );
      validateProductionReviewedGateDecision(
        input.reviewedDecision,
        input.deployment,
        input.promotionAssessment,
        requireCurrentTimestamp(input.now),
      );
      invokeFence(
        () => input.assertDeploymentCurrent(input.deployment),
        'Deployment current fence',
      );
      invokeFence(
        () => input.assertAdapterCurrent(input.adapterAttestation),
        'Adapter confinement fence',
      );
      invokeFence(
        () => input.assertHeadProtectionCurrent(input.protectedHeadProfile),
        'Protected registry-head fence',
      );
      assertSignedMemberships(
        input.memberships,
        input.adapterRegistry,
        input.runnerRegistry,
        input.effectRegistry,
      );
      assertRegistryTrustRoot(
        input.protectedHeadProfile.trustRootDigest,
        input.adapterRegistry,
        input.runnerRegistry,
        input.effectRegistry,
      );
      invokeFence(
        () =>
          assertPromotionCurrent({
            profileDigest: input.promotionAssessment.profileDigest,
            evidenceBundleDigest:
              input.promotionAssessment.evidenceBundleDigest,
            environmentDigest: input.deployment.environmentDigest,
            buildDigest: input.deployment.buildDigest,
            configurationDigest: input.deployment.configurationDigest,
            evidencePolicyDigest: input.deployment.evidencePolicyDigest,
            evaluatedAt: input.promotionAssessment.evaluatedAt,
          }),
        'Promotion evidence final fence',
      );
      invokeFence(
        () =>
          input.assertReviewedDecisionCurrent(
            input.reviewedDecision,
            input.deployment,
            input.promotionAssessment,
          ),
        'Reviewed production gate fence',
      );
      invokeFence(
        () => assertRecoveryResolved(admission, input.deployment),
        'Recovery barrier final fence',
      );
    },
  });
}

function assertSignedMemberships(
  memberships: readonly ProductionOperationMembership[],
  adapterRegistry: CurrentScopedRegistry,
  runnerRegistry: CurrentScopedRegistry,
  effectRegistry: CurrentScopedRegistry,
): void {
  for (const membership of memberships) {
    if (
      adapterRegistry.resolveAdapter(membership.adapter) === null ||
      effectRegistry.resolveEffect(membership.effect) === null ||
      (membership.runner !== null &&
        runnerRegistry.resolveRunner(membership.runner) === null)
    ) {
      fail(
        'registry-membership-mismatch',
        'registries',
        `Signed registry membership is missing for ${membership.operation}`,
      );
    }
  }
  adapterRegistry.assertCurrent();
  runnerRegistry.assertCurrent();
  effectRegistry.assertCurrent();
}

function assertRegistryTrustRoot(
  trustRootDigest: string,
  adapterRegistry: CurrentScopedRegistry,
  runnerRegistry: CurrentScopedRegistry,
  effectRegistry: CurrentScopedRegistry,
): void {
  if (
    adapterRegistry.signer.trustRegistryDigest !== trustRootDigest ||
    runnerRegistry.signer.trustRegistryDigest !== trustRootDigest ||
    effectRegistry.signer.trustRegistryDigest !== trustRootDigest ||
    adapterRegistry.signer.trustEpoch !== runnerRegistry.signer.trustEpoch ||
    adapterRegistry.signer.trustEpoch !== effectRegistry.signer.trustEpoch
  ) {
    fail(
      'protected-head-insufficient',
      'protected-head',
      'Registry signer snapshots do not share one protected trust-root epoch',
    );
  }
}

function assertAdapterSetBindings(
  bindings: readonly TrustedSafeCodingAdapterBinding[],
  memberships: readonly ProductionOperationMembership[],
  deployment: ProductionDeploymentBinding,
): void {
  if (bindings.length !== memberships.length) {
    fail(
      'adapter-binding-mismatch',
      'adapters',
      'Every configured adapter must have one exact signed membership',
    );
  }
  for (const membership of memberships) {
    const binding = bindings.find(
      (candidate) => candidate.action === membership.operation,
    );
    if (binding === undefined) {
      fail(
        'adapter-binding-mismatch',
        'adapters',
        `Adapter binding is missing for ${membership.operation}`,
      );
    }
    assertBindingMatchesMembership(binding, membership, deployment);
  }
}

function createAuthorityDescriptor(input: {
  readonly deployment: ProductionDeploymentBinding;
  readonly promotionAssessment: PromotionAssessment;
  readonly reviewedDecision: ProductionReviewedGateDecision;
  readonly recoveryAdmission: ProductionRecoveryAdmission;
  readonly hash: ProductionHashPort;
}): ProductionAuthorityDescriptor {
  const body = Object.freeze({
    kind: PRODUCTION_AUTHORITY_DESCRIPTOR_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    deploymentId: input.deployment.deploymentId,
    workspaceId: input.deployment.workspaceId,
    taskId: input.deployment.taskId,
    rootObjectId: input.deployment.rootObjectId,
    environmentDigest: input.deployment.environmentDigest,
    platformDigest: input.deployment.platformDigest,
    buildDigest: input.deployment.buildDigest,
    configurationDigest: input.deployment.configurationDigest,
    policyDigest: input.deployment.policyDigest,
    adapterRegistryManifestHash: input.deployment.adapterRegistryManifestHash,
    runnerRegistryManifestHash: input.deployment.runnerRegistryManifestHash,
    effectRegistryManifestHash: input.deployment.effectRegistryManifestHash,
    promotionProfileDigest: input.promotionAssessment.profileDigest,
    promotionAssessmentDigest: input.promotionAssessment.assessmentDigest,
    evidenceBundleDigest: input.promotionAssessment.evidenceBundleDigest,
    reviewedDecisionId: input.reviewedDecision.decisionId,
    recoveryAdmissionId: input.recoveryAdmission.admissionId,
    recoveryRecordSetDigest: input.recoveryAdmission.recordSetDigest,
    controlPlaneStorageAdapterId: input.deployment.controlPlaneStorageAdapterId,
    authorityGateDefault: 'off' as const,
    automaticPromotion: false as const,
  });
  const authorityId = `authority:${hashProductionValue(
    AUTHORITY_DESCRIPTOR_HASH_DOMAIN,
    body,
    input.hash,
  )}`;
  return Object.freeze({ ...body, authorityId });
}

function createAuthorityHandle(input: {
  readonly descriptor: ProductionAuthorityDescriptor;
  readonly controlPlane: ExecutionControlPlane;
  readonly adapters: ProductionAdapterAuthorityPort;
  readonly bindings: readonly TrustedSafeCodingAdapterBinding[];
  readonly memberships: readonly ProductionOperationMembership[];
  readonly fence: AuthorityFence;
}): ProductionAuthorityHandle {
  const resolveGuardian = pinMethod(
    input.adapters.guardianAdapters,
    'resolve',
    'Guardian adapter registry',
  );
  const prepareGuardian = pinMethod(
    input.adapters.guardianPrepare,
    'prepare',
    'Guardian adapter PREPARE port',
  );
  const executeAdapterEffect = pinMethod(
    input.adapters,
    'executeControlPlaneEffectOnce',
    'Production adapter effect port',
  );
  const expectedBinding = (
    action: SafeCodingAction,
  ): TrustedSafeCodingAdapterBinding | null => {
    const membership = input.memberships.find(
      (candidate) => candidate.operation === action.action,
    );
    if (membership === undefined) return null;
    return (
      input.bindings.find(
        (candidate) => candidate.action === membership.operation,
      ) ?? null
    );
  };
  const adapters: ProductionAdapterCallbacks = Object.freeze({
    async resolveAuthorizationBinding(actionValue: SafeCodingAction) {
      const action = validateSafeCodingAction(actionValue);
      input.fence.assertExecutionCurrent();
      const candidate = await resolveGuardian(action);
      if (candidate === null) return null;
      const binding = validateAdapterBinding(candidate);
      const expected = expectedBinding(action);
      if (expected === null || !bindingValuesEqual(binding, expected)) {
        fail(
          'adapter-binding-mismatch',
          'adapters',
          'Resolved authorization adapter is outside signed production membership',
        );
      }
      input.fence.assertExecutionCurrent();
      return binding;
    },
    async prepareAuthorization(
      actionValue: SafeCodingAction,
      bindingValue: TrustedSafeCodingAdapterBinding,
    ) {
      const action = validateSafeCodingAction(actionValue);
      const binding = validateAdapterBinding(bindingValue);
      const expected = expectedBinding(action);
      if (expected === null || !bindingValuesEqual(binding, expected)) {
        fail(
          'adapter-binding-mismatch',
          'adapters',
          'PREPARE adapter binding is outside signed production membership',
        );
      }
      input.fence.assertExecutionCurrent();
      const prepared = await prepareGuardian(action, binding);
      input.fence.assertExecutionCurrent();
      return prepared as PreparedSafeCodingAction;
    },
  });

  const fixedEffect: ControlPlaneEffectPort = Object.freeze({
    async executeOnce(
      request: Parameters<ControlPlaneEffectPort['executeOnce']>[0],
    ) {
      input.fence.assertExecutionCurrent();
      if (
        !input.memberships.some(
          (membership) =>
            membership.adapter.adapterId === request.adapterId &&
            membership.adapter.adapterDigest === request.adapterDigest,
        )
      ) {
        fail(
          'adapter-binding-mismatch',
          'adapters',
          'Control-plane effect request is outside signed adapter membership',
        );
      }
      const finalAuthorityState: {
        value: 'armed' | 'accepted' | 'rejected' | 'closed';
      } = { value: 'armed' };
      const readFinalAuthorityState = (): typeof finalAuthorityState.value =>
        finalAuthorityState.value;
      const finalAuthority: ProductionEffectFinalAuthorityPort = Object.freeze({
        assertFinalAuthoritySynchronously(
          assertedRequest: Parameters<
            ProductionEffectFinalAuthorityPort['assertFinalAuthoritySynchronously']
          >[0],
        ): void {
          if (
            finalAuthorityState.value !== 'armed' ||
            assertedRequest !== request
          ) {
            finalAuthorityState.value = 'rejected';
            fail(
              'final-fence-failed',
              'final-fence',
              'Adapter final authority capability is one-shot and request-bound',
            );
          }
          try {
            input.fence.assertExecutionCurrent();
            finalAuthorityState.value = 'accepted';
          } catch (error) {
            finalAuthorityState.value = 'rejected';
            throw error;
          }
        },
      });
      try {
        const observation = await executeAdapterEffect(request, finalAuthority);
        if (readFinalAuthorityState() !== 'accepted') {
          fail(
            'final-fence-failed',
            'final-fence',
            'Adapter did not consume final authority exactly once at dispatch',
          );
        }
        return observation;
      } finally {
        finalAuthorityState.value = 'closed';
      }
    },
  });

  const controlPlane: ProductionControlPlaneCallbacks = Object.freeze({
    prepare: async (
      value: Parameters<ProductionControlPlaneCallbacks['prepare']>[0],
    ) => {
      input.fence.assertExecutionCurrent();
      if (
        !input.memberships.some(
          (membership) =>
            membership.adapter.adapterId === value.adapterId &&
            membership.adapter.adapterDigest === value.adapterDigest,
        )
      ) {
        fail(
          'adapter-binding-mismatch',
          'adapters',
          'Prepared control-plane record is outside signed adapter membership',
        );
      }
      return await input.controlPlane.prepare(value);
    },
    consumeCommitPermit: async (
      value: Parameters<
        ProductionControlPlaneCallbacks['consumeCommitPermit']
      >[0],
    ) => {
      input.fence.assertExecutionCurrent();
      return await input.controlPlane.consumeCommitPermit(value);
    },
    executeOnce: async (
      value: Parameters<ProductionControlPlaneCallbacks['executeOnce']>[0],
    ) => {
      input.fence.assertExecutionCurrent();
      return await input.controlPlane.executeOnce({
        ...value,
        effect: fixedEffect,
      });
    },
    // Terminal closure remains callable after a later gate revocation.
    abortPrepared: input.controlPlane.abortPrepared.bind(input.controlPlane),
    deliverEvidence: input.controlPlane.deliverEvidence.bind(
      input.controlPlane,
    ),
    get: input.controlPlane.get.bind(input.controlPlane),
    pendingEvidence: input.controlPlane.pendingEvidence.bind(
      input.controlPlane,
    ),
  });
  return Object.freeze({
    descriptor: input.descriptor,
    controlPlane,
    adapters,
    assertCurrentSynchronously: input.fence.assertExecutionCurrent,
  });
}

function invokeFence(fence: () => unknown, label: string): void {
  try {
    requireSynchronousVoid(fence(), label);
  } catch (error) {
    if (error instanceof ProductionBootstrapError) throw error;
    fail(
      'final-fence-failed',
      'final-fence',
      `${label} rejected current authority`,
      error,
    );
  }
}

function readyDiagnostic(
  descriptor: ProductionAuthorityDescriptor,
  assessment: PromotionAssessment,
  recoveryRecordCount: number,
): ProductionAuthorityDiagnostic {
  return Object.freeze({
    kind: PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    status: 'ready',
    authorityPublished: true,
    authorityGateDefault: 'off',
    automaticPromotion: false,
    stage: 'ready',
    blockerCode: null,
    blockerName: null,
    deploymentId: descriptor.deploymentId,
    authorityId: descriptor.authorityId,
    promotionEligibility: assessment.eligibility,
    recoveryRecordCount,
    recoveryUnresolvedCount: 0,
  });
}

function disabledDiagnostic(input: {
  readonly failure: ProductionBootstrapError;
  readonly deploymentId: string | null;
  readonly promotionEligibility: PromotionAssessment['eligibility'] | null;
  readonly recoveryRecordCount: number | null;
  readonly recoveryUnresolvedCount: number | null;
}): ProductionAuthorityDiagnostic {
  return Object.freeze({
    kind: PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    status: 'disabled',
    authorityPublished: false,
    authorityGateDefault: 'off',
    automaticPromotion: false,
    stage: input.failure.stage as ProductionBootstrapStage,
    blockerCode: input.failure.code,
    blockerName:
      input.failure.originalCause instanceof Error
        ? input.failure.originalCause.name
        : input.failure.name,
    deploymentId: input.deploymentId,
    authorityId: null,
    promotionEligibility: input.promotionEligibility,
    recoveryRecordCount: input.recoveryRecordCount,
    recoveryUnresolvedCount: input.recoveryUnresolvedCount,
  });
}
