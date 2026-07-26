import { ensureRipgrepInstalled } from '@clodex/agent-runtime-node';
import { app } from 'electron';
import path from 'node:path';
import { AutoUpdateService } from '../../services/auto-update';
import type { FaviconService } from '../../services/favicon';
import { GlobalConfigService } from '../../services/global-config';
import type { HistoryService } from '../../services/history';
import type { KartonService } from '../../services/karton';
import type { LocalPortsScannerService } from '../../services/local-ports-scanner';
import type { Logger } from '../../services/logger';
import { NotificationService } from '../../services/notification';
import { NotificationSoundsService } from '../../services/notification-sounds';
import { OmniboxSuggestionsService } from '../../services/omnibox-suggestions';
import type { PreferencesService } from '../../services/preferences';
import type { TelemetryService } from '../../services/telemetry';
import type { WebDataService } from '../../services/webdata';
import type { WindowLayoutService } from '../../services/window-layout';
import { getRipgrepBasePath } from '../../utils/paths';
import { setupUrlHandlers } from '../url-routing';

export type SyncAvailableSoundPacks = (selectedPack?: string) => Promise<void>;

export interface NotificationRuntimePhaseOptions {
  logger: Logger;
  verbose?: boolean;
  uiKarton: KartonService;
  historyService: HistoryService;
  webDataService: WebDataService;
  faviconService: FaviconService;
  localPortsScannerService: LocalPortsScannerService;
  windowLayoutService: WindowLayoutService;
  telemetryService: TelemetryService;
  preferencesService: PreferencesService;
}

export type NotificationRuntimePhaseResult = ReturnType<
  typeof setupUrlHandlers
> & {
  omniboxSuggestionsService: OmniboxSuggestionsService;
  notificationService: NotificationService;
  autoUpdateService: AutoUpdateService;
  globalConfigService: GlobalConfigService;
  notificationSoundsService: NotificationSoundsService;
  syncAvailableSoundPacks: SyncAvailableSoundPacks;
  startNotificationBackgroundWork: () => void;
};

export async function runNotificationRuntimePhase(
  options: NotificationRuntimePhaseOptions,
): Promise<NotificationRuntimePhaseResult> {
  const {
    logger,
    verbose,
    uiKarton,
    historyService,
    webDataService,
    faviconService,
    localPortsScannerService,
    windowLayoutService,
    telemetryService,
    preferencesService,
  } = options;

  const omniboxSuggestionsService = await OmniboxSuggestionsService.create(
    logger,
    uiKarton,
    historyService,
    webDataService,
    faviconService,
    localPortsScannerService,
  );

  const urlHandlers = setupUrlHandlers(windowLayoutService, logger);

  const notificationService = await NotificationService.create(
    logger,
    uiKarton,
  );
  const autoUpdateService = await AutoUpdateService.create(
    logger,
    notificationService,
    telemetryService,
    preferencesService,
    uiKarton,
  );
  const globalConfigService = await GlobalConfigService.create(
    logger,
    uiKarton,
  );

  // Packaged builds copy the leaf directory directly into Resources/;
  // development reads the checked-in assets directory under the app root.
  const soundsDir = app.isPackaged
    ? path.join(process.resourcesPath!, 'sounds')
    : path.join(app.getAppPath(), 'assets', 'sounds');
  const importedPacksDir = path.join(
    app.getPath('userData'),
    'imported-sound-packs',
  );

  const notificationSoundsService = await NotificationSoundsService.create(
    logger,
    uiKarton,
    soundsDir,
    importedPacksDir,
    globalConfigService.get(),
  );

  notificationSoundsService.setWindowRef(() =>
    windowLayoutService.getBaseWindow(),
  );
  notificationSoundsService.setWebContentsRef(() =>
    windowLayoutService.getUIWebContents(),
  );
  notificationSoundsService.setFocusAgentHandler((agentId) =>
    windowLayoutService.focusAgentFromExternalWindow(agentId),
  );

  const notificationSoundsConfigListener: Parameters<
    typeof globalConfigService.addConfigUpdatedListener
  >[0] = (newConfig) => {
    notificationSoundsService.onConfigUpdated(newConfig);
  };
  globalConfigService.addConfigUpdatedListener(
    notificationSoundsConfigListener,
  );

  const syncAvailableSoundPacks: SyncAvailableSoundPacks = async (
    selectedPack,
  ) => {
    const packs = notificationSoundsService.listPacks();
    const displayNames = notificationSoundsService.getPackDisplayNames();

    uiKarton.setState((draft) => {
      draft.notificationSoundPacks = {
        available: packs,
        displayNames,
      };
    });

    if (selectedPack) {
      await globalConfigService.set({
        ...globalConfigService.get(),
        notificationSoundPack: selectedPack,
      });
    }
  };

  const startNotificationBackgroundWork = (): void => {
    void syncAvailableSoundPacks().catch((error) => {
      logger.error('[Main] Failed to save discovered sound packs', error);
    });

    ensureRipgrepInstalled({
      rgBinaryBasePath: getRipgrepBasePath(),
      onLog: logger.debug,
    })
      .then((installResult) => {
        if (!installResult.success) {
          telemetryService.captureException(
            new Error(installResult.error ?? 'Unknown error'),
            { service: 'main', operation: 'ensureRipgrep' },
          );
          logger.warn(
            `Ripgrep installation failed: ${installResult.error}. Grep/glob operations will use slower Node.js implementations.`,
          );
        } else if (verbose) {
          logger.debug('Ripgrep is available for grep/glob operations');
        }
      })
      .catch((error) => {
        logger.warn(
          `Ripgrep installation failed: ${error}. Grep/glob operations will use slower Node.js implementations.`,
        );
        telemetryService.captureException(error as Error, {
          service: 'main',
          operation: 'ensureRipgrep',
        });
      });
  };

  return {
    ...urlHandlers,
    omniboxSuggestionsService,
    notificationService,
    autoUpdateService,
    globalConfigService,
    notificationSoundsService,
    syncAvailableSoundPacks,
    startNotificationBackgroundWork,
  };
}
