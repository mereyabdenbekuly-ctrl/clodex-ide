import { createHash, randomUUID } from 'node:crypto';
import { evaluateMcpToolPolicy } from '@clodex/mcp-runtime';
import {
  DEFAULT_ARTIFACT_BRIDGE_POLICY,
  artifactBridgeContextSchema,
  artifactBridgeGrantInputSchema,
  artifactBridgeGrantRevokeScopeSchema,
  artifactBridgeGrantSchema,
  artifactBridgeNavigationEpochSchema,
  artifactBridgePolicySchema,
  artifactBridgeRequestSchema,
  artifactBridgeRuntimeInspectorSnapshotSchema,
  artifactBridgeRuntimeQuotaSnapshotSchema,
  matchesArtifactBridgeToolPolicy,
  type ArtifactBridgeCapability,
  type ArtifactBridgeContext,
  type ArtifactBridgeGrant,
  type ArtifactBridgeGrantInput,
  type ArtifactBridgeGrantRevokeScope,
  type ArtifactBridgeLifecycleEvent,
  type ArtifactBridgeOperationKind,
  type ArtifactBridgeOperationSnapshot,
  type ArtifactBridgePolicy,
  type ArtifactBridgeRequest,
  type ArtifactBridgeRuntimeInspectorSnapshot,
  type ArtifactBridgeSensitiveEgressReason,
  type ArtifactBridgeSensitiveMcpApproval,
  type ArtifactBridgeSensitiveMcpProposal,
  type ArtifactBridgeSessionBinding,
  type ArtifactBridgeSessionSnapshot,
  type ArtifactBridgeWriteApproval,
  type ArtifactBridgeWriteProposal,
} from '@shared/artifact-bridge';
import {
  generatedAppIdentitySchema,
  generatedAppManifestSchema,
  getManifestAutomationIds,
  getManifestCapabilityTypes,
  getManifestMcpTools,
  getManifestMcpWriteTools,
  type GeneratedAppIdentity,
  type GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import type {
  ArtifactBridgeGrantReviewSelection,
  ArtifactBridgeGrantReviewSnapshot,
  ArtifactBridgeGrantReviewSubmission,
} from '@shared/artifact-bridge-grant-review';
import type { AgenticAppRuntimeDogfoodTelemetry } from '@shared/agentic-app-runtime-telemetry';
import { z } from 'zod';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import { DisposableService } from '../disposable';
import { TRUSTED_UI_REVIEWER_CONNECTION_ID } from '../trusted-ui-karton-transport';
import {
  artifactBridgeAuditResource,
  auditContext,
  type ArtifactBridgeAuditReader,
  type ArtifactBridgeAuditRecorder,
} from './audit-ledger';
import {
  canonicalizeArtifactBridgeJson,
  hashArtifactBridgeJson,
} from './canonical-json';
import {
  assertNoRawSecrets,
  classifySensitiveMcpOperation,
  redactSensitiveText,
  sanitizeSensitiveValue,
} from './sensitive-egress';
import { ArtifactBridgeGrantReviewRegistry } from './grant-review-registry';
import {
  artifactBridgeMcpCommitmentsEqual,
  createArtifactBridgeMcpEffectCommitment,
  type ArtifactBridgeMcpEffectCommitment,
  type ArtifactBridgeTrustedMcpClassification,
} from './effect-commitment';
import {
  ArtifactBridgeEffectWal,
  MemoryArtifactBridgeEffectWal,
  PersistedArtifactBridgeEffectWal,
  type ArtifactBridgeEffectWalPersistence,
} from './effect-wal';

const MAX_RESULT_BYTES = 1_000_000;
const MAX_CALLS_PER_MINUTE = 30;
type ParsedArtifactBridgeGrantInput = z.output<
  typeof artifactBridgeGrantInputSchema
>;
const resolvedArtifactBridgeAppSchema = z
  .object({
    identity: generatedAppIdentitySchema,
    manifest: generatedAppManifestSchema,
  })
  .strict();
type ResolvedArtifactBridgeApp = z.output<
  typeof resolvedArtifactBridgeAppSchema
>;
const PROCEDURES = [
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

const pendingGrantMutationSchema = z
  .object({
    mutationId: z.string().uuid(),
    kind: z.enum(['set', 'revoke']),
    context: artifactBridgeContextSchema,
    startedAt: z.string().datetime(),
  })
  .strict();
const grantStoreSchema = z
  .object({
    version: z.literal(5),
    grants: z.record(z.string(), artifactBridgeGrantSchema),
    pendingMutations: z
      .record(z.string(), pendingGrantMutationSchema)
      .optional(),
  })
  .strict();
type GrantStore = z.infer<typeof grantStoreSchema>;

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
const v2GrantSchema = v3GrantSchema
  .omit({ schemaVersion: true, mcpWriteTools: true })
  .extend({ schemaVersion: z.literal(2) });
const v2GrantStoreSchema = z.object({
  version: z.literal(2),
  grants: z.record(z.string(), v2GrantSchema),
});

const legacyGrantStoreSchema = z.object({
  version: z.literal(1),
  grants: z.record(z.string(), z.unknown()),
});

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

interface ValidatedArtifactBridgeHostSessionBinding
  extends ArtifactBridgeHostSessionBinding {
  identity: GeneratedAppIdentity;
  dispatchFence: HostDispatchFence;
}

interface HostDispatchFence {
  readonly generationId: string;
  revoked: boolean;
}

interface GrantDispatchFence {
  readonly grantId: string;
  readonly revision: number;
  revoked: boolean;
}

interface ValidatedGrantBinding {
  readonly key: string;
  readonly grant: ArtifactBridgeGrant;
  readonly dispatchFence: GrantDispatchFence;
}

export interface ArtifactBridgeServiceOptions {
  logger: Logger;
  karton: KartonService;
  mcpRegistry: McpRegistryService;
  isFeatureEnabled: () => boolean;
  arePackageCapabilitiesEnabled?: () => boolean;
  areRuntimeQuotasEnabled?: () => boolean;
  areLifecycleEventsEnabled?: () => boolean;
  areEphemeralGrantsEnabled?: () => boolean;
  isSensitiveEgressEnabled?: () => boolean;
  areAsyncOperationsEnabled?: () => boolean;
  isRuntimeInspectorEnabled?: () => boolean;
  emitLifecycleEvent?: (event: ArtifactBridgeLifecycleEvent) => Promise<void>;
  captureDogfoodTelemetry?: (
    context: ArtifactBridgeContext,
    observation: Omit<
      AgenticAppRuntimeDogfoodTelemetry,
      'principal_kind' | 'app_instance_hash'
    >,
  ) => void;
  askAgent: (
    context: ArtifactBridgeContext,
    prompt: string,
    options?: { beforeDispatch?: () => void },
  ) => Promise<string>;
  runAutomation: (
    automationId: string,
    options?: {
      beforeDispatch?: (input: {
        automation: unknown;
        prompt: string;
        attempt: number;
      }) => void;
      retryMode?: 'configured' | 'no-blind-retry';
      failureMode?: 'record' | 'propagate';
    },
  ) => Promise<unknown>;
  resolveApp: (context: ArtifactBridgeContext) => Promise<{
    identity: GeneratedAppIdentity;
    manifest: GeneratedAppManifest;
  } | null>;
  auditRecorder?: ArtifactBridgeAuditRecorder;
  auditReader?: ArtifactBridgeAuditReader;
  getPolicy?: (context: ArtifactBridgeContext) => ArtifactBridgePolicy;
  areWritesEnabled?: () => boolean;
  persistence?: ArtifactBridgePersistence;
  effectWalPersistence?: ArtifactBridgeEffectWalPersistence;
  now?: () => number;
}

class PersistedGrantStore implements ArtifactBridgePersistence {
  async load(): Promise<unknown> {
    const { readPersistedData } = await import('@/utils/persisted-data');
    return await readPersistedData(
      'artifact-capability-grants',
      z.union([
        grantStoreSchema,
        v4GrantStoreSchema,
        v3GrantStoreSchema,
        v2GrantStoreSchema,
        legacyGrantStoreSchema,
      ]),
      { version: 5, grants: {} },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
  }

  async save(store: GrantStore): Promise<void> {
    const { writePersistedData } = await import('@/utils/persisted-data');
    await writePersistedData(
      'artifact-capability-grants',
      grantStoreSchema,
      store,
      {
        encrypt: true,
        requireEncryption: true,
      },
    );
  }
}

export class ArtifactBridgeService extends DisposableService {
  private store: GrantStore = { version: 5, grants: {} };
  private readonly persistence: ArtifactBridgePersistence;
  private readonly now: () => number;
  private saveQueue = Promise.resolve();
  private readonly recentCalls = new Map<string, number[]>();
  private readonly activeInvocations = new Map<string, number>();
  private readonly operationCalls = new Map<string, number[]>();
  private readonly writes = new Map<string, PreparedWrite>();
  private readonly sensitiveMcpCalls = new Map<
    string,
    PreparedSensitiveMcpCall
  >();
  private readonly operations = new Map<string, ArtifactBridgeOperation>();
  private readonly lifecycleInvalidationSignals = new Set<string>();
  private readonly activeSessions = new Map<
    string,
    | {
        context: ArtifactBridgeContext;
        openedAt: string;
        hostIssued: false;
        navigationEpoch: null;
      }
    | {
        context: ArtifactBridgeContext;
        openedAt: string;
        hostIssued: true;
        documentSlotId: string;
        navigationEpoch: number;
        identity: GeneratedAppIdentity;
        dispatchFence: HostDispatchFence;
      }
  >();
  private readonly hostDocumentSlots = new Map<
    string,
    {
      context: ArtifactBridgeContext;
      navigationEpoch: number;
      sessionId: string;
    }
  >();
  private readonly hostSessionMutationQueues = new Map<string, Promise<void>>();
  private readonly ephemeralGrants = new Map<string, ArtifactBridgeGrant>();
  private readonly grantDispatchFences = new Map<
    string,
    { grant: ArtifactBridgeGrant; dispatchFence: GrantDispatchFence }
  >();
  private readonly validatedGrantBindings = new WeakMap<
    ArtifactBridgeGrant,
    ValidatedGrantBinding
  >();
  private readonly grantMutationEpochs = new Map<string, number>();
  private readonly grantReviewMutationEpochs = new Map<
    string,
    { contextKey: string; epoch: number }
  >();
  private readonly pendingPersistentGrantMutations = new Map<string, number>();
  private readonly pendingPersistentGrantRevocations = new Map<
    string,
    ArtifactBridgeContext
  >();
  private readonly dirtyPersistentGrantContexts = new Set<string>();
  private nextGrantRevision = 0;
  private effectWal!: ArtifactBridgeEffectWal;
  private readonly grantReviews: ArtifactBridgeGrantReviewRegistry;

  private constructor(private readonly options: ArtifactBridgeServiceOptions) {
    super();
    this.persistence = options.persistence ?? new PersistedGrantStore();
    this.now = options.now ?? Date.now;
    this.grantReviews = new ArtifactBridgeGrantReviewRegistry({
      resolveApp: async (context) => await this.resolveValidatedApp(context),
      getPolicy: (context) => this.getGrantReviewPolicy(context),
      now: this.now,
    });
  }

  public static async create(
    options: ArtifactBridgeServiceOptions,
  ): Promise<ArtifactBridgeService> {
    const service = new ArtifactBridgeService(options);
    service.effectWal = await ArtifactBridgeEffectWal.create(
      options.effectWalPersistence ??
        (options.persistence
          ? new MemoryArtifactBridgeEffectWal()
          : new PersistedArtifactBridgeEffectWal()),
      service.now,
    );
    const persisted = await service.persistence.load();
    const parsed = grantStoreSchema.safeParse(persisted);
    if (parsed.success) {
      service.store = parsed.data;
      const pendingMutations = Object.entries(
        service.store.pendingMutations ?? {},
      );
      if (pendingMutations.length > 0) {
        const reconciled = structuredClone(service.store);
        for (const [storedKey, mutation] of pendingMutations) {
          delete reconciled.grants[storedKey];
          delete reconciled.grants[service.contextKey(mutation.context)];
        }
        delete reconciled.pendingMutations;
        grantStoreSchema.parse(reconciled);
        await service.persistence.save(reconciled);
        service.store = reconciled;
        for (const [, mutation] of pendingMutations) {
          await options.auditRecorder?.record({
            action: 'grant.revoked',
            outcome: 'success',
            context: auditContext(mutation.context),
            resource: `recovery:incomplete-${mutation.kind}-mutation`,
          });
        }
      }
    } else {
      const v4 = v4GrantStoreSchema.safeParse(persisted);
      if (v4.success) {
        service.store = {
          version: 5,
          grants: Object.fromEntries(
            Object.values(v4.data.grants).map((grant) => {
              const migrated = artifactBridgeGrantSchema.parse({
                ...grant,
                schemaVersion: 5,
                scope: { kind: 'persistent' },
              });
              return [service.contextKey(migrated.context), migrated];
            }),
          ),
        };
        await service.persistence.save(service.store);
        service.registerProcedures();
        return service;
      }
      const v3 = v3GrantStoreSchema.safeParse(persisted);
      if (v3.success) {
        service.store = {
          version: 5,
          grants: Object.fromEntries(
            Object.values(v3.data.grants).map((grant) => {
              const migrated = artifactBridgeGrantSchema.parse({
                ...grant,
                schemaVersion: 5,
                context: { kind: 'agent', ...grant.context },
                scope: { kind: 'persistent' },
              });
              return [service.contextKey(migrated.context), migrated];
            }),
          ),
        };
        await service.persistence.save(service.store);
        service.registerProcedures();
        return service;
      }
      const v2 = v2GrantStoreSchema.safeParse(persisted);
      if (v2.success) {
        service.store = {
          version: 5,
          grants: Object.fromEntries(
            Object.values(v2.data.grants).map((grant) => {
              const migrated = artifactBridgeGrantSchema.parse({
                ...grant,
                schemaVersion: 5,
                context: { kind: 'agent', ...grant.context },
                mcpWriteTools: [],
                scope: { kind: 'persistent' },
              });
              return [service.contextKey(migrated.context), migrated];
            }),
          ),
        };
        await service.persistence.save(service.store);
        service.registerProcedures();
        return service;
      }
      const legacy = legacyGrantStoreSchema.safeParse(persisted);
      if (legacy.success && Object.keys(legacy.data.grants).length > 0) {
        options.logger.warn(
          '[ArtifactBridge] Legacy capability grants were revoked because they were not bound to an app manifest',
          { grantCount: Object.keys(legacy.data.grants).length },
        );
      }
      service.store = { version: 5, grants: {} };
      await service.persistence.save(service.store);
    }
    service.registerProcedures();
    return service;
  }

  private registerProcedures(): void {
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.getGrant',
      async (clientId, context, sessionId) => {
        assertTrustedReviewer(clientId);
        return await this.getGrant(context, sessionId);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.getActiveSessions',
      async (clientId, context) => {
        assertTrustedReviewer(clientId);
        return this.getActiveSessions(context);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.getRuntimeInspector',
      async (clientId, context) => {
        assertTrustedReviewer(clientId);
        return await this.getRuntimeInspector(context);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.openGrantReview',
      async (clientId, context, selection) => {
        assertTrustedReviewer(clientId);
        return await this.openGrantReview(context, selection);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.submitGrantReview',
      async (clientId, submission) => {
        assertTrustedReviewer(clientId);
        return await this.submitGrantReview(submission);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.revokeGrant',
      async (clientId, context, scope) => {
        assertTrustedReviewer(clientId);
        await this.revokeGrant(context, scope);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.getPolicy',
      async (clientId, context) => {
        assertTrustedReviewer(clientId);
        return this.getGrantReviewPolicy(
          artifactBridgeContextSchema.parse(context),
        );
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.approveWrite',
      async (clientId, context, proposalId, sessionId) => {
        assertTrustedReviewer(clientId);
        return await this.approveWrite(context, proposalId, sessionId);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.rejectWrite',
      async (clientId, context, proposalId, sessionId) => {
        assertTrustedReviewer(clientId);
        await this.rejectWrite(context, proposalId, sessionId);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.approveSensitiveMcpCall',
      async (clientId, context, proposalId, sessionId) => {
        assertTrustedReviewer(clientId);
        return await this.approveSensitiveMcpCall(
          context,
          proposalId,
          sessionId,
        );
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.rejectSensitiveMcpCall',
      async (clientId, context, proposalId, sessionId) => {
        assertTrustedReviewer(clientId);
        await this.rejectSensitiveMcpCall(context, proposalId, sessionId);
      },
    );
  }

  public async invoke(
    rawContext: ArtifactBridgeContext,
    rawRequest: ArtifactBridgeRequest,
    rawSessionId?: string,
  ): Promise<unknown> {
    return await this.invokeInternal(rawContext, rawRequest, rawSessionId);
  }

  private async invokeInternal(
    rawContext: ArtifactBridgeContext,
    rawRequest: ArtifactBridgeRequest,
    rawSessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<unknown> {
    this.assertEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const request = artifactBridgeRequestSchema.parse(rawRequest);
    const sessionId = rawSessionId
      ? z.string().uuid().parse(rawSessionId)
      : undefined;
    let enteredInvocation = false;

    try {
      this.enforceRateLimit(context);
      enteredInvocation = this.enterInvocation(context);
      let result: unknown;
      if (request.method === 'getCapabilities') {
        const grant = await this.getGrant(context, sessionId);
        this.requireExactHostSessionBinding(context, exactHostBinding);
        const policy = this.getPolicy(context);
        result = {
          version: 2,
          capabilities: grant?.capabilities ?? [],
          mcpTools: grant?.mcpTools ?? [],
          mcpWriteTools: grant?.mcpWriteTools ?? [],
          automationIds: grant?.automationIds ?? [],
          expiresAt: grant?.expiresAt ?? null,
          grantScope: grant?.scope ?? null,
          writesEnabled: this.options.areWritesEnabled?.() ?? false,
          sensitiveEgressEnabled:
            this.options.isSensitiveEgressEnabled?.() ?? false,
          asyncOperationsEnabled:
            this.options.areAsyncOperationsEnabled?.() ?? false,
          runtimeQuotas: this.getRuntimeQuotaSnapshot(context, policy),
        };
      } else {
        const grant = await this.requireGrant(context, sessionId);
        const grantBinding = this.requireValidatedGrantBinding(grant);
        this.requireGrantDispatchBinding(context, grantBinding);
        this.requireExactHostSessionBinding(context, exactHostBinding);
        const policy = this.getPolicy(context);
        assertPolicyEnabled(policy);
        switch (request.method) {
          case 'callMcpTool':
            assertCapabilityAllowedByPolicy(policy, 'mcp:call');
            this.requireCapability(grant, 'mcp:call');
            result = await this.callMcpTool(
              context,
              grant,
              request.params,
              exactHostBinding,
            );
            break;
          case 'prepareSensitiveMcpCall':
            this.assertSensitiveEgressEnabled();
            assertCapabilityAllowedByPolicy(policy, 'mcp:call');
            this.requireCapability(grant, 'mcp:call');
            result = await this.prepareSensitiveMcpCall(
              context,
              grant,
              request.params,
              sessionId,
              exactHostBinding,
            );
            break;
          case 'commitSensitiveMcpCall':
            this.assertSensitiveEgressEnabled();
            assertCapabilityAllowedByPolicy(policy, 'mcp:call');
            this.requireCapability(grant, 'mcp:call');
            result = await this.commitSensitiveMcpCall(
              context,
              grant,
              request.params,
              sessionId,
              exactHostBinding,
            );
            break;
          case 'startMcpOperation':
            this.assertAsyncOperationsEnabled();
            assertCapabilityAllowedByPolicy(policy, 'mcp:call');
            this.requireCapability(grant, 'mcp:call');
            result = await this.startMcpOperation(
              context,
              grant,
              request.params,
              sessionId,
              exactHostBinding,
            );
            break;
          case 'startAutomationOperation':
            this.assertAsyncOperationsEnabled();
            assertCapabilityAllowedByPolicy(policy, 'automation:run');
            this.requireCapability(grant, 'automation:run');
            result = await this.startAutomationOperation(
              context,
              grant,
              request.params,
              sessionId,
              exactHostBinding,
            );
            break;
          case 'getOperation':
            this.assertAsyncOperationsEnabled();
            result = this.getOperationSnapshot(
              context,
              request.params.operationId,
              sessionId,
            );
            break;
          case 'getOperationResult':
            this.assertAsyncOperationsEnabled();
            result = this.getOperationResult(
              context,
              request.params.operationId,
              sessionId,
            );
            break;
          case 'cancelOperation':
            this.assertAsyncOperationsEnabled();
            result = await this.cancelOperation(
              context,
              request.params.operationId,
              sessionId,
            );
            break;
          case 'prepareMcpWrite':
            this.assertWritesEnabled();
            assertCapabilityAllowedByPolicy(policy, 'mcp:write');
            this.requireCapability(grant, 'mcp:write');
            result = await this.prepareMcpWrite(
              context,
              grant,
              request.params,
              sessionId,
              exactHostBinding,
            );
            break;
          case 'commitMcpWrite':
            this.assertWritesEnabled();
            assertCapabilityAllowedByPolicy(policy, 'mcp:write');
            this.requireCapability(grant, 'mcp:write');
            result = await this.commitMcpWrite(
              context,
              grant,
              request.params,
              sessionId,
              exactHostBinding,
            );
            break;
          case 'askAgent':
            if (context.kind !== 'agent') {
              throw new Error(
                'Packaged generated apps cannot impersonate or ask an agent',
              );
            }
            assertCapabilityAllowedByPolicy(policy, 'agent:ask');
            this.requireCapability(grant, 'agent:ask');
            // Generated-app prompts are always treated as an egress boundary.
            // A rollout gate must never make credential protection weaker.
            assertNoRawSecrets(request.params.prompt);
            this.consumeOperationQuota(
              context,
              'agent:ask',
              policy.maxAgentAsksPerHour,
            );
            this.requireExactHostSessionBinding(context, exactHostBinding);
            result = this.protectResult({
              text: await this.options.askAgent(
                context,
                request.params.prompt,
                {
                  beforeDispatch: () => {
                    this.requireGrantDispatchBinding(context, grantBinding);
                    this.requireExactHostSessionBinding(
                      context,
                      exactHostBinding,
                    );
                  },
                },
              ),
            });
            break;
          case 'runAutomation':
            assertCapabilityAllowedByPolicy(policy, 'automation:run');
            this.requireCapability(grant, 'automation:run');
            if (!grant.automationIds.includes(request.params.automationId)) {
              throw new Error(
                'Automation is not included in the generated app grant',
              );
            }
            this.consumeOperationQuota(
              context,
              'automation:run',
              policy.maxAutomationRunsPerHour,
            );
            try {
              this.requireExactHostSessionBinding(context, exactHostBinding);
              await this.options.runAutomation(request.params.automationId, {
                beforeDispatch: () => {
                  this.requireGrantDispatchBinding(context, grantBinding);
                  this.requireExactHostSessionBinding(
                    context,
                    exactHostBinding,
                  );
                },
                retryMode: 'no-blind-retry',
                failureMode: 'propagate',
              });
              // AutomationService returns its complete control-plane snapshot.
              // Never forward that cross-principal data to a generated app.
              result = this.protectResult({ ok: true });
              await this.emitLifecycleEvent({
                type: 'automationCompleted',
                context,
                automationId: request.params.automationId,
                outcome: 'success',
              });
            } catch (error) {
              await this.emitLifecycleEvent({
                type: 'automationCompleted',
                context,
                automationId: request.params.automationId,
                outcome: 'error',
              });
              throw error;
            }
            break;
          default:
            result = request satisfies never;
        }
      }
      await this.audit({
        action: 'capability.invoked',
        outcome: 'success',
        context: auditContext(context),
        requestId: hashAuditIdentifier(request.id),
        method: request.method,
        resource: artifactBridgeAuditResource(request.method, request.params),
      });
      this.captureDogfoodTelemetry(context, {
        activity: 'capability-invocation',
        outcome: 'success',
        capability_kind: capabilityKindForRequest(request.method),
      });
      return result;
    } catch (error) {
      const rawErrorMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown generated app capability error';
      const sanitizedErrorMessage = this.sanitizeErrorMessage(rawErrorMessage);
      const denied = isAuthorizationError(error);
      await this.audit({
        action: 'capability.invoked',
        outcome: denied ? 'denied' : 'error',
        context: auditContext(context),
        requestId: hashAuditIdentifier(request.id),
        method: request.method,
        resource: artifactBridgeAuditResource(request.method, request.params),
        error: sanitizedErrorMessage.slice(0, 500),
      });
      this.captureDogfoodTelemetry(context, {
        activity: 'capability-invocation',
        outcome: denied ? 'denied' : 'failure',
        capability_kind: capabilityKindForRequest(request.method),
      });
      if (/raw credentials|credential-shaped|secret/i.test(rawErrorMessage)) {
        this.captureDogfoodTelemetry(context, {
          activity: 'security-control',
          outcome: 'blocked',
          security_control: 'secret-egress',
        });
      }
      throw new Error(sanitizedErrorMessage);
    } finally {
      if (enteredInvocation) this.leaveInvocation(context);
    }
  }

  public async getGrant(
    rawContext: ArtifactBridgeContext,
    rawSessionId?: string,
  ): Promise<ArtifactBridgeGrant | null> {
    this.assertEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const sessionId = rawSessionId
      ? z.string().uuid().parse(rawSessionId)
      : undefined;
    const persistentGrant = this.currentGrantForDispatchKey(
      this.contextKey(context),
    );
    const grant =
      sessionId && (this.options.areEphemeralGrantsEnabled?.() ?? false)
        ? (this.ephemeralGrants.get(
            this.ephemeralGrantKey(context, sessionId),
          ) ?? persistentGrant)
        : persistentGrant;
    if (!grant) return null;
    const binding = this.captureGrantBinding(grant);
    if (
      grant.scope.kind === 'session' &&
      (!sessionId ||
        grant.scope.sessionId !== sessionId ||
        !this.isActiveSession(context, sessionId))
    ) {
      return null;
    }
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now()) {
      await this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'revoked',
        context,
        reason: 'grant-expired',
      });
      return null;
    }
    const current = await this.options.resolveApp(context);
    if (!this.isGrantBindingCurrent(binding)) return null;
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now()) {
      await this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'revoked',
        context,
        reason: 'grant-expired',
      });
      return null;
    }
    if (!current) {
      await this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'identityChanged',
        context,
        reason: 'app-unavailable',
      });
      return null;
    }
    if (!identitiesMatch(grant.identity, current.identity)) {
      await this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'identityChanged',
        context,
        reason: 'identity-mismatch',
      });
      return null;
    }
    if (!this.isGrantBindingCurrent(binding)) return null;
    this.clearLifecycleInvalidationSignals(context);
    const cloned = structuredClone(grant);
    this.validatedGrantBindings.set(cloned, binding);
    return cloned;
  }

  public async setGrant(
    rawInput: ArtifactBridgeGrantInput,
  ): Promise<ArtifactBridgeGrant> {
    return await this.setGrantInternal(rawInput);
  }

  private async setGrantInternal(
    rawInput: ArtifactBridgeGrantInput,
    expectedMutationEpoch?: number,
    reviewExpiresAt?: string,
  ): Promise<ArtifactBridgeGrant> {
    this.assertEnabled();
    const input = artifactBridgeGrantInputSchema.parse(rawInput);
    this.assertContextEnabled(input.context);
    if (
      input.context.kind === 'package' &&
      input.capabilities.includes('agent:ask')
    ) {
      throw new Error(
        'Packaged generated apps cannot receive the agent:ask capability',
      );
    }
    if (
      input.capabilities.includes('mcp:write') ||
      input.mcpWriteTools.length > 0
    ) {
      this.assertWritesEnabled();
    }
    const policy = this.getPolicy(input.context);
    assertPolicyEnabled(policy);
    assertGrantMatchesPolicy(input, policy, this.now());
    if (input.expiresAt && Date.parse(input.expiresAt) <= this.now()) {
      throw new Error('Artifact capability grant expiry must be in the future');
    }
    this.assertGrantReviewNotExpired(reviewExpiresAt);
    this.assertPersistentGrantStoreWritable(input.context);
    if (expectedMutationEpoch !== undefined) {
      this.requireGrantMutationEpoch(input.context, expectedMutationEpoch);
    }
    const grantMutationEpoch = this.advanceGrantMutationEpoch(input.context);
    this.clearGrantReviewsForContext(input.context);
    const current = await this.options.resolveApp(input.context);
    this.requireGrantMutationEpoch(input.context, grantMutationEpoch);
    if (!current) {
      throw new Error(
        'Generated app must have a valid capability manifest before grants can be saved',
      );
    }
    if (input.identity && !identitiesMatch(input.identity, current.identity)) {
      throw new Error(
        'Generated app changed while capabilities were being reviewed',
      );
    }
    assertGrantMatchesManifest(input, current.manifest);

    // Resolution is asynchronous. Re-check every mutable admission boundary
    // after it completes so a gate or policy change cannot persist a latent
    // grant that becomes usable if the old policy is restored later.
    this.assertEnabled();
    this.assertContextEnabled(input.context);
    if (
      input.capabilities.includes('mcp:write') ||
      input.mcpWriteTools.length > 0
    ) {
      this.assertWritesEnabled();
    }
    const currentPolicy = this.getPolicy(input.context);
    assertPolicyEnabled(currentPolicy);
    assertGrantMatchesPolicy(input, currentPolicy, this.now());
    if (input.expiresAt && Date.parse(input.expiresAt) <= this.now()) {
      throw new Error('Artifact capability grant expiry must be in the future');
    }
    this.assertGrantReviewNotExpired(reviewExpiresAt);
    this.assertPersistentGrantStoreWritable(input.context);
    if (input.scope.kind === 'session') {
      this.assertEphemeralGrantsEnabled();
      if (!this.isActiveSession(input.context, input.scope.sessionId)) {
        throw new Error(
          'The selected generated app preview session is no longer active',
        );
      }
    }
    // A replacement grant is a new authority epoch even if its visible fields
    // are identical. Block publication while the encrypted snapshot is being
    // durably written; no caller may observe authority that save() can still
    // reject or ambiguously persist.
    const persistentKey = this.contextKey(input.context);
    this.pendingPersistentGrantMutations.set(persistentKey, grantMutationEpoch);
    this.invalidateGrantFencesForContext(input.context);
    this.deleteWritesForContext(input.context);
    this.deleteSensitiveCallsForContext(input.context);
    this.deleteOperationsForContext(input.context);
    const grant = artifactBridgeGrantSchema.parse({
      ...input,
      schemaVersion: 5,
      identity: current.identity,
      updatedAt: new Date(this.now()).toISOString(),
    });
    try {
      this.deleteEphemeralGrantsForContext(grant.context);
      await this.persistGrantStoreMutation(
        grant.context,
        grantMutationEpoch,
        'set',
        (store) => {
          if (grant.scope.kind === 'session') {
            delete store.grants[persistentKey];
          } else {
            store.grants[persistentKey] = grant;
          }
          return store;
        },
        () =>
          this.validateGrantPublication(
            input,
            grantMutationEpoch,
            reviewExpiresAt,
          ),
        async () => {
          await this.audit({
            // This record attests that the staged mutation passed review and
            // is authorized to commit. It deliberately does not claim that
            // the separate grant-store transaction has already committed.
            action: 'grant.save-prepared',
            outcome: 'success',
            context: auditContext(grant.context),
            resource: `scope:${grant.scope.kind}`,
          });
        },
        () => {
          if (
            this.pendingPersistentGrantMutations.get(persistentKey) ===
            grantMutationEpoch
          ) {
            this.pendingPersistentGrantMutations.delete(persistentKey);
          }
          if (grant.scope.kind === 'session') {
            this.ephemeralGrants.set(
              this.ephemeralGrantKey(grant.context, grant.scope.sessionId),
              grant,
            );
          }
          this.captureGrantBinding(grant);
        },
      );
    } finally {
      if (
        this.pendingPersistentGrantMutations.get(persistentKey) ===
        grantMutationEpoch
      ) {
        this.pendingPersistentGrantMutations.delete(persistentKey);
      }
    }
    this.clearLifecycleInvalidationSignals(grant.context);
    await this.emitLifecycleEvent({
      type: 'capabilitiesChanged',
      context: grant.context,
      reason: 'grant-saved',
    });
    return structuredClone(grant);
  }

  public async openGrantReview(
    rawContext: ArtifactBridgeContext,
    rawSelection: ArtifactBridgeGrantReviewSelection,
  ): Promise<ArtifactBridgeGrantReviewSnapshot> {
    this.assertEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    this.assertPersistentGrantStoreWritable(context);
    const reviewEpoch = this.advanceGrantMutationEpoch(context);
    this.clearGrantReviewsForContext(context);
    const snapshot = await this.grantReviews.open(context, rawSelection);
    try {
      this.requireGrantMutationEpoch(context, reviewEpoch);
    } catch (error) {
      this.grantReviews.delete(snapshot.reviewId);
      throw error;
    }
    this.grantReviewMutationEpochs.set(snapshot.reviewId, {
      contextKey: this.contextKey(context),
      epoch: reviewEpoch,
    });
    return snapshot;
  }

  public async submitGrantReview(
    rawSubmission: ArtifactBridgeGrantReviewSubmission,
  ): Promise<ArtifactBridgeGrant> {
    this.assertEnabled();
    const reviewBinding = this.grantReviewMutationEpochs.get(
      rawSubmission.reviewId,
    );
    if (!reviewBinding) {
      throw new Error('Artifact Bridge grant review is unavailable or used');
    }
    this.grantReviewMutationEpochs.delete(rawSubmission.reviewId);
    const { snapshot, selection } =
      await this.grantReviews.consume(rawSubmission);
    if (reviewBinding.contextKey !== this.contextKey(snapshot.context)) {
      throw new Error('Artifact Bridge grant review authority is mismatched');
    }
    this.requireGrantMutationEpoch(snapshot.context, reviewBinding.epoch);
    return await this.setGrantInternal(
      {
        context: snapshot.context,
        identity: snapshot.identity,
        ...selection,
      },
      reviewBinding.epoch,
      snapshot.expiresAt,
    );
  }

  public async revokeGrant(
    rawContext: ArtifactBridgeContext,
    rawScope?: ArtifactBridgeGrantRevokeScope,
  ): Promise<void> {
    this.assertEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const scope = artifactBridgeGrantRevokeScopeSchema.parse(
      rawScope ?? { kind: 'all' },
    );
    const grantMutationEpoch = this.advanceGrantMutationEpoch(context);
    this.clearGrantReviewsForContext(context);
    const persistentKey = this.contextKey(context);
    if (scope.kind === 'all' || scope.kind === 'persistent') {
      this.pendingPersistentGrantRevocations.set(
        persistentKey,
        structuredClone(context),
      );
    }
    this.clearLifecycleInvalidationSignals(context);
    if (scope.kind === 'all') {
      this.invalidateGrantFencesForContext(context);
    } else if (scope.kind === 'persistent') {
      this.invalidateGrantFence(this.contextKey(context));
    } else {
      this.invalidateGrantFence(
        this.ephemeralGrantKey(context, scope.sessionId),
      );
    }
    if (scope.kind === 'all') {
      this.deleteEphemeralGrantsForContext(context);
    } else if (scope.kind === 'session') {
      this.ephemeralGrants.delete(
        this.ephemeralGrantKey(context, scope.sessionId),
      );
    }
    if (scope.kind === 'all') {
      this.deleteWritesForContext(context);
      this.deleteSensitiveCallsForContext(context);
      this.deleteOperationsForContext(context);
    } else if (scope.kind === 'session') {
      this.deleteWritesForSession(context, scope.sessionId);
      this.deleteSensitiveCallsForSession(context, scope.sessionId);
      this.deleteOperationsForSession(context, scope.sessionId);
    } else {
      this.deletePersistentWritesForContext(context);
      this.deletePersistentSensitiveCallsForContext(context);
      this.deletePersistentOperationsForContext(context);
    }
    this.recentCalls.delete(this.contextKey(context));
    this.operationCalls.delete(`${this.contextKey(context)}:agent:ask`);
    this.operationCalls.delete(`${this.contextKey(context)}:automation:run`);
    if (scope.kind === 'all' || scope.kind === 'persistent') {
      await this.persistPersistentGrantRevocation(
        context,
        grantMutationEpoch,
        `scope:${scope.kind}`,
      );
    }
    if (scope.kind === 'session') {
      await this.audit({
        action: 'grant.revoked',
        outcome: 'success',
        context: auditContext(context),
        resource: `scope:${scope.kind}`,
      });
    }
    await this.emitLifecycleEvent({
      type: 'revoked',
      context,
      reason: 'grant-revoked',
    });
  }

  public getActiveSessions(
    rawContext: ArtifactBridgeContext,
  ): ArtifactBridgeSessionSnapshot[] {
    this.assertEnabled();
    this.assertEphemeralGrantsEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    return this.listActiveSessions(context);
  }

  private listActiveSessions(
    context: ArtifactBridgeContext,
  ): ArtifactBridgeSessionSnapshot[] {
    return [...this.activeSessions.entries()]
      .filter(([, session]) =>
        artifactBridgeContextsEqual(session.context, context),
      )
      .map(([sessionId, session]) => ({
        sessionId,
        context: structuredClone(session.context),
        openedAt: session.openedAt,
        hasEphemeralGrant: this.ephemeralGrants.has(
          this.ephemeralGrantKey(context, sessionId),
        ),
      }))
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  }

  public async getRuntimeInspector(
    rawContext: ArtifactBridgeContext,
  ): Promise<ArtifactBridgeRuntimeInspectorSnapshot> {
    this.assertEnabled();
    this.assertRuntimeInspectorEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    this.cleanupExpiredWrites();
    this.cleanupExpiredSensitiveMcpCalls();
    this.cleanupExpiredOperations();

    const key = this.contextKey(context);
    const sessions = this.listActiveSessions(context).slice(0, 100);
    const persistentGrant = await this.getGrant(context);
    const sessionGrants = (
      await Promise.all(
        sessions.map(
          async (session) => await this.getGrant(context, session.sessionId),
        ),
      )
    ).filter(
      (grant): grant is ArtifactBridgeGrant => grant?.scope.kind === 'session',
    );
    const policy = this.getPolicy(context);
    const rateLimitCalls = (this.recentCalls.get(key) ?? []).filter(
      (timestamp) => timestamp > this.now() - 60_000,
    );
    if (rateLimitCalls.length === 0) this.recentCalls.delete(key);
    else this.recentCalls.set(key, rateLimitCalls);

    const pendingReviews = [
      ...[...this.writes.values()]
        .filter(
          (prepared) =>
            this.contextKey(prepared.proposal.context) === key &&
            prepared.status !== 'committed',
        )
        .map((prepared) => ({
          id: prepared.proposal.id,
          kind: 'mcp-write' as const,
          sessionId: prepared.sessionId,
          serverId: prepared.proposal.serverId,
          toolName: prepared.proposal.toolName,
          status: prepared.status,
          createdAt: prepared.proposal.createdAt,
          expiresAt: prepared.proposal.expiresAt,
          sensitiveEgressReasons:
            prepared.proposal.sensitiveEgressReasons ?? [],
        })),
      ...[...this.sensitiveMcpCalls.values()]
        .filter(
          (prepared) =>
            this.contextKey(prepared.proposal.context) === key &&
            prepared.status !== 'committed',
        )
        .map((prepared) => ({
          id: prepared.proposal.id,
          kind: 'sensitive-mcp' as const,
          sessionId: prepared.sessionId,
          serverId: prepared.proposal.serverId,
          toolName: prepared.proposal.toolName,
          status: prepared.status,
          createdAt: prepared.proposal.createdAt,
          expiresAt: prepared.proposal.expiresAt,
          sensitiveEgressReasons: prepared.proposal.reasons,
        })),
    ]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 200);

    const operations = [...this.operations.values()]
      .filter(
        (operation) =>
          operation.active &&
          this.contextKey(operation.snapshot.context) === key,
      )
      .map((operation) => ({
        ...structuredClone(operation.snapshot),
        sessionId: operation.sessionId,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const audit = this.options.auditReader
      ? await this.options.auditReader.listRecent(50, context)
      : [];
    const snapshot = artifactBridgeRuntimeInspectorSnapshotSchema.parse({
      version: 1,
      generatedAt: new Date(this.now()).toISOString(),
      context,
      featureFlags: {
        writesEnabled: this.options.areWritesEnabled?.() ?? false,
        runtimeQuotasEnabled: this.options.areRuntimeQuotasEnabled?.() ?? false,
        lifecycleEventsEnabled:
          this.options.areLifecycleEventsEnabled?.() ?? false,
        ephemeralGrantsEnabled:
          this.options.areEphemeralGrantsEnabled?.() ?? false,
        sensitiveEgressEnabled:
          this.options.isSensitiveEgressEnabled?.() ?? false,
        asyncOperationsEnabled:
          this.options.areAsyncOperationsEnabled?.() ?? false,
      },
      policy,
      persistentGrant:
        persistentGrant?.scope.kind === 'persistent' ? persistentGrant : null,
      sessionGrants,
      sessions,
      runtimeQuotas: this.getRuntimeQuotaSnapshot(context, policy),
      activeInvocations: this.activeInvocations.get(key) ?? 0,
      rateLimitCallsLastMinute: rateLimitCalls.length,
      pendingReviews,
      operations,
      audit,
    });
    this.captureDogfoodTelemetry(context, {
      activity: 'runtime-inspector',
      outcome: 'success',
    });
    return snapshot;
  }

  /**
   * Opens the production session boundary for a generated-app document.
   * Session identifiers are created only by the backend and epochs increase
   * independently for each backend-issued document slot.
   */
  public async openHostSession(
    rawContext: ArtifactBridgeContext,
    rawDocumentSlotId?: string,
  ): Promise<ArtifactBridgeHostSessionBinding> {
    this.assertEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const suppliedDocumentSlotId =
      rawDocumentSlotId === undefined
        ? undefined
        : z.string().uuid().parse(rawDocumentSlotId);
    const documentSlotId =
      suppliedDocumentSlotId ?? this.generateUniqueDocumentSlotId();

    return await this.withHostSessionMutation(documentSlotId, async () => {
      // The feature gate can change while a same-slot mutation is queued.
      // Re-check it immediately before creating any authority-bearing state.
      this.assertEnabled();
      this.assertContextEnabled(context);

      const slot = this.hostDocumentSlots.get(documentSlotId);
      if (
        suppliedDocumentSlotId &&
        (!slot || !artifactBridgeContextsEqual(slot.context, context))
      ) {
        this.captureDogfoodTelemetry(context, {
          activity: 'security-control',
          outcome: 'blocked',
          security_control: 'principal-isolation',
        });
        throw new Error(
          'Generated app host document slot is inactive or mismatched',
        );
      }

      const current = await this.resolveValidatedApp(context);
      if (!current) {
        throw new Error(
          'Generated app must resolve to a valid identity before a host session can open',
        );
      }

      // Resolution is asynchronous. Re-check gates before committing a new
      // session so a mid-resolution disable cannot create authority.
      this.assertEnabled();
      this.assertContextEnabled(context);

      const previous = [...this.activeSessions.entries()].find(
        ([, session]) =>
          session.hostIssued && session.documentSlotId === documentSlotId,
      );
      if (previous) {
        await this.unregisterSession(context, previous[0]);
      }

      const previousEpoch = slot?.navigationEpoch ?? 0;
      if (previousEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Generated app navigation epoch space is exhausted');
      }
      const navigationEpoch = previousEpoch + 1;
      const sessionId = this.generateUniqueSessionId();
      const openedAt = new Date(this.now()).toISOString();
      const dispatchFence: HostDispatchFence = {
        generationId: randomUUID(),
        revoked: false,
      };

      this.hostDocumentSlots.set(documentSlotId, {
        context,
        navigationEpoch,
        sessionId,
      });
      this.activeSessions.set(sessionId, {
        context,
        openedAt,
        hostIssued: true,
        documentSlotId,
        navigationEpoch,
        identity: structuredClone(current.identity),
        dispatchFence,
      });
      this.captureDogfoodTelemetry(context, {
        activity: 'preview-session',
        outcome: 'started',
      });

      return {
        documentSlotId,
        sessionId,
        navigationEpoch,
        openedAt,
        assetHash: current.identity.assetHash,
      };
    });
  }

  /**
   * Invokes through an exact backend-issued document binding. Validation is
   * intentionally performed before request parsing, grant resolution, quota
   * accounting, or any effect adapter can run.
   */
  public async invokeHostSession(
    rawContext: ArtifactBridgeContext,
    rawRequest: ArtifactBridgeRequest,
    rawSessionId: string,
    rawNavigationEpoch: number,
  ): Promise<unknown> {
    this.assertEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const binding = this.requireHostSessionBinding(
      context,
      rawSessionId,
      rawNavigationEpoch,
    );

    const current = await this.resolveValidatedApp(context);
    if (!current) {
      await this.invalidateExactHostSession(
        context,
        binding,
        'app-unavailable',
      );
      throw new Error('Generated app host session identity is unavailable');
    }
    if (!identitiesMatch(binding.identity, current.identity)) {
      await this.invalidateExactHostSession(
        context,
        binding,
        'identity-mismatch',
      );
      throw new Error('Generated app host session identity changed');
    }

    // Resolution may race navigation/rotation. Revalidate the exact original
    // binding immediately before request parsing or effect dispatch.
    this.requireExactHostSessionBinding(context, binding);
    return await this.invokeInternal(
      context,
      rawRequest,
      binding.sessionId,
      binding,
    );
  }

  /**
   * Closes only the exact active document binding supplied by the host. A
   * stale epoch, session ID, or context cannot revoke a newer session.
   */
  public async closeHostSession(
    rawContext: ArtifactBridgeContext,
    rawDocumentSlotId: string,
    rawSessionId: string,
    rawNavigationEpoch: number,
  ): Promise<void> {
    const context = artifactBridgeContextSchema.parse(rawContext);
    const documentSlotId = z.string().uuid().parse(rawDocumentSlotId);
    const sessionId = z.string().uuid().parse(rawSessionId);
    const navigationEpoch =
      artifactBridgeNavigationEpochSchema.parse(rawNavigationEpoch);
    await this.withHostSessionMutation(documentSlotId, async () => {
      const slot = this.requireExactHostDocumentSlot(
        context,
        documentSlotId,
        sessionId,
        navigationEpoch,
      );
      const active = this.activeSessions.get(sessionId);
      if (
        !active &&
        [...this.activeSessions.values()].some(
          (candidate) =>
            candidate.hostIssued && candidate.documentSlotId === documentSlotId,
        )
      ) {
        throw new Error(
          'Generated app host session binding is inactive or mismatched',
        );
      }
      try {
        if (active) {
          this.requireHostSessionBinding(
            context,
            sessionId,
            navigationEpoch,
            documentSlotId,
          );
          await this.unregisterSession(context, sessionId);
        }
      } finally {
        if (this.hostDocumentSlots.get(documentSlotId) === slot) {
          this.hostDocumentSlots.delete(documentSlotId);
        }
      }
    });
  }

  /**
   * Immediately removes effect authority while retaining only exact slot/epoch
   * metadata for a bounded same-frame reconnect.
   */
  public async suspendHostSession(
    rawContext: ArtifactBridgeContext,
    rawDocumentSlotId: string,
    rawSessionId: string,
    rawNavigationEpoch: number,
  ): Promise<void> {
    const context = artifactBridgeContextSchema.parse(rawContext);
    const documentSlotId = z.string().uuid().parse(rawDocumentSlotId);
    await this.withHostSessionMutation(documentSlotId, async () => {
      const binding = this.requireHostSessionBinding(
        context,
        rawSessionId,
        rawNavigationEpoch,
        documentSlotId,
      );
      await this.unregisterSession(context, binding.sessionId);
    });
  }

  public registerSession(
    rawContext: ArtifactBridgeContext,
    rawSessionId: string,
  ): boolean {
    this.assertEnabled();
    if (
      !(this.options.areEphemeralGrantsEnabled?.() ?? false) &&
      !(this.options.areAsyncOperationsEnabled?.() ?? false) &&
      !(this.options.isRuntimeInspectorEnabled?.() ?? false)
    ) {
      return false;
    }
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const sessionId = z.string().uuid().parse(rawSessionId);
    const existing = this.activeSessions.get(sessionId);
    if (existing && !artifactBridgeContextsEqual(existing.context, context)) {
      this.captureDogfoodTelemetry(context, {
        activity: 'security-control',
        outcome: 'blocked',
        security_control: 'principal-isolation',
      });
      throw new Error('Generated app session identity collision');
    }
    if (existing) return true;
    this.activeSessions.set(sessionId, {
      context,
      openedAt: new Date(this.now()).toISOString(),
      hostIssued: false,
      navigationEpoch: null,
    });
    this.captureDogfoodTelemetry(context, {
      activity: 'preview-session',
      outcome: 'started',
    });
    return true;
  }

  public async unregisterSession(
    rawContext: ArtifactBridgeContext,
    rawSessionId: string,
  ): Promise<void> {
    const context = artifactBridgeContextSchema.parse(rawContext);
    const sessionId = z.string().uuid().parse(rawSessionId);
    const existing = this.activeSessions.get(sessionId);
    const registered = Boolean(
      existing && artifactBridgeContextsEqual(existing.context, context),
    );
    if (registered) {
      if (existing?.hostIssued) existing.dispatchFence.revoked = true;
      this.activeSessions.delete(sessionId);
      this.captureDogfoodTelemetry(context, {
        activity: 'preview-session',
        outcome: 'closed',
      });
    }
    const ephemeralKey = this.ephemeralGrantKey(context, sessionId);
    this.invalidateGrantFence(ephemeralKey);
    const hadGrant = this.ephemeralGrants.delete(ephemeralKey);
    this.deleteWritesForSession(context, sessionId);
    this.deleteSensitiveCallsForSession(context, sessionId);
    this.deleteOperationsForSession(context, sessionId);
    if (!registered && !hadGrant) return;
    if (hadGrant) {
      await this.audit({
        action: 'grant.revoked',
        outcome: 'success',
        context: auditContext(context),
        resource: 'scope:session-close',
      });
      await this.emitLifecycleEvent({
        type: 'revoked',
        context,
        reason: 'session-closed',
        sessionId,
      });
    }
  }

  public getPolicy(rawContext: ArtifactBridgeContext): ArtifactBridgePolicy {
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    return artifactBridgePolicySchema.parse(
      this.options.getPolicy?.(context) ?? DEFAULT_ARTIFACT_BRIDGE_POLICY,
    );
  }

  private getGrantReviewPolicy(
    context: ArtifactBridgeContext,
  ): ArtifactBridgePolicy {
    const policy = this.getPolicy(context);
    if (this.options.areWritesEnabled?.() ?? false) return policy;
    return artifactBridgePolicySchema.parse({
      ...policy,
      allowedCapabilities: policy.allowedCapabilities.filter(
        (capability) => capability !== 'mcp:write',
      ),
      allowedMcpWriteTools: [],
    });
  }

  public async approveWrite(
    rawContext: ArtifactBridgeContext,
    proposalId: string,
    rawSessionId?: string,
  ): Promise<ArtifactBridgeWriteApproval> {
    this.assertWritesEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const sessionId = rawSessionId
      ? z.string().uuid().parse(rawSessionId)
      : undefined;
    const prepared = this.requirePreparedWrite(context, proposalId, sessionId);
    await this.requireGrant(context, prepared.sessionId ?? undefined);
    this.requireGrantDispatchBinding(context, prepared.grantBinding);
    assertPolicyEnabled(this.getPolicy(context));
    if (prepared.status === 'committed') {
      throw new Error('Generated app write proposal was already committed');
    }
    if (prepared.status === 'committing') {
      throw new Error(
        'Generated app write proposal is already being committed',
      );
    }
    if (
      prepared.status === 'approved' &&
      prepared.commitToken &&
      prepared.approvalAuditRecorded
    ) {
      return {
        proposal: structuredClone(prepared.proposal),
        commitToken: prepared.commitToken,
      };
    }
    if (prepared.status !== 'prepared' && prepared.status !== 'approved') {
      throw new Error('Generated app write proposal can no longer be approved');
    }
    if (!prepared.commitToken) prepared.commitToken = randomUUID();
    await this.ensurePreparedEffectApprovalAudit(prepared, {
      kind: 'mcp-write',
      action: 'write.approved',
      context,
    });
    if (
      this.requirePreparedWrite(context, proposalId, sessionId) !== prepared
    ) {
      throw new Error('Generated app write proposal is no longer current');
    }
    this.requireGrantDispatchBinding(context, prepared.grantBinding);
    this.captureDogfoodTelemetry(context, {
      activity: 'write-approval',
      outcome: 'success',
    });
    return {
      proposal: structuredClone(prepared.proposal),
      commitToken: prepared.commitToken,
    };
  }

  public async rejectWrite(
    rawContext: ArtifactBridgeContext,
    proposalId: string,
    rawSessionId?: string,
  ): Promise<void> {
    this.assertWritesEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const sessionId = rawSessionId
      ? z.string().uuid().parse(rawSessionId)
      : undefined;
    const prepared = this.requirePreparedWrite(context, proposalId, sessionId);
    if (prepared.status !== 'prepared' && prepared.status !== 'approved') {
      throw new Error('Generated app write proposal can no longer be rejected');
    }
    if (prepared.status === 'approved' && prepared.commitToken) {
      await this.effectWal.markFailedPreEffect(
        prepared.proposal.id,
        'Reviewer rejected the prepared effect',
      );
    }
    this.writes.delete(proposalId);
    await this.audit({
      action: 'write.rejected',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(
        prepared.proposal.serverId,
        prepared.proposal.toolName,
      ),
    });
  }

  public async approveSensitiveMcpCall(
    rawContext: ArtifactBridgeContext,
    proposalId: string,
    rawSessionId?: string,
  ): Promise<ArtifactBridgeSensitiveMcpApproval> {
    this.assertSensitiveEgressEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const sessionId = rawSessionId
      ? z.string().uuid().parse(rawSessionId)
      : undefined;
    const prepared = this.requirePreparedSensitiveMcpCall(
      context,
      proposalId,
      sessionId,
    );
    await this.requireGrant(context, prepared.sessionId ?? undefined);
    this.requireGrantDispatchBinding(context, prepared.grantBinding);
    assertPolicyEnabled(this.getPolicy(context));
    if (prepared.status === 'committed') {
      throw new Error('Sensitive MCP call was already committed');
    }
    if (prepared.status === 'committing') {
      throw new Error('Sensitive MCP call is already being committed');
    }
    if (
      prepared.status === 'approved' &&
      prepared.commitToken &&
      prepared.approvalAuditRecorded
    ) {
      return {
        proposal: structuredClone(prepared.proposal),
        commitToken: prepared.commitToken,
      };
    }
    if (prepared.status !== 'prepared' && prepared.status !== 'approved') {
      throw new Error('Sensitive MCP call can no longer be approved');
    }
    if (!prepared.commitToken) prepared.commitToken = randomUUID();
    await this.ensurePreparedEffectApprovalAudit(prepared, {
      kind: 'sensitive-mcp',
      action: 'sensitive-egress.approved',
      context,
    });
    if (
      this.requirePreparedSensitiveMcpCall(context, proposalId, sessionId) !==
      prepared
    ) {
      throw new Error('Sensitive MCP proposal is no longer current');
    }
    this.assertSensitiveEgressEnabled();
    this.requireGrantDispatchBinding(context, prepared.grantBinding);
    this.captureDogfoodTelemetry(context, {
      activity: 'sensitive-approval',
      outcome: 'success',
    });
    return {
      proposal: structuredClone(prepared.proposal),
      commitToken: prepared.commitToken,
    };
  }

  public async rejectSensitiveMcpCall(
    rawContext: ArtifactBridgeContext,
    proposalId: string,
    rawSessionId?: string,
  ): Promise<void> {
    this.assertSensitiveEgressEnabled();
    const context = artifactBridgeContextSchema.parse(rawContext);
    this.assertContextEnabled(context);
    const sessionId = rawSessionId
      ? z.string().uuid().parse(rawSessionId)
      : undefined;
    const prepared = this.requirePreparedSensitiveMcpCall(
      context,
      proposalId,
      sessionId,
    );
    if (prepared.status !== 'prepared' && prepared.status !== 'approved') {
      throw new Error('Sensitive MCP call can no longer be rejected');
    }
    if (prepared.status === 'approved' && prepared.commitToken) {
      await this.effectWal.markFailedPreEffect(
        prepared.proposal.id,
        'Reviewer rejected the prepared effect',
      );
    }
    this.sensitiveMcpCalls.delete(proposalId);
    await this.audit({
      action: 'sensitive-egress.rejected',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(
        prepared.proposal.serverId,
        prepared.proposal.toolName,
      ),
    });
  }

  private async callMcpTool(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<unknown> {
    const grantBinding = this.requireValidatedGrantBinding(grant);
    const allowed = grant.mcpTools.some(
      (tool) =>
        tool.serverId === request.serverId &&
        tool.toolName === request.toolName,
    );
    if (!allowed) throw new Error('MCP tool is not included in the app grant');
    assertToolAllowedByPolicy(
      this.getPolicy(context).allowedMcpReadTools,
      request.serverId,
      request.toolName,
      'read',
    );

    const { server, descriptor } = await this.requireMcpReadDescriptor(
      request.serverId,
      request.toolName,
    );
    if (this.options.isSensitiveEgressEnabled?.() ?? false) {
      assertNoRawSecrets(request.arguments);
      const reasons = classifySensitiveMcpOperation({
        transportType: server.transport.type,
        serverId: request.serverId,
        descriptor,
        arguments: request.arguments,
      });
      if (reasons.length > 0) {
        throw new Error(
          'Sensitive MCP operation requires separate one-time approval',
        );
      }
    }

    const classification: ArtifactBridgeTrustedMcpClassification = {
      kind: 'read',
    };
    const effectCommitment = this.createCurrentMcpEffectCommitment({
      context,
      grantBinding,
      exactHostBinding,
      serverId: request.serverId,
      toolName: request.toolName,
      arguments: request.arguments,
      classification,
    });
    // Descriptor lookup is asynchronous. A document can close or rotate while
    // it is in flight, so revalidate the exact host generation immediately
    // before the current read-profile effect adapter is entered.
    this.requireExactHostSessionBinding(context, exactHostBinding);
    this.requireGrantDispatchBinding(context, grantBinding);
    const result = await this.executeMcpTool(
      context,
      request.serverId,
      request.toolName,
      request.arguments,
      undefined,
      undefined,
      exactHostBinding,
      grantBinding,
      effectCommitment,
      classification,
    );
    return this.protectResult(result);
  }

  private async startMcpOperation(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      timeoutMs?: number;
    },
    sessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<ArtifactBridgeOperationSnapshot> {
    const grantBinding = this.requireValidatedGrantBinding(grant);
    const allowed = grant.mcpTools.some(
      (tool) =>
        tool.serverId === request.serverId &&
        tool.toolName === request.toolName,
    );
    if (!allowed) throw new Error('MCP tool is not included in the app grant');
    const policy = this.getPolicy(context);
    assertToolAllowedByPolicy(
      policy.allowedMcpReadTools,
      request.serverId,
      request.toolName,
      'read',
    );
    const { server, descriptor } = await this.requireMcpReadDescriptor(
      request.serverId,
      request.toolName,
    );
    if (this.options.isSensitiveEgressEnabled?.() ?? false) {
      assertNoRawSecrets(request.arguments);
      const reasons = classifySensitiveMcpOperation({
        transportType: server.transport.type,
        serverId: request.serverId,
        descriptor,
        arguments: request.arguments,
      });
      if (reasons.length > 0) {
        throw new Error(
          'Sensitive MCP operation requires callSensitiveStart and one-time approval',
        );
      }
    }
    const encodedArguments = canonicalizeArtifactBridgeJson(request.arguments);
    if (Buffer.byteLength(encodedArguments, 'utf8') > 100_000) {
      throw new Error('Generated app MCP arguments exceed the size limit');
    }
    const classification: ArtifactBridgeTrustedMcpClassification = {
      kind: 'read',
    };
    const effectCommitment = this.createCurrentMcpEffectCommitment({
      context,
      grantBinding,
      exactHostBinding,
      serverId: request.serverId,
      toolName: request.toolName,
      arguments: request.arguments,
      classification,
    });
    this.requireExactHostSessionBinding(context, exactHostBinding);
    this.requireGrantDispatchBinding(context, grantBinding);
    return await this.createOperation({
      context,
      sessionId,
      exactHostBinding,
      grantBinding,
      kind: 'mcp',
      label: `${request.serverId}/${request.toolName}`,
      timeoutMs: request.timeoutMs,
      cancellableWhenRunning: true,
      execute: async (signal, timeoutMs, beforeDispatch) =>
        this.protectResult(
          await this.executeMcpTool(
            context,
            request.serverId,
            request.toolName,
            request.arguments,
            signal,
            timeoutMs,
            exactHostBinding,
            grantBinding,
            effectCommitment,
            classification,
            () => {
              this.assertAsyncOperationsEnabled();
              beforeDispatch();
            },
          ),
        ),
    });
  }

  private async startAutomationOperation(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: { automationId: string; timeoutMs?: number },
    sessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<ArtifactBridgeOperationSnapshot> {
    const grantBinding = this.requireValidatedGrantBinding(grant);
    if (!grant.automationIds.includes(request.automationId)) {
      throw new Error('Automation is not included in the generated app grant');
    }
    const policy = this.getPolicy(context);
    this.consumeOperationQuota(
      context,
      'automation:run',
      policy.maxAutomationRunsPerHour,
    );
    this.requireExactHostSessionBinding(context, exactHostBinding);
    this.requireGrantDispatchBinding(context, grantBinding);
    return await this.createOperation({
      context,
      sessionId,
      exactHostBinding,
      grantBinding,
      kind: 'automation',
      label: `automation:${request.automationId}`,
      timeoutMs: request.timeoutMs,
      cancellableWhenRunning: false,
      execute: async (_signal, _timeoutMs, beforeDispatch) => {
        try {
          this.requireExactHostSessionBinding(context, exactHostBinding);
          this.requireGrantDispatchBinding(context, grantBinding);
          await this.options.runAutomation(request.automationId, {
            beforeDispatch: () => {
              this.assertAsyncOperationsEnabled();
              this.requireGrantDispatchBinding(context, grantBinding);
              this.requireExactHostSessionBinding(context, exactHostBinding);
              beforeDispatch();
            },
            retryMode: 'no-blind-retry',
            failureMode: 'propagate',
          });
          const result = this.protectResult({ ok: true });
          await this.emitLifecycleEvent({
            type: 'automationCompleted',
            context,
            automationId: request.automationId,
            outcome: 'success',
          });
          return result;
        } catch (error) {
          await this.emitLifecycleEvent({
            type: 'automationCompleted',
            context,
            automationId: request.automationId,
            outcome: 'error',
          });
          throw error;
        }
      },
    });
  }

  private async createOperation(input: {
    context: ArtifactBridgeContext;
    sessionId?: string;
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding;
    grantBinding: ValidatedGrantBinding;
    kind: ArtifactBridgeOperationKind;
    label: string;
    timeoutMs?: number;
    cancellableWhenRunning: boolean;
    execute: (
      signal: AbortSignal,
      timeoutMs: number,
      beforeDispatch: () => void,
    ) => Promise<unknown>;
  }): Promise<ArtifactBridgeOperationSnapshot> {
    this.cleanupExpiredOperations();
    const policy = this.getPolicy(input.context);
    const activeCount = [...this.operations.values()].filter(
      (operation) =>
        operation.active &&
        this.contextKey(operation.snapshot.context) ===
          this.contextKey(input.context) &&
        (operation.snapshot.status === 'queued' ||
          operation.snapshot.status === 'running'),
    ).length;
    if (activeCount >= policy.maxConcurrentAsyncOperations) {
      throw new Error(
        'Generated app concurrent async operation quota was exceeded',
      );
    }
    if (this.operations.size >= 100) {
      this.pruneOldestTerminalOperation();
    }
    if (this.operations.size >= 100) {
      throw new Error('Generated app async operation registry is full');
    }
    const timeoutMs = Math.min(
      input.timeoutMs ?? policy.maxAsyncOperationTimeoutSeconds * 1_000,
      policy.maxAsyncOperationTimeoutSeconds * 1_000,
    );
    const now = this.now();
    const controller = new AbortController();
    const operation: ArtifactBridgeOperation = {
      snapshot: {
        id: randomUUID(),
        context: structuredClone(input.context),
        kind: input.kind,
        status: 'queued',
        label: redactSensitiveText(input.label).slice(0, 300),
        progress: { phase: 'queued', percent: 0 },
        cancellable: true,
        createdAt: new Date(now).toISOString(),
        startedAt: null,
        completedAt: null,
        expiresAt: new Date(
          now + timeoutMs + policy.asyncOperationRetentionSeconds * 1_000,
        ).toISOString(),
        error: null,
      },
      sessionId: input.sessionId ?? null,
      exactHostBinding: input.exactHostBinding,
      grantBinding: input.grantBinding,
      controller,
      active: true,
      finalDispatchPassed: false,
      retentionSeconds: policy.asyncOperationRetentionSeconds,
      result: undefined,
      timeout: null,
    };
    this.requireExactHostSessionBinding(input.context, input.exactHostBinding);
    this.requireGrantDispatchBinding(input.context, input.grantBinding);
    this.operations.set(operation.snapshot.id, operation);
    this.captureDogfoodTelemetry(input.context, {
      activity: 'async-operation',
      outcome: 'started',
      operation_kind: input.kind,
    });
    try {
      await this.audit({
        action: 'operation.started',
        outcome: 'success',
        context: auditContext(input.context),
        resource: `kind:${input.kind}`,
      });
      await this.emitOperationChanged(operation);
      this.requireExactHostSessionBinding(
        input.context,
        input.exactHostBinding,
      );
      this.requireGrantDispatchBinding(input.context, input.grantBinding);
      if (!operation.active || operation.snapshot.status !== 'queued') {
        throw new Error('Generated app async operation was revoked');
      }

      queueMicrotask(() => {
        void this.runOperation(
          operation,
          timeoutMs,
          policy.asyncOperationRetentionSeconds,
          input.cancellableWhenRunning,
          input.execute,
        );
      });
      return structuredClone(operation.snapshot);
    } catch (error) {
      this.disposeOperation(operation);
      this.operations.delete(operation.snapshot.id);
      throw error;
    }
  }

  private async runOperation(
    operation: ArtifactBridgeOperation,
    timeoutMs: number,
    retentionSeconds: number,
    cancellableWhenRunning: boolean,
    execute: (
      signal: AbortSignal,
      timeoutMs: number,
      beforeDispatch: () => void,
    ) => Promise<unknown>,
  ): Promise<void> {
    if (!operation.active || operation.snapshot.status !== 'queued') return;
    if (!this.operationFenceAllowsDispatch(operation)) return;
    operation.snapshot.status = 'running';
    operation.snapshot.startedAt = new Date(this.now()).toISOString();
    operation.snapshot.progress = { phase: 'running', percent: null };
    operation.snapshot.cancellable = cancellableWhenRunning;
    await this.emitOperationChanged(operation);
    if (!operation.active || operation.snapshot.status !== 'running') return;
    if (!this.operationFenceAllowsDispatch(operation)) return;

    operation.timeout = setTimeout(() => {
      if (!operation.active || operation.snapshot.status !== 'running') {
        return;
      }
      const status = operation.finalDispatchPassed
        ? ('uncertain' as const)
        : ('timed-out' as const);
      operation.controller.abort();
      void this.finishOperation(
        operation,
        status,
        retentionSeconds,
        undefined,
        operation.finalDispatchPassed
          ? 'Generated app async operation timed out after final dispatch; effect outcome is uncertain'
          : 'Generated app async operation timed out before final dispatch',
      );
    }, timeoutMs);

    try {
      this.requireExactHostSessionBinding(
        operation.snapshot.context,
        operation.exactHostBinding,
      );
      this.requireGrantDispatchBinding(
        operation.snapshot.context,
        operation.grantBinding,
      );
      const result = await execute(operation.controller.signal, timeoutMs, () =>
        this.passOperationFinalDispatchFence(operation),
      );
      if (!operation.active || operation.snapshot.status !== 'running') return;
      operation.snapshot.progress = { phase: 'finalizing', percent: 95 };
      await this.emitOperationChanged(operation);
      await this.finishOperation(
        operation,
        'completed',
        retentionSeconds,
        result,
      );
    } catch (error) {
      if (!operation.active || operation.snapshot.status !== 'running') return;
      if (operation.controller.signal.aborted) {
        await this.finishOperation(
          operation,
          operation.finalDispatchPassed ? 'uncertain' : 'cancelled',
          retentionSeconds,
          undefined,
          operation.finalDispatchPassed
            ? 'Generated app async operation was cancelled after final dispatch; effect outcome is uncertain'
            : 'Generated app async operation was cancelled before final dispatch',
        );
        return;
      }
      await this.finishOperation(
        operation,
        operation.finalDispatchPassed ? 'uncertain' : 'failed',
        retentionSeconds,
        undefined,
        operation.finalDispatchPassed
          ? 'Generated app async adapter failed after final dispatch; effect outcome is uncertain'
          : this.sanitizeErrorMessage(
              error instanceof Error ? error.message : String(error),
            ),
      );
    }
  }

  private operationFenceAllowsDispatch(
    operation: ArtifactBridgeOperation,
  ): boolean {
    try {
      this.requireExactHostSessionBinding(
        operation.snapshot.context,
        operation.exactHostBinding,
      );
      this.requireGrantDispatchBinding(
        operation.snapshot.context,
        operation.grantBinding,
      );
      return true;
    } catch {
      this.disposeOperation(operation);
      this.operations.delete(operation.snapshot.id);
      return false;
    }
  }

  private passOperationFinalDispatchFence(
    operation: ArtifactBridgeOperation,
  ): void {
    if (
      !operation.active ||
      operation.snapshot.status !== 'running' ||
      operation.controller.signal.aborted
    ) {
      throw new Error(
        'Generated app async operation is no longer dispatch-authorized',
      );
    }
    if (operation.finalDispatchPassed) {
      throw new Error(
        'Generated app async operation final dispatch fence was already consumed',
      );
    }
    this.requireExactHostSessionBinding(
      operation.snapshot.context,
      operation.exactHostBinding,
    );
    this.requireGrantDispatchBinding(
      operation.snapshot.context,
      operation.grantBinding,
    );
    operation.finalDispatchPassed = true;
  }

  private async finishOperation(
    operation: ArtifactBridgeOperation,
    status: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'uncertain',
    retentionSeconds: number,
    result?: unknown,
    error?: string,
  ): Promise<void> {
    if (!operation.active || isTerminalOperation(operation.snapshot.status)) {
      return;
    }
    if (operation.timeout) clearTimeout(operation.timeout);
    operation.timeout = null;
    operation.snapshot.status = status;
    operation.snapshot.progress = { phase: 'finished', percent: 100 };
    operation.snapshot.cancellable = false;
    operation.snapshot.completedAt = new Date(this.now()).toISOString();
    operation.snapshot.expiresAt = new Date(
      this.now() + retentionSeconds * 1_000,
    ).toISOString();
    operation.snapshot.error = error?.slice(0, 500) ?? null;
    operation.result =
      status === 'completed' ? structuredClone(result) : undefined;
    this.captureDogfoodTelemetry(operation.snapshot.context, {
      activity: 'async-operation',
      outcome: status === 'completed' ? 'success' : 'failure',
      operation_kind: operation.snapshot.kind,
    });
    await this.audit({
      action: 'operation.completed',
      outcome: status === 'completed' ? 'success' : 'error',
      context: auditContext(operation.snapshot.context),
      resource: `kind:${operation.snapshot.kind}:status:${status}`,
      ...(error
        ? { error: this.sanitizeErrorMessage(error).slice(0, 500) }
        : {}),
    });
    await this.emitOperationChanged(operation);
  }

  private getOperationSnapshot(
    context: ArtifactBridgeContext,
    operationId: string,
    sessionId?: string,
  ): ArtifactBridgeOperationSnapshot {
    const operation = this.requireOperation(context, operationId, sessionId);
    return structuredClone(operation.snapshot);
  }

  private getOperationResult(
    context: ArtifactBridgeContext,
    operationId: string,
    sessionId?: string,
  ): unknown {
    const operation = this.requireOperation(context, operationId, sessionId);
    switch (operation.snapshot.status) {
      case 'completed':
        return structuredClone(operation.result);
      case 'failed':
        throw new Error(operation.snapshot.error ?? 'Async operation failed');
      case 'cancelled':
        throw new Error('Async operation was cancelled');
      case 'timed-out':
        throw new Error('Async operation timed out');
      case 'uncertain':
        throw new Error(
          'Async operation effect outcome is uncertain; retry is forbidden',
        );
      case 'queued':
      case 'running':
        throw new Error('Async operation has not completed');
    }
  }

  private async cancelOperation(
    context: ArtifactBridgeContext,
    operationId: string,
    sessionId?: string,
  ): Promise<ArtifactBridgeOperationSnapshot> {
    const operation = this.requireOperation(context, operationId, sessionId);
    if (isTerminalOperation(operation.snapshot.status)) {
      return structuredClone(operation.snapshot);
    }
    if (!operation.snapshot.cancellable) {
      throw new Error('Async operation can no longer be cancelled safely');
    }
    operation.controller.abort();
    await this.finishOperation(
      operation,
      operation.finalDispatchPassed ? 'uncertain' : 'cancelled',
      this.getPolicy(context).asyncOperationRetentionSeconds,
      undefined,
      operation.finalDispatchPassed
        ? 'Generated app async operation was cancelled after final dispatch; effect outcome is uncertain'
        : 'Generated app async operation was cancelled before final dispatch',
    );
    return structuredClone(operation.snapshot);
  }

  private requireOperation(
    context: ArtifactBridgeContext,
    operationId: string,
    sessionId?: string,
  ): ArtifactBridgeOperation {
    this.cleanupExpiredOperations();
    const operation = this.operations.get(operationId);
    if (
      !operation?.active ||
      this.contextKey(operation.snapshot.context) !==
        this.contextKey(context) ||
      operation.sessionId !== (sessionId ?? null)
    ) {
      throw new Error('Generated app async operation is unavailable');
    }
    return operation;
  }

  private async emitOperationChanged(
    operation: ArtifactBridgeOperation,
  ): Promise<void> {
    await this.emitLifecycleEvent({
      type: 'operationChanged',
      context: operation.snapshot.context,
      ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
      operation: structuredClone(operation.snapshot),
    });
  }

  private cleanupExpiredOperations(): void {
    const now = this.now();
    for (const [id, operation] of this.operations) {
      if (Date.parse(operation.snapshot.expiresAt) <= now) {
        this.disposeOperation(operation);
        this.operations.delete(id);
      }
    }
  }

  private pruneOldestTerminalOperation(): void {
    const terminal = [...this.operations.values()]
      .filter((operation) => isTerminalOperation(operation.snapshot.status))
      .sort((left, right) =>
        left.snapshot.createdAt.localeCompare(right.snapshot.createdAt),
      )[0];
    if (!terminal) return;
    this.disposeOperation(terminal);
    this.operations.delete(terminal.snapshot.id);
  }

  private disposeOperation(
    operation: ArtifactBridgeOperation,
    options: {
      preserveUncertainAfterFinalDispatch?: boolean;
      reason?: string;
    } = {},
  ): boolean {
    if (
      options.preserveUncertainAfterFinalDispatch &&
      operation.active &&
      operation.finalDispatchPassed &&
      !isTerminalOperation(operation.snapshot.status)
    ) {
      operation.controller.abort();
      void this.finishOperation(
        operation,
        'uncertain',
        operation.retentionSeconds,
        undefined,
        options.reason ??
          'Generated app async authority ended after final dispatch; effect outcome is uncertain',
      ).catch((error) => {
        this.options.logger.warn(
          '[ArtifactBridge] Failed to record uncertain async operation',
          { error },
        );
      });
      return false;
    }
    operation.active = false;
    operation.controller.abort();
    if (operation.timeout) clearTimeout(operation.timeout);
    operation.timeout = null;
    operation.result = undefined;
    return true;
  }

  private async prepareSensitiveMcpCall(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    sessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<ArtifactBridgeSensitiveMcpProposal> {
    const grantBinding = this.requireValidatedGrantBinding(grant);
    this.cleanupExpiredSensitiveMcpCalls();
    const allowed = grant.mcpTools.some(
      (tool) =>
        tool.serverId === request.serverId &&
        tool.toolName === request.toolName,
    );
    if (!allowed) throw new Error('MCP tool is not included in the app grant');
    const policy = this.getPolicy(context);
    assertPolicyEnabled(policy);
    assertToolAllowedByPolicy(
      policy.allowedMcpReadTools,
      request.serverId,
      request.toolName,
      'read',
    );
    assertSensitiveToolAllowedByPolicy(
      policy,
      request.serverId,
      request.toolName,
    );
    assertNoRawSecrets(request.arguments);
    const { server, descriptor } = await this.requireMcpReadDescriptor(
      request.serverId,
      request.toolName,
    );
    const reasons = classifySensitiveMcpOperation({
      transportType: server.transport.type,
      serverId: request.serverId,
      descriptor,
      arguments: request.arguments,
    });
    if (reasons.length === 0) {
      throw new Error(
        'MCP operation is not classified as sensitive; use the ordinary call API',
      );
    }
    const encodedArguments = canonicalizeArtifactBridgeJson(request.arguments);
    if (Buffer.byteLength(encodedArguments, 'utf8') > 100_000) {
      throw new Error('Generated app MCP arguments exceed the size limit');
    }
    const classification: ArtifactBridgeTrustedMcpClassification = {
      kind: 'sensitive-read',
      reasons,
    };
    const effectCommitment = this.createCurrentMcpEffectCommitment({
      context,
      grantBinding,
      exactHostBinding,
      serverId: request.serverId,
      toolName: request.toolName,
      arguments: request.arguments,
      classification,
    });
    const createdAt = new Date(this.now());
    const proposal: ArtifactBridgeSensitiveMcpProposal = {
      id: randomUUID(),
      context,
      serverId: request.serverId,
      toolName: request.toolName,
      toolDescription: null,
      argumentsPreview: createArgumentsPreview(request.arguments),
      reasons,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + policy.sensitiveEgressProposalTtlSeconds * 1_000,
      ).toISOString(),
    };
    this.requireExactHostSessionBinding(context, exactHostBinding);
    this.requireGrantDispatchBinding(context, grantBinding);
    this.sensitiveMcpCalls.set(proposal.id, {
      proposal,
      sessionId: sessionId ?? null,
      identity: structuredClone(grant.identity),
      arguments: structuredClone(request.arguments),
      argumentsHash: hashJson(request.arguments),
      grantBinding,
      effectCommitment,
      classification,
      dispatchAuthorized: false,
      status: 'prepared',
      commitToken: null,
      approvalAuditRecorded: false,
      approvalAuditPromise: null,
      commitPromise: null,
      operationId: null,
      result: undefined,
    });
    await this.audit({
      action: 'sensitive-egress.prepared',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(request.serverId, request.toolName),
    });
    return structuredClone(proposal);
  }

  private async commitSensitiveMcpCall(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: {
      proposalId: string;
      commitToken: string;
      asOperation: boolean;
      timeoutMs?: number;
    },
    sessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<unknown> {
    const prepared = this.requirePreparedSensitiveMcpCall(
      context,
      request.proposalId,
      sessionId,
    );
    if (
      prepared.status === 'committed' &&
      prepared.commitToken === request.commitToken
    ) {
      return structuredClone(prepared.result);
    }
    if (
      prepared.commitToken === request.commitToken &&
      isTerminalEffectFailureStatus(prepared.status)
    ) {
      throwTerminalEffectFailure(prepared.status);
    }
    if (
      request.asOperation &&
      prepared.operationId &&
      prepared.commitToken === request.commitToken
    ) {
      return this.getOperationSnapshot(
        context,
        prepared.operationId,
        sessionId,
      );
    }
    if (
      prepared.status === 'committing' &&
      prepared.commitToken === request.commitToken &&
      prepared.commitPromise
    ) {
      return structuredClone(await prepared.commitPromise);
    }
    if (
      prepared.status === 'approved' &&
      prepared.commitToken === request.commitToken &&
      !prepared.approvalAuditRecorded
    ) {
      throw new Error(
        'Sensitive MCP approval audit is incomplete; dispatch is forbidden',
      );
    }
    if (
      prepared.status !== 'approved' ||
      prepared.commitToken !== request.commitToken
    ) {
      throw new Error('Sensitive MCP call is not approved');
    }
    if (request.asOperation) {
      this.assertAsyncOperationsEnabled();
      prepared.status = 'committing';
      const snapshot = await this.createOperation({
        context,
        sessionId,
        grantBinding: prepared.grantBinding,
        kind: 'mcp',
        label: `${prepared.proposal.serverId}/${prepared.proposal.toolName}`,
        timeoutMs: request.timeoutMs,
        cancellableWhenRunning: true,
        execute: async (signal, _timeoutMs, beforeDispatch) =>
          await this.executePreparedEffectWithSettlement(
            prepared,
            async () =>
              await this.executePreparedSensitiveMcpCall(
                context,
                grant,
                prepared,
                signal,
                request.timeoutMs,
                exactHostBinding,
                beforeDispatch,
              ),
          ),
        exactHostBinding,
      });
      prepared.operationId = snapshot.id;
      return snapshot;
    }
    prepared.status = 'committing';
    const commitPromise = this.executePreparedSensitiveMcpCall(
      context,
      grant,
      prepared,
      undefined,
      undefined,
      exactHostBinding,
    );
    prepared.commitPromise = commitPromise;
    try {
      return structuredClone(await commitPromise);
    } catch (error) {
      await this.settlePreparedEffectFailure(prepared, error);
      throw error;
    }
  }

  private async executePreparedSensitiveMcpCall(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    prepared: PreparedSensitiveMcpCall,
    signal?: AbortSignal,
    timeoutMs?: number,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
    onBeforeDispatchPassed?: () => void,
  ): Promise<unknown> {
    this.requireGrantDispatchBinding(context, prepared.grantBinding);
    if (!identitiesMatch(prepared.identity, grant.identity)) {
      throw new Error('Generated app changed after sensitive call preparation');
    }
    if (hashJson(prepared.arguments) !== prepared.argumentsHash) {
      throw new Error('Sensitive MCP call arguments changed');
    }
    assertNoRawSecrets(prepared.arguments);
    const policy = this.getPolicy(context);
    assertPolicyEnabled(policy);
    assertToolAllowedByPolicy(
      policy.allowedMcpReadTools,
      prepared.proposal.serverId,
      prepared.proposal.toolName,
      'read',
    );
    assertSensitiveToolAllowedByPolicy(
      policy,
      prepared.proposal.serverId,
      prepared.proposal.toolName,
    );
    const allowed = grant.mcpTools.some(
      (tool) =>
        tool.serverId === prepared.proposal.serverId &&
        tool.toolName === prepared.proposal.toolName,
    );
    if (!allowed) throw new Error('MCP tool is not included in the app grant');
    const { server, descriptor } = await this.requireMcpReadDescriptor(
      prepared.proposal.serverId,
      prepared.proposal.toolName,
    );
    const reasons = classifySensitiveMcpOperation({
      transportType: server.transport.type,
      serverId: prepared.proposal.serverId,
      descriptor,
      arguments: prepared.arguments,
    });
    if (!sameSensitiveReasons(reasons, prepared.proposal.reasons)) {
      throw new Error('Sensitive MCP classification changed after approval');
    }
    if (!prepared.commitToken) {
      throw new Error('Sensitive MCP execution ticket is unavailable');
    }
    this.requireCurrentMcpEffectCommitment(prepared.effectCommitment, {
      context,
      grantBinding: prepared.grantBinding,
      exactHostBinding,
      serverId: prepared.proposal.serverId,
      toolName: prepared.proposal.toolName,
      arguments: prepared.arguments,
      classification: prepared.classification,
    });
    prepared.dispatchAuthorized = false;
    await this.effectWal.beginDispatch({
      effectId: prepared.proposal.id,
      commitmentHash: prepared.effectCommitment.hash,
      ticketHash: effectTicketHash(prepared.commitToken),
    });
    this.requireExactHostSessionBinding(context, exactHostBinding);
    const rawResult = await this.executeMcpTool(
      context,
      prepared.proposal.serverId,
      prepared.proposal.toolName,
      prepared.arguments,
      signal,
      timeoutMs,
      exactHostBinding,
      prepared.grantBinding,
      prepared.effectCommitment,
      prepared.classification,
      () => {
        this.assertSensitiveEgressEnabled();
        if (onBeforeDispatchPassed) this.assertAsyncOperationsEnabled();
        this.requirePreparedSensitiveDispatchAuthorization(prepared);
        onBeforeDispatchPassed?.();
        prepared.dispatchAuthorized = true;
      },
    );
    let result: unknown;
    let storedResult: unknown;
    let resultHash: string;
    try {
      result = this.protectResult(rawResult);
      storedResult = structuredClone(result);
      resultHash = hashArtifactBridgeJson(
        'clodex.artifact-bridge.effect-result.v1',
        storedResult,
      );
    } catch (error) {
      await this.effectWal.markResultUnavailable(
        prepared.proposal.id,
        'Effect completed but its result was unavailable',
      );
      prepared.status = 'result-unavailable';
      prepared.result = undefined;
      prepared.commitPromise = null;
      throw error;
    }
    await this.effectWal.markCommitted(prepared.proposal.id, resultHash);
    prepared.status = 'committed';
    prepared.result = storedResult;
    prepared.commitPromise = null;
    await this.audit({
      action: 'sensitive-egress.committed',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(
        prepared.proposal.serverId,
        prepared.proposal.toolName,
      ),
    });
    return result;
  }

  private async prepareMcpWrite(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    sessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<ArtifactBridgeWriteProposal> {
    const grantBinding = this.requireValidatedGrantBinding(grant);
    this.cleanupExpiredWrites();
    this.requireGrantedMcpWriteTool(grant, request);
    const policy = this.getPolicy(context);
    assertPolicyEnabled(policy);
    assertToolAllowedByPolicy(
      policy.allowedMcpWriteTools,
      request.serverId,
      request.toolName,
      'write',
    );
    const descriptor = await this.requireMcpWriteDescriptor(
      request.serverId,
      request.toolName,
    );
    let sensitiveEgressReasons: ArtifactBridgeSensitiveEgressReason[] = [];
    if (this.options.isSensitiveEgressEnabled?.() ?? false) {
      assertNoRawSecrets(request.arguments);
      const server =
        this.options.mcpRegistry.snapshot().servers[request.serverId];
      sensitiveEgressReasons = classifySensitiveMcpOperation({
        transportType: server?.transport.type,
        serverId: request.serverId,
        descriptor,
        arguments: request.arguments,
      });
      if (sensitiveEgressReasons.length > 0) {
        assertSensitiveToolAllowedByPolicy(
          policy,
          request.serverId,
          request.toolName,
        );
      }
    }
    const encodedArguments = canonicalizeArtifactBridgeJson(request.arguments);
    if (Buffer.byteLength(encodedArguments, 'utf8') > 100_000) {
      throw new Error('Generated app write arguments exceed the size limit');
    }
    const destructive = descriptor.annotations?.destructiveHint === true;
    const classification: ArtifactBridgeTrustedMcpClassification =
      sensitiveEgressReasons.length > 0
        ? {
            kind: 'sensitive-write',
            destructive,
            reasons: sensitiveEgressReasons,
          }
        : { kind: 'write', destructive };
    const effectCommitment = this.createCurrentMcpEffectCommitment({
      context,
      grantBinding,
      exactHostBinding,
      serverId: request.serverId,
      toolName: request.toolName,
      arguments: request.arguments,
      classification,
    });

    const createdAt = new Date(this.now());
    const proposal: ArtifactBridgeWriteProposal = {
      id: randomUUID(),
      context,
      serverId: request.serverId,
      toolName: request.toolName,
      toolDescription:
        (this.options.isSensitiveEgressEnabled?.() ?? false)
          ? null
          : descriptor.description?.slice(0, 2_000) || null,
      argumentsPreview: createArgumentsPreview(request.arguments),
      risk: destructive ? 'destructive' : 'write',
      sensitiveEgressReasons,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + policy.writeProposalTtlSeconds * 1_000,
      ).toISOString(),
    };
    this.requireExactHostSessionBinding(context, exactHostBinding);
    this.requireGrantDispatchBinding(context, grantBinding);
    this.writes.set(proposal.id, {
      proposal,
      sessionId: sessionId ?? null,
      identity: structuredClone(grant.identity),
      arguments: structuredClone(request.arguments),
      argumentsHash: hashJson(request.arguments),
      grantBinding,
      effectCommitment,
      classification,
      dispatchAuthorized: false,
      status: 'prepared',
      commitToken: null,
      approvalAuditRecorded: false,
      approvalAuditPromise: null,
      commitPromise: null,
      result: undefined,
    });
    await this.audit({
      action: 'write.prepared',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(request.serverId, request.toolName),
    });
    return structuredClone(proposal);
  }

  private async commitMcpWrite(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: { proposalId: string; commitToken: string },
    sessionId?: string,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<unknown> {
    const prepared = this.requirePreparedWrite(
      context,
      request.proposalId,
      sessionId,
    );
    if (
      prepared.status === 'committed' &&
      prepared.commitToken === request.commitToken
    ) {
      return structuredClone(prepared.result);
    }
    if (
      prepared.commitToken === request.commitToken &&
      isTerminalEffectFailureStatus(prepared.status)
    ) {
      throwTerminalEffectFailure(prepared.status);
    }
    if (
      prepared.status === 'committing' &&
      prepared.commitToken === request.commitToken &&
      prepared.commitPromise
    ) {
      return structuredClone(await prepared.commitPromise);
    }
    if (
      prepared.status === 'approved' &&
      prepared.commitToken === request.commitToken &&
      !prepared.approvalAuditRecorded
    ) {
      throw new Error(
        'Generated app write approval audit is incomplete; dispatch is forbidden',
      );
    }
    if (
      prepared.status !== 'approved' ||
      prepared.commitToken !== request.commitToken
    ) {
      throw new Error('Generated app write proposal is not approved');
    }
    prepared.status = 'committing';
    const commitPromise = this.executePreparedWrite(
      context,
      grant,
      prepared,
      exactHostBinding,
    );
    prepared.commitPromise = commitPromise;
    try {
      return structuredClone(await commitPromise);
    } catch (error) {
      await this.settlePreparedEffectFailure(prepared, error);
      throw error;
    }
  }

  private async executePreparedWrite(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    prepared: PreparedWrite,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
  ): Promise<unknown> {
    this.requireGrantDispatchBinding(context, prepared.grantBinding);
    if (!identitiesMatch(prepared.identity, grant.identity)) {
      throw new Error('Generated app changed after write preparation');
    }
    if (hashJson(prepared.arguments) !== prepared.argumentsHash) {
      throw new Error('Generated app write proposal arguments changed');
    }
    if (this.options.isSensitiveEgressEnabled?.() ?? false) {
      assertNoRawSecrets(prepared.arguments);
    }
    this.requireGrantedMcpWriteTool(grant, prepared.proposal);
    const policy = this.getPolicy(context);
    assertPolicyEnabled(policy);
    assertToolAllowedByPolicy(
      policy.allowedMcpWriteTools,
      prepared.proposal.serverId,
      prepared.proposal.toolName,
      'write',
    );
    const descriptor = await this.requireMcpWriteDescriptor(
      prepared.proposal.serverId,
      prepared.proposal.toolName,
    );
    if (this.options.isSensitiveEgressEnabled?.() ?? false) {
      const server =
        this.options.mcpRegistry.snapshot().servers[prepared.proposal.serverId];
      const reasons = classifySensitiveMcpOperation({
        transportType: server?.transport.type,
        serverId: prepared.proposal.serverId,
        descriptor,
        arguments: prepared.arguments,
      });
      if (
        reasons.length > 0 ||
        prepared.proposal.sensitiveEgressReasons.length > 0
      ) {
        assertSensitiveToolAllowedByPolicy(
          policy,
          prepared.proposal.serverId,
          prepared.proposal.toolName,
        );
      }
      if (
        !sameSensitiveReasons(reasons, prepared.proposal.sensitiveEgressReasons)
      ) {
        throw new Error('MCP write egress classification changed after review');
      }
    }

    if (!prepared.commitToken) {
      throw new Error('Generated app write execution ticket is unavailable');
    }
    this.requireCurrentMcpEffectCommitment(prepared.effectCommitment, {
      context,
      grantBinding: prepared.grantBinding,
      exactHostBinding,
      serverId: prepared.proposal.serverId,
      toolName: prepared.proposal.toolName,
      arguments: prepared.arguments,
      classification: prepared.classification,
    });
    prepared.dispatchAuthorized = false;
    await this.effectWal.beginDispatch({
      effectId: prepared.proposal.id,
      commitmentHash: prepared.effectCommitment.hash,
      ticketHash: effectTicketHash(prepared.commitToken),
    });
    this.requireExactHostSessionBinding(context, exactHostBinding);
    const rawResult = await this.executeMcpTool(
      context,
      prepared.proposal.serverId,
      prepared.proposal.toolName,
      prepared.arguments,
      undefined,
      undefined,
      exactHostBinding,
      prepared.grantBinding,
      prepared.effectCommitment,
      prepared.classification,
      () => {
        this.requirePreparedWriteDispatchAuthorization(prepared);
        prepared.dispatchAuthorized = true;
      },
    );
    let result: unknown;
    let storedResult: unknown;
    let resultHash: string;
    try {
      result = this.protectResult(rawResult);
      storedResult = structuredClone(result);
      resultHash = hashArtifactBridgeJson(
        'clodex.artifact-bridge.effect-result.v1',
        storedResult,
      );
    } catch (error) {
      await this.effectWal.markResultUnavailable(
        prepared.proposal.id,
        'Effect completed but its result was unavailable',
      );
      prepared.status = 'result-unavailable';
      prepared.result = undefined;
      prepared.commitPromise = null;
      throw error;
    }
    await this.effectWal.markCommitted(prepared.proposal.id, resultHash);
    prepared.status = 'committed';
    prepared.result = storedResult;
    prepared.commitPromise = null;
    await this.audit({
      action: 'write.committed',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(
        prepared.proposal.serverId,
        prepared.proposal.toolName,
      ),
    });
    return result;
  }

  private async requireMcpWriteDescriptor(serverId: string, toolName: string) {
    const registry = this.options.mcpRegistry.snapshot();
    const server = registry.servers[serverId];
    if (!server?.enabled) throw new Error('MCP server is unavailable');
    const descriptor = (
      await this.options.mcpRegistry.listTools(serverId)
    ).find((tool) => tool.name === toolName);
    if (!descriptor) throw new Error('MCP tool is unavailable');
    const policy = evaluateMcpToolPolicy(server, {
      name: descriptor.name,
      readOnlyHint: descriptor.annotations?.readOnlyHint,
      destructiveHint: descriptor.annotations?.destructiveHint,
    });
    if (
      policy.decision === 'deny' ||
      descriptor.annotations?.readOnlyHint === true
    ) {
      throw new Error('Generated app write tool is denied or marked read-only');
    }
    return descriptor;
  }

  private async requireMcpReadDescriptor(serverId: string, toolName: string) {
    const registry = this.options.mcpRegistry.snapshot();
    const server = registry.servers[serverId];
    if (!server?.enabled) throw new Error('MCP server is unavailable');
    const descriptor = (
      await this.options.mcpRegistry.listTools(serverId)
    ).find((tool) => tool.name === toolName);
    if (!descriptor) throw new Error('MCP tool is unavailable');
    const policy = evaluateMcpToolPolicy(server, {
      name: descriptor.name,
      readOnlyHint: descriptor.annotations?.readOnlyHint,
      destructiveHint: descriptor.annotations?.destructiveHint,
    });
    if (
      policy.decision !== 'allow' ||
      descriptor.annotations?.readOnlyHint !== true ||
      descriptor.annotations?.destructiveHint === true
    ) {
      throw new Error(
        'Generated apps may call only explicitly allowed read-only MCP tools',
      );
    }
    return { server, descriptor };
  }

  private createCurrentMcpEffectCommitment(input: {
    context: ArtifactBridgeContext;
    grantBinding: ValidatedGrantBinding;
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    classification: ArtifactBridgeTrustedMcpClassification;
  }): ArtifactBridgeMcpEffectCommitment {
    this.requireGrantDispatchBinding(input.context, input.grantBinding);
    this.requireExactHostSessionBinding(input.context, input.exactHostBinding);
    const snapshot = this.options.mcpRegistry.getToolDispatchSnapshot(
      input.serverId,
      input.toolName,
    );
    return createArtifactBridgeMcpEffectCommitment({
      context: input.context,
      identity: input.grantBinding.grant.identity,
      session: input.exactHostBinding
        ? {
            sessionId: input.exactHostBinding.sessionId,
            navigationEpoch: input.exactHostBinding.navigationEpoch,
            documentSlotId: input.exactHostBinding.documentSlotId,
            hostGenerationId: input.exactHostBinding.dispatchFence.generationId,
          }
        : null,
      grant: {
        grantId: input.grantBinding.dispatchFence.grantId,
        revision: input.grantBinding.dispatchFence.revision,
      },
      server: snapshot.server,
      runtime: snapshot.runtime,
      descriptor: snapshot.descriptor,
      classification: input.classification,
      securityProfile: {
        sensitiveEgressEnabled:
          this.options.isSensitiveEgressEnabled?.() ?? false,
      },
      arguments: input.arguments,
      policy: this.getPolicy(input.context),
    });
  }

  private requireCurrentMcpEffectCommitment(
    expected: ArtifactBridgeMcpEffectCommitment,
    input: {
      context: ArtifactBridgeContext;
      grantBinding: ValidatedGrantBinding;
      exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding;
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      classification: ArtifactBridgeTrustedMcpClassification;
    },
  ): void {
    const current = this.createCurrentMcpEffectCommitment(input);
    if (!artifactBridgeMcpCommitmentsEqual(expected, current)) {
      throw new Error(
        'MCP effect commitment changed after authorization review',
      );
    }
  }

  private async executeMcpTool(
    context: ArtifactBridgeContext,
    serverId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
    exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding,
    grantBinding?: ValidatedGrantBinding,
    effectCommitment?: ArtifactBridgeMcpEffectCommitment,
    classification?: ArtifactBridgeTrustedMcpClassification,
    onBeforeDispatchPassed?: () => void,
  ): Promise<unknown> {
    const withholdSensitiveErrors =
      this.options.isSensitiveEgressEnabled?.() ?? false;
    try {
      if (grantBinding && (!effectCommitment || classification === undefined)) {
        throw new Error('MCP effect commitment is required before dispatch');
      }
      if ((effectCommitment || classification) && !grantBinding) {
        throw new Error('MCP effect grant binding is required before dispatch');
      }
      this.requireExactHostSessionBinding(context, exactHostBinding);
      if (grantBinding) this.requireGrantDispatchBinding(context, grantBinding);
      return await this.options.mcpRegistry.callTool(
        serverId,
        toolName,
        arguments_,
        {
          timeoutMs: timeoutMs ?? 30_000,
          ...(signal ? { signal } : {}),
          agentInstanceId: this.mcpPrincipalId(context),
          ...(exactHostBinding || grantBinding
            ? {
                beforeDispatch: () => {
                  if (grantBinding) {
                    this.requireGrantDispatchBinding(context, grantBinding);
                  }
                  this.requireExactHostSessionBinding(
                    context,
                    exactHostBinding,
                  );
                  if (effectCommitment && grantBinding && classification) {
                    this.requireCurrentMcpEffectCommitment(effectCommitment, {
                      context,
                      grantBinding,
                      exactHostBinding,
                      serverId,
                      toolName,
                      arguments: arguments_,
                      classification,
                    });
                  }
                  onBeforeDispatchPassed?.();
                },
              }
            : {}),
        },
      );
    } catch (error) {
      if (
        withholdSensitiveErrors ||
        (this.options.isSensitiveEgressEnabled?.() ?? false)
      ) {
        throw new Error(
          'MCP tool execution failed; sensitive details withheld',
        );
      }
      throw error;
    }
  }

  private requireGrantedMcpWriteTool(
    grant: ArtifactBridgeGrant,
    request: { serverId: string; toolName: string },
  ): void {
    const allowed = grant.mcpWriteTools.some(
      (tool) =>
        tool.serverId === request.serverId &&
        tool.toolName === request.toolName,
    );
    if (!allowed) {
      throw new Error('MCP write tool is not included in the app grant');
    }
  }

  private async ensurePreparedEffectApprovalAudit(
    prepared: PreparedEffect,
    input: {
      kind: 'mcp-write' | 'sensitive-mcp';
      action: 'write.approved' | 'sensitive-egress.approved';
      context: ArtifactBridgeContext;
    },
  ): Promise<void> {
    if (prepared.approvalAuditRecorded) return;
    if (prepared.approvalAuditPromise) {
      await prepared.approvalAuditPromise;
      return;
    }
    if (!prepared.commitToken) {
      throw new Error('Effect approval token is unavailable');
    }

    const commitToken = prepared.commitToken;
    const approvalAuditPromise = (async () => {
      const walRecord = await this.effectWal.prepare({
        effectId: prepared.proposal.id,
        kind: input.kind,
        commitmentHash: prepared.effectCommitment.hash,
        ticketHash: effectTicketHash(commitToken),
      });
      if (walRecord.state !== 'PREPARED') {
        throw new Error(
          'Effect approval WAL is no longer in a dispatchable state',
        );
      }

      // `approved` means that the one-shot WAL ticket exists. The token is not
      // released to the reviewer, and commit remains fail-closed, until the
      // mandatory approval audit below has completed successfully.
      prepared.status = 'approved';
      try {
        await this.audit({
          action: input.action,
          outcome: 'success',
          context: auditContext(input.context),
          resource: safeMcpAuditResource(
            prepared.proposal.serverId,
            prepared.proposal.toolName,
          ),
        });
        prepared.approvalAuditRecorded = true;
      } catch (auditError) {
        // Recorder failures are write-ambiguous: retrying the same append could
        // duplicate or corrupt an already-written record. Burn the one-shot WAL
        // ticket instead. A fresh proposal/review is required after the audit
        // sink is healthy again, and no caller ever receives this token.
        try {
          await this.effectWal.markFailedPreEffect(
            prepared.proposal.id,
            'Mandatory approval audit did not complete',
          );
          prepared.status = 'failed-pre-effect';
        } catch (closureError) {
          prepared.status = 'uncertain';
          this.options.logger.warn(
            '[ArtifactBridge] Failed to close an approval after audit failure',
            { closureError },
          );
        }
        prepared.commitToken = null;
        throw auditError;
      }
    })();
    prepared.approvalAuditPromise = approvalAuditPromise;
    try {
      await approvalAuditPromise;
    } finally {
      if (prepared.approvalAuditPromise === approvalAuditPromise) {
        prepared.approvalAuditPromise = null;
      }
    }
  }

  private async executePreparedEffectWithSettlement<T>(
    prepared: PreparedEffect,
    execute: () => Promise<T>,
  ): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      await this.settlePreparedEffectFailure(prepared, error);
      throw error;
    }
  }

  private async settlePreparedEffectFailure(
    prepared: PreparedEffect,
    _error: unknown,
  ): Promise<void> {
    if (
      prepared.status === 'committed' ||
      isTerminalEffectFailureStatus(prepared.status)
    ) {
      prepared.commitPromise = null;
      return;
    }
    const record = this.effectWal.get(prepared.proposal.id);
    try {
      switch (record?.state) {
        case 'PREPARED':
          await this.effectWal.markFailedPreEffect(
            prepared.proposal.id,
            'Effect rejected before final dispatch',
          );
          prepared.status = 'failed-pre-effect';
          break;
        case 'DISPATCHING':
          if (prepared.dispatchAuthorized) {
            await this.effectWal.markUncertain(
              prepared.proposal.id,
              'Adapter result unavailable after final dispatch',
            );
            prepared.status = 'uncertain';
          } else {
            await this.effectWal.markFailedPreEffect(
              prepared.proposal.id,
              'Effect rejected before final dispatch',
            );
            prepared.status = 'failed-pre-effect';
          }
          break;
        case 'COMMITTED':
          prepared.status = 'committed';
          break;
        case 'RESULT_UNAVAILABLE':
          prepared.status = 'result-unavailable';
          break;
        case 'UNCERTAIN':
          prepared.status = 'uncertain';
          break;
        case 'FAILED_PRE_EFFECT':
          prepared.status = 'failed-pre-effect';
          break;
        case undefined:
          prepared.status = 'uncertain';
          break;
      }
    } catch {
      // If the terminal write itself fails, never make the one-shot token
      // dispatchable again. A persisted DISPATCHING record recovers UNCERTAIN.
      prepared.status = 'uncertain';
    }
    prepared.commitPromise = null;
  }

  private requirePreparedWrite(
    context: ArtifactBridgeContext,
    proposalId: string,
    sessionId?: string,
  ): PreparedWrite {
    this.cleanupExpiredWrites();
    const prepared = this.writes.get(proposalId);
    if (
      !prepared ||
      this.contextKey(prepared.proposal.context) !== this.contextKey(context) ||
      prepared.sessionId !== (sessionId ?? null)
    ) {
      throw new Error('Generated app write proposal is unavailable or expired');
    }
    return prepared;
  }

  private requirePreparedWriteDispatchAuthorization(
    prepared: PreparedWrite,
  ): void {
    if (!prepared.approvalAuditRecorded) {
      throw new Error(
        'Generated app write approval audit is incomplete; dispatch is forbidden',
      );
    }
    if (
      prepared.status !== 'committing' ||
      !prepared.commitToken ||
      Date.parse(prepared.proposal.expiresAt) <= this.now()
    ) {
      throw new Error(
        'Generated app write execution ticket expired before final dispatch',
      );
    }
  }

  private invalidatePreparedEffect(
    prepared: PreparedEffect,
    reason: string,
  ): void {
    if (
      prepared.status !== 'approved' ||
      !prepared.commitToken ||
      this.effectWal.get(prepared.proposal.id)?.state !== 'PREPARED'
    ) {
      return;
    }
    prepared.status = 'failed-pre-effect';
    prepared.commitPromise = null;
    void this.effectWal
      .markFailedPreEffect(prepared.proposal.id, reason.slice(0, 500))
      .catch((error) => {
        this.options.logger.warn(
          '[ArtifactBridge] Failed to close a prepared effect WAL record',
          { error },
        );
      });
  }

  private cleanupExpiredWrites(): void {
    const now = this.now();
    for (const [id, prepared] of this.writes) {
      if (Date.parse(prepared.proposal.expiresAt) <= now) {
        this.invalidatePreparedEffect(prepared, 'Effect proposal expired');
        this.writes.delete(id);
      }
    }
  }

  private requirePreparedSensitiveMcpCall(
    context: ArtifactBridgeContext,
    proposalId: string,
    sessionId?: string,
  ): PreparedSensitiveMcpCall {
    this.cleanupExpiredSensitiveMcpCalls();
    const prepared = this.sensitiveMcpCalls.get(proposalId);
    if (
      !prepared ||
      this.contextKey(prepared.proposal.context) !== this.contextKey(context) ||
      prepared.sessionId !== (sessionId ?? null)
    ) {
      throw new Error('Sensitive MCP proposal is unavailable or expired');
    }
    return prepared;
  }

  private requirePreparedSensitiveDispatchAuthorization(
    prepared: PreparedSensitiveMcpCall,
  ): void {
    if (!prepared.approvalAuditRecorded) {
      throw new Error(
        'Sensitive MCP approval audit is incomplete; dispatch is forbidden',
      );
    }
    if (
      prepared.status !== 'committing' ||
      !prepared.commitToken ||
      Date.parse(prepared.proposal.expiresAt) <= this.now()
    ) {
      throw new Error(
        'Sensitive MCP execution ticket expired before final dispatch',
      );
    }
  }

  private cleanupExpiredSensitiveMcpCalls(): void {
    const now = this.now();
    for (const [id, prepared] of this.sensitiveMcpCalls) {
      if (Date.parse(prepared.proposal.expiresAt) <= now) {
        this.invalidatePreparedEffect(prepared, 'Effect proposal expired');
        this.sensitiveMcpCalls.delete(id);
      }
    }
  }

  private deleteWritesForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.writes) {
      if (this.contextKey(prepared.proposal.context) === key) {
        this.invalidatePreparedEffect(prepared, 'Grant authority changed');
        this.writes.delete(id);
      }
    }
  }

  private deleteWritesForSession(
    context: ArtifactBridgeContext,
    sessionId: string,
  ): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.writes) {
      if (
        this.contextKey(prepared.proposal.context) === key &&
        prepared.sessionId === sessionId
      ) {
        this.invalidatePreparedEffect(prepared, 'Session authority ended');
        this.writes.delete(id);
      }
    }
  }

  private deletePersistentWritesForContext(
    context: ArtifactBridgeContext,
  ): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.writes) {
      if (
        this.contextKey(prepared.proposal.context) === key &&
        prepared.sessionId === null
      ) {
        this.invalidatePreparedEffect(prepared, 'Grant authority changed');
        this.writes.delete(id);
      }
    }
  }

  private deleteSensitiveCallsForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.sensitiveMcpCalls) {
      if (this.contextKey(prepared.proposal.context) === key) {
        this.invalidatePreparedEffect(prepared, 'Grant authority changed');
        this.sensitiveMcpCalls.delete(id);
      }
    }
  }

  private deleteSensitiveCallsForSession(
    context: ArtifactBridgeContext,
    sessionId: string,
  ): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.sensitiveMcpCalls) {
      if (
        this.contextKey(prepared.proposal.context) === key &&
        prepared.sessionId === sessionId
      ) {
        this.invalidatePreparedEffect(prepared, 'Session authority ended');
        this.sensitiveMcpCalls.delete(id);
      }
    }
  }

  private deletePersistentSensitiveCallsForContext(
    context: ArtifactBridgeContext,
  ): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.sensitiveMcpCalls) {
      if (
        this.contextKey(prepared.proposal.context) === key &&
        prepared.sessionId === null
      ) {
        this.invalidatePreparedEffect(prepared, 'Grant authority changed');
        this.sensitiveMcpCalls.delete(id);
      }
    }
  }

  private deleteOperationsForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    for (const [id, operation] of this.operations) {
      if (this.contextKey(operation.snapshot.context) === key) {
        if (
          this.disposeOperation(operation, {
            preserveUncertainAfterFinalDispatch: true,
            reason:
              'Generated app async authority changed after final dispatch; effect outcome is uncertain',
          })
        ) {
          this.operations.delete(id);
        }
      }
    }
  }

  private deleteOperationsForSession(
    context: ArtifactBridgeContext,
    sessionId: string,
  ): void {
    const key = this.contextKey(context);
    for (const [id, operation] of this.operations) {
      if (
        this.contextKey(operation.snapshot.context) === key &&
        operation.sessionId === sessionId
      ) {
        if (
          this.disposeOperation(operation, {
            preserveUncertainAfterFinalDispatch: true,
            reason:
              'Generated app async session closed after final dispatch; effect outcome is uncertain',
          })
        ) {
          this.operations.delete(id);
        }
      }
    }
  }

  private deletePersistentOperationsForContext(
    context: ArtifactBridgeContext,
  ): void {
    const key = this.contextKey(context);
    for (const [id, operation] of this.operations) {
      if (
        this.contextKey(operation.snapshot.context) === key &&
        operation.sessionId === null
      ) {
        if (
          this.disposeOperation(operation, {
            preserveUncertainAfterFinalDispatch: true,
            reason:
              'Generated app async authority changed after final dispatch; effect outcome is uncertain',
          })
        ) {
          this.operations.delete(id);
        }
      }
    }
  }

  private async requireGrant(
    context: ArtifactBridgeContext,
    sessionId?: string,
  ): Promise<ArtifactBridgeGrant> {
    const grant = await this.getGrant(context, sessionId);
    if (!grant) throw new Error('Generated app has no active capability grant');
    return grant;
  }

  private requireCapability(
    grant: ArtifactBridgeGrant,
    capability: ArtifactBridgeCapability,
  ): void {
    if (!grant.capabilities.includes(capability)) {
      throw new Error(
        `Generated app capability "${capability}" is not granted`,
      );
    }
  }

  private enforceRateLimit(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    const cutoff = this.now() - 60_000;
    const calls = (this.recentCalls.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (calls.length >= MAX_CALLS_PER_MINUTE) {
      throw new Error('Generated app capability rate limit exceeded');
    }
    calls.push(this.now());
    this.recentCalls.set(key, calls);
  }

  private enterInvocation(context: ArtifactBridgeContext): boolean {
    if (!(this.options.areRuntimeQuotasEnabled?.() ?? false)) return false;
    const policy = this.getPolicy(context);
    const key = this.contextKey(context);
    const active = this.activeInvocations.get(key) ?? 0;
    if (active >= policy.maxConcurrentInvocations) {
      throw new Error('Generated app concurrent invocation quota was exceeded');
    }
    this.activeInvocations.set(key, active + 1);
    return true;
  }

  private leaveInvocation(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    const active = this.activeInvocations.get(key) ?? 0;
    if (active <= 1) this.activeInvocations.delete(key);
    else this.activeInvocations.set(key, active - 1);
  }

  private consumeOperationQuota(
    context: ArtifactBridgeContext,
    operation: 'agent:ask' | 'automation:run',
    limit: number,
  ): void {
    if (!(this.options.areRuntimeQuotasEnabled?.() ?? false)) return;
    const key = `${this.contextKey(context)}:${operation}`;
    const calls = this.getRecentOperationCalls(key);
    if (calls.length >= limit) {
      throw new Error(`Generated app ${operation} hourly quota was exceeded`);
    }
    calls.push(this.now());
    this.operationCalls.set(key, calls);
  }

  private getRuntimeQuotaSnapshot(
    context: ArtifactBridgeContext,
    policy: ArtifactBridgePolicy,
  ) {
    const enabled = this.options.areRuntimeQuotasEnabled?.() ?? false;
    const askCalls = enabled
      ? this.getRecentOperationCalls(`${this.contextKey(context)}:agent:ask`)
          .length
      : 0;
    const automationCalls = enabled
      ? this.getRecentOperationCalls(
          `${this.contextKey(context)}:automation:run`,
        ).length
      : 0;
    return artifactBridgeRuntimeQuotaSnapshotSchema.parse({
      enabled,
      maxConcurrentInvocations: policy.maxConcurrentInvocations,
      maxAgentAsksPerHour: policy.maxAgentAsksPerHour,
      maxAutomationRunsPerHour: policy.maxAutomationRunsPerHour,
      remainingAgentAsksThisHour: Math.max(
        0,
        policy.maxAgentAsksPerHour - askCalls,
      ),
      remainingAutomationRunsThisHour: Math.max(
        0,
        policy.maxAutomationRunsPerHour - automationCalls,
      ),
    });
  }

  private getRecentOperationCalls(key: string): number[] {
    const cutoff = this.now() - 3_600_000;
    const calls = (this.operationCalls.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (calls.length === 0) this.operationCalls.delete(key);
    else this.operationCalls.set(key, calls);
    return calls;
  }

  private capResult<T>(result: T): T {
    const encoded = JSON.stringify(result);
    if (encoded && Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) {
      throw new Error('Generated app capability result exceeds the size limit');
    }
    return result;
  }

  private protectResult<T>(result: T): T {
    // Output privacy is a permanent trust-boundary property, not a rollout
    // feature. Using the live gate here would allow true -> false transitions
    // after dispatch to expose raw provider/tool results.
    const protectedResult = sanitizeSensitiveValue(result) as T;
    return this.capResult(protectedResult);
  }

  private sanitizeErrorMessage(message: string): string {
    return redactSensitiveText(message);
  }

  private contextKey(context: ArtifactBridgeContext): string {
    return context.kind === 'agent'
      ? JSON.stringify([
          'agent',
          context.agentId,
          context.appId,
          context.pluginId ?? null,
        ])
      : JSON.stringify(['package', context.packageId, context.appId]);
  }

  private ephemeralGrantKey(
    context: ArtifactBridgeContext,
    sessionId: string,
  ): string {
    return `${this.contextKey(context)}:session:${sessionId}`;
  }

  private grantDispatchKey(grant: ArtifactBridgeGrant): string {
    return grant.scope.kind === 'session'
      ? this.ephemeralGrantKey(grant.context, grant.scope.sessionId)
      : this.contextKey(grant.context);
  }

  private currentGrantForDispatchKey(
    key: string,
  ): ArtifactBridgeGrant | undefined {
    if (
      this.pendingPersistentGrantMutations.has(key) ||
      this.pendingPersistentGrantRevocations.has(key) ||
      this.dirtyPersistentGrantContexts.has(key)
    ) {
      return undefined;
    }
    return this.ephemeralGrants.get(key) ?? this.store.grants[key];
  }

  private captureGrantBinding(
    grant: ArtifactBridgeGrant,
  ): ValidatedGrantBinding {
    const key = this.grantDispatchKey(grant);
    if (this.currentGrantForDispatchKey(key) !== grant) {
      throw new Error('Generated app capability grant is no longer current');
    }
    const existing = this.grantDispatchFences.get(key);
    if (existing?.grant === grant && !existing.dispatchFence.revoked) {
      return { key, grant, dispatchFence: existing.dispatchFence };
    }
    if (existing) existing.dispatchFence.revoked = true;
    if (this.nextGrantRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Generated app grant revision space is exhausted');
    }
    const dispatchFence: GrantDispatchFence = {
      grantId: randomUUID(),
      revision: ++this.nextGrantRevision,
      revoked: false,
    };
    this.grantDispatchFences.set(key, { grant, dispatchFence });
    return { key, grant, dispatchFence };
  }

  private requireValidatedGrantBinding(
    grant: ArtifactBridgeGrant,
  ): ValidatedGrantBinding {
    const binding = this.validatedGrantBindings.get(grant);
    if (!binding) {
      throw new Error('Generated app capability grant binding is unavailable');
    }
    return binding;
  }

  private isGrantBindingCurrent(binding: ValidatedGrantBinding): boolean {
    const currentFence = this.grantDispatchFences.get(binding.key);
    return Boolean(
      !binding.dispatchFence.revoked &&
        currentFence?.dispatchFence === binding.dispatchFence &&
        currentFence.grant === binding.grant &&
        this.currentGrantForDispatchKey(binding.key) === binding.grant,
    );
  }

  private requireGrantDispatchBinding(
    context: ArtifactBridgeContext,
    binding: ValidatedGrantBinding,
  ): void {
    this.assertEnabled();
    this.assertContextEnabled(context);
    if (
      !artifactBridgeContextsEqual(binding.grant.context, context) ||
      !this.isGrantBindingCurrent(binding)
    ) {
      throw new Error('Generated app capability grant was revoked or replaced');
    }
    if (
      binding.grant.expiresAt &&
      Date.parse(binding.grant.expiresAt) <= this.now()
    ) {
      void this.deleteGrant(binding.grant).catch((error) => {
        this.options.logger.warn(
          '[ArtifactBridge] Failed to persist an expired grant tombstone',
          { error },
        );
      });
      throw new Error('Generated app capability grant expired before dispatch');
    }
    if (
      binding.grant.scope.kind === 'session' &&
      !this.isActiveSession(context, binding.grant.scope.sessionId)
    ) {
      throw new Error('Generated app session grant is no longer active');
    }
    if (
      binding.grant.capabilities.includes('mcp:write') ||
      binding.grant.mcpWriteTools.length > 0
    ) {
      this.assertWritesEnabled();
    }
    const policy = this.getPolicy(context);
    assertPolicyEnabled(policy);
    assertGrantMatchesPolicy(binding.grant, policy, this.now());
  }

  private invalidateGrantFence(key: string): void {
    const current = this.grantDispatchFences.get(key);
    if (current) current.dispatchFence.revoked = true;
    this.grantDispatchFences.delete(key);
  }

  private invalidateGrantFencesForContext(
    context: ArtifactBridgeContext,
  ): void {
    const persistentKey = this.contextKey(context);
    const sessionPrefix = `${persistentKey}:session:`;
    for (const key of [...this.grantDispatchFences.keys()]) {
      if (key === persistentKey || key.startsWith(sessionPrefix)) {
        this.invalidateGrantFence(key);
      }
    }
  }

  private advanceGrantMutationEpoch(context: ArtifactBridgeContext): number {
    const key = this.contextKey(context);
    const current = this.grantMutationEpochs.get(key) ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Generated app grant mutation epoch space is exhausted');
    }
    const next = current + 1;
    this.grantMutationEpochs.set(key, next);
    return next;
  }

  private requireGrantMutationEpoch(
    context: ArtifactBridgeContext,
    expected: number,
  ): void {
    if (
      (this.grantMutationEpochs.get(this.contextKey(context)) ?? 0) !== expected
    ) {
      throw new Error(
        'Generated app grant review became stale during publication',
      );
    }
  }

  private clearGrantReviewsForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    this.grantReviews.deleteContext(context);
    for (const [reviewId, binding] of this.grantReviewMutationEpochs) {
      if (binding.contextKey === key) {
        this.grantReviewMutationEpochs.delete(reviewId);
      }
    }
  }

  private generateUniqueSessionId(): string {
    let sessionId = randomUUID();
    while (this.activeSessions.has(sessionId)) sessionId = randomUUID();
    return sessionId;
  }

  private generateUniqueDocumentSlotId(): string {
    let documentSlotId = randomUUID();
    while (this.hostDocumentSlots.has(documentSlotId)) {
      documentSlotId = randomUUID();
    }
    return documentSlotId;
  }

  private async resolveValidatedApp(
    context: ArtifactBridgeContext,
  ): Promise<ResolvedArtifactBridgeApp | null> {
    const resolved = await this.options.resolveApp(context);
    if (!resolved) return null;
    const parsed = resolvedArtifactBridgeAppSchema.safeParse(resolved);
    if (!parsed.success) return null;
    if (
      parsed.data.manifest.id !== context.appId ||
      parsed.data.identity.appVersion !== parsed.data.manifest.version ||
      parsed.data.identity.manifestSchemaVersion !==
        parsed.data.manifest.schemaVersion
    ) {
      return null;
    }
    return parsed.data;
  }

  private requireHostSessionBinding(
    context: ArtifactBridgeContext,
    rawSessionId: string,
    rawNavigationEpoch: number,
    documentSlotId?: string,
  ): ValidatedArtifactBridgeHostSessionBinding {
    const sessionId = z.string().uuid().parse(rawSessionId);
    const navigationEpoch =
      artifactBridgeNavigationEpochSchema.parse(rawNavigationEpoch);
    const session = this.activeSessions.get(sessionId);
    if (
      !session?.hostIssued ||
      session.dispatchFence.revoked ||
      session.navigationEpoch !== navigationEpoch ||
      (documentSlotId !== undefined &&
        session.documentSlotId !== documentSlotId) ||
      !artifactBridgeContextsEqual(session.context, context)
    ) {
      this.captureDogfoodTelemetry(context, {
        activity: 'security-control',
        outcome: 'blocked',
        security_control: 'principal-isolation',
      });
      throw new Error(
        'Generated app host session binding is inactive or mismatched',
      );
    }
    return {
      documentSlotId: session.documentSlotId,
      sessionId,
      navigationEpoch,
      openedAt: session.openedAt,
      assetHash: session.identity.assetHash,
      identity: structuredClone(session.identity),
      dispatchFence: session.dispatchFence,
    };
  }

  private requireExactHostDocumentSlot(
    context: ArtifactBridgeContext,
    documentSlotId: string,
    sessionId: string,
    navigationEpoch: number,
  ): {
    context: ArtifactBridgeContext;
    navigationEpoch: number;
    sessionId: string;
  } {
    const slot = this.hostDocumentSlots.get(documentSlotId);
    if (
      !slot ||
      slot.sessionId !== sessionId ||
      slot.navigationEpoch !== navigationEpoch ||
      !artifactBridgeContextsEqual(slot.context, context)
    ) {
      this.captureDogfoodTelemetry(context, {
        activity: 'security-control',
        outcome: 'blocked',
        security_control: 'principal-isolation',
      });
      throw new Error(
        'Generated app host session binding is inactive or mismatched',
      );
    }
    return slot;
  }

  private requireExactHostSessionBinding(
    context: ArtifactBridgeContext,
    binding?: ValidatedArtifactBridgeHostSessionBinding,
  ): void {
    if (!binding) return;
    if (binding.dispatchFence.revoked) {
      this.rejectInactiveHostBinding(context);
    }
    const active = this.requireHostSessionBinding(
      context,
      binding.sessionId,
      binding.navigationEpoch,
      binding.documentSlotId,
    );
    if (
      active.dispatchFence !== binding.dispatchFence ||
      active.dispatchFence.generationId !==
        binding.dispatchFence.generationId ||
      !identitiesMatch(active.identity, binding.identity)
    ) {
      this.rejectInactiveHostBinding(context);
    }
  }

  private rejectInactiveHostBinding(context: ArtifactBridgeContext): never {
    this.captureDogfoodTelemetry(context, {
      activity: 'security-control',
      outcome: 'blocked',
      security_control: 'principal-isolation',
    });
    throw new Error(
      'Generated app host session binding is inactive or mismatched',
    );
  }

  private async invalidateExactHostSession(
    context: ArtifactBridgeContext,
    binding: ValidatedArtifactBridgeHostSessionBinding,
    reason: 'app-unavailable' | 'identity-mismatch',
  ): Promise<void> {
    let invalidated = false;
    await this.withHostSessionMutation(binding.documentSlotId, async () => {
      const active = this.activeSessions.get(binding.sessionId);
      if (
        !active?.hostIssued ||
        active.documentSlotId !== binding.documentSlotId ||
        active.navigationEpoch !== binding.navigationEpoch ||
        !artifactBridgeContextsEqual(active.context, context) ||
        !identitiesMatch(active.identity, binding.identity)
      ) {
        return;
      }
      await this.unregisterSession(context, binding.sessionId);
      invalidated = true;
    });

    if (invalidated) {
      await this.emitLifecycleEvent({
        type: 'identityChanged',
        context,
        reason,
      });
    }
  }

  private async withHostSessionMutation<T>(
    documentSlotId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.hostSessionMutationQueues.get(documentSlotId);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => await released);
    this.hostSessionMutationQueues.set(documentSlotId, queued);

    if (previous) await previous.catch(() => undefined);
    try {
      return await mutation();
    } finally {
      release();
      if (this.hostSessionMutationQueues.get(documentSlotId) === queued) {
        this.hostSessionMutationQueues.delete(documentSlotId);
      }
    }
  }

  private isActiveSession(
    context: ArtifactBridgeContext,
    sessionId: string,
  ): boolean {
    const session = this.activeSessions.get(sessionId);
    return Boolean(
      session && artifactBridgeContextsEqual(session.context, context),
    );
  }

  private async deleteGrant(grant: ArtifactBridgeGrant): Promise<void> {
    const key = this.grantDispatchKey(grant);
    const current = this.currentGrantForDispatchKey(key);
    if (current !== grant) return;
    const grantMutationEpoch = this.advanceGrantMutationEpoch(grant.context);
    this.clearGrantReviewsForContext(grant.context);
    if (grant.scope.kind === 'session') {
      this.deleteWritesForSession(grant.context, grant.scope.sessionId);
      this.deleteSensitiveCallsForSession(grant.context, grant.scope.sessionId);
      this.deleteOperationsForSession(grant.context, grant.scope.sessionId);
    } else {
      this.deletePersistentWritesForContext(grant.context);
      this.deletePersistentSensitiveCallsForContext(grant.context);
      this.deletePersistentOperationsForContext(grant.context);
    }
    this.invalidateGrantFence(key);
    if (grant.scope.kind === 'session') {
      this.ephemeralGrants.delete(key);
    } else {
      this.pendingPersistentGrantRevocations.set(
        key,
        structuredClone(grant.context),
      );
      // Do not report automatic invalidation as complete until the durable
      // tombstone commits. A failed save leaves this context fenced and is
      // surfaced to the caller; clean teardown performs a final retry.
      await this.persistPersistentGrantRevocation(
        grant.context,
        grantMutationEpoch,
        'reason:automatic-invalidation',
      );
    }
  }

  private deleteEphemeralGrantsForContext(
    context: ArtifactBridgeContext,
  ): void {
    const prefix = `${this.contextKey(context)}:session:`;
    for (const key of [...this.ephemeralGrants.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.invalidateGrantFence(key);
      this.ephemeralGrants.delete(key);
    }
  }

  private mcpPrincipalId(context: ArtifactBridgeContext): string {
    if (context.kind === 'agent') return context.agentId;
    return `generated-app-package:${createHash('sha256')
      .update(context.packageId)
      .digest('hex')
      .slice(0, 32)}`;
  }

  private assertEnabled(): void {
    this.assertNotDisposed();
    if (!this.options.isFeatureEnabled()) {
      throw new Error('Generated app capability bridge is disabled');
    }
  }

  private assertContextEnabled(context: ArtifactBridgeContext): void {
    if (
      context.kind === 'package' &&
      !(this.options.arePackageCapabilitiesEnabled?.() ?? false)
    ) {
      throw new Error('Packaged generated app capabilities are disabled');
    }
  }

  private assertWritesEnabled(): void {
    if (!(this.options.areWritesEnabled?.() ?? false)) {
      throw new Error('Generated app safe writes are disabled');
    }
  }

  private assertEphemeralGrantsEnabled(): void {
    if (!(this.options.areEphemeralGrantsEnabled?.() ?? false)) {
      throw new Error('Generated app ephemeral grants are disabled');
    }
  }

  private assertSensitiveEgressEnabled(): void {
    if (!(this.options.isSensitiveEgressEnabled?.() ?? false)) {
      throw new Error('Generated app sensitive egress policy is disabled');
    }
  }

  private assertAsyncOperationsEnabled(): void {
    if (!(this.options.areAsyncOperationsEnabled?.() ?? false)) {
      throw new Error('Generated app async operations are disabled');
    }
  }

  private assertRuntimeInspectorEnabled(): void {
    if (!(this.options.isRuntimeInspectorEnabled?.() ?? false)) {
      throw new Error('Generated app runtime inspector is disabled');
    }
  }

  private assertPersistentGrantStoreWritable(
    context: ArtifactBridgeContext,
    expectedPendingMutationEpoch?: number,
  ): void {
    const key = this.contextKey(context);
    const pendingMutationEpoch = this.pendingPersistentGrantMutations.get(key);
    if (
      pendingMutationEpoch !== undefined &&
      pendingMutationEpoch !== expectedPendingMutationEpoch
    ) {
      throw new Error('Generated app grant publication is already in progress');
    }
    if (this.pendingPersistentGrantRevocations.has(key)) {
      throw new Error(
        'Generated app grant revocation is awaiting durable persistence',
      );
    }
    if (this.dirtyPersistentGrantContexts.has(key)) {
      throw new Error(
        'Generated app grant store is fail-closed after a persistence error; revoke the grant to reconcile it',
      );
    }
  }

  private assertGrantReviewNotExpired(expiresAt?: string): void {
    if (expiresAt && Date.parse(expiresAt) <= this.now()) {
      throw new Error(
        'Artifact Bridge grant review expired before publication',
      );
    }
  }

  private validateGrantPublication(
    input: z.output<typeof artifactBridgeGrantInputSchema>,
    expectedPendingMutationEpoch: number,
    reviewExpiresAt?: string,
  ): void {
    this.assertEnabled();
    this.assertContextEnabled(input.context);
    this.assertPersistentGrantStoreWritable(
      input.context,
      expectedPendingMutationEpoch,
    );
    if (
      input.capabilities.includes('mcp:write') ||
      input.mcpWriteTools.length > 0
    ) {
      this.assertWritesEnabled();
    }
    const policy = this.getPolicy(input.context);
    assertPolicyEnabled(policy);
    assertGrantMatchesPolicy(input, policy, this.now());
    if (input.expiresAt && Date.parse(input.expiresAt) <= this.now()) {
      throw new Error('Artifact capability grant expiry must be in the future');
    }
    this.assertGrantReviewNotExpired(reviewExpiresAt);
    if (input.scope.kind === 'session') {
      this.assertEphemeralGrantsEnabled();
      if (!this.isActiveSession(input.context, input.scope.sessionId)) {
        throw new Error(
          'The selected generated app preview session is no longer active',
        );
      }
    }
  }

  private async persistPersistentGrantRevocation(
    context: ArtifactBridgeContext,
    expectedMutationEpoch: number,
    auditResource: string,
  ): Promise<void> {
    const key = this.contextKey(context);
    await this.persistGrantStoreMutation(
      context,
      expectedMutationEpoch,
      'revoke',
      (store) => {
        delete store.grants[key];
        return store;
      },
      undefined,
      async () => {
        await this.audit({
          action: 'grant.revoke-prepared',
          outcome: 'success',
          context: auditContext(context),
          resource: auditResource,
        });
      },
    );
    this.pendingPersistentGrantRevocations.delete(key);
  }

  private async persistGrantStoreMutation(
    context: ArtifactBridgeContext,
    expectedMutationEpoch: number,
    kind: 'set' | 'revoke',
    mutate: (store: GrantStore) => GrantStore,
    validateCurrent?: () => void,
    beforePublish?: () => Promise<void>,
    publish?: () => void,
  ): Promise<void> {
    const key = this.contextKey(context);
    const run = async () => {
      this.requireGrantMutationEpoch(context, expectedMutationEpoch);
      validateCurrent?.();
      const previous = structuredClone(this.store);
      const candidate = mutate(structuredClone(previous));
      candidate.pendingMutations = {
        ...(candidate.pendingMutations ?? {}),
        [key]: {
          mutationId: randomUUID(),
          kind,
          context: structuredClone(context),
          startedAt: new Date(this.now()).toISOString(),
        },
      };
      grantStoreSchema.parse(candidate);
      let committed: GrantStore | null = null;
      try {
        // A crash after this staged write is fail-closed on restart: startup
        // removes every grant whose mutation marker was not finalized.
        await this.persistence.save(candidate);
        this.requireGrantMutationEpoch(context, expectedMutationEpoch);
        validateCurrent?.();
        await beforePublish?.();
        this.requireGrantMutationEpoch(context, expectedMutationEpoch);
        validateCurrent?.();

        // Preserve the exact grant object that was validated above. Grant
        // dispatch fences deliberately use object identity to distinguish an
        // identical-looking replacement grant from the authority instance it
        // replaces. Cloning here would make the freshly committed grant fail
        // its own publication fence.
        committed = candidate;
        if (committed.pendingMutations) {
          delete committed.pendingMutations[key];
          if (Object.keys(committed.pendingMutations).length === 0) {
            delete committed.pendingMutations;
          }
        }
        grantStoreSchema.parse(committed);
        await this.persistence.save(committed);
      } catch (mutationError) {
        // save() failures are ambiguous. Restore the last published snapshot
        // when possible; otherwise leave the context dirty and the staged
        // marker on disk for startup reconciliation.
        this.dirtyPersistentGrantContexts.add(key);
        try {
          await this.persistence.save(previous);
          this.dirtyPersistentGrantContexts.delete(key);
        } catch (rollbackError) {
          this.options.logger.warn(
            '[ArtifactBridge] Failed to roll back a stale grant-store write',
            { rollbackError },
          );
        }
        throw mutationError;
      }

      this.store = committed;
      this.dirtyPersistentGrantContexts.delete(key);
      publish?.();
    };

    const task = this.saveQueue.then(run, run);
    this.saveQueue = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  private async audit(
    event: Parameters<ArtifactBridgeAuditRecorder['record']>[0],
  ): Promise<void> {
    await this.options.auditRecorder?.record(event);
  }

  private async emitLifecycleEvent(
    event:
      | Omit<
          Extract<
            ArtifactBridgeLifecycleEvent,
            { type: 'capabilitiesChanged' }
          >,
          'eventId' | 'occurredAt'
        >
      | Omit<
          Extract<ArtifactBridgeLifecycleEvent, { type: 'revoked' }>,
          'eventId' | 'occurredAt'
        >
      | Omit<
          Extract<ArtifactBridgeLifecycleEvent, { type: 'identityChanged' }>,
          'eventId' | 'occurredAt'
        >
      | Omit<
          Extract<
            ArtifactBridgeLifecycleEvent,
            { type: 'automationCompleted' }
          >,
          'eventId' | 'occurredAt'
        >
      | Omit<
          Extract<ArtifactBridgeLifecycleEvent, { type: 'operationChanged' }>,
          'eventId' | 'occurredAt'
        >,
  ): Promise<void> {
    if (!(this.options.areLifecycleEventsEnabled?.() ?? false)) return;
    const invalidationKey =
      event.type === 'revoked' || event.type === 'identityChanged'
        ? `${this.contextKey(event.context)}:${event.type}:${event.reason}:${
            event.type === 'revoked' ? (event.sessionId ?? 'all') : 'all'
          }`
        : null;
    if (
      invalidationKey &&
      this.lifecycleInvalidationSignals.has(invalidationKey)
    ) {
      return;
    }
    try {
      await this.options.emitLifecycleEvent?.({
        ...event,
        eventId: randomUUID(),
        occurredAt: new Date(this.now()).toISOString(),
      } as ArtifactBridgeLifecycleEvent);
      if (invalidationKey) {
        this.lifecycleInvalidationSignals.add(invalidationKey);
      }
    } catch (error) {
      this.options.logger.warn(
        '[ArtifactBridge] Failed to emit advisory lifecycle event',
        {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private captureDogfoodTelemetry(
    context: ArtifactBridgeContext,
    observation: Omit<
      AgenticAppRuntimeDogfoodTelemetry,
      'principal_kind' | 'app_instance_hash'
    >,
  ): void {
    try {
      this.options.captureDogfoodTelemetry?.(context, observation);
    } catch (error) {
      this.options.logger.warn(
        '[ArtifactBridge] Failed to capture content-free dogfood telemetry',
        { error },
      );
    }
  }

  private clearLifecycleInvalidationSignals(
    context: ArtifactBridgeContext,
  ): void {
    const prefix = `${this.contextKey(context)}:`;
    for (const key of this.lifecycleInvalidationSignals) {
      if (key.startsWith(prefix)) this.lifecycleInvalidationSignals.delete(key);
    }
  }

  protected async onTeardown(): Promise<void> {
    for (const session of this.activeSessions.values()) {
      if (session.hostIssued) session.dispatchFence.revoked = true;
    }
    for (const procedure of PROCEDURES) {
      this.options.karton.removeServerProcedureHandler(procedure);
    }
    this.recentCalls.clear();
    this.activeInvocations.clear();
    this.operationCalls.clear();
    this.writes.clear();
    this.sensitiveMcpCalls.clear();
    for (const operation of this.operations.values()) {
      this.disposeOperation(operation);
    }
    this.operations.clear();
    this.activeSessions.clear();
    this.hostDocumentSlots.clear();
    this.hostSessionMutationQueues.clear();
    await this.saveQueue;
    for (const context of [
      ...this.pendingPersistentGrantRevocations.values(),
    ]) {
      const retryEpoch = this.advanceGrantMutationEpoch(context);
      await this.persistPersistentGrantRevocation(
        context,
        retryEpoch,
        'reason:teardown-retry',
      );
    }
    this.ephemeralGrants.clear();
    this.grantReviews.clear();
    this.grantMutationEpochs.clear();
    this.grantReviewMutationEpochs.clear();
    this.pendingPersistentGrantMutations.clear();
    this.pendingPersistentGrantRevocations.clear();
    this.dirtyPersistentGrantContexts.clear();
    this.lifecycleInvalidationSignals.clear();
    await this.effectWal.flush();
  }
}

function isAuthorizationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /grant|granted|capability|requested|allowed|policy|quota|rate limit|concurrent|read-only|destructive/i.test(
    error.message,
  );
}

type PreparedWrite = {
  proposal: ArtifactBridgeWriteProposal;
  sessionId: string | null;
  identity: GeneratedAppIdentity;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  grantBinding: ValidatedGrantBinding;
  effectCommitment: ArtifactBridgeMcpEffectCommitment;
  classification: ArtifactBridgeTrustedMcpClassification;
  dispatchAuthorized: boolean;
  status:
    | 'prepared'
    | 'approved'
    | 'committing'
    | 'committed'
    | 'result-unavailable'
    | 'uncertain'
    | 'failed-pre-effect';
  commitToken: string | null;
  approvalAuditRecorded: boolean;
  approvalAuditPromise: Promise<void> | null;
  commitPromise: Promise<unknown> | null;
  result: unknown;
};

type PreparedSensitiveMcpCall = {
  proposal: ArtifactBridgeSensitiveMcpProposal;
  sessionId: string | null;
  identity: GeneratedAppIdentity;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  grantBinding: ValidatedGrantBinding;
  effectCommitment: ArtifactBridgeMcpEffectCommitment;
  classification: ArtifactBridgeTrustedMcpClassification;
  dispatchAuthorized: boolean;
  status:
    | 'prepared'
    | 'approved'
    | 'committing'
    | 'committed'
    | 'result-unavailable'
    | 'uncertain'
    | 'failed-pre-effect';
  commitToken: string | null;
  approvalAuditRecorded: boolean;
  approvalAuditPromise: Promise<void> | null;
  commitPromise: Promise<unknown> | null;
  operationId: string | null;
  result: unknown;
};

type PreparedEffect = PreparedWrite | PreparedSensitiveMcpCall;

type ArtifactBridgeOperation = {
  snapshot: ArtifactBridgeOperationSnapshot;
  sessionId: string | null;
  exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding;
  grantBinding: ValidatedGrantBinding;
  controller: AbortController;
  active: boolean;
  finalDispatchPassed: boolean;
  retentionSeconds: number;
  result: unknown;
  timeout: ReturnType<typeof setTimeout> | null;
};

function isTerminalOperation(
  status: ArtifactBridgeOperationSnapshot['status'],
): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out' ||
    status === 'uncertain'
  );
}

function isTerminalEffectFailureStatus(
  status: PreparedEffect['status'],
): status is 'result-unavailable' | 'uncertain' | 'failed-pre-effect' {
  return (
    status === 'result-unavailable' ||
    status === 'uncertain' ||
    status === 'failed-pre-effect'
  );
}

function throwTerminalEffectFailure(
  status: 'result-unavailable' | 'uncertain' | 'failed-pre-effect',
): never {
  switch (status) {
    case 'result-unavailable':
      throw new Error(
        'Effect completed but its result is unavailable; retry is forbidden',
      );
    case 'uncertain':
      throw new Error('Effect outcome is uncertain; retry is forbidden');
    case 'failed-pre-effect':
      throw new Error(
        'Execution ticket failed before effect dispatch; a new review is required',
      );
  }
}

function artifactBridgeContextsEqual(
  left: ArtifactBridgeContext,
  right: ArtifactBridgeContext,
): boolean {
  if (left.kind !== right.kind || left.appId !== right.appId) return false;
  if (left.kind === 'package' && right.kind === 'package') {
    return left.packageId === right.packageId;
  }
  if (left.kind === 'agent' && right.kind === 'agent') {
    return (
      left.agentId === right.agentId &&
      (left.pluginId ?? null) === (right.pluginId ?? null)
    );
  }
  return false;
}

function assertPolicyEnabled(policy: ArtifactBridgePolicy): void {
  if (!policy.enabled) {
    throw new Error('Generated app capabilities are disabled by policy');
  }
}

function assertCapabilityAllowedByPolicy(
  policy: ArtifactBridgePolicy,
  capability: ArtifactBridgeCapability,
): void {
  if (!policy.allowedCapabilities.includes(capability)) {
    throw new Error(
      `Capability "${capability}" is disabled by organization policy`,
    );
  }
}

function assertGrantMatchesPolicy(
  input: ParsedArtifactBridgeGrantInput,
  policy: ArtifactBridgePolicy,
  now: number,
): void {
  for (const capability of input.capabilities) {
    if (!policy.allowedCapabilities.includes(capability)) {
      throw new Error(
        `Capability "${capability}" is disabled by organization policy`,
      );
    }
  }
  for (const tool of input.mcpTools) {
    assertToolAllowedByPolicy(
      policy.allowedMcpReadTools,
      tool.serverId,
      tool.toolName,
      'read',
    );
  }
  for (const tool of input.mcpWriteTools) {
    assertToolAllowedByPolicy(
      policy.allowedMcpWriteTools,
      tool.serverId,
      tool.toolName,
      'write',
    );
  }
  if (!input.expiresAt) {
    if (!policy.allowNeverExpiringGrants) {
      throw new Error('Never-expiring grants are disabled by policy');
    }
    return;
  }
  if (
    Date.parse(input.expiresAt) - now >
    policy.maxGrantDurationHours * 3_600_000
  ) {
    throw new Error('Grant expiry exceeds the organization policy limit');
  }
}

function assertToolAllowedByPolicy(
  patterns: string[],
  serverId: string,
  toolName: string,
  mode: 'read' | 'write',
): void {
  if (!matchesArtifactBridgeToolPolicy(patterns, serverId, toolName)) {
    throw new Error(
      `MCP ${mode} tool "${serverId}/${toolName}" is disabled by organization policy`,
    );
  }
}

function assertSensitiveToolAllowedByPolicy(
  policy: ArtifactBridgePolicy,
  serverId: string,
  toolName: string,
): void {
  if (
    matchesArtifactBridgeToolPolicy(
      policy.deniedSensitiveMcpTools,
      serverId,
      toolName,
    ) ||
    !matchesArtifactBridgeToolPolicy(
      policy.allowedSensitiveMcpTools,
      serverId,
      toolName,
    )
  ) {
    throw new Error(
      `Sensitive MCP tool "${serverId}/${toolName}" is disabled by organization policy`,
    );
  }
}

function sameSensitiveReasons(
  left: ArtifactBridgeSensitiveEgressReason[],
  right: ArtifactBridgeSensitiveEgressReason[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reason) => right.includes(reason))
  );
}

