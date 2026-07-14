import {
  canonicalizeJson,
  encodeUtf8,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type SafeCodingEffectClass,
} from '@clodex/contracts';
import type { TrustedSafeCodingAdapterBinding } from '@clodex/guardian';
import type { PromotionAssessment } from '@clodex/promotion';
import {
  validateAdapterRegistryMember,
  validateEffectRegistryMember,
  validateRegistryManifestExpectation,
  validateRunnerRegistryMember,
  type RegistryManifestExpectation,
} from '@clodex/registry';
import {
  PRODUCTION_ADAPTER_ATTESTATION_KIND,
  PRODUCTION_AUTHORITY_VERSION,
  PRODUCTION_DEPLOYMENT_BINDING_KIND,
  PRODUCTION_GATE_DECISION_KIND,
  PRODUCTION_PROTECTED_HEAD_KIND,
  PRODUCTION_RECOVERY_ADMISSION_KIND,
  PRODUCTION_RECOVERY_PROFILE_KIND,
  ProductionBootstrapError,
  type ProductionAdapterConfinementAttestation,
  type ProductionBootstrapBlockerCode,
  type ProductionBootstrapStage,
  type ProductionDeploymentBinding,
  type ProductionHashPort,
  type ProductionOperationMembership,
  type ProductionProtectedRegistryHeadProfile,
  type ProductionRecoveryAdmission,
  type ProductionRecoveryBarrierProfile,
  type ProductionReviewedGateDecision,
} from './production-model.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,255}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const SUPPORTED_OPERATIONS = Object.freeze([
  'filesystem.create',
  'filesystem.mkdir',
  'filesystem.replace',
  'git.diff',
  'git.status',
  'test.run',
] as const);

export function validateProductionDeploymentBinding(
  value: unknown,
): ProductionDeploymentBinding {
  const record = requireClosedRecord(
    value,
    [
      'adapterAuthorityProfileDigest',
      'adapterRegistryManifestHash',
      'buildDigest',
      'configurationDigest',
      'controlPlaneStorageAdapterId',
      'deploymentId',
      'effectRegistryManifestHash',
      'environmentDigest',
      'evidencePolicyDigest',
      'kind',
      'platformDigest',
      'policyDigest',
      'promotionProfileDigest',
      'rootObjectId',
      'runnerRegistryManifestHash',
      'targetGateId',
      'taskId',
      'version',
      'workspaceId',
    ],
    'Production deployment binding',
  );
  requireLiteral(
    record.kind,
    PRODUCTION_DEPLOYMENT_BINDING_KIND,
    'Production deployment kind',
  );
  requireLiteral(
    record.version,
    PRODUCTION_AUTHORITY_VERSION,
    'Production deployment version',
  );
  return deepFreeze({
    kind: PRODUCTION_DEPLOYMENT_BINDING_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    deploymentId: requireIdentifier(record.deploymentId, 'Deployment ID'),
    workspaceId: requireIdentifier(record.workspaceId, 'Workspace ID'),
    taskId: requireIdentifier(record.taskId, 'Task ID'),
    rootObjectId: requireIdentifier(record.rootObjectId, 'Root object ID'),
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Environment digest',
    ),
    platformDigest: requireDigest(record.platformDigest, 'Platform digest'),
    buildDigest: requireDigest(record.buildDigest, 'Build digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Configuration digest',
    ),
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    evidencePolicyDigest: requireDigest(
      record.evidencePolicyDigest,
      'Evidence policy digest',
    ),
    adapterAuthorityProfileDigest: requireDigest(
      record.adapterAuthorityProfileDigest,
      'Adapter authority profile digest',
    ),
    adapterRegistryManifestHash: requireDigest(
      record.adapterRegistryManifestHash,
      'Adapter registry manifest hash',
    ),
    runnerRegistryManifestHash: requireDigest(
      record.runnerRegistryManifestHash,
      'Runner registry manifest hash',
    ),
    effectRegistryManifestHash: requireDigest(
      record.effectRegistryManifestHash,
      'Effect registry manifest hash',
    ),
    promotionProfileDigest: requireDigest(
      record.promotionProfileDigest,
      'Promotion profile digest',
    ),
    targetGateId: requireIdentifier(record.targetGateId, 'Target gate ID'),
    controlPlaneStorageAdapterId: requireIdentifier(
      record.controlPlaneStorageAdapterId,
      'Control-plane storage adapter ID',
    ),
  });
}

