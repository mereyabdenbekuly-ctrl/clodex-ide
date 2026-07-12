import { z } from 'zod';
import { generatedAppIdentitySchema } from './generated-app-manifest';

export const artifactBridgeCapabilitySchema = z.enum([
  'mcp:call',
  'mcp:write',
  'agent:ask',
  'automation:run',
]);
export type ArtifactBridgeCapability = z.infer<
  typeof artifactBridgeCapabilitySchema
>;

const agentArtifactBridgeContextSchema = z.object({
  kind: z.literal('agent'),
  agentId: z.string().min(1).max(256),
  appId: z.string().min(1).max(256),
  pluginId: z.string().min(1).max(256).optional(),
});
const packageArtifactBridgeContextSchema = z.object({
  kind: z.literal('package'),
  packageId: z.string().min(1).max(256),
  appId: z.string().min(1).max(256),
});
export const artifactBridgeContextSchema = z.discriminatedUnion('kind', [
  agentArtifactBridgeContextSchema,
  packageArtifactBridgeContextSchema,
]);
export type ArtifactBridgeContext = z.infer<typeof artifactBridgeContextSchema>;

export const artifactBridgeRequestSchema = z.discriminatedUnion('method', [
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('getCapabilities'),
    params: z.object({}).default({}),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('callMcpTool'),
    params: z.object({
      serverId: z.string().min(1).max(256),
      toolName: z.string().min(1).max(256),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('prepareSensitiveMcpCall'),
    params: z.object({
      serverId: z.string().min(1).max(256),
      toolName: z.string().min(1).max(256),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('commitSensitiveMcpCall'),
    params: z.object({
      proposalId: z.string().uuid(),
      commitToken: z.string().uuid(),
      asOperation: z.boolean().default(false),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('startMcpOperation'),
    params: z.object({
      serverId: z.string().min(1).max(256),
      toolName: z.string().min(1).max(256),
      arguments: z.record(z.string(), z.unknown()).default({}),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('startAutomationOperation'),
    params: z.object({
      automationId: z.string().uuid(),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('getOperation'),
    params: z.object({ operationId: z.string().uuid() }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('getOperationResult'),
    params: z.object({ operationId: z.string().uuid() }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('cancelOperation'),
    params: z.object({ operationId: z.string().uuid() }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('prepareMcpWrite'),
    params: z.object({
      serverId: z.string().min(1).max(256),
      toolName: z.string().min(1).max(256),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('commitMcpWrite'),
    params: z.object({
      proposalId: z.string().uuid(),
      commitToken: z.string().uuid(),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('askAgent'),
    params: z.object({
      prompt: z.string().trim().min(1).max(10_000),
    }),
  }),
  z.object({
    id: z.string().min(1).max(128),
    method: z.literal('runAutomation'),
    params: z.object({
      automationId: z.string().uuid(),
    }),
  }),
]);
export type ArtifactBridgeRequest = z.infer<typeof artifactBridgeRequestSchema>;

export const artifactBridgeEnvelopeSchema = z.object({
  __clodexArtifactBridge: z.literal(2),
  type: z.literal('request'),
  sessionId: z.string().uuid(),
  request: artifactBridgeRequestSchema,
});
export type ArtifactBridgeEnvelope = z.infer<
  typeof artifactBridgeEnvelopeSchema
>;

export type ArtifactBridgeResponse = {
  __clodexArtifactBridge: 2;
  type: 'response';
  sessionId: string;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const artifactBridgeLifecycleEventBaseSchema = z.object({
  eventId: z.string().uuid(),
  context: artifactBridgeContextSchema,
  occurredAt: z.string().datetime(),
});

export const artifactBridgeOperationKindSchema = z.enum(['mcp', 'automation']);
export type ArtifactBridgeOperationKind = z.infer<
  typeof artifactBridgeOperationKindSchema
>;

export const artifactBridgeOperationStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);
export type ArtifactBridgeOperationStatus = z.infer<
  typeof artifactBridgeOperationStatusSchema
>;

export const artifactBridgeOperationSnapshotSchema = z.object({
  id: z.string().uuid(),
  context: artifactBridgeContextSchema,
  kind: artifactBridgeOperationKindSchema,
  status: artifactBridgeOperationStatusSchema,
  label: z.string().min(1).max(300),
  progress: z.object({
    phase: z.enum(['queued', 'running', 'finalizing', 'finished']),
    percent: z.number().min(0).max(100).nullable(),
  }),
  cancellable: z.boolean(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  error: z.string().max(500).nullable(),
});
export type ArtifactBridgeOperationSnapshot = z.infer<
  typeof artifactBridgeOperationSnapshotSchema
>;

export const artifactBridgeLifecycleEventSchema = z.discriminatedUnion('type', [
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('capabilitiesChanged'),
    reason: z.enum(['grant-saved', 'policy-changed']),
  }),
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('revoked'),
    reason: z.enum([
      'grant-revoked',
      'grant-expired',
      'session-closed',
      'app-deleted',
      'policy-invalidated',
      'trust-invalidated',
    ]),
    sessionId: z.string().uuid().optional(),
  }),
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('identityChanged'),
    reason: z.enum(['identity-mismatch', 'app-unavailable']),
  }),
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('packageTrustChanged'),
    reason: z.literal('publisher-trust-changed'),
  }),
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('packagePolicyChanged'),
    reason: z.literal('publisher-policy-changed'),
  }),
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('automationCompleted'),
    automationId: z.string().uuid(),
    outcome: z.enum(['success', 'error']),
  }),
  artifactBridgeLifecycleEventBaseSchema.extend({
    type: z.literal('operationChanged'),
    sessionId: z.string().uuid().optional(),
    operation: artifactBridgeOperationSnapshotSchema,
  }),
]);
export type ArtifactBridgeLifecycleEvent = z.infer<
  typeof artifactBridgeLifecycleEventSchema
>;

export type ArtifactBridgeLifecycleEnvelope = {
  __clodexArtifactBridge: 2;
  type: 'event';
  sessionId: string;
  event: ArtifactBridgeLifecycleEvent;
};

export const artifactBridgeRuntimeQuotaSnapshotSchema = z.object({
  enabled: z.boolean(),
  maxConcurrentInvocations: z.number().int().positive(),
  maxAgentAsksPerHour: z.number().int().nonnegative(),
  maxAutomationRunsPerHour: z.number().int().nonnegative(),
  remainingAgentAsksThisHour: z.number().int().nonnegative(),
  remainingAutomationRunsThisHour: z.number().int().nonnegative(),
});
export type ArtifactBridgeRuntimeQuotaSnapshot = z.infer<
  typeof artifactBridgeRuntimeQuotaSnapshotSchema
>;

export type ArtifactBridgeConnect = {
  __clodexArtifactBridge: 2;
  type: 'connect';
  sessionId: string;
};

const artifactBridgeMcpToolScopeSchema = z.object({
  serverId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256),
});

export const artifactBridgeGrantScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('persistent') }),
  z.object({
    kind: z.literal('session'),
    sessionId: z.string().uuid(),
  }),
]);
export type ArtifactBridgeGrantScope = z.infer<
  typeof artifactBridgeGrantScopeSchema
