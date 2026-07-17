import { beforeEach, describe, expect, it, vi } from 'vitest';

const betterAuthCalls = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getSession: vi.fn(),
  sendOtp: vi.fn(),
  signInOtp: vi.fn(),
  signOut: vi.fn(),
}));
const clodexCalls = vi.hoisted(() => ({
  createIdeToken: vi.fn(),
  exchangeCode: vi.fn(),
  exchangeDashboardSessionForAccessToken: vi.fn(),
  getIdeKeys: vi.fn(),
  getSelf: vi.fn(),
  getTelegramLoginStatus: vi.fn(),
  getUserModels: vi.fn(),
  startTelegramLogin: vi.fn(),
}));
const externalAuth = vi.hoisted(() => ({
  openLogin: vi.fn(),
  openTelegram: vi.fn(),
}));
const persistedData = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(async () => undefined),
}));

vi.hoisted(() => {
  vi.stubGlobal('__APP_BASE_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_BUNDLE_ID__', 'xyz.clodex.agentic-ide.test');
  vi.stubGlobal('__APP_VERSION__', '1.16.0-authlocal4');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'dev');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
  vi.stubGlobal('__APP_AUTH_ENABLED__', true);
  vi.stubGlobal('__APP_AUTHOR__', 'Clodex Labs');
  vi.stubGlobal('__APP_COPYRIGHT__', 'Copyright © 2026 Clodex Labs');
  vi.stubGlobal('__APP_HOMEPAGE__', 'https://clodex.xyz');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  process.env.CLODEX_ORIGIN = 'https://clodex.test';
  delete process.env.CLODEX_AUTH_CALLBACK_SCHEME;
});

vi.mock('./server-interop', () => ({
  createBetterAuthClient: vi.fn(() => ({
    authenticate: betterAuthCalls.authenticate,
    emailOtp: { sendVerificationOtp: betterAuthCalls.sendOtp },
    getSession: betterAuthCalls.getSession,
    signIn: { emailOtp: betterAuthCalls.signInOtp },
    signOut: betterAuthCalls.signOut,
  })),
}));

vi.mock('./clodex', () => ({
  ClodexAuthInterop: class {
    createIdeToken = clodexCalls.createIdeToken;
    exchangeCode = clodexCalls.exchangeCode;
    exchangeDashboardSessionForAccessToken =
      clodexCalls.exchangeDashboardSessionForAccessToken;
    getIdeKeys = clodexCalls.getIdeKeys;
    getSelf = clodexCalls.getSelf;
    getTelegramLoginStatus = clodexCalls.getTelegramLoginStatus;
    getUserModels = clodexCalls.getUserModels;
    startTelegramLogin = clodexCalls.startTelegramLogin;
  },
  ClodexRequestError: class extends Error {},
  openClodexLoginInSystemBrowser: externalAuth.openLogin,
  openClodexTelegramInSystemApp: externalAuth.openTelegram,
}));

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: persistedData.read,
  writePersistedData: persistedData.write,
}));

vi.mock('../../utils/validate-api-keys', () => ({
  validateApiKeys: vi.fn(),
}));

import { AuthService } from './index';

const HANDOFF_DISABLED_ERROR =
  'CLODEx browser sign-in is temporarily disabled until a state-bound PKCE flow is available. Use BYOK or a local model.';

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

describe('AuthService legacy browser handoff kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('purges an unbound persisted session before it can be restored', async () => {
    const { service, state } = await createService({
      token: 'authlocal3-session',
      user: { id: 'legacy-user' },
    });

    expect(persistedData.write).toHaveBeenCalledWith(
      'auth-session',
      expect.anything(),
      null,
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
    expect(state.userAccount.status).toBe('unauthenticated');
    expect(service.accessToken).toBeUndefined();
    expect(clodexCalls.getSelf).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('does not open the system browser for email or social sign-in', async () => {
    const { service } = await createService();

    await expect(service.signInEmail()).resolves.toEqual({
      error: HANDOFF_DISABLED_ERROR,
    });
    await expect(service.signInSocial('github')).resolves.toEqual({
      error: HANDOFF_DISABLED_ERROR,
    });
    expect(externalAuth.openLogin).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('consumes only the exact callback and never exchanges code or token', async () => {
    const { service } = await createService();

    await expect(
      service.handleAuthCallbackUrl(
        'clodex-ide://auth/callback?code=unbound-code',
      ),
    ).resolves.toBe(true);
    await expect(
      service.handleAuthCallbackUrl(
        'clodex-ide://auth/callback#token=unbound-token',
      ),
    ).resolves.toBe(true);
    await expect(
      service.handleAuthCallbackUrl(
        'clodex-ide://authorization/callback?code=unbound-code',
      ),
    ).resolves.toBe(false);
    await expect(
      service.handleAuthCallbackUrl('clodex://auth/callback?code=wrong-scheme'),
    ).resolves.toBe(false);

    expect(clodexCalls.exchangeCode).not.toHaveBeenCalled();
    expect(betterAuthCalls.authenticate).not.toHaveBeenCalled();
    expect(service.accessToken).toBeUndefined();

    await service.teardown();
  });
});