export function validateProductionAdapterAttestation(
  value: unknown,
  deployment: ProductionDeploymentBinding,
  now: string,
): ProductionAdapterConfinementAttestation {
  const record = requireClosedRecord(
    value,
    [
      'arbitraryCommandApi',
      'arbitraryHostFilesystemApi',
      'attestationId',
      'buildDigest',
      'configurationDigest',
      'deploymentId',
      'descriptorRelativeFilesystem',
      'environmentDigest',
      'exactStateCas',
      'expiresAt',
      'featureGateDefault',
      'fileAndDirectoryFsync',
      'finalAuthorityFenceInsideSerializedDispatch',
      'gitBoundedOutputAndTimeout',
      'gitNoShellHooksPagerExternalDiffTextconvCredentialsOrNetwork',
      'kind',
      'openat2BeneathNoSymlinksNoMagicLinksNoMountEscape',
      'platform',
      'platformDigest',
      'policyDigest',
      'profileDigest',
      'profileId',
      'rootObjectId',
      'taskId',
      'testCapabilitiesDroppedAndNoNewPrivileges',
      'testDigestPinnedPullNever',
      'testNetworkAndCredentialsDisabled',
      'testReadOnlyWorkspaceAndDisposableScratch',
      'verificationEvidenceDigest',
      'verifiedAt',
      'verifierId',
      'version',
      'workspaceId',
    ],
    'Production adapter confinement attestation',
  );
  requireLiteral(
    record.kind,
    PRODUCTION_ADAPTER_ATTESTATION_KIND,
    'Adapter attestation kind',
  );
  requireLiteral(
    record.version,
    PRODUCTION_AUTHORITY_VERSION,
    'Adapter attestation version',
  );
  requireLiteral(record.platform, 'linux', 'Adapter platform');
  requireLiteral(
    record.descriptorRelativeFilesystem,
    true,
    'Descriptor-relative filesystem enforcement',
  );
  requireLiteral(
    record.openat2BeneathNoSymlinksNoMagicLinksNoMountEscape,
    true,
    'openat2 confinement enforcement',
  );
  requireLiteral(record.exactStateCas, true, 'Exact-state CAS enforcement');
  requireLiteral(
    record.fileAndDirectoryFsync,
    true,
    'Filesystem durability enforcement',
  );
  requireLiteral(
    record.gitNoShellHooksPagerExternalDiffTextconvCredentialsOrNetwork,
    true,
    'Hardened Git enforcement',
  );
  requireLiteral(
    record.gitBoundedOutputAndTimeout,
    true,
    'Git resource-bound enforcement',
  );
  requireLiteral(
    record.testDigestPinnedPullNever,
    true,
    'Digest-pinned test image enforcement',
  );
  requireLiteral(
    record.testNetworkAndCredentialsDisabled,
    true,
    'Test network/credential denial',
  );
  requireLiteral(
    record.testReadOnlyWorkspaceAndDisposableScratch,
    true,
    'Test workspace/scratch confinement',
  );
  requireLiteral(
    record.testCapabilitiesDroppedAndNoNewPrivileges,
    true,
    'Test privilege confinement',
  );
  requireLiteral(
    record.finalAuthorityFenceInsideSerializedDispatch,
    true,
    'Final authority fence inside serialized dispatch',
  );
  requireLiteral(
    record.arbitraryHostFilesystemApi,
    false,
    'Arbitrary host filesystem API',
  );
  requireLiteral(record.arbitraryCommandApi, false, 'Arbitrary command API');
  requireLiteral(record.featureGateDefault, false, 'Feature-gate default');

  const attestation = deepFreeze({
    kind: PRODUCTION_ADAPTER_ATTESTATION_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    attestationId: requireIdentifier(record.attestationId, 'Attestation ID'),
    verifierId: requireIdentifier(record.verifierId, 'Verifier ID'),
    verificationEvidenceDigest: requireDigest(
      record.verificationEvidenceDigest,
      'Verification evidence digest',
    ),
    deploymentId: requireIdentifier(record.deploymentId, 'Deployment ID'),
    workspaceId: requireIdentifier(record.workspaceId, 'Workspace ID'),
    taskId: requireIdentifier(record.taskId, 'Task ID'),
    rootObjectId: requireIdentifier(record.rootObjectId, 'Root object ID'),
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Environment digest',
    ),
    platformDigest: requireDigest(record.platformDigest, 'Platform digest'),
    buildDigest: requireDigest(record.buildDigest, 'Build digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Configuration digest',
    ),
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    profileId: requireIdentifier(record.profileId, 'Adapter profile ID'),
    profileDigest: requireDigest(
      record.profileDigest,
      'Adapter profile digest',
    ),
    platform: 'linux' as const,
    descriptorRelativeFilesystem: true as const,
    openat2BeneathNoSymlinksNoMagicLinksNoMountEscape: true as const,
    exactStateCas: true as const,
    fileAndDirectoryFsync: true as const,
    gitNoShellHooksPagerExternalDiffTextconvCredentialsOrNetwork: true as const,
    gitBoundedOutputAndTimeout: true as const,
    testDigestPinnedPullNever: true as const,
    testNetworkAndCredentialsDisabled: true as const,
    testReadOnlyWorkspaceAndDisposableScratch: true as const,
    testCapabilitiesDroppedAndNoNewPrivileges: true as const,
    finalAuthorityFenceInsideSerializedDispatch: true as const,
    arbitraryHostFilesystemApi: false as const,
    arbitraryCommandApi: false as const,
    featureGateDefault: false as const,
    verifiedAt: requireTimestamp(record.verifiedAt, 'Attestation verifiedAt'),
    expiresAt: requireTimestamp(record.expiresAt, 'Attestation expiresAt'),
  });
  assertTimeWindow(
    attestation.verifiedAt,
    attestation.expiresAt,
    now,
    'Adapter attestation',
  );
  assertAdapterAttestationBinding(attestation, deployment);
  return attestation;
}

