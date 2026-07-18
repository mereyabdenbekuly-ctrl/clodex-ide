import { beforeEach, describe, expect, it, vi } from 'vitest';

const betterAuthCalls = vi.hoisted(() => ({
  getSession: vi.fn(),
  onTokenReceived: null as ((token: string) => void) | null,
  sendOtp: vi.fn(),
  signInOtp: vi.fn(),
  signOut: vi.fn(),
}));
const clodexCalls = vi.hoisted(() => ({
  createIdeToken: vi.fn(),
  exchangeDashboardSessionForAccessToken: vi.fn(),
  exchangePkceAuthorizationCode: vi.fn(),
  getIdeKeys: vi.fn(),
  getSelf: vi.fn(),
  getTelegramLoginStatus: vi.fn(),
  getUserModels: vi.fn(),
  startTelegramLogin: vi.fn(),
}));
const browserAuth = vi.hoisted(() => ({
  createRequest: vi.fn(),
  createState: vi.fn(),
  open: vi.fn(),
}));
const loopback = vi.hoisted(() => ({
  callback: null as
    | ((callback: {
        code?: string;
        error?: string;
        kind: 'authorization' | 'error';
        state: string;
      }) => Promise<boolean>)
    | null,
  create: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));
const persistedData = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(async () => undefined),
}));

vi.hoisted(() => {
  vi.stubGlobal('__APP_BASE_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_BUNDLE_ID__', 'xyz.clodex.agentic-ide.test');
  vi.stubGlobal('__APP_VERSION__', '1.16.0-authlocal5');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'dev');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
  vi.stubGlobal('__APP_AUTH_ENABLED__', true);
  vi.stubGlobal('__APP_AUTHOR__', 'Clodex Labs');
  vi.stubGlobal('__APP_COPYRIGHT__', 'Copyright © 2026 Clodex Labs');
  vi.stubGlobal('__APP_HOMEPAGE__', 'https://clodex.xyz');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  process.env.CLODEX_ORIGIN = 'https://clodex.test';
  process.env.CLODEX_IDE_CLIENT_ID = 'clodex-test';
  delete process.env.CLODEX_AUTH_CALLBACK_SCHEME;
});

vi.mock('./server-interop', () => ({
  CLODEX_DESKTOP_CLIENT_ID: 'clodex-test',
  createBetterAuthClient: vi.fn(
    (_getToken: unknown, onTokenReceived: (token: string) => void) => {
      betterAuthCalls.onTokenReceived = onTokenReceived;
      return {
        emailOtp: { sendVerificationOtp: betterAuthCalls.sendOtp },
        getSession: betterAuthCalls.getSession,
        signIn: { emailOtp: betterAuthCalls.signInOtp },
        signOut: betterAuthCalls.signOut,
      };
    },
  ),
  createClodexBrowserAuthState: browserAuth.createState,
  createClodexBrowserAuthRequest: browserAuth.createRequest,
}));

vi.mock('./loopback-auth', () => ({
  createLoopbackAuthServer: loopback.create,
}));

vi.mock('./clodex', () => ({
  ClodexAuthInterop: class {
    createIdeToken = clodexCalls.createIdeToken;
    exchangeDashboardSessionForAccessToken =
      clodexCalls.exchangeDashboardSessionForAccessToken;
    exchangePkceAuthorizationCode = clodexCalls.exchangePkceAuthorizationCode;
    getIdeKeys = clodexCalls.getIdeKeys;
    getSelf = clodexCalls.getSelf;
    getTelegramLoginStatus = clodexCalls.getTelegramLoginStatus;
    getUserModels = clodexCalls.getUserModels;
    startTelegramLogin = clodexCalls.startTelegramLogin;
  },
  ClodexRequestError: class extends Error {
    status = 400;
  },
  openClodexTelegramInSystemApp: vi.fn(),
}));

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: persistedData.read,
  writePersistedData: persistedData.write,
}));

vi.mock('../../utils/validate-api-keys', () => ({
  validateApiKeys: vi.fn(),
}));

import { AuthService } from './index';

