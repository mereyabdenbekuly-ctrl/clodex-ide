import {
  artifactBridgeContextSchema,
  type artifactBridgeGrantInputSchema,
  artifactBridgeGrantSchema,
  type ArtifactBridgeGrant,
  type ArtifactBridgeSessionBinding,
} from '@shared/artifact-bridge';
import {
  generatedAppIdentitySchema,
  generatedAppManifestSchema,
  type GeneratedAppIdentity,
} from '@shared/generated-app-manifest';
import { z } from 'zod';

export const MAX_RESULT_BYTES = 1_000_000;
export const MAX_CALLS_PER_MINUTE = 30;
export const agentAskModelAdapterIdentitySchema = z
  .object({
    modelId: z.string().trim().min(1).max(256),
    resolvedProviderId: z.string().trim().min(1).max(256),
    resolvedModelId: z.string().trim().min(1).max(256),
    adapterId: z.literal('clodex.artifact-bridge.ai-sdk.generate-text'),
    adapterVersion: z.literal(1),
    maxOutputTokens: z.literal(1_024),
    timeoutMs: z.literal(30_000),
    maxRetries: z.literal(0),
  })
  .strict();
export type ParsedArtifactBridgeGrantInput = z.output<
  typeof artifactBridgeGrantInputSchema
>;
export const resolvedArtifactBridgeAppSchema = z
  .object({
    identity: generatedAppIdentitySchema,
    manifest: generatedAppManifestSchema,
  })
  .strict();
export type ResolvedArtifactBridgeApp = z.output<
  typeof resolvedArtifactBridgeAppSchema
>;
export const PROCEDURES = [
  'artifactBridge.getGrant',
  'artifactBridge.getActiveSessions',
  'artifactBridge.getRuntimeInspector',
  'artifactBridge.openGrantReview',
  'artifactBridge.submitGrantReview',
  'artifactBridge.revokeGrant',
  'artifactBridge.getPolicy',
  'artifactBridge.approveWrite',
  'artifactBridge.rejectWrite',
  'artifactBridge.approveSensitiveMcpCall',
  'artifactBridge.rejectSensitiveMcpCall',
] as const;

export const pendingGrantMutationSchema = z
  .object({
    mutationId: z.string().uuid(),
    kind: z.enum(['set', 'revoke']),
    context: artifactBridgeContextSchema,
    startedAt: z.string().datetime(),
  })
  .strict();
export const grantStoreSchema = z
  .object({
    version: z.literal(5),
    grants: z.record(z.string(), artifactBridgeGrantSchema),
    pendingMutations: z
      .record(z.string(), pendingGrantMutationSchema)
      .optional(),
  })
  .strict();
export type GrantStore = z.infer<typeof grantStoreSchema>;

const legacyAgentContextSchema = z.object({
  agentId: z.string().min(1).max(256),
  appId: z.string().min(1).max(256),
  pluginId: z.string().min(1).max(256).optional(),
});
const v4GrantSchema = artifactBridgeGrantSchema
  .omit({ schemaVersion: true, scope: true })
  .extend({ schemaVersion: z.literal(4) });
const v4GrantStoreSchema = z.object({
  version: z.literal(4),
  grants: z.record(z.string(), v4GrantSchema),
});
export { v4GrantStoreSchema };
const v3GrantSchema = v4GrantSchema
  .omit({ schemaVersion: true, context: true })
  .extend({
    schemaVersion: z.literal(3),
    context: legacyAgentContextSchema,
  });
const v3GrantStoreSchema = z.object({
  version: z.literal(3),
  grants: z.record(z.string(), v3GrantSchema),
});
export { v3GrantStoreSchema };
const v2GrantSchema = v3GrantSchema
  .omit({ schemaVersion: true, mcpWriteTools: true })
  .extend({ schemaVersion: z.literal(2) });
const v2GrantStoreSchema = z.object({
  version: z.literal(2),
  grants: z.record(z.string(), v2GrantSchema),
});
export { v2GrantStoreSchema };

export const legacyGrantStoreSchema = z.object({
  version: z.literal(1),
  grants: z.record(z.string(), z.unknown()),
});

/** All grant-store schema versions accepted when loading persisted state. */
export const grantStoreReaderSchema = z.union([
  grantStoreSchema,
  v4GrantStoreSchema,
  v3GrantStoreSchema,
  v2GrantStoreSchema,
  legacyGrantStoreSchema,
]);

export interface ArtifactBridgePersistence {
  load(): Promise<unknown>;
  save(store: GrantStore): Promise<void>;
}

/**
 * Backend-issued identity for one generated-app document lifetime.
 *
 * The context is deliberately not repeated in the value returned to the
 * caller: it remains an independent, trusted argument at every backend
 * boundary and is checked against the stored session record.
 */
export interface ArtifactBridgeHostSessionBinding
  extends ArtifactBridgeSessionBinding {
  documentSlotId: string;
  openedAt: string;
  assetHash: string;
}

export interface ValidatedArtifactBridgeHostSessionBinding
  extends ArtifactBridgeHostSessionBinding {
  identity: GeneratedAppIdentity;
  dispatchFence: HostDispatchFence;
}

export interface HostDispatchFence {
  readonly generationId: string;
  revoked: boolean;
}

export interface GrantDispatchFence {
  readonly grantId: string;
  readonly revision: number;
  revoked: boolean;
}

export interface ValidatedGrantBinding {
  readonly key: string;
  readonly grant: ArtifactBridgeGrant;
  readonly dispatchFence: GrantDispatchFence;
}