export function validateProductionProtectedHeadProfile(
  value: unknown,
  deployment: ProductionDeploymentBinding,
): ProductionProtectedRegistryHeadProfile {
  const record = requireClosedRecord(
    value,
    [
      'antiRollback',
      'deploymentId',
      'durable',
      'environmentDigest',
      'independentlyProtected',
      'kind',
      'linearizable',
      'multiProcess',
      'platformDigest',
      'serviceId',
      'synchronousFinalFence',
      'trustRootDigest',
      'version',
    ],
    'Protected registry-head profile',
  );
  requireLiteral(
    record.kind,
    PRODUCTION_PROTECTED_HEAD_KIND,
    'Protected-head profile kind',
  );
  requireLiteral(
    record.version,
    PRODUCTION_AUTHORITY_VERSION,
    'Protected-head profile version',
  );
  for (const [name, value_] of [
    ['linearizable', record.linearizable],
    ['durable', record.durable],
    ['multiProcess', record.multiProcess],
    ['independentlyProtected', record.independentlyProtected],
    ['antiRollback', record.antiRollback],
    ['synchronousFinalFence', record.synchronousFinalFence],
  ] as const) {
    requireLiteral(value_, true, `Protected-head ${name}`);
  }
  const profile = deepFreeze({
    kind: PRODUCTION_PROTECTED_HEAD_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    serviceId: requireIdentifier(record.serviceId, 'Protected-head service ID'),
    deploymentId: requireIdentifier(record.deploymentId, 'Deployment ID'),
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Environment digest',
    ),
    platformDigest: requireDigest(record.platformDigest, 'Platform digest'),
    trustRootDigest: requireDigest(record.trustRootDigest, 'Trust-root digest'),
    linearizable: true as const,
    durable: true as const,
    multiProcess: true as const,
    independentlyProtected: true as const,
    antiRollback: true as const,
    synchronousFinalFence: true as const,
  });
  if (
    profile.deploymentId !== deployment.deploymentId ||
    profile.environmentDigest !== deployment.environmentDigest ||
    profile.platformDigest !== deployment.platformDigest
  ) {
    fail(
      'protected-head-insufficient',
      'protected-head',
      'Protected registry head is bound to another deployment or platform',
    );
  }
  return profile;
}

export function validateProductionRecoveryProfile(
  value: unknown,
  deployment: ProductionDeploymentBinding,
): ProductionRecoveryBarrierProfile {
  const record = requireClosedRecord(
    value,
    [
      'authorityPublicationSerialized',
      'barrierId',
      'buildDigest',
      'configurationDigest',
      'deploymentId',
      'effectReplayForbidden',
      'environmentDigest',
      'evidenceReceiptReverification',
      'kind',
      'policyDigest',
      'restartScanBeforeAuthority',
      'synchronousFinalFence',
      'uncertainEffectReconciliation',
      'version',
    ],
    'Production recovery-barrier profile',
  );
  requireLiteral(
    record.kind,
    PRODUCTION_RECOVERY_PROFILE_KIND,
    'Recovery profile kind',
  );
  requireLiteral(
    record.version,
    PRODUCTION_AUTHORITY_VERSION,
    'Recovery profile version',
  );
  for (const [name, value_] of [
    ['restartScanBeforeAuthority', record.restartScanBeforeAuthority],
    ['evidenceReceiptReverification', record.evidenceReceiptReverification],
    ['uncertainEffectReconciliation', record.uncertainEffectReconciliation],
    ['effectReplayForbidden', record.effectReplayForbidden],
    ['authorityPublicationSerialized', record.authorityPublicationSerialized],
    ['synchronousFinalFence', record.synchronousFinalFence],
  ] as const) {
    requireLiteral(value_, true, `Recovery profile ${name}`);
  }
  const profile = deepFreeze({
    kind: PRODUCTION_RECOVERY_PROFILE_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    barrierId: requireIdentifier(record.barrierId, 'Recovery barrier ID'),
    deploymentId: requireIdentifier(record.deploymentId, 'Deployment ID'),
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Environment digest',
    ),
    buildDigest: requireDigest(record.buildDigest, 'Build digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Configuration digest',
    ),
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    restartScanBeforeAuthority: true as const,
    evidenceReceiptReverification: true as const,
    uncertainEffectReconciliation: true as const,
    effectReplayForbidden: true as const,
    authorityPublicationSerialized: true as const,
    synchronousFinalFence: true as const,
  });
  if (
    profile.deploymentId !== deployment.deploymentId ||
    profile.environmentDigest !== deployment.environmentDigest ||
    profile.buildDigest !== deployment.buildDigest ||
    profile.configurationDigest !== deployment.configurationDigest ||
    profile.policyDigest !== deployment.policyDigest
  ) {
    fail(
      'recovery-unresolved',
      'recovery',
      'Recovery barrier profile does not match the deployment binding',
    );
  }
  return profile;
}

