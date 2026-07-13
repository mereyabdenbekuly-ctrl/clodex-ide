import type { FaviconService } from '../../services/favicon';
import type { HistoryService } from '../../services/history';
import type { KartonService } from '../../services/karton';
import type { LocalPortsScannerService } from '../../services/local-ports-scanner';
import type { Logger } from '../../services/logger';
import type { PreferencesService } from '../../services/preferences';
import type { TelemetryService } from '../../services/telemetry';
import type { WebDataService } from '../../services/webdata';
import type { WindowLayoutService } from '../../services/window-layout';
import type { GlobalConfig } from '@shared/karton-contracts/ui/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const app = {
    isPackaged: false,
    getAppPath: vi.fn(),
    getPath: vi.fn(),
  };

  return {
    app,
    autoUpdateCreate: vi.fn(),
    calls: [] as string[],
    ensureRipgrepInstalled: vi.fn(),
    getRipgrepBasePath: vi.fn(),
    globalConfigCreate: vi.fn(),
    notificationCreate: vi.fn(),
    notificationSoundsCreate: vi.fn(),
    omniboxCreate: vi.fn(),
    setupUrlHandlers: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: mocks.app }));

vi.mock('@clodex/agent-runtime-node', () => ({
  ensureRipgrepInstalled: mocks.ensureRipgrepInstalled,
}));

vi.mock('../../services/auto-update', () => ({
  AutoUpdateService: { create: mocks.autoUpdateCreate },
}));

vi.mock('../../services/global-config', () => ({
  GlobalConfigService: { create: mocks.globalConfigCreate },
}));

vi.mock('../../services/notification', () => ({
  NotificationService: { create: mocks.notificationCreate },
}));

vi.mock('../../services/notification-sounds', () => ({
  NotificationSoundsService: { create: mocks.notificationSoundsCreate },
}));

vi.mock('../../services/omnibox-suggestions', () => ({
  OmniboxSuggestionsService: { create: mocks.omniboxCreate },
}));

vi.mock('../../utils/paths', () => ({
  getRipgrepBasePath: mocks.getRipgrepBasePath,
}));

vi.mock('../url-routing', () => ({
  setupUrlHandlers: mocks.setupUrlHandlers,
}));

import {
  runNotificationRuntimePhase,
  type NotificationRuntimePhaseOptions,
} from './notification-runtime';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type TestUiState = {
  notificationSoundPacks: {
    available: string[];
    displayNames: Record<string, string>;
  };
};

const loggerDebug = vi.fn();
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const logger = {
  debug: loggerDebug,
  info: loggerInfo,
  warn: loggerWarn,
  error: loggerError,
} as unknown as Logger;
const historyService = { service: 'history' } as unknown as HistoryService;
const webDataService = { service: 'webdata' } as unknown as WebDataService;
const faviconService = { service: 'favicon' } as unknown as FaviconService;
const localPortsScannerService = {
  service: 'local-ports',
} as unknown as LocalPortsScannerService;
const captureException = vi.fn();
const telemetryService = {
  captureException,
} as unknown as TelemetryService;
const preferencesService = {
  service: 'preferences',
} as unknown as PreferencesService;
const notificationService = { service: 'notification' };
const autoUpdateService = { service: 'auto-update' };
const omniboxSuggestionsService = { service: 'omnibox' };
const baseWindow = { kind: 'base-window' };
const uiWebContents = { kind: 'ui-web-contents' };
const urlHandlers = {
  registerAuthCallbackHandler: vi.fn(),
  registerMcpOAuthCallbackHandler: vi.fn(),
  registerSkillInstallHandler: vi.fn(),
};

let uiState: TestUiState;
let uiKarton: {
  setState: ReturnType<typeof vi.fn>;
};
let windowLayoutService: {
  getBaseWindow: ReturnType<typeof vi.fn>;
  getUIWebContents: ReturnType<typeof vi.fn>;
};
let currentConfig: GlobalConfig;
let globalConfigService: {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  addConfigUpdatedListener: ReturnType<typeof vi.fn>;
};
let notificationSoundsService: {
  setWindowRef: ReturnType<typeof vi.fn>;
  setWebContentsRef: ReturnType<typeof vi.fn>;
  onConfigUpdated: ReturnType<typeof vi.fn>;
  listPacks: ReturnType<typeof vi.fn>;
  getPackDisplayNames: ReturnType<typeof vi.fn>;
};
let configListener:
  | ((newConfig: GlobalConfig, oldConfig: GlobalConfig | null) => void)
  | undefined;
