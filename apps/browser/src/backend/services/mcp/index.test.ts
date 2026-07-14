import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialsService } from '../credentials';
import type { Logger } from '../logger';
import type { McpOAuthService } from './oauth';
import type { McpHostController, McpRegistryServiceOptions } from './index';

const persisted = vi.hoisted(() => ({
  value: {
    schemaVersion: 1 as const,
    servers: {},
  },
}));

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: vi.fn(async () => structuredClone(persisted.value)),
  writePersistedData: vi.fn(async (_name, _schema, value) => {
    persisted.value = structuredClone(value);
  }),
}));

import { McpRegistryService } from './index';

type CreateHostOptions = Parameters<
  NonNullable<McpRegistryServiceOptions['createHost']>
>[0];

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeCredentialsService(): CredentialsService {
  return {
    resolveSecretField: vi.fn(async () => null),
  } as unknown as CredentialsService;
}

function makeHost(): McpHostController & {
  connectServer: ReturnType<typeof vi.fn>;
  disconnectServer: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  listResourceTemplates: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
  listPrompts: ReturnType<typeof vi.fn>;
  getPrompt: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  finishOAuth: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
} {
  return {
    connectServer: vi.fn(async () => 'connected' as const),
    disconnectServer: vi.fn(async () => undefined),
    listTools: vi.fn(async () => []),
    listResources: vi.fn(async () => ({ resources: [] })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    callTool: vi.fn(async () => ({ content: [] })),
    finishOAuth: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  };
}

function enabledLocalServer(id = 'local-test') {
  return {
    id,
    displayName: 'Local Test',
    enabled: true,
    source: { kind: 'user' as const },
    transport: {
      type: 'stdio' as const,
      command: '/usr/local/bin/example-mcp',
      args: [],
      env: {},
    },
    policy: { default: 'ask' as const, tools: {} },
  };
}

function readDataTool() {
  return {
    name: 'read_data',
    title: 'Read data',
    description: 'Reads bounded test data',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
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

describe('McpRegistryService', () => {
  beforeEach(() => {
    persisted.value = {
      schemaVersion: 1,
      servers: {},
    };
  });

  it('persists user MCP configuration through encrypted persisted-data options', async () => {
    const host = makeHost();
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });

    await service.upsertServer({
      id: 'local-test',
      displayName: 'Local Test',
      enabled: false,
      source: { kind: 'user' },
      transport: {
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        args: [],
        env: {},
      },
      policy: { default: 'ask', tools: {} },
    });

    expect(service.snapshot().servers['local-test']).toMatchObject({
      id: 'local-test',
      enabled: false,
      transport: { type: 'stdio' },
    });
    expect(persisted.value.servers).toHaveProperty('local-test');
    expect(host.connectServer).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('resolves credential references without persisting raw secret values', async () => {
    const host = makeHost();
    const credentialsService = {
      resolveSecretField: vi.fn(async () => ({
        value: 'top-secret-token',
        allowedOrigins: ['https://api.github.com'],
      })),
    } as unknown as CredentialsService;
    const options: McpRegistryServiceOptions = {
      logger: makeLogger(),
      credentialsService,
      createHost: async () => host,
    };
    const service = await McpRegistryService.create(options);

    await service.upsertServer({
      id: 'github-local',
      displayName: 'GitHub Local',
      enabled: true,
      source: { kind: 'user' },
      transport: {
        type: 'stdio',
        command: '/usr/local/bin/github-mcp',
        args: [],
        env: {
          GITHUB_TOKEN: {
            kind: 'credential',
            credentialId: 'github-pat',
            field: 'token',
          },
        },
      },
      policy: { default: 'ask', tools: {} },
    });

    expect(host.connectServer).toHaveBeenCalledWith(
      'github-local',
      expect.objectContaining({
        type: 'stdio',
        env: expect.objectContaining({
          GITHUB_TOKEN: 'top-secret-token',
        }),
      }),
      ['top-secret-token'],
    );
    expect(JSON.stringify(persisted.value)).not.toContain('top-secret-token');
    await service.teardown();
  });

  it('enforces allowed origins for remote credential headers', async () => {
    const host = makeHost();
    const credentialsService = {
      resolveSecretField: vi.fn(async () => ({
        value: 'top-secret-token',
        allowedOrigins: ['https://api.github.com'],
      })),
    } as unknown as CredentialsService;
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService,
      createHost: async () => host,
    });

    await expect(
      service.upsertServer({
        id: 'remote-test',
        displayName: 'Remote Test',
        enabled: true,
        source: { kind: 'user' },
        transport: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/rpc',
          headers: {
            Authorization: {
              kind: 'credential',
              credentialId: 'github-pat',
              field: 'token',
            },
          },
        },
        policy: { default: 'ask', tools: {} },
      }),
    ).rejects.toThrow('not allowed for origin');
    expect(host.connectServer).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('reserves the Clodex session credential for built-in services', async () => {
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => makeHost(),
    });

    await expect(
      service.upsertServer({
        id: 'custom-clodex-session',
        displayName: 'Custom Clodex Session',
        enabled: false,
        source: { kind: 'user' },
        transport: {
          type: 'streamable-http',
          url: 'https://clodex.xyz/mcp',
          headers: {
            Authorization: {
              kind: 'credential',
              credentialId: 'clodex-auth',
              field: 'accessToken',
            },
          },
        },
        policy: { default: 'ask', tools: {} },
      }),
    ).rejects.toThrow('reserved for built-in services');
    await service.teardown();
  });

  it('synchronizes plugin servers without overwriting user enablement and policy', async () => {
    const host = makeHost();
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    const pluginServer = {
      id: 'plugin.example.gateway',
      displayName: 'Example: Gateway',
      enabled: false,
      source: {
        kind: 'plugin' as const,
        pluginId: 'example',
        pluginVersion: '1.0.0',
      },
      transport: {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com/rpc',
        headers: {},
      },
      policy: { default: 'ask' as const, tools: {} },
    };
    await service.syncPluginServers([pluginServer]);
    await service.setEnabled(pluginServer.id, true);

    await service.syncPluginServers([
      {
        ...pluginServer,
        source: { ...pluginServer.source, pluginVersion: '1.1.0' },
        transport: {
          ...pluginServer.transport,
          url: 'https://mcp.example.com/v2/rpc',
        },
      },
    ]);

    expect(service.snapshot().servers[pluginServer.id]).toMatchObject({
      enabled: true,
      source: { pluginVersion: '1.1.0' },
      transport: { url: 'https://mcp.example.com/v2/rpc' },
      policy: { default: 'ask' },
    });
    await service.syncPluginServers([]);
    expect(service.snapshot().servers[pluginServer.id]).toBeUndefined();
    await service.teardown();
  });

  it('completes a one-time OAuth callback and reconnects the server', async () => {
    const host = makeHost();
    host.connectServer
      .mockResolvedValueOnce('authorization-required')
      .mockResolvedValueOnce('connected');
    const oauthService = {
      resolveRuntimeConfig: vi.fn(() => ({
        clientRegistrationId: 'clodex-dynamic',
        redirectUrl: 'clodex-ide://mcp/oauth/callback',
        scopes: ['mcp:tools'],
        clientMetadata: {
          redirect_uris: ['clodex-ide://mcp/oauth/callback'],
        },
        allowedAuthorizationOrigins: ['https://mcp.example.com'],
      })),
      consumeCallback: vi.fn(async () => ({
        serverId: 'remote-oauth',
        authorizationCode: 'authorization-code',
      })),
      handleHostRequest: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        configured: false,
        authorizationPending: true,
      })),
      clearServer: vi.fn(async () => undefined),
    } as unknown as McpOAuthService;
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      oauthService,
      createHost: async () => host,
    });

    await service.upsertServer({
      id: 'remote-oauth',
      displayName: 'Remote OAuth',
      enabled: true,
      source: { kind: 'user' },
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: {},
        oauth: {
          clientRegistrationId: 'clodex-dynamic',
          scopes: ['mcp:tools'],
          redirectMode: 'custom-scheme',
        },
      },
      policy: { default: 'ask', tools: {} },
    });
    expect(service.listRuntimeStates()[0]?.status).toBe(
      'authorization-required',
    );

    await expect(
      service.handleOAuthCallback(
        'clodex-ide://mcp/oauth/callback?code=authorization-code&state=state',
      ),
    ).resolves.toBe(true);
    expect(host.finishOAuth).toHaveBeenCalledWith(
      'remote-oauth',
      'authorization-code',
    );
    expect(service.listRuntimeStates()[0]?.status).toBe('connected');
    await service.teardown();
  });

  it('aggregates paginated context catalogs and reuses the bounded cache', async () => {
    const host = makeHost();
    host.listResources
      .mockResolvedValueOnce({
        resources: [{ uri: 'smoke://fixture/one', name: 'One' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        resources: [{ uri: 'smoke://fixture/two', name: 'Two' }],
      });
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    await service.upsertServer(enabledLocalServer());

    await expect(service.listResources('local-test')).resolves.toEqual([
      expect.objectContaining({ name: 'One' }),
      expect.objectContaining({ name: 'Two' }),
    ]);
    await expect(service.listResources('local-test')).resolves.toHaveLength(2);
    expect(host.listResources).toHaveBeenCalledTimes(2);
    expect(host.listResources).toHaveBeenNthCalledWith(
      2,
      'local-test',
      'page-2',
    );
    await service.teardown();
  });

  it('rejects repeated pagination cursors', async () => {
    const host = makeHost();
    host.listResources
      .mockResolvedValueOnce({
        resources: [],
        nextCursor: 'repeated',
      })
      .mockResolvedValueOnce({
        resources: [],
        nextCursor: 'repeated',
      });
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    await service.upsertServer(enabledLocalServer());

    await expect(service.listResources('local-test')).rejects.toThrow(
      'pagination cursor repeated',
    );
    await service.teardown();
  });

  it('rejects context catalogs larger than 5000 items', async () => {
    const host = makeHost();
    host.listResources.mockResolvedValueOnce({
      resources: Array.from({ length: 5_001 }, (_, index) => ({
        uri: `smoke://fixture/${index}`,
        name: `Resource ${index}`,
      })),
    });
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    await service.upsertServer(enabledLocalServer());

    await expect(service.listResources('local-test')).rejects.toThrow(
      'exceeds 5000 items',
    );
    await service.teardown();
  });

  it('rejects context pagination beyond 100 pages', async () => {
    const host = makeHost();
    let page = 0;
    host.listPrompts.mockImplementation(async () => {
      page += 1;
      return {
        prompts: [{ name: `prompt-${page}` }],
        nextCursor: `page-${page + 1}`,
      };
    });
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    await service.upsertServer(enabledLocalServer());

    await expect(service.listPrompts('local-test')).rejects.toThrow(
      'exceeds 100 pages',
    );
    expect(host.listPrompts).toHaveBeenCalledTimes(100);
    await service.teardown();
  });

  it('delegates the dispatch fence to the host final-dispatch boundary', async () => {
    const host = makeHost();
    let releaseHostReadiness!: () => void;
    const hostReadiness = new Promise<void>((resolve) => {
      releaseHostReadiness = resolve;
    });
    const hostDispatch = vi.fn();
    host.callTool.mockImplementation(
      async (
        _serverId: string,
        _toolName: string,
        _args: Record<string, unknown>,
        options?: { beforeDispatch?: () => void },
      ) => {
        await hostReadiness;
        options?.beforeDispatch?.();
        hostDispatch();
        return { content: [] };
      },
    );
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    await service.upsertServer(enabledLocalServer());

    let revoked = false;
    const beforeDispatch = vi.fn(() => {
      if (revoked) throw new Error('Host generation was revoked');
    });
    const result = service.callTool(
      'local-test',
      'read_data',
      {},
      { beforeDispatch },
    );
    const rejection = expect(result).rejects.toThrow(
      'Host generation was revoked',
    );
    await vi.waitFor(() => expect(host.callTool).toHaveBeenCalledTimes(1));

    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(host.callTool).toHaveBeenCalledWith(
      'local-test',
      'read_data',
      {},
      expect.objectContaining({ beforeDispatch }),
    );

    revoked = true;
    releaseHostReadiness();
    await rejection;
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(hostDispatch).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('advances configurationRevision across upsert, reconnect, and policy mutations', async () => {
    const host = makeHost();
    host.listTools.mockResolvedValue([readDataTool()]);
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });

    await service.upsertServer(enabledLocalServer());
    await service.listTools('local-test');
    const initial = service.getToolDispatchSnapshot('local-test', 'read_data');

    await service.upsertServer({
      ...enabledLocalServer(),
      displayName: 'Reconfigured Local Test',
    });
    await service.listTools('local-test');
    const afterUpsert = service.getToolDispatchSnapshot(
      'local-test',
      'read_data',
    );

    await service.restartServer('local-test');
    await service.listTools('local-test');
    const afterReconnect = service.getToolDispatchSnapshot(
      'local-test',
      'read_data',
    );

    await service.setPolicy('local-test', {
      default: 'deny',
      tools: { read_data: 'allow' },
    });
    const afterPolicy = service.getToolDispatchSnapshot(
      'local-test',
      'read_data',
    );

    expect(afterUpsert.runtime.configurationRevision).toBeGreaterThan(
      initial.runtime.configurationRevision,
    );
    expect(afterReconnect.runtime.configurationRevision).toBeGreaterThan(
      afterUpsert.runtime.configurationRevision,
    );
    expect(afterPolicy.runtime.configurationRevision).toBeGreaterThan(
      afterReconnect.runtime.configurationRevision,
    );
    expect(afterPolicy.server.policy).toEqual({
      default: 'deny',
      tools: { read_data: 'allow' },
    });
    await service.teardown();
  });

  it('detects transient A-to-B-to-A server drift at the final dispatch fence', async () => {
    const host = makeHost();
    const effect = vi.fn();
    host.listTools.mockResolvedValue([readDataTool()]);
    host.callTool.mockImplementation(
      async (
        _serverId: string,
        _toolName: string,
        _args: Record<string, unknown>,
        options?: { beforeDispatch?: () => void },
      ) => {
        options?.beforeDispatch?.();
        effect();
        return { content: [] };
      },
    );
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });
    const configurationA = enabledLocalServer();
    const configurationB = {
      ...enabledLocalServer(),
      transport: {
        ...enabledLocalServer().transport,
        command: '/usr/local/bin/reconfigured-example-mcp',
      },
    };

    await service.upsertServer(configurationA);
    await service.listTools('local-test');
    const reviewed = service.getToolDispatchSnapshot('local-test', 'read_data');

    await service.upsertServer(configurationB);
    await service.upsertServer(configurationA);
    await service.listTools('local-test');
    const beforeDispatch = service.getToolDispatchSnapshot(
      'local-test',
      'read_data',
    );

    expect(beforeDispatch.server).toEqual(reviewed.server);
    expect(beforeDispatch.descriptor).toEqual(reviewed.descriptor);
    expect(beforeDispatch.runtime).toMatchObject({
      restartCount: reviewed.runtime.restartCount,
      catalogRevision: reviewed.runtime.catalogRevision,
    });
    expect(beforeDispatch.runtime.configurationRevision).toBeGreaterThan(
      reviewed.runtime.configurationRevision,
    );

    const finalFence = vi.fn(() => {
      const current = service.getToolDispatchSnapshot(
        'local-test',
        'read_data',
      );
      if (
        current.runtime.configurationRevision !==
        reviewed.runtime.configurationRevision
      ) {
        throw new Error('MCP server configuration generation changed');
      }
    });
    await expect(
      service.callTool(
        'local-test',
        'read_data',
        {},
        {
          beforeDispatch: finalFence,
        },
      ),
    ).rejects.toThrow('MCP server configuration generation changed');
    expect(finalFence).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('serializes parallel connects so a stale completion cannot replace the current host', async () => {
    persisted.value = {
      schemaVersion: 1,
      servers: { 'local-test': enabledLocalServer() },
    };
    const host = makeHost();
    const firstConnect = deferred<void>();
    let activeConnection: 'A' | 'B' | null = null;
    let connectAttempt = 0;
    host.connectServer.mockImplementation(async () => {
      connectAttempt += 1;
      if (connectAttempt === 1) {
        await firstConnect.promise;
        activeConnection = 'A';
      } else {
        activeConnection = 'B';
      }
      return 'connected' as const;
    });
    host.disconnectServer.mockImplementation(async () => {
      activeConnection = null;
    });
    host.listTools.mockImplementation(async () => [
      {
        ...readDataTool(),
        title: `Descriptor from ${activeConnection ?? 'no connection'}`,
      },
    ]);
    host.callTool.mockImplementation(async () => ({ activeConnection }));
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });

    const firstList = service.listTools('local-test');
    const firstRejection = expect(firstList).rejects.toThrow(
      'connection was superseded',
    );
    await vi.waitFor(() => expect(host.connectServer).toHaveBeenCalledTimes(1));

    const secondList = service.listTools('local-test');
    await Promise.resolve();
    expect(host.connectServer).toHaveBeenCalledTimes(1);

    firstConnect.resolve();
    await firstRejection;
    await expect(secondList).resolves.toEqual([
      expect.objectContaining({ title: 'Descriptor from B' }),
    ]);
    expect(host.connectServer).toHaveBeenCalledTimes(2);
    expect(host.disconnectServer).toHaveBeenCalledTimes(1);

    const dispatchSnapshot = service.getToolDispatchSnapshot(
      'local-test',
      'read_data',
    );
    expect(dispatchSnapshot.descriptor.title).toBe('Descriptor from B');
    await expect(
      service.callTool('local-test', 'read_data', {}),
    ).resolves.toEqual({ activeConnection: 'B' });
    await service.teardown();
  });

  it('cannot create or publish a host after teardown begins during transport resolution', async () => {
    persisted.value = {
      schemaVersion: 1,
      servers: {
        'local-test': {
          ...enabledLocalServer(),
          transport: {
            ...enabledLocalServer().transport,
            env: {
              TEST_TOKEN: {
                kind: 'credential' as const,
                credentialId: 'test-token',
                field: 'value',
              },
            },
          },
        },
      },
    };
    const credential = deferred<{
      value: string;
      allowedOrigins: string[];
    } | null>();
    const credentialsService = {
      resolveSecretField: vi.fn(async () => await credential.promise),
    } as unknown as CredentialsService;
    const createHost = vi.fn(async () => makeHost());
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService,
      createHost,
    });

    const list = service.listTools('local-test');
    const listRejection = expect(list).rejects.toThrow('has been disposed');
    await vi.waitFor(() =>
      expect(credentialsService.resolveSecretField).toHaveBeenCalledTimes(1),
    );

    const teardown = service.teardown();
    credential.resolve({ value: 'secret', allowedOrigins: [] });

    await listRejection;
    await teardown;
    expect(createHost).not.toHaveBeenCalled();
  });

  it('tears down a host whose creation completes after registry teardown starts', async () => {
    persisted.value = {
      schemaVersion: 1,
      servers: { 'local-test': enabledLocalServer() },
    };
    const host = makeHost();
    const hostCreation = deferred<McpHostController>();
    const createHost = vi.fn(async () => await hostCreation.promise);
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost,
    });

    const list = service.listTools('local-test');
    const listRejection = expect(list).rejects.toThrow('has been disposed');
    await vi.waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));

    const teardown = service.teardown();
    hostCreation.resolve(host);

    await listRejection;
    await teardown;
    expect(host.connectServer).not.toHaveBeenCalled();
    expect(host.teardown).toHaveBeenCalledTimes(1);
  });

  it('updates cached catalogs and catalogRevision after list-changed', async () => {
    const host = makeHost();
    let onListChanged: CreateHostOptions['onListChanged'];
    host.listResources.mockResolvedValueOnce({
      resources: [{ uri: 'smoke://fixture/old', name: 'Old' }],
    });
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async (options) => {
        onListChanged = options.onListChanged;
        return host;
      },
    });
    await service.upsertServer(enabledLocalServer());
    await expect(service.listResources('local-test')).resolves.toEqual([
      expect.objectContaining({ name: 'Old' }),
    ]);

    onListChanged?.('local-test', 'resources', [
      { uri: 'smoke://fixture/new', name: 'New' },
    ]);

    await expect(service.listResources('local-test')).resolves.toEqual([
      expect.objectContaining({ name: 'New' }),
    ]);
    expect(host.listResources).toHaveBeenCalledTimes(1);
    expect(service.listRuntimeStates()[0]?.catalogRevision).toBe(1);
    await service.teardown();
  });

  it('does not publish a catalog result captured before a reconnect revision', async () => {
    persisted.value = {
      schemaVersion: 1,
      servers: { 'local-test': enabledLocalServer() },
    };
    const host = makeHost();
    const staleTools =
      deferred<Awaited<ReturnType<McpHostController['listTools']>>>();
    host.listTools
      .mockImplementationOnce(async () => await staleTools.promise)
      .mockResolvedValueOnce([
        { ...readDataTool(), title: 'Descriptor from connection B' },
      ]);
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async () => host,
    });

    const staleList = service.listTools('local-test');
    await vi.waitFor(() => expect(host.listTools).toHaveBeenCalledTimes(1));
    await service.connectServer('local-test');
    staleTools.resolve([
      { ...readDataTool(), title: 'Descriptor from connection A' },
    ]);

    await expect(staleList).rejects.toThrow('connection was superseded');
    await expect(service.listTools('local-test')).resolves.toEqual([
      expect.objectContaining({ title: 'Descriptor from connection B' }),
    ]);
    expect(
      service.getToolDispatchSnapshot('local-test', 'read_data').descriptor
        .title,
    ).toBe('Descriptor from connection B');
    await service.teardown();
  });

  it('drops list-changed cache publication while a reconnect is in flight', async () => {
    persisted.value = {
      schemaVersion: 1,
      servers: { 'local-test': enabledLocalServer() },
    };
    const host = makeHost();
    const reconnectStarted = deferred<void>();
    const releaseReconnect = deferred<void>();
    let connectCount = 0;
    host.connectServer.mockImplementation(async () => {
      connectCount += 1;
      if (connectCount === 2) {
        reconnectStarted.resolve();
        await releaseReconnect.promise;
      }
      return 'connected' as const;
    });
    host.listTools
      .mockResolvedValueOnce([
        { ...readDataTool(), title: 'Initial descriptor' },
      ])
      .mockResolvedValueOnce([
        { ...readDataTool(), title: 'Descriptor from connection B' },
      ]);
    let onListChanged: CreateHostOptions['onListChanged'];
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async (options) => {
        onListChanged = options.onListChanged;
        return host;
      },
    });
    await service.listTools('local-test');

    const reconnect = service.connectServer('local-test');
    await reconnectStarted.promise;
    onListChanged?.('local-test', 'tools', [
      { ...readDataTool(), title: 'Stale descriptor from connection A' },
    ]);
    releaseReconnect.resolve();
    await reconnect;

    await expect(service.listTools('local-test')).resolves.toEqual([
      expect.objectContaining({ title: 'Descriptor from connection B' }),
    ]);
    expect(host.listTools).toHaveBeenCalledTimes(2);
    await service.teardown();
  });

  it('forwards elicitation to the current handler and cancels without one', async () => {
    const host = makeHost();
    let onElicitationRequest: CreateHostOptions['onElicitationRequest'];
    const service = await McpRegistryService.create({
      logger: makeLogger(),
      credentialsService: makeCredentialsService(),
      createHost: async (options) => {
        onElicitationRequest = options.onElicitationRequest;
        return host;
      },
    });
    await service.upsertServer(enabledLocalServer());
    const request = {
      message: 'Choose an environment.',
      fields: [
        {
          id: 'environment',
          kind: 'select' as const,
          label: 'Environment',
          required: true,
          options: [
            { value: 'staging', label: 'Staging' },
            { value: 'production', label: 'Production' },
          ],
        },
      ],
    };
    const signal = new AbortController().signal;

    await expect(
      onElicitationRequest?.('local-test', 'agent-1', request, signal),
    ).resolves.toEqual({ action: 'cancel' });

    const handler = vi.fn(async () => ({
      action: 'accept' as const,
      content: { environment: 'staging' },
    }));
    service.setElicitationHandler(handler);

    await expect(
      onElicitationRequest?.('local-test', 'agent-1', request, signal),
    ).resolves.toEqual({
      action: 'accept',
      content: { environment: 'staging' },
    });
    expect(handler).toHaveBeenCalledWith(
      'local-test',
      'agent-1',
      request,
      signal,
    );
    await service.teardown();
  });
});