export function validateProductionRecoveryAdmission(
  value: unknown,
  deployment: ProductionDeploymentBinding,
  profile: ProductionRecoveryBarrierProfile,
  expected: {
    readonly recordSetDigest: string;
    readonly recordCount: number;
    readonly recoveredMutationCount: number;
    readonly uncertainRecordCount: number;
  },
  now: string,
): ProductionRecoveryAdmission {
  const record = requireClosedRecord(
    value,
    [
      'admissionId',
      'admittedAt',
      'barrierId',
      'deliveryReceiptsReverified',
      'deploymentId',
      'effectReplayAttempted',
      'kind',
      'recordCount',
      'recordSetDigest',
      'recoveredMutationCount',
      'terminalEvidenceComplete',
      'uncertainEffectsReconciledOrQuarantined',
      'uncertainRecordCount',
      'unresolvedRecordCount',
      'version',
    ],
    'Production recovery admission',
  );
  requireLiteral(
    record.kind,
    PRODUCTION_RECOVERY_ADMISSION_KIND,
    'Recovery admission kind',
  );
  requireLiteral(
    record.version,
    PRODUCTION_AUTHORITY_VERSION,
    'Recovery admission version',
  );
  requireLiteral(
    record.terminalEvidenceComplete,
    true,
    'Terminal evidence completion',
  );
  requireLiteral(
    record.deliveryReceiptsReverified,
    true,
    'Evidence receipt reverification',
  );
  requireLiteral(
    record.uncertainEffectsReconciledOrQuarantined,
    true,
    'Uncertain-effect reconciliation',
  );
  requireLiteral(record.effectReplayAttempted, false, 'Recovery effect replay');
  requireLiteral(record.unresolvedRecordCount, 0, 'Unresolved record count');
  const admission = deepFreeze({
    kind: PRODUCTION_RECOVERY_ADMISSION_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    admissionId: requireIdentifier(record.admissionId, 'Recovery admission ID'),
    barrierId: requireIdentifier(record.barrierId, 'Recovery barrier ID'),
    deploymentId: requireIdentifier(record.deploymentId, 'Deployment ID'),
    recordSetDigest: requireDigest(
      record.recordSetDigest,
      'Recovery record-set digest',
    ),
    recordCount: requireNonNegativeInteger(record.recordCount, 'Record count'),
    recoveredMutationCount: requireNonNegativeInteger(
      record.recoveredMutationCount,
      'Recovered mutation count',
    ),
    uncertainRecordCount: requireNonNegativeInteger(
      record.uncertainRecordCount,
      'Uncertain record count',
    ),
    unresolvedRecordCount: 0 as const,
    terminalEvidenceComplete: true as const,
    deliveryReceiptsReverified: true as const,
    uncertainEffectsReconciledOrQuarantined: true as const,
    effectReplayAttempted: false as const,
    admittedAt: requireTimestamp(record.admittedAt, 'Recovery admittedAt'),
  });
  if (
    admission.deploymentId !== deployment.deploymentId ||
    admission.barrierId !== profile.barrierId ||
    admission.recordSetDigest !== expected.recordSetDigest ||
    admission.recordCount !== expected.recordCount ||
    admission.recoveredMutationCount !== expected.recoveredMutationCount ||
    admission.uncertainRecordCount !== expected.uncertainRecordCount ||
    Date.parse(admission.admittedAt) >
      Date.parse(requireTimestamp(now, 'Current time'))
  ) {
    fail(
      'recovery-unresolved',
      'recovery',
      'Recovery admission does not exactly match the recovered durable record set',
    );
  }
  return admission;
}

