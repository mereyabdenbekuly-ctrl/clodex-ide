import {
  CANARY_DISTRIBUTION_SUMMARY_KIND,
  CANARY_HEALTH_SUMMARY_KIND,
} from './canary-observation-receipt.mjs';
import { assembleCanaryObservationEvidenceBundle } from './assemble-canary-observation-receipt.mjs';
import { canonicalCanaryArtifactBytes } from './canary-observation-summaries.mjs';

export const CANARY_FIXTURE_NOW = new Date('2026-07-15T01:00:00.000Z');
export const CANARY_FIXTURE_RELEASE_COMMIT = '1'.repeat(40);
export const CANARY_FIXTURE_MANIFEST_SHA256 = '2'.repeat(64);
export const CANARY_FIXTURE_PUBLICATION_SHA256 = '3'.repeat(64);

function commonBindings() {
  return {
    manifest: {
      path: '.release-notes/clodex-technical-preview.json',
      sha256: CANARY_FIXTURE_MANIFEST_SHA256,
      sourceCommit: CANARY_FIXTURE_RELEASE_COMMIT,
    },
    publication: {
      createdAt: '2026-07-13T00:00:00.000Z',
      releaseId: 77,
      reportAssetId: 101,
      reportFileName: 'clodex-release-publication.json',
      reportSha256: CANARY_FIXTURE_PUBLICATION_SHA256,
      repository: 'mereyabdenbekuly-ctrl/clodex-ide',
      sourceCommit: CANARY_FIXTURE_RELEASE_COMMIT,
      state: 'draft',
      tag: 'v1.16.0-preview.3',
    },
    release: {
      channel: 'preview',
      promotionRole: 'canary',
      sourceCommit: CANARY_FIXTURE_RELEASE_COMMIT,
      tag: 'v1.16.0-preview.3',
      version: '1.16.0-preview.3',
    },
    source: {
      commit: CANARY_FIXTURE_RELEASE_COMMIT,
      ref: 'refs/heads/main',
      repository: 'mereyabdenbekuly-ctrl/clodex-ide',
    },
  };
}

export function canaryDistributionProducer() {
  const commit = '4'.repeat(40);
  return {
    repository: 'example-org/clodex-distribution-evidence',
    runAttempt: 1,
    runId: 4001,
    sourceCommit: commit,
    sourceRef: 'refs/heads/main',
    workflow:
      'example-org/clodex-distribution-evidence/.github/workflows/aggregate-canary-distribution.yml',
    workflowCommit: commit,
  };
}

export function canaryHealthProducer() {
  const commit = '5'.repeat(40);
  return {
    repository: 'example-org/clodex-health-evidence',
    runAttempt: 2,
    runId: 5001,
    sourceCommit: commit,
    sourceRef: 'refs/heads/main',
    workflow:
      'example-org/clodex-health-evidence/.github/workflows/aggregate-canary-health.yml',
    workflowCommit: commit,
  };
}

export function canaryReceiptProducer() {
  const commit = '6'.repeat(40);
  return {
    repository: 'mereyabdenbekuly-ctrl/clodex-ide',
    runAttempt: 1,
    runId: 6001,
    sourceCommit: commit,
    sourceRef: 'refs/heads/main',
    workflow:
      'mereyabdenbekuly-ctrl/clodex-ide/.github/workflows/release-canary-observation.yml',
    workflowCommit: commit,
  };
}

export function canaryDistributionSummary() {
  return {
    artifactKind: CANARY_DISTRIBUTION_SUMMARY_KIND,
    generatedAt: '2026-07-14T00:31:30.000Z',
    ...commonBindings(),
    observation: {
      counters: {
        signatureTrustFailures: 0,
        uniqueInstallations: 5,
      },
      distributionClosedAt: '2026-07-14T00:31:00.000Z',
      endedAt: '2026-07-14T00:30:00.000Z',
      startedAt: '2026-07-13T00:30:00.000Z',
    },
    producer: canaryDistributionProducer(),
    schemaVersion: 1,
  };
}

export function canaryHealthSummary() {
  return {
    artifactKind: CANARY_HEALTH_SUMMARY_KIND,
    generatedAt: '2026-07-14T00:31:00.000Z',
    ...commonBindings(),
    observation: {
      counters: {
        authAttempts: 5,
        authFailures: 0,
        crashLoops: 0,
        crashes: 0,
        dataLossIncidents: 0,
        egressMissingPrompts: 0,
        egressPromptAttempts: 5,
        egressUnexpectedAllows: 0,
        guardianBypassIncidents: 0,
        launchAttempts: 10,
        launchFailures: 0,
        recoveryAttempts: 5,
        recoveryFailures: 0,
      },
      endedAt: '2026-07-14T00:30:00.000Z',
      startedAt: '2026-07-13T00:30:00.000Z',
    },
    producer: canaryHealthProducer(),
    schemaVersion: 1,
  };
}

export function canaryObservationEvidenceBundle() {
  return assembleCanaryObservationEvidenceBundle(
    {
      distributionBytes: canonicalCanaryArtifactBytes(
        canaryDistributionSummary(),
      ),
      healthBytes: canonicalCanaryArtifactBytes(canaryHealthSummary()),
      producer: canaryReceiptProducer(),
    },
    { now: CANARY_FIXTURE_NOW },
  );
}

function attestation(subject, producer) {
  return {
    repository: producer.repository,
    signerDigest: producer.workflowCommit,
    signerWorkflow: producer.workflow,
    sourceDigest: producer.sourceCommit,
    sourceRef: producer.sourceRef,
    subjectSha256: subject.sha256,
  };
}

export function canaryExpectedProducers() {
  return {
    distribution: canaryDistributionProducer(),
    health: canaryHealthProducer(),
    receipt: canaryReceiptProducer(),
  };
}

export function canaryVerifiedAttestations(bundle) {
  const producers = canaryExpectedProducers();
  return {
    distribution: attestation(bundle.distribution, producers.distribution),
    health: attestation(bundle.health, producers.health),
    receipt: attestation(bundle.receipt, producers.receipt),
  };
}
