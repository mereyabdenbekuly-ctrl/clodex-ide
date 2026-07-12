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
