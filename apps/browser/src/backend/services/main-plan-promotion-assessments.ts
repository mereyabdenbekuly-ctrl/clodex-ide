import fs from 'node:fs';
import path from 'node:path';
import type { AppReleaseChannel } from '@shared/feature-gates';
import type { MainPlanPromotionAssessment } from '@shared/main-plan-readiness';
import { verifyModelFabricPublicationState } from './model-fabric-policy-publication';
import {
  isRunnerDogfoodEvidencePromotionEligible,
  verifyRunnerDogfoodEvidenceBundle,
  type RunnerDogfoodEvidenceBundle,
} from './runner-routing/dogfood-evidence';

const MAX_MODEL_FABRIC_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const MAX_RUNNER_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_RUNNER_BUNDLES = 128;
const MAX_RUNNER_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MINIMUM_PHYSICAL_RUNNER_SAMPLES = 4;
const MINIMUM_DISTINCT_COMMAND_CLASSES = 2;

export interface ModelFabricPromotionAssessmentInput {
  channel: AppReleaseChannel;
  now: Date;
  statePath: string;
  rootPublicKeyPath: string;
  snapshotRootPublicKeyPath?: string;
}

export interface RunnerPromotionAssessmentInput {
  now: Date;
  buildCommitSha: string;
  evidenceDirectoryPath: string;
  trustedCollectorPublicKeys?: readonly string[];
  trustedCollectorPublicKeysPath?: string;
}

/**
 * Treats the authenticated Model Fabric publication state as the promotion
 * authority. The state already contains signed approvals, a signed publication
 * receipt, and the exact signed policy snapshot. Release builds additionally
 * require the publication to have reached the production stage.
 */
export function assessModelFabricPromotion(
  input: ModelFabricPromotionAssessmentInput,
): MainPlanPromotionAssessment {
  const evidencePath = path.resolve(input.statePath);
  if (!fs.existsSync(evidencePath)) {
    return {
      state: 'absent',
      source: 'model-fabric-policy-publication',
      evidencePath,
      blockers: [],
    };
  }

  const rootPublicKeyPath = path.resolve(input.rootPublicKeyPath);
  if (!fs.existsSync(rootPublicKeyPath)) {
    return {
      state: 'not-ready',
      source: 'model-fabric-policy-publication',
      evidencePath,
      blockers: ['model-fabric-root-public-key-missing'],
    };
  }

  try {
    const state = JSON.parse(
      readRegularFile(
        evidencePath,
        MAX_MODEL_FABRIC_STATE_BYTES,
        'Model Fabric publication state',
      ).toString('utf8'),
    );
    const rootPublicKey = readRegularFile(
      rootPublicKeyPath,
      MAX_PUBLIC_KEY_BYTES,
      'Model Fabric root public key',
    ).toString('utf8');
    const snapshotRootPublicKeyPath = input.snapshotRootPublicKeyPath
      ? path.resolve(input.snapshotRootPublicKeyPath)
      : rootPublicKeyPath;
    if (!fs.existsSync(snapshotRootPublicKeyPath)) {
      return {
        state: 'not-ready',
        source: 'model-fabric-policy-publication',
        evidencePath,
        blockers: ['model-fabric-snapshot-root-public-key-missing'],
      };
    }
    const snapshotRootPublicKey =
      snapshotRootPublicKeyPath === rootPublicKeyPath
        ? rootPublicKey
        : readRegularFile(
            snapshotRootPublicKeyPath,
            MAX_PUBLIC_KEY_BYTES,
            'Model Fabric snapshot root public key',
          ).toString('utf8');
    const nowMs = input.now.getTime();
    const verified = verifyModelFabricPublicationState({
      state,
      rootPublicKey,
      snapshotRootPublicKey,
      now: nowMs,
    });
    const receipt = verified.lastReceipt;
    const snapshot = verified.lastSnapshot;
    const blockers: string[] = [];

    if (input.channel === 'release' && receipt.stage !== 'production') {
      blockers.push('model-fabric-production-publication-required');
    }
    if (receipt.publishedAt > nowMs + MAX_CLOCK_SKEW_MS) {
      blockers.push('model-fabric-publication-from-future');
    }
    if (
      verified.authority.expiresAt <= nowMs ||
      snapshot.rootset.expiresAt <= nowMs ||
      snapshot.keyset.expiresAt <= nowMs ||
      snapshot.policy.expiresAt <= nowMs
    ) {
      blockers.push('model-fabric-publication-expired');
    }

    return {
      state: blockers.length === 0 ? 'ready' : 'not-ready',
      source: 'model-fabric-policy-publication',
      evidencePath,
      blockers,
      details: {
        stage: receipt.stage,
        authorityRevision: receipt.authorityRevision,
        policyRevision: receipt.policyRevision,
        publishedAt: receipt.publishedAt,
      },
    };
  } catch {
    return {
      state: 'invalid',
      source: 'model-fabric-policy-publication',
      evidencePath,
      blockers: ['model-fabric-publication-validation-failed'],
    };
  }
}

