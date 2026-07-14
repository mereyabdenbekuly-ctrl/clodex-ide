import type {
  CapabilityScope,
  SupportedReferenceActionKind,
} from '@clodex/adapters';
import type { SafeCodingAction } from '@clodex/contracts';
import type {
  AbortPreparedControlPlaneInput,
  CommitPermitAuthorityPort,
  ConsumeCommitPermitInput,
  ControlPlaneRecoveryResult,
  ControlPlaneEffectExecutionRequest,
  ControlPlaneStorageTransactionPort,
  ControlPlaneTransactionRecord,
  DeliverControlPlaneEvidenceInput,
  EvidenceAdmissionReceiptPort,
  PrepareControlPlaneInput,
  TrustedSynchronousClock,
} from '@clodex/control-plane';
import type {
  PreparedSafeCodingAction,
  SafeCodingAdapterRegistryPort,
  SafeCodingPreparePort,
  TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import type {
  PromotionAssessment,
  PromotionClockPort,
  PromotionEvidenceTrustPort,
  PromotionHashPort,
} from '@clodex/promotion';
import type {
  AdapterRegistryMember,
  EffectRegistryMember,
  ProtectedRegistryHeadPort,
  RegistryClockPort,
  RegistryHashPort,
  RegistryManifestExpectation,
  RegistrySignatureVerifierPort,
  RunnerRegistryMember,
} from '@clodex/registry';

export const PRODUCTION_DEPLOYMENT_BINDING_KIND =
  'clodex.production-deployment-binding' as const;
export const PRODUCTION_ADAPTER_ATTESTATION_KIND =
  'clodex.production-adapter-confinement-attestation' as const;
export const PRODUCTION_PROTECTED_HEAD_KIND =
  'clodex.production-protected-registry-head-profile' as const;
export const PRODUCTION_RECOVERY_PROFILE_KIND =
  'clodex.production-recovery-barrier-profile' as const;
export const PRODUCTION_RECOVERY_ADMISSION_KIND =
  'clodex.production-recovery-admission' as const;
export const PRODUCTION_GATE_DECISION_KIND =
  'clodex.production-reviewed-gate-decision' as const;
export const PRODUCTION_AUTHORITY_DESCRIPTOR_KIND =
  'clodex.production-authority-descriptor' as const;
export const PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND =
  'clodex.production-authority-diagnostic' as const;
export const PRODUCTION_AUTHORITY_VERSION = 1 as const;

/**
 * Complete immutable deployment binding selected outside request/model input.
 * The bootstrap compares every registry, adapter, promotion and storage input
 * against this record before it can publish an authority handle.
 */
export interface ProductionDeploymentBinding {
  readonly kind: typeof PRODUCTION_DEPLOYMENT_BINDING_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly deploymentId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
  readonly environmentDigest: string;
  readonly platformDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly evidencePolicyDigest: string;
  readonly adapterAuthorityProfileDigest: string;
  readonly adapterRegistryManifestHash: string;
  readonly runnerRegistryManifestHash: string;
  readonly effectRegistryManifestHash: string;
  readonly promotionProfileDigest: string;
  readonly targetGateId: string;
  readonly controlPlaneStorageAdapterId: string;
}

/**
 * Evidence-backed deployment claim supplied by a platform verifier. Merely
 * constructing this data does not prove confinement; the paired synchronous
 * final-fence port is mandatory and is called for every new authority use.
 */
export interface ProductionAdapterConfinementAttestation {
  readonly kind: typeof PRODUCTION_ADAPTER_ATTESTATION_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly attestationId: string;
  readonly verifierId: string;
  readonly verificationEvidenceDigest: string;
  readonly deploymentId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
  readonly environmentDigest: string;
  readonly platformDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly platform: 'linux';
  readonly descriptorRelativeFilesystem: true;
  readonly openat2BeneathNoSymlinksNoMagicLinksNoMountEscape: true;
  readonly exactStateCas: true;
  readonly fileAndDirectoryFsync: true;
  readonly gitNoShellHooksPagerExternalDiffTextconvCredentialsOrNetwork: true;
  readonly gitBoundedOutputAndTimeout: true;
  readonly testDigestPinnedPullNever: true;
  readonly testNetworkAndCredentialsDisabled: true;
  readonly testReadOnlyWorkspaceAndDisposableScratch: true;
  readonly testCapabilitiesDroppedAndNoNewPrivileges: true;
  readonly finalAuthorityFenceInsideSerializedDispatch: true;
  readonly arbitraryHostFilesystemApi: false;
  readonly arbitraryCommandApi: false;
  readonly featureGateDefault: false;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface ProductionProtectedRegistryHeadProfile {
  readonly kind: typeof PRODUCTION_PROTECTED_HEAD_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly environmentDigest: string;
  readonly platformDigest: string;
  readonly trustRootDigest: string;
  readonly linearizable: true;
  readonly durable: true;
  readonly multiProcess: true;
  readonly independentlyProtected: true;
  readonly antiRollback: true;
  readonly synchronousFinalFence: true;
}

export interface ProductionProtectedRegistryHeadPort
  extends ProtectedRegistryHeadPort {
  readonly protection: ProductionProtectedRegistryHeadProfile;
  assertProtectionCurrentSynchronously(
    expected: ProductionProtectedRegistryHeadProfile,
  ): void;
}

export interface ProductionRecoveryBarrierProfile {
  readonly kind: typeof PRODUCTION_RECOVERY_PROFILE_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly barrierId: string;
  readonly deploymentId: string;
  readonly environmentDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly restartScanBeforeAuthority: true;
  readonly evidenceReceiptReverification: true;
  readonly uncertainEffectReconciliation: true;
  readonly effectReplayForbidden: true;
  readonly authorityPublicationSerialized: true;
  readonly synchronousFinalFence: true;
}

export interface ProductionRecoveryAdmission {
  readonly kind: typeof PRODUCTION_RECOVERY_ADMISSION_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly admissionId: string;
  readonly barrierId: string;
  readonly deploymentId: string;
  readonly recordSetDigest: string;
  readonly recordCount: number;
  readonly recoveredMutationCount: number;
  readonly uncertainRecordCount: number;
  readonly unresolvedRecordCount: 0;
  readonly terminalEvidenceComplete: true;
  readonly deliveryReceiptsReverified: true;
  readonly uncertainEffectsReconciledOrQuarantined: true;
  readonly effectReplayAttempted: false;
  readonly admittedAt: string;
}

export interface ProductionRecoveryControlPlanePort {
  scan(): Promise<readonly ControlPlaneTransactionRecord[]>;
  get(transactionId: string): Promise<ControlPlaneTransactionRecord | null>;
  deliverEvidence(
    input: DeliverControlPlaneEvidenceInput,
  ): Promise<ControlPlaneTransactionRecord>;
}

export interface ProductionRecoveryReconcileInput {
  readonly deployment: ProductionDeploymentBinding;
  readonly recoveryPass: readonly ControlPlaneRecoveryResult[];
  readonly controlPlane: ProductionRecoveryControlPlanePort;
}

export interface ProductionRecoveryPort {
  readonly profile: ProductionRecoveryBarrierProfile;
  reconcile(
    input: ProductionRecoveryReconcileInput,
  ): unknown | Promise<unknown>;
  assertResolvedSynchronously(
    admission: ProductionRecoveryAdmission,
    deployment: ProductionDeploymentBinding,
  ): void;
}

export interface ProductionReviewedGateDecision {
  readonly kind: typeof PRODUCTION_GATE_DECISION_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly decisionId: string;
  readonly deploymentId: string;
  readonly targetGateId: string;
  readonly enabled: true;
  readonly promotionProfileDigest: string;
  readonly promotionAssessmentDigest: string;
  readonly evidenceBundleDigest: string;
  readonly environmentDigest: string;
  readonly platformDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly evidencePolicyDigest: string;
  readonly adapterRegistryManifestHash: string;
  readonly runnerRegistryManifestHash: string;
  readonly effectRegistryManifestHash: string;
  readonly reviewerSetDigest: string;
  readonly reviewReceiptDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ProductionReviewedGatePort {
  readReviewedDecision(input: {
    readonly deployment: ProductionDeploymentBinding;
    readonly assessment: PromotionAssessment;
  }): unknown | null | Promise<unknown | null>;
  assertCurrentSynchronously(
    decision: ProductionReviewedGateDecision,
    deployment: ProductionDeploymentBinding,
    assessment: PromotionAssessment,
  ): void;
}

export interface ProductionDeploymentPort {
  readCurrent(): unknown | Promise<unknown>;
  assertCurrentSynchronously(expected: ProductionDeploymentBinding): void;
}

export interface ProductionClockPort
  extends TrustedSynchronousClock,
    RegistryClockPort,
    PromotionClockPort {}

export interface ProductionHashPort
  extends RegistryHashPort,
    PromotionHashPort {
  sha256(input: Uint8Array): string;
}

/**
 * Per-attempt, request-bound authority capability created by this package.
 *
 * The adapter must invoke it exactly once inside its serialized/prepared
 * execution boundary, after every await needed to reach that boundary and
 * synchronously immediately before the first effect-capable OS operation. It
 * must not catch a rejection, yield between the assertion and dispatch, retain
 * the capability after the attempt, or use it to authorize a retry.
 */
export interface ProductionEffectFinalAuthorityPort {
  /** The exact request object supplied for this attempt must be returned. */
  assertFinalAuthoritySynchronously(
    request: ControlPlaneEffectExecutionRequest,
  ): void;
}

/**
 * Stable composition surface for an already constructed fixed-operation
 * adapter set. A Node implementation may sit behind it, but no generic host
 * filesystem/process/container callback crosses this boundary.
 */
export interface ProductionAdapterAuthorityPort {
  readonly capabilityScope: CapabilityScope;
  readonly bindings: readonly TrustedSafeCodingAdapterBinding[];
  readonly guardianAdapters: SafeCodingAdapterRegistryPort;
  readonly guardianPrepare: SafeCodingPreparePort;
  readConfinementAttestation(): unknown | Promise<unknown>;
  assertConfinementCurrentSynchronously(
    attestation: ProductionAdapterConfinementAttestation,
  ): void;
  /**
   * One attempt through the already prepared fixed-operation adapter set.
   * It must verify the complete request against its inert prepared state and
   * must never retry an ambiguous effect internally. The supplied final
   * authority capability is one-shot and request-bound; this method must call
   * it at the serialized dispatch boundary described by
   * `ProductionEffectFinalAuthorityPort` before any effect-capable OS call.
   */
  executeControlPlaneEffectOnce(
    request: ControlPlaneEffectExecutionRequest,
    finalAuthority: ProductionEffectFinalAuthorityPort,
  ): Promise<unknown>;
}

export interface ProductionSignedRegistryInput {
  readonly envelope: unknown;
  readonly expected: RegistryManifestExpectation;
}

export interface ProductionSignedRegistrySet {
  readonly adapter: ProductionSignedRegistryInput;
  readonly runner: ProductionSignedRegistryInput;
  readonly effect: ProductionSignedRegistryInput;
}

export interface ProductionOperationMembership {
  readonly operation: SupportedReferenceActionKind;
  readonly adapter: AdapterRegistryMember;
  readonly effect: EffectRegistryMember;
  readonly runner: RunnerRegistryMember | null;
}

export interface ProductionPromotionInput {
  readonly profile: unknown;
  readonly expectedProfileDigest: string;
  readonly evidence: readonly unknown[];
  readonly trust: PromotionEvidenceTrustPort;
  readonly reviewedGate: ProductionReviewedGatePort;
}

export interface ProductionRegistryInput {
  readonly head: ProductionProtectedRegistryHeadPort;
  readonly signatures: RegistrySignatureVerifierPort;
  readonly manifests: ProductionSignedRegistrySet;
  readonly memberships: readonly ProductionOperationMembership[];
}

export interface ProductionControlPlaneInput {
  readonly storage: ControlPlaneStorageTransactionPort;
  readonly commitPermits: CommitPermitAuthorityPort;
  readonly evidenceReceipts: EvidenceAdmissionReceiptPort;
}

export interface ProductionAuthorityBootstrapInput {
  readonly expectedDeployment: unknown;
  readonly deployment: ProductionDeploymentPort;
  readonly clock: ProductionClockPort;
  readonly hash: ProductionHashPort;
  readonly registry: ProductionRegistryInput;
  readonly adapters: ProductionAdapterAuthorityPort;
  readonly promotion: ProductionPromotionInput;
  readonly controlPlane: ProductionControlPlaneInput;
  readonly recovery: ProductionRecoveryPort;
}

export interface ProductionAuthorityDescriptor {
  readonly kind: typeof PRODUCTION_AUTHORITY_DESCRIPTOR_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly authorityId: string;
  readonly deploymentId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
  readonly environmentDigest: string;
  readonly platformDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly adapterRegistryManifestHash: string;
  readonly runnerRegistryManifestHash: string;
  readonly effectRegistryManifestHash: string;
  readonly promotionProfileDigest: string;
  readonly promotionAssessmentDigest: string;
  readonly evidenceBundleDigest: string;
  readonly reviewedDecisionId: string;
  readonly recoveryAdmissionId: string;
  readonly recoveryRecordSetDigest: string;
  readonly controlPlaneStorageAdapterId: string;
  readonly authorityGateDefault: 'off';
  readonly automaticPromotion: false;
}

export interface ProductionControlPlaneCallbacks {
  prepare(
    input: PrepareControlPlaneInput,
  ): Promise<ControlPlaneTransactionRecord>;
  consumeCommitPermit(
    input: ConsumeCommitPermitInput,
  ): Promise<ControlPlaneTransactionRecord>;
  executeOnce(input: {
    readonly transactionId: string;
    readonly expectedRevision: number;
  }): Promise<ControlPlaneTransactionRecord>;
  abortPrepared(
    input: AbortPreparedControlPlaneInput,
  ): Promise<ControlPlaneTransactionRecord>;
  deliverEvidence(
    input: DeliverControlPlaneEvidenceInput,
  ): Promise<ControlPlaneTransactionRecord>;
  get(transactionId: string): Promise<ControlPlaneTransactionRecord | null>;
  pendingEvidence(): Promise<readonly ControlPlaneTransactionRecord[]>;
}

export interface ProductionAdapterCallbacks {
  resolveAuthorizationBinding(
    action: SafeCodingAction,
  ): Promise<TrustedSafeCodingAdapterBinding | null>;
  prepareAuthorization(
    action: SafeCodingAction,
    binding: TrustedSafeCodingAdapterBinding,
  ): Promise<PreparedSafeCodingAction>;
}

/**
 * This is the only authority-bearing output. It exposes fixed control-plane
 * and fixed adapter callbacks, never a registry mutator, gate mutator, host
 * filesystem API, process API, shell, network, credential or container API.
 */
export interface ProductionAuthorityHandle {
  readonly descriptor: ProductionAuthorityDescriptor;
  readonly controlPlane: ProductionControlPlaneCallbacks;
  readonly adapters: ProductionAdapterCallbacks;
  assertCurrentSynchronously(): void;
}

export type ProductionBootstrapStage =
  | 'input'
  | 'deployment'
  | 'platform'
  | 'protected-head'
  | 'registries'
  | 'adapters'
  | 'promotion'
  | 'reviewed-decision'
  | 'control-plane'
  | 'recovery'
  | 'final-fence'
  | 'ready';

export type ProductionBootstrapBlockerCode =
  | 'input-invalid'
  | 'deployment-binding-mismatch'
  | 'deployment-unavailable'
  | 'platform-attestation-invalid'
  | 'platform-attestation-stale'
  | 'protected-head-insufficient'
  | 'registry-admission-failed'
  | 'registry-membership-mismatch'
  | 'adapter-binding-mismatch'
  | 'promotion-blocked'
  | 'promotion-invalid'
  | 'reviewed-decision-missing'
  | 'reviewed-decision-invalid'
  | 'control-plane-not-durable'
  | 'control-plane-construction-failed'
  | 'recovery-failed'
  | 'recovery-unresolved'
  | 'final-fence-failed'
  | 'unexpected-failure';

export interface ProductionAuthorityDiagnostic {
  readonly kind: typeof PRODUCTION_AUTHORITY_DIAGNOSTIC_KIND;
  readonly version: typeof PRODUCTION_AUTHORITY_VERSION;
  readonly status: 'disabled' | 'ready';
  readonly authorityPublished: boolean;
  readonly authorityGateDefault: 'off';
  readonly automaticPromotion: false;
  readonly stage: ProductionBootstrapStage;
  readonly blockerCode: ProductionBootstrapBlockerCode | null;
  readonly blockerName: string | null;
  readonly deploymentId: string | null;
  readonly authorityId: string | null;
  readonly promotionEligibility: PromotionAssessment['eligibility'] | null;
  readonly recoveryRecordCount: number | null;
  readonly recoveryUnresolvedCount: number | null;
}

export interface ProductionBootstrapResult {
  readonly authority: ProductionAuthorityHandle | null;
  readonly diagnostic: ProductionAuthorityDiagnostic;
}

export class ProductionBootstrapError extends Error {
  public constructor(
    public readonly code: ProductionBootstrapBlockerCode,
    public readonly stage: ProductionBootstrapStage,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'ProductionBootstrapError';
  }
}
