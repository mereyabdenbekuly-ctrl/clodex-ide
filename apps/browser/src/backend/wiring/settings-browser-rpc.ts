import { clipboard, dialog } from 'electron';
import type {
  FaviconBitmapResult,
  HistoryFilter,
  HistoryResult,
} from '@shared/karton-contracts/pages-api/types';
import type { FaviconService } from '../services/favicon';
import type { HistoryService } from '../services/history';
import type { KartonService } from '../services/karton';
import type { Logger } from '../services/logger';
import type { MacOSClosedLidSleepService } from '../services/macos-closed-lid-sleep';
import type { NotificationSoundsService } from '../services/notification-sounds';
import type { PagesService } from '../services/pages';
import type { WebDataService } from '../services/webdata';

export function wireSettingsBrowserRpc(deps: {
  uiKarton: KartonService;
  notificationSoundsService: NotificationSoundsService;
  syncAvailableSoundPacks: (selectedPack?: string) => Promise<void>;
  macOSClosedLidSleepService: MacOSClosedLidSleepService;
  webDataService: WebDataService;
  pagesService: PagesService;
  historyService: HistoryService;
  faviconService: FaviconService;
  logger: Logger;
}): void {
  const {
    uiKarton,
    notificationSoundsService,
    syncAvailableSoundPacks,
    macOSClosedLidSleepService,
    webDataService,
    pagesService,
    historyService,
    faviconService,
    logger,
  } = deps;

  uiKarton.registerServerProcedureHandler(
    'config.previewSoundPack',
    async (
      _cid: string,
      packId: string,
      loudness: 'off' | 'subtle' | 'default',
    ) => ({
      ok: await notificationSoundsService.previewPackDoneSound(
        packId,
        loudness,
      ),
    }),
  );

  uiKarton.registerServerProcedureHandler(
    'config.importSoundPack',
    async () => {
      const result = await dialog.showOpenDialog({
        title: 'Use Custom Sound',
        filters: [
          { name: 'Sound files', extensions: ['mp3', 'json'] },
          { name: 'MP3 audio', extensions: ['mp3'] },
          { name: 'Sound pack JSON', extensions: ['json'] },
        ],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { error: '' };
      }

      const imported = await notificationSoundsService.importPack(
        result.filePaths[0],
      );
      if ('error' in imported) return imported;

      try {
        await syncAvailableSoundPacks(imported.id);
      } catch (err) {
        logger.error('[Main] Failed to save imported sound pack', err);
        return {
          error: 'Sound pack imported, but saving the selection failed.',
        };
      }

      return imported;
    },
  );

  uiKarton.registerServerProcedureHandler('closedLidSleep.toggle', async () => {
    return macOSClosedLidSleepService.toggle();
  });
  uiKarton.registerServerProcedureHandler(
    'closedLidSleep.refresh',
    async () => {
      return macOSClosedLidSleepService.refresh();
    },
  );

  // browser.addSearchEngine / removeSearchEngine
  uiKarton.registerServerProcedureHandler(
    'browser.addSearchEngine',
    async (
      _cid: string,
      input: { name: string; url: string; keyword: string },
    ) => {
      const id = await webDataService.addSearchEngine(input);
      await webDataService.getSearchEngines().then((engines) => {
        uiKarton.setState((draft) => {
          draft.searchEngines = engines;
        });
      });
      return { id, success: true };
    },
  );
  uiKarton.registerServerProcedureHandler(
    'browser.removeSearchEngine',
    async (_cid: string, id: number) => {
      const removed = await webDataService.removeSearchEngine(id);
      await webDataService.getSearchEngines().then((engines) => {
        uiKarton.setState((draft) => {
          draft.searchEngines = engines;
        });
      });
      return { success: removed };
    },
  );

  // browser.copyText - write text to the system clipboard from the main
  // process. The UI renderer's navigator.clipboard rejects when focus is
  // inside a web-content view, so clipboard writes are routed through here.
  uiKarton.registerServerProcedureHandler(
    'browser.copyText',
    async (_cid: string, text: string) => {
      clipboard.writeText(text);
    },
  );

  // browser.clearBrowsingData
  uiKarton.registerServerProcedureHandler(
    'browser.clearBrowsingData',
    async (
      _cid: string,
      options: Parameters<typeof pagesService.clearBrowsingData>[0],
    ) => {
      return pagesService.clearBrowsingData(options);
    },
  );

  // browser.getHistory / browser.getFaviconBitmaps (history settings section)
  uiKarton.registerServerProcedureHandler(
    'browser.getHistory',
    async (_cid: string, filter: HistoryFilter): Promise<HistoryResult[]> => {
      const results = await historyService.queryHistory(filter);
      const pageUrls = results.map((r) => r.url);
      const faviconMap = await faviconService.getFaviconsForUrls(pageUrls);
      return results.map((r) => ({
        ...r,
        faviconUrl: faviconMap.get(r.url) ?? null,
      }));
    },
  );
  uiKarton.registerServerProcedureHandler(
    'browser.getFaviconBitmaps',
    async (
      _cid: string,
      faviconUrls: string[],
    ): Promise<Record<string, FaviconBitmapResult>> => {
      const bitmapMap = await faviconService.getFaviconBitmaps(faviconUrls);
      const result: Record<string, FaviconBitmapResult> = {};
      for (const [url, bitmap] of bitmapMap) {
        result[url] = bitmap;
      }
      return result;
    },
  );
}
