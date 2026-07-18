import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from './index';

const clodexNetworkCalls = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  startTelegramLogin: vi.fn(),
  getTelegramLoginStatus: vi.fn(),
  exchangeDashboardSessionForAccessToken: vi.fn(),
  getSelf: vi.fn(),
  getIdeKeys: vi.fn(),
  createIdeToken: vi.fn(),
  getUserModels: vi.fn(),
}));

vi.hoisted(() => {
  vi.stubGlobal('__APP_BASE_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_BUNDLE_ID__', 'xyz.clodex.agentic-ide.test');
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'dev');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
  vi.stubGlobal('__APP_AUTH_ENABLED__', true);
  vi.stubGlobal('__APP_AUTHOR__', 'Clodex Labs');
  vi.stubGlobal('__APP_COPYRIGHT__', 'Copyright © 2025 Clodex Labs');
  vi.stubGlobal('__APP_HOMEPAGE__', 'https://clodex.xyz');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  process.env.CLODEX_ORIGIN = 'https://clodex.test';
});

vi.mock('./server-interop', () => ({
  CLODEX_DESKTOP_CLIENT_ID: 'clodex-test',
  createBetterAuthClient: vi.fn(() => ({
    emailOtp: {
      sendVerificationOtp: vi.fn(),
    },
    signIn: {
      emailOtp: vi.fn(),
    },
    signOut: vi.fn(),
    getSession: vi.fn(),
  })),
}));

vi.mock('./clodex', () => ({
  ClodexAuthInterop: class {
    exchangeCode = clodexNetworkCalls.exchangeCode;
    startTelegramLogin = clodexNetworkCalls.startTelegramLogin;
    getTelegramLoginStatus = clodexNetworkCalls.getTelegramLoginStatus;
    exchangeDashboardSessionForAccessToken =
      clodexNetworkCalls.exchangeDashboardSessionForAccessToken;
    getSelf = clodexNetworkCalls.getSelf;
    getIdeKeys = clodexNetworkCalls.getIdeKeys;
    createIdeToken = clodexNetworkCalls.createIdeToken;
    getUserModels = clodexNetworkCalls.getUserModels;
  },
  ClodexRequestError: class extends Error {
    public constructor(
      message: string,
      public status?: number,
    ) {
      super(message);
    }
  },
  openClodexLoginInSystemBrowser: vi.fn(),
  openClodexTelegramInSystemApp: vi.fn(),
}));

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: vi.fn(
    async (_key: string, _schema: unknown, fallback) => fallback,
  ),
  writePersistedData: vi.fn(async () => undefined),
}));

vi.mock('../../utils/validate-api-keys', () => ({
  validateApiKeys: vi.fn(),
}));