>;

export const artifactBridgeGrantSchema = z.object({
  schemaVersion: z.literal(5),
  context: artifactBridgeContextSchema,
  scope: artifactBridgeGrantScopeSchema,
  identity: generatedAppIdentitySchema,
  capabilities: z.array(artifactBridgeCapabilitySchema).max(8),
  mcpTools: z.array(artifactBridgeMcpToolScopeSchema).max(100).default([]),
  mcpWriteTools: z.array(artifactBridgeMcpToolScopeSchema).max(100).default([]),
  automationIds: z.array(z.string().uuid()).max(100).default([]),
  expiresAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime(),
});
export type ArtifactBridgeGrant = z.infer<typeof artifactBridgeGrantSchema>;

export const artifactBridgeGrantInputSchema = artifactBridgeGrantSchema
  .omit({
    schemaVersion: true,
    updatedAt: true,
    scope: true,
  })
  .extend({
    identity: generatedAppIdentitySchema.optional(),
    scope: artifactBridgeGrantScopeSchema.default({ kind: 'persistent' }),
  });
export type ArtifactBridgeGrantInput = z.input<
  typeof artifactBridgeGrantInputSchema
>;

export const artifactBridgeGrantRevokeScopeSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('persistent') }),
    z.object({
      kind: z.literal('session'),
      sessionId: z.string().uuid(),
    }),
  ],
);
export type ArtifactBridgeGrantRevokeScope = z.infer<
  typeof artifactBridgeGrantRevokeScopeSchema
>;

export const artifactBridgeSessionSnapshotSchema = z.object({
  sessionId: z.string().uuid(),
  context: artifactBridgeContextSchema,
  openedAt: z.string().datetime(),
  hasEphemeralGrant: z.boolean(),
});
export type ArtifactBridgeSessionSnapshot = z.infer<
  typeof artifactBridgeSessionSnapshotSchema
>;

export const artifactBridgeAuditActionSchema = z.enum([
  'grant.saved',
  'grant.revoked',
  'capability.invoked',
  'write.prepared',
  'write.approved',
  'write.rejected',
  'write.committed',
  'sensitive-egress.prepared',
  'sensitive-egress.approved',
  'sensitive-egress.rejected',
  'sensitive-egress.committed',
  'operation.started',
  'operation.completed',
]);
export type ArtifactBridgeAuditAction = z.infer<
  typeof artifactBridgeAuditActionSchema
