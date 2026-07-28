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
  it('synchronously advances the credential epoch for a same-account token replacement', async () => {
    const { authService, uiKarton } = await createTestAuthService();
    const listener = vi.fn();
    authService.registerCredentialEpochChangeCallback(listener);
    const publicStateBefore = structuredClone(uiKarton.state.userAccount);
    const current = (
      authService as unknown as {
        durableCredentials: NonNullable<unknown>;
      }
    ).durableCredentials as Record<string, unknown>;

    const persistence = (
      authService as unknown as {
        persistCredentials: (credentials: unknown) => Promise<boolean>;
      }
    ).persistCredentials({
      ...current,
      token: 'replacement-session-token',
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(uiKarton.state.userAccount).toEqual(publicStateBefore);
    await expect(persistence).resolves.toBe(true);
  });

  it('tracks only the exact fresh route token across replacement and tombstoning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const { authService } = await createTestAuthService();
      const createIdeToken = (
        authService as unknown as {
          clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
        }
      ).clodexInterop.createIdeToken;
      let issueCount = 0;
      createIdeToken.mockImplementation(
        async (_accessToken: string, keyId?: string) => ({
          token: `rotating-route-token-${++issueCount}`,
          keyId,
          group: 'CLAUDE',
        }),
      );
      const route = {
        provider: 'anthropic' as const,
        modelId: 'claude-opus-5',
      };

      const tokenA = await authService.ensureModelAccessTokenForRoute(route);
      expect(tokenA).toBe('rotating-route-token-1');
      expect(authService.isModelAccessTokenCurrent(tokenA!)).toBe(true);
      expect(authService.isModelAccessTokenCurrent('different-token')).toBe(
        false,
      );

      vi.advanceTimersByTime(10 * 60_000);
      expect(authService.isModelAccessTokenCurrent(tokenA!)).toBe(false);

      const tokenB = await authService.ensureModelAccessTokenForRoute(route);
      expect(tokenB).toBe('rotating-route-token-2');
      expect(authService.isModelAccessTokenCurrent(tokenA!)).toBe(false);
      expect(authService.isModelAccessTokenCurrent(tokenB!)).toBe(true);

      const tokenCache = (
        authService as unknown as {
          ideModelTokenByKeyId: Map<
            string,
            {
              token: string;
              cachedAtMs: number;
              expiresAt?: string;
              keyId?: string;
              group?: string;
            }
          >;
        }
      ).ideModelTokenByKeyId;
      const tokenBEntry = [...tokenCache.values()].find(
        (entry) => entry.token === tokenB,
      );
      expect(tokenBEntry).toBeDefined();

      expect(authService.invalidateRejectedModelAccessToken(tokenB!)).toBe(
        true,
      );
      expect(authService.isModelAccessTokenCurrent(tokenB!)).toBe(false);

      tokenCache.set('reinserted-tombstoned-token', tokenBEntry!);
      expect(authService.isModelAccessTokenCurrent(tokenB!)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a still-cached exact route token using declared expiry and refresh skew', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const { authService } = await createTestAuthService();
      const createIdeToken = (
        authService as unknown as {
          clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
        }
      ).clodexInterop.createIdeToken;
      createIdeToken.mockResolvedValue({
        token: 'short-lived-route-token',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '120',
      });

      const token = await authService.ensureModelAccessTokenForRoute({
        provider: 'anthropic',
        modelId: 'claude-opus-5',
      });
      expect(authService.isModelAccessTokenCurrent(token!)).toBe(true);

      vi.advanceTimersByTime(60_000);

      expect(authService.isModelAccessTokenCurrent(token!)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recognizes an exact fresh primary token independently of route caches', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken.mockResolvedValue({
      token: 'primary-model-token',
      keyId: 'all-key',
      group: 'ALL',
      expiresAt: '3600',
    });

    const token = await authService.ensureModelAccessToken();
    expect(token).toBe('primary-model-token');
    expect(authService.isModelAccessTokenCurrent(token!)).toBe(true);

    const tokenState = authService as unknown as {
      ideModelToken: unknown;
      ideModelTokenByKeyId: Map<string, unknown>;
    };
    tokenState.ideModelTokenByKeyId.clear();
    expect(authService.isModelAccessTokenCurrent(token!)).toBe(true);

    tokenState.ideModelToken = null;
    expect(authService.isModelAccessTokenCurrent(token!)).toBe(false);
  });

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

  it('evicts only cache entries carrying a relay-rejected token', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    let issueCount = 0;
    createIdeToken.mockImplementation(
      async (
        _accessToken: string,
        keyId?: string,
        route?: { provider?: string },
      ) => ({
        token: `${route?.provider}-route-token-${++issueCount}`,
        keyId,
        group: route?.provider === 'anthropic' ? 'CLAUDE' : 'GPT',
        expiresAt: '3600',
      }),
    );
    const openAiRoute = { provider: 'openai' as const, modelId: 'gpt-5.5' };
    const anthropicRoute = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    const rejectedToken =
      await authService.ensureModelAccessTokenForRoute(openAiRoute);
    const unaffectedToken =
      await authService.ensureModelAccessTokenForRoute(anthropicRoute);
    expect(
      authService.invalidateRejectedModelAccessToken(rejectedToken ?? ''),
    ).toBe(true);

    await expect(
      authService.ensureModelAccessTokenForRoute(anthropicRoute),
    ).resolves.toBe(unaffectedToken);
    await expect(
      authService.ensureModelAccessTokenForRoute(openAiRoute),
    ).resolves.not.toBe(rejectedToken);
    expect(createIdeToken).toHaveBeenCalledTimes(3);
  });

  it('does not cache a token rejected while its issuance is still in flight', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    type IssuedToken = {
      token: string;
      keyId: string;
      group: string;
      expiresAt: string;
    };
    let resolvePendingToken!: (value: IssuedToken) => void;
    createIdeToken
      .mockImplementationOnce(
        () =>
          new Promise<IssuedToken>((resolve) => {
            resolvePendingToken = resolve;
          }),
      )
      .mockResolvedValueOnce({
        token: 'fresh-route-token-b',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      });
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    const pendingIssuance = authService.ensureModelAccessTokenForRoute(route);
    expect(createIdeToken).toHaveBeenCalledTimes(1);
    expect(
      authService.invalidateRejectedModelAccessToken('rejected-route-token-a'),
    ).toBe(false);
    resolvePendingToken({
      token: 'rejected-route-token-a',
      keyId: 'all-key',
      group: 'CLAUDE',
      expiresAt: '3600',
    });

    await expect(pendingIssuance).resolves.toBeUndefined();
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('fresh-route-token-b');
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('fresh-route-token-b');
    expect(createIdeToken).toHaveBeenCalledTimes(2);
  });

  it('does not let a late rejection of token A evict fresh token B', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken
      .mockResolvedValueOnce({
        token: 'route-token-a',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      })
      .mockResolvedValueOnce({
        token: 'route-token-b',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      });
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('route-token-a');
    expect(
      authService.invalidateRejectedModelAccessToken('route-token-a'),
    ).toBe(true);
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('route-token-b');

    expect(
      authService.invalidateRejectedModelAccessToken('route-token-a'),
    ).toBe(false);
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('route-token-b');
    expect(createIdeToken).toHaveBeenCalledTimes(2);
  });

  it('preserves rejected-token tombstones across a cache-only clear', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken
      .mockResolvedValueOnce({
        token: 'rejected-route-token-a',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      })
      .mockResolvedValueOnce({
        token: 'fresh-route-token-b',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      });
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    authService.invalidateRejectedModelAccessToken('rejected-route-token-a');
    (
      authService as unknown as {
        clearModelAccessTokenCache: () => void;
      }
    ).clearModelAccessTokenCache();

    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBeUndefined();
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('fresh-route-token-b');
    expect(createIdeToken).toHaveBeenCalledTimes(2);
  });

  it('releases rejected-token tombstones after trusted session authority changes', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken.mockResolvedValueOnce({
      token: 'route-token-reissued-for-new-session',
      keyId: 'all-key',
      group: 'CLAUDE',
      expiresAt: '3600',
    });
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    authService.invalidateRejectedModelAccessToken(
      'route-token-reissued-for-new-session',
    );
    const current = (
      authService as unknown as {
        durableCredentials: Record<string, unknown>;
      }
    ).durableCredentials;
    await (
      authService as unknown as {
        persistCredentials: (credentials: unknown) => Promise<boolean>;
      }
    ).persistCredentials({
      ...current,
      token: 'replacement-session-token',
    });

    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('route-token-reissued-for-new-session');
    expect(createIdeToken).toHaveBeenCalledWith(
      'replacement-session-token',
      'all-key',
      {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        group: 'CLAUDE',
      },
    );
  });

  it('retains rejected-token tombstones when a session replacement is not durable', async () => {
    const { writePersistedData } = await import('../../utils/persisted-data');
    vi.mocked(writePersistedData).mockRejectedValueOnce(
      new Error('credential store unavailable'),
    );
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken
      .mockResolvedValueOnce({
        token: 'rejected-route-token-a',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      })
      .mockResolvedValueOnce({
        token: 'fresh-route-token-b',
        keyId: 'all-key',
        group: 'CLAUDE',
        expiresAt: '3600',
      });
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    authService.invalidateRejectedModelAccessToken('rejected-route-token-a');
    const current = (
      authService as unknown as {
        durableCredentials: Record<string, unknown>;
      }
    ).durableCredentials;
    await expect(
      (
        authService as unknown as {
          persistCredentials: (credentials: unknown) => Promise<boolean>;
        }
      ).persistCredentials({
        ...current,
        token: 'replacement-session-token',
      }),
    ).resolves.toBe(false);

    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBeUndefined();
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('fresh-route-token-b');
    expect(createIdeToken).toHaveBeenNthCalledWith(
      1,
      'session-token',
      'all-key',
      {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        group: 'CLAUDE',
      },
    );
  });

  it('deduplicates concurrent route-specific token refreshes', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    let resolveToken:
      | ((value: {
          token: string;
          keyId: string;
          group: string;
          expiresAt: string;
        }) => void)
      | undefined;
    createIdeToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );

    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };
    const first = authService.ensureModelAccessTokenForRoute(route);
    const second = authService.ensureModelAccessTokenForRoute(route);

    expect(createIdeToken).toHaveBeenCalledTimes(1);
    resolveToken?.({
      token: 'shared-claude-route-token',
      keyId: 'all-key',
      group: 'CLAUDE',
      expiresAt: '3600',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared-claude-route-token',
      'shared-claude-route-token',
    ]);
    expect(createIdeToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-date'],
  ])('bounds route-token freshness when expiry is %s', async (_label, expiresAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    try {
      const { authService } = await createTestAuthService();
      const createIdeToken = (
        authService as unknown as {
          clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
        }
      ).clodexInterop.createIdeToken;
      let issueCount = 0;
      createIdeToken.mockImplementation(
        async (_accessToken: string, keyId?: string) => ({
          token: `bounded-token-${++issueCount}`,
          keyId,
          group: 'CLAUDE',
          expiresAt,
        }),
      );
      const route = {
        provider: 'anthropic' as const,
        modelId: 'claude-opus-5',
      };

      await expect(
        authService.ensureModelAccessTokenForRoute(route),
      ).resolves.toBe('bounded-token-1');
      await expect(
        authService.ensureModelAccessTokenForRoute(route),
      ).resolves.toBe('bounded-token-1');
      expect(createIdeToken).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10 * 60_000);

      await expect(
        authService.ensureModelAccessTokenForRoute(route),
      ).resolves.toBe('bounded-token-2');
      expect(createIdeToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates route tokens when the session credential authority changes', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    createIdeToken.mockImplementation(
      async (accessToken: string, keyId?: string) => ({
        token: `route-token-for-${accessToken}`,
        keyId,
        group: 'CLAUDE',
        expiresAt: '3600',
      }),
    );
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('route-token-for-session-token');
    const current = (
      authService as unknown as {
        durableCredentials: Record<string, unknown>;
      }
    ).durableCredentials;
    await (
      authService as unknown as {
        persistCredentials: (credentials: unknown) => Promise<boolean>;
      }
    ).persistCredentials({
      ...current,
      token: 'replacement-session-token',
    });

    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('route-token-for-replacement-session-token');
    expect(createIdeToken).toHaveBeenCalledTimes(2);
    expect(createIdeToken).toHaveBeenLastCalledWith(
      'replacement-session-token',
      'all-key',
      {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        group: 'CLAUDE',
      },
    );
  });

  it('does not let an invalidated in-flight route refresh overwrite the next credential generation', async () => {
    const { authService } = await createTestAuthService();
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    type IssuedToken = {
      token: string;
      keyId: string;
      group: string;
      expiresAt: string;
    };
    let resolveOldToken: ((value: IssuedToken) => void) | undefined;
    let resolveNewToken: ((value: IssuedToken) => void) | undefined;
    createIdeToken
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldToken = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewToken = resolve;
          }),
      );
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    const oldRequest = authService.ensureModelAccessTokenForRoute(route);
    const current = (
      authService as unknown as {
        durableCredentials: Record<string, unknown>;
      }
    ).durableCredentials;
    await (
      authService as unknown as {
        persistCredentials: (credentials: unknown) => Promise<boolean>;
      }
    ).persistCredentials({
      ...current,
      token: 'replacement-session-token',
    });
    const newRequest = authService.ensureModelAccessTokenForRoute(route);
    expect(createIdeToken).toHaveBeenCalledTimes(2);

    resolveOldToken?.({
      token: 'old-route-token',
      keyId: 'all-key',
      group: 'CLAUDE',
      expiresAt: '3600',
    });
    await expect(oldRequest).resolves.toBeUndefined();

    const joinedNewRequest = authService.ensureModelAccessTokenForRoute(route);
    expect(createIdeToken).toHaveBeenCalledTimes(2);
    resolveNewToken?.({
      token: 'new-route-token',
      keyId: 'all-key',
      group: 'CLAUDE',
      expiresAt: '3600',
    });
    await expect(Promise.all([newRequest, joinedNewRequest])).resolves.toEqual([
      'new-route-token',
      'new-route-token',
    ]);
    await expect(
      authService.ensureModelAccessTokenForRoute(route),
    ).resolves.toBe('new-route-token');
    expect(createIdeToken).toHaveBeenCalledTimes(2);
  });

  it('invalidates route tokens when the selected key changes', async () => {
    const { authService, uiKarton } = await createTestAuthService();
    const claudeKey = {
      id: 'claude-key',
      name: 'CLAUDE',
      group: 'CLAUDE',
      isDefault: false,
      modelLimitsEnabled: false,
    };
    uiKarton.state.userAccount.keys.push(claudeKey);
    Object.assign(authService as unknown as Record<string, unknown>, {
      clodexIdeKeys: uiKarton.state.userAccount.keys,
    });
    const createIdeToken = (
      authService as unknown as {
        clodexInterop: { createIdeToken: ReturnType<typeof vi.fn> };
      }
    ).clodexInterop.createIdeToken;
    let issueCount = 0;
    createIdeToken.mockImplementation(
      async (
        _accessToken: string,
        keyId?: string,
        route?: { group?: string },
      ) => ({
        token: `${route ? 'route' : 'generic'}-${keyId}-${++issueCount}`,
        keyId,
        group: route?.group ?? (keyId === 'all-key' ? 'ALL' : 'CLAUDE'),
        expiresAt: '3600',
      }),
    );
    const route = {
      provider: 'anthropic' as const,
      modelId: 'claude-opus-5',
    };

    const firstRouteToken =
      await authService.ensureModelAccessTokenForRoute(route);
    await expect(authService.selectClodexKey('claude-key')).resolves.toEqual(
      {},
    );
    await expect(authService.selectClodexKey('all-key')).resolves.toEqual({});
    const secondRouteToken =
      await authService.ensureModelAccessTokenForRoute(route);

    expect(firstRouteToken).toBe('route-all-key-1');
    expect(secondRouteToken).toMatch(/^route-all-key-/);
    expect(secondRouteToken).not.toBe(firstRouteToken);
    expect(
      createIdeToken.mock.calls.filter((call) => call[2] !== undefined),
    ).toHaveLength(2);
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

  it('keeps the exact legacy session token current until it is rejected', async () => {
    const previousClodexAuthEnabled = process.env.CLODEX_AUTH_ENABLED;
    process.env.CLODEX_AUTH_ENABLED = 'false';
    vi.resetModules();

    try {
      const { authService } = await createTestAuthService();
      const token = await authService.ensureModelAccessToken();

      expect(token).toBe('session-token');
      expect(authService.isModelAccessTokenCurrent(token!)).toBe(true);
      expect(authService.isModelAccessTokenCurrent('different-token')).toBe(
        false,
      );

      authService.invalidateRejectedModelAccessToken(token!);

      expect(authService.isModelAccessTokenCurrent(token!)).toBe(false);
    } finally {
      if (previousClodexAuthEnabled === undefined) {
        delete process.env.CLODEX_AUTH_ENABLED;
      } else {
        process.env.CLODEX_AUTH_ENABLED = previousClodexAuthEnabled;
      }
      vi.resetModules();
    }
  });
});
