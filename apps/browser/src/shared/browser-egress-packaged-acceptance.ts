import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export const browserEgressPackagedAcceptanceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('browser-egress-packaged-acceptance'),
    createdAt: z.string().datetime(),
    result: z.literal('passed'),
    app: z
      .object({
        platform: z.literal('darwin'),
        architecture: z.enum(['arm64', 'x64']),
        releaseChannel: z.enum(['prerelease', 'nightly']),
        version: semanticVersionSchema,
      })
      .strict(),
    enforcement: z
      .object({
        outcome: z.literal('fail-closed'),
        browserSignal: z.enum([
          'proxy-denial-response',
          'load-error-page',
          'navigation-failed',
        ]),
        promptObserved: z.literal(false),
        allowReasonCode: z.literal('exact-destination-grant'),
        denyReasonCode: z.literal('loopback-denied'),
      })
      .strict(),
    checks: z
      .object({
        packagedAppLaunched: z.literal(true),
        realUiBrowserTabOpened: z.literal(true),
        localNavigationSucceeded: z.literal(true),
        auditChainVerified: z.literal(true),
        blockedAttemptFailClosed: z.literal(true),
        zeroSinkConnections: z.literal(true),
        zeroSinkRequests: z.literal(true),
        zeroSinkBodyBytes: z.literal(true),
      })
      .strict(),
    counts: z
      .object({
        localFixtureRequests: z.number().int().positive(),
        allowedAuditDecisions: z.number().int().positive(),
        deniedAuditDecisions: z.number().int().positive(),
        sinkConnections: z.literal(0),
        sinkRequests: z.literal(0),
        sinkBodyBytes: z.literal(0),
        unexpectedAllows: z.literal(0),
      })
      .strict(),
    audit: z
      .object({
        verified: z.literal(true),
        policyHash: sha256Schema,
        terminalEventHash: sha256Schema,
      })
      .strict(),
    retention: z
      .object({
        rawLogs: z.literal(false),
        rawAudit: z.literal(false),
        networkAddresses: z.literal(false),
        responseBodies: z.literal(false),
        screenshots: z.literal(false),
        profileData: z.literal(false),
        inheritedSecrets: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type BrowserEgressPackagedAcceptanceManifest = z.infer<
  typeof browserEgressPackagedAcceptanceManifestSchema
>;

export function serializeBrowserEgressPackagedAcceptanceManifest(
  value: BrowserEgressPackagedAcceptanceManifest,
): string {
  return `${JSON.stringify(
    browserEgressPackagedAcceptanceManifestSchema.parse(value),
    null,
    2,
  )}\n`;
}
