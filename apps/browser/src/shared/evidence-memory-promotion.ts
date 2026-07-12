import { createHash, sign, verify, type KeyLike } from 'node:crypto';
import { z } from 'zod';
import type {
  EvidenceMemoryRolloutPolicy,
  EvidenceMemoryRolloutStage,
} from './evidence-memory-rollout';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({
  offset: false,
  local: false,
});
const canaryStageSchema = z.enum(['canary-5', 'canary-25', 'canary-100']);
const deliveryModeSchema = z.enum([
  'external-ci-artifact',
  'repository-evidence-commit',
]);

export const EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS = [
  '.release-evidence/evidence-memory.json',
  '.release-evidence/evidence-memory-quality.json',
  '.release-evidence/evidence-memory-trace-replay.json',
] as const;

const evaluationLinkSchema = z
  .object({
    generatedAt: canonicalTimestampSchema,
    sha256: sha256Schema,
    policyHash: sha256Schema,
  })
  .strict();

const traceReplayLinkSchema = evaluationLinkSchema
  .extend({
    traceSetHash: sha256Schema,
  })
  .strict();

export const evidenceMemoryPromotionBodySchema = z
  .object({
    schemaVersion: z.literal(2),
    sourceChannel: z.literal('prerelease'),
    generatedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    delivery: z
      .object({
        mode: deliveryModeSchema,
      })
      .strict(),
    targetStage: canaryStageSchema,
    qualityEvidence: evaluationLinkSchema,
    traceReplayEvidence: traceReplayLinkSchema,
  })
  .strict();

export const evidenceMemoryPromotionEvidenceSchema =
  evidenceMemoryPromotionBodySchema
    .extend({
      signature: z
        .object({
          algorithm: z.literal('ed25519'),
          keyId: z.string().min(1).max(128),
          value: z.string().min(1).max(1_024),
        })
        .strict(),
    })
    .strict();

export type EvidenceMemoryPromotionBody = z.infer<
  typeof evidenceMemoryPromotionBodySchema
>;
export type EvidenceMemoryPromotionDeliveryMode = z.infer<
  typeof deliveryModeSchema
>;
export type EvidenceMemoryPromotionEvidence = z.infer<
  typeof evidenceMemoryPromotionEvidenceSchema
>;

export interface EvidenceMemoryPromotionArtifactSummary {
  bytes: Uint8Array;
  generatedAt: string;
  policyHash: string;
  promotionReady: boolean;
  source?: string;
  traceSetHash?: string;
}

export interface EvidenceMemoryPromotionSourceBinding {
  buildCommitSha: string;
  sourceCommitIsAncestor: boolean;
  changedPaths: readonly string[];
}

export type EvidenceMemoryPromotionCheckId =
  | 'valid-signature'
  | 'source-commit-matches-build'
  | 'source-commit-reachable'
  | 'promotion-diff-allowed'
  | 'valid-evidence-window'
  | 'evidence-not-from-future'
  | 'evidence-not-expired'
  | 'maximum-validity-window'
  | 'target-stage-allowed'
  | 'quality-sha256-matches'
  | 'quality-generated-at-matches'
  | 'quality-policy-matches'
  | 'quality-suite-ready'
  | 'quality-evidence-fresh'
  | 'trace-sha256-matches'
  | 'trace-generated-at-matches'
  | 'trace-policy-matches'
  | 'trace-set-matches'
  | 'trace-suite-ready'
  | 'trace-evidence-fresh'
  | 'linked-evidence-not-from-future'
  | 'external-trace-evidence';

export interface EvidenceMemoryPromotionCheck {
  id: EvidenceMemoryPromotionCheckId;
  passed: boolean;
  actual: string | number | boolean;
  required: string | number | boolean;
}

export interface EvidenceMemoryPromotionReadiness {
  ready: boolean;
  checks: EvidenceMemoryPromotionCheck[];
  evidenceAgeHours: number;
  validityHours: number;
}

export function createEvidenceMemoryPromotionEvidence(options: {
  body: EvidenceMemoryPromotionBody;
  privateKey: KeyLike;
  keyId: string;
}): EvidenceMemoryPromotionEvidence {
  const body = evidenceMemoryPromotionBodySchema.parse(options.body);
  const signature = sign(
    null,
    Buffer.from(canonicalBody(body)),
    options.privateKey,
  );
  return evidenceMemoryPromotionEvidenceSchema.parse({
    ...body,
    signature: {
      algorithm: 'ed25519',
      keyId: options.keyId,
      value: signature.toString('base64'),
    },
  });
}