export function validateProductionReviewedGateDecision(
  value: unknown,
  deployment: ProductionDeploymentBinding,
  assessment: PromotionAssessment,
  now: string,
): ProductionReviewedGateDecision {
  const record = requireClosedRecord(
    value,
    [
      'adapterRegistryManifestHash',
      'buildDigest',
      'configurationDigest',
      'decisionId',
      'deploymentId',
      'effectRegistryManifestHash',
      'enabled',
      'environmentDigest',
      'evidenceBundleDigest',
      'evidencePolicyDigest',
      'expiresAt',
      'issuedAt',
      'kind',
      'platformDigest',
      'policyDigest',
      'promotionAssessmentDigest',
      'promotionProfileDigest',
      'reviewReceiptDigest',
      'reviewerSetDigest',
      'runnerRegistryManifestHash',
      'targetGateId',
      'version',
    ],
    'Reviewed production gate decision',
  );
  requireLiteral(
    record.kind,
    PRODUCTION_GATE_DECISION_KIND,
    'Reviewed gate decision kind',
  );
  requireLiteral(
    record.version,
    PRODUCTION_AUTHORITY_VERSION,
    'Reviewed gate decision version',
  );
  requireLiteral(record.enabled, true, 'Reviewed gate decision');
  const decision = deepFreeze({
    kind: PRODUCTION_GATE_DECISION_KIND,
    version: PRODUCTION_AUTHORITY_VERSION,
    decisionId: requireIdentifier(record.decisionId, 'Gate decision ID'),
    deploymentId: requireIdentifier(record.deploymentId, 'Deployment ID'),
    targetGateId: requireIdentifier(record.targetGateId, 'Target gate ID'),
    enabled: true as const,
    promotionProfileDigest: requireDigest(
      record.promotionProfileDigest,
      'Promotion profile digest',
    ),
    promotionAssessmentDigest: requireDigest(
      record.promotionAssessmentDigest,
      'Promotion assessment digest',
    ),
    evidenceBundleDigest: requireDigest(
      record.evidenceBundleDigest,
      'Evidence bundle digest',
    ),
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Environment digest',
    ),
    platformDigest: requireDigest(record.platformDigest, 'Platform digest'),
    buildDigest: requireDigest(record.buildDigest, 'Build digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Configuration digest',
    ),
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    evidencePolicyDigest: requireDigest(
      record.evidencePolicyDigest,
      'Evidence policy digest',
    ),
    adapterRegistryManifestHash: requireDigest(
      record.adapterRegistryManifestHash,
      'Adapter registry manifest hash',
    ),
    runnerRegistryManifestHash: requireDigest(
      record.runnerRegistryManifestHash,
      'Runner registry manifest hash',
    ),
    effectRegistryManifestHash: requireDigest(
      record.effectRegistryManifestHash,
      'Effect registry manifest hash',
    ),
    reviewerSetDigest: requireDigest(
      record.reviewerSetDigest,
      'Reviewer-set digest',
    ),
    reviewReceiptDigest: requireDigest(
      record.reviewReceiptDigest,
      'Review receipt digest',
    ),
    issuedAt: requireTimestamp(record.issuedAt, 'Gate decision issuedAt'),
    expiresAt: requireTimestamp(record.expiresAt, 'Gate decision expiresAt'),
  });
  assertTimeWindow(
    decision.issuedAt,
    decision.expiresAt,
    now,
    'Reviewed gate decision',
  );
  if (
    decision.deploymentId !== deployment.deploymentId ||
    decision.targetGateId !== deployment.targetGateId ||
    decision.promotionProfileDigest !== deployment.promotionProfileDigest ||
    decision.promotionProfileDigest !== assessment.profileDigest ||
    decision.promotionAssessmentDigest !== assessment.assessmentDigest ||
    decision.evidenceBundleDigest !== assessment.evidenceBundleDigest ||
    decision.environmentDigest !== deployment.environmentDigest ||
    decision.platformDigest !== deployment.platformDigest ||
    decision.buildDigest !== deployment.buildDigest ||
    decision.configurationDigest !== deployment.configurationDigest ||
    decision.policyDigest !== deployment.policyDigest ||
    decision.evidencePolicyDigest !== deployment.evidencePolicyDigest ||
    decision.adapterRegistryManifestHash !==
      deployment.adapterRegistryManifestHash ||
    decision.runnerRegistryManifestHash !==
      deployment.runnerRegistryManifestHash ||
    decision.effectRegistryManifestHash !==
      deployment.effectRegistryManifestHash
  ) {
    fail(
      'reviewed-decision-invalid',
      'reviewed-decision',
      'Reviewed gate decision is not bound to the admitted deployment and evidence',
    );
  }
  return decision;
}