function createState() {
  return {
    userAccount: {
      status: 'loading',
      machineId: '',
      models: [],
      keys: [],
      activeKeyId: undefined,
      isSwitchingKey: false,
      ideToken: undefined,
    },
  };
}

async function createService(persisted: unknown = null) {
  persistedData.read.mockResolvedValueOnce(persisted);
  const state = createState();
  const uiKarton = {
    state,
    setState: vi.fn((updater: (draft: typeof state) => void) => updater(state)),
    registerServerProcedureHandler: vi.fn(),
    removeServerProcedureHandler: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const service = await AuthService.create(
    { getMachineId: vi.fn(() => 'machine-id') } as never,
    uiKarton as never,
    { showNotification: vi.fn() } as never,
    logger as never,
  );
  return { logger, service, state };
}

describe('AuthService secure browser handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    betterAuthCalls.onTokenReceived = null;
    loopback.callback = null;
    browserAuth.createState.mockReturnValue('state-1');
    browserAuth.createRequest.mockImplementation(({ redirectUri, state }) => ({
      clientId: 'clodex-test',
      codeVerifier: 'verifier-1',
      open: browserAuth.open,
      redirectUri,
      state,
    }));
    loopback.create.mockImplementation(async ({ onCallback }) => {
      loopback.callback = onCallback;
      return {
        callbackUrl: 'http://127.0.0.1:43123/auth/callback',
        dispose: loopback.dispose,
      };
    });
    browserAuth.open.mockResolvedValue(undefined);
    clodexCalls.getIdeKeys.mockResolvedValue([]);
    clodexCalls.createIdeToken.mockResolvedValue({ token: 'ide-model-token' });
    clodexCalls.getUserModels.mockResolvedValue([]);
    clodexCalls.getSelf.mockResolvedValue({
      id: 'user-1',
      email: 'person@example.com',
    });
    clodexCalls.exchangePkceAuthorizationCode.mockResolvedValue({
      accessToken: 'desktop-access-token',
      user: { id: 'user-1', email: 'person@example.com' },
    });
  });

  it('purges only legacy sessions without trusted provenance', async () => {
    const { service, state } = await createService({
      token: 'legacy-session',
      user: { id: 'legacy-user' },
    });

    expect(persistedData.write).toHaveBeenCalledWith(
      'auth-session',
      expect.anything(),
      null,
      expect.objectContaining({ encrypt: true, requireEncryption: true }),
    );
    expect(state.userAccount.status).toBe('unauthenticated');
    expect(service.accessToken).toBeUndefined();

    await service.teardown();
  });

  it('restores a versioned PKCE session after restart', async () => {
    const { service, state } = await createService({
      token: 'desktop-access-token',
      protocolVersion: 2,
      provenance: 'clodex-browser-pkce-s256-v1',
      clientId: 'clodex-test',
      user: { id: 'user-1' },
    });

    expect(state.userAccount.status).toBe('authenticated');
    expect(service.accessToken).toBe('desktop-access-token');
    expect(persistedData.write).not.toHaveBeenCalledWith(
      'auth-session',
      expect.anything(),
      null,
      expect.anything(),
    );

    await service.teardown();
  });

  it('purges a PKCE session issued to a different desktop client', async () => {
    const { service, state } = await createService({
      token: 'desktop-access-token',
      protocolVersion: 2,
      provenance: 'clodex-browser-pkce-s256-v1',
      clientId: 'another-client',
      user: { id: 'user-1' },
    });

    expect(state.userAccount.status).toBe('unauthenticated');
    expect(service.accessToken).toBeUndefined();
    expect(persistedData.write).toHaveBeenCalledWith(
      'auth-session',
      expect.anything(),
      null,
      expect.anything(),
    );

    await service.teardown();
  });

  it('opens a state-bound loopback flow and exchanges one opaque code', async () => {
    const { service } = await createService();
    const resultPromise = service.signInEmail();

    await vi.waitFor(() => expect(browserAuth.open).toHaveBeenCalledOnce());
    expect(browserAuth.createRequest).toHaveBeenCalledWith({
      redirectUri: 'http://127.0.0.1:43123/auth/callback',
      state: 'state-1',
    });
    expect(loopback.callback).not.toBeNull();

    await expect(
      loopback.callback?.({
        code: 'opaque-code',
        kind: 'authorization',
        state: 'state-1',
      }),
    ).resolves.toBe(true);
    await expect(resultPromise).resolves.toEqual({});

    expect(clodexCalls.exchangePkceAuthorizationCode).toHaveBeenCalledWith({
      clientId: 'clodex-test',
      code: 'opaque-code',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://127.0.0.1:43123/auth/callback',
      signal: expect.any(AbortSignal),
    });
    expect(service.accessToken).toBe('desktop-access-token');
    expect(persistedData.write).toHaveBeenCalledWith(
      'auth-session',
      expect.anything(),
      expect.objectContaining({
        token: 'desktop-access-token',
        protocolVersion: 2,
        provenance: 'clodex-browser-pkce-s256-v1',
        clientId: 'clodex-test',
      }),
      expect.anything(),
    );

    await expect(
      loopback.callback?.({
        code: 'replayed-code',
        kind: 'authorization',
        state: 'state-1',
      }),
    ).resolves.toBe(false);
    expect(clodexCalls.exchangePkceAuthorizationCode).toHaveBeenCalledTimes(1);

    await service.teardown();
  });

  it('routes social login through the generic secure website transaction', async () => {
    const { service } = await createService();
    const resultPromise = service.signInSocial('github');

    await vi.waitFor(() => expect(browserAuth.open).toHaveBeenCalledOnce());
    expect(browserAuth.createRequest).toHaveBeenCalledWith({
      redirectUri: 'http://127.0.0.1:43123/auth/callback',
      state: 'state-1',
    });

    await loopback.callback?.({
      error: 'access_denied',
      kind: 'error',
      state: 'state-1',
    });
    await expect(resultPromise).resolves.toEqual({
      error: 'CLODEx browser sign-in was cancelled or denied.',
    });
    expect(clodexCalls.exchangePkceAuthorizationCode).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('keeps legacy custom-scheme callbacks fail-closed', async () => {
    const { service } = await createService();

    await expect(
      service.handleAuthCallbackUrl(
        'clodex-ide://auth/callback?code=raw-bearer',
      ),
    ).resolves.toBe(true);
    await expect(
      service.handleAuthCallbackUrl(
        'clodex-ide://auth/callback#token=unbound-token',
      ),
    ).resolves.toBe(true);
    await expect(
      service.handleAuthCallbackUrl(
        'clodex-ide://authorization/callback?code=opaque-code',
      ),
    ).resolves.toBe(false);

    expect(clodexCalls.exchangePkceAuthorizationCode).not.toHaveBeenCalled();
    expect(service.accessToken).toBeUndefined();

    await service.teardown();
  });

  it('cleans up the loopback receiver when the browser cannot open', async () => {
    browserAuth.open.mockRejectedValueOnce(new Error('open failed'));
    const { service } = await createService();

    await expect(service.signInEmail()).resolves.toEqual({
      error: 'Could not open CLODEx.xyz in the system browser.',
    });
    await vi.waitFor(() => expect(loopback.dispose).toHaveBeenCalledOnce());

    await service.teardown();
  });

  it('aborts an in-flight exchange before logout can be followed by authentication', async () => {
    let exchangeSignal: AbortSignal | undefined;
    clodexCalls.exchangePkceAuthorizationCode.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          exchangeSignal = signal;
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const { service, state } = await createService();
    const resultPromise = service.signInEmail();
    await vi.waitFor(() => expect(browserAuth.open).toHaveBeenCalledOnce());

    const callbackPromise = loopback.callback?.({
      code: 'opaque-code',
      kind: 'authorization',
      state: 'state-1',
    });
    await vi.waitFor(() => expect(exchangeSignal).toBeDefined());

    await service.logout();
    await expect(resultPromise).resolves.toEqual({
      error: 'Sign-in was cancelled.',
    });
    await expect(callbackPromise).resolves.toBe(false);
    expect(exchangeSignal?.aborted).toBe(true);
    expect(service.accessToken).toBeUndefined();
    expect(state.userAccount.status).toBe('unauthenticated');

    await service.teardown();
  });

  it('times out a browser handoff and closes its local receiver', async () => {
    vi.useFakeTimers();
    try {
      const { service } = await createService();
      const resultPromise = service.signInEmail();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(resultPromise).resolves.toEqual({
        error: 'CLODEx browser sign-in timed out.',
      });
      expect(loopback.dispose).toHaveBeenCalledOnce();

      await service.teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish authenticated state when durable storage fails', async () => {
    persistedData.write.mockRejectedValueOnce(new Error('disk unavailable'));
    const { service, state } = await createService();
    const resultPromise = service.signInEmail();
    await vi.waitFor(() => expect(browserAuth.open).toHaveBeenCalledOnce());

    await expect(
      loopback.callback?.({
        code: 'opaque-code',
        kind: 'authorization',
        state: 'state-1',
      }),
    ).resolves.toBe(false);
    await expect(resultPromise).resolves.toEqual({
      error: 'Could not complete secure CLODEx browser sign-in.',
    });
    expect(service.accessToken).toBeUndefined();
    expect(state.userAccount.status).toBe('unauthenticated');

    await service.teardown();
  });

  it('keeps a PKCE token private until the durable write commits', async () => {
    let resolveWrite: (() => void) | undefined;
    persistedData.write.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveWrite = () => resolve(undefined);
        }),
    );
    const { service, state } = await createService();
    const resultPromise = service.signInEmail();
    await vi.waitFor(() => expect(browserAuth.open).toHaveBeenCalledOnce());

    const callbackPromise = loopback.callback?.({
      code: 'opaque-code',
      kind: 'authorization',
      state: 'state-1',
    });
    await vi.waitFor(() => expect(persistedData.write).toHaveBeenCalled());

    expect(service.accessToken).toBeUndefined();
    expect(state.userAccount.status).toBe('unauthenticated');

    resolveWrite?.();
    await expect(callbackPromise).resolves.toBe(true);
    await expect(resultPromise).resolves.toEqual({});
    expect(service.accessToken).toBe('desktop-access-token');
    expect(state.userAccount.status).toBe('authenticated');

    await service.teardown();
  });

  it('rejects a competing OTP verification and ignores its stale token after logout', async () => {
    let resolveOtp:
      | ((value: {
          data: { user: { id: string; email: string } };
          error: null;
        }) => void)
      | undefined;
    betterAuthCalls.signInOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOtp = resolve;
        }),
    );
    const { service, state } = await createService();
    const first = service.verifyOtp('person@example.com', '123456');
    await vi.waitFor(() =>
      expect(betterAuthCalls.signInOtp).toHaveBeenCalled(),
    );

    await expect(
      service.verifyOtp('other@example.com', '654321'),
    ).resolves.toEqual({
      error: 'Another CLODEx sign-in is already in progress.',
    });

    await service.logout();
    betterAuthCalls.onTokenReceived?.('stale-otp-token');
    resolveOtp?.({
      data: { user: { id: 'stale-user', email: 'person@example.com' } },
      error: null,
    });

    await expect(first).resolves.toEqual({ error: 'Sign-in was cancelled.' });
    expect(service.accessToken).toBeUndefined();
    expect(state.userAccount.status).toBe('unauthenticated');

    await service.teardown();
  });

  it('invalidates a Telegram attempt when logout wins the race', async () => {
    let resolveLogin:
      | ((value: {
          token: string;
          telegramUrl: string;
          expiresAt: number;
        }) => void)
      | undefined;
    clodexCalls.startTelegramLogin.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve;
        }),
    );
    const { service } = await createService();
    const signIn = service.signInTelegram();
    await vi.waitFor(() =>
      expect(clodexCalls.startTelegramLogin).toHaveBeenCalledOnce(),
    );

    await service.logout();
    resolveLogin?.({
      token: 'telegram-attempt',
      telegramUrl: 'https://t.me/clodex_bot?start=telegram-attempt',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(signIn).resolves.toEqual({ error: 'Sign-in was cancelled.' });
    expect(service.accessToken).toBeUndefined();

    await service.teardown();
  });
});
