import { describe, expect, it } from 'vitest';
import {
  collectCredentialReferences,
  mcpRegistryConfigSchema,
  mcpServerConfigSchema,
  mcpTransportSchema,
} from './config';

describe('MCP config schema', () => {
  it('accepts stdio, Streamable HTTP, and legacy SSE transports', () => {
    expect(
      mcpTransportSchema.parse({
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        args: ['--stdio'],
        env: {},
      }),
    ).toMatchObject({ type: 'stdio' });
    expect(
      mcpTransportSchema.parse({
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: {},
      }),
    ).toMatchObject({ type: 'streamable-http' });
    expect(
      mcpTransportSchema.parse({
        type: 'sse',
        url: 'http://127.0.0.1:3030/sse',
        headers: {},
      }),
    ).toMatchObject({ type: 'sse' });
  });

  it('accepts secret-free OAuth metadata on remote transports', () => {
    expect(
      mcpTransportSchema.parse({
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: {},
        oauth: {
          clientRegistrationId: 'clodex-dynamic',
          scopes: ['mcp:tools', 'mcp:resources'],
          redirectMode: 'custom-scheme',
        },
      }),
    ).toMatchObject({
      oauth: {
        clientRegistrationId: 'clodex-dynamic',
        scopes: ['mcp:tools', 'mcp:resources'],
      },
    });
  });

  it('rejects ambiguous OAuth plus Authorization header configuration', () => {
    expect(() =>
      mcpTransportSchema.parse({
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: {
          Authorization: {
            kind: 'credential',
            credentialId: 'github-pat',
            field: 'token',
          },
        },
        oauth: {
          clientRegistrationId: 'clodex-dynamic',
          scopes: [],
          redirectMode: 'custom-scheme',
        },
      }),
    ).toThrow('may not also configure an Authorization header');
  });

  it('rejects non-loopback plaintext remote MCP URLs', () => {
    expect(() =>
      mcpTransportSchema.parse({
        type: 'streamable-http',
        url: 'http://mcp.example.com/rpc',
        headers: {},
      }),
    ).toThrow('Remote MCP URLs must use HTTPS');
  });

  it('requires credential references for sensitive env and header values', () => {
    expect(() =>
      mcpTransportSchema.parse({
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        env: {
          API_TOKEN: { kind: 'literal', value: 'secret' },
        },
      }),
    ).toThrow('credential reference');
    expect(() =>
      mcpTransportSchema.parse({
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: {
          Authorization: { kind: 'literal', value: 'Bearer secret' },
        },
      }),
    ).toThrow('credential reference');
    expect(() =>
      mcpTransportSchema.parse({
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        env: {
          VALUE: {
            kind: 'literal',
            value: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
          },
        },
      }),
    ).toThrow('credential reference');
  });

  it('rejects credentials embedded in stdio arguments', () => {
    expect(() =>
      mcpTransportSchema.parse({
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        args: ['--token', 'top-secret-token'],
        env: {},
      }),
    ).toThrow('may not be embedded');
    expect(() =>
      mcpTransportSchema.parse({
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        args: ['--authorization=Bearer top-secret-token'],
        env: {},
      }),
    ).toThrow('may not be embedded');
  });

  it('collects and deduplicates credential references', () => {
    const transport = mcpTransportSchema.parse({
      type: 'stdio',
      command: '/usr/local/bin/example-mcp',
      env: {
        GITHUB_TOKEN: {
          kind: 'credential',
          credentialId: 'github-pat',
          field: 'token',
        },
        SECONDARY_TOKEN: {
          kind: 'credential',
          credentialId: 'github-pat',
          field: 'token',
        },
      },
    });
    expect(collectCredentialReferences(transport)).toEqual([
      {
        kind: 'credential',
        credentialId: 'github-pat',
        field: 'token',
      },
    ]);
  });

  it('requires registry keys to match server IDs', () => {
    const server = mcpServerConfigSchema.parse({
      id: 'server-a',
      displayName: 'Server A',
      enabled: true,
      source: { kind: 'user' },
      transport: {
        type: 'stdio',
        command: '/usr/local/bin/example-mcp',
        env: {},
      },
      policy: { default: 'ask', tools: {} },
    });
    expect(() =>
      mcpRegistryConfigSchema.parse({
        schemaVersion: 1,
        servers: { 'server-b': server },
      }),
    ).toThrow('Registry key must match server.id');
  });
});