/**
 * Promotes the decoupled execution canary only from signed, content-free
 * paired-replay bundles produced by a pinned collector. This proves a real
 * non-local SSH or Docker execution slice; it deliberately does not authorize
 * automatic runner routing, which remains a separate post-v1 rollout.
 */
export function assessRunnerPromotion(
  input: RunnerPromotionAssessmentInput,
): MainPlanPromotionAssessment {
  const evidencePath = path.resolve(input.evidenceDirectoryPath);
  if (!fs.existsSync(evidencePath)) {
    return {
      state: 'absent',
      source: 'runner-signed-paired-replay',
      evidencePath,
      blockers: [],
    };
  }

  try {
    const directory = fs.lstatSync(evidencePath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Runner evidence path is not a trusted directory');
    }
    const entries = fs
      .readdirSync(evidencePath, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) {
      return {
        state: 'absent',
        source: 'runner-signed-paired-replay',
        evidencePath,
        blockers: [],
      };
    }
    if (entries.length > MAX_RUNNER_BUNDLES) {
      throw new Error('Runner evidence directory exceeds the bundle limit');
    }

    const trustedCollectorPublicKeys = loadTrustedCollectorPublicKeys(input);
    if (trustedCollectorPublicKeys.length === 0) {
      return {
        state: 'not-ready',
        source: 'runner-signed-paired-replay',
        evidencePath,
        blockers: ['runner-trusted-collector-key-missing'],
      };
    }

    const bundles = entries.map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Runner evidence bundle is not a regular file');
      }
      const bundlePath = path.join(evidencePath, entry.name);
      const value = JSON.parse(
        readRegularFile(
          bundlePath,
          MAX_RUNNER_BUNDLE_BYTES,
          'Runner evidence bundle',
        ).toString('utf8'),
      );
      return verifyRunnerDogfoodEvidenceBundle(
        value,
        trustedCollectorPublicKeys,
      );
    });

    return evaluateRunnerPromotionBundles(
      bundles,
      input.now,
      evidencePath,
      input.buildCommitSha,
    );
  } catch {
    return {
      state: 'invalid',
      source: 'runner-signed-paired-replay',
      evidencePath,
      blockers: ['runner-evidence-validation-failed'],
    };
  }
}