let windowRef: (() => unknown) | undefined;
let webContentsRef: (() => unknown) | undefined;

function phaseOptions(verbose = false): NotificationRuntimePhaseOptions {
  return {
    logger,
    verbose,
    uiKarton: uiKarton as unknown as KartonService,
    historyService,
    webDataService,
    faviconService,
    localPortsScannerService,
    windowLayoutService: windowLayoutService as unknown as WindowLayoutService,
    telemetryService,
    preferencesService,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.app.isPackaged = false;
  mocks.app.getAppPath.mockReturnValue('/app');
  mocks.app.getPath.mockImplementation((name: string) => {
    expect(name).toBe('userData');
    return '/user-data';
  });
  mocks.getRipgrepBasePath.mockImplementation(() => {
    mocks.calls.push('ripgrep-path');
    return '/ripgrep';
  });

  uiState = {
    notificationSoundPacks: { available: [], displayNames: {} },
  };
  uiKarton = {
    setState: vi.fn((update: (draft: TestUiState) => void) => {
      mocks.calls.push('karton-state');
      update(uiState);
    }),
  };
  windowLayoutService = {
    getBaseWindow: vi.fn(() => baseWindow),
    getUIWebContents: vi.fn(() => uiWebContents),
  };
  currentConfig = {
    appColorScheme: 'system',
    notificationSoundPack: 'default',
    notificationSoundLoudness: 'subtle',
    dockBounceEnabled: true,
    blockAppSuspensionWhenAgentsActive: true,
    personalizationThemeId: 'default',
  };
  configListener = undefined;
  globalConfigService = {
    get: vi.fn(() => {
      mocks.calls.push('global-config-get');
      return { ...currentConfig };
    }),
    set: vi.fn().mockResolvedValue(undefined),
    addConfigUpdatedListener: vi.fn(
      (
        listener: (
          newConfig: GlobalConfig,
          oldConfig: GlobalConfig | null,
        ) => void,
      ) => {
        mocks.calls.push('config-listener');
        configListener = listener;
      },
    ),
  };
  windowRef = undefined;
  webContentsRef = undefined;
  notificationSoundsService = {
    setWindowRef: vi.fn((ref: () => unknown) => {
      mocks.calls.push('window-ref');
      windowRef = ref;
    }),
    setWebContentsRef: vi.fn((ref: () => unknown) => {
      mocks.calls.push('web-contents-ref');
      webContentsRef = ref;
    }),
    onConfigUpdated: vi.fn(),
    listPacks: vi.fn(() => {
      mocks.calls.push('list-packs');
      return ['default', 'custom'];
    }),
    getPackDisplayNames: vi.fn(() => {
      mocks.calls.push('pack-display-names');
      return { default: 'Default', custom: 'Custom' };
    }),
  };

  mocks.omniboxCreate.mockImplementation(() => {
    mocks.calls.push('omnibox');
    return Promise.resolve(omniboxSuggestionsService);
  });
  mocks.setupUrlHandlers.mockImplementation(() => {
    mocks.calls.push('url-handlers');
    return urlHandlers;
  });
  mocks.notificationCreate.mockImplementation(() => {
    mocks.calls.push('notification');
    return Promise.resolve(notificationService);
  });
  mocks.autoUpdateCreate.mockImplementation(() => {
    mocks.calls.push('auto-update');
    return Promise.resolve(autoUpdateService);
  });
  mocks.globalConfigCreate.mockImplementation(() => {
    mocks.calls.push('global-config');
    return Promise.resolve(globalConfigService);
  });
  mocks.notificationSoundsCreate.mockImplementation(() => {
    mocks.calls.push('notification-sounds');
    return Promise.resolve(notificationSoundsService);
  });
});

