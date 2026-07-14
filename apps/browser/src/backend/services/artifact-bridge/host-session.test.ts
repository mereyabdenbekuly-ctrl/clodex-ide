import type {
  ArtifactBridgeContext,
  ArtifactBridgeLifecycleEvent,
} from '@shared/artifact-bridge';
import type {
  GeneratedAppIdentity,
  GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import { ArtifactBridgeService, type ArtifactBridgePersistence } from './index';

const context: ArtifactBridgeContext = {
  kind: 'agent',
  agentId: 'agent-1',
  appId: 'dashboard',
};

const askRequest = {
  id: 'host-session-ask',
  method: 'askAgent' as const,
  params: { prompt: 'Summarize the dashboard.' },
};

type HarnessFeatures = {
  writes?: boolean;
  sensitiveEgress?: boolean;
  asyncOperations?: boolean;
  lifecycleEvents?: boolean;
};

function createHarness(
  isFeatureEnabled: () => boolean = () => true,
  features: HarnessFeatures = {},
) {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: (...args: any[]) => Promise<any>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  const persistence: ArtifactBridgePersistence = {
    load: async () => ({ version: 5, grants: {} }),
    save: async () => undefined,
  };
  const readTool = {
    name: 'search',
    description: 'Search documentation',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const writeTool = {
    name: 'update',
    description: 'Update a record',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, destructiveHint: true },
  };
  const listTools = vi.fn(async () => [readTool, writeTool]);
  const hostCallTool = vi.fn(
    async (
      _serverId: string,
      _toolName: string,
      _args: Record<string, unknown>,
    ) => ({ ok: true }),
  );
  const callTool = vi.fn(
    async (
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
      options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
        agentInstanceId?: string;
        beforeDispatch?: () => void;
      },
    ) => {
      options?.beforeDispatch?.();
      return await hostCallTool(serverId, toolName, args);
    },
  );
  const mcpRegistry = {
    snapshot: () => ({
      schemaVersion: 1,
      servers: {
        docs: {
          id: 'docs',
          displayName: 'Docs',
          enabled: true,
          source: { kind: 'builtin', builtinId: 'docs' },
          transport: { type: 'streamable-http', url: 'https://example.com' },
          policy: { default: 'allow-read-only', tools: {} },
        },
      },
    }),
    listTools,
    getToolDispatchSnapshot: (serverId: string, toolName: string) => ({
      server: {
        id: serverId,
        displayName: 'Docs',
        enabled: true,
        source: { kind: 'builtin', builtinId: 'docs' },
        transport: {
          type: 'streamable-http',
          url: 'https://example.com',
        },
        policy: { default: 'allow-read-only', tools: {} },
      },
      runtime: {
        restartCount: 0,
        catalogRevision: 0,
        configurationRevision: 0,
      },
      descriptor: structuredClone(
        [readTool, writeTool].find((tool) => tool.name === toolName),
      ),
    }),
    callTool,
  } as unknown as McpRegistryService;
  const askAgent = vi.fn(async () => 'bounded answer');
  const runAutomation = vi.fn(async () => ({ ok: true }));
  const emitLifecycleEvent = vi.fn(
    async (_event: ArtifactBridgeLifecycleEvent) => undefined,
  );
  const automationId = '1cbd31a0-af7b-4b5a-948d-e782dea80d82';
  const identity = {
    manifestSchemaVersion: 1 as const,
    appVersion: '1.0.0',
    manifestHash: 'a'.repeat(64),
    executableHash: 'b'.repeat(64),
    assetHash: 'c'.repeat(64),
  };
  const manifest = {
    schemaVersion: 1 as const,
    id: 'dashboard',
    name: 'Dashboard',
    version: '1.0.0',
    entrypoint: 'index.html' as const,
    capabilities: [
      {
        type: 'mcp:call' as const,
        reason: 'Search documentation',
        tools: [{ serverId: 'docs', toolName: 'search' }],
      },
      {
        type: 'agent:ask' as const,
        reason: 'Summarize dashboard data',
      },
      {
        type: 'mcp:write' as const,
        reason: 'Update the selected record',
        tools: [{ serverId: 'docs', toolName: 'update' }],
      },
      {
        type: 'automation:run' as const,
        reason: 'Run the approved report',
        automationIds: [automationId],
      },
    ],
  };
  const resolveApp = vi.fn(
    async (
      requestedContext: ArtifactBridgeContext,
    ): Promise<{
      identity: GeneratedAppIdentity;
      manifest: GeneratedAppManifest;
    } | null> => ({
      identity,
      manifest: { ...manifest, id: requestedContext.appId },
    }),
  );

  return {
    askAgent,
    automationId,
    callTool,
    emitLifecycleEvent,
    hostCallTool,
    identity,
    karton,
    listTools,
    manifest,
    mcpRegistry,
    persistence,
    readTool,
    resolveApp,
    runAutomation,
    writeTool,
    async createService() {
      return await ArtifactBridgeService.create({
        logger: { warn: vi.fn() } as unknown as Logger,
        karton,
        mcpRegistry,
        persistence,
        isFeatureEnabled,
        areEphemeralGrantsEnabled: () => true,
        areWritesEnabled: () => features.writes ?? false,
        isSensitiveEgressEnabled: () => features.sensitiveEgress ?? false,
        areAsyncOperationsEnabled: () => features.asyncOperations ?? false,
        areLifecycleEventsEnabled: () => features.lifecycleEvents ?? false,
        emitLifecycleEvent,
        askAgent,
        runAutomation,
        resolveApp,
      });
    },
  };
}

