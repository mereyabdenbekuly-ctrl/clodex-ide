import { z } from 'zod';

export const sessionRecoveryAcceptancePhases = ['seed', 'verify'] as const;

export type SessionRecoveryAcceptancePhase =
  (typeof sessionRecoveryAcceptancePhases)[number];

export const SESSION_RECOVERY_ACCEPTANCE_SWITCH = 'session-recovery-acceptance';
export const SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER =
  '.clodex-session-recovery-acceptance';
export const SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER_CONTENT =
  'clodex-session-recovery-acceptance-v1\n';
export const SESSION_RECOVERY_ACCEPTANCE_ARTIFACT_DIRECTORY =
  'session-recovery-acceptance';

const contentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const platformSchema = z.enum(['darwin', 'win32', 'linux']);
const observationCountsSchema = z
  .object({
    history: z.number().int().nonnegative(),
    queuedMessages: z.number().int().nonnegative(),
    mountedWorkspaces: z.number().int().nonnegative(),
  })
  .strict();

const phaseArtifactBaseSchema = z.object({
  schemaVersion: z.literal(1),
  appVersion: z.string().trim().min(1).max(128),
  platform: platformSchema,
  arch: z.string().trim().min(1).max(128),
  taskIdentityHash: contentDigestSchema,
  semanticStateDigest: contentDigestSchema,
  counts: observationCountsSchema,
});

export const sessionRecoverySeedArtifactSchema = phaseArtifactBaseSchema
  .extend({
    phase: z.literal('seed'),
    checks: z
      .object({
        isolatedProfile: z.literal(true),
        freshProfile: z.literal(true),
        targetAgentCreated: z.literal(true),
        deterministicStateSeeded: z.literal(true),
        persistedStateMatched: z.literal(true),
        checkpointFlushed: z.literal(true),
        tabStatePersisted: z.literal(true),
        contentFreeAudit: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const sessionRecoveryVerifyArtifactSchema = phaseArtifactBaseSchema
  .extend({
    phase: z.literal('verify'),
    checks: z
      .object({
        isolatedProfile: z.literal(true),
        sameProfileRestart: z.literal(true),
        targetAgentResumed: z.literal(true),
        persistedStateMatched: z.literal(true),
        liveStateMatched: z.literal(true),
        noDataLoss: z.literal(true),
        contentFreeAudit: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const sessionRecoveryPhaseArtifactSchema = z.discriminatedUnion(
  'phase',
  [sessionRecoverySeedArtifactSchema, sessionRecoveryVerifyArtifactSchema],
);

export type SessionRecoverySeedArtifact = z.infer<
  typeof sessionRecoverySeedArtifactSchema
>;
export type SessionRecoveryVerifyArtifact = z.infer<
  typeof sessionRecoveryVerifyArtifactSchema
>;
export type SessionRecoveryPhaseArtifact = z.infer<
  typeof sessionRecoveryPhaseArtifactSchema
>;

export const sessionRecoveryAcceptanceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: platformSchema,
    arch: z.string().trim().min(1).max(128),
    appVersion: z.string().trim().min(1).max(128),
    completedAt: z.string().datetime({ offset: true }),
    markerSetVersion: z.literal(1),
    durationsMs: z
      .object({
        seed: z.number().int().nonnegative(),
        verify: z.number().int().nonnegative(),
      })
      .strict(),
    restoredCounts: observationCountsSchema,
    checks: z
      .object({
        intersessionMutexHeld: z.literal(true),
        isolatedProfile: z.literal(true),
        seededPersistedState: z.literal(true),
        checkpointFlushed: z.literal(true),
        gracefulSeedShutdown: z.literal(true),
        sameProfileRestart: z.literal(true),
        targetAgentResumed: z.literal(true),
        persistedDigestMatched: z.literal(true),
        liveDigestMatched: z.literal(true),
        noDataLoss: z.literal(true),
        gracefulVerifyShutdown: z.literal(true),
        contentFreeAudit: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type SessionRecoveryAcceptanceEvidence = z.infer<
  typeof sessionRecoveryAcceptanceEvidenceSchema
>;

export function parseSessionRecoveryPhaseArtifact(
  value: unknown,
): SessionRecoveryPhaseArtifact {
  const parsed = sessionRecoveryPhaseArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Session recovery phase artifact is invalid');
  }
  return parsed.data;
}

export function createSessionRecoveryAcceptanceEvidence(input: {
  seed: SessionRecoverySeedArtifact;
  verify: SessionRecoveryVerifyArtifact;
  seedDurationMs: number;
  verifyDurationMs: number;
  completedAt?: Date;
}): SessionRecoveryAcceptanceEvidence {
  const { seed, verify } = input;
  if (
    seed.platform !== verify.platform ||
    seed.arch !== verify.arch ||
    seed.appVersion !== verify.appVersion
  ) {
    throw new Error('Session recovery phases used different packaged builds');
  }
  if (seed.taskIdentityHash !== verify.taskIdentityHash) {
    throw new Error('Session recovery restarted a different task');
  }
  if (seed.semanticStateDigest !== verify.semanticStateDigest) {
    throw new Error('Session recovery semantic state digest changed');
  }
  if (
    seed.counts.history !== verify.counts.history ||
    seed.counts.queuedMessages !== verify.counts.queuedMessages ||
    seed.counts.mountedWorkspaces !== verify.counts.mountedWorkspaces
  ) {
    throw new Error('Session recovery state counts changed');
  }

  return sessionRecoveryAcceptanceEvidenceSchema.parse({
    schemaVersion: 1,
    platform: seed.platform,
    arch: seed.arch,
    appVersion: seed.appVersion,
    completedAt: (input.completedAt ?? new Date()).toISOString(),
    markerSetVersion: 1,
    durationsMs: {
      seed: Math.round(input.seedDurationMs),
      verify: Math.round(input.verifyDurationMs),
    },
    restoredCounts: verify.counts,
    checks: {
      intersessionMutexHeld: true,
      isolatedProfile: true,
      seededPersistedState: true,
      checkpointFlushed: true,
      gracefulSeedShutdown: true,
      sameProfileRestart: true,
      targetAgentResumed: true,
      persistedDigestMatched: true,
      liveDigestMatched: true,
      noDataLoss: true,
      gracefulVerifyShutdown: true,
      contentFreeAudit: true,
    },
  });
}
