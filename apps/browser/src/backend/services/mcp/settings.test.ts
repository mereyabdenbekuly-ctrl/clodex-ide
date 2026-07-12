import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@clodex/mcp-runtime';
import type { CredentialsService } from '../credentials';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from './index';
import { McpSettingsService } from './settings';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function makeKarton() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    handlers,
    service: {
      registerServerProcedureHandler: vi.fn(
        (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(name, handler);
        },
      ),
      removeServerProcedureHandler: vi.fn((name: string) => {
        handlers.delete(name);
      }),
    } as unknown as KartonService,
  };
}

function makeRegistry(initialServers: McpServerConfig[] = []) {
  const servers = Object.fromEntries(
    initialServers.map((server) => [server.id, structuredClone(server)]),
  );
  const runtimeStates = new Map(
    initialServers.map((server) => [
      server.id,
      {
        serverId: server.id,
        status: server.enabled
          ? ('disconnected' as const)
          : ('disabled' as const),
        lastError: null,
        connectedAt: null,
        updatedAt: Date.now(),
        restartCount: 0,
        catalogRevision: 0,
      },
    ]),
  );
  const registry = {
    snapshot: vi.fn(() => ({
      schemaVersion: 1 as const,
      servers: structuredClone(servers),
    })),
    listRuntimeStates: vi.fn(() => [...runtimeStates.values()]),
    getLogs: vi.fn(() => [
      {
        timestamp: Date.now(),
        level: 'error' as const,
        message: 'Authorization: Bearer top-secret-token',
      },
    ]),
    getOAuthStatus: vi.fn(() => null),
    upsertServer: vi.fn(async (server: McpServerConfig) => {
      servers[server.id] = structuredClone(server);
      runtimeStates.set(server.id, {
        serverId: server.id,
        status: server.enabled ? 'disconnected' : 'disabled',
        lastError: null,
        connectedAt: null,
        updatedAt: Date.now(),
        restartCount: 0,
        catalogRevision: 0,
      });
      return server;
    }),
    setEnabled: vi.fn(async (serverId: string, enabled: boolean) => {
      servers[serverId]!.enabled = enabled;
    }),
    setPolicy: vi.fn(
      async (serverId: string, policy: McpServerConfig['policy']) => {
        servers[serverId]!.policy = structuredClone(policy);
      },
    ),
    removeServer: vi.fn(async (serverId: string) => {
      delete servers[serverId];
    }),
    connectServer: vi.fn(async () => undefined),
    disconnectServer: vi.fn(async () => undefined),
    restartServer: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => []),
    listTools: vi.fn(async () => []),
    listResources: vi.fn(async () => []),
    listResourceTemplates: vi.fn(async () => []),
    readResource: vi.fn(async () => ({ contents: [] })),
    listPrompts: vi.fn(async () => []),
    getPrompt: vi.fn(async () => ({ messages: [] })),
  } as unknown as McpRegistryService;
  return { registry, servers };
}