function capabilityKindForRequest(
  method: ArtifactBridgeRequest['method'],
): NonNullable<AgenticAppRuntimeDogfoodTelemetry['capability_kind']> {
  switch (method) {
    case 'getCapabilities':
      return 'discovery';
    case 'callMcpTool':
    case 'startMcpOperation':
      return 'mcp-read';
    case 'prepareSensitiveMcpCall':
    case 'commitSensitiveMcpCall':
      return 'mcp-sensitive';
    case 'prepareMcpWrite':
    case 'commitMcpWrite':
      return 'mcp-write';
    case 'askAgent':
      return 'agent-ask';
    case 'runAutomation':
    case 'startAutomationOperation':
      return 'automation';
    case 'getOperation':
    case 'getOperationResult':
    case 'cancelOperation':
      return 'async-control';
  }
}

function hashJson(value: unknown): string {
  return hashArtifactBridgeJson(
    'clodex.artifact-bridge.arguments-integrity.v1',
    value,
  );
}

function effectTicketHash(commitToken: string): string {
  return hashArtifactBridgeJson(
    'clodex.artifact-bridge.execution-ticket.v1',
    commitToken,
  );
}

function hashAuditIdentifier(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function safeMcpAuditResource(serverId: string, toolName: string): string {
  return redactSensitiveText(`${serverId}/${toolName}`).slice(0, 513);
}

function createArgumentsPreview(arguments_: Record<string, unknown>): string {
  const redacted = sanitizeSensitiveValue(arguments_);
  const encoded = JSON.stringify(redacted, null, 2);
  return encoded.length <= 20_000
    ? encoded
    : `${encoded.slice(0, 19_980)}\n…[truncated]`;
}

function assertTrustedReviewer(clientId: string): void {
  if (clientId !== TRUSTED_UI_REVIEWER_CONNECTION_ID) {
    throw new Error('Artifact capability grants require a trusted UI client');
  }
}

function identitiesMatch(
  granted: GeneratedAppIdentity,
  current: GeneratedAppIdentity,
): boolean {
  return (
    granted.manifestSchemaVersion === current.manifestSchemaVersion &&
    granted.appVersion === current.appVersion &&
    granted.manifestHash === current.manifestHash &&
    granted.executableHash === current.executableHash &&
    granted.assetHash === current.assetHash
  );
}

function assertGrantMatchesManifest(
  input: ParsedArtifactBridgeGrantInput,
  manifest: GeneratedAppManifest,
): void {
  const requestedCapabilities = new Set(getManifestCapabilityTypes(manifest));
  for (const capability of input.capabilities) {
    if (!requestedCapabilities.has(capability)) {
      throw new Error(
        `Capability "${capability}" was not requested by the generated app manifest`,
      );
    }
  }

  const requestedMcpTools = new Set(
    getManifestMcpTools(manifest).map(
      (tool) => `${tool.serverId}\0${tool.toolName}`,
    ),
  );
  for (const tool of input.mcpTools) {
    if (!requestedMcpTools.has(`${tool.serverId}\0${tool.toolName}`)) {
      throw new Error(
        `MCP tool "${tool.serverId}/${tool.toolName}" was not requested by the generated app manifest`,
      );
    }
  }
  if (input.mcpTools.length > 0 && !input.capabilities.includes('mcp:call')) {
    throw new Error('MCP tools require the "mcp:call" capability');
  }

  const requestedMcpWriteTools = new Set(
    getManifestMcpWriteTools(manifest).map(
      (tool) => `${tool.serverId}\0${tool.toolName}`,
    ),
  );
  for (const tool of input.mcpWriteTools) {
    if (!requestedMcpWriteTools.has(`${tool.serverId}\0${tool.toolName}`)) {
      throw new Error(
        `MCP write tool "${tool.serverId}/${tool.toolName}" was not requested by the generated app manifest`,
      );
    }
  }
  if (
    input.mcpWriteTools.length > 0 &&
    !input.capabilities.includes('mcp:write')
  ) {
    throw new Error('MCP write tools require the "mcp:write" capability');
  }

  const requestedAutomationIds = new Set(getManifestAutomationIds(manifest));
  for (const automationId of input.automationIds) {
    if (!requestedAutomationIds.has(automationId)) {
      throw new Error(
        `Automation "${automationId}" was not requested by the generated app manifest`,
      );
    }
  }
  if (
    input.automationIds.length > 0 &&
    !input.capabilities.includes('automation:run')
  ) {
    throw new Error(
      'Automation identifiers require the "automation:run" capability',
    );
  }
}
