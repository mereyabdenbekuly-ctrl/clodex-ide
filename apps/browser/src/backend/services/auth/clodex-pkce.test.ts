import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  process.env.API_URL = 'https://clodex.test/api/';
  delete process.env.CLODEX_API_URL;
  vi.stubGlobal('fetch', fetchMock);
});

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { ClodexAuthInterop } from './clodex';

describe('ClodexAuthInterop PKCE exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            accessToken: 'desktop-access-token',
            user: { id: 'user-1', email: 'person@example.com' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });

  it('uses the same normalized API origin as the browser authorization start', async () => {
    const interop = new ClodexAuthInterop();
    const abortController = new AbortController();

    await expect(
      interop.exchangePkceAuthorizationCode({
        clientId: 'clodex-community-observed',
        code: 'opaque-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:43123/auth/callback',
        signal: abortController.signal,
      }),
    ).resolves.toMatchObject({
      accessToken: 'desktop-access-token',
      user: { id: 'user-1' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://clodex.test/api/v1/auth/electron/token');
    expect(init).toMatchObject({
      method: 'POST',
      signal: abortController.signal,
    });
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'clodex-community-observed',
      redirect_uri: 'http://127.0.0.1:43123/auth/callback',
      code: 'opaque-code',
      code_verifier: 'verifier',
    });
  });
});
