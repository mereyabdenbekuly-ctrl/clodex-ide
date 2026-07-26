import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoUpdater = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  on: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
}));
const discoverCommunityManualUpdate = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
  vi.stubGlobal('__APP_VERSION__', '1.16.0-community4');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-unsigned');
  vi.stubGlobal('__APP_AUTO_UPDATE_ENABLED__', false);
});

vi.mock('electron', () => ({ autoUpdater }));
vi.mock('./community-manual-update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./community-manual-update')>()),
  discoverCommunityManualUpdate,
}));

import { AutoUpdateService } from './auto-update';
import { CommunityManualUpdateError } from './community-manual-update';

const REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';

function createHarness() {
  const state = {
    autoUpdate: {
      status: 'idle',
      updateInfo: null as {
        releaseName?: string;
        releaseNotes?: string;
        releasePageUrl?: string;
      } | null,
      errorMessage: null as string | null,
    },
  };
  const handlers = new Map<string, (clientId: string) => Promise<void>>();
  const preferencesService = {
    addListener: vi.fn(),
    get: vi.fn(() => ({ updateChannel: 'beta' })),
  };
  const uiKarton = {
    registerServerProcedureHandler: vi.fn(
      (name: string, handler: (clientId: string) => Promise<void>) => {
        handlers.set(name, handler);
      },
    ),
    removeServerProcedureHandler: vi.fn((name: string) => {
      handlers.delete(name);
    }),
    setState: vi.fn((updater: (draft: typeof state) => void) => updater(state)),
  };
  const telemetryService = { captureException: vi.fn() };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    handlers,
    logger,
    preferencesService,
    state,
    telemetryService,
    uiKarton,
  };
}

describe('AutoUpdateService community manual update bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverCommunityManualUpdate.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
    vi.stubGlobal('__APP_VERSION__', '1.16.0-community4');
    vi.stubGlobal('__APP_PLATFORM__', 'darwin');
    vi.stubGlobal('__APP_ARCH__', 'arm64');
    vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-unsigned');
    vi.stubGlobal('__APP_AUTO_UPDATE_ENABLED__', false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers only the manual check without feed, updater events, or timers', async () => {
    discoverCommunityManualUpdate.mockResolvedValue({ status: 'current' });
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    expect(harness.state.autoUpdate.status).toBe('manual-idle');
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(harness.preferencesService.addListener).not.toHaveBeenCalled();
    expect(harness.handlers.has('autoUpdate.checkForUpdates')).toBe(true);
    expect(harness.handlers.has('autoUpdate.quitAndInstall')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await harness.handlers.get('autoUpdate.checkForUpdates')?.('renderer');

    expect(harness.state.autoUpdate.status).toBe('manual-current');
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await service.teardown();
  });

  it('publishes only validated release-page metadata for a compatible update', async () => {
    discoverCommunityManualUpdate.mockResolvedValue({
      status: 'available',
      releaseName: '1.16.0-community5',
      releaseNotes: 'Raw release Markdown must not reach renderer state.',
      releasePageUrl: `https://github.com/${REPOSITORY}/releases/tag/v1.16.0-community5`,
      installerAssetName:
        'clodex-community-unsigned-1.16.0-community5-arm64.dmg',
    });
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    await service.checkForUpdates();

    expect(harness.state.autoUpdate).toEqual({
      status: 'manual-available',
      updateInfo: {
        releaseName: '1.16.0-community5',
        releasePageUrl:
          `https://github.com/${REPOSITORY}/releases/tag/` +
          'v1.16.0-community5',
      },
      errorMessage: null,
    });
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('never forwards an installer selection into renderer state', async () => {
    vi.stubGlobal('__APP_PLATFORM__', 'linux');
    vi.stubGlobal('__APP_ARCH__', 'x64');
    discoverCommunityManualUpdate.mockResolvedValue({
      status: 'available',
      releaseName: '1.16.0-community5',
      releasePageUrl: `https://github.com/${REPOSITORY}/releases/tag/v1.16.0-community5`,
      installerAssetName:
        'clodex-community-unsigned_1.16.0-community5_amd64.deb',
    });
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    await service.checkForUpdates();

    expect(harness.state.autoUpdate).toEqual({
      status: 'manual-available',
      updateInfo: {
        releaseName: '1.16.0-community5',
        releasePageUrl:
          `https://github.com/${REPOSITORY}/releases/tag/` +
          'v1.16.0-community5',
      },
      errorMessage: null,
    });

    await service.teardown();
  });

  it('fails closed with a retryable manual error and no untrusted URL', async () => {
    discoverCommunityManualUpdate.mockRejectedValue(
      new CommunityManualUpdateError(
        'request-failed',
        'offline and secret details',
      ),
    );
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    await service.checkForUpdates();

    expect(harness.state.autoUpdate).toEqual({
      status: 'manual-error',
      updateInfo: null,
      errorMessage:
        'Could not check for updates. Check your connection and try again.',
    });
    expect(harness.state.autoUpdate.errorMessage).not.toContain('secret');
    expect(harness.telemetryService.captureException).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[AutoUpdateService] Manual community update check failed (request-failed)',
    );
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('coalesces concurrent button clicks into one bounded request', async () => {
    let resolveDiscovery!: (result: { status: 'current' }) => void;
    discoverCommunityManualUpdate.mockImplementation(
      async () =>
        await new Promise<{ status: 'current' }>((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    const first = service.checkForUpdates();
    const second = service.checkForUpdates();
    expect(harness.state.autoUpdate.status).toBe('manual-checking');
    expect(discoverCommunityManualUpdate).toHaveBeenCalledTimes(1);
    resolveDiscovery({ status: 'current' });
    await Promise.all([first, second]);

    expect(harness.state.autoUpdate.status).toBe('manual-current');
    await service.teardown();
  });

  it('rate-limits sequential checks with a 15 second cooldown', async () => {
    discoverCommunityManualUpdate.mockResolvedValue({ status: 'current' });
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    await service.checkForUpdates();
    await service.checkForUpdates();
    expect(discoverCommunityManualUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_999);
    await service.checkForUpdates();
    expect(discoverCommunityManualUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await service.checkForUpdates();
    expect(discoverCommunityManualUpdate).toHaveBeenCalledTimes(2);

    await service.teardown();
  });

  it('aborts and drains an in-flight check before teardown resolves', async () => {
    let requestAborted = false;
    discoverCommunityManualUpdate.mockImplementation(
      async (request: { signal?: AbortSignal }) =>
        await new Promise<{ status: 'current' }>((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              requestAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const harness = createHarness();
    const service = await AutoUpdateService.create(
      harness.logger as never,
      {} as never,
      harness.telemetryService as never,
      harness.preferencesService as never,
      harness.uiKarton as never,
    );

    const check = service.checkForUpdates();
    expect(harness.state.autoUpdate.status).toBe('manual-checking');

    await service.teardown();
    await expect(check).resolves.toBeUndefined();

    expect(requestAborted).toBe(true);
    expect(harness.handlers.has('autoUpdate.checkForUpdates')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
