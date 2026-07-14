import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import {
  DEFAULT_ARTIFACT_BRIDGE_POLICY,
  type ArtifactBridgeContext,
  type ArtifactBridgeLifecycleEvent,
  type ArtifactBridgeWriteProposal,
} from '@shared/artifact-bridge';
import type { ArtifactBridgeAuditRecorder } from './audit-ledger';
import { ArtifactBridgeService, type ArtifactBridgePersistence } from './index';
import { TRUSTED_UI_REVIEWER_CONNECTION_ID } from '../trusted-ui-karton-transport';
import { createArtifactBridgeAgentAskModelAdapterIdentity } from './effect-commitment';

function createHarness(initialStore: unknown = { version: 5, grants: {} }) {
  let store: unknown = structuredClone(initialStore);
  const savedStores: unknown[] = [];
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
      savedStores.push(structuredClone(value));
    },
  };
  const callTool = vi.fn(
    async (
      _serverId?: string,
      _toolName?: string,
      _arguments?: Record<string, unknown>,
      _options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
        agentInstanceId?: string;
        beforeDispatch?: () => void;
      },
    ): Promise<unknown> => {
      _options?.beforeDispatch?.();
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );
  const listTools = vi.fn(async () => [
    {
      name: 'search',
      description: 'Search',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'update',
      description: 'Update a record',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ]);
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
      server: structuredClone(
        (mcpRegistry as unknown as { snapshot: () => any }).snapshot().servers[
          serverId
        ],
      ),
      runtime: {
        restartCount: 0,
        catalogRevision: 0,
        configurationRevision: 0,
      },
      descriptor: structuredClone(
        [
          {
            name: 'search',
            description: 'Search',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: 'update',
            description: 'Update a record',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ].find((tool) => tool.name === toolName),
      ),
    }),
    callTool,
  } as unknown as McpRegistryService;
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
      return 'bounded answer';
    },
  );
  const identity = {
    manifestSchemaVersion: 1 as const,
    appVersion: '1.0.0',
    manifestHash: 'a'.repeat(64),
    executableHash: 'b'.repeat(64),
    assetHash: 'c'.repeat(64),
  };
  const automationId = '1cbd31a0-af7b-4b5a-948d-e782dea80d82';
  const automationDefinition = {
    id: automationId,
    title: 'Approved report',
    prompt: 'Run the approved report',
    enabled: true,
    schedule: {
      kind: 'interval' as const,
      everyMs: 60_000,
      anchorAt: '2026-07-14T00:00:00.000Z',
    },
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
  const resolveAutomationDefinition = vi.fn(() =>
    structuredClone(automationDefinition),
  );
  const runAutomation = vi.fn(
    async (
      _automationId: string,
      options?: {
        beforeDispatch?: (input: {
          automation: unknown;
          prompt: string;
          attempt: number;
        }) => void;
      },
    ) => {
      options?.beforeDispatch?.({
        automation: structuredClone(automationDefinition),
        prompt: automationDefinition.prompt,
        attempt: 1,
      });
      return { ok: true };
    },
  );
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
        type: 'mcp:write' as const,
        reason: 'Update the selected record',
        tools: [{ serverId: 'docs', toolName: 'update' }],
      },
      {
        type: 'agent:ask' as const,
        reason: 'Summarize dashboard data',
      },
      {
        type: 'automation:run' as const,
        reason: 'Run the approved report',
        automationIds: [automationId],
      },
    ],
  };
  const resolveApp = vi.fn(async () => ({ identity, manifest }));

  return {
    handlers,
    karton,
    persistence,
    resolveAgentAskModelAdapterIdentity,
    resolveAutomationDefinition,
    mcpRegistry,
    callTool,
    askAgent,
    runAutomation,
    identity,
    automationId,
    automationDefinition,
    manifest,
    resolveApp,
    savedStores,
  };
}

const context = {
  kind: 'agent' as const,
  agentId: 'agent-1',
  appId: 'dashboard',
};
const packageContext = {
  kind: 'package' as const,
  packageId: 'com.example.dashboard',
  appId: 'dashboard',
};
const DEFAULT_TEST_POLICY = DEFAULT_ARTIFACT_BRIDGE_POLICY;

