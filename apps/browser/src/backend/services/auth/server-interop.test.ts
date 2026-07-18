import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronShell = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.hoisted(() => {
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-observed');
  process.env.API_URL = 'https://clodex.test/api/';
  delete process.env.CLODEX_API_URL;
  delete process.env.CLODEX_IDE_CLIENT_ID;
});

vi.mock('electron', () => ({ shell: electronShell }));

import {
  createClodexBrowserAuthRequest,
  createClodexBrowserAuthState,
} from './server-interop';

describe('CLODEx browser PKCE request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronShell.openExternal.mockResolvedValue(undefined);
  });

  it('keeps the verifier local and opens the strict observed authorization URL', async () => {
    const state = createClodexBrowserAuthState();
    const request = createClodexBrowserAuthRequest({
      redirectUri: 'http://127.0.0.1:43123/auth/callback',
      state,
    });

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.clientId).toBe('clodex-community-observed');

    await request.open();
    expect(electronShell.openExternal).toHaveBeenCalledOnce();
    const [rawUrl, options] = electronShell.openExternal.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe(
      'https://clodex.test/api/v1/auth/electron/start',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'clodex-community-observed',
      redirect_uri: 'http://127.0.0.1:43123/auth/callback',
      code_challenge: createHash('sha256')
        .update(request.codeVerifier)
        .digest('base64url'),
      code_challenge_method: 'S256',
      state,
    });
    expect(rawUrl).not.toContain(request.codeVerifier);
    expect(options).toEqual({ activate: true });
  });
});