describe('runNotificationRuntimePhase', () => {
  it('preserves service order, forwards dependencies, and returns URL handlers', async () => {
    const ripgrep = deferred<{ success: boolean; error?: string }>();
    mocks.ensureRipgrepInstalled.mockImplementation(() => {
      mocks.calls.push('ensure-ripgrep');
      return ripgrep.promise;
    });

    const result = await runNotificationRuntimePhase(phaseOptions());
    result.startNotificationBackgroundWork();

    expect(mocks.calls).toEqual([
      'omnibox',
      'url-handlers',
      'notification',
      'auto-update',
      'global-config',
      'global-config-get',
      'notification-sounds',
      'window-ref',
      'web-contents-ref',
      'config-listener',
      'list-packs',
      'pack-display-names',
      'karton-state',
      'ripgrep-path',
      'ensure-ripgrep',
    ]);
    expect(mocks.omniboxCreate).toHaveBeenCalledWith(
      logger,
      uiKarton,
      historyService,
      webDataService,
      faviconService,
      localPortsScannerService,
    );
    expect(mocks.setupUrlHandlers).toHaveBeenCalledWith(
      windowLayoutService,
      logger,
    );
    expect(mocks.notificationCreate).toHaveBeenCalledWith(logger, uiKarton);
    expect(mocks.autoUpdateCreate).toHaveBeenCalledWith(
      logger,
      notificationService,
      telemetryService,
      preferencesService,
      uiKarton,
    );
    expect(mocks.globalConfigCreate).toHaveBeenCalledWith(logger, uiKarton);
    expect(mocks.notificationSoundsCreate).toHaveBeenCalledWith(
      logger,
      uiKarton,
      '/app/assets/sounds',
      '/user-data/imported-sound-packs',
      currentConfig,
    );
    expect(mocks.ensureRipgrepInstalled).toHaveBeenCalledWith({
      rgBinaryBasePath: '/ripgrep',
      onLog: logger.debug,
    });
    expect(result).toMatchObject({
      omniboxSuggestionsService,
      notificationService,
      autoUpdateService,
      globalConfigService,
      notificationSoundsService,
      ...urlHandlers,
    });
    expect(uiState.notificationSoundPacks).toEqual({
      available: ['default', 'custom'],
      displayNames: { default: 'Default', custom: 'Custom' },
    });
    expect(windowRef?.()).toBe(baseWindow);
    expect(webContentsRef?.()).toBe(uiWebContents);
    expect(windowLayoutService.getBaseWindow).toHaveBeenCalledTimes(1);
    expect(windowLayoutService.getUIWebContents).toHaveBeenCalledTimes(1);
  });

  it('forwards config updates and preserves sound-pack state-before-save semantics', async () => {
    mocks.ensureRipgrepInstalled.mockReturnValue(new Promise(() => {}));
    const result = await runNotificationRuntimePhase(phaseOptions());
    result.startNotificationBackgroundWork();
    const updatedConfig = {
      ...currentConfig,
      notificationSoundPack: 'custom',
    };

    configListener?.(updatedConfig, currentConfig);
    expect(notificationSoundsService.onConfigUpdated).toHaveBeenCalledWith(
      updatedConfig,
    );

    notificationSoundsService.listPacks.mockReturnValue(['custom']);
    notificationSoundsService.getPackDisplayNames.mockReturnValue({
      custom: 'Custom Pack',
    });
    const savedConfig = { ...currentConfig, notificationSoundPack: 'custom' };
    await result.syncAvailableSoundPacks('custom');

    expect(uiState.notificationSoundPacks).toEqual({
      available: ['custom'],
      displayNames: { custom: 'Custom Pack' },
    });
    expect(globalConfigService.set).toHaveBeenLastCalledWith(savedConfig);
    expect(uiKarton.setState.mock.invocationCallOrder.at(-1)).toBeLessThan(
      globalConfigService.set.mock.invocationCallOrder.at(-1)!,
    );

    const saveFailure = new Error('save failed');
    globalConfigService.set.mockRejectedValueOnce(saveFailure);
    notificationSoundsService.listPacks.mockReturnValue(['other']);
    notificationSoundsService.getPackDisplayNames.mockReturnValue({
      other: 'Other Pack',
    });

    await expect(result.syncAvailableSoundPacks('other')).rejects.toBe(
      saveFailure,
    );
    expect(uiState.notificationSoundPacks).toEqual({
      available: ['other'],
      displayNames: { other: 'Other Pack' },
    });
  });

  it('logs initial sound-pack discovery errors without rejecting startup', async () => {
    const backgroundOrder: string[] = [];
    const discoveryFailure = new Error('discovery failed');
    loggerError.mockImplementation(() => {
      backgroundOrder.push('sound-error');
    });
    loggerDebug.mockImplementation((message: string) => {
      if (message === 'Ripgrep is available for grep/glob operations') {
        backgroundOrder.push('ripgrep-success');
      }
    });
    notificationSoundsService.listPacks.mockImplementation(() => {
      throw discoveryFailure;
    });
    mocks.ensureRipgrepInstalled.mockResolvedValue({ success: true });

    const result = await runNotificationRuntimePhase(phaseOptions(true));
    result.startNotificationBackgroundWork();
    await flushMicrotasks();

    expect(backgroundOrder).toEqual(['sound-error', 'ripgrep-success']);
    expect(logger.error).toHaveBeenCalledWith(
      '[Main] Failed to save discovered sound packs',
      discoveryFailure,
    );
    expect(globalConfigService.set).not.toHaveBeenCalled();
  });

  it('keeps the initial sound-pack rejection handled when ripgrep setup throws', async () => {
    const discoveryFailure = new Error('discovery failed');
    const pathFailure = new Error('ripgrep path failed');
    notificationSoundsService.listPacks.mockImplementation(() => {
      throw discoveryFailure;
    });
    mocks.getRipgrepBasePath.mockImplementation(() => {
      throw pathFailure;
    });

    const result = await runNotificationRuntimePhase(phaseOptions());
    expect(() => result.startNotificationBackgroundWork()).toThrow(pathFailure);
    await flushMicrotasks();

    expect(logger.error).toHaveBeenCalledWith(
      '[Main] Failed to save discovered sound packs',
      discoveryFailure,
    );
    expect(mocks.ensureRipgrepInstalled).not.toHaveBeenCalled();
  });

  it('logs successful ripgrep bootstrap only in verbose mode', async () => {
    mocks.ensureRipgrepInstalled.mockResolvedValue({ success: true });

    const result = await runNotificationRuntimePhase(phaseOptions(true));
    result.startNotificationBackgroundWork();
    await flushMicrotasks();

    expect(logger.debug).toHaveBeenCalledWith(
      'Ripgrep is available for grep/glob operations',
    );
    expect(telemetryService.captureException).not.toHaveBeenCalled();
  });

  it('captures resolved ripgrep failures before warning about fallback', async () => {
    const branchOrder: string[] = [];
    captureException.mockImplementation(() => {
      branchOrder.push('telemetry');
    });
    loggerWarn.mockImplementation(() => {
      branchOrder.push('warn');
    });
    mocks.ensureRipgrepInstalled.mockResolvedValue({
      success: false,
      error: undefined,
    });

    const result = await runNotificationRuntimePhase(phaseOptions());
    result.startNotificationBackgroundWork();
    await flushMicrotasks();

    expect(branchOrder).toEqual(['telemetry', 'warn']);
    expect(telemetryService.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unknown error' }),
      { service: 'main', operation: 'ensureRipgrep' },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Ripgrep installation failed: undefined. Grep/glob operations will use slower Node.js implementations.',
    );
  });

  it('warns before capturing rejected ripgrep bootstrap promises', async () => {
    const branchOrder: string[] = [];
    const failure = new Error('install rejected');
    loggerWarn.mockImplementation(() => {
      branchOrder.push('warn');
    });
    captureException.mockImplementation(() => {
      branchOrder.push('telemetry');
    });
    mocks.ensureRipgrepInstalled.mockRejectedValue(failure);

    const result = await runNotificationRuntimePhase(phaseOptions());
    result.startNotificationBackgroundWork();
    await flushMicrotasks();

    expect(branchOrder).toEqual(['warn', 'telemetry']);
    expect(logger.warn).toHaveBeenCalledWith(
      `Ripgrep installation failed: ${failure}. Grep/glob operations will use slower Node.js implementations.`,
    );
    expect(telemetryService.captureException).toHaveBeenCalledWith(failure, {
      service: 'main',
      operation: 'ensureRipgrep',
    });
  });
});
