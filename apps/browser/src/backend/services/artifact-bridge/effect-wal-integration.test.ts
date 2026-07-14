import type { McpServerConfig, McpToolDescriptor } from '@clodex/mcp-runtime';
import type {
  ArtifactBridgeContext,
  ArtifactBridgeRequest,
  ArtifactBridgeSensitiveMcpProposal,
  ArtifactBridgeWriteProposal,
} from '@shared/artifact-bridge';
import type {
  GeneratedAppIdentity,
  GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import type { TrustedMcpFinalAuthority } from '../mcp/trusted-dispatch-gateway';
import type {
  ArtifactBridgeEffectWalPersistence,
  ArtifactBridgeEffectWalRecord,
} from './effect-wal';
import { createArtifactBridgeAgentAskModelAdapterIdentity } from './effect-commitment';
import { ArtifactBridgeService, type ArtifactBridgePersistence } from './index';

const context: ArtifactBridgeContext = {
  kind: 'agent',
  agentId: 'agent-1',
  appId: 'dashboard',
};

const identity: GeneratedAppIdentity = {
  manifestSchemaVersion: 1,
  appVersion: '1.0.0',
  manifestHash: 'a'.repeat(64),
  executableHash: 'b'.repeat(64),
  assetHash: 'c'.repeat(64),
};

const automationId = '73d94ed7-cd2b-459a-b6b0-57f43e295ec7';
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
    { type: 'agent:ask', reason: 'Summarize approved data' },
    {
      type: 'automation:run',
      reason: 'Run the approved report',
      automationIds: [automationId],
    },
  ],
};

const readDescriptor: McpToolDescriptor = {
  name: 'search',
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

type EffectKind = 'write' | 'sensitive';

type TestMcpCallOptions = {
  beforeDispatch?: () => void;
  finalAuthority?: TrustedMcpFinalAuthority;
};

function passMcpFinalDispatch(options: TestMcpCallOptions | undefined): void {
  options?.beforeDispatch?.();
  options?.finalAuthority?.prepareFinalCheck();
  options?.finalAuthority?.assertAndConsume(undefined as never);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createWalProbe() {
  let store: unknown = { version: 1, records: {} };
  const persistence: ArtifactBridgeEffectWalPersistence = {
    load: async () => structuredClone(store),
    save: async (next) => {
      store = structuredClone(next);
    },
  };
  return {
    persistence,
    record(effectId: string): ArtifactBridgeEffectWalRecord | undefined {
      return structuredClone(
        (
          store as {
            records: Record<string, ArtifactBridgeEffectWalRecord>;
          }
        ).records[effectId],
      );
    },
    records(): ArtifactBridgeEffectWalRecord[] {
      return Object.values(
        (
          store as {
            records: Record<string, ArtifactBridgeEffectWalRecord>;
          }
        ).records,
      ).map((record) => structuredClone(record));
    },
  };
}

function createHarness() {
  let grantStore: unknown = { version: 5, grants: {} };
  const grantPersistence: ArtifactBridgePersistence = {
    load: async () => structuredClone(grantStore),
    save: async (next) => {
      grantStore = structuredClone(next);
    },
  };
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: (...args: any[]) => Promise<any>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
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
  const descriptors = [readDescriptor, writeDescriptor];
  let adapterBehavior: (
    beforeDispatch: (() => void) | undefined,
  ) => Promise<unknown> = async (beforeDispatch) => {
    beforeDispatch?.();
    return { ok: true };
  };
  let askBehavior: (
    beforeDispatch: (() => void) | undefined,
  ) => Promise<string> = async (beforeDispatch) => {
    beforeDispatch?.();
    return 'answer';
  };
  let automationBehavior: (
    beforeDispatch: (() => void) | undefined,
  ) => Promise<unknown> = async (beforeDispatch) => {
    beforeDispatch?.();
    return { ok: true };
  };
  let agentModelId = 'test/model';
  let currentAutomationDefinition = structuredClone(automationDefinition);
  const callTool = vi.fn(
    async (
      _serverId: string,
      _toolName: string,
      _arguments: Record<string, unknown>,
      options?: TestMcpCallOptions,
    ) => await adapterBehavior(() => passMcpFinalDispatch(options)),
  );
  const mcpRegistry = {
    snapshot: () => ({
      schemaVersion: 1,
      servers: { docs: structuredClone(server) },
    }),
    listTools: async () => structuredClone(descriptors),
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
        runtime: {
          restartCount: 0,
          catalogRevision: 0,
          configurationRevision: 0,
        },
        descriptor: structuredClone(descriptor),
      };
    },
    callTool,
  } as unknown as McpRegistryService;
  const wal = createWalProbe();

  return {
    callTool,
    wal,
    setAdapterBehavior(
      behavior: (beforeDispatch: (() => void) | undefined) => Promise<unknown>,
    ) {
      adapterBehavior = behavior;
    },
    setAskBehavior(
      behavior: (beforeDispatch: (() => void) | undefined) => Promise<string>,
    ) {
      askBehavior = behavior;
    },
    setAutomationBehavior(
      behavior: (beforeDispatch: (() => void) | undefined) => Promise<unknown>,
    ) {
      automationBehavior = behavior;
    },
    setAgentModelId(modelId: string) {
      agentModelId = modelId;
    },
    setAutomationDefinitionTitle(title: string) {
      currentAutomationDefinition = {
        ...currentAutomationDefinition,
        title,
        updatedAt: '2026-07-14T00:00:01.000Z',
      };
    },
    async createService(
      options: { setGrant?: boolean; sensitiveEgress?: boolean } = {},
    ) {
      const service = await ArtifactBridgeService.create({
        logger: { warn: vi.fn() } as unknown as Logger,
        karton,
        mcpRegistry,
        persistence: grantPersistence,
        effectWalPersistence: wal.persistence,
        isFeatureEnabled: () => true,
        areEphemeralGrantsEnabled: () => true,
        areWritesEnabled: () => true,
        isSensitiveEgressEnabled: () => options.sensitiveEgress ?? true,
        areAsyncOperationsEnabled: () => true,
        resolveAgentAskModelAdapterIdentity: () =>
          createArtifactBridgeAgentAskModelAdapterIdentity(agentModelId),
        askAgent: async (_context, _prompt, askOptions) =>
          await askBehavior(askOptions?.beforeDispatch),
        resolveAutomationDefinition: () =>
          structuredClone(currentAutomationDefinition),
        runAutomation: async (_automationId, automationOptions) =>
          await automationBehavior(() =>
            automationOptions?.beforeDispatch?.({
              automation: structuredClone(automationDefinition),
              prompt: automationDefinition.prompt,
              attempt: 1,
            }),
          ),
        resolveApp: async () => ({ identity, manifest }),
      });
      if (options.setGrant ?? true) {
        await service.setGrant({
          context,
          identity,
          capabilities: [
            'mcp:call',
            'mcp:write',
            'agent:ask',
            'automation:run',
          ],
          mcpTools: [{ serverId: 'docs', toolName: 'search' }],
          mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
          automationIds: [automationId],
          expiresAt: null,
        });
      }
      return service;
    },
  };
}