export function evaluateRunnerPromotionBundles(
  bundles: readonly RunnerDogfoodEvidenceBundle[],
  now: Date,
  evidencePath = 'in-memory',
  buildCommitSha?: string,
): MainPlanPromotionAssessment {
  const nowMs = now.getTime();
  const blockers: string[] = [];
  if (hasDuplicates(bundles.map((bundle) => bundle.bundleId))) {
    blockers.push('runner-bundle-replay-detected');
  }
  const allSamples = bundles.flatMap((bundle) => bundle.samples);
  if (hasDuplicates(allSamples.map((sample) => sample.sampleId))) {
    blockers.push('runner-sample-replay-detected');
  }
  if (hasDuplicates(allSamples.map((sample) => sample.replay.receiptHash))) {
    blockers.push('runner-receipt-replay-detected');
  }
  if (hasDuplicates(allSamples.map((sample) => sample.replay.jobHash))) {
    blockers.push('runner-job-replay-detected');
  }
  const physicalSamples = bundles.flatMap((bundle) =>
    bundle.samples.filter(
      (sample) =>
        isRunnerDogfoodEvidencePromotionEligible(sample) &&
        (sample.replay.providerKind === 'ssh' ||
          sample.replay.providerKind === 'docker'),
    ),
  );
  const distinctCommandClasses = new Set(
    physicalSamples.map((sample) => sample.commandClassHash),
  );
  const providerKinds = new Set(
    physicalSamples.map((sample) => sample.replay.providerKind),
  );
  const evidenceAges = bundles.map((bundle) => nowMs - bundle.collectedAt);

  if (
    buildCommitSha !== undefined &&
    bundles.some((bundle) => bundle.sourceCommitSha !== buildCommitSha)
  ) {
    blockers.push('runner-source-commit-mismatch');
  }
  if (
    bundles.some((bundle) => bundle.collectedAt > nowMs + MAX_CLOCK_SKEW_MS)
  ) {
    blockers.push('runner-evidence-from-future');
  }
  if (evidenceAges.some((age) => age > MAX_RUNNER_EVIDENCE_AGE_MS)) {
    blockers.push('runner-evidence-stale');
  }
  if (physicalSamples.length < MINIMUM_PHYSICAL_RUNNER_SAMPLES) {
    blockers.push('runner-physical-samples-insufficient');
  }
  if (distinctCommandClasses.size < MINIMUM_DISTINCT_COMMAND_CLASSES) {
    blockers.push('runner-command-class-coverage-insufficient');
  }
  if (
    physicalSamples.some(
      (sample) =>
        sample.replay.outcome !== 'completed' ||
        sample.replay.timedOut ||
        sample.replay.exitCodeClass !== 'zero',
    )
  ) {
    blockers.push('runner-physical-replay-failed');
  }

  return {
    state: blockers.length === 0 ? 'ready' : 'not-ready',
    source: 'runner-signed-paired-replay',
    evidencePath,
    blockers,
    details: {
      bundleCount: bundles.length,
      physicalSampleCount: physicalSamples.length,
      distinctCommandClasses: distinctCommandClasses.size,
      providerKinds: [...providerKinds].sort().join(','),
      maximumEvidenceAgeHours:
        evidenceAges.length === 0
          ? 0
          : Math.max(...evidenceAges.map((age) => Math.max(0, age))) /
            3_600_000,
    },
  };
}

function loadTrustedCollectorPublicKeys(
  input: RunnerPromotionAssessmentInput,
): string[] {
  const keys = [...(input.trustedCollectorPublicKeys ?? [])];
  if (
    input.trustedCollectorPublicKeysPath &&
    fs.existsSync(input.trustedCollectorPublicKeysPath)
  ) {
    keys.push(
      ...readRegularFile(
        path.resolve(input.trustedCollectorPublicKeysPath),
        MAX_PUBLIC_KEY_BYTES,
        'Runner trusted collector keys',
      )
        .toString('utf8')
        .split(/[\s,]+/u)
        .filter(Boolean),
    );
  }
  if (
    keys.some(
      (key) =>
        key.length < 16 || key.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(key),
    )
  ) {
    throw new Error('Runner trusted collector key is invalid');
  }
  return [...new Set(keys)];
}

function readRegularFile(
  filePath: string,
  maximumBytes: number,
  label: string,
): Buffer {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > maximumBytes
  ) {
    throw new Error(`${label} is not a trusted regular file`);
  }
  return fs.readFileSync(filePath);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