>;

export const artifactBridgeAuditEntrySchema = z.object({
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  action: artifactBridgeAuditActionSchema,
  outcome: z.enum(['success', 'denied', 'error']),
  context: artifactBridgeContextSchema,
  requestId: z.string().max(128).nullable(),
  method: z.string().max(128).nullable(),
  resource: z.string().max(513).nullable(),
  error: z.string().max(500).nullable(),
});
export type ArtifactBridgeAuditEntry = z.infer<
  typeof artifactBridgeAuditEntrySchema
>;

export const artifactBridgeSensitiveEgressReasonSchema = z.enum([
  'remote-network',
  'credential-sensitive',
]);
export type ArtifactBridgeSensitiveEgressReason = z.infer<
  typeof artifactBridgeSensitiveEgressReasonSchema
>;

export const artifactBridgeWriteProposalSchema = z.object({
  id: z.string().uuid(),
  context: artifactBridgeContextSchema,
  serverId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256),
  toolDescription: z.string().max(2_000).nullable(),
  argumentsPreview: z.string().max(20_000),
  risk: z.enum(['write', 'destructive']),
  sensitiveEgressReasons: z
    .array(artifactBridgeSensitiveEgressReasonSchema)
    .max(2)
    .default([]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type ArtifactBridgeWriteProposal = z.infer<
  typeof artifactBridgeWriteProposalSchema
>;

export const artifactBridgeWriteApprovalSchema = z.object({
  proposal: artifactBridgeWriteProposalSchema,
  commitToken: z.string().uuid(),
});
export type ArtifactBridgeWriteApproval = z.infer<
  typeof artifactBridgeWriteApprovalSchema
>;

export const artifactBridgeSensitiveMcpProposalSchema = z.object({
  id: z.string().uuid(),
  context: artifactBridgeContextSchema,
  serverId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256),
  toolDescription: z.string().max(2_000).nullable(),
  argumentsPreview: z.string().max(20_000),
  reasons: z.array(artifactBridgeSensitiveEgressReasonSchema).min(1).max(2),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type ArtifactBridgeSensitiveMcpProposal = z.infer<
  typeof artifactBridgeSensitiveMcpProposalSchema
>;

export const artifactBridgeSensitiveMcpApprovalSchema = z.object({
  proposal: artifactBridgeSensitiveMcpProposalSchema,
  commitToken: z.string().uuid(),
});
export type ArtifactBridgeSensitiveMcpApproval = z.infer<
  typeof artifactBridgeSensitiveMcpApprovalSchema
>;

const artifactBridgeToolPolicyPatternSchema = z
  .string()
  .trim()
  .min(3)
  .max(513)
  .regex(
    /^(?:\*|[^*/\s]+)\/(?:\*|[^*/\s]+)$/,
    'MCP tool policy patterns must use server/tool with optional wildcards',
  );

export const artifactBridgePolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    allowedCapabilities: z
      .array(artifactBridgeCapabilitySchema)
      .max(8)
      .default(['mcp:call', 'mcp:write', 'agent:ask', 'automation:run']),
    allowedMcpReadTools: z
      .array(artifactBridgeToolPolicyPatternSchema)
      .max(500)
      .default(['*/*']),
    allowedMcpWriteTools: z
      .array(artifactBridgeToolPolicyPatternSchema)
      .max(500)
      .default(['*/*']),
    allowedSensitiveMcpTools: z
      .array(artifactBridgeToolPolicyPatternSchema)
      .max(500)
      .default(['*/*']),
    deniedSensitiveMcpTools: z
      .array(artifactBridgeToolPolicyPatternSchema)
      .max(500)
      .default([]),
    allowNeverExpiringGrants: z.boolean().default(true),
    maxGrantDurationHours: z
      .number()
      .positive()
      .max(24 * 365)
      .default(720),
    writeProposalTtlSeconds: z.number().int().min(30).max(900).default(300),
    sensitiveEgressProposalTtlSeconds: z
      .number()
      .int()
      .min(30)
      .max(900)
      .default(300),
    maxConcurrentInvocations: z.number().int().min(1).max(16).default(2),
    maxAgentAsksPerHour: z.number().int().min(0).max(1_000).default(20),
    maxAutomationRunsPerHour: z.number().int().min(0).max(1_000).default(30),
    maxConcurrentAsyncOperations: z.number().int().min(1).max(32).default(3),
    maxAsyncOperationTimeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .default(300),
    asyncOperationRetentionSeconds: z
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(900),
  })
  .strict();
export type ArtifactBridgePolicy = z.infer<typeof artifactBridgePolicySchema>;

export const DEFAULT_ARTIFACT_BRIDGE_POLICY = artifactBridgePolicySchema.parse(
  {},
);

const artifactBridgeInspectorReviewStatusSchema = z.enum([
  'prepared',
  'approved',
  'committing',
  'committed',
]);

export const artifactBridgeInspectorReviewSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['mcp-write', 'sensitive-mcp']),
  sessionId: z.string().uuid().nullable(),
  serverId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256),
  status: artifactBridgeInspectorReviewStatusSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sensitiveEgressReasons: z
    .array(artifactBridgeSensitiveEgressReasonSchema)
    .max(2),
});
export type ArtifactBridgeInspectorReview = z.infer<
  typeof artifactBridgeInspectorReviewSchema
