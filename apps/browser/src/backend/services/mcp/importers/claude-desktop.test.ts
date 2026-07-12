import { describe, expect, it } from 'vitest';
import {
  materializeClaudeDesktopMcpImport,
  previewClaudeDesktopMcpConfig,
} from './claude-desktop';

describe('Claude Desktop MCP import preview', () => {
  it('never exposes imported secret values in the preview', () => {
    const preview = previewClaudeDesktopMcpConfig(
      {
        mcpServers: {
          github: {
            command: '/usr/local/bin/github-mcp',
            env: {
              GITHUB_TOKEN: 'raw-imported-secret',
              LOG_LEVEL: 'info',
            },
          },
        },
      },
      1,
    );

    expect(preview.servers[0]).toMatchObject({
      sourceName: 'github',
      supported: true,
      readyToImport: false,
      requiredSecrets: [
        {
          key: 'GITHUB_TOKEN',
          target: 'env',
          suggestedCredentialId: 'github-pat',
        },
      ],
    });
    expect(JSON.stringify(preview)).not.toContain('raw-imported-secret');
    expect(preview.servers[0]?.proposedConfig?.transport).toMatchObject({
      type: 'stdio',
      env: {
        LOG_LEVEL: { kind: 'literal', value: 'info' },
      },
    });
  });

  it('materializes an import only after explicit credential mapping', () => {
    const preview = previewClaudeDesktopMcpConfig(
      {
        mcpServers: {
          github: {
            command: '/usr/local/bin/github-mcp',
            env: { GITHUB_TOKEN: 'raw-imported-secret' },
          },
        },
      },
      1,
    );
    const serverId = preview.servers[0]?.proposedId;
    expect(serverId).toBe('github');

    const configs = materializeClaudeDesktopMcpImport(preview, {
      github: {
        'env:GITHUB_TOKEN': {
          kind: 'credential',
          credentialId: 'github-pat',
          field: 'token',
        },
      },
    });
    expect(configs[0]?.transport).toMatchObject({
      type: 'stdio',
      env: {
        GITHUB_TOKEN: {
          kind: 'credential',
          credentialId: 'github-pat',
          field: 'token',
        },
      },
    });
    expect(JSON.stringify(configs)).not.toContain('raw-imported-secret');
  });

  it('marks insecure non-loopback remote URLs as unsupported', () => {
    const preview = previewClaudeDesktopMcpConfig({
      mcpServers: {
        remote: {
          type: 'streamable-http',
          url: 'http://mcp.example.com/rpc',
        },
      },
    });
    expect(preview.servers[0]).toMatchObject({
      supported: false,
      readyToImport: false,
      proposedConfig: null,
    });
  });

  it('detects token-shaped values even under non-sensitive names', () => {
    const preview = previewClaudeDesktopMcpConfig({
      mcpServers: {
        remote: {
          command: '/usr/local/bin/example-mcp',
          env: {
            VALUE: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
          },
        },
      },
    });
    expect(preview.servers[0]).toMatchObject({
      supported: true,
      readyToImport: false,
      requiredSecrets: [{ key: 'VALUE', target: 'env' }],
    });
    expect(JSON.stringify(preview)).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
    );
  });

  it('rejects token-shaped command arguments that cannot become references', () => {
    const preview = previewClaudeDesktopMcpConfig({
      mcpServers: {
        remote: {
          command: '/usr/local/bin/example-mcp',
          args: ['ghp_abcdefghijklmnopqrstuvwxyz123456'],
        },
      },
    });
    expect(preview.servers[0]).toMatchObject({
      supported: false,
      readyToImport: false,
      proposedConfig: null,
    });
    expect(JSON.stringify(preview)).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
    );
  });
});