describe('ArtifactBridgeService host-issued sessions', () => {
  it('issues independent document slots for concurrent same-context previews', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const legacySessionId = crypto.randomUUID();
    expect(service.registerSession(context, legacySessionId)).toBe(true);

    const first = await service.openHostSession(context);
    const second = await service.openHostSession(context);
    const otherContext = { ...context, appId: 'other-app' };
    const other = await service.openHostSession(otherContext);

    expect(first.documentSlotId).not.toBe(second.documentSlotId);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.navigationEpoch).toBe(1);
    expect(second.navigationEpoch).toBe(1);
    expect(other.navigationEpoch).toBe(1);
    expect(first.assetHash).toBe(harness.identity.assetHash);
    expect(first.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      service.getActiveSessions(context).map((session) => session.sessionId),
    ).toEqual(
      expect.arrayContaining([
        legacySessionId,
        first.sessionId,
        second.sessionId,
      ]),
    );
    await expect(
      service.invokeHostSession(
        context,
        { id: 'first-slot', method: 'getCapabilities', params: {} },
        first.sessionId,
        first.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      service.invokeHostSession(
        context,
        { id: 'second-slot', method: 'getCapabilities', params: {} },
        second.sessionId,
        second.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await service.teardown();
  });

  it('fails closed on context, ID, or epoch mismatch before resolver and effects', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    harness.resolveApp.mockClear();

    await expect(
      service.invokeHostSession(
        { ...context, appId: 'other-app' },
        askRequest,
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.invokeHostSession(
        context,
        askRequest,
        crypto.randomUUID(),
        binding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.invokeHostSession(
        context,
        askRequest,
        binding.sessionId,
        binding.navigationEpoch + 1,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');

    expect(harness.resolveApp).not.toHaveBeenCalled();
    expect(harness.listTools).not.toHaveBeenCalled();
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.askAgent).not.toHaveBeenCalled();
    expect(harness.runAutomation).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('denies invocation after the exact host binding is closed', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);

    await service.closeHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );

    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'after-close',
          method: 'getCapabilities',
          params: {},
        },
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.openHostSession(context, binding.documentSlotId),
    ).rejects.toThrow('document slot is inactive or mismatched');
    await service.teardown();
  });

  it('suspends effect authority while retaining an exact rotatable slot', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);

    await service.suspendHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );

    await expect(
      service.invokeHostSession(
        context,
        { id: 'after-suspend', method: 'getCapabilities', params: {} },
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    const rotated = await service.openHostSession(
      context,
      binding.documentSlotId,
    );
    expect(rotated.navigationEpoch).toBe(binding.navigationEpoch + 1);
    await expect(
      service.closeHostSession(
        context,
        binding.documentSlotId,
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await service.closeHostSession(
      context,
      rotated.documentSlotId,
      rotated.sessionId,
      rotated.navigationEpoch,
    );
    await service.teardown();
  });

  it('rotates only one document slot and rejects stale or cross-slot close attempts', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const oldBinding = await service.openHostSession(context);
    const otherBinding = await service.openHostSession(context);
    const activeBinding = await service.openHostSession(
      context,
      oldBinding.documentSlotId,
    );

    expect(activeBinding.documentSlotId).toBe(oldBinding.documentSlotId);
    expect(activeBinding.navigationEpoch).toBe(oldBinding.navigationEpoch + 1);

    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'stale-invoke',
          method: 'getCapabilities',
          params: {},
        },
        oldBinding.sessionId,
        oldBinding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.closeHostSession(
        context,
        oldBinding.documentSlotId,
        oldBinding.sessionId,
        oldBinding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.closeHostSession(
        context,
        otherBinding.documentSlotId,
        activeBinding.sessionId,
        activeBinding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.closeHostSession(
        { ...context, appId: 'other-app' },
        activeBinding.documentSlotId,
        activeBinding.sessionId,
        activeBinding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'active-invoke',
          method: 'getCapabilities',
          params: {},
        },
        activeBinding.sessionId,
        activeBinding.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'other-slot-active',
          method: 'getCapabilities',
          params: {},
        },
        otherBinding.sessionId,
        otherBinding.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await service.teardown();
  });

  it('rejects unknown or cross-context document-slot rotation', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);

    await expect(
      service.openHostSession(context, crypto.randomUUID()),
    ).rejects.toThrow('document slot is inactive or mismatched');
    await expect(service.openHostSession(context, '')).rejects.toThrow();
    await expect(
      service.openHostSession(
        { ...context, appId: 'other-app' },
        binding.documentSlotId,
      ),
    ).rejects.toThrow('document slot is inactive or mismatched');
    await expect(
      service.invokeHostSession(
        context,
        { id: 'still-active', method: 'getCapabilities', params: {} },
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await service.teardown();
  });

  it('keeps the old binding exact-closeable when rotation identity resolution fails', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    harness.resolveApp.mockResolvedValueOnce(null);

    await expect(
      service.openHostSession(context, binding.documentSlotId),
    ).rejects.toThrow(
      'must resolve to a valid identity before a host session can open',
    );
    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'old-binding-after-failed-rotation',
          method: 'getCapabilities',
          params: {},
        },
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });

    await expect(
      service.closeHostSession(
        context,
        binding.documentSlotId,
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.openHostSession(context, binding.documentSlotId),
    ).rejects.toThrow('document slot is inactive or mismatched');
    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'closed-after-failed-rotation',
          method: 'getCapabilities',
          params: {},
        },
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await service.teardown();
  });

  it('creates no session while gated off but still permits exact safe close after gate-off', async () => {
    let enabled = false;
    const harness = createHarness(() => enabled);
    const service = await harness.createService();

    await expect(service.openHostSession(context)).rejects.toThrow(
      'capability bridge is disabled',
    );
    enabled = true;
    const first = await service.openHostSession(context);

    expect(first.navigationEpoch).toBe(1);
    enabled = false;
    await expect(
      service.closeHostSession(
        context,
        first.documentSlotId,
        first.sessionId,
        first.navigationEpoch,
      ),
    ).resolves.toBeUndefined();
    enabled = true;
    await expect(
      service.invokeHostSession(
        context,
        { id: 'closed-after-gate-off', method: 'getCapabilities', params: {} },
        first.sessionId,
        first.navigationEpoch,
      ),
    ).rejects.toThrow('session binding is inactive or mismatched');
    await service.teardown();
  });

  it('blocks a stale effect when the exact session suspends during grant identity resolution', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    let releaseGrantResolution!: () => void;
    const grantResolution = new Promise<void>((resolve) => {
      releaseGrantResolution = resolve;
    });
    let markGrantResolutionStarted!: () => void;
    const grantResolutionStarted = new Promise<void>((resolve) => {
      markGrantResolutionStarted = resolve;
    });
    const resolvedApp = {
      identity: harness.identity,
      manifest: harness.manifest,
    };
    harness.resolveApp.mockClear();
    harness.resolveApp
      .mockResolvedValue(resolvedApp)
      .mockResolvedValueOnce(resolvedApp)
      .mockImplementationOnce(async () => {
        markGrantResolutionStarted();
        await grantResolution;
        return resolvedApp;
      });

    const invocation = service.invokeHostSession(
      context,
      askRequest,
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedInvocation = expect(invocation).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await grantResolutionStarted;
    await service.suspendHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    releaseGrantResolution();

    await deniedInvocation;
    expect(harness.askAgent).not.toHaveBeenCalled();
    await service.closeHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    await service.teardown();
  });

  it('blocks MCP dispatch when the exact session suspends during descriptor lookup', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    let releaseDescriptorLookup!: () => void;
    const descriptorLookup = new Promise<void>((resolve) => {
      releaseDescriptorLookup = resolve;
    });
    let markDescriptorLookupStarted!: () => void;
    const descriptorLookupStarted = new Promise<void>((resolve) => {
      markDescriptorLookupStarted = resolve;
    });
    harness.listTools.mockImplementationOnce(async () => {
      markDescriptorLookupStarted();
      await descriptorLookup;
      return [harness.readTool];
    });

    const invocation = service.invokeHostSession(
      context,
      {
        id: 'host-session-mcp',
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'session fence' },
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedInvocation = expect(invocation).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await descriptorLookupStarted;
    await service.suspendHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    releaseDescriptorLookup();

    await deniedInvocation;
    expect(harness.callTool).not.toHaveBeenCalled();
    await service.closeHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    await service.teardown();
  });

  it('blocks a stale effect when same-slot rotation wins during grant identity resolution', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    let releaseGrantResolution!: () => void;
    const grantResolution = new Promise<void>((resolve) => {
      releaseGrantResolution = resolve;
    });
    let markGrantResolutionStarted!: () => void;
    const grantResolutionStarted = new Promise<void>((resolve) => {
      markGrantResolutionStarted = resolve;
    });
    const resolvedApp = {
      identity: harness.identity,
      manifest: harness.manifest,
    };
    harness.resolveApp.mockClear();
    harness.resolveApp
      .mockResolvedValue(resolvedApp)
      .mockResolvedValueOnce(resolvedApp)
      .mockImplementationOnce(async () => {
        markGrantResolutionStarted();
        await grantResolution;
        return resolvedApp;
      });

    const invocation = service.invokeHostSession(
      context,
      askRequest,
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedInvocation = expect(invocation).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await grantResolutionStarted;
    const rotated = await service.openHostSession(
      context,
      binding.documentSlotId,
    );
    releaseGrantResolution();

    await deniedInvocation;
    expect(harness.askAgent).not.toHaveBeenCalled();
    await expect(
      service.invokeHostSession(
        context,
        { id: 'rotated-session', method: 'getCapabilities', params: {} },
        rotated.sessionId,
        rotated.navigationEpoch,
      ),
    ).resolves.toMatchObject({ version: 2 });
    await service.teardown();
  });

  it('blocks a reviewed sensitive call when suspension wins during commit descriptor lookup', async () => {
    const harness = createHarness(() => true, { sensitiveEgress: true });
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invokeHostSession(
      context,
      {
        id: 'host-sensitive-prepare',
        method: 'prepareSensitiveMcpCall',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'generation fence' },
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    )) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      proposal.id,
      binding.sessionId,
    );

    let releaseDescriptorLookup!: () => void;
    const descriptorLookup = new Promise<void>((resolve) => {
      releaseDescriptorLookup = resolve;
    });
    let markDescriptorLookupStarted!: () => void;
    const descriptorLookupStarted = new Promise<void>((resolve) => {
      markDescriptorLookupStarted = resolve;
    });
    harness.listTools.mockImplementationOnce(async () => {
      markDescriptorLookupStarted();
      await descriptorLookup;
      return [harness.readTool];
    });

    const commit = service.invokeHostSession(
      context,
      {
        id: 'host-sensitive-commit',
        method: 'commitSensitiveMcpCall',
        params: {
          proposalId: approval.proposal.id,
          commitToken: approval.commitToken,
          asOperation: false,
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedCommit = expect(commit).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await descriptorLookupStarted;
    await service.suspendHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    releaseDescriptorLookup();

    await deniedCommit;
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.hostCallTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('blocks a reviewed write when same-slot rotation wins during commit descriptor lookup', async () => {
    const harness = createHarness(() => true, { writes: true });
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invokeHostSession(
      context,
      {
        id: 'host-write-prepare',
        method: 'prepareMcpWrite',
        params: {
          serverId: 'docs',
          toolName: 'update',
          arguments: { recordId: 'record-1' },
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    )) as { id: string };
    const approval = await service.approveWrite(
      context,
      proposal.id,
      binding.sessionId,
    );

    let releaseDescriptorLookup!: () => void;
    const descriptorLookup = new Promise<void>((resolve) => {
      releaseDescriptorLookup = resolve;
    });
    let markDescriptorLookupStarted!: () => void;
    const descriptorLookupStarted = new Promise<void>((resolve) => {
      markDescriptorLookupStarted = resolve;
    });
    harness.listTools.mockImplementationOnce(async () => {
      markDescriptorLookupStarted();
      await descriptorLookup;
      return [harness.writeTool];
    });

    const commit = service.invokeHostSession(
      context,
      {
        id: 'host-write-commit',
        method: 'commitMcpWrite',
        params: {
          proposalId: approval.proposal.id,
          commitToken: approval.commitToken,
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedCommit = expect(commit).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await descriptorLookupStarted;
    await service.openHostSession(context, binding.documentSlotId);
    releaseDescriptorLookup();

    await deniedCommit;
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.hostCallTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('blocks a running automation operation after suspension during its lifecycle await', async () => {
    const harness = createHarness(() => true, {
      asyncOperations: true,
      lifecycleEvents: true,
    });
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['automation:run'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [harness.automationId],
      expiresAt: null,
    });

    let releaseRunningEvent!: () => void;
    const runningEvent = new Promise<void>((resolve) => {
      releaseRunningEvent = resolve;
    });
    let markRunningEventStarted!: () => void;
    const runningEventStarted = new Promise<void>((resolve) => {
      markRunningEventStarted = resolve;
    });
    let markRunningEventFinished!: () => void;
    const runningEventFinished = new Promise<void>((resolve) => {
      markRunningEventFinished = resolve;
    });
    harness.emitLifecycleEvent.mockImplementation(async (event) => {
      if (
        event.type === 'operationChanged' &&
        event.operation.status === 'running'
      ) {
        markRunningEventStarted();
        await runningEvent;
        markRunningEventFinished();
      }
    });

    await expect(
      service.invokeHostSession(
        context,
        {
          id: 'host-automation-operation',
          method: 'startAutomationOperation',
          params: { automationId: harness.automationId },
        },
        binding.sessionId,
        binding.navigationEpoch,
      ),
    ).resolves.toMatchObject({ status: 'queued' });
    await runningEventStarted;
    await service.suspendHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    releaseRunningEvent();
    await runningEventFinished;
    await Promise.resolve();

    expect(harness.runAutomation).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('does not queue an MCP operation when same-slot rotation wins during the queued lifecycle await', async () => {
    const harness = createHarness(() => true, {
      asyncOperations: true,
      lifecycleEvents: true,
    });
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    let releaseQueuedEvent!: () => void;
    const queuedEvent = new Promise<void>((resolve) => {
      releaseQueuedEvent = resolve;
    });
    let markQueuedEventStarted!: () => void;
    const queuedEventStarted = new Promise<void>((resolve) => {
      markQueuedEventStarted = resolve;
    });
    harness.emitLifecycleEvent.mockImplementation(async (event) => {
      if (
        event.type === 'operationChanged' &&
        event.operation.status === 'queued'
      ) {
        markQueuedEventStarted();
        await queuedEvent;
      }
    });

    const invocation = service.invokeHostSession(
      context,
      {
        id: 'host-mcp-operation',
        method: 'startMcpOperation',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'queued generation fence' },
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedInvocation = expect(invocation).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await queuedEventStarted;
    await service.openHostSession(context, binding.documentSlotId);
    releaseQueuedEvent();

    await deniedInvocation;
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.hostCallTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('rechecks the exact host generation after an MCP registry wait and before final host dispatch', async () => {
    const harness = createHarness();
    const service = await harness.createService();
    const binding = await service.openHostSession(context);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    let releaseRegistryWait!: () => void;
    const registryWait = new Promise<void>((resolve) => {
      releaseRegistryWait = resolve;
    });
    let markRegistryWaitStarted!: () => void;
    const registryWaitStarted = new Promise<void>((resolve) => {
      markRegistryWaitStarted = resolve;
    });
    harness.callTool.mockImplementationOnce(
      async (serverId, toolName, args, options) => {
        markRegistryWaitStarted();
        await registryWait;
        options?.beforeDispatch?.();
        return await harness.hostCallTool(serverId, toolName, args);
      },
    );

    const invocation = service.invokeHostSession(
      context,
      {
        id: 'host-mcp-final-dispatch',
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'final dispatch fence' },
        },
      },
      binding.sessionId,
      binding.navigationEpoch,
    );
    const deniedInvocation = expect(invocation).rejects.toThrow(
      'session binding is inactive or mismatched',
    );
    await registryWaitStarted;
    await service.suspendHostSession(
      context,
      binding.documentSlotId,
      binding.sessionId,
      binding.navigationEpoch,
    );
    releaseRegistryWait();

    await deniedInvocation;
    expect(harness.callTool).toHaveBeenCalledTimes(1);
    expect(harness.hostCallTool).not.toHaveBeenCalled();
    await service.teardown();
  });
});