type HostBinding = Awaited<
  ReturnType<ArtifactBridgeService['openHostSession']>
>;

async function invoke(
  service: ArtifactBridgeService,
  request: ArtifactBridgeRequest,
  binding?: HostBinding,
): Promise<unknown> {
  if (!binding) return await service.invoke(context, request);
  return await service.invokeHostSession(
    context,
    request,
    binding.sessionId,
    binding.navigationEpoch,
  );
}

async function prepareAndApprove(
  service: ArtifactBridgeService,
  kind: EffectKind,
  binding?: HostBinding,
) {
  if (kind === 'write') {
    const proposal = (await invoke(
      service,
      {
        id: crypto.randomUUID(),
        method: 'prepareMcpWrite',
        params: {
          serverId: 'docs',
          toolName: 'update',
          arguments: { recordId: 'record-1', status: 'approved' },
        },
      },
      binding,
    )) as ArtifactBridgeWriteProposal;
    const approval = await service.approveWrite(
      context,
      proposal.id,
      binding?.sessionId,
    );
    return {
      proposalId: proposal.id,
      commit: async () =>
        await invoke(
          service,
          {
            id: crypto.randomUUID(),
            method: 'commitMcpWrite',
            params: {
              proposalId: proposal.id,
              commitToken: approval.commitToken,
            },
          },
          binding,
        ),
    };
  }

  const proposal = (await invoke(
    service,
    {
      id: crypto.randomUUID(),
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    },
    binding,
  )) as ArtifactBridgeSensitiveMcpProposal;
  const approval = await service.approveSensitiveMcpCall(
    context,
    proposal.id,
    binding?.sessionId,
  );
  return {
    proposalId: proposal.id,
    commit: async () =>
      await invoke(
        service,
        {
          id: crypto.randomUUID(),
          method: 'commitSensitiveMcpCall',
          params: {
            proposalId: proposal.id,
            commitToken: approval.commitToken,
            asOperation: false,
          },
        },
        binding,
      ),
  };
}

