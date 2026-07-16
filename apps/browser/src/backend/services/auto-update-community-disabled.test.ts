import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoUpdater = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  on: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
}));

vi.hoisted(() => {
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
  vi.stubGlobal('__APP_VERSION__', '1.16.0');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-unsigned');
  vi.stubGlobal('__APP_AUTO_UPDATE_ENABLED__', false);
});

vi.mock('electron', () => ({ autoUpdater }));

import { AutoUpdateService } from './auto-update';

describe('AutoUpdateService community distribution guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not configure a feed, handlers, timers, or update checks', async () => {
    const state = {
      autoUpdate: {
        status: 'idle',
        updateInfo: null,
        errorMessage: null,
      },
    };
    const preferencesService = {
      addListener: vi.fn(),
      get: vi.fn(() => ({ updateChannel: 'beta' })),
    };
    const uiKarton = {
      registerServerProcedureHandler: vi.fn(),
      removeServerProcedureHandler: vi.fn(),
      setState: vi.fn((updater: (draft: typeof state) => void) =>
        updater(state),
      ),
    };

    const service = await AutoUpdateService.create(
      {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
      {} as never,
      { captureException: vi.fn() } as never,
      preferencesService as never,
      uiKarton as never,
    );

    expect(state.autoUpdate.status).toBe('unsupported');
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(preferencesService.addListener).not.toHaveBeenCalled();
    expect(uiKarton.registerServerProcedureHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    service.checkForUpdates();
    await vi.runAllTimersAsync();

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();

    await service.teardown();
  });
});
