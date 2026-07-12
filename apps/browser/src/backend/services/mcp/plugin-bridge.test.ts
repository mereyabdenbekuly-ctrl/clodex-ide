import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginMarketplaceLockEntry } from '@shared/plugin-marketplace';
import { discoverPluginMcpServers } from './plugin-bridge';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-plugin-mcp-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('plugin MCP bridge', () => {
  it('discovers remote MCP declarations from signed installed plugins', async () => {
    const plugin = makePlugin();
    await writeServers(plugin.id, {
      schemaVersion: 1,
      servers: [
        {
          id: 'gateway',
          displayName: 'Gateway',
          enabledByDefault: true,
          transport: {
            type: 'streamable-http',
            url: 'https://mcp.example.com/rpc',
            headers: {},
          },
          policy: { default: 'allow-read-only', tools: {} },
        },
      ],
    });

    await expect(
      discoverPluginMcpServers({ installedDir: root, installed: [plugin] }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'plugin.example-plugin.gateway',
        enabled: false,
        source: {
          kind: 'plugin',
          pluginId: 'example-plugin',
          pluginVersion: '1.0.0',
        },
        policy: { default: 'ask', tools: {} },
      }),
    ]);
  });

  it('rejects credentials not declared by the plugin manifest', async () => {
    const plugin = makePlugin({
      permissions: ['mcp', 'network', 'credentials'],
    });
    await writeServers(plugin.id, {
      schemaVersion: 1,
      servers: [
        {
          id: 'gateway',
          displayName: 'Gateway',
          transport: {
            type: 'streamable-http',
            url: 'https://api.github.com/mcp',
            headers: {
              Authorization: {
                kind: 'credential',
                credentialId: 'github-pat',
                field: 'token',
              },
            },
          },
        },
      ],
    });

    await expect(
      discoverPluginMcpServers({ installedDir: root, installed: [plugin] }),
    ).rejects.toThrow('references undeclared credential');
  });

  it('rejects plugin executables while the feature gate is disabled', async () => {
    const plugin = makePlugin({ permissions: ['mcp', 'process'] });
    await writeServers(plugin.id, {
      schemaVersion: 1,
      servers: [
        {
          id: 'local',
          displayName: 'Local',
          runtimeId: 'local-runtime',
          transport: {
            type: 'stdio',
            command: 'runtime-placeholder',
            args: [],
            env: {},
          },
        },
      ],
    });

    await expect(
      discoverPluginMcpServers({ installedDir: root, installed: [plugin] }),
    ).rejects.toThrow('executable extensions are disabled');
  });

  it('binds an integrity-checked plugin runtime to a stdio MCP server', async () => {
    const plugin = makePlugin({ permissions: ['mcp', 'process'] });
    const executable =
      process.platform === 'win32' ? 'server.cmd' : 'server.sh';
    const content =
      process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n';
    const runtimeDir = path.join(root, plugin.id, 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, executable), content, {
      mode: 0o755,
    });
    await fs.writeFile(
      path.join(runtimeDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        runtimes: [
          {
            id: 'local-runtime',
            kind: 'executable',
            entrypoint: `runtime/${executable}`,
            sha256: createHash('sha256').update(content).digest('hex'),
            args: ['--plugin'],
            platforms: [process.platform],
            architectures: [process.arch],
            limits: { maxMemoryMb: 256, requestTimeoutMs: 30_000 },
          },
        ],
      }),
    );
    await writeServers(plugin.id, {
      schemaVersion: 1,
      servers: [
        {
          id: 'local',
          displayName: 'Local',
          runtimeId: 'local-runtime',
          transport: {
            type: 'stdio',
            command: 'runtime-placeholder',
            args: ['--mcp'],
            env: {},
          },
        },
      ],
    });

    const result = await discoverPluginMcpServers({
      installedDir: root,
      installed: [plugin],
      isExecutableRuntimeEnabled: () => true,
    });

    expect(result[0]).toMatchObject({
      id: 'plugin.example-plugin.local',
      source: {
        executableRuntimePolicy: {
          kind: 'plugin-executable',
          pluginId: 'example-plugin',
          runtimeId: 'local-runtime',
          pluginRoot: path.join(root, plugin.id),
          allowNetwork: false,
          allowFilesystem: false,
          maxMemoryMb: 256,
          requestTimeoutMs: 30_000,
        },
      },
      transport: {
        type: 'stdio',
        args: ['--plugin', '--mcp'],
      },
    });
    expect((result[0]?.transport as { command: string }).command).toContain(
      executable,
    );
  });

  it('requires network permission for remote MCP declarations', async () => {
    const plugin = makePlugin({ permissions: ['mcp'] });
    await writeServers(plugin.id, {
      schemaVersion: 1,
      servers: [
        {
          id: 'gateway',
          displayName: 'Gateway',
          transport: {
            type: 'streamable-http',
            url: 'https://mcp.example.com/rpc',
            headers: {},
          },
        },
      ],
    });

    await expect(
      discoverPluginMcpServers({ installedDir: root, installed: [plugin] }),
    ).rejects.toThrow('without network permission');
  });

  it('ignores MCP files from plugins without the mcp permission', async () => {
    const plugin = makePlugin({ permissions: ['network'] });
    await writeServers(plugin.id, {
      schemaVersion: 1,
      servers: [
        {
          id: 'gateway',
          displayName: 'Gateway',
          transport: {
            type: 'streamable-http',
            url: 'https://mcp.example.com/rpc',
            headers: {},
          },
        },
      ],
    });

    await expect(
      discoverPluginMcpServers({ installedDir: root, installed: [plugin] }),
    ).resolves.toEqual([]);
  });
});

function makePlugin(
  overrides: {
    permissions?: PluginMarketplaceLockEntry['manifest']['permissions'];
  } = {},
): PluginMarketplaceLockEntry {
  return {
    id: 'example-plugin',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    source: 'official',
    installedAt: 1,
    updatedAt: 1,
    manifest: {
      schemaVersion: 1,
      id: 'example-plugin',
      version: '1.0.0',
      displayName: 'Example Plugin',
      description: 'Example',
      publisher: 'Clodex Labs',
      compatibility: { minAppVersion: '1.16.0' },
      permissions: overrides.permissions ?? ['mcp', 'network'],
      requiredCredentials: [],
      mcpServers: [
        {
          id: 'gateway',
          displayName: 'Gateway',
          transport: 'streamable-http',
          endpoint: 'https://mcp.example.com/rpc',
          authentication: 'none',
        },
      ],
    },
  };
}

async function writeServers(pluginId: string, value: unknown): Promise<void> {
  const directory = path.join(root, pluginId, 'mcp');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'servers.json'),
    JSON.stringify(value),
  );
}
