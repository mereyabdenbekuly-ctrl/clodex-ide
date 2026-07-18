import { createHash, randomBytes } from 'node:crypto';
import { shell } from 'electron';
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient } from 'better-auth/client/plugins';

export const API_URL =
  process.env.CLODEX_API_URL || process.env.API_URL || 'https://clodex.xyz/api';
export const CLODEX_DESKTOP_CLIENT_ID =
  process.env.CLODEX_IDE_CLIENT_ID ||
  (__APP_DISTRIBUTION_MODE__ === 'community-observed'
    ? 'clodex-community-observed'
    : 'clodex-ide');

type BetterAuthClientOptions = {
  plugins: [ReturnType<typeof emailOTPClient>];
};

export type BetterAuthClient = ReturnType<
  typeof createAuthClient<BetterAuthClientOptions>
>;

function createBase64UrlRandomString(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}

export function createClodexBrowserAuthState(): string {
  return createBase64UrlRandomString(32);
}

export type ClodexBrowserAuthRequest = {
  clientId: string;
  codeVerifier: string;
  open: () => Promise<void>;
  redirectUri: string;
  state: string;
};

/**
 * Creates a desktop authorization request without exposing either the state or
 * PKCE verifier to the renderer. The verifier remains owned by AuthService in
 * the Electron main process and is sent only to the one-time token endpoint.
 */
export function createClodexBrowserAuthRequest(options: {
  redirectUri: string;
  state: string;
}): ClodexBrowserAuthRequest {
  const codeVerifier = createBase64UrlRandomString(32);
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  const url = new URL(`${API_URL.replace(/\/+$/, '')}/v1/auth/electron/start`);
  url.searchParams.set('client_id', CLODEX_DESKTOP_CLIENT_ID);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);

  return {
    clientId: CLODEX_DESKTOP_CLIENT_ID,
    codeVerifier,
    redirectUri: options.redirectUri,
    state: options.state,
    open: () => shell.openExternal(url.toString(), { activate: true }),
  };
}

/**
 * Creates a better-auth client for the Electron main process.
 *
 * Uses bearer token auth (stored in our encrypted credential store)
 * instead of browser cookies. The `getToken` callback lets the
 * AuthService supply the current persisted token lazily.
 *
 * `onTokenReceived` is called whenever any response includes a
 * `set-auth-token` header, handling both initial sign-in and
 * automatic token refreshes from `getSession()`.
 */
export function createBetterAuthClient(
  getToken: () => string | null,
  onTokenReceived: (token: string) => void,
): BetterAuthClient {
  return createAuthClient({
    baseURL: API_URL,
    basePath: '/v1/auth',
    disableDefaultFetchPlugins: true,
    fetchOptions: {
      auth: {
        type: 'Bearer',
        token: () => getToken() ?? '',
      },
      onSuccess: (ctx) => {
        const authToken = ctx.response.headers.get('set-auth-token');
        if (authToken) {
          onTokenReceived(authToken);
        }
      },
    },
    plugins: [emailOTPClient()],
  });
}
