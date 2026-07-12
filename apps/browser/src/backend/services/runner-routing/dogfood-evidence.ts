import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  runnerPairedReplayProfiles,
  type RunnerPairedReplayProfile,
} from '@clodex/agent-core/runner-routing';
import {
  canonicalizeRunnerValue,
  getRunnerPublicKeyId,
  hashRunnerExecutionStageTimings,
} from '@clodex/agent-shell';
import { z } from 'zod';

const SIGNATURE_CONTEXT = 'clodex.runner-dogfood-evidence.v2';
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const providerKindSchema = z.enum(['local', 'ssh', 'docker']);
const replayProfileSchema = z.enum(runnerPairedReplayProfiles);
export const runnerDogfoodEvidenceScenarios = [
  'organic-read-only',
  'organic-heavyweight',
  'controlled-local-timeout',
  'controlled-local-failure',
  'controlled-local-latency',
] as const;
const scenarioSchema = z.enum(runnerDogfoodEvidenceScenarios);
export type RunnerDogfoodEvidenceScenario =
  (typeof runnerDogfoodEvidenceScenarios)[number];

const executionTimingsSchema = z
  .object({
    version: z.literal(1),
    sshRoundTrips: z.number().int().nonnegative(),
    artifactBeforeRoundTrips: z.number().int().nonnegative(),
    dispatchRoundTrips: z.number().int().nonnegative(),
    pollingRoundTrips: z.number().int().nonnegative(),
    artifactAfterRoundTrips: z.number().int().nonnegative(),
    artifactBeforeDurationMs: z.number().int().nonnegative(),
    dispatchDurationMs: z.number().int().nonnegative(),
    commandDurationMs: z.number().int().nonnegative().nullable(),
    pollingDurationMs: z.number().int().nonnegative(),
    artifactAfterDurationMs: z.number().int().nonnegative(),
    receiptFinalizationDurationMs: z.number().int().nonnegative(),
  })
  .strict();

const executionSchema = z
  .object({
    providerId: z.string().min(1).max(256),
    providerKind: providerKindSchema,
    environmentFingerprintHash: sha256Schema,
    outcome: z.enum(['completed', 'failed']),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean(),
    exitCodeClass: z.enum(['zero', 'non-zero', 'missing']),
    receiptHash: sha256Schema,
    jobHash: sha256Schema,
    outputHash: sha256Schema.nullable(),
    artifactManifestHash: sha256Schema.nullable(),
    executionTimingHash: sha256Schema.nullable().optional(),
    executionTimings: executionTimingsSchema.optional(),
    preparationDurationMs: z.number().int().nonnegative().optional(),
    totalDurationMs: z.number().int().nonnegative().optional(),
    workspaceCacheStatus: z
      .enum(['disabled', 'cold', 'warm', 'quarantined'])
      .optional(),
    workspaceReuseCount: z.number().int().nonnegative().optional(),
    transferBytes: z.number().int().nonnegative().optional(),
    transferBytesAvoided: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (
      (execution.executionTimings === undefined) !==
      (execution.executionTimingHash === undefined ||
        execution.executionTimingHash === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dogfood execution timings must be bound by a receipt hash',
        path: ['executionTimingHash'],
      });
    }
    if (
      execution.executionTimings &&
      execution.executionTimingHash !==
        hashRunnerExecutionStageTimings(execution.executionTimings)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dogfood execution timing hash does not match its timings',
        path: ['executionTimingHash'],
      });
    }
    if (
      execution.totalDurationMs !== undefined &&
      execution.totalDurationMs < execution.durationMs
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Total dogfood duration cannot be shorter than execution',
        path: ['totalDurationMs'],
      });
    }
  });

const sampleSchema = z
  .object({
    sampleId: z.string().uuid(),
    profile: replayProfileSchema,
    commandClassHash: sha256Schema,
    snapshotHash: sha256Schema,
    scenario: scenarioSchema.optional(),
    promotionEligible: z.boolean().optional(),
    actual: executionSchema,
    replay: executionSchema,
  })
  .strict()
  .superRefine((sample, context) => {
    if (
      sample.actual.providerId === sample.replay.providerId &&
      sample.actual.providerKind === sample.replay.providerKind
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dogfood counterfactual provider must differ from actual',
        path: ['replay', 'providerId'],
      });
    }
    if (!profileMatchesProvider(sample.profile, sample.replay.providerKind)) {
      context.addIssue({
        code: 'custom',
        message: 'Dogfood replay profile does not match replay provider',
        path: ['profile'],
      });
    }
    const scenario = sample.scenario ?? 'organic-read-only';
    const promotionEligible =
      sample.promotionEligible ?? scenario.startsWith('organic-');
    if (scenario.startsWith('controlled-') && promotionEligible) {
      context.addIssue({
        code: 'custom',
        message: 'Controlled dogfood scenarios cannot unlock promotion',
        path: ['promotionEligible'],
      });
    }
  });