export function validateRegistryExpectationForDeployment(
  value: unknown,
  registryType: 'adapter' | 'runner' | 'effect',
  deployment: ProductionDeploymentBinding,
): RegistryManifestExpectation {
  const expected = validateRegistryManifestExpectation(value);
  const expectedHash =
    registryType === 'adapter'
      ? deployment.adapterRegistryManifestHash
      : registryType === 'runner'
        ? deployment.runnerRegistryManifestHash
        : deployment.effectRegistryManifestHash;
  if (
    expected.registryType !== registryType ||
    expected.workspaceId !== deployment.workspaceId ||
    expected.taskId !== deployment.taskId ||
    expected.rootObjectId !== deployment.rootObjectId ||
    expected.policyDigest !== deployment.policyDigest ||
    expected.configurationDigest !== deployment.configurationDigest ||
    expected.buildDigest !== deployment.buildDigest ||
    expected.manifestHash !== expectedHash
  ) {
    fail(
      'deployment-binding-mismatch',
      'registries',
      `${registryType} registry expectation does not match the deployment binding`,
    );
  }
  return expected;
}

export function validateProductionOperationMemberships(
  value: unknown,
): readonly ProductionOperationMembership[] {
  const values = requireDenseArray(
    value,
    'Production operation memberships',
    1,
    64,
  );
  const result = values.map((item) => validateMembership(item));
  const sorted = [...result].sort((left, right) =>
    compareAscii(left.operation, right.operation),
  );
  if (
    result.some((item, index) => item.operation !== sorted[index]?.operation) ||
    new Set(result.map((item) => item.operation)).size !== result.length
  ) {
    fail(
      'registry-membership-mismatch',
      'registries',
      'Production operation memberships must be sorted and unique by operation',
    );
  }
  return Object.freeze(result);
}

export function validateAdapterBindings(
  value: unknown,
): readonly TrustedSafeCodingAdapterBinding[] {
  const values = requireDenseArray(value, 'Production adapter bindings', 1, 64);
  const result = values.map((item) => validateAdapterBinding(item));
  const sorted = [...result].sort((left, right) =>
    compareAscii(left.action, right.action),
  );
  if (
    result.some((item, index) => item.action !== sorted[index]?.action) ||
    new Set(result.map((item) => item.action)).size !== result.length
  ) {
    fail(
      'adapter-binding-mismatch',
      'adapters',
      'Production adapter bindings must be sorted and unique by action',
    );
  }
  return Object.freeze(result);
}

export function validateAdapterBinding(
  value: unknown,
): TrustedSafeCodingAdapterBinding {
  const record = requireClosedRecord(
    value,
    [
      'action',
      'adapterDigest',
      'adapterId',
      'adapterRegistryDigest',
      'effectClass',
      'effectRegistryDigest',
      'policyDigest',
      'runnerRegistryDigest',
    ],
    'Trusted adapter binding',
  );
  const action = requireOperation(record.action);
  const effectClass = requireEffectClass(record.effectClass);
  if (effectClass !== expectedEffectClass(action)) {
    fail(
      'adapter-binding-mismatch',
      'adapters',
      `Adapter effect class is invalid for ${action}`,
    );
  }
  return deepFreeze({
    action,
    policyDigest: requireDigest(record.policyDigest, 'Adapter policy digest'),
    adapterId: requireIdentifier(record.adapterId, 'Adapter ID'),
    adapterDigest: requireDigest(record.adapterDigest, 'Adapter digest'),
    adapterRegistryDigest: requireDigest(
      record.adapterRegistryDigest,
      'Adapter registry digest',
    ),
    runnerRegistryDigest: requireDigest(
      record.runnerRegistryDigest,
      'Runner registry digest',
    ),
    effectRegistryDigest: requireDigest(
      record.effectRegistryDigest,
      'Effect registry digest',
    ),
    effectClass,
  });
}

export function assertBindingMatchesMembership(
  binding: TrustedSafeCodingAdapterBinding,
  membership: ProductionOperationMembership,
  deployment: ProductionDeploymentBinding,
): void {
  if (
    binding.action !== membership.operation ||
    binding.adapterId !== membership.adapter.adapterId ||
    binding.adapterDigest !== membership.adapter.adapterDigest ||
    binding.effectClass !== membership.effect.effectClass ||
    binding.policyDigest !== deployment.policyDigest ||
    binding.adapterRegistryDigest !== deployment.adapterRegistryManifestHash ||
    binding.runnerRegistryDigest !== deployment.runnerRegistryManifestHash ||
    binding.effectRegistryDigest !== deployment.effectRegistryManifestHash
  ) {
    fail(
      'adapter-binding-mismatch',
      'adapters',
      `Adapter binding does not match signed membership for ${membership.operation}`,
    );
  }
}