export function parseEvidenceMemoryPromotionEvidence(
  value: unknown,
): EvidenceMemoryPromotionEvidence {
  return evidenceMemoryPromotionEvidenceSchema.parse(value);
}

export function evaluateEvidenceMemoryPromotionReadiness(
  evidence: EvidenceMemoryPromotionEvidence,
  options: {
    publicKey: KeyLike;
    sourceBinding: EvidenceMemoryPromotionSourceBinding;
    currentPolicy: EvidenceMemoryRolloutPolicy;
    quality: EvidenceMemoryPromotionArtifactSummary;
    traceReplay: EvidenceMemoryPromotionArtifactSummary;
    now?: Date;
  },
): EvidenceMemoryPromotionReadiness {
  const parsed = parseEvidenceMemoryPromotionEvidence(evidence);
  const { signature: signatureValue, ...body } = parsed;
  const now = (options.now ?? new Date()).getTime();
  const generatedAt = Date.parse(body.generatedAt);
  const expiresAt = Date.parse(body.expiresAt);
  const validityHours = (expiresAt - generatedAt) / 3_600_000;
  const evidenceAgeHours = Math.max(0, (now - generatedAt) / 3_600_000);
  const qualityGeneratedAt = Date.parse(body.qualityEvidence.generatedAt);
  const traceGeneratedAt = Date.parse(body.traceReplayEvidence.generatedAt);
  const qualityAgeHours = Math.max(0, (now - qualityGeneratedAt) / 3_600_000);
  const traceAgeHours = Math.max(0, (now - traceGeneratedAt) / 3_600_000);
  const changedPaths = normalizeChangedPaths(
    options.sourceBinding.changedPaths,
  );
  const externalDelivery = body.delivery.mode === 'external-ci-artifact';
  const sourceCommitMatchesBuild = externalDelivery
    ? body.sourceCommitSha === options.sourceBinding.buildCommitSha
    : body.sourceCommitSha !== options.sourceBinding.buildCommitSha;
  const sourceCommitReachable =
    body.sourceCommitSha === options.sourceBinding.buildCommitSha ||
    options.sourceBinding.sourceCommitIsAncestor;
  const promotionDiffAllowed = externalDelivery
    ? changedPaths.length === 0
    : changedPaths.length > 0 &&
      changedPaths.every((filePath) =>
        EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS.includes(
          filePath as (typeof EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS)[number],
        ),
      );
  const validSignature = verify(
    null,
    Buffer.from(canonicalBody(body)),
    options.publicKey,
    Buffer.from(signatureValue.value, 'base64'),
  );
  const checks: EvidenceMemoryPromotionCheck[] = [
    check('valid-signature', validSignature, validSignature, true),
    check(
      'source-commit-matches-build',
      sourceCommitMatchesBuild,
      `${body.sourceCommitSha}..${options.sourceBinding.buildCommitSha}`,
      externalDelivery
        ? 'source commit equals build commit'
        : 'source commit precedes a distinct evidence-only build commit',
    ),
    check(
      'source-commit-reachable',
      sourceCommitReachable,
      sourceCommitReachable,
      true,
    ),
    check(
      'promotion-diff-allowed',
      promotionDiffAllowed,
      changedPaths.length > 0 ? changedPaths.join(',') : 'none',
      externalDelivery
        ? 'no committed delta from source commit'
        : EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS.join(','),
    ),
    check(
      'valid-evidence-window',
      expiresAt > generatedAt,
      `${body.generatedAt}..${body.expiresAt}`,
      'increasing canonical timestamps',
    ),
    check(
      'evidence-not-from-future',
      generatedAt <= now + 5 * 60_000,
      body.generatedAt,
      'not more than 5 minutes in the future',
    ),
    check(
      'evidence-not-expired',
      expiresAt >= now,
      body.expiresAt,
      'at or after current time',
    ),
    check('maximum-validity-window', validityHours <= 48, validityHours, 48),
    check(
      'target-stage-allowed',
      isTargetStageAllowed(options.currentPolicy.stage, body.targetStage),
      body.targetStage,
      allowedTargetDescription(options.currentPolicy.stage),
    ),
    linkCheck(
      'quality-sha256-matches',
      body.qualityEvidence.sha256,
      sha256(options.quality.bytes),
    ),
    linkCheck(
      'quality-generated-at-matches',
      body.qualityEvidence.generatedAt,
      options.quality.generatedAt,
    ),
    linkCheck(
      'quality-policy-matches',
      body.qualityEvidence.policyHash,
      options.quality.policyHash,
    ),
    check(
      'quality-suite-ready',
      options.quality.promotionReady,
      options.quality.promotionReady,
      true,
    ),
    check('quality-evidence-fresh', qualityAgeHours <= 48, qualityAgeHours, 48),
    linkCheck(
      'trace-sha256-matches',
      body.traceReplayEvidence.sha256,
      sha256(options.traceReplay.bytes),
    ),
    linkCheck(
      'trace-generated-at-matches',
      body.traceReplayEvidence.generatedAt,
      options.traceReplay.generatedAt,
    ),
    linkCheck(
      'trace-policy-matches',
      body.traceReplayEvidence.policyHash,
      options.traceReplay.policyHash,
    ),
    linkCheck(
      'trace-set-matches',
      body.traceReplayEvidence.traceSetHash,
      options.traceReplay.traceSetHash ?? '',
    ),
    check(
      'trace-suite-ready',
      options.traceReplay.promotionReady,
      options.traceReplay.promotionReady,
      true,
    ),
    check('trace-evidence-fresh', traceAgeHours <= 48, traceAgeHours, 48),
    check(
      'linked-evidence-not-from-future',
      qualityGeneratedAt <= generatedAt + 5 * 60_000 &&
        traceGeneratedAt <= generatedAt + 5 * 60_000,
      `${body.qualityEvidence.generatedAt},${body.traceReplayEvidence.generatedAt}`,
      'not later than envelope generation + 5 minutes',
    ),
    check(
      'external-trace-evidence',
      options.traceReplay.source === 'external-content-free-trace',
      options.traceReplay.source ?? 'missing',
      'external-content-free-trace',
    ),
  ];
  return {
    ready: checks.every((item) => item.passed),
    checks,
    evidenceAgeHours,
    validityHours,
  };
}

