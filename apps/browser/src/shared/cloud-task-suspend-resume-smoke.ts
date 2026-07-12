import { z } from 'zod';

export const cloudTaskSuspendResumeSmokeChecks = [
  'networkReconnect',
  'systemSuspendResume',
  'orphanCancellation',
  'artifactRangeResume',
  'contentFreeAudit',
] as const;

export type CloudTaskSuspendResumeSmokeCheck =
  (typeof cloudTaskSuspendResumeSmokeChecks)[number];

export const cloudTaskSuspendResumeSmokeEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.enum(['darwin', 'win32', 'linux']),
    arch: z.string().trim().min(1).max(128),
    appVersion: z.string().trim().min(1).max(128),
    completedAt: z.string().datetime({ offset: true }),
    checks: z
      .object({
        networkReconnect: z.literal(true),
        systemSuspendResume: z.literal(true),
        orphanCancellation: z.literal(true),
        artifactRangeResume: z.literal(true),
        contentFreeAudit: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type CloudTaskSuspendResumeSmokeEvidence = z.infer<
  typeof cloudTaskSuspendResumeSmokeEvidenceSchema
>;

export function parseCloudTaskSuspendResumeSmokeEvidence(
  value: unknown,
): CloudTaskSuspendResumeSmokeEvidence {
  const parsed = cloudTaskSuspendResumeSmokeEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Cloud task suspend/resume smoke evidence is invalid');
  }
  return parsed.data;
}

export function createCloudTaskSuspendResumeSmokeEvidence(input: {
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  completedAt?: Date;
  checks: Partial<Record<CloudTaskSuspendResumeSmokeCheck, boolean>>;
}): CloudTaskSuspendResumeSmokeEvidence {
  if (
    input.platform !== 'darwin' &&
    input.platform !== 'win32' &&
    input.platform !== 'linux'
  ) {
    throw new Error('Cloud task smoke platform is unsupported');
  }
  const missing = cloudTaskSuspendResumeSmokeChecks.filter(
    (check) => input.checks[check] !== true,
  );
  if (missing.length > 0) {
    throw new Error(
      `Cloud task smoke evidence is incomplete: ${missing.join(', ')}`,
    );
  }
  if (!input.arch.trim() || !input.appVersion.trim()) {
    throw new Error('Cloud task smoke build metadata is incomplete');
  }
  return parseCloudTaskSuspendResumeSmokeEvidence({
    schemaVersion: 1,
    platform: input.platform,
    arch: input.arch,
    appVersion: input.appVersion,
    completedAt: (input.completedAt ?? new Date()).toISOString(),
    checks: Object.fromEntries(
      cloudTaskSuspendResumeSmokeChecks.map((check) => [check, true]),
    ) as Record<CloudTaskSuspendResumeSmokeCheck, true>,
  });
}