export function bindingValuesEqual(
  left: TrustedSafeCodingAdapterBinding,
  right: TrustedSafeCodingAdapterBinding,
): boolean {
  return (
    canonicalizeJson(left as unknown as CanonicalJsonValue) ===
    canonicalizeJson(right as unknown as CanonicalJsonValue)
  );
}

export function dataValuesEqual(left: unknown, right: unknown): boolean {
  return (
    canonicalizeJson(left as CanonicalJsonValue) ===
    canonicalizeJson(right as CanonicalJsonValue)
  );
}

export function hashProductionValue(
  domain: string,
  value: unknown,
  hash: ProductionHashPort,
): string {
  const digest = hash.sha256(
    encodeUtf8(`${domain}\0${canonicalizeJson(value as CanonicalJsonValue)}`),
  );
  return requireDigest(digest, 'Production hash output');
}

export function requireCurrentTimestamp(now: () => string): string {
  return requireTimestamp(now(), 'Trusted current time');
}

export function requireSynchronousVoid(value: unknown, label: string): void {
  if (value !== undefined) {
    fail(
      'final-fence-failed',
      'final-fence',
      `${label} must synchronously return undefined`,
    );
  }
}

export function readOwnData<T>(owner: unknown, name: string, label: string): T {
  if (
    owner === null ||
    (typeof owner !== 'object' && typeof owner !== 'function')
  ) {
    fail('input-invalid', 'input', `${label} is unavailable`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || !('value' in descriptor)) {
    fail('input-invalid', 'input', `${label} must be an own data property`);
  }
  return descriptor.value as T;
}

export function pinMethod<Owner extends object, Name extends keyof Owner>(
  owner: Owner,
  name: Name,
  label: string,
): Owner[Name] {
  let cursor: object | null = owner;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(
      cursor,
      name as string | symbol,
    );
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        fail(
          'input-invalid',
          'input',
          `${label} method must be a data-property function`,
        );
      }
      return descriptor.value.bind(owner) as Owner[Name];
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  fail('input-invalid', 'input', `${label} must expose the required method`);
}

export function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(
      'input-invalid',
      'input',
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

export function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('input-invalid', 'input', `${label} must be a bounded identifier`);
  }
  return value;
}

export function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    fail(
      'input-invalid',
      'input',
      `${label} must be a canonical UTC timestamp`,
    );
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== normalizeTimestamp(value)
  ) {
    fail(
      'input-invalid',
      'input',
      `${label} is not a real canonical UTC timestamp`,
    );
  }
  return value;
}

export function fail(
  code: ProductionBootstrapBlockerCode,
  stage: ProductionBootstrapStage,
  message: string,
  cause?: unknown,
): never {
  throw new ProductionBootstrapError(code, stage, message, cause);
}

function validateMembership(value: unknown): ProductionOperationMembership {
  const record = requireClosedRecord(
    value,
    ['adapter', 'effect', 'operation', 'runner'],
    'Production operation membership',
  );
  const operation = requireOperation(record.operation);
  const adapter = validateAdapterRegistryMember(record.adapter);
  const effect = validateEffectRegistryMember(record.effect);
  const runner =
    record.runner === null ? null : validateRunnerRegistryMember(record.runner);
  if (
    adapter.operation !== operation ||
    effect.operation !== operation ||
    adapter.adapterId !== effect.adapterId ||
    adapter.adapterDigest !== effect.adapterDigest ||
    adapter.argumentSchemaDigest !== effect.argumentSchemaDigest ||
    adapter.effectId !== effect.effectId ||
    effect.effectClass !== expectedEffectClass(operation)
  ) {
    fail(
      'registry-membership-mismatch',
      'registries',
      `Adapter/effect membership mismatch for ${operation}`,
    );
  }
  if (runner === null) {
    if (
      adapter.runnerId !== null ||
      adapter.runnerDigest !== null ||
      operation === 'test.run'
    ) {
      fail(
        'registry-membership-mismatch',
        'registries',
        `Runner membership is incomplete for ${operation}`,
      );
    }
  } else if (
    adapter.runnerId !== runner.runnerId ||
    adapter.runnerDigest !== runner.runnerDigest
  ) {
    fail(
      'registry-membership-mismatch',
      'registries',
      `Runner membership does not match adapter membership for ${operation}`,
    );
  }
  return deepFreeze({ operation, adapter, effect, runner });
}

function assertAdapterAttestationBinding(
  attestation: ProductionAdapterConfinementAttestation,
  deployment: ProductionDeploymentBinding,
): void {
  if (
    attestation.deploymentId !== deployment.deploymentId ||
    attestation.workspaceId !== deployment.workspaceId ||
    attestation.taskId !== deployment.taskId ||
    attestation.rootObjectId !== deployment.rootObjectId ||
    attestation.environmentDigest !== deployment.environmentDigest ||
    attestation.platformDigest !== deployment.platformDigest ||
    attestation.buildDigest !== deployment.buildDigest ||
    attestation.configurationDigest !== deployment.configurationDigest ||
    attestation.policyDigest !== deployment.policyDigest ||
    attestation.profileDigest !== deployment.adapterAuthorityProfileDigest
  ) {
    fail(
      'platform-attestation-invalid',
      'platform',
      'Adapter confinement attestation does not match the deployment binding',
    );
  }
}

