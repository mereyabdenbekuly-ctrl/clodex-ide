import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger';

const persisted = vi.hoisted(() => ({
  value: {
    schemaVersion: 1 as const,
    sessions: {},
  },
}));

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: vi.fn(async () => structuredClone(persisted.value)),
  writePersistedData: vi.fn(async (_name, _schema, value) => {
    persisted.value = structuredClone(value);
  }),
}));

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
}));

import { McpOAuthService } from './oauth';

const server = {
  id: 'remote-test',
  displayName: 'Remote Test',
  enabled: true,
  source: { kind: 'user' as const },
  transport: {
    type: 'streamable-http' as const,
    url: 'https://mcp.example.com/rpc',
    headers: {},
    oauth: {
      clientRegistrationId: 'clodex-dynamic',
      scopes: ['mcp:tools'],
      redirectMode: 'custom-scheme' as const,
    },
  },
  policy: { default: 'ask' as const, tools: {} },
};

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('McpOAuthService', () => {
  beforeEach(() => {
    persisted.value = {
      schemaVersion: 1,
      sessions: {},
    };
  });

  it('keeps OAuth config secret-free and binds dynamic registration to server origin', async () => {
    const service = await McpOAuthService.create({
      logger: makeLogger(),
      openExternal: vi.fn(async () => undefined),
    });
    expect(service.resolveRuntimeConfig(server)).toMatchObject({
      clientRegistrationId: 'clodex-dynamic',
      redirectUrl: 'clodex-ide://mcp/oauth/callback',
      allowedAuthorizationOrigins: ['https://mcp.example.com'],
      scopes: ['mcp:tools'],
    });
    expect(JSON.stringify(server)).not.toContain('access_token');
    await service.teardown();
  });

  it('validates state, redirect URI, PKCE, and one-time callback consumption', async () => {
    const openExternal = vi.fn(async () => undefined);
    const service = await McpOAuthService.create({
      logger: makeLogger(),
      openExternal,
    });
    const state = await service.handleHostRequest(server, {
      operation: 'prepare-state',
    });
    await service.handleHostRequest(server, {
      operation: 'save-code-verifier',
      codeVerifier: 'v'.repeat(64),
    });
    const authorizationUrl = new URL('https://mcp.example.com/authorize');
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set(
      'redirect_uri',
      'clodex-ide://mcp/oauth/callback',
    );
    authorizationUrl.searchParams.set('client_id', 'dynamic-client');
    authorizationUrl.searchParams.set('state', String(state));
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('code_challenge', 'challenge');
    await service.handleHostRequest(server, {
      operation: 'open-authorization',
      authorizationUrl: authorizationUrl.toString(),
    });
    expect(openExternal).toHaveBeenCalledTimes(1);

    const callback = `clodex-ide://mcp/oauth/callback?code=code-1&state=${String(state)}`;
    await expect(service.consumeCallback(callback)).resolves.toEqual({
      serverId: 'remote-test',
      authorizationCode: 'code-1',
    });
    await expect(
      service.handleHostRequest(server, {
        operation: 'load-code-verifier',
      }),
    ).resolves.toBe('v'.repeat(64));
    await expect(service.consumeCallback(callback)).rejects.toThrow(
      'already used',
    );
    await service.teardown();
  });

  it('rejects authorization and discovery endpoints outside the registered origin', async () => {
    const service = await McpOAuthService.create({
      logger: makeLogger(),
      openExternal: vi.fn(async () => undefined),
    });
    const state = await service.handleHostRequest(server, {
      operation: 'prepare-state',
    });
    const url = new URL('https://attacker.example/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', 'clodex-ide://mcp/oauth/callback');
    url.searchParams.set('client_id', 'dynamic-client');
    url.searchParams.set('state', String(state));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', 'challenge');
    await expect(
      service.handleHostRequest(server, {
        operation: 'open-authorization',
        authorizationUrl: url.toString(),
      }),
    ).rejects.toThrow('not allowed');
    await service.teardown();
  });

  it('persists tokens only in the encrypted OAuth session store', async () => {
    const service = await McpOAuthService.create({
      logger: makeLogger(),
      openExternal: vi.fn(async () => undefined),
    });
    await service.handleHostRequest(server, {
      operation: 'save-tokens',
      value: {
        access_token: 'top-secret-access-token',
        refresh_token: 'top-secret-refresh-token',
        token_type: 'Bearer',
      },
    });
    expect(JSON.stringify(persisted.value)).toContain(
      'top-secret-access-token',
    );
    expect(JSON.stringify(server)).not.toContain('top-secret-access-token');
    expect(service.getStatus(server.id)).toEqual({
      configured: true,
      authorizationPending: false,
    });
    await service.teardown();
  });
});