>;

export const artifactBridgeInspectorOperationSchema =
  artifactBridgeOperationSnapshotSchema.extend({
    sessionId: z.string().uuid().nullable(),
  });
export type ArtifactBridgeInspectorOperation = z.infer<
  typeof artifactBridgeInspectorOperationSchema
>;

export const artifactBridgeRuntimeInspectorSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  context: artifactBridgeContextSchema,
  featureFlags: z.object({
    writesEnabled: z.boolean(),
    runtimeQuotasEnabled: z.boolean(),
    lifecycleEventsEnabled: z.boolean(),
    ephemeralGrantsEnabled: z.boolean(),
    sensitiveEgressEnabled: z.boolean(),
    asyncOperationsEnabled: z.boolean(),
  }),
  policy: artifactBridgePolicySchema,
  persistentGrant: artifactBridgeGrantSchema.nullable(),
  sessionGrants: z.array(artifactBridgeGrantSchema).max(100),
  sessions: z.array(artifactBridgeSessionSnapshotSchema).max(100),
  runtimeQuotas: artifactBridgeRuntimeQuotaSnapshotSchema,
  activeInvocations: z.number().int().nonnegative(),
  rateLimitCallsLastMinute: z.number().int().nonnegative(),
  pendingReviews: z.array(artifactBridgeInspectorReviewSchema).max(200),
  operations: z.array(artifactBridgeInspectorOperationSchema).max(100),
  audit: z.array(artifactBridgeAuditEntrySchema).max(100),
});
export type ArtifactBridgeRuntimeInspectorSnapshot = z.infer<
  typeof artifactBridgeRuntimeInspectorSnapshotSchema
>;

export function isArtifactBridgeCapabilityAllowed(
  policy: ArtifactBridgePolicy,
  capability: ArtifactBridgeCapability,
): boolean {
  return policy.enabled && policy.allowedCapabilities.includes(capability);
}

export function matchesArtifactBridgeToolPolicy(
  patterns: readonly string[],
  serverId: string,
  toolName: string,
): boolean {
  return patterns.some((pattern) => {
    const separator = pattern.indexOf('/');
    if (separator < 0) return false;
    const serverPattern = pattern.slice(0, separator);
    const toolPattern = pattern.slice(separator + 1);
    return (
      (serverPattern === '*' || serverPattern === serverId) &&
      (toolPattern === '*' || toolPattern === toolName)
    );
  });
}

export type ArtifactBridgeGrantExpiryPreset = {
  value: 'day' | 'week' | 'month' | 'policy-max' | 'never';
  label: string;
  hours: number | null;
};

export function getArtifactBridgeGrantExpiryPresets(
  policy: ArtifactBridgePolicy,
): ArtifactBridgeGrantExpiryPreset[] {
  const candidatePresets: ArtifactBridgeGrantExpiryPreset[] = [
    { value: 'day', label: '1 day', hours: 24 },
    { value: 'week', label: '7 days', hours: 24 * 7 },
    { value: 'month', label: '30 days', hours: 24 * 30 },
  ];
  const presets = candidatePresets.filter(
    (preset) =>
      preset.hours !== null && preset.hours <= policy.maxGrantDurationHours,
  );

  const hasExactMaximum = presets.some(
    (preset) => preset.hours === policy.maxGrantDurationHours,
  );
  if (!hasExactMaximum) {
    presets.push({
      value: 'policy-max',
      label: formatPolicyDuration(policy.maxGrantDurationHours),
      hours: policy.maxGrantDurationHours,
    });
  }
  if (policy.allowNeverExpiringGrants) {
    presets.push({ value: 'never', label: 'No expiry', hours: null });
  }
  return presets;
}

function formatPolicyDuration(hours: number): string {
  if (hours < 24) {
    return `Policy maximum (${Number(hours.toFixed(2))} hours)`;
  }
  const days = hours / 24;
  return `Policy maximum (${Number(days.toFixed(2))} days)`;
}
