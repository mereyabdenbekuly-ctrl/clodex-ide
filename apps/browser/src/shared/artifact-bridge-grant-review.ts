import { z } from 'zod';
import {
  artifactBridgeCapabilitySchema,
  artifactBridgePolicySchema,
  type ArtifactBridgeContext,
} from './artifact-bridge';
import {
  generatedAppIdentitySchema,
  generatedAppManifestSchema,
} from './generated-app-manifest';

export const ARTIFACT_BRIDGE_GRANT_REVIEW_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_BRIDGE_POLICY_HASH_VERSION = 1 as const;

const identifierSchema = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const utf8Encoder = new TextEncoder();

export const artifactBridgeGrantReviewContextSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('agent'),
        agentId: identifierSchema,
        appId: identifierSchema,
        pluginId: identifierSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('package'),
        packageId: identifierSchema,
        appId: identifierSchema,
      })
      .strict(),
  ],
);

export const artifactBridgeGrantReviewIdentitySchema =
  generatedAppIdentitySchema.strict();

export const artifactBridgeGrantReviewToolSchema = z
  .object({
    serverId: identifierSchema,
    toolName: identifierSchema,
  })
  .strict();

export const artifactBridgeGrantReviewScopeSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('persistent') }).strict(),
    z
      .object({
        kind: z.literal('session'),
        sessionId: z.string().uuid(),
      })
      .strict(),
  ],
);

export const artifactBridgeGrantReviewSelectionSchema = z
  .object({
    scope: artifactBridgeGrantReviewScopeSchema,
    capabilities: z.array(artifactBridgeCapabilitySchema).max(8),
    mcpTools: z.array(artifactBridgeGrantReviewToolSchema).max(100),
    mcpWriteTools: z.array(artifactBridgeGrantReviewToolSchema).max(100),
    automationIds: z.array(z.string().uuid()).max(100),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((selection, context) => {
    addDuplicateIssues(selection.capabilities, context, ['capabilities']);
    addDuplicateIssues(selection.mcpTools.map(toolKey), context, ['mcpTools']);
    addDuplicateIssues(selection.mcpWriteTools.map(toolKey), context, [
      'mcpWriteTools',
    ]);
    addDuplicateIssues(selection.automationIds, context, ['automationIds']);
  });

export const artifactBridgeGrantReviewProvenanceSchema = z
  .object({ kind: z.literal('agent') })
  .strict();

export const artifactBridgeGrantReviewSnapshotSchema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_BRIDGE_GRANT_REVIEW_SCHEMA_VERSION),
    reviewId: z.string().uuid(),
    context: artifactBridgeGrantReviewContextSchema,
    identity: artifactBridgeGrantReviewIdentitySchema,
    manifest: generatedAppManifestSchema,
    policy: artifactBridgePolicySchema,
    policyHash: sha256Schema,
    provenance: artifactBridgeGrantReviewProvenanceSchema,
    openedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    selection: artifactBridgeGrantReviewSelectionSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.openedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Grant review expiry must be after its open time',
      });
    }
  });

export const artifactBridgeGrantReviewSubmissionSchema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_BRIDGE_GRANT_REVIEW_SCHEMA_VERSION),
    reviewId: z.string().uuid(),
    context: artifactBridgeGrantReviewContextSchema,
    identity: artifactBridgeGrantReviewIdentitySchema,
    selection: artifactBridgeGrantReviewSelectionSchema,
  })
  .strict();

export type ArtifactBridgeGrantReviewContext = z.infer<
  typeof artifactBridgeGrantReviewContextSchema
>;
export type ArtifactBridgeGrantReviewSelection = z.infer<
  typeof artifactBridgeGrantReviewSelectionSchema
>;
export type ArtifactBridgeGrantReviewSnapshot = z.infer<
  typeof artifactBridgeGrantReviewSnapshotSchema
>;
export type ArtifactBridgeGrantReviewSubmission = z.infer<
  typeof artifactBridgeGrantReviewSubmissionSchema
>;

export function canonicalizeArtifactBridgePolicy(
  policy: z.input<typeof artifactBridgePolicySchema>,
): string {
  return JSON.stringify(
    sortJsonValue(artifactBridgePolicySchema.parse(policy)),
  );
}

export function createArtifactBridgePolicyHashTranscript(
  policy: z.input<typeof artifactBridgePolicySchema>,
): string {
  return `clodex.artifact-bridge.policy.v${ARTIFACT_BRIDGE_POLICY_HASH_VERSION}\0${canonicalizeArtifactBridgePolicy(policy)}`;
}

export function canonicalizeArtifactBridgeGrantReviewSelection(
  rawSelection: z.input<typeof artifactBridgeGrantReviewSelectionSchema>,
): ArtifactBridgeGrantReviewSelection {
  const selection =
    artifactBridgeGrantReviewSelectionSchema.parse(rawSelection);
  return artifactBridgeGrantReviewSelectionSchema.parse({
    ...selection,
    capabilities: [...selection.capabilities].sort(compareUtf8),
    mcpTools: [...selection.mcpTools].sort(compareTools),
    mcpWriteTools: [...selection.mcpWriteTools].sort(compareTools),
    automationIds: [...selection.automationIds].sort(compareUtf8),
  });
}

export function artifactBridgeGrantReviewContextsEqual(
  left: ArtifactBridgeContext,
  right: ArtifactBridgeContext,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function toolKey(tool: { serverId: string; toolName: string }): string {
  return `${tool.serverId}\0${tool.toolName}`;
}

function compareTools(
  left: { serverId: string; toolName: string },
  right: { serverId: string; toolName: string },
): number {
  return compareUtf8(toolKey(left), toolKey(right));
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Grant review selections must not contain duplicates',
    });
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
