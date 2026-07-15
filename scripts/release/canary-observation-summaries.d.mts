export type CommitSha = string;
export type Sha256 = string;
export type CanonicalUtcInstant = string;

export interface CanarySourceBinding {
  commit: CommitSha;
  ref: 'refs/heads/main';
  repository: 'mereyabdenbekuly-ctrl/clodex-ide';
}

export interface CanaryManifestBinding {
  path: string;
  sha256: Sha256;
  sourceCommit: CommitSha;
}

export interface CanaryReleaseBinding {
  channel: 'preview';
  promotionRole: 'canary';
  sourceCommit: CommitSha;
  tag: string;
  version: string;
}

export interface CanaryPublicationBinding {
  createdAt: CanonicalUtcInstant;
  releaseId: number;
  reportAssetId: number;
  reportFileName: 'clodex-release-publication.json';
  reportSha256: Sha256;
  repository: 'mereyabdenbekuly-ctrl/clodex-ide';
  sourceCommit: CommitSha;
  state: 'draft';
  tag: string;
}

export interface CanarySummaryProducer {
  repository: string;
  runAttempt: number;
  runId: number;
  sourceCommit: CommitSha;
  sourceRef: 'refs/heads/main';
  workflow: string;
  workflowCommit: CommitSha;
}

interface CanarySummaryBase {
  generatedAt: CanonicalUtcInstant;
  manifest: CanaryManifestBinding;
  producer: CanarySummaryProducer;
  publication: CanaryPublicationBinding;
  release: CanaryReleaseBinding;
  schemaVersion: 1;
  source: CanarySourceBinding;
}

export interface CanaryDistributionSummary extends CanarySummaryBase {
  artifactKind: 'content-free-canary-distribution-summary-v1';
  observation: {
    counters: {
      signatureTrustFailures: number;
      uniqueInstallations: number;
    };
    distributionClosedAt: CanonicalUtcInstant;
    endedAt: CanonicalUtcInstant;
    startedAt: CanonicalUtcInstant;
  };
}

export interface CanaryHealthSummary extends CanarySummaryBase {
  artifactKind: 'content-free-canary-health-summary-v1';
  observation: {
    counters: {
      authAttempts: number;
      authFailures: number;
      crashLoops: number;
      crashes: number;
      dataLossIncidents: number;
      egressMissingPrompts: number;
      egressPromptAttempts: number;
      egressUnexpectedAllows: number;
      guardianBypassIncidents: number;
      launchAttempts: number;
      launchFailures: number;
      recoveryAttempts: number;
      recoveryFailures: number;
    };
    endedAt: CanonicalUtcInstant;
    startedAt: CanonicalUtcInstant;
  };
}

export type CanarySummary = CanaryDistributionSummary | CanaryHealthSummary;

export interface CanaryArtifactSubject<
  T extends CanarySummary = CanarySummary,
> {
  artifactKind: T['artifactKind'];
  sha256: Sha256;
  value: T;
}

export interface VerifiedCanaryAttestation {
  repository: string;
  signerDigest: CommitSha;
  signerWorkflow: string;
  sourceDigest: CommitSha;
  sourceRef: 'refs/heads/main';
  subjectSha256: Sha256;
}

export const CANARY_SUMMARY_SCHEMA_VERSION: 1;
export const CANARY_SUMMARY_MAX_BYTES: number;
export const CANARY_SUMMARY_CLOCK_SKEW_MS: number;
export const CANARY_DISTRIBUTION_COUNTER_NAMES: readonly [
  'signatureTrustFailures',
  'uniqueInstallations',
];
export const CANARY_HEALTH_COUNTER_NAMES: readonly string[];

export function canonicalCanaryJson(value: unknown): string;
export function canonicalCanaryArtifactBytes(value: unknown): Buffer;
export function validateCanarySummaryProducer<T extends CanarySummaryProducer>(
  value: T,
): T;
export function validateCanaryDistributionSummary<
  T extends CanaryDistributionSummary,
>(value: T, options?: { now?: Date }): T;
export function validateCanaryHealthSummary<T extends CanaryHealthSummary>(
  value: T,
  options?: { now?: Date },
): T;
export function validateCanarySummary<T extends CanarySummary>(
  value: T,
  options?: { now?: Date },
): T;
export function parseCanonicalCanarySummaryBytes(
  bytes: Uint8Array,
  options?: { kind?: CanarySummary['artifactKind']; now?: Date },
): { bytes: Buffer; sha256: Sha256; value: CanarySummary };
export function createCanaryArtifactSubject<T extends CanarySummary>(
  value: T,
  options?: { now?: Date },
): CanaryArtifactSubject<T>;
export function validateCanaryArtifactSubject<T extends CanarySummary>(
  subject: CanaryArtifactSubject<T>,
  options?: { kind?: T['artifactKind']; now?: Date },
): CanaryArtifactSubject<T>;
export function validateVerifiedCanaryAttestation<
  T extends VerifiedCanaryAttestation,
>(value: T): T;
export function verifyCanarySummaryAttestationBinding<T extends CanarySummary>(
  subject: CanaryArtifactSubject<T>,
  attestation: VerifiedCanaryAttestation,
  options?: {
    expectedProducer?: CanarySummaryProducer;
    kind?: T['artifactKind'];
    now?: Date;
  },
): {
  attestation: VerifiedCanaryAttestation;
  producer: CanarySummaryProducer;
  subject: CanaryArtifactSubject<T>;
};