async function createTestAuthService() {
  const { AuthService } = await import('./index');
  const state = {
    userAccount: {
      status: 'authenticated',
      activeKeyId: 'all-key',
      keys: [
        {
          id: 'all-key',
          name: 'ALL',
          group: 'ALL',
          isDefault: true,
          modelLimitsEnabled: false,
        },
      ],
      models: [],
      ideToken: undefined,
    },
  };
  const uiKarton = {
    state,
    setState: vi.fn((updater: (draft: typeof state) => void) => updater(state)),
    registerServerProcedureHandler: vi.fn(),
    removeServerProcedureHandler: vi.fn(),
  };
  const authService = new (
    AuthService as unknown as new (
      identifierService: unknown,
      uiKarton: unknown,
      notificationService: unknown,
      logger: unknown,
    ) => AuthService
  )(
    { getMachineId: vi.fn(() => 'machine-id') },
    uiKarton,
    { showNotification: vi.fn() },
    {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  );

  const credentials = {
    token: 'session-token',
    protocolVersion: 2,
    provenance: 'clodex-browser-pkce-s256-v1',
    clientId: 'clodex-test',
    activeKeyId: 'all-key',
  } as const;
  Object.assign(authService as unknown as Record<string, unknown>, {
    _credentials: credentials,
    durableCredentials: credentials,
    clodexIdeKeys: state.userAccount.keys,
    clodexInterop: {
      createIdeToken: vi.fn(async (_accessToken: string, keyId?: string) => ({
        token: `token-for-${keyId}`,
        keyId,
        group: 'GPT',
      })),
    },
  });

  return { authService, uiKarton };
}

describe('AuthService Clodex network consent', () => {
  it('does not contact Clodex during a fresh startup before explicit selection', async () => {
    for (const call of Object.values(clodexNetworkCalls)) call.mockClear();

    const { AuthService } = await import('./index');
    const state = {
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
    const uiKarton = {
      state,
      setState: vi.fn((updater: (draft: typeof state) => void) =>
        updater(state),
      ),
      registerServerProcedureHandler: vi.fn(),
      removeServerProcedureHandler: vi.fn(),
    };

    const authService = await AuthService.create(
      { getMachineId: vi.fn(() => 'machine-id') } as never,
      uiKarton as never,
      { showNotification: vi.fn() } as never,
      {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as never,
    );

    expect(
      Object.values(clodexNetworkCalls).some((call) => call.mock.calls.length),
    ).toBe(false);

    await authService.teardown();
  });
});

describe('AuthService route-specific Clodex model tokens', () => {
  it('allows the universal ALL key to route an Anthropic battle model', async () => {
    const { authService } = await createTestAuthService();

    const token = await authService.ensureModelAccessTokenForRoute({
      provider: 'anthropic',
      modelId: 'claude-opus-4.8',
    });

    expect(token).toBe('token-for-all-key');
    expect(
      (
        authService as unknown as {
          clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
        }
      ).clodexInterop.createIdeToken,
    ).toHaveBeenCalledWith('session-token', 'all-key', {
      provider: 'anthropic',
      modelId: 'claude-opus-4.8',
      group: 'CLAUDE',
    });
  });

  it('does not reuse an OpenAI route token for an Anthropic route on the same ALL key', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;

    const openAiToken = await authService.ensureModelAccessTokenForRoute({
      provider: 'openai',
      modelId: 'gpt-5.5',
    });
    const anthropicToken = await authService.ensureModelAccessTokenForRoute({
      provider: 'anthropic',
      modelId: 'claude-opus-4.8',
    });

    expect(openAiToken).toBe('token-for-all-key');
    expect(anthropicToken).toBe('token-for-all-key');
    expect(createIdeToken).toHaveBeenCalledTimes(2);
    expect(createIdeToken).toHaveBeenNthCalledWith(
      1,
      'session-token',
      'all-key',
      {
        provider: 'openai',
        modelId: 'gpt-5.5',
        group: 'GPT',
      },
    );
    expect(createIdeToken).toHaveBeenNthCalledWith(
      2,
      'session-token',
      'all-key',
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4.8',
        group: 'CLAUDE',
      },
    );
  });

  it('rejects a virtual ALL route token for a selected ALL key', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken.mockResolvedValueOnce({
      token: 'bad-all-token',
      keyId: 'all-key',
      group: 'ALL',
    });

    await expect(
      authService.ensureModelAccessTokenForRoute({
        provider: 'google',
        modelId: 'gemini-3.1-pro-preview',
      }),
    ).rejects.toThrow('must issue a concrete GEMINI runtime token');
    expect(createIdeToken).toHaveBeenCalledWith('session-token', 'all-key', {
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
      group: 'GEMINI',
    });
  });

  it('does not silently switch away from the selected ALL key when the gateway returns ALL', async () => {
    const { authService, uiKarton } = await createTestAuthService();
    Object.assign(uiKarton.state.userAccount, {
      activeKeyId: 'all-key',
      keys: [
        {
          id: 'all-key',
          name: 'ALL',
          group: 'ALL',
          isDefault: true,
          modelLimitsEnabled: false,
        },
        {
          id: 'gpt-key',
          name: 'GPT',
          group: 'GPT',
          modelLimitsEnabled: false,
        },
      ],
    });
    Object.assign(authService as unknown as Record<string, unknown>, {
      clodexIdeKeys: uiKarton.state.userAccount.keys,
    });
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken.mockResolvedValueOnce({
      token: 'bad-all-token',
      keyId: 'all-key',
      group: 'ALL',
    });

    await expect(
      authService.ensureModelAccessTokenForRoute({
        provider: 'openai',
        modelId: 'gpt-5.5',
      }),
    ).rejects.toThrow('must issue a concrete GPT runtime token');

    expect(createIdeToken).toHaveBeenCalledTimes(1);
    expect(createIdeToken).toHaveBeenCalledWith('session-token', 'all-key', {
      provider: 'openai',
      modelId: 'gpt-5.5',
      group: 'GPT',
    });
  });

  it('prefers an ALL key over a provider-specific default key when resolving the active key', async () => {
    const { authService, uiKarton } = await createTestAuthService();
    type TestClodexKey = {
      id: string;
      name: string;
      group?: string;
      isDefault?: boolean;
      modelLimitsEnabled?: boolean;
    };
    const keys: TestClodexKey[] = [
      {
        id: 'gpt-key',
        name: 'GPT',
        group: 'GPT',
        isDefault: true,
        modelLimitsEnabled: false,
      },
      {
        id: 'all-key',
        name: 'ALL',
        group: 'ALL',
        modelLimitsEnabled: false,
      },
    ];
    Object.assign(uiKarton.state.userAccount, { activeKeyId: undefined });
    Object.assign(authService as unknown as Record<string, unknown>, {
      _credentials: {
        token: 'session-token',
        protocolVersion: 2,
        provenance: 'clodex-browser-pkce-s256-v1',
        clientId: 'clodex-test',
        activeKeyId: undefined,
      },
      durableCredentials: {
        token: 'session-token',
        protocolVersion: 2,
        provenance: 'clodex-browser-pkce-s256-v1',
        clientId: 'clodex-test',
        activeKeyId: undefined,
      },
      clodexIdeKeys: keys,
    });

    const activeKeyId = (
      authService as unknown as {
        resolveActiveClodexKeyId: (keys: TestClodexKey[]) => string | undefined;
      }
    ).resolveActiveClodexKeyId(keys);

    expect(activeKeyId).toBe('all-key');
  });

  it('deduplicates concurrent generic IDE token refreshes for the same ALL key', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;

    let resolveToken:
      | ((value: { token: string; keyId: string; group: string }) => void)
      | undefined;
    createIdeToken.mockImplementationOnce(
      async (_accessToken: string, keyId?: string) =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }).then(() => ({
          token: 'shared-all-token',
          keyId: keyId ?? 'all-key',
          group: 'ALL',
        })),
    );

    const first = authService.ensureModelAccessToken();
    const second = authService.ensureModelAccessToken();
    expect(createIdeToken).toHaveBeenCalledTimes(1);

    resolveToken?.({
      token: 'shared-all-token',
      keyId: 'all-key',
      group: 'ALL',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared-all-token',
      'shared-all-token',
    ]);
    expect(createIdeToken).toHaveBeenCalledTimes(1);
  });

  it('does not restore a model token when logout wins an in-flight refresh', async () => {
    const { authService, uiKarton } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    let resolveToken:
      | ((value: { token: string; keyId: string; group: string }) => void)
      | undefined;
    createIdeToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );

    const refresh = authService.ensureModelAccessToken();
    expect(createIdeToken).toHaveBeenCalledOnce();
    await authService.logout();
    resolveToken?.({
      token: 'stale-model-token',
      keyId: 'all-key',
      group: 'GPT',
    });

    await expect(refresh).resolves.toBeUndefined();
    expect(authService.modelAccessToken).toBeUndefined();
    expect(uiKarton.state.userAccount.ideToken).toBeUndefined();
  });
});