function makeCredentials(): CredentialsService {
  return {
    has: vi.fn((credentialId: string) => credentialId === 'github-pat'),
    listMcpCustomCredentials: vi.fn(() => []),
    setMcpCustomCredential: vi.fn(async () => undefined),
    deleteMcpCustomCredential: vi.fn(async () => undefined),
  } as unknown as CredentialsService;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

async function call<T>(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  name: string,
  ...args: unknown[]
): Promise<T> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing procedure ${name}`);
  return (await handler('test-client', ...args)) as T;
}

describe('McpSettingsService', () => {
  it('returns secret-free snapshots and sanitizes diagnostics', async () => {
    const karton = makeKarton();
    const { registry } = makeRegistry([
      {
        id: 'github-local',
        displayName: 'GitHub Local',
        enabled: false,
        source: { kind: 'user' },
        transport: {
          type: 'stdio',
          command: '/usr/local/bin/github-mcp',
          args: ['--token', 'top-secret-token'],
          env: {
            GITHUB_TOKEN: {
              kind: 'credential',
              credentialId: 'github-pat',
              field: 'token',
            },
          },
        },
        policy: { default: 'ask', tools: {} },
      },
    ]);
    const service = await McpSettingsService.create({
      logger: makeLogger(),
      karton: karton.service,
      registry,
      credentials: makeCredentials(),
    });

    const snapshot = await call<Record<string, unknown>>(
      karton.handlers,
      'mcp.list',
    );
    expect(JSON.stringify(snapshot)).not.toContain('top-secret-token');
    expect(JSON.stringify(snapshot)).toContain('[redacted]');

    const logs = await call<Array<{ message: string }>>(
      karton.handlers,
      'mcp.getLogs',
      'github-local',
    );
    expect(logs[0]?.message).toBe('authorization: [redacted]');
    await service.teardown();
  });

  it('keeps plugin transports managed while allowing policy changes', async () => {
    const karton = makeKarton();
    const { registry } = makeRegistry([
      {
        id: 'plugin.example.remote',
        displayName: 'Example Remote',
        enabled: false,
        source: {
          kind: 'plugin',
          pluginId: 'example',
          pluginVersion: '1.0.0',
        },
        transport: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/rpc',
          headers: {},
        },
        policy: { default: 'ask', tools: {} },
      },
    ]);
    const service = await McpSettingsService.create({
      logger: makeLogger(),
      karton: karton.service,
      registry,
      credentials: makeCredentials(),
    });

    await expect(
      call(karton.handlers, 'mcp.upsert', {
        id: 'plugin.example.remote',
        displayName: 'Tampered',
        enabled: false,
        transport: {
          type: 'streamable-http',
          url: 'https://attacker.example/rpc',
          headers: {},
        },
        policy: { default: 'ask', tools: {} },
      }),
    ).rejects.toThrow('managed by the application');

    await call(karton.handlers, 'mcp.setPolicy', 'plugin.example.remote', {
      default: 'deny',
      tools: {},
    });
    expect(registry.setPolicy).toHaveBeenCalledWith('plugin.example.remote', {
      default: 'deny',
      tools: {},
    });
    await service.teardown();
  });

  it('imports only after an explicit preview and confirmation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-import-'));
    tempDirs.push(directory);
    const configPath = path.join(directory, 'claude_desktop_config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            command: '/usr/local/bin/github-mcp',
            env: { GITHUB_TOKEN: 'raw-token-from-foreign-config' },
          },
        },
      }),
    );
    const karton = makeKarton();
    const { registry, servers } = makeRegistry();
    const service = await McpSettingsService.create({
      logger: makeLogger(),
      karton: karton.service,
      registry,
      credentials: makeCredentials(),
    });

    const preview = await call<{
      previewId: string;
      servers: Array<{
        proposedId: string;
        requiredSecrets: Array<{ target: string; key: string }>;
      }>;
    }>(karton.handlers, 'mcp.previewClaudeDesktopImport', configPath);
    expect(Object.keys(servers)).toHaveLength(0);
    expect(JSON.stringify(preview)).not.toContain(
      'raw-token-from-foreign-config',
    );

    const proposedId = preview.servers[0]!.proposedId;
    await call(karton.handlers, 'mcp.applyClaudeDesktopImport', {
      previewId: preview.previewId,
      serverIds: [proposedId],
      mappings: {
        [proposedId]: {
          'env:GITHUB_TOKEN': {
            kind: 'credential',
            credentialId: 'github-pat',
            field: 'token',
          },
        },
      },
    });

    expect(servers[proposedId]).toMatchObject({
      enabled: false,
      source: { kind: 'imported', importer: 'claude-desktop' },
      transport: {
        env: {
          GITHUB_TOKEN: {
            kind: 'credential',
            credentialId: 'github-pat',
            field: 'token',
          },
        },
      },
    });
    expect(JSON.stringify(servers)).not.toContain(
      'raw-token-from-foreign-config',
    );
    await service.teardown();
  });
});
