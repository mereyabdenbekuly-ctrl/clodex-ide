import { z } from 'zod';
import { remoteControlNativeAttestationProviderSchema } from './remote-control-protocol';

export const REMOTE_CONTROL_PHYSICAL_SMOKE_SCHEMA_VERSION = 1 as const;

export const remoteControlPhysicalSmokeCheckIdSchema = z.enum([
  'qrPairing',
  'encryptedSession',
  'backgroundResume',
  'guardianApproval',
  'networkHandoff',
  'revoke',
  'hardwareAttestation',
  'privacyAudit',
]);
export type RemoteControlPhysicalSmokeCheckId = z.infer<
  typeof remoteControlPhysicalSmokeCheckIdSchema
>;

const passedCheckSchema = z
  .object({
    outcome: z.literal('passed'),
  })
  .strict();

export const remoteControlPhysicalSmokeReportSchema = z
  .object({
    schemaVersion: z.literal(REMOTE_CONTROL_PHYSICAL_SMOKE_SCHEMA_VERSION),
    outcome: z.literal('passed'),
    platform: z.enum(['ios', 'android']),
    deviceModel: z.string().trim().min(1).max(120),
    osVersion: z.string().trim().min(1).max(80),
    appBuild: z.string().trim().min(1).max(120),
    attestationProvider: remoteControlNativeAttestationProviderSchema,
    trustLevel: z.literal('hardware-backed'),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    checks: z
      .object({
        qrPairing: passedCheckSchema,
        encryptedSession: passedCheckSchema,
        backgroundResume: passedCheckSchema,
        guardianApproval: passedCheckSchema,
        networkHandoff: passedCheckSchema,
        revoke: passedCheckSchema,
        hardwareAttestation: passedCheckSchema,
        privacyAudit: passedCheckSchema,
      })
      .strict(),
    privacy: z
      .object({
        rawEvidencePersisted: z.literal(false),
        rawEvidenceAudited: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .refine((report) => report.completedAt >= report.startedAt, {
    message: 'completedAt must not be earlier than startedAt',
  });
export type RemoteControlPhysicalSmokeReport = z.infer<
  typeof remoteControlPhysicalSmokeReportSchema
>;

export interface RemoteControlPhysicalSmokeInput {
  platform: 'ios' | 'android';
  deviceModel: string;
  osVersion: string;
  appBuild: string;
  attestationProvider: RemoteControlPhysicalSmokeReport['attestationProvider'];
  startedAt: number;
  completedAt?: number;
  checks: Record<RemoteControlPhysicalSmokeCheckId, boolean>;
}

export function createRemoteControlPhysicalSmokeReport(
  input: RemoteControlPhysicalSmokeInput,
): RemoteControlPhysicalSmokeReport {
  const expectedProvider =
    input.platform === 'ios' ? 'apple-app-attest' : 'android-play-integrity';
  if (input.attestationProvider !== expectedProvider) {
    throw new Error(
      `${input.platform} physical smoke requires ${expectedProvider}`,
    );
  }
  const missingChecks = remoteControlPhysicalSmokeCheckIdSchema.options.filter(
    (check) => input.checks[check] !== true,
  );
  if (missingChecks.length > 0) {
    throw new Error(
      `physical smoke checks must be explicitly confirmed: ${missingChecks.join(', ')}`,
    );
  }
  return remoteControlPhysicalSmokeReportSchema.parse({
    schemaVersion: REMOTE_CONTROL_PHYSICAL_SMOKE_SCHEMA_VERSION,
    outcome: 'passed',
    platform: input.platform,
    deviceModel: input.deviceModel,
    osVersion: input.osVersion,
    appBuild: input.appBuild,
    attestationProvider: input.attestationProvider,
    trustLevel: 'hardware-backed',
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? Date.now(),
    checks: Object.fromEntries(
      remoteControlPhysicalSmokeCheckIdSchema.options.map((check) => [
        check,
        { outcome: 'passed' as const },
      ]),
    ),
    privacy: {
      rawEvidencePersisted: false,
      rawEvidenceAudited: false,
    },
  });
}