export function isEvidenceMemoryRolloutPolicyArmed(
  policy: EvidenceMemoryRolloutPolicy,
): boolean {
  return policy.allocationPercent > 0;
}

function canonicalBody(body: EvidenceMemoryPromotionBody): string {
  return JSON.stringify({
    schemaVersion: body.schemaVersion,
    sourceChannel: body.sourceChannel,
    generatedAt: body.generatedAt,
    expiresAt: body.expiresAt,
    sourceCommitSha: body.sourceCommitSha,
    delivery: body.delivery,
    targetStage: body.targetStage,
    qualityEvidence: body.qualityEvidence,
    traceReplayEvidence: body.traceReplayEvidence,
  });
}

function normalizeChangedPaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths)).map((filePath) =>
    filePath.replaceAll('\\', '/').replace(/^\.\//, ''),
  );
}

function isTargetStageAllowed(
  current: EvidenceMemoryRolloutStage,
  target: EvidenceMemoryPromotionBody['targetStage'],
): boolean {
  if (current === target) return true;
  return (
    (current === 'shadow' && target === 'canary-5') ||
    (current === 'canary-5' && target === 'canary-25') ||
    (current === 'canary-25' && target === 'canary-100')
  );
}

function allowedTargetDescription(stage: EvidenceMemoryRolloutStage): string {
  switch (stage) {
    case 'shadow':
      return 'canary-5';
    case 'canary-5':
      return 'canary-5 or canary-25';
    case 'canary-25':
      return 'canary-25 or canary-100';
    case 'canary-100':
      return 'canary-100';
    case 'hold':
      return 'no canary promotion while hold is active';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function linkCheck(
  id: EvidenceMemoryPromotionCheckId,
  actual: string,
  required: string,
): EvidenceMemoryPromotionCheck {
  return check(id, actual === required, actual, required);
}

function check(
  id: EvidenceMemoryPromotionCheckId,
  passed: boolean,
  actual: string | number | boolean,
  required: string | number | boolean,
): EvidenceMemoryPromotionCheck {
  return { id, passed, actual, required };
}
