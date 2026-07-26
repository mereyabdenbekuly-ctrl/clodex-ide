import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoUpdater = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  on: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
}));

vi.hoisted(() => {
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'prerelease');
  vi.stubGlobal('__APP_VERSION__', '1.16.0-preview.2');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
  vi.stubGlobal('__APP_AUTO_UPDATE_ENABLED__', true);
});

vi.mock('electron', () => ({ autoUpdater }));

import { AutoUpdateService } from './auto-update';

const originalUpdateServerOrigin = process.env.UPDATE_SERVER_ORIGIN;

function createHarness() {
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
    setState: vi.fn((updater: (draft: typeof state) => void) => updater(state)),
  };
  return { preferencesService, state, uiKarton };
}

async function createService(harness: ReturnType<typeof createHarness>) {
  return await AutoUpdateService.create(
    {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as never,
    {} as never,
    { captureException: vi.fn() } as never,
    harness.preferencesService as never,
    harness.uiKarton as never,
  );
}

describe('AutoUpdateService unsupported official feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'prerelease');
    vi.stubGlobal('__APP_VERSION__', '1.16.0-preview.2');
    vi.stubGlobal('__APP_PLATFORM__', 'darwin');
    vi.stubGlobal('__APP_ARCH__', 'arm64');
    vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
    vi.stubGlobal('__APP_AUTO_UPDATE_ENABLED__', true);
    process.env.UPDATE_SERVER_ORIGIN = 'https://updates.clodex.xyz';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalUpdateServerOrigin === undefined) {
      delete process.env.UPDATE_SERVER_ORIGIN;
    } else {
      process.env.UPDATE_SERVER_ORIGIN = originalUpdateServerOrigin;
    }
  });

  it('marks technical previews unsupported instead of exposing a dead button', async () => {
    const harness = createHarness();
    const service = await createService(harness);

    expect(harness.state.autoUpdate.status).toBe('unsupported');
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(
      harness.uiKarton.registerServerProcedureHandler,
    ).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await service.teardown();
  });

  it('marks stable builds without a feed origin unsupported', async () => {
    vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
    vi.stubGlobal('__APP_VERSION__', '1.16.0');
    delete process.env.UPDATE_SERVER_ORIGIN;
    const harness = createHarness();
    const service = await createService(harness);

    expect(harness.state.autoUpdate.status).toBe('unsupported');
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(
      harness.uiKarton.registerServerProcedureHandler,
    ).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await service.teardown();
  });

  it('preserves the signed official updater path for a configured stable build', async () => {
    vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
    vi.stubGlobal('__APP_VERSION__', '1.16.0');
    const harness = createHarness();
    const service = await createService(harness);

    expect(harness.state.autoUpdate.status).toBe('idle');
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://updates.clodex.xyz/update/clodex/release/macos/arm64/1.16.0',
    });
    expect(autoUpdater.on).toHaveBeenCalledTimes(6);
    expect(harness.preferencesService.addListener).toHaveBeenCalledTimes(1);
    expect(
      harness.uiKarton.registerServerProcedureHandler,
    ).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);

    await service.teardown();

    expect(harness.uiKarton.removeServerProcedureHandler).toHaveBeenCalledWith(
      'autoUpdate.checkForUpdates',
    );
    expect(harness.uiKarton.removeServerProcedureHandler).toHaveBeenCalledWith(
      'autoUpdate.quitAndInstall',
    );
  });
});