function expectedEffectClass(
  operation: ProductionOperationMembership['operation'],
): SafeCodingEffectClass {
  switch (operation) {
    case 'filesystem.create':
    case 'filesystem.mkdir':
    case 'filesystem.replace':
      return 'local.reversible';
    case 'git.diff':
    case 'git.status':
      return 'local.observation';
    case 'test.run':
      return 'sandbox.ephemeral';
  }
}

function requireEffectClass(value: unknown): SafeCodingEffectClass {
  if (
    value !== 'local.observation' &&
    value !== 'local.reversible' &&
    value !== 'sandbox.ephemeral'
  ) {
    fail(
      'adapter-binding-mismatch',
      'adapters',
      'Adapter effect class is invalid',
    );
  }
  return value;
}

function requireOperation(
  value: unknown,
): ProductionOperationMembership['operation'] {
  if (
    typeof value !== 'string' ||
    !(SUPPORTED_OPERATIONS as readonly string[]).includes(value)
  ) {
    fail('input-invalid', 'input', 'Production operation is unsupported');
  }
  return value as ProductionOperationMembership['operation'];
}

function assertTimeWindow(
  issuedAt: string,
  expiresAt: string,
  now: string,
  label: string,
): void {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(requireTimestamp(now, 'Current time'));
  if (expiresAtMs <= issuedAtMs || nowMs < issuedAtMs || nowMs >= expiresAtMs) {
    fail(
      label === 'Adapter attestation'
        ? 'platform-attestation-stale'
        : 'reviewed-decision-invalid',
      label === 'Adapter attestation' ? 'platform' : 'reviewed-decision',
      `${label} is outside its trusted validity window`,
    );
  }
}

function requireClosedRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== Object.keys(value).length
  ) {
    fail('input-invalid', 'input', `${label} must be a closed data record`);
  }
  const record = value as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      fail(
        'input-invalid',
        'input',
        `${label} cannot contain accessors or hidden fields`,
      );
    }
  }
  assertCanonicalData(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    fail('input-invalid', 'input', `${label} has unknown or missing fields`);
  }
  return record;
}

function requireDenseArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail('input-invalid', 'input', `${label} must be a bounded ordinary array`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes('length')) {
    fail(
      'input-invalid',
      'input',
      `${label} must be dense and contain no extra fields`,
    );
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      fail(
        'input-invalid',
        'input',
        `${label} cannot contain holes or accessors`,
      );
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function assertCanonicalData(value: unknown, label: string): void {
  try {
    assertClosedDataTree(value, label);
    const canonical = canonicalizeJson(value as CanonicalJsonValue);
    parseCanonicalJson(canonical);
  } catch (error) {
    fail(
      'input-invalid',
      'input',
      `${label} is not bounded canonical JSON data`,
      error,
    );
  }
}

function assertClosedDataTree(value: unknown, label: string): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 20_000 || depth > 48) {
      throw new Error(`${label} exceeds structural limits`);
    }
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new Error(`${label} contains a non-canonical number`);
      }
      return;
    }
    if (typeof current !== 'object') {
      throw new Error(`${label} contains non-data input`);
    }
    if (seen.has(current)) throw new Error(`${label} contains a cycle`);
    seen.add(current);
    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        Object.getOwnPropertySymbols(current).length !== 0 ||
        current.length > 4096
      ) {
        throw new Error(`${label} contains an invalid array`);
      }
      const names = Object.getOwnPropertyNames(current);
      if (names.length !== current.length + 1 || !names.includes('length')) {
        throw new Error(`${label} contains a sparse or extended array`);
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current,
          String(index),
        );
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`${label} contains an array accessor`);
        }
        visit(descriptor.value, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(current).length !== 0
      ) {
        throw new Error(`${label} contains a non-data object`);
      }
      const names = Object.getOwnPropertyNames(current);
      if (names.length > 1024 || names.length !== Object.keys(current).length) {
        throw new Error(`${label} contains hidden or excessive fields`);
      }
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`${label} contains an object accessor`);
        }
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(current);
  };
  visit(value, 0);
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    fail('input-invalid', 'input', `${label} is invalid`);
  }
  return expected;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(
      'input-invalid',
      'input',
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function normalizeTimestamp(value: string): string {
  return value.includes('.') ? value : value.replace('Z', '.000Z');
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