describe('ArtifactBridgeService', () => {
  it('rejects invoke at the master gate before resolver or effect adapters', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => false,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(
      service.invoke(context, {
        id: 'gate-off',
        method: 'askAgent',
        params: { prompt: 'This must never execute.' },
      }),
    ).rejects.toThrow('Generated app capability bridge is disabled');
    expect(harness.resolveApp).not.toHaveBeenCalled();
    expect(harness.mcpRegistry.listTools).not.toHaveBeenCalled();
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(harness.askAgent).not.toHaveBeenCalled();
    expect(harness.runAutomation).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('emits bounded dogfood observations without request content', async () => {
    const harness = createHarness();
    const captureDogfoodTelemetry = vi.fn();
    const service = await ArtifactBridgeService.create({
      logger: { warn: vi.fn() } as unknown as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areEphemeralGrantsEnabled: () => true,
      isRuntimeInspectorEnabled: () => true,
      captureDogfoodTelemetry,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    const sessionId = '5ae5fe8d-8437-4ac5-aa30-80852bc66102';

    expect(service.registerSession(context, sessionId)).toBe(true);
    await service.invoke(
      context,
      { id: 'telemetry-discovery', method: 'getCapabilities', params: {} },
      sessionId,
    );
    await service.getRuntimeInspector(context);
    await service.unregisterSession(context, sessionId);

    const observations = captureDogfoodTelemetry.mock.calls.map(
      ([, observation]) => observation,
    );
    expect(observations).toEqual(
      expect.arrayContaining([
        { activity: 'preview-session', outcome: 'started' },
        {
          activity: 'capability-invocation',
          outcome: 'success',
          capability_kind: 'discovery',
        },
        { activity: 'runtime-inspector', outcome: 'success' },
        { activity: 'preview-session', outcome: 'closed' },
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain('telemetry-discovery');
    expect(JSON.stringify(observations)).not.toContain('agent-1');
    expect(JSON.stringify(observations)).not.toContain('dashboard');
    await service.teardown();
  });

  it('returns no capabilities until the trusted UI stores a grant', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    const result = await service.invoke(context, {
      id: '1',
      method: 'getCapabilities',
      params: {},
    });

    expect(result).toEqual({
      version: 2,
      capabilities: [],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
      grantScope: null,
      writesEnabled: false,
      sensitiveEgressEnabled: false,
      asyncOperationsEnabled: false,
      runtimeQuotas: {
        enabled: false,
        maxConcurrentInvocations: 2,
        maxAgentAsksPerHour: 20,
        maxAutomationRunsPerHour: 30,
        remainingAgentAsksThisHour: 20,
        remainingAutomationRunsThisHour: 30,
      },
    });
    await service.teardown();
  });

  it('allows only granted read-only MCP tools', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    const result = await service.invoke(context, {
      id: '2',
      method: 'callMcpTool',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    });

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(harness.callTool).toHaveBeenCalledWith(
      'docs',
      'search',
      { query: 'Clodex' },
      expect.objectContaining({
        timeoutMs: 30_000,
        agentInstanceId: 'agent-1',
        beforeDispatch: expect.any(Function),
      }),
    );
    await service.teardown();
  });

  it('derives the current app identity for internal grant inputs', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    const grant = await service.setGrant({
      context,
      capabilities: [],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    expect(grant).toMatchObject({ identity: harness.identity });
    expect(harness.resolveApp).toHaveBeenCalledWith(context);
    await service.teardown();
  });

  it('requires a separate one-time approval for sensitive remote MCP reads', async () => {
    const harness = createHarness();
    harness.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      access_token: 'must-not-reach-preview',
    });
    const record = vi.fn<ArtifactBridgeAuditRecorder['record']>(
      async () => undefined,
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      auditRecorder: { record },
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    await expect(
      service.invoke(context, {
        id: 'sensitive-direct',
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'Clodex' },
        },
      }),
    ).rejects.toThrow('requires separate one-time approval');

    const proposal = await service.invoke(context, {
      id: 'sensitive-prepare',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    });
    expect(proposal).toMatchObject({
      serverId: 'docs',
      toolName: 'search',
      reasons: ['remote-network'],
      argumentsPreview: expect.stringContaining('Clodex'),
    });
    const approval = await service.approveSensitiveMcpCall(
      context,
      (proposal as { id: string }).id,
    );
    await expect(
      service.invoke(context, {
        id: 'sensitive-commit',
        method: 'commitSensitiveMcpCall',
        params: {
          proposalId: approval.proposal.id,
          commitToken: approval.commitToken,
          asOperation: false,
        },
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      access_token: '[REDACTED]',
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sensitive-egress.committed' }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      'must-not-reach-preview',
    );
    await service.teardown();
  });

  it('blocks raw credentials before preparing sensitive MCP egress', async () => {
    const harness = createHarness();
    const record = vi.fn<ArtifactBridgeAuditRecorder['record']>(
      async () => undefined,
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      auditRecorder: { record },
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    await expect(
      service.invoke(context, {
        id: 'credential-blocked',
        method: 'prepareSensitiveMcpCall',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { authorization: 'Bearer abcdefghijklmnop' },
        },
      }),
    ).rejects.toThrow('Raw credentials are not allowed');
    expect(harness.callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(record.mock.calls)).not.toContain('abcdefghijklmnop');
    await service.teardown();
  });

  it('enforces organization allow and deny patterns for sensitive MCP tools', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        allowedSensitiveMcpTools: ['docs/*'],
        deniedSensitiveMcpTools: ['docs/search'],
      }),
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    await expect(
      service.invoke(context, {
        id: 'policy-denied',
        method: 'prepareSensitiveMcpCall',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'Clodex' },
        },
      }),
    ).rejects.toThrow('disabled by organization policy');
    await service.teardown();
  });

  it('withholds MCP provider error details from preview and audit', async () => {
    const harness = createHarness();
    harness.callTool.mockRejectedValueOnce(
      new Error('upstream failed with token=abcdefghijklmnop'),
    );
    const record = vi.fn<ArtifactBridgeAuditRecorder['record']>(
      async () => undefined,
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      auditRecorder: { record },
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invoke(context, {
      id: 'provider-error-prepare',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    })) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      proposal.id,
    );

    await expect(
      service.invoke(context, {
        id: 'provider-error-commit',
        method: 'commitSensitiveMcpCall',
        params: {
          proposalId: approval.proposal.id,
          commitToken: approval.commitToken,
          asOperation: false,
        },
      }),
    ).rejects.toThrow('sensitive details withheld');
    expect(JSON.stringify(record.mock.calls)).not.toContain('abcdefghijklmnop');
    await service.teardown();
  });

  it('applies secret blocking and result redaction to reviewed MCP writes', async () => {
    const harness = createHarness();
    harness.callTool.mockResolvedValueOnce({
      updated: true,
      refreshToken: 'must-not-reach-preview',
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });

    await expect(
      service.invoke(context, {
        id: 'write-secret-blocked',
        method: 'prepareMcpWrite',
        params: {
          serverId: 'docs',
          toolName: 'update',
          arguments: { password: 'not-forwarded' },
        },
      }),
    ).rejects.toThrow('Raw credentials are not allowed');

    const proposal = await service.invoke(context, {
      id: 'write-sensitive-prepare',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-1' },
      },
    });
    expect(proposal).toMatchObject({
      sensitiveEgressReasons: ['remote-network'],
    });
    const approval = await service.approveWrite(
      context,
      (proposal as { id: string }).id,
    );
    await expect(
      service.invoke(context, {
        id: 'write-sensitive-commit',
        method: 'commitMcpWrite',
        params: {
          proposalId: approval.proposal.id,
          commitToken: approval.commitToken,
        },
      }),
    ).resolves.toEqual({
      updated: true,
      refreshToken: '[REDACTED]',
    });
    await service.teardown();
  });

  it('supports bounded agent questions and automation launch', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask', 'automation:run'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [harness.automationId],
      expiresAt: null,
    });

    await expect(
      service.invoke(context, {
        id: '3',
        method: 'askAgent',
        params: { prompt: 'Summarize this dashboard.' },
      }),
    ).resolves.toEqual({ text: 'bounded answer' });
    await expect(
      service.invoke(context, {
        id: '4',
        method: 'runAutomation',
        params: { automationId: harness.automationId },
      }),
    ).resolves.toEqual({ ok: true });
    await service.teardown();
  });

  it('enforces per-principal concurrency only behind the runtime quota gate', async () => {
    const harness = createHarness();
    let finishAsk!: (value: string) => void;
    harness.askAgent.mockImplementationOnce(
      async (_context, _prompt, options) => {
        options?.beforeDispatch?.();
        return await new Promise<string>((resolve) => {
          finishAsk = resolve;
        });
      },
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areRuntimeQuotasEnabled: () => true,
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        maxConcurrentInvocations: 1,
      }),
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    const first = service.invoke(context, {
      id: 'concurrent-first',
      method: 'askAgent',
      params: { prompt: 'Hold this request.' },
    });
    await vi.waitFor(() => expect(harness.askAgent).toHaveBeenCalledTimes(1));
    await expect(
      service.invoke(context, {
        id: 'concurrent-second',
        method: 'askAgent',
        params: { prompt: 'Attempt overlap.' },
      }),
    ).rejects.toThrow('concurrent invocation quota');
    finishAsk('done');
    await expect(first).resolves.toEqual({ text: 'done' });
    await service.teardown();
  });

  it('runs MCP work through session-bound async operation handles', async () => {
    const harness = createHarness();
    const events: ArtifactBridgeLifecycleEvent[] = [];
    const sessionId = '4d6f2a31-904f-4f2d-b4a5-f33bf1c8ef66';
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      areLifecycleEventsEnabled: () => true,
      emitLifecycleEvent: async (event) => {
        events.push(event);
      },
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    service.registerSession(context, sessionId);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    const started = (await service.invoke(
      context,
      {
        id: 'async-start',
        method: 'startMcpOperation',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'Clodex' },
        },
      },
      sessionId,
    )) as { id: string; status: string };
    expect(started.status).toBe('queued');
    await vi.waitFor(async () => {
      await expect(
        service.invoke(
          context,
          {
            id: 'async-status',
            method: 'getOperation',
            params: { operationId: started.id },
          },
          sessionId,
        ),
      ).resolves.toMatchObject({ status: 'completed' });
    });
    await expect(
      service.invoke(
        context,
        {
          id: 'async-result',
          method: 'getOperationResult',
          params: { operationId: started.id },
        },
        sessionId,
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    await expect(
      service.invoke(
        context,
        {
          id: 'async-cross-session',
          method: 'getOperation',
          params: { operationId: started.id },
        },
        '2de5116f-15c8-4f2f-8f4e-a4cbcb6ebf18',
      ),
    ).rejects.toThrow('operation is unavailable');
    expect(events.filter((event) => event.type === 'operationChanged')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'operationChanged',
          sessionId,
          operation: expect.objectContaining({ status: 'completed' }),
        }),
      ]),
    );
    await service.teardown();
  });

  it('cancels a running MCP operation through its AbortSignal', async () => {
    const harness = createHarness();
    let observedSignal: AbortSignal | undefined;
    harness.callTool.mockImplementationOnce(
      async (
        _serverId,
        _toolName,
        _arguments,
        options?: { signal?: AbortSignal },
      ) =>
        await new Promise((_resolve, reject) => {
          observedSignal = options?.signal;
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted upstream')),
            { once: true },
          );
        }),
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    const started = (await service.invoke(context, {
      id: 'async-cancel-start',
      method: 'startMcpOperation',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    })) as { id: string };
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await expect(
      service.invoke(context, {
        id: 'async-cancel',
        method: 'cancelOperation',
        params: { operationId: started.id },
      }),
    ).resolves.toMatchObject({ status: 'cancelled', cancellable: false });
    expect(observedSignal?.aborted).toBe(true);
    await expect(
      service.invoke(context, {
        id: 'async-cancel-result',
        method: 'getOperationResult',
        params: { operationId: started.id },
      }),
    ).rejects.toThrow('cancelled');
    await service.teardown();
  });

  it('runs an approved sensitive MCP read as an async operation and redacts its result', async () => {
    const harness = createHarness();
    harness.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      access_token: 'must-not-reach-generated-code',
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invoke(context, {
      id: 'sensitive-async-prepare',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'Clodex' },
      },
    })) as { id: string };
    const approval = await service.approveSensitiveMcpCall(
      context,
      proposal.id,
    );

    const started = (await service.invoke(context, {
      id: 'sensitive-async-commit',
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: true,
      },
    })) as { id: string };
    await vi.waitFor(async () => {
      await expect(
        service.invoke(context, {
          id: 'sensitive-async-status',
          method: 'getOperation',
          params: { operationId: started.id },
        }),
      ).resolves.toMatchObject({ status: 'completed' });
    });
    await expect(
      service.invoke(context, {
        id: 'sensitive-async-result',
        method: 'getOperationResult',
        params: { operationId: started.id },
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      access_token: '[REDACTED]',
    });
    await service.teardown();
  });

  it('aborts and removes session-bound operations when the preview session closes', async () => {
    const harness = createHarness();
    const sessionId = '5b2e5b65-5924-4a6d-82f7-6da7f82a44eb';
    let observedSignal: AbortSignal | undefined;
    harness.callTool.mockImplementationOnce(
      async (
        _serverId,
        _toolName,
        _arguments,
        options?: { signal?: AbortSignal },
      ) =>
        await new Promise((_resolve, reject) => {
          observedSignal = options?.signal;
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('session closed')),
            { once: true },
          );
        }),
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    service.registerSession(context, sessionId);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    const started = (await service.invoke(
      context,
      {
        id: 'session-operation-start',
        method: 'startMcpOperation',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'Clodex' },
        },
      },
      sessionId,
    )) as { id: string };
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await service.unregisterSession(context, sessionId);
    expect(observedSignal?.aborted).toBe(true);
    await expect(
      service.invoke(
        context,
        {
          id: 'session-operation-after-close',
          method: 'getOperation',
          params: { operationId: started.id },
        },
        sessionId,
      ),
    ).rejects.toThrow('operation is unavailable');
    await service.teardown();
  });

  it('enforces the per-principal async operation concurrency limit', async () => {
    const harness = createHarness();
    harness.callTool.mockImplementation(
      async (
        _serverId,
        _toolName,
        _arguments,
        options?: { signal?: AbortSignal },
      ) =>
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        maxConcurrentAsyncOperations: 1,
      }),
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    const first = (await service.invoke(context, {
      id: 'concurrency-first',
      method: 'startMcpOperation',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'first' },
      },
    })) as { id: string };

    await expect(
      service.invoke(context, {
        id: 'concurrency-second',
        method: 'startMcpOperation',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'second' },
        },
      }),
    ).rejects.toThrow('concurrent async operation quota');
    await service.invoke(context, {
      id: 'concurrency-cleanup',
      method: 'cancelOperation',
      params: { operationId: first.id },
    });
    await service.teardown();
  });

  it('times out long-running MCP operations and aborts the provider request', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      let observedSignal: AbortSignal | undefined;
      harness.callTool.mockImplementationOnce(
        async (
          _serverId,
          _toolName,
          _arguments,
          options?: { signal?: AbortSignal },
        ) =>
          await new Promise((_resolve, reject) => {
            observedSignal = options?.signal;
            options?.signal?.addEventListener(
              'abort',
              () => reject(new Error('timed out upstream')),
              { once: true },
            );
          }),
      );
      const service = await ArtifactBridgeService.create({
        logger: {} as Logger,
        karton: harness.karton,
        mcpRegistry: harness.mcpRegistry,
        persistence: harness.persistence,
        isFeatureEnabled: () => true,
        areAsyncOperationsEnabled: () => true,
        askAgent: harness.askAgent,
        resolveAgentAskModelAdapterIdentity:
          harness.resolveAgentAskModelAdapterIdentity,
        runAutomation: harness.runAutomation,
        resolveAutomationDefinition: harness.resolveAutomationDefinition,
        resolveApp: harness.resolveApp,
      });
      await service.setGrant({
        context,
        identity: harness.identity,
        capabilities: ['mcp:call'],
        mcpTools: [{ serverId: 'docs', toolName: 'search' }],
        mcpWriteTools: [],
        automationIds: [],
        expiresAt: null,
      });
      const started = (await service.invoke(context, {
        id: 'timeout-start',
        method: 'startMcpOperation',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'slow' },
          timeoutMs: 1_000,
        },
      })) as { id: string };
      await vi.advanceTimersByTimeAsync(1_000);

      expect(observedSignal?.aborted).toBe(true);
      await expect(
        service.invoke(context, {
          id: 'timeout-status',
          method: 'getOperation',
          params: { operationId: started.id },
        }),
      ).resolves.toMatchObject({
        status: 'timed-out',
        cancellable: false,
      });
      await expect(
        service.invoke(context, {
          id: 'timeout-result',
          method: 'getOperationResult',
          params: { operationId: started.id },
        }),
      ).rejects.toThrow('timed out');
      await service.teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not claim that a running automation can be cancelled', async () => {
    const harness = createHarness();
    let finishAutomation!: () => void;
    harness.runAutomation.mockImplementationOnce(
      async (_automationId, options) => {
        options?.beforeDispatch?.({
          automation: structuredClone(harness.automationDefinition),
          prompt: harness.automationDefinition.prompt,
          attempt: 1,
        });
        return await new Promise((resolve) => {
          finishAutomation = () => resolve({ ok: true });
        });
      },
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['automation:run'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [harness.automationId],
      expiresAt: null,
    });
    const started = (await service.invoke(context, {
      id: 'automation-operation-start',
      method: 'startAutomationOperation',
      params: { automationId: harness.automationId },
    })) as { id: string };
    await vi.waitFor(() =>
      expect(harness.runAutomation).toHaveBeenCalledTimes(1),
    );
    await expect(
      service.invoke(context, {
        id: 'automation-operation-running',
        method: 'getOperation',
        params: { operationId: started.id },
      }),
    ).resolves.toMatchObject({ status: 'running', cancellable: false });
    await expect(
      service.invoke(context, {
        id: 'automation-operation-cancel',
        method: 'cancelOperation',
        params: { operationId: started.id },
      }),
    ).rejects.toThrow('can no longer be cancelled safely');

    finishAutomation();
    await vi.waitFor(async () => {
      await expect(
        service.invoke(context, {
          id: 'automation-operation-completed',
          method: 'getOperation',
          params: { operationId: started.id },
        }),
      ).resolves.toMatchObject({ status: 'completed' });
    });
    await service.teardown();
  });

  it('returns a bounded trusted runtime inspector snapshot without request arguments or results', async () => {
    const harness = createHarness();
    const sessionId = 'd8735f30-038d-48d8-b90d-536797c6529f';
    const auditReader = {
      listRecent: vi.fn(async () => [
        {
          sequence: 7,
          timestamp: '2026-07-11T12:00:00.000Z',
          action: 'capability.invoked' as const,
          outcome: 'success' as const,
          context,
          requestId: 'audit-request',
          method: 'callMcpTool',
          resource: 'docs/search',
          error: null,
        },
      ]),
    };
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      areRuntimeQuotasEnabled: () => true,
      areLifecycleEventsEnabled: () => true,
      isSensitiveEgressEnabled: () => true,
      areAsyncOperationsEnabled: () => true,
      isRuntimeInspectorEnabled: () => true,
      auditReader,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    expect(service.registerSession(context, sessionId)).toBe(true);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call', 'mcp:write', 'automation:run'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [harness.automationId],
      expiresAt: null,
    });
    await service.invoke(
      context,
      {
        id: 'inspector-write',
        method: 'prepareMcpWrite',
        params: {
          serverId: 'docs',
          toolName: 'update',
          arguments: { customerId: 'cust_123', note: 'internal update' },
        },
      },
      sessionId,
    );
    await service.invoke(
      context,
      {
        id: 'inspector-sensitive',
        method: 'prepareSensitiveMcpCall',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: 'private customer record' },
        },
      },
      sessionId,
    );
    const operation = (await service.invoke(
      context,
      {
        id: 'inspector-operation',
        method: 'startAutomationOperation',
        params: {
          automationId: harness.automationId,
        },
      },
      sessionId,
    )) as { id: string };
    await vi.waitFor(async () => {
      await expect(
        service.invoke(
          context,
          {
            id: 'inspector-operation-status',
            method: 'getOperation',
            params: { operationId: operation.id },
          },
          sessionId,
        ),
      ).resolves.toMatchObject({ status: 'completed' });
    });

    const snapshot = await service.getRuntimeInspector(context);
    expect(snapshot).toMatchObject({
      version: 1,
      context,
      featureFlags: {
        writesEnabled: true,
        runtimeQuotasEnabled: true,
        lifecycleEventsEnabled: true,
        ephemeralGrantsEnabled: false,
        sensitiveEgressEnabled: true,
        asyncOperationsEnabled: true,
      },
      persistentGrant: {
        scope: { kind: 'persistent' },
        capabilities: ['mcp:call', 'mcp:write', 'automation:run'],
      },
      sessions: [
        expect.objectContaining({
          sessionId,
          hasEphemeralGrant: false,
        }),
      ],
      activeInvocations: 0,
      pendingReviews: expect.arrayContaining([
        expect.objectContaining({
          kind: 'mcp-write',
          serverId: 'docs',
          toolName: 'update',
          sessionId,
        }),
        expect.objectContaining({
          kind: 'sensitive-mcp',
          serverId: 'docs',
          toolName: 'search',
          sessionId,
        }),
      ]),
      operations: [
        expect.objectContaining({
          id: operation.id,
          status: 'completed',
          sessionId,
        }),
      ],
      audit: [
        expect.objectContaining({
          sequence: 7,
          resource: 'docs/search',
        }),
      ],
    });
    expect(snapshot.rateLimitCallsLastMinute).toBeGreaterThanOrEqual(4);
    expect(auditReader.listRecent).toHaveBeenCalledWith(50, context);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('private customer record');
    expect(encoded).not.toContain('cust_123');
    expect(encoded).not.toContain('"content"');
    await service.teardown();
  });

  it('keeps runtime inspection disabled by default and restricted to the trusted UI client', async () => {
    const disabledHarness = createHarness();
    const disabled = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: disabledHarness.karton,
      mcpRegistry: disabledHarness.mcpRegistry,
      persistence: disabledHarness.persistence,
      isFeatureEnabled: () => true,
      askAgent: disabledHarness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        disabledHarness.resolveAgentAskModelAdapterIdentity,
      runAutomation: disabledHarness.runAutomation,
      resolveAutomationDefinition: disabledHarness.resolveAutomationDefinition,
      resolveApp: disabledHarness.resolveApp,
    });
    await expect(disabled.getRuntimeInspector(context)).rejects.toThrow(
      'runtime inspector is disabled',
    );
    await disabled.teardown();

    const harness = createHarness();
    const enabled = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      isRuntimeInspectorEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await expect(
      harness.handlers.get('artifactBridge.getRuntimeInspector')?.(
        'pages',
        context,
      ),
    ).rejects.toThrow('trusted UI client');
    await expect(
      harness.handlers.get('artifactBridge.getRuntimeInspector')?.(
        TRUSTED_UI_REVIEWER_CONNECTION_ID,
        context,
      ),
    ).resolves.toMatchObject({ version: 1, context });
    await enabled.teardown();
  });

  it('enforces hourly agent and automation quotas and reports remaining capacity', async () => {
    const harness = createHarness();
    const record = vi.fn<ArtifactBridgeAuditRecorder['record']>(
      async () => undefined,
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areRuntimeQuotasEnabled: () => true,
      auditRecorder: { record },
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        maxAgentAsksPerHour: 1,
        maxAutomationRunsPerHour: 1,
      }),
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask', 'automation:run'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [harness.automationId],
      expiresAt: null,
    });

    await service.invoke(context, {
      id: 'ask-allowed',
      method: 'askAgent',
      params: { prompt: 'One question.' },
    });
    await expect(
      service.invoke(context, {
        id: 'ask-denied',
        method: 'askAgent',
        params: { prompt: 'Second question.' },
      }),
    ).rejects.toThrow('agent:ask hourly quota');
    await service.invoke(context, {
      id: 'automation-allowed',
      method: 'runAutomation',
      params: { automationId: harness.automationId },
    });
    await expect(
      service.invoke(context, {
        id: 'automation-denied',
        method: 'runAutomation',
        params: { automationId: harness.automationId },
      }),
    ).rejects.toThrow('automation:run hourly quota');

    await expect(
      service.invoke(context, {
        id: 'quota-snapshot',
        method: 'getCapabilities',
        params: {},
      }),
    ).resolves.toMatchObject({
      runtimeQuotas: {
        enabled: true,
        remainingAgentAsksThisHour: 0,
        remainingAutomationRunsThisHour: 0,
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'capability.invoked',
        outcome: 'denied',
        method: 'askAgent',
        error: expect.stringContaining('hourly quota'),
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('One question.');
    await service.teardown();
  });

  it('invalidates a grant when executable identity changes', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    harness.resolveApp.mockResolvedValue({
      identity: {
        ...harness.identity,
        executableHash: 'd'.repeat(64),
      },
      manifest: harness.manifest,
    });

    await expect(
      service.invoke(context, {
        id: 'changed',
        method: 'askAgent',
        params: { prompt: 'Use the old grant.' },
      }),
    ).rejects.toThrow('no active capability grant');
    await service.teardown();
  });

  it('revokes a grant when non-executable assets change', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    harness.resolveApp.mockResolvedValue({
      identity: {
        ...harness.identity,
        assetHash: 'd'.repeat(64),
      },
      manifest: harness.manifest,
    });

    await expect(
      service.invoke(context, {
        id: 'asset-only-change',
        method: 'askAgent',
        params: { prompt: 'Use the stale grant.' },
      }),
    ).rejects.toThrow('no active capability grant');
    expect(harness.askAgent).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('revokes legacy v1 grants during migration and persists an empty v5 store', async () => {
    const harness = createHarness({
      version: 1,
      grants: {
        legacy: {
          context,
          capabilities: ['agent:ask'],
        },
      },
    });
    const warn = vi.fn();
    const service = await ArtifactBridgeService.create({
      logger: { warn } as unknown as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Legacy capability grants were revoked'),
      { grantCount: 1 },
    );
    expect(harness.savedStores).toContainEqual({ version: 5, grants: {} });
    await service.teardown();
  });

  it('fails closed when persisted grant data is malformed', async () => {
    const harness = createHarness({ version: 4, grants: { broken: true } });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    expect(harness.savedStores).toContainEqual({ version: 5, grants: {} });
    await expect(
      harness.handlers.get('artifactBridge.getGrant')?.(
        TRUSTED_UI_REVIEWER_CONNECTION_ID,
        context,
      ),
    ).resolves.toBeNull();
    await service.teardown();
  });

  it('migrates identity-bound v2 grants without granting write tools', async () => {
    const identity = {
      manifestSchemaVersion: 1 as const,
      appVersion: '1.0.0',
      manifestHash: 'a'.repeat(64),
      executableHash: 'b'.repeat(64),
      assetHash: 'c'.repeat(64),
    };
    const harness = createHarness({
      version: 2,
      grants: {
        legacyV2: {
          schemaVersion: 2,
          context,
          identity,
          capabilities: ['agent:ask'],
          mcpTools: [],
          automationIds: [],
          expiresAt: null,
          updatedAt: '2026-07-11T12:00:00.000Z',
        },
      },
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    expect(harness.savedStores.at(-1)).toMatchObject({
      version: 5,
      grants: {
        [JSON.stringify(['agent', 'agent-1', 'dashboard', null])]:
          expect.objectContaining({
            schemaVersion: 5,
            context,
            scope: { kind: 'persistent' },
            mcpWriteTools: [],
          }),
      },
    });
    await service.teardown();
  });

  it('migrates v3 agent grants to discriminated v5 persistent principals without revoking them', async () => {
    const harness = createHarness({
      version: 3,
      grants: {
        legacyV3: {
          schemaVersion: 3,
          context: { agentId: 'agent-1', appId: 'dashboard' },
          identity: {
            manifestSchemaVersion: 1,
            appVersion: '1.0.0',
            manifestHash: 'a'.repeat(64),
            executableHash: 'b'.repeat(64),
            assetHash: 'c'.repeat(64),
          },
          capabilities: ['agent:ask'],
          mcpTools: [],
          mcpWriteTools: [],
          automationIds: [],
          expiresAt: null,
          updatedAt: '2026-07-11T12:00:00.000Z',
        },
      },
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(service.getGrant(context)).resolves.toMatchObject({
      schemaVersion: 5,
      context,
      scope: { kind: 'persistent' },
      capabilities: ['agent:ask'],
    });
    expect(harness.savedStores.at(-1)).toMatchObject({ version: 5 });
    await service.teardown();
  });

  it('migrates v4 grants to v5 persistent scope without widening access', async () => {
    const harness = createHarness({
      version: 4,
      grants: {
        legacyV4: {
          schemaVersion: 4,
          context,
          identity: {
            manifestSchemaVersion: 1,
            appVersion: '1.0.0',
            manifestHash: 'a'.repeat(64),
            executableHash: 'b'.repeat(64),
            assetHash: 'c'.repeat(64),
          },
          capabilities: ['agent:ask'],
          mcpTools: [],
          mcpWriteTools: [],
          automationIds: [],
          expiresAt: null,
          updatedAt: '2026-07-11T12:00:00.000Z',
        },
      },
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(service.getGrant(context)).resolves.toMatchObject({
      schemaVersion: 5,
      scope: { kind: 'persistent' },
      capabilities: ['agent:ask'],
    });
    expect(harness.savedStores.at(-1)).toMatchObject({ version: 5 });
    await service.teardown();
  });

  it('keeps package principals behind a separate default-off backend gate', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      arePackageCapabilitiesEnabled: () => false,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(service.getGrant(packageContext)).rejects.toThrow(
      'Packaged generated app capabilities are disabled',
    );
    expect(harness.resolveApp).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('uses isolated stable MCP principals for packages and never allows agent impersonation', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      arePackageCapabilitiesEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context: packageContext,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    await service.invoke(packageContext, {
      id: 'package-read',
      method: 'callMcpTool',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'package' },
      },
    });
    expect(harness.callTool).toHaveBeenCalledWith(
      'docs',
      'search',
      { query: 'package' },
      {
        timeoutMs: 30_000,
        agentInstanceId: expect.stringMatching(
          /^generated-app-package:[a-f0-9]{32}$/,
        ),
        beforeDispatch: expect.any(Function),
      },
    );
    await expect(
      service.setGrant({
        context: packageContext,
        identity: harness.identity,
        capabilities: ['agent:ask'],
        mcpTools: [],
        mcpWriteTools: [],
        automationIds: [],
        expiresAt: null,
      }),
    ).rejects.toThrow('cannot receive the agent:ask capability');
    expect(harness.askAgent).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('denies package agent:ask even if a tampered v4 store contains that grant', async () => {
    const identity = {
      manifestSchemaVersion: 1 as const,
      appVersion: '1.0.0',
      manifestHash: 'a'.repeat(64),
      executableHash: 'b'.repeat(64),
      assetHash: 'c'.repeat(64),
    };
    const key = JSON.stringify([
      'package',
      packageContext.packageId,
      packageContext.appId,
    ]);
    const harness = createHarness({
      version: 4,
      grants: {
        [key]: {
          schemaVersion: 4,
          context: packageContext,
          identity,
          capabilities: ['agent:ask'],
          mcpTools: [],
          mcpWriteTools: [],
          automationIds: [],
          expiresAt: null,
          updatedAt: '2026-07-11T12:00:00.000Z',
        },
      },
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      arePackageCapabilitiesEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(
      service.invoke(packageContext, {
        id: 'package-agent-ask',
        method: 'askAgent',
        params: { prompt: 'Impersonate the owner.' },
      }),
    ).rejects.toThrow('cannot impersonate or ask an agent');
    expect(harness.askAgent).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('does not collide package and agent grants and invalidates package identity changes', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      arePackageCapabilitiesEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    await service.setGrant({
      context: packageContext,
      identity: harness.identity,
      capabilities: ['automation:run'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [harness.automationId],
      expiresAt: null,
    });

    await expect(service.getGrant(context)).resolves.toMatchObject({
      capabilities: ['mcp:call'],
    });
    await expect(service.getGrant(packageContext)).resolves.toMatchObject({
      capabilities: ['automation:run'],
    });
    harness.resolveApp.mockResolvedValue({
      identity: { ...harness.identity, executableHash: 'd'.repeat(64) },
      manifest: harness.manifest,
    });
    await expect(service.getGrant(packageContext)).resolves.toBeNull();
    await service.teardown();
  });

  it('requires trusted two-phase approval before an MCP write and commits idempotently', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });

    const proposal = (await service.invoke(context, {
      id: 'prepare-write',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: {
          recordId: 'record-1',
          status: 'approved',
          apiKey: 'must-not-appear',
        },
      },
    })) as ArtifactBridgeWriteProposal;
    expect(proposal).toMatchObject({
      serverId: 'docs',
      toolName: 'update',
      risk: 'destructive',
    });
    expect(proposal.argumentsPreview).toContain('[REDACTED]');
    expect(proposal.argumentsPreview).not.toContain('must-not-appear');

    await expect(
      service.invoke(context, {
        id: 'commit-before-approval',
        method: 'commitMcpWrite',
        params: {
          proposalId: proposal.id,
          commitToken: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow('not approved');

    const approval = await service.approveWrite(context, proposal.id);
    const commitRequest = {
      id: 'commit-write',
      method: 'commitMcpWrite',
      params: {
        proposalId: proposal.id,
        commitToken: approval.commitToken,
      },
    } as const;
    const first = await service.invoke(context, commitRequest);
    const repeated = await service.invoke(context, {
      ...commitRequest,
      id: 'commit-write-retry',
    });

    expect(first).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(repeated).toEqual(first);
    expect(harness.callTool).toHaveBeenCalledTimes(1);
    expect(harness.callTool).toHaveBeenCalledWith(
      'docs',
      'update',
      expect.objectContaining({ recordId: 'record-1' }),
      expect.objectContaining({
        timeoutMs: 30_000,
        agentInstanceId: 'agent-1',
        beforeDispatch: expect.any(Function),
      }),
    );
    await service.teardown();
  });

  it('coalesces concurrent commits for the same one-time token', async () => {
    const harness = createHarness();
    let finishWrite!: (value: {
      content: Array<{ type: string; text: string }>;
    }) => void;
    harness.callTool.mockImplementationOnce(
      async () =>
        await new Promise<{ content: Array<{ type: string; text: string }> }>(
          (resolve) => {
            finishWrite = resolve;
          },
        ),
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invoke(context, {
      id: 'prepare-concurrent',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-1' },
      },
    })) as { id: string };
    const approval = await service.approveWrite(context, proposal.id);
    const request = {
      method: 'commitMcpWrite' as const,
      params: {
        proposalId: proposal.id,
        commitToken: approval.commitToken,
      },
    };

    const first = service.invoke(context, { id: 'commit-a', ...request });
    const second = service.invoke(context, { id: 'commit-b', ...request });
    await vi.waitFor(() => expect(harness.callTool).toHaveBeenCalledTimes(1));
    finishWrite({ content: [{ type: 'text', text: 'updated' }] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { content: [{ type: 'text', text: 'updated' }] },
      { content: [{ type: 'text', text: 'updated' }] },
    ]);
    expect(harness.callTool).toHaveBeenCalledTimes(1);
    await service.teardown();
  });

  it('expires and rejects prepared writes without executing them', async () => {
    const harness = createHarness();
    let now = Date.parse('2026-07-11T12:00:00.000Z');
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        enabled: true,
        allowedCapabilities: ['mcp:write'],
        allowedMcpReadTools: [],
        allowedMcpWriteTools: ['docs/update'],
        allowNeverExpiringGrants: true,
        maxGrantDurationHours: 24,
        writeProposalTtlSeconds: 30,
      }),
      now: () => now,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invoke(context, {
      id: 'prepare-expiring',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-1' },
      },
    })) as { id: string };

    now += 30_001;
    await expect(service.approveWrite(context, proposal.id)).rejects.toThrow(
      'unavailable or expired',
    );
    expect(harness.callTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('prevents commit after rejection or app identity change', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    const rejected = (await service.invoke(context, {
      id: 'prepare-rejected',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-1' },
      },
    })) as { id: string };
    const rejectedApproval = await service.approveWrite(context, rejected.id);
    await service.rejectWrite(context, rejected.id);
    await expect(
      service.invoke(context, {
        id: 'commit-rejected',
        method: 'commitMcpWrite',
        params: {
          proposalId: rejected.id,
          commitToken: rejectedApproval.commitToken,
        },
      }),
    ).rejects.toThrow('unavailable or expired');

    const changed = (await service.invoke(context, {
      id: 'prepare-changed',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-2' },
      },
    })) as { id: string };
    const changedApproval = await service.approveWrite(context, changed.id);
    harness.resolveApp.mockResolvedValue({
      identity: {
        ...harness.identity,
        executableHash: 'd'.repeat(64),
      },
      manifest: harness.manifest,
    });
    await expect(
      service.invoke(context, {
        id: 'commit-changed',
        method: 'commitMcpWrite',
        params: {
          proposalId: changed.id,
          commitToken: changedApproval.commitToken,
        },
      }),
    ).rejects.toThrow('no active capability grant');
    expect(harness.callTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('applies policy changes immediately between approval and commit', async () => {
    const harness = createHarness();
    let writeAllowed = true;
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        enabled: true,
        allowedCapabilities: writeAllowed ? ['mcp:write'] : [],
        allowedMcpReadTools: [],
        allowedMcpWriteTools: writeAllowed ? ['docs/update'] : [],
        allowNeverExpiringGrants: true,
        maxGrantDurationHours: 24,
        writeProposalTtlSeconds: 60,
      }),
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invoke(context, {
      id: 'prepare-policy-change',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-1' },
      },
    })) as { id: string };
    const approval = await service.approveWrite(context, proposal.id);

    writeAllowed = false;
    await expect(
      service.invoke(context, {
        id: 'commit-policy-change',
        method: 'commitMcpWrite',
        params: {
          proposalId: proposal.id,
          commitToken: approval.commitToken,
        },
      }),
    ).rejects.toThrow('organization policy');
    expect(harness.callTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('records the complete safe-write audit lifecycle', async () => {
    const harness = createHarness();
    const record = vi.fn<ArtifactBridgeAuditRecorder['record']>(
      async () => undefined,
    );
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      auditRecorder: { record },
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['mcp:write'],
      mcpTools: [],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    const proposal = (await service.invoke(context, {
      id: 'prepare-audited',
      method: 'prepareMcpWrite',
      params: {
        serverId: 'docs',
        toolName: 'update',
        arguments: { recordId: 'record-1' },
      },
    })) as { id: string };
    const approval = await service.approveWrite(context, proposal.id);
    await service.invoke(context, {
      id: 'commit-audited',
      method: 'commitMcpWrite',
      params: {
        proposalId: proposal.id,
        commitToken: approval.commitToken,
      },
    });

    expect(record.mock.calls.map(([event]) => event.action)).toEqual(
      expect.arrayContaining([
        'grant.save-prepared',
        'write.prepared',
        'write.approved',
        'write.committed',
      ]),
    );
    await service.teardown();
  });

  it('accepts only the internally injected ui-main reviewer identity', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    for (const untrustedClientId of [
      'ui',
      'pages',
      'pages-api',
      'tab',
      'reviewer',
      'ui-main-forged',
    ]) {
      await expect(
        harness.handlers.get('artifactBridge.openGrantReview')?.(
          untrustedClientId,
          context,
          {
            scope: { kind: 'persistent' },
            capabilities: ['agent:ask'],
            mcpTools: [],
            mcpWriteTools: [],
            automationIds: [],
            expiresAt: null,
          },
        ),
        untrustedClientId,
      ).rejects.toThrow('trusted UI client');
    }
    expect(harness.resolveApp).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('keeps MCP writes fail-closed when the dedicated feature flag is off', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => false,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await expect(
      harness.handlers.get('artifactBridge.openGrantReview')?.(
        TRUSTED_UI_REVIEWER_CONNECTION_ID,
        context,
        {
          scope: { kind: 'persistent' },
          capabilities: ['mcp:write'],
          mcpTools: [],
          mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
          automationIds: [],
          expiresAt: null,
        },
      ),
    ).rejects.toThrow('disabled by policy');
    expect(harness.callTool).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('enforces organization capability and MCP tool policy', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areWritesEnabled: () => true,
      getPolicy: () => ({
        ...DEFAULT_TEST_POLICY,
        enabled: true,
        allowedCapabilities: ['mcp:call'],
        allowedMcpReadTools: ['docs/search'],
        allowedMcpWriteTools: [],
        allowNeverExpiringGrants: true,
        maxGrantDurationHours: 24,
        writeProposalTtlSeconds: 60,
      }),
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(
      service.setGrant({
        context,
        identity: harness.identity,
        capabilities: ['mcp:write'],
        mcpTools: [],
        mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
        automationIds: [],
        expiresAt: null,
      }),
    ).rejects.toThrow('organization policy');
    await service.teardown();
  });

  it('rejects capabilities not declared by the manifest', async () => {
    const harness = createHarness();
    harness.resolveApp.mockResolvedValue({
      identity: harness.identity,
      manifest: {
        ...harness.manifest,
        capabilities: [],
      },
    });
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });

    await expect(
      service.setGrant({
        context,
        identity: harness.identity,
        capabilities: ['agent:ask'],
        mcpTools: [],
        mcpWriteTools: [],
        automationIds: [],
        expiresAt: null,
      }),
    ).rejects.toThrow('was not requested');
    await service.teardown();
  });

  it('keeps session grants in memory, exact-session bound, and default-off', async () => {
    const disabledHarness = createHarness();
    const disabledService = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: disabledHarness.karton,
      mcpRegistry: disabledHarness.mcpRegistry,
      persistence: disabledHarness.persistence,
      isFeatureEnabled: () => true,
      areEphemeralGrantsEnabled: () => false,
      askAgent: disabledHarness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        disabledHarness.resolveAgentAskModelAdapterIdentity,
      runAutomation: disabledHarness.runAutomation,
      resolveAutomationDefinition: disabledHarness.resolveAutomationDefinition,
      resolveApp: disabledHarness.resolveApp,
    });
    const disabledSessionId = crypto.randomUUID();
    expect(disabledService.registerSession(context, disabledSessionId)).toBe(
      false,
    );
    await expect(
      disabledService.setGrant({
        context,
        scope: { kind: 'session', sessionId: disabledSessionId },
        identity: disabledHarness.identity,
        capabilities: ['mcp:call'],
        mcpTools: [{ serverId: 'docs', toolName: 'search' }],
        mcpWriteTools: [],
        automationIds: [],
        expiresAt: null,
      }),
    ).rejects.toThrow('ephemeral grants are disabled');
    await disabledService.teardown();

    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areEphemeralGrantsEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    const grantedSessionId = crypto.randomUUID();
    const otherSessionId = crypto.randomUUID();
    expect(service.registerSession(context, grantedSessionId)).toBe(true);
    expect(service.registerSession(context, otherSessionId)).toBe(true);
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    harness.savedStores.length = 0;
    await service.setGrant({
      context,
      scope: { kind: 'session', sessionId: grantedSessionId },
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });

    await expect(
      service.invoke(
        context,
        {
          id: 'session-granted',
          method: 'callMcpTool',
          params: {
            serverId: 'docs',
            toolName: 'search',
            arguments: { query: 'session' },
          },
        },
        grantedSessionId,
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    await expect(
      service.invoke(
        context,
        {
          id: 'session-other',
          method: 'callMcpTool',
          params: {
            serverId: 'docs',
            toolName: 'search',
            arguments: {},
          },
        },
        otherSessionId,
      ),
    ).rejects.toThrow('no active capability grant');
    await expect(
      service.invoke(context, {
        id: 'session-missing',
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: {},
        },
      }),
    ).rejects.toThrow('no active capability grant');
    expect(service.getActiveSessions(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: otherSessionId,
          hasEphemeralGrant: false,
        }),
        expect.objectContaining({
          sessionId: grantedSessionId,
          hasEphemeralGrant: true,
        }),
      ]),
    );
    expect(harness.savedStores).toHaveLength(2);
    expect(harness.savedStores[0]).toMatchObject({
      version: 5,
      grants: {},
      pendingMutations: expect.any(Object),
    });
    expect(harness.savedStores.at(-1)).toEqual({ version: 5, grants: {} });
    expect(JSON.stringify(harness.savedStores)).not.toContain(grantedSessionId);

    await service.unregisterSession(context, grantedSessionId);
    await expect(
      service.getGrant(context, grantedSessionId),
    ).resolves.toBeNull();
    expect(service.registerSession(context, grantedSessionId)).toBe(true);
    await expect(
      service.getGrant(context, grantedSessionId),
    ).resolves.toBeNull();
    await service.teardown();
  });

  it('rejects session replay across another generated-app principal', async () => {
    const harness = createHarness();
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areEphemeralGrantsEnabled: () => true,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    const sessionId = crypto.randomUUID();
    expect(service.registerSession(context, sessionId)).toBe(true);
    expect(() =>
      service.registerSession({ ...context, appId: 'another-app' }, sessionId),
    ).toThrow('session identity collision');
    await service.teardown();
  });

  it('emits bounded lifecycle metadata only while its independent gate is enabled', async () => {
    const harness = createHarness();
    const emittedEvents: ArtifactBridgeLifecycleEvent[] = [];
    const emitLifecycleEvent = vi.fn(
      async (event: ArtifactBridgeLifecycleEvent) => {
        emittedEvents.push(event);
      },
    );
    let lifecycleEnabled = true;
    const service = await ArtifactBridgeService.create({
      logger: {} as Logger,
      karton: harness.karton,
      mcpRegistry: harness.mcpRegistry,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      areLifecycleEventsEnabled: () => lifecycleEnabled,
      emitLifecycleEvent,
      askAgent: harness.askAgent,
      resolveAgentAskModelAdapterIdentity:
        harness.resolveAgentAskModelAdapterIdentity,
      runAutomation: harness.runAutomation,
      resolveAutomationDefinition: harness.resolveAutomationDefinition,
      resolveApp: harness.resolveApp,
    });
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: ['automation:run'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [harness.automationId],
      expiresAt: null,
    });
    await service.invoke(context, {
      id: 'lifecycle-automation',
      method: 'runAutomation',
      params: { automationId: harness.automationId },
    });
    await service.revokeGrant(context);

    expect(
      emittedEvents.map((event) => ({
        type: event.type,
        reason: 'reason' in event ? event.reason : undefined,
        outcome: 'outcome' in event ? event.outcome : undefined,
      })),
    ).toEqual([
      {
        type: 'capabilitiesChanged',
        reason: 'grant-saved',
        outcome: undefined,
      },
      {
        type: 'automationCompleted',
        reason: undefined,
        outcome: 'success',
      },
      {
        type: 'revoked',
        reason: 'grant-revoked',
        outcome: undefined,
      },
    ]);
    for (const event of emittedEvents) {
      expect(event).not.toHaveProperty('prompt');
      expect(event).not.toHaveProperty('arguments');
      expect(event).not.toHaveProperty('result');
    }

    lifecycleEnabled = false;
    await service.setGrant({
      context,
      identity: harness.identity,
      capabilities: [],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    expect(emitLifecycleEvent).toHaveBeenCalledTimes(3);
    await service.teardown();
  });
});
