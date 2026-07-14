import type { McpServerConfig, McpToolDescriptor } from '@clodex/mcp-runtime';
import type {
  ArtifactBridgeContext,
  ArtifactBridgeGrantInput,
  ArtifactBridgeOperationSnapshot,
} from '@shared/artifact-bridge';
import type {
  GeneratedAppIdentity,
  GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import type { TrustedMcpFinalAuthority } from '../mcp/trusted-dispatch-gateway';
import { ArtifactBridgeService, type ArtifactBridgePersistence } from './index';

const context: ArtifactBridgeContext = {
  kind: 'agent',
  agentId: 'agent-async-fence',
  appId: 'dashboard',
};

const automationId = 'd9af065d-bef7-4f3f-a348-961e40a01792';
const automationDefinition = {
  id: automationId,
  title: 'Approved report',
  prompt: 'approved automation',
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
      reason: 'Search approved documentation',
      tools: [{ serverId: 'docs', toolName: 'search' }],
    },
    {
      type: 'automation:run',
      reason: 'Run an approved report',
      automationIds: [automationId],
    },
  ],
};

const descriptor: McpToolDescriptor = {
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
  policy: { default: 'allow-read-only', tools: {} },
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

type McpCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  agentInstanceId?: string;
  beforeDispatch?: () => void;
  finalAuthority?: TrustedMcpFinalAuthority;
};

function passMcpFinalDispatch(options: McpCallOptions | undefined): void {
  options?.beforeDispatch?.();
  options?.finalAuthority?.prepareFinalCheck();
  options?.finalAuthority?.assertAndConsume(undefined as never);
}

type AutomationRunOptions = {
  beforeDispatch?: (input: {
    automation: unknown;
    prompt: string;
    attempt: number;
  }) => void;
  retryMode?: 'configured' | 'no-blind-retry';
  failureMode?: 'record' | 'propagate';
};

