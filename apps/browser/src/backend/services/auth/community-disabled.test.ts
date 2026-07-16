import { describe, expect, it, vi } from 'vitest';

const betterAuthCalls = vi.hoisted(() => ({
  getSession: vi.fn(),
  sendOtp: vi.fn(),
  signInOtp: vi.fn(),
  signOut: vi.fn(),
}));
const clodexAuthCalls = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  getIdeKeys: vi.fn(),
  getSelf: vi.fn(),
  getTelegramLoginStatus: vi.fn(),
  getUserModels: vi.fn(),
  startTelegramLogin: vi.fn(),
}));
const persistedData = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(async () => undefined),
}));
const externalAuth = vi.hoisted(() => ({
  openLogin: vi.fn(),
  openTelegram: vi.fn(),
}));

vi.hoisted(() => {
  vi.stubGlobal('__APP_BASE_NAME__', 'clodex-community-unsigned');
  vi.stubGlobal('__APP_NAME__', 'Clodex Agentic IDE (Community Unsigned)');
  vi.stubGlobal(
    '__APP_BUNDLE_ID__',
    'xyz.clodex.agentic-ide.community-unsigned',
  );
  vi.stubGlobal('__APP_VERSION__', '1.16.0');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
  vi.stubGlobal('__APP_AUTH_ENABLED__', false);
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-unsigned');
  vi.stubGlobal('__APP_AUTHOR__', 'Clodex contributors');
  vi.stubGlobal('__APP_COPYRIGHT__', 'Copyright © 2026 Clodex contributors');
  vi.stubGlobal('__APP_HOMEPAGE__', 'https://clodex.xyz');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
});

vi.mock('./server-interop', () => ({
  createBetterAuthClient: vi.fn(() => ({
    emailOtp: { sendVerificationOtp: betterAuthCalls.sendOtp },
    getSession: betterAuthCalls.getSession,
    signIn: { emailOtp: betterAuthCalls.signInOtp },
    signOut: betterAuthCalls.signOut,
  })),
}));

vi.mock('./clodex', () => ({
  ClodexAuthInterop: class {
    exchangeCode = clodexAuthCalls.exchangeCode;
    getIdeKeys = clodexAuthCalls.getIdeKeys;
    getSelf = clodexAuthCalls.getSelf;
    getTelegramLoginStatus = clodexAuthCalls.getTelegramLoginStatus;
    getUserModels = clodexAuthCalls.getUserModels;
    startTelegramLogin = clodexAuthCalls.startTelegramLogin;
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

describe('AuthService community distribution guard', () => {
  it('keeps account auth inert without reading credentials or using the network', async () => {
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
    const service = await AuthService.create(
      { getMachineId: vi.fn(() => 'community-machine') } as never,
      uiKarton as never,
      { showNotification: vi.fn() } as never,
      {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
    );

    expect(persistedData.read).not.toHaveBeenCalled();
    expect(state.userAccount).toMatchObject({
      status: 'unauthenticated',
      machineId: 'community-machine',
      models: [],
      keys: [],
    });
    expect(service.accessToken).toBeUndefined();
    expect(service.modelAccessToken).toBeUndefined();
    await expect(service.ensureModelAccessToken()).resolves.toBeUndefined();
    await expect(
      service.ensureModelAccessTokenForRoute({ provider: 'openai' }),
    ).resolves.toBeUndefined();
    await expect(service.sendOtp('person@example.com')).resolves.toEqual({
      error: 'Account sign-in is disabled in this distribution.',
    });
    await expect(
      service.verifyOtp('person@example.com', '123456'),
    ).resolves.toEqual({
      error: 'Account sign-in is disabled in this distribution.',
    });
    await expect(service.signInSocial('github')).resolves.toEqual({
      error: 'Account sign-in is disabled in this distribution.',
    });
    await expect(service.signInEmail()).resolves.toEqual({
      error: 'Account sign-in is disabled in this distribution.',
    });
    await expect(service.signInTelegram()).resolves.toEqual({
      error: 'Account sign-in is disabled in this distribution.',
    });
    await expect(
      service.handleAuthCallbackUrl('clodex-ide://auth/callback?code=test'),
    ).resolves.toBe(false);

    expect(
      [
        ...Object.values(betterAuthCalls),
        ...Object.values(clodexAuthCalls),
        ...Object.values(externalAuth),
      ].some((call) => call.mock.calls.length > 0),
    ).toBe(false);

    await service.teardown();
  });
});
