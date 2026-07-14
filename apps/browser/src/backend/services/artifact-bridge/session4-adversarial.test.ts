import { randomUUID } from 'node:crypto';
import type { McpServerConfig, McpToolDescriptor } from '@clodex/mcp-runtime';
import type {
  ArtifactBridgeContext,
  ArtifactBridgeGrantInput,
  ArtifactBridgeRequest,
  ArtifactBridgeWriteProposal,
} from '@shared/artifact-bridge';
import type {
  GeneratedAppIdentity,
  GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import type {
  ArtifactBridgeGrantReviewSelection,
  ArtifactBridgeGrantReviewSubmission,
} from '@shared/artifact-bridge-grant-review';
import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import type { TrustedMcpFinalAuthority } from '../mcp/trusted-dispatch-gateway';
import type { ArtifactBridgeAuditRecorder } from './audit-ledger';
import { createArtifactBridgeAgentAskModelAdapterIdentity } from './effect-commitment';
import { ArtifactBridgeService, type ArtifactBridgePersistence } from './index';

const context: ArtifactBridgeContext = {
  kind: 'agent',
  agentId: 'agent-1',
  appId: 'dashboard',
};

const automationId = '1cbd31a0-af7b-4b5a-948d-e782dea80d82';
const automationDefinition = {
  id: automationId,
  title: 'Approved report',
  prompt: 'Run the approved report',
  enabled: true,
  schedule: { kind: 'interval' as const, everyMs: 60_000 },
  missedRunPolicy: 'run-on-wake' as const,
  retryPolicy: {
    maxAttempts: 1,
    initialBackoffMs: 5_000,
    maxBackoffMs: 5_000,
  },
  executionTarget: 'local' as const,
  workspacePaths: [],
  modelId: 'test/model',
  approvalMode: 'alwaysAsk' as const,
  grant: { capabilities: [], expiresAt: null },
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  nextRunAt: '2026-07-14T00:01:00.000Z',
  lastRunAt: null,
};

const identity: GeneratedAppIdentity = {
  manifestSchemaVersion: 1,
  appVersion: '1.0.0',
  manifestHash: 'a'.repeat(64),
  executableHash: 'b'.repeat(64),
  assetHash: 'c'.repeat(64),
};

const manifest: GeneratedAppManifest = {
  schemaVersion: 1,
  id: 'dashboard',
  name: 'Dashboard',
  version: '1.0.0',
  entrypoint: 'index.html',
  capabilities: [
    {
      type: 'mcp:call',
      reason: 'Search documentation',
      tools: [{ serverId: 'docs', toolName: 'search' }],
    },
    {
      type: 'mcp:write',
      reason: 'Update records',
      tools: [{ serverId: 'docs', toolName: 'update' }],
    },
    {
      type: 'agent:ask',
      reason: 'Summarize data',
    },
    {
      type: 'automation:run',
      reason: 'Run the approved report',
      automationIds: [automationId],
    },
  ],
};

const readDescriptor: McpToolDescriptor = {
  name: 'search',
  title: 'Search docs',
  description: 'Search documentation',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const writeDescriptor: McpToolDescriptor = {
  name: 'update',
  title: 'Update record',
  description: 'Update one record',
  inputSchema: {
    type: 'object',
    properties: {
      recordId: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['recordId'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestMcpCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  agentInstanceId?: string;
  beforeDispatch?: () => void;
  finalAuthority?: TrustedMcpFinalAuthority;
};

function passMcpFinalDispatch(options: TestMcpCallOptions | undefined): void {
  options?.beforeDispatch?.();
  options?.finalAuthority?.prepareFinalCheck();
  options?.finalAuthority?.assertAndConsume(undefined as never);
}

function createHarness(initialStore: unknown = { version: 5, grants: {} }) {
  let store: unknown = structuredClone(initialStore);
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: (...args: any[]) => Promise<any>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  const saveGrantStore = vi.fn(
    async (value: Parameters<ArtifactBridgePersistence['save']>[0]) => {
      store = structuredClone(value);
    },
  );
  const persistence: ArtifactBridgePersistence = {
    load: async () => structuredClone(store),
    save: saveGrantStore,
  };

  const server: McpServerConfig = {
    id: 'docs',
    displayName: 'Docs',
    enabled: true,
    source: { kind: 'builtin', builtinId: 'docs' },
    transport: {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: {},
    },
    policy: { default: 'allow-read-only', tools: { update: 'allow' } },
  };
  const descriptors: McpToolDescriptor[] = [
    structuredClone(readDescriptor),
    structuredClone(writeDescriptor),
  ];
  const runtime = {
    restartCount: 0,
    catalogRevision: 0,
    configurationRevision: 0,
  };
  const mcpEffect = vi.fn(
    async (
      _serverId: string,
      _toolName: string,
      _arguments: Record<string, unknown>,
    ) => ({
      content: [{ type: 'text', text: 'ok' }],
    }),
  );
  const listTools = vi.fn(async () => structuredClone(descriptors));
  let beforeFinalDispatch: (() => void) | undefined;
  const callTool = vi.fn(
    async (
      serverId: string,
      toolName: string,
      arguments_: Record<string, unknown>,
      options?: TestMcpCallOptions,
    ) => {
      // Model the final adapter fence: no host effect occurs unless the
      // synchronous callback accepts the exact current commitment.
      beforeFinalDispatch?.();
      passMcpFinalDispatch(options);
      return await mcpEffect(serverId, toolName, arguments_);
    },
  );
  const mcpRegistry = {
    snapshot: () => ({
      schemaVersion: 1,
      servers: { docs: structuredClone(server) },
    }),
    listTools,
    getToolDispatchSnapshot: (serverId: string, toolName: string) => {
      if (serverId !== server.id || !server.enabled) {
        throw new Error('MCP server is not dispatch-ready');
      }
      const descriptor = descriptors.find(
        (candidate) => candidate.name === toolName,
      );
      if (!descriptor) throw new Error('MCP tool is not committed');
      return {
        server: structuredClone(server),
        runtime: structuredClone(runtime),
        descriptor: structuredClone(descriptor),
      };
    },
    callTool,
  } as unknown as McpRegistryService;

  const askEffect = vi.fn(async () => 'bounded answer');
  const resolveAgentAskModelAdapterIdentity = vi.fn(() =>
    createArtifactBridgeAgentAskModelAdapterIdentity('test/model'),
  );
  const askAgent = vi.fn(
    async (
      _context: ArtifactBridgeContext,
      _prompt: string,
      options?: { beforeDispatch?: () => void },
    ) => {
      options?.beforeDispatch?.();
      return await askEffect();
    },
  );
  const automationEffect = vi.fn(async () => ({ ok: true }));
  const runAutomation = vi.fn(
    async (
      requestedAutomationId: string,
      options?: {
        beforeDispatch?: (input: {
          automation: unknown;
          prompt: string;
          attempt: number;
        }) => void;
        retryMode?: 'configured' | 'no-blind-retry';
        failureMode?: 'record' | 'propagate';
      },
    ) => {
      options?.beforeDispatch?.({
        automation: {
          ...structuredClone(automationDefinition),
          id: requestedAutomationId,
        },
        prompt: automationDefinition.prompt,
        attempt: 1,
      });
      return await automationEffect();
    },
  );
  const resolveApp = vi.fn(async () => ({ identity, manifest }));
  const resolveAutomationDefinition = vi.fn(() =>
    structuredClone(automationDefinition),
  );

  return {
    karton,
    persistence,
    saveGrantStore,
    persistedGrantStore: () => structuredClone(store),
    server,
    descriptors,
    runtime,
    setBeforeFinalDispatch: (callback: (() => void) | undefined) => {
      beforeFinalDispatch = callback;
    },
    mcpRegistry,
    listTools,
    callTool,
    mcpEffect,
    askAgent,
    resolveAgentAskModelAdapterIdentity,
    askEffect,
    runAutomation,
    automationEffect,
    resolveAutomationDefinition,
    resolveApp,
  };
}

type Harness = ReturnType<typeof createHarness>;

async function createService(
  harness: Harness,
  options: {
    now?: () => number;
    sensitiveEgress?: () => boolean;
    asyncOperations?: () => boolean;
    auditRecorder?: ArtifactBridgeAuditRecorder;
  } = {},
) {
  return await ArtifactBridgeService.create({
    logger: { warn: vi.fn() } as unknown as Logger,
    karton: harness.karton,
    mcpRegistry: harness.mcpRegistry,
    persistence: harness.persistence,
    isFeatureEnabled: () => true,
    areWritesEnabled: () => true,
    ...(options.sensitiveEgress
      ? { isSensitiveEgressEnabled: options.sensitiveEgress }
      : {}),
    ...(options.asyncOperations
      ? { areAsyncOperationsEnabled: options.asyncOperations }
      : {}),
    askAgent: harness.askAgent,
    resolveAgentAskModelAdapterIdentity:
      harness.resolveAgentAskModelAdapterIdentity,
    runAutomation: harness.runAutomation,
    resolveAutomationDefinition: harness.resolveAutomationDefinition,
    resolveApp: harness.resolveApp,
    ...(options.auditRecorder ? { auditRecorder: options.auditRecorder } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

function grantInput(
  capabilities: ArtifactBridgeGrantInput['capabilities'] = [
    'mcp:call',
    'mcp:write',
    'agent:ask',
    'automation:run',
  ],
): ArtifactBridgeGrantInput {
  return {
    context,
    scope: { kind: 'persistent' },
    identity,
    capabilities,
    mcpTools: capabilities.includes('mcp:call')
      ? [{ serverId: 'docs', toolName: 'search' }]
      : [],
    mcpWriteTools: capabilities.includes('mcp:write')
      ? [{ serverId: 'docs', toolName: 'update' }]
      : [],
    automationIds: capabilities.includes('automation:run')
      ? [automationId]
      : [],
    expiresAt: null,
  };
}

async function replaceGrantWithIdenticalAuthority(
  service: ArtifactBridgeService,
  input: ArtifactBridgeGrantInput,
) {
  await service.setGrant(structuredClone(input));
}

async function prepareAndApproveWrite(service: ArtifactBridgeService) {
  const proposal = (await service.invoke(context, {
    id: randomUUID(),
    method: 'prepareMcpWrite',
    params: {
      serverId: 'docs',
      toolName: 'update',
      arguments: { recordId: 'record-1', status: 'approved' },
    },
  })) as ArtifactBridgeWriteProposal;
  const approval = await service.approveWrite(context, proposal.id);
  return { proposal, approval };
}

function reviewSubmission(
  snapshot: Awaited<ReturnType<ArtifactBridgeService['openGrantReview']>>,
): ArtifactBridgeGrantReviewSubmission {
  return {
    schemaVersion: 1,
    reviewId: snapshot.reviewId,
    context: snapshot.context,
    identity: snapshot.identity,
    selection: snapshot.selection,
  };
}

describe('ArtifactBridgeService Session 4 adversarial authorization', () => {
  it('does not publish a grant when revoke wins during setGrant resolution', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    const pausedResolution = deferred<{
      identity: GeneratedAppIdentity;
      manifest: GeneratedAppManifest;
    }>();
    harness.resolveApp.mockImplementationOnce(
      async () => await pausedResolution.promise,
    );

    const pendingGrant = service.setGrant(grantInput(['agent:ask']));
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledTimes(1));
    await service.revokeGrant(context);
    pausedResolution.resolve({ identity, manifest });

    await expect(pendingGrant).rejects.toThrow('stale during publication');
    await expect(service.getGrant(context)).resolves.toBeNull();
    expect(harness.askEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('never exposes a persistent grant before its durable save succeeds', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    harness.saveGrantStore.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(service.setGrant(grantInput(['agent:ask']))).rejects.toThrow(
      'disk unavailable',
    );
    await expect(service.getGrant(context)).resolves.toBeNull();
    expect(harness.persistedGrantStore()).toEqual({ version: 5, grants: {} });

    // The failed staged write is followed by a successful durable rollback,
    // so the context is safe to use again without an administrative repair.
    await expect(
      service.setGrant(grantInput(['agent:ask'])),
    ).resolves.toMatchObject({ capabilities: ['agent:ask'] });
    await service.teardown();
  });

  it('keeps a durably staged grant unusable until its audit record succeeds', async () => {
    const harness = createHarness();
    const auditStarted = deferred<void>();
    const releaseAudit = deferred<void>();
    const service = await createService(harness, {
      auditRecorder: {
        record: async (event) => {
          if (event.action !== 'grant.save-prepared') return;
          auditStarted.resolve();
          await releaseAudit.promise;
        },
      },
    });

    const publication = service.setGrant(grantInput(['agent:ask']));
    await auditStarted.promise;
    await expect(service.getGrant(context)).resolves.toBeNull();
    releaseAudit.resolve();

    await expect(publication).resolves.toMatchObject({
      capabilities: ['agent:ask'],
    });
    await expect(service.getGrant(context)).resolves.toMatchObject({
      capabilities: ['agent:ask'],
    });
    await service.teardown();
  });

  it('revokes an incomplete staged grant during crash recovery', async () => {
    const harness = createHarness();
    const auditStarted = deferred<void>();
    const releaseAudit = deferred<void>();
    const service = await createService(harness, {
      auditRecorder: {
        record: async (event) => {
          if (event.action !== 'grant.save-prepared') return;
          auditStarted.resolve();
          await releaseAudit.promise;
        },
      },
    });
    const publication = service.setGrant(grantInput(['agent:ask']));
    await auditStarted.promise;
    const crashSnapshot = harness.persistedGrantStore();
    expect(crashSnapshot).toMatchObject({
      version: 5,
      grants: expect.any(Object),
      pendingMutations: expect.any(Object),
    });

    const recoveredHarness = createHarness(crashSnapshot);
    const recovered = await createService(recoveredHarness);
    await expect(recovered.getGrant(context)).resolves.toBeNull();
    expect(recoveredHarness.persistedGrantStore()).toEqual({
      version: 5,
      grants: {},
    });
    await recovered.teardown();

    releaseAudit.resolve();
    await publication;
    await service.teardown();
  });

  it('rolls back a staged grant when mandatory audit persistence fails', async () => {
    const harness = createHarness();
    const service = await createService(harness, {
      auditRecorder: {
        record: async (event) => {
          if (event.action === 'grant.save-prepared') {
            throw new Error('audit unavailable');
          }
        },
      },
    });

    await expect(service.setGrant(grantInput(['agent:ask']))).rejects.toThrow(
      'audit unavailable',
    );
    await expect(service.getGrant(context)).resolves.toBeNull();
    expect(harness.persistedGrantStore()).toEqual({ version: 5, grants: {} });
    await service.teardown();
  });

  it('records only a prepared audit event when the grant becomes stale before commit', async () => {
    const harness = createHarness();
    const actions: string[] = [];
    let now = Date.parse('2026-07-14T00:00:00.000Z');
    const service = await createService(harness, {
      now: () => now,
      auditRecorder: {
        record: async (event) => {
          actions.push(event.action);
          if (event.action === 'grant.save-prepared') {
            now += 2_000;
          }
        },
      },
    });
    const expiringGrant = grantInput(['agent:ask']);
    expiringGrant.expiresAt = new Date(now + 1_000).toISOString();

    await expect(service.setGrant(expiringGrant)).rejects.toThrow(
      'expiry must be in the future',
    );
    expect(actions).toEqual(['grant.save-prepared']);
    expect(actions).not.toContain('grant.saved');
    await expect(service.getGrant(context)).resolves.toBeNull();
    expect(harness.persistedGrantStore()).toEqual({ version: 5, grants: {} });
    await service.teardown();
  });

  it('burns a write token when its approval audit fails and shares that failure across concurrent callers', async () => {
    const harness = createHarness();
    const approvalAuditStarted = deferred<void>();
    const releaseApprovalAudit = deferred<void>();
    let approvalAuditAttempts = 0;
    const service = await createService(harness, {
      auditRecorder: {
        record: async (event) => {
          if (event.action !== 'write.approved') return;
          approvalAuditAttempts += 1;
          approvalAuditStarted.resolve();
          await releaseApprovalAudit.promise;
          if (approvalAuditAttempts === 1) {
            throw new Error('approval audit unavailable');
          }
        },
      },
    });
    await service.setGrant(grantInput(['mcp:write']));
    const proposal = (await service.invoke(context, {
      id: randomUUID(),
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-audit-retry' },
      },
    })) as ArtifactBridgeWriteProposal;

    const firstApproval = service.approveWrite(context, proposal.id);
    const firstRejection = expect(firstApproval).rejects.toThrow(
      'approval audit unavailable',
    );
    await approvalAuditStarted.promise;
    const concurrentApproval = service.approveWrite(context, proposal.id);
    const concurrentRejection = expect(concurrentApproval).rejects.toThrow(
      'approval audit unavailable',
    );
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledTimes(4));

    expect(approvalAuditAttempts).toBe(1);
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    releaseApprovalAudit.resolve();
    await Promise.all([firstRejection, concurrentRejection]);

    await expect(service.approveWrite(context, proposal.id)).rejects.toThrow(
      'can no longer be approved',
    );
    expect(approvalAuditAttempts).toBe(1);
    expect(harness.mcpEffect).not.toHaveBeenCalled();

    const replacement = (await service.invoke(context, {
      id: randomUUID(),
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-fresh-review' },
      },
    })) as ArtifactBridgeWriteProposal;
    const replacementApproval = await service.approveWrite(
      context,
      replacement.id,
    );
    expect(approvalAuditAttempts).toBe(2);
    await service.invoke(context, {
      id: randomUUID(),
      method: 'commitMcpWrite',
      params: {
        proposalId: replacement.id,
        commitToken: replacementApproval.commitToken,
      },
    });
    expect(harness.mcpEffect).toHaveBeenCalledTimes(1);
    await service.teardown();
  });

  it('does not reuse a sensitive approval token after its audit first fails', async () => {
    const harness = createHarness();
    let approvalAuditAttempts = 0;
    const service = await createService(harness, {
      sensitiveEgress: () => true,
      auditRecorder: {
        record: async (event) => {
          if (event.action !== 'sensitive-egress.approved') return;
          approvalAuditAttempts += 1;
          if (approvalAuditAttempts === 1) {
            throw new Error('sensitive approval audit unavailable');
          }
        },
      },
    });
    await service.setGrant(grantInput(['mcp:call']));
    const proposal = (await service.invoke(context, {
      id: randomUUID(),
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'approved remote audit retry' },
      },
    })) as { id: string };

    await expect(
      service.approveSensitiveMcpCall(context, proposal.id),
    ).rejects.toThrow('sensitive approval audit unavailable');
    expect(approvalAuditAttempts).toBe(1);
    expect(harness.mcpEffect).not.toHaveBeenCalled();

    await expect(
      service.approveSensitiveMcpCall(context, proposal.id),
    ).rejects.toThrow('can no longer be approved');
    expect(approvalAuditAttempts).toBe(1);

    const replacement = (await service.invoke(context, {
      id: randomUUID(),
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'fresh sensitive approval review' },
      },
    })) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      replacement.id,
    );
    expect(approvalAuditAttempts).toBe(2);
    await service.invoke(context, {
      id: randomUUID(),
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: replacement.id,
        commitToken: approval.commitToken,
        asOperation: false,
      },
    });
    expect(harness.mcpEffect).toHaveBeenCalledTimes(1);
    await service.teardown();
  });

  it('rolls back a staged grant when teardown starts during durable save', async () => {
    const harness = createHarness();
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    harness.saveGrantStore.mockImplementationOnce(async (value) => {
      saveStarted.resolve();
      await releaseSave.promise;
      // Model a successful atomic replace immediately before the service sees
      // that shutdown invalidated publication.
      const persisted = structuredClone(value);
      await harness.saveGrantStore(persisted);
    });
    const service = await createService(harness);

    const publication = service.setGrant(grantInput(['agent:ask']));
    await saveStarted.promise;
    const teardown = service.teardown();
    releaseSave.resolve();

    await expect(publication).rejects.toThrow('has been disposed');
    await teardown;
    expect(harness.persistedGrantStore()).toEqual({ version: 5, grants: {} });

    const restarted = await createService(harness);
    await expect(restarted.getGrant(context)).resolves.toBeNull();
    await restarted.teardown();
  });

  it('keeps a failed persistent revoke fenced and retries the tombstone durably', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    await service.setGrant(grantInput(['agent:ask']));
    harness.saveGrantStore.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(service.revokeGrant(context)).rejects.toThrow(
      'disk unavailable',
    );
    await expect(service.getGrant(context)).resolves.toBeNull();
    await expect(service.setGrant(grantInput(['agent:ask']))).rejects.toThrow(
      'revocation is awaiting durable persistence',
    );

    await service.revokeGrant(context);
    expect(harness.persistedGrantStore()).toEqual({ version: 5, grants: {} });
    await service.teardown();

    const restarted = await createService(harness);
    await expect(restarted.getGrant(context)).resolves.toBeNull();
    await restarted.teardown();
  });

  it('does not claim that a persistent revoke committed when its final save fails', async () => {
    const harness = createHarness();
    const actions: string[] = [];
    const service = await createService(harness, {
      auditRecorder: {
        record: async (event) => {
          actions.push(event.action);
        },
      },
    });
    await service.setGrant(grantInput(['agent:ask']));
    actions.length = 0;
    harness.saveGrantStore
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('final commit unavailable'));

    await expect(service.revokeGrant(context)).rejects.toThrow(
      'final commit unavailable',
    );
    expect(actions).toEqual(['grant.revoke-prepared']);
    expect(actions).not.toContain('grant.revoked');
    await expect(service.getGrant(context)).resolves.toBeNull();

    await service.teardown();
    const restarted = await createService(harness);
    await expect(restarted.getGrant(context)).resolves.toBeNull();
    await restarted.teardown();
  });

  it('surfaces a failed automatic identity revocation and retries it during clean teardown', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    await service.setGrant(grantInput(['agent:ask']));
    harness.resolveApp.mockResolvedValue({
      identity: { ...identity, assetHash: 'd'.repeat(64) },
      manifest,
    });
    harness.saveGrantStore.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(service.getGrant(context)).rejects.toThrow('disk unavailable');
    await vi.waitFor(() =>
      expect(harness.saveGrantStore).toHaveBeenCalledTimes(4),
    );
    await expect(service.getGrant(context)).resolves.toBeNull();
    harness.resolveApp.mockResolvedValue({ identity, manifest });
    await service.teardown();
    expect(harness.persistedGrantStore()).toEqual({ version: 5, grants: {} });

    const restarted = await createService(harness);
    await expect(restarted.getGrant(context)).resolves.toBeNull();
    await restarted.teardown();
  });

  it('makes revoke win over an already-open grant review', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    const selection: ArtifactBridgeGrantReviewSelection = {
      scope: { kind: 'persistent' },
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    };
    const snapshot = await service.openGrantReview(context, selection);

    await service.revokeGrant(context);
    await expect(
      service.submitGrantReview(reviewSubmission(snapshot)),
    ).rejects.toThrow('unavailable or used');
    await expect(service.getGrant(context)).resolves.toBeNull();
    await service.teardown();
  });

  it('does not publish a review opened across a concurrent revoke', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    const pausedResolution = deferred<{
      identity: GeneratedAppIdentity;
      manifest: GeneratedAppManifest;
    }>();
    harness.resolveApp.mockImplementationOnce(
      async () => await pausedResolution.promise,
    );
    const selection: ArtifactBridgeGrantReviewSelection = {
      scope: { kind: 'persistent' },
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    };

    const pendingReview = service.openGrantReview(context, selection);
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledTimes(1));
    await service.revokeGrant(context);
    pausedResolution.resolve({ identity, manifest });

    await expect(pendingReview).rejects.toThrow('stale during publication');
    await expect(service.getGrant(context)).resolves.toBeNull();
    await service.teardown();
  });

  it('rejects a write ticket that expires during adapter readiness', async () => {
    const harness = createHarness();
    let now = Date.parse('2026-07-14T00:00:00.000Z');
    const service = await createService(harness, { now: () => now });
    await service.setGrant(grantInput(['mcp:write']));
    const { approval } = await prepareAndApproveWrite(service);
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    harness.callTool.mockImplementationOnce(
      async (serverId, toolName, arguments_, options) => {
        try {
          entered.resolve();
          await releaseFinalCallback.promise;
          passMcpFinalDispatch(options);
          return await harness.mcpEffect(serverId, toolName, arguments_);
        } finally {
          settled.resolve();
        }
      },
    );

    const commit = service.invoke(context, {
      id: randomUUID(),
      method: 'commitMcpWrite',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
      },
    });
    await entered.promise;
    now += 24 * 60 * 60 * 1_000;
    releaseFinalCallback.resolve();

    await expect(commit).rejects.toThrow(
      'ticket expired before final dispatch',
    );
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('rejects a queued sensitive ticket that expires before final dispatch', async () => {
    const harness = createHarness();
    let now = Date.parse('2026-07-14T00:00:00.000Z');
    const service = await createService(harness, {
      now: () => now,
      sensitiveEgress: () => true,
      asyncOperations: () => true,
    });
    await service.setGrant(grantInput(['mcp:call']));
    const proposal = (await service.invoke(context, {
      id: randomUUID(),
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'reviewed remote query' },
      },
    })) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      proposal.id,
    );
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    harness.callTool.mockImplementationOnce(
      async (serverId, toolName, arguments_, options) => {
        try {
          entered.resolve();
          await releaseFinalCallback.promise;
          passMcpFinalDispatch(options);
          return await harness.mcpEffect(serverId, toolName, arguments_);
        } finally {
          settled.resolve();
        }
      },
    );

    await service.invoke(context, {
      id: randomUUID(),
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: true,
      },
    });
    await entered.promise;
    now += 24 * 60 * 60 * 1_000;
    releaseFinalCallback.resolve();
    await settled.promise;

    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('does not return a replacement grant through a getGrant call authorized under the old grant epoch', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    const input = grantInput(['agent:ask']);
    await service.setGrant(input);
    const pausedResolution = deferred<{
      identity: GeneratedAppIdentity;
      manifest: GeneratedAppManifest;
    }>();
    harness.resolveApp.mockImplementationOnce(
      async () => await pausedResolution.promise,
    );

    const pendingGrant = service.getGrant(context);
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledTimes(2));
    await replaceGrantWithIdenticalAuthority(service, input);
    pausedResolution.resolve({ identity, manifest });

    await expect(pendingGrant).resolves.toBeNull();
    await expect(service.getGrant(context)).resolves.toMatchObject({
      capabilities: ['agent:ask'],
    });
    expect(harness.askEffect).not.toHaveBeenCalled();
    expect(harness.automationEffect).not.toHaveBeenCalled();
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it.each([
    {
      name: 'agent adapter after revocation',
      capabilities: ['agent:ask'] as const,
      request: {
        id: 'paused-ask',
        method: 'askAgent',
        params: { prompt: 'Do not dispatch after revocation.' },
      } satisfies ArtifactBridgeRequest,
      mutate: async (service: ArtifactBridgeService) => {
        await service.revokeGrant(context);
      },
      adapter: (harness: Harness) => harness.askAgent,
      effect: (harness: Harness) => harness.askEffect,
    },
    {
      name: 'automation adapter after identical replacement',
      capabilities: ['automation:run'] as const,
      request: {
        id: 'paused-automation',
        method: 'runAutomation',
        params: { automationId },
      } satisfies ArtifactBridgeRequest,
      mutate: async (service: ArtifactBridgeService) => {
        await replaceGrantWithIdenticalAuthority(
          service,
          grantInput(['automation:run']),
        );
      },
      adapter: (harness: Harness) => harness.runAutomation,
      effect: (harness: Harness) => harness.automationEffect,
    },
    {
      name: 'MCP adapter after identical replacement',
      capabilities: ['mcp:call'] as const,
      request: {
        id: 'paused-mcp',
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'authorization race' },
        },
      } satisfies ArtifactBridgeRequest,
      mutate: async (service: ArtifactBridgeService) => {
        await replaceGrantWithIdenticalAuthority(
          service,
          grantInput(['mcp:call']),
        );
      },
      adapter: (harness: Harness) => harness.callTool,
      effect: (harness: Harness) => harness.mcpEffect,
    },
  ])('fails closed before the $name when resolveApp is paused', async ({
    capabilities,
    request,
    mutate,
    adapter,
    effect,
  }) => {
    const harness = createHarness();
    const service = await createService(harness);
    await service.setGrant(grantInput([...capabilities]));
    const pausedResolution = deferred<{
      identity: GeneratedAppIdentity;
      manifest: GeneratedAppManifest;
    }>();
    harness.resolveApp.mockImplementationOnce(
      async () => await pausedResolution.promise,
    );

    const invocation = service.invoke(context, request);
    await vi.waitFor(() => expect(harness.resolveApp).toHaveBeenCalledTimes(2));
    await mutate(service);
    pausedResolution.resolve({ identity, manifest });

    await expect(invocation).rejects.toThrow('no active capability grant');
    expect(adapter(harness)).not.toHaveBeenCalled();
    expect(effect(harness)).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('invalidates an approved write token when an identical G2 replaces G1', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    const input = grantInput(['mcp:write']);
    await service.setGrant(input);
    const { proposal, approval } = await prepareAndApproveWrite(service);

    await replaceGrantWithIdenticalAuthority(service, input);

    await expect(
      service.invoke(context, {
        id: 'old-g1-write-token',
        method: 'commitMcpWrite',
        params: {
          proposalId: proposal.id,
          commitToken: approval.commitToken,
        },
      }),
    ).rejects.toThrow('unavailable or expired');
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it.each([
    {
      name: 'server endpoint',
      mutate: (harness: Harness) => {
        if (harness.server.transport.type !== 'streamable-http') {
          throw new Error('Unexpected test transport');
        }
        harness.server.transport.url = 'https://changed.example.com/mcp';
      },
    },
    {
      name: 'descriptor metadata',
      mutate: (harness: Harness) => {
        const descriptor = requireDescriptor(harness, 'update');
        descriptor.title = 'Changed title';
        descriptor.description = 'Changed description after approval';
      },
    },
    {
      name: 'descriptor input schema',
      mutate: (harness: Harness) => {
        requireDescriptor(harness, 'update').inputSchema = {
          type: 'object',
          properties: { recordId: { type: 'integer' } },
          required: ['recordId'],
          additionalProperties: false,
        };
      },
    },
    {
      name: 'non-classification descriptor annotations',
      mutate: (harness: Harness) => {
        const descriptor = requireDescriptor(harness, 'update');
        descriptor.annotations = {
          ...descriptor.annotations,
          idempotentHint: true,
          vendorReviewProfile: 'changed-after-approval',
        };
      },
    },
    {
      name: 'catalog generation',
      mutate: (harness: Harness) => {
        harness.runtime.catalogRevision += 1;
      },
    },
    {
      name: 'host restart generation',
      mutate: (harness: Harness) => {
        harness.runtime.restartCount += 1;
      },
    },
    {
      name: 'server configuration generation',
      mutate: (harness: Harness) => {
        harness.runtime.configurationRevision += 1;
      },
    },
  ])('blocks dispatch when the committed $name changes after write approval', async ({
    mutate,
  }) => {
    const harness = createHarness();
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:write']));
    const { proposal, approval } = await prepareAndApproveWrite(service);
    harness.setBeforeFinalDispatch(() => mutate(harness));

    await expect(
      service.invoke(context, {
        id: randomUUID(),
        method: 'commitMcpWrite',
        params: {
          proposalId: proposal.id,
          commitToken: approval.commitToken,
        },
      }),
    ).rejects.toThrow('MCP effect commitment changed');
    expect(harness.callTool).toHaveBeenCalledTimes(1);
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it.each([
    {
      name: 'circular',
      createArguments: () => {
        const arguments_: Record<string, unknown> = { query: 'cycle' };
        arguments_.self = arguments_;
        return arguments_;
      },
      message: 'circular references',
    },
    {
      name: 'BigInt',
      createArguments: () => ({ query: 'bigint', cursor: 1n }),
      message: 'bigint values',
    },
  ])('rejects $name MCP arguments before any effect can begin', async ({
    createArguments,
    message,
  }) => {
    const harness = createHarness();
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:call']));

    await expect(
      service.invoke(context, {
        id: randomUUID(),
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: createArguments(),
        },
      }),
    ).rejects.toThrow(message);
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });
});

function requireDescriptor(harness: Harness, toolName: string) {
  const descriptor = harness.descriptors.find(
    (candidate) => candidate.name === toolName,
  );
  if (!descriptor) throw new Error(`Missing test descriptor ${toolName}`);
  return descriptor;
}
