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
import type {
  ArtifactBridgeEffectWalPersistence,
  ArtifactBridgeEffectWalRecord,
} from './effect-wal';
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
  const callTool = vi.fn(
    async (
      _serverId: string,
      _toolName: string,
      _arguments: Record<string, unknown>,
      options?: { beforeDispatch?: () => void },
    ) => await adapterBehavior(options?.beforeDispatch),
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
    async createService() {
      const service = await ArtifactBridgeService.create({
        logger: { warn: vi.fn() } as unknown as Logger,
        karton,
        mcpRegistry,
        persistence: grantPersistence,
        effectWalPersistence: wal.persistence,
        isFeatureEnabled: () => true,
        areEphemeralGrantsEnabled: () => true,
        areWritesEnabled: () => true,
        isSensitiveEgressEnabled: () => true,
        askAgent: async () => 'unused',
        runAutomation: async () => ({ unused: true }),
        resolveApp: async () => ({ identity, manifest }),
      });
      await service.setGrant({
        context,
        identity,
        capabilities: ['mcp:call', 'mcp:write'],
        mcpTools: [{ serverId: 'docs', toolName: 'search' }],
        mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
        automationIds: [],
        expiresAt: null,
      });
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
});
