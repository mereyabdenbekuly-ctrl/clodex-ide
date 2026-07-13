import type { AttachmentsService } from '@clodex/agent-core/attachments';
import {
  detectShell,
  resolveShellEnv,
  type DetectedShell,
} from '@clodex/agent-shell';
import path from 'node:path';
import { FileTreeService } from '../../services/file-tree';
import type { FaviconService } from '../../services/favicon';
import { GitService } from '../../services/git';
import { HistoryService } from '../../services/history';
import type { KartonService } from '../../services/karton';
import type { Logger } from '../../services/logger';
import type { ControlledBrowserTabEgressOptions } from '../../services/network-policy/controlled-browser';
import { PagesService } from '../../services/pages';
import type { PreferencesService } from '../../services/preferences';
import type { TelemetryService } from '../../services/telemetry';
import type { WebDataService } from '../../services/webdata';
import { WindowLayoutService } from '../../services/window-layout';

export interface BrowserUiServicesPhaseOptions {
  logger: Logger;
  verbose?: boolean;
  webDataService: WebDataService;
  telemetryService: TelemetryService;
  faviconService: FaviconService;
  preferencesService: PreferencesService;
  attachments: AttachmentsService;
  controlledBrowserEgress?: ControlledBrowserTabEgressOptions;
}

export interface BrowserUiServicesPhaseResult {
  historyService: HistoryService;
  pagesService: PagesService;
  windowLayoutService: WindowLayoutService;
  uiKarton: KartonService;
  fileTreeService: FileTreeService;
  detectedShell: DetectedShell | null;
  resolvedEnvPromise: Promise<Record<string, string> | null>;
  gitService: GitService;
  startSearchEngineSync: () => void;
}

export async function runBrowserUiServicesPhase(
  options: BrowserUiServicesPhaseOptions,
): Promise<BrowserUiServicesPhaseResult> {
  const {
    logger,
    verbose,
    webDataService,
    telemetryService,
    faviconService,
    preferencesService,
    attachments,
    controlledBrowserEgress,
  } = options;

  // HistoryService depends on WebDataService + telemetry.
  const historyService = await HistoryService.create(
    logger,
    webDataService,
    telemetryService,
  );

  // PagesService must exist before WindowLayoutService.
  const pagesService = await PagesService.create(
    logger,
    historyService,
    faviconService,
    telemetryService,
  );

  // WindowLayoutService applies the startup page preference while it
  // initializes and owns the UI Karton instance used below.
  const windowLayoutService = await WindowLayoutService.create(
    logger,
    historyService,
    faviconService,
    pagesService,
    preferencesService,
    attachments,
    telemetryService,
    controlledBrowserEgress,
  );
  const uiKarton = windowLayoutService.uiKarton;

  const fileTreeService = await FileTreeService.create(logger, uiKarton);
  fileTreeService.setOpenFileTabHandler(
    async (metadata, agentInstanceId, openOptions) => {
      const tabId = await windowLayoutService.openFileTab(
        metadata,
        agentInstanceId,
        openOptions,
      );
      // Read-only, agent-internal files (for example attachment blobs) do
      // not belong to a listed workspace tree, so revealing them would
      // only open the panel on a workspace that is not present.
      if (!metadata.readOnly) {
        fileTreeService.revealInFileTree(
          metadata.workspaceKey,
          metadata.relativePath,
        );
      }
      return tabId;
    },
  );
  fileTreeService.setAttachmentDirResolver((agentId) =>
    attachments.agentBlobDir(agentId),
  );
  fileTreeService.setAttachmentReader(
    (attachmentDir) => {
      const normalized = path.resolve(attachmentDir);
      if (path.basename(normalized) !== 'data-attachments') return null;
      const agentId = path.basename(path.dirname(normalized));
      return agentId || null;
    },
    (agentId, attachmentId) => attachments.read(agentId, attachmentId),
  );

  const detectedShell = detectShell();
  const resolvedEnvPromise = detectedShell
    ? resolveShellEnv(detectedShell)
    : Promise.resolve(null);
  const gitService = await GitService.create({
    logger,
    telemetryService,
    resolvedEnvPromise,
  });

  const startSearchEngineSync = (): void => {
    webDataService
      .getSearchEngines()
      .then((engines) => {
        uiKarton.setState((draft) => {
          draft.searchEngines = engines;
        });
        if (verbose) {
          logger.debug(
            `[Main] Pushed ${engines.length} search engines to UI karton`,
          );
        }
      })
      .catch((error) => {
        logger.warn('[Main] Failed to load search engines', error);
      });
  };

  return {
    historyService,
    pagesService,
    windowLayoutService,
    uiKarton,
    fileTreeService,
    detectedShell,
    resolvedEnvPromise,
    gitService,
    startSearchEngineSync,
  };
}