function createHarness() {
  let store: unknown = { version: 5, grants: {} };
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: (...args: any[]) => Promise<any>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  const persistence: ArtifactBridgePersistence = {
    load: async () => structuredClone(store),
    save: async (value) => {
      store = structuredClone(value);
    },
  };

  const mcpEffect = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const callTool = vi.fn(
    async (
      _serverId: string,
      _toolName: string,
      _arguments: Record<string, unknown>,
      options?: McpCallOptions,
    ) => {
      passMcpFinalDispatch(options);
      return await mcpEffect();
    },
  );
  const mcpRegistry = {
    snapshot: () => ({
      schemaVersion: 1,
      servers: { docs: structuredClone(server) },
    }),
    listTools: vi.fn(async () => [structuredClone(descriptor)]),
    getToolDispatchSnapshot: (serverId: string, toolName: string) => {
      if (serverId !== server.id || toolName !== descriptor.name) {
        throw new Error('Unknown MCP dispatch target');
      }
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

  const automationEffect = vi.fn(async () => ({ ok: true }));
  const runAutomation = vi.fn(
    async (requestedAutomationId: string, options?: AutomationRunOptions) => {
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

  return {
    karton,
    persistence,
    mcpRegistry,
    mcpEffect,
    callTool,
    automationEffect,
    runAutomation,
    resolveAutomationDefinition: vi.fn(() =>
      structuredClone(automationDefinition),
    ),
    resolveApp: vi.fn(async () => ({ identity, manifest })),
  };
}

type Harness = ReturnType<typeof createHarness>;

async function createService(
  harness: Harness,
  options: {
    sensitive?: boolean | (() => boolean);
    asyncOperations?: boolean | (() => boolean);
  } = {},
) {
  const sensitiveOption = options.sensitive;
  const sensitiveEnabled =
    typeof sensitiveOption === 'function'
      ? sensitiveOption
      : () => sensitiveOption ?? false;
  const asyncOperationsOption = options.asyncOperations;
  const asyncOperationsEnabled =
    typeof asyncOperationsOption === 'function'
      ? asyncOperationsOption
      : () => asyncOperationsOption ?? true;
  return await ArtifactBridgeService.create({
    logger: { warn: vi.fn() } as unknown as Logger,
    karton: harness.karton,
    mcpRegistry: harness.mcpRegistry,
    persistence: harness.persistence,
    isFeatureEnabled: () => true,
    areAsyncOperationsEnabled: asyncOperationsEnabled,
    isRuntimeInspectorEnabled: () => true,
    isSensitiveEgressEnabled: sensitiveEnabled,
    askAgent: vi.fn(async () => 'answer'),
    runAutomation: harness.runAutomation,
    resolveAutomationDefinition: harness.resolveAutomationDefinition,
    resolveApp: harness.resolveApp,
  });
}

function grantInput(
  capabilities: ArtifactBridgeGrantInput['capabilities'],
): ArtifactBridgeGrantInput {
  return {
    context,
    scope: { kind: 'persistent' },
    identity,
    capabilities,
    mcpTools: capabilities.includes('mcp:call')
      ? [{ serverId: 'docs', toolName: 'search' }]
      : [],
    mcpWriteTools: [],
    automationIds: capabilities.includes('automation:run')
      ? [automationId]
      : [],
    expiresAt: null,
  };
}

async function startMcpOperation(service: ArtifactBridgeService) {
  return (await service.invoke(context, {
    id: 'start-mcp-operation',
    method: 'startMcpOperation',
    params: {
      serverId: 'docs',
      toolName: 'search',
      arguments: { query: 'dispatch fence' },
      timeoutMs: 1_000,
    },
  })) as ArtifactBridgeOperationSnapshot;
}

async function startAutomationOperation(service: ArtifactBridgeService) {
  return (await service.invoke(context, {
    id: 'start-automation-operation',
    method: 'startAutomationOperation',
    params: { automationId, timeoutMs: 1_000 },
  })) as ArtifactBridgeOperationSnapshot;
}

async function getOperation(
  service: ArtifactBridgeService,
  operationId: string,
) {
  return (await service.invoke(context, {
    id: `get-${operationId}`,
    method: 'getOperation',
    params: { operationId },
  })) as ArtifactBridgeOperationSnapshot;
}

async function flushBackgroundOperation() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForOperationStatus(
  service: ArtifactBridgeService,
  operationId: string,
  status: ArtifactBridgeOperationSnapshot['status'],
) {
  await vi.waitFor(async () => {
    const inspector = await service.getRuntimeInspector(context);
    expect(inspector.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: operationId, status }),
      ]),
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ArtifactBridge async final-dispatch fence', () => {
  it('blocks an MCP operation when the async kill switch turns off before final dispatch', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    let asyncEnabled = true;
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        entered.resolve();
        try {
          await releaseFinalCallback.promise;
          passMcpFinalDispatch(options);
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness, {
      asyncOperations: () => asyncEnabled,
    });
    await service.setGrant(grantInput(['mcp:call']));

    const operation = await startMcpOperation(service);
    await entered.promise;
    asyncEnabled = false;
    releaseFinalCallback.resolve();
    await settled.promise;
    await waitForOperationStatus(service, operation.id, 'failed');
    expect(harness.mcpEffect).not.toHaveBeenCalled();

    asyncEnabled = true;
    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'failed',
    });
    await service.teardown();
  });

  it('blocks an automation operation when the async kill switch turns off before final dispatch', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    let asyncEnabled = true;
    harness.runAutomation.mockImplementationOnce(
      async (requestedAutomationId, options?: AutomationRunOptions) => {
        entered.resolve();
        try {
          await releaseFinalCallback.promise;
          options?.beforeDispatch?.({
            automation: {
              ...structuredClone(automationDefinition),
              id: requestedAutomationId,
            },
            prompt: automationDefinition.prompt,
            attempt: 1,
          });
          return await harness.automationEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness, {
      asyncOperations: () => asyncEnabled,
    });
    await service.setGrant(grantInput(['automation:run']));

    const operation = await startAutomationOperation(service);
    await entered.promise;
    asyncEnabled = false;
    releaseFinalCallback.resolve();
    await settled.promise;
    await waitForOperationStatus(service, operation.id, 'failed');
    expect(harness.automationEffect).not.toHaveBeenCalled();

    asyncEnabled = true;
    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'failed',
    });
    await service.teardown();
  });

  it('blocks an approved sensitive effect when its gate turns off before final dispatch', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    let sensitiveEnabled = true;
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        entered.resolve();
        await releaseFinalCallback.promise;
        passMcpFinalDispatch(options);
        return await harness.mcpEffect();
      },
    );
    const service = await createService(harness, {
      sensitive: () => sensitiveEnabled,
    });
    await service.setGrant(grantInput(['mcp:call']));
    const proposal = (await service.invoke(context, {
      id: 'prepare-sensitive-kill-switch',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'approved sensitive request' },
      },
    })) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      proposal.id,
    );

    const commit = service.invoke(context, {
      id: 'commit-sensitive-kill-switch',
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: false,
      },
    });
    await entered.promise;
    sensitiveEnabled = false;
    releaseFinalCallback.resolve();

    await expect(commit).rejects.toThrow('sensitive details withheld');
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('invalidates an ordinary MCP commitment when sensitive enforcement turns on before dispatch', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    let sensitiveEnabled = false;
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        entered.resolve();
        await releaseFinalCallback.promise;
        passMcpFinalDispatch(options);
        return await harness.mcpEffect();
      },
    );
    const service = await createService(harness, {
      sensitive: () => sensitiveEnabled,
    });
    await service.setGrant(grantInput(['mcp:call']));

    const call = service.invoke(context, {
      id: 'ordinary-sensitive-profile-drift',
      method: 'callMcpTool',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'profile drift' },
      },
    });
    await entered.promise;
    sensitiveEnabled = true;
    releaseFinalCallback.resolve();

    await expect(call).rejects.toThrow('sensitive details withheld');
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('times out before the MCP final callback without entering the adapter effect', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        entered.resolve();
        try {
          await releaseFinalCallback.promise;
          passMcpFinalDispatch(options);
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:call']));

    const operation = await startMcpOperation(service);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'timed-out',
      cancellable: false,
    });
    releaseFinalCallback.resolve();
    await settled.promise;
    await flushBackgroundOperation();
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('reports MCP timeout after final dispatch as uncertain when the adapter ignores abort', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const afterFinalCallback = deferred<void>();
    const releaseEffect = deferred<{
      content: { type: string; text: string }[];
    }>();
    const settled = deferred<void>();
    harness.mcpEffect.mockImplementationOnce(
      async () => await releaseEffect.promise,
    );
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        try {
          passMcpFinalDispatch(options);
          afterFinalCallback.resolve();
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:call']));

    const operation = await startMcpOperation(service);
    await afterFinalCallback.promise;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'uncertain',
      cancellable: false,
      error: expect.stringContaining('outcome is uncertain'),
    });
    await expect(
      service.invoke(context, {
        id: 'uncertain-timeout-result',
        method: 'getOperationResult',
        params: { operationId: operation.id },
      }),
    ).rejects.toThrow('outcome is uncertain; retry is forbidden');
    expect(harness.mcpEffect).toHaveBeenCalledTimes(1);

    releaseEffect.resolve({ content: [{ type: 'text', text: 'late' }] });
    await settled.promise;
    await flushBackgroundOperation();
    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'uncertain',
    });
    await service.teardown();
  });

  it('cancels before the MCP final callback and prevents the adapter effect', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        entered.resolve();
        try {
          await releaseFinalCallback.promise;
          passMcpFinalDispatch(options);
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:call']));

    const operation = await startMcpOperation(service);
    await entered.promise;
    await expect(
      service.invoke(context, {
        id: 'cancel-before-final',
        method: 'cancelOperation',
        params: { operationId: operation.id },
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });

    releaseFinalCallback.resolve();
    await settled.promise;
    await flushBackgroundOperation();
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('reports cancellation after MCP final dispatch as uncertain', async () => {
    const harness = createHarness();
    const afterFinalCallback = deferred<void>();
    const releaseEffect = deferred<{
      content: { type: string; text: string }[];
    }>();
    const settled = deferred<void>();
    harness.mcpEffect.mockImplementationOnce(
      async () => await releaseEffect.promise,
    );
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        try {
          passMcpFinalDispatch(options);
          afterFinalCallback.resolve();
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:call']));

    const operation = await startMcpOperation(service);
    await afterFinalCallback.promise;
    await expect(
      service.invoke(context, {
        id: 'cancel-after-final',
        method: 'cancelOperation',
        params: { operationId: operation.id },
      }),
    ).resolves.toMatchObject({ status: 'uncertain' });
    expect(harness.mcpEffect).toHaveBeenCalledTimes(1);

    releaseEffect.resolve({ content: [{ type: 'text', text: 'late' }] });
    await settled.promise;
    await flushBackgroundOperation();
    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'uncertain',
    });
    await service.teardown();
  });

  it('revokes before the MCP final callback, removes the operation, and prevents dispatch', async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        entered.resolve();
        try {
          await releaseFinalCallback.promise;
          passMcpFinalDispatch(options);
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['mcp:call']));

    const operation = await startMcpOperation(service);
    await entered.promise;
    await service.revokeGrant(context);
    releaseFinalCallback.resolve();
    await settled.promise;
    await flushBackgroundOperation();

    const inspector = await service.getRuntimeInspector(context);
    expect(inspector.operations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: operation.id })]),
    );
    expect(harness.mcpEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('times out before the automation final callback without dispatching it', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const entered = deferred<void>();
    const releaseFinalCallback = deferred<void>();
    const settled = deferred<void>();
    harness.runAutomation.mockImplementationOnce(
      async (requestedAutomationId, options?: AutomationRunOptions) => {
        entered.resolve();
        try {
          await releaseFinalCallback.promise;
          options?.beforeDispatch?.({
            automation: {
              ...structuredClone(automationDefinition),
              id: requestedAutomationId,
            },
            prompt: automationDefinition.prompt,
            attempt: 1,
          });
          return await harness.automationEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['automation:run']));

    const operation = await startAutomationOperation(service);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'timed-out',
    });
    releaseFinalCallback.resolve();
    await settled.promise;
    await flushBackgroundOperation();
    expect(harness.automationEffect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('reports automation timeout after final dispatch as uncertain', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const afterFinalCallback = deferred<void>();
    const releaseEffect = deferred<{ ok: boolean }>();
    const settled = deferred<void>();
    harness.automationEffect.mockImplementationOnce(
      async () => await releaseEffect.promise,
    );
    harness.runAutomation.mockImplementationOnce(
      async (requestedAutomationId, options?: AutomationRunOptions) => {
        try {
          options?.beforeDispatch?.({
            automation: {
              ...structuredClone(automationDefinition),
              id: requestedAutomationId,
            },
            prompt: automationDefinition.prompt,
            attempt: 1,
          });
          afterFinalCallback.resolve();
          return await harness.automationEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness);
    await service.setGrant(grantInput(['automation:run']));

    const operation = await startAutomationOperation(service);
    await afterFinalCallback.promise;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'uncertain',
      error: expect.stringContaining('outcome is uncertain'),
    });
    expect(harness.automationEffect).toHaveBeenCalledTimes(1);

    releaseEffect.resolve({ ok: true });
    await settled.promise;
    await flushBackgroundOperation();
    await expect(getOperation(service, operation.id)).resolves.toMatchObject({
      status: 'uncertain',
    });
    await service.teardown();
  });

  it('retains uncertain evidence when a sensitive async MCP grant is revoked after final dispatch', async () => {
    const harness = createHarness();
    const afterFinalCallback = deferred<void>();
    const releaseEffect = deferred<{
      content: { type: string; text: string }[];
    }>();
    const settled = deferred<void>();
    harness.mcpEffect.mockImplementationOnce(
      async () => await releaseEffect.promise,
    );
    harness.callTool.mockImplementationOnce(
      async (_serverId, _toolName, _arguments, options?: McpCallOptions) => {
        try {
          passMcpFinalDispatch(options);
          afterFinalCallback.resolve();
          return await harness.mcpEffect();
        } finally {
          settled.resolve();
        }
      },
    );
    const service = await createService(harness, { sensitive: true });
    await service.setGrant(grantInput(['mcp:call']));
    const proposal = (await service.invoke(context, {
      id: 'prepare-sensitive-operation',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'sensitive dispatch fence' },
      },
    })) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      proposal.id,
    );
    const operation = (await service.invoke(context, {
      id: 'start-sensitive-operation',
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: true,
        timeoutMs: 1_000,
      },
    })) as ArtifactBridgeOperationSnapshot;

    await afterFinalCallback.promise;
    await service.revokeGrant(context);
    const inspector = await service.getRuntimeInspector(context);
    expect(inspector.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: operation.id,
          status: 'uncertain',
          error: expect.stringContaining('outcome is uncertain'),
        }),
      ]),
    );
    expect(harness.mcpEffect).toHaveBeenCalledTimes(1);

    releaseEffect.resolve({ content: [{ type: 'text', text: 'late' }] });
    await settled.promise;
    await flushBackgroundOperation();
    const finalInspector = await service.getRuntimeInspector(context);
    expect(finalInspector.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: operation.id, status: 'uncertain' }),
      ]),
    );
    await service.teardown();
  });
});