const unsignedBundleSchema = z
  .object({
    schemaVersion: z.literal(2),
    bundleId: z.string().uuid(),
    collectedAt: z.number().int().nonnegative(),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    collectorPublicKey: base64UrlSchema.min(16).max(1024),
    collectorKeyId: base64UrlSchema.min(16).max(128),
    samples: z.array(sampleSchema).min(1).max(128),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (
      bundle.collectorKeyId !== getRunnerPublicKeyId(bundle.collectorPublicKey)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dogfood collector key id does not match public key',
        path: ['collectorKeyId'],
      });
    }
    if (
      new Set(bundle.samples.map((sample) => sample.sampleId)).size !==
      bundle.samples.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Dogfood sample ids must be unique',
        path: ['samples'],
      });
    }
  });

export const runnerDogfoodEvidenceBundleSchema = unsignedBundleSchema
  .extend({
    signature: base64UrlSchema.min(16).max(1024),
  })
  .strict();

export type RunnerDogfoodEvidenceExecution = z.infer<typeof executionSchema>;
export type RunnerDogfoodEvidenceSample = z.infer<typeof sampleSchema>;
export type RunnerDogfoodEvidenceBundle = z.infer<
  typeof runnerDogfoodEvidenceBundleSchema
>;
export type UnsignedRunnerDogfoodEvidenceBundle = z.infer<
  typeof unsignedBundleSchema
>;

export function signRunnerDogfoodEvidenceBundle(
  input: Omit<
    UnsignedRunnerDogfoodEvidenceBundle,
    'collectorPublicKey' | 'collectorKeyId'
  >,
  identity: { privateKeyPem: string; publicKey: string },
): RunnerDogfoodEvidenceBundle {
  const unsigned = unsignedBundleSchema.parse({
    ...input,
    collectorPublicKey: identity.publicKey,
    collectorKeyId: getRunnerPublicKeyId(identity.publicKey),
  });
  const privateKey = createPrivateKey(identity.privateKeyPem);
  if (
    !createPublicKey(privateKey).equals(importCollectorKey(identity.publicKey))
  ) {
    throw new Error('Dogfood collector signing keypair does not match');
  }
  return runnerDogfoodEvidenceBundleSchema.parse({
    ...unsigned,
    signature: sign('sha256', signaturePayload(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  });
}

export function verifyRunnerDogfoodEvidenceBundle(
  input: unknown,
  trustedCollectorPublicKeys: readonly string[],
): RunnerDogfoodEvidenceBundle {
  const bundle = runnerDogfoodEvidenceBundleSchema.parse(input);
  if (!trustedCollectorPublicKeys.includes(bundle.collectorPublicKey)) {
    throw new Error('Runner dogfood collector is not trusted');
  }
  const { signature, ...unsigned } = bundle;
  const verified = verify(
    'sha256',
    signaturePayload(unsigned),
    {
      key: importCollectorKey(bundle.collectorPublicKey),
      dsaEncoding: 'ieee-p1363',
    },
    Buffer.from(signature, 'base64url'),
  );
  if (!verified) {
    throw new Error('Runner dogfood evidence signature is invalid');
  }
  return bundle;
}

export function getRunnerDogfoodEvidenceScenario(
  sample: RunnerDogfoodEvidenceSample,
): RunnerDogfoodEvidenceScenario {
  return sample.scenario ?? 'organic-read-only';
}

export function isRunnerDogfoodEvidencePromotionEligible(
  sample: RunnerDogfoodEvidenceSample,
): boolean {
  return (
    sample.promotionEligible ??
    getRunnerDogfoodEvidenceScenario(sample).startsWith('organic-')
  );
}

function signaturePayload(bundle: UnsignedRunnerDogfoodEvidenceBundle): Buffer {
  return Buffer.from(
    `${SIGNATURE_CONTEXT}\n${canonicalizeRunnerValue(bundle)}`,
    'utf8',
  );
}

function importCollectorKey(publicKey: string) {
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('Dogfood collector signing key must use P-256');
  }
  return key;
}

function profileMatchesProvider(
  profile: RunnerPairedReplayProfile,
  providerKind: 'local' | 'ssh' | 'docker',
): boolean {
  if (
    profile === 'ssh-read-only' ||
    profile === 'ssh-node-cache' ||
    profile === 'ssh-cargo-cache' ||
    profile === 'ssh-go-cache'
  ) {
    return providerKind === 'ssh';
  }
  if (profile === 'docker-isolated') return providerKind === 'docker';
  return providerKind === 'local';
}
