import { createHash, randomUUID } from 'node:crypto';
import { evaluateMcpToolPolicy } from '@clodex/mcp-runtime';
import {
  DEFAULT_ARTIFACT_BRIDGE_POLICY,
  artifactBridgeContextSchema,
  artifactBridgeGrantInputSchema,
  artifactBridgeGrantRevokeScopeSchema,
  artifactBridgeGrantSchema,
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
  type ArtifactBridgeSessionSnapshot,
  type ArtifactBridgeWriteApproval,
  type ArtifactBridgeWriteProposal,
} from '@shared/artifact-bridge';
import {
  getManifestAutomationIds,
  getManifestCapabilityTypes,
  getManifestMcpTools,
  getManifestMcpWriteTools,
  type GeneratedAppIdentity,
  type GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import type { AgenticAppRuntimeDogfoodTelemetry } from '@shared/agentic-app-runtime-telemetry';
import { z } from 'zod';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import { DisposableService } from '../disposable';
import {
  artifactBridgeAuditResource,
  auditContext,
  type ArtifactBridgeAuditReader,
  type ArtifactBridgeAuditRecorder,
} from './audit-ledger';
import {
  assertNoRawSecrets,
  classifySensitiveMcpOperation,
  redactSensitiveText,
  sanitizeSensitiveValue,
} from './sensitive-egress';

const MAX_RESULT_BYTES = 1_000_000;
const MAX_CALLS_PER_MINUTE = 30;
type ParsedArtifactBridgeGrantInput = z.output<
  typeof artifactBridgeGrantInputSchema
>;
const PROCEDURES = [
  'artifactBridge.invoke',
  'artifactBridge.getGrant',
  'artifactBridge.getActiveSessions',
  'artifactBridge.getRuntimeInspector',
  'artifactBridge.setGrant',
  'artifactBridge.revokeGrant',
  'artifactBridge.getPolicy',
  'artifactBridge.approveWrite',
  'artifactBridge.rejectWrite',
  'artifactBridge.approveSensitiveMcpCall',
  'artifactBridge.rejectSensitiveMcpCall',
] as const;

const grantStoreSchema = z.object({
  version: z.literal(5),
  grants: z.record(z.string(), artifactBridgeGrantSchema),
});
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
  askAgent: (context: ArtifactBridgeContext, prompt: string) => Promise<string>;
  runAutomation: (automationId: string) => Promise<unknown>;
  resolveApp: (context: ArtifactBridgeContext) => Promise<{
    identity: GeneratedAppIdentity;
    manifest: GeneratedAppManifest;
  } | null>;
  auditRecorder?: ArtifactBridgeAuditRecorder;
  auditReader?: ArtifactBridgeAuditReader;
  getPolicy?: (context: ArtifactBridgeContext) => ArtifactBridgePolicy;
  areWritesEnabled?: () => boolean;
  persistence?: ArtifactBridgePersistence;
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
    { context: ArtifactBridgeContext; openedAt: string }
  >();
  private readonly ephemeralGrants = new Map<string, ArtifactBridgeGrant>();

  private constructor(private readonly options: ArtifactBridgeServiceOptions) {
    super();
    this.persistence = options.persistence ?? new PersistedGrantStore();
    this.now = options.now ?? Date.now;
  }

  public static async create(
    options: ArtifactBridgeServiceOptions,
  ): Promise<ArtifactBridgeService> {
    const service = new ArtifactBridgeService(options);
    const persisted = await service.persistence.load();
    const parsed = grantStoreSchema.safeParse(persisted);
    if (parsed.success) {
      service.store = parsed.data;
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
      'artifactBridge.invoke',
      async (_clientId, context, request, sessionId) =>
        await this.invoke(context, request, sessionId),
    );
    this.options.karton.registerServerProcedureHandler(
      'artifactBridge.getGrant',
      async (_clientId, context, sessionId) =>
        await this.getGrant(context, sessionId),
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
      'artifactBridge.setGrant',
      async (clientId, input) => {
        assertTrustedReviewer(clientId);
        return await this.setGrant(input);
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
      async (_clientId, context) => this.getPolicy(context),
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
        const policy = this.getPolicy(context);
        assertPolicyEnabled(policy);
        switch (request.method) {
          case 'callMcpTool':
            assertCapabilityAllowedByPolicy(policy, 'mcp:call');
            this.requireCapability(grant, 'mcp:call');
            result = await this.callMcpTool(context, grant, request.params);
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
            if (this.options.isSensitiveEgressEnabled?.() ?? false) {
              assertNoRawSecrets(request.params.prompt);
            }
            this.consumeOperationQuota(
              context,
              'agent:ask',
              policy.maxAgentAsksPerHour,
            );
            result = this.protectResult({
              text: await this.options.askAgent(context, request.params.prompt),
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
              result = this.protectResult(
                await this.options.runAutomation(request.params.automationId),
              );
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
      const denied = isAuthorizationError(error);
      await this.audit({
        action: 'capability.invoked',
        outcome: denied ? 'denied' : 'error',
        context: auditContext(context),
        requestId: hashAuditIdentifier(request.id),
        method: request.method,
        resource: artifactBridgeAuditResource(request.method, request.params),
        error:
          error instanceof Error
            ? this.sanitizeErrorMessage(error.message).slice(0, 500)
            : 'Unknown',
      });
      this.captureDogfoodTelemetry(context, {
        activity: 'capability-invocation',
        outcome: denied ? 'denied' : 'failure',
        capability_kind: capabilityKindForRequest(request.method),
      });
      if (
        error instanceof Error &&
        /raw credentials|credential-shaped|secret/i.test(error.message)
      ) {
        this.captureDogfoodTelemetry(context, {
          activity: 'security-control',
          outcome: 'blocked',
          security_control: 'secret-egress',
        });
      }
      if (error instanceof Error) {
        const sanitizedMessage = this.sanitizeErrorMessage(error.message);
        if (sanitizedMessage !== error.message) {
          throw new Error(sanitizedMessage);
        }
      }
      throw error;
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
    const grant =
      sessionId && (this.options.areEphemeralGrantsEnabled?.() ?? false)
        ? (this.ephemeralGrants.get(
            this.ephemeralGrantKey(context, sessionId),
          ) ?? this.store.grants[this.contextKey(context)])
        : this.store.grants[this.contextKey(context)];
    if (!grant) return null;
    if (
      grant.scope.kind === 'session' &&
      (!sessionId ||
        grant.scope.sessionId !== sessionId ||
        !this.isActiveSession(context, sessionId))
    ) {
      return null;
    }
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now()) {
      this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'revoked',
        context,
        reason: 'grant-expired',
      });
      return null;
    }
    const current = await this.options.resolveApp(context);
    if (!current) {
      this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'identityChanged',
        context,
        reason: 'app-unavailable',
      });
      return null;
    }
    if (!identitiesMatch(grant.identity, current.identity)) {
      this.deleteGrant(grant);
      await this.emitLifecycleEvent({
        type: 'identityChanged',
        context,
        reason: 'identity-mismatch',
      });
      return null;
    }
    this.clearLifecycleInvalidationSignals(context);
    return structuredClone(grant);
  }

  public async setGrant(
    rawInput: ArtifactBridgeGrantInput,
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
    const current = await this.options.resolveApp(input.context);
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
    if (input.scope.kind === 'session') {
      this.assertEphemeralGrantsEnabled();
      if (!this.isActiveSession(input.context, input.scope.sessionId)) {
        throw new Error(
          'The selected generated app preview session is no longer active',
        );
      }
    }
    const grant = artifactBridgeGrantSchema.parse({
      ...input,
      schemaVersion: 5,
      identity: current.identity,
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (grant.scope.kind === 'session') {
      const persistentChanged = Boolean(
        this.store.grants[this.contextKey(grant.context)],
      );
      delete this.store.grants[this.contextKey(grant.context)];
      this.deleteEphemeralGrantsForContext(grant.context);
      this.ephemeralGrants.set(
        this.ephemeralGrantKey(grant.context, grant.scope.sessionId),
        grant,
      );
      if (persistentChanged) await this.persist();
    } else {
      this.deleteEphemeralGrantsForContext(grant.context);
      this.store.grants[this.contextKey(grant.context)] = grant;
      await this.persist();
    }
    this.clearLifecycleInvalidationSignals(grant.context);
    await this.audit({
      action: 'grant.saved',
      outcome: 'success',
      context: auditContext(grant.context),
      resource: `scope:${grant.scope.kind}`,
    });
    await this.emitLifecycleEvent({
      type: 'capabilitiesChanged',
      context: grant.context,
      reason: 'grant-saved',
    });
    return structuredClone(grant);
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
    this.clearLifecycleInvalidationSignals(context);
    let persistentChanged = false;
    if (scope.kind === 'all' || scope.kind === 'persistent') {
      persistentChanged = Boolean(this.store.grants[this.contextKey(context)]);
      delete this.store.grants[this.contextKey(context)];
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
    if (persistentChanged) await this.persist();
    await this.audit({
      action: 'grant.revoked',
      outcome: 'success',
      context: auditContext(context),
      resource: `scope:${scope.kind}`,
    });
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
    this.activeSessions.set(sessionId, {
      context,
      openedAt: existing?.openedAt ?? new Date(this.now()).toISOString(),
    });
    if (!existing) {
      this.captureDogfoodTelemetry(context, {
        activity: 'preview-session',
        outcome: 'started',
      });
    }
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
      this.activeSessions.delete(sessionId);
      this.captureDogfoodTelemetry(context, {
        activity: 'preview-session',
        outcome: 'closed',
      });
    }
    const hadGrant = this.ephemeralGrants.delete(
      this.ephemeralGrantKey(context, sessionId),
    );
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
    assertPolicyEnabled(this.getPolicy(context));
    if (prepared.status === 'committed') {
      throw new Error('Generated app write proposal was already committed');
    }
    if (prepared.status === 'committing') {
      throw new Error(
        'Generated app write proposal is already being committed',
      );
    }
    if (prepared.status === 'approved' && prepared.commitToken) {
      return {
        proposal: structuredClone(prepared.proposal),
        commitToken: prepared.commitToken,
      };
    }
    if (!prepared.commitToken) prepared.commitToken = randomUUID();
    prepared.status = 'approved';
    await this.audit({
      action: 'write.approved',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(
        prepared.proposal.serverId,
        prepared.proposal.toolName,
      ),
    });
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
    if (prepared.status === 'committing' || prepared.status === 'committed') {
      throw new Error('Generated app write proposal can no longer be rejected');
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
    assertPolicyEnabled(this.getPolicy(context));
    if (prepared.status === 'committed') {
      throw new Error('Sensitive MCP call was already committed');
    }
    if (prepared.status === 'committing') {
      throw new Error('Sensitive MCP call is already being committed');
    }
    if (prepared.status === 'approved' && prepared.commitToken) {
      return {
        proposal: structuredClone(prepared.proposal),
        commitToken: prepared.commitToken,
      };
    }
    if (!prepared.commitToken) prepared.commitToken = randomUUID();
    prepared.status = 'approved';
    await this.audit({
      action: 'sensitive-egress.approved',
      outcome: 'success',
      context: auditContext(context),
      resource: safeMcpAuditResource(
        prepared.proposal.serverId,
        prepared.proposal.toolName,
      ),
    });
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
    if (prepared.status === 'committing' || prepared.status === 'committed') {
      throw new Error('Sensitive MCP call can no longer be rejected');
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
  ): Promise<unknown> {
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

    const result = await this.executeMcpTool(
      context,
      request.serverId,
      request.toolName,
      request.arguments,
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
  ): Promise<ArtifactBridgeOperationSnapshot> {
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
    const encodedArguments = JSON.stringify(request.arguments);
    if (Buffer.byteLength(encodedArguments, 'utf8') > 100_000) {
      throw new Error('Generated app MCP arguments exceed the size limit');
    }
    return await this.createOperation({
      context,
      sessionId,
      kind: 'mcp',
      label: `${request.serverId}/${request.toolName}`,
      timeoutMs: request.timeoutMs,
      cancellableWhenRunning: true,
      execute: async (signal, timeoutMs) =>
        this.protectResult(
          await this.executeMcpTool(
            context,
            request.serverId,
            request.toolName,
            request.arguments,
            signal,
            timeoutMs,
          ),
        ),
    });
  }

  private async startAutomationOperation(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    request: { automationId: string; timeoutMs?: number },
    sessionId?: string,
  ): Promise<ArtifactBridgeOperationSnapshot> {
    if (!grant.automationIds.includes(request.automationId)) {
      throw new Error('Automation is not included in the generated app grant');
    }
    const policy = this.getPolicy(context);
    this.consumeOperationQuota(
      context,
      'automation:run',
      policy.maxAutomationRunsPerHour,
    );
    return await this.createOperation({
      context,
      sessionId,
      kind: 'automation',
      label: `automation:${request.automationId}`,
      timeoutMs: request.timeoutMs,
      cancellableWhenRunning: false,
      execute: async () => {
        try {
          const result = this.protectResult(
            await this.options.runAutomation(request.automationId),
          );
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
    kind: ArtifactBridgeOperationKind;
    label: string;
    timeoutMs?: number;
    cancellableWhenRunning: boolean;
    execute: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>;
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
      controller,
      active: true,
      result: undefined,
      timeout: null,
    };
    this.operations.set(operation.snapshot.id, operation);
    this.captureDogfoodTelemetry(input.context, {
      activity: 'async-operation',
      outcome: 'started',
      operation_kind: input.kind,
    });
    await this.audit({
      action: 'operation.started',
      outcome: 'success',
      context: auditContext(input.context),
      resource: `kind:${input.kind}`,
    });
    await this.emitOperationChanged(operation);

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
  }

  private async runOperation(
    operation: ArtifactBridgeOperation,
    timeoutMs: number,
    retentionSeconds: number,
    cancellableWhenRunning: boolean,
    execute: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>,
  ): Promise<void> {
    if (!operation.active || operation.snapshot.status !== 'queued') return;
    operation.snapshot.status = 'running';
    operation.snapshot.startedAt = new Date(this.now()).toISOString();
    operation.snapshot.progress = { phase: 'running', percent: null };
    operation.snapshot.cancellable = cancellableWhenRunning;
    await this.emitOperationChanged(operation);

    operation.timeout = setTimeout(() => {
      if (!operation.active || operation.snapshot.status !== 'running') {
        return;
      }
      operation.controller.abort();
      void this.finishOperation(
        operation,
        'timed-out',
        retentionSeconds,
        undefined,
        'Generated app async operation timed out',
      );
    }, timeoutMs);

    try {
      const result = await execute(operation.controller.signal, timeoutMs);
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
          'cancelled',
          retentionSeconds,
          undefined,
          'Generated app async operation was cancelled',
        );
        return;
      }
      await this.finishOperation(
        operation,
        'failed',
        retentionSeconds,
        undefined,
        this.sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async finishOperation(
    operation: ArtifactBridgeOperation,
    status: 'completed' | 'failed' | 'cancelled' | 'timed-out',
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
      'cancelled',
      this.getPolicy(context).asyncOperationRetentionSeconds,
      undefined,
      'Generated app async operation was cancelled',
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

  private disposeOperation(operation: ArtifactBridgeOperation): void {
    operation.active = false;
    operation.controller.abort();
    if (operation.timeout) clearTimeout(operation.timeout);
    operation.timeout = null;
    operation.result = undefined;
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
  ): Promise<ArtifactBridgeSensitiveMcpProposal> {
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
    const encodedArguments = JSON.stringify(request.arguments);
    if (Buffer.byteLength(encodedArguments, 'utf8') > 100_000) {
      throw new Error('Generated app MCP arguments exceed the size limit');
    }
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
    this.sensitiveMcpCalls.set(proposal.id, {
      proposal,
      sessionId: sessionId ?? null,
      identity: structuredClone(grant.identity),
      arguments: structuredClone(request.arguments),
      argumentsHash: hashJson(request.arguments),
      status: 'prepared',
      commitToken: null,
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
        kind: 'mcp',
        label: `${prepared.proposal.serverId}/${prepared.proposal.toolName}`,
        timeoutMs: request.timeoutMs,
        cancellableWhenRunning: true,
        execute: async (signal) =>
          await this.executePreparedSensitiveMcpCall(
            context,
            grant,
            prepared,
            signal,
            request.timeoutMs,
          ),
      });
      prepared.operationId = snapshot.id;
      return snapshot;
    }
    prepared.status = 'committing';
    const commitPromise = this.executePreparedSensitiveMcpCall(
      context,
      grant,
      prepared,
    );
    prepared.commitPromise = commitPromise;
    try {
      return structuredClone(await commitPromise);
    } catch (error) {
      if (
        (prepared.status as PreparedSensitiveMcpCall['status']) !== 'committed'
      ) {
        prepared.status = 'approved';
        prepared.commitPromise = null;
      }
      throw error;
    }
  }

  private async executePreparedSensitiveMcpCall(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    prepared: PreparedSensitiveMcpCall,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
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
    const result = this.protectResult(
      await this.executeMcpTool(
        context,
        prepared.proposal.serverId,
        prepared.proposal.toolName,
        prepared.arguments,
        signal,
        timeoutMs,
      ),
    );
    prepared.status = 'committed';
    prepared.result = structuredClone(result);
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
  ): Promise<ArtifactBridgeWriteProposal> {
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
    const encodedArguments = JSON.stringify(request.arguments);
    if (Buffer.byteLength(encodedArguments, 'utf8') > 100_000) {
      throw new Error('Generated app write arguments exceed the size limit');
    }

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
      risk:
        descriptor.annotations?.destructiveHint === true
          ? 'destructive'
          : 'write',
      sensitiveEgressReasons,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + policy.writeProposalTtlSeconds * 1_000,
      ).toISOString(),
    };
    this.writes.set(proposal.id, {
      proposal,
      sessionId: sessionId ?? null,
      identity: structuredClone(grant.identity),
      arguments: structuredClone(request.arguments),
      argumentsHash: hashJson(request.arguments),
      status: 'prepared',
      commitToken: null,
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
      prepared.status === 'committing' &&
      prepared.commitToken === request.commitToken &&
      prepared.commitPromise
    ) {
      return structuredClone(await prepared.commitPromise);
    }
    if (
      prepared.status !== 'approved' ||
      prepared.commitToken !== request.commitToken
    ) {
      throw new Error('Generated app write proposal is not approved');
    }
    prepared.status = 'committing';
    const commitPromise = this.executePreparedWrite(context, grant, prepared);
    prepared.commitPromise = commitPromise;
    try {
      return structuredClone(await commitPromise);
    } catch (error) {
      // `executePreparedWrite` mutates the shared proposal across an await.
      // TypeScript keeps the pre-await "committing" narrowing, so widen it
      // before checking whether the commit completed and only audit failed.
      if ((prepared.status as PreparedWrite['status']) !== 'committed') {
        prepared.status = 'approved';
        prepared.commitPromise = null;
      }
      throw error;
    }
  }

  private async executePreparedWrite(
    context: ArtifactBridgeContext,
    grant: ArtifactBridgeGrant,
    prepared: PreparedWrite,
  ): Promise<unknown> {
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

    const result = this.protectResult(
      await this.executeMcpTool(
        context,
        prepared.proposal.serverId,
        prepared.proposal.toolName,
        prepared.arguments,
      ),
    );
    prepared.status = 'committed';
    prepared.result = structuredClone(result);
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

  private async executeMcpTool(
    context: ArtifactBridgeContext,
    serverId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    try {
      return await this.options.mcpRegistry.callTool(
        serverId,
        toolName,
        arguments_,
        {
          timeoutMs: timeoutMs ?? 30_000,
          ...(signal ? { signal } : {}),
          agentInstanceId: this.mcpPrincipalId(context),
        },
      );
    } catch (error) {
      if (this.options.isSensitiveEgressEnabled?.() ?? false) {
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

  private cleanupExpiredWrites(): void {
    const now = this.now();
    for (const [id, prepared] of this.writes) {
      if (Date.parse(prepared.proposal.expiresAt) <= now) {
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

  private cleanupExpiredSensitiveMcpCalls(): void {
    const now = this.now();
    for (const [id, prepared] of this.sensitiveMcpCalls) {
      if (Date.parse(prepared.proposal.expiresAt) <= now) {
        this.sensitiveMcpCalls.delete(id);
      }
    }
  }

  private deleteWritesForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.writes) {
      if (this.contextKey(prepared.proposal.context) === key) {
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
        this.writes.delete(id);
      }
    }
  }

  private deleteSensitiveCallsForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    for (const [id, prepared] of this.sensitiveMcpCalls) {
      if (this.contextKey(prepared.proposal.context) === key) {
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
        this.sensitiveMcpCalls.delete(id);
      }
    }
  }

  private deleteOperationsForContext(context: ArtifactBridgeContext): void {
    const key = this.contextKey(context);
    for (const [id, operation] of this.operations) {
      if (this.contextKey(operation.snapshot.context) === key) {
        this.disposeOperation(operation);
        this.operations.delete(id);
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
        this.disposeOperation(operation);
        this.operations.delete(id);
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
        this.disposeOperation(operation);
        this.operations.delete(id);
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
    const protectedResult = (
      this.options.isSensitiveEgressEnabled?.()
        ? sanitizeSensitiveValue(result)
        : result
    ) as T;
    return this.capResult(protectedResult);
  }

  private sanitizeErrorMessage(message: string): string {
    return this.options.isSensitiveEgressEnabled?.()
      ? redactSensitiveText(message)
      : message;
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

  private isActiveSession(
    context: ArtifactBridgeContext,
    sessionId: string,
  ): boolean {
    const session = this.activeSessions.get(sessionId);
    return Boolean(
      session && artifactBridgeContextsEqual(session.context, context),
    );
  }

  private deleteGrant(grant: ArtifactBridgeGrant): void {
    if (grant.scope.kind === 'session') {
      this.deleteOperationsForSession(grant.context, grant.scope.sessionId);
    } else {
      this.deletePersistentOperationsForContext(grant.context);
    }
    if (grant.scope.kind === 'session') {
      this.ephemeralGrants.delete(
        this.ephemeralGrantKey(grant.context, grant.scope.sessionId),
      );
    } else {
      delete this.store.grants[this.contextKey(grant.context)];
      void this.persist().catch(() => undefined);
    }
  }

  private deleteEphemeralGrantsForContext(
    context: ArtifactBridgeContext,
  ): void {
    const prefix = `${this.contextKey(context)}:session:`;
    for (const key of this.ephemeralGrants.keys()) {
      if (key.startsWith(prefix)) this.ephemeralGrants.delete(key);
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

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.store);
    this.saveQueue = this.saveQueue.then(
      async () => await this.persistence.save(snapshot),
      async () => await this.persistence.save(snapshot),
    );
    await this.saveQueue;
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
    this.ephemeralGrants.clear();
    this.lifecycleInvalidationSignals.clear();
    await this.saveQueue;
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
  status: 'prepared' | 'approved' | 'committing' | 'committed';
  commitToken: string | null;
  commitPromise: Promise<unknown> | null;
  result: unknown;
};

type PreparedSensitiveMcpCall = {
  proposal: ArtifactBridgeSensitiveMcpProposal;
  sessionId: string | null;
  identity: GeneratedAppIdentity;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  status: 'prepared' | 'approved' | 'committing' | 'committed';
  commitToken: string | null;
  commitPromise: Promise<unknown> | null;
  operationId: string | null;
  result: unknown;
};

type ArtifactBridgeOperation = {
  snapshot: ArtifactBridgeOperationSnapshot;
  sessionId: string | null;
  controller: AbortController;
  active: boolean;
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
    status === 'timed-out'
  );
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
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  if (clientId !== 'ui') {
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
    granted.executableHash === current.executableHash
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