describe('ArtifactBridgeService effect WAL integration', () => {
  it.each([
    {
      name: 'direct write with an oversized result',
      kind: 'write' as const,
      result: () => ({ payload: 'x'.repeat(1_000_001) }),
    },
    {
      name: 'sensitive commit with a BigInt result',
      kind: 'sensitive' as const,
      result: () => ({ value: 1n }),
    },
  ])('records RESULT_UNAVAILABLE for $name and never redispatches', async ({
    kind,
    result,
  }) => {
    const harness = createHarness();
    harness.setAdapterBehavior(async (beforeDispatch) => {
      beforeDispatch?.();
      return result();
    });
    const service = await harness.createService();
    try {
      const prepared = await prepareAndApprove(service, kind);

      await expect(prepared.commit()).rejects.toThrow();
      expect(harness.wal.record(prepared.proposalId)?.state).toBe(
        'RESULT_UNAVAILABLE',
      );
      await expect(prepared.commit()).rejects.toThrow(/result is unavailable/i);
      expect(harness.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await service.teardown();
    }
  });

  it.each([
    { name: 'direct write', kind: 'write' as const },
    { name: 'sensitive commit', kind: 'sensitive' as const },
  ])('records UNCERTAIN when $name loses its adapter result after the final fence', async ({
    kind,
  }) => {
    const harness = createHarness();
    let finalFencePasses = 0;
    harness.setAdapterBehavior(async (beforeDispatch) => {
      beforeDispatch?.();
      finalFencePasses += 1;
      throw new Error('Adapter response was lost after effect dispatch');
    });
    const service = await harness.createService();
    try {
      const prepared = await prepareAndApprove(service, kind);

      await expect(prepared.commit()).rejects.toThrow();
      expect(finalFencePasses).toBe(1);
      expect(harness.wal.record(prepared.proposalId)?.state).toBe('UNCERTAIN');
      await expect(prepared.commit()).rejects.toThrow(/outcome is uncertain/i);
      expect(harness.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await service.teardown();
    }
  });

  it.each([
    { name: 'direct write revoked at the final fence', kind: 'write' as const },
    {
      name: 'sensitive commit whose host closes at the final fence',
      kind: 'sensitive' as const,
    },
  ])('records FAILED_PRE_EFFECT for $name and consumes the ticket', async ({
    kind,
  }) => {
    const harness = createHarness();
    const adapterEntered = deferred<void>();
    const continueToFence = deferred<void>();
    let finalFencePasses = 0;
    harness.setAdapterBehavior(async (beforeDispatch) => {
      adapterEntered.resolve();
      await continueToFence.promise;
      beforeDispatch?.();
      finalFencePasses += 1;
      return { ok: true };
    });
    const service = await harness.createService();
    try {
      const binding =
        kind === 'sensitive'
          ? await service.openHostSession(context)
          : undefined;
      const prepared = await prepareAndApprove(service, kind, binding);
      const firstCommit = prepared.commit();
      await adapterEntered.promise;

      if (binding) {
        await service.closeHostSession(
          context,
          binding.documentSlotId,
          binding.sessionId,
          binding.navigationEpoch,
        );
      } else {
        await service.revokeGrant(context);
      }
      continueToFence.resolve();

      await expect(firstCommit).rejects.toThrow();
      expect(finalFencePasses).toBe(0);
      expect(harness.wal.record(prepared.proposalId)?.state).toBe(
        'FAILED_PRE_EFFECT',
      );
      await expect(prepared.commit()).rejects.toThrow();
      expect(harness.callTool).toHaveBeenCalledTimes(1);
    } finally {
      continueToFence.resolve();
      await service.teardown();
    }
  });

  it('records RESULT_UNAVAILABLE for a direct ask result-loss and never regenerates it', async () => {
    const harness = createHarness();
    let effects = 0;
    harness.setAskBehavior(async (beforeDispatch) => {
      beforeDispatch?.();
      effects += 1;
      return 'x'.repeat(1_000_001);
    });
    const service = await harness.createService();
    const request: ArtifactBridgeRequest = {
      id: 'universal-ask-result-loss',
      method: 'askAgent',
      params: { prompt: 'Summarize the approved data.' },
    };
    try {
      await expect(invoke(service, request)).rejects.toThrow();
      expect(
        harness.wal.records().find((record) => record.kind === 'agent-ask'),
      ).toMatchObject({ state: 'RESULT_UNAVAILABLE' });
      await expect(invoke(service, request)).rejects.toThrow(
        /retry is forbidden/i,
      );
      expect(effects).toBe(1);
    } finally {
      await service.teardown();
    }
  });

  it('records UNCERTAIN for automation create-agent/message partial failure and forbids replay', async () => {
    const harness = createHarness();
    let effects = 0;
    harness.setAutomationBehavior(async (beforeDispatch) => {
      beforeDispatch?.();
      effects += 1;
      throw new Error('Agent was created but message delivery was lost');
    });
    const service = await harness.createService();
    const request: ArtifactBridgeRequest = {
      id: 'universal-automation-partial-failure',
      method: 'runAutomation',
      params: { automationId },
    };
    try {
      await expect(invoke(service, request)).rejects.toThrow();
      expect(
        harness.wal.records().find((record) => record.kind === 'automation'),
      ).toMatchObject({ state: 'UNCERTAIN' });
      await expect(invoke(service, request)).rejects.toThrow(
        /retry is forbidden/i,
      );
      expect(effects).toBe(1);
    } finally {
      await service.teardown();
    }
  });

  it('burns a direct ask when revocation wins the synchronous final fence', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    let effects = 0;
    harness.setAskBehavior(async (beforeDispatch) => {
      entered.resolve();
      await release.promise;
      beforeDispatch?.();
      effects += 1;
      return 'answer';
    });
    const service = await harness.createService();
    const request: ArtifactBridgeRequest = {
      id: 'universal-ask-revoked',
      method: 'askAgent',
      params: { prompt: 'Summarize the approved data.' },
    };
    try {
      const invocation = invoke(service, request);
      await entered.promise;
      await service.revokeGrant(context);
      release.resolve();
      await expect(invocation).rejects.toThrow();
      expect(effects).toBe(0);
      expect(
        harness.wal.records().find((record) => record.kind === 'agent-ask'),
      ).toMatchObject({ state: 'FAILED_PRE_EFFECT' });
    } finally {
      release.resolve();
      await service.teardown();
    }
  });

  it('rejects model-adapter identity drift before direct ask dispatch', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    let effects = 0;
    harness.setAskBehavior(async (beforeDispatch) => {
      entered.resolve();
      await release.promise;
      beforeDispatch?.();
      effects += 1;
      return 'answer';
    });
    const service = await harness.createService();
    try {
      const invocation = invoke(service, {
        id: 'universal-ask-model-drift',
        method: 'askAgent',
        params: { prompt: 'Summarize the approved data.' },
      });
      await entered.promise;
      harness.setAgentModelId('test/changed-model');
      release.resolve();
      await expect(invocation).rejects.toThrow();
      expect(effects).toBe(0);
      expect(
        harness.wal.records().find((record) => record.kind === 'agent-ask'),
      ).toMatchObject({ state: 'FAILED_PRE_EFFECT' });
    } finally {
      release.resolve();
      await service.teardown();
    }
  });

  it('rejects automation definition drift before the composite first effect', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const release = deferred<void>();
    let effects = 0;
    harness.setAutomationBehavior(async (beforeDispatch) => {
      entered.resolve();
      await release.promise;
      beforeDispatch?.();
      effects += 1;
      return { ok: true };
    });
    const service = await harness.createService();
    try {
      const invocation = invoke(service, {
        id: 'universal-automation-definition-drift',
        method: 'runAutomation',
        params: { automationId },
      });
      await entered.promise;
      harness.setAutomationDefinitionTitle('Changed after authorization');
      release.resolve();
      await expect(invocation).rejects.toThrow();
      expect(effects).toBe(0);
      expect(
        harness.wal.records().find((record) => record.kind === 'automation'),
      ).toMatchObject({ state: 'FAILED_PRE_EFFECT' });
    } finally {
      release.resolve();
      await service.teardown();
    }
  });

  it('recovers a crashed ordinary async MCP dispatch as UNCERTAIN without replay', async () => {
    const harness = createHarness();
    const dispatched = deferred<void>();
    const lostResult = deferred<unknown>();
    harness.setAdapterBehavior(async (beforeDispatch) => {
      beforeDispatch?.();
      dispatched.resolve();
      return await lostResult.promise;
    });
    const first = await harness.createService({ sensitiveEgress: false });
    const request: ArtifactBridgeRequest = {
      id: 'universal-async-mcp-crash',
      method: 'startMcpOperation',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    };
    const secondServices: ArtifactBridgeService[] = [];
    try {
      await invoke(first, request);
      await dispatched.promise;

      const recovered = await harness.createService({
        setGrant: false,
        sensitiveEgress: false,
      });
      secondServices.push(recovered);
      expect(
        harness.wal
          .records()
          .find((record) => record.kind === 'mcp-read-async'),
      ).toMatchObject({ state: 'UNCERTAIN' });
      await expect(invoke(recovered, request)).rejects.toThrow();
      expect(harness.callTool).toHaveBeenCalledTimes(1);
    } finally {
      lostResult.reject(new Error('Simulated process loss'));
      await Promise.resolve();
      for (const service of secondServices) await service.teardown();
      await first.teardown();
    }
  });
});
