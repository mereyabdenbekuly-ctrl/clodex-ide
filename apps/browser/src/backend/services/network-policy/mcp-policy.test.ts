import { describe, expect, it } from 'vitest';
import { createRemoteMcpNetworkPolicy } from './mcp-policy';

describe('createRemoteMcpNetworkPolicy', () => {
  it('allows only the configured MCP and OAuth origins and ports', () => {
    expect(
      createRemoteMcpNetworkPolicy('github', {
        type: 'streamable-http',
        url: 'https://mcp.example.com/v1',
        headers: {},
        oauth: {
          clientRegistrationId: 'client',
          redirectUrl: 'http://127.0.0.1/callback',
          scopes: [],
          clientMetadata: {},
          allowedAuthorizationOrigins: [
            'https://auth.example.com',
            'https://mcp.example.com',
          ],
        },
      }),
    ).toMatchObject({
      id: 'mcp-remote:github',
      mode: 'allowlist',
      allowedHosts: ['mcp.example.com', 'auth.example.com'],
      allowedPorts: [443],
      allowLoopback: false,
      allowPrivateNetworks: false,
      allowIpLiterals: false,
    });
  });

  it('permits loopback only when explicitly configured', () => {
    expect(
      createRemoteMcpNetworkPolicy('local', {
        type: 'sse',
        url: 'http://127.0.0.1:4318/sse',
        headers: {},
      }),
    ).toMatchObject({
      allowedHosts: ['127.0.0.1'],
      allowedPorts: [4318],
      allowLoopback: true,
      allowIpLiterals: true,
    });
  });
});
