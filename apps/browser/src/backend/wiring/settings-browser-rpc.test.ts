import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('electron', () => ({
  clipboard: { writeText: electronMocks.writeText },
  dialog: { showOpenDialog: electronMocks.showOpenDialog },
}));

import { wireSettingsBrowserRpc } from './settings-browser-rpc';

const PROCEDURE_NAMES = [
  'config.previewSoundPack',
  'config.importSoundPack',
  'closedLidSleep.toggle',
  'closedLidSleep.refresh',
  'browser.addSearchEngine',
  'browser.removeSearchEngine',
  'browser.copyText',
  'browser.clearBrowsingData',
  'browser.getHistory',
  'browser.getFaviconBitmaps',
] as const;

type ProcedureName = (typeof PROCEDURE_NAMES)[number];
type RegisteredHandler = (...args: unknown[]) => unknown;

function createHarness() {
  const handlers = new Map<string, RegisteredHandler>();
  const registrationOrder: string[] = [];
  const registerServerProcedureHandler = vi.fn(
    (name: string, handler: unknown) => {
      registrationOrder.push(name);
      handlers.set(name, handler as RegisteredHandler);
    },
  );
  const kartonState = { searchEngines: [] as unknown[] };
  const setState = vi.fn(
    (update: (draft: typeof kartonState) => void): void => {
      update(kartonState);
    },
  );
  const notificationSoundsService = {
    importPack: vi.fn(),
    previewPackDoneSound: vi.fn(),
  };
  const macOSClosedLidSleepService = {
    refresh: vi.fn(),
    toggle: vi.fn(),
  };
  const webDataService = {
    addSearchEngine: vi.fn(),
    getSearchEngines: vi.fn(),
    removeSearchEngine: vi.fn(),
  };
  const pagesService = { clearBrowsingData: vi.fn() };
  const historyService = { queryHistory: vi.fn() };
  const faviconService = {
    getFaviconBitmaps: vi.fn(),
    getFaviconsForUrls: vi.fn(),
  };
  const logger = { error: vi.fn() };
  const syncAvailableSoundPacks = vi.fn();

  wireSettingsBrowserRpc({
    uiKarton: {
      registerServerProcedureHandler,
      setState,
    },
    notificationSoundsService,
    syncAvailableSoundPacks,
    macOSClosedLidSleepService,
    webDataService,
    pagesService,
    historyService,
    faviconService,
    logger,
  } as unknown as Parameters<typeof wireSettingsBrowserRpc>[0]);

  return {
    faviconService,
    handler(name: ProcedureName): RegisteredHandler {
      const registered = handlers.get(name);
      if (!registered) throw new Error(`Missing handler for ${name}`);
      return registered;
    },
    historyService,
    kartonState,
    logger,
    macOSClosedLidSleepService,
    notificationSoundsService,
    pagesService,
    registerServerProcedureHandler,
    registrationOrder,
    setState,
    syncAvailableSoundPacks,
    webDataService,
  };
}

beforeEach(() => {
  electronMocks.showOpenDialog.mockReset();
  electronMocks.writeText.mockReset();
});

describe('wireSettingsBrowserRpc', () => {
  it('registers the extracted procedures in their original order', () => {
    const harness = createHarness();

    expect(harness.registrationOrder).toEqual(PROCEDURE_NAMES);
    expect(harness.registerServerProcedureHandler).toHaveBeenCalledTimes(
      PROCEDURE_NAMES.length,
    );
  });

  it('forwards preview, closed-lid sleep, clipboard, and clearing calls', async () => {
    const harness = createHarness();
    const toggledState = { isSleepDisabled: true };
    const refreshedState = { isSleepDisabled: false };
    const clearOptions = { history: true, cache: true };
    const clearResult = { success: true, historyEntriesCleared: 3 };
    harness.notificationSoundsService.previewPackDoneSound.mockResolvedValue(
      true,
    );
    harness.macOSClosedLidSleepService.toggle.mockResolvedValue(toggledState);
    harness.macOSClosedLidSleepService.refresh.mockResolvedValue(
      refreshedState,
    );
    harness.pagesService.clearBrowsingData.mockResolvedValue(clearResult);

    await expect(
      harness.handler('config.previewSoundPack')(
        'caller',
        'custom-pack',
        'subtle',
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.handler('closedLidSleep.toggle')('caller'),
    ).resolves.toBe(toggledState);
    await expect(
      harness.handler('closedLidSleep.refresh')('caller'),
    ).resolves.toBe(refreshedState);
    await expect(
      harness.handler('browser.copyText')('caller', 'copied text'),
    ).resolves.toBeUndefined();
    await expect(
      harness.handler('browser.clearBrowsingData')('caller', clearOptions),
    ).resolves.toBe(clearResult);

    expect(
      harness.notificationSoundsService.previewPackDoneSound,
    ).toHaveBeenCalledWith('custom-pack', 'subtle');
    expect(harness.macOSClosedLidSleepService.toggle).toHaveBeenCalledWith();
    expect(harness.macOSClosedLidSleepService.refresh).toHaveBeenCalledWith();
    expect(electronMocks.writeText).toHaveBeenCalledWith('copied text');
    expect(harness.pagesService.clearBrowsingData).toHaveBeenCalledWith(
      clearOptions,
    );
  });

  it.each([
    ['a canceled dialog', { canceled: true, filePaths: ['/tmp/ignored.mp3'] }],
    ['an empty selection', { canceled: false, filePaths: [] }],
  ])('returns the empty error for %s', async (_label, dialogResult) => {
    const harness = createHarness();
    electronMocks.showOpenDialog.mockResolvedValue(dialogResult);

    await expect(
      harness.handler('config.importSoundPack')('caller'),
    ).resolves.toEqual({ error: '' });

    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith({
      title: 'Use Custom Sound',
      filters: [
        { name: 'Sound files', extensions: ['mp3', 'json'] },
        { name: 'MP3 audio', extensions: ['mp3'] },
        { name: 'Sound pack JSON', extensions: ['json'] },
      ],
      properties: ['openFile'],
    });
    expect(harness.notificationSoundsService.importPack).not.toHaveBeenCalled();
    expect(harness.syncAvailableSoundPacks).not.toHaveBeenCalled();
  });

  it('imports the first selected sound pack and persists its selection', async () => {
    const harness = createHarness();
    const imported = { id: 'custom-pack', name: 'Custom Pack' };
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/custom-pack.json', '/tmp/ignored.mp3'],
    });
    harness.notificationSoundsService.importPack.mockResolvedValue(imported);
    harness.syncAvailableSoundPacks.mockResolvedValue(undefined);

    await expect(
      harness.handler('config.importSoundPack')('caller'),
    ).resolves.toBe(imported);

    expect(harness.notificationSoundsService.importPack).toHaveBeenCalledWith(
      '/tmp/custom-pack.json',
    );
    expect(harness.syncAvailableSoundPacks).toHaveBeenCalledWith('custom-pack');
  });

  it('forwards sound-pack import errors without trying to save selection', async () => {
    const harness = createHarness();
    const importError = { error: 'Invalid sound pack manifest.' };
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/broken.json'],
    });
    harness.notificationSoundsService.importPack.mockResolvedValue(importError);

    await expect(
      harness.handler('config.importSoundPack')('caller'),
    ).resolves.toBe(importError);

    expect(harness.syncAvailableSoundPacks).not.toHaveBeenCalled();
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  it('logs selection save failures and returns the stable sound-pack error', async () => {
    const harness = createHarness();
    const saveError = new Error('config write failed');
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/custom.mp3'],
    });
    harness.notificationSoundsService.importPack.mockResolvedValue({
      id: 'custom-pack',
      name: 'Custom Pack',
    });
    harness.syncAvailableSoundPacks.mockRejectedValue(saveError);

    await expect(
      harness.handler('config.importSoundPack')('caller'),
    ).resolves.toEqual({
      error: 'Sound pack imported, but saving the selection failed.',
    });

    expect(harness.syncAvailableSoundPacks).toHaveBeenCalledWith('custom-pack');
    expect(harness.logger.error).toHaveBeenCalledWith(
      '[Main] Failed to save imported sound pack',
      saveError,
    );
  });

  it('refreshes Karton search-engine state after add and remove operations', async () => {
    const harness = createHarness();
    const input = {
      name: 'Example',
      url: 'https://example.com/?q=%s',
      keyword: 'ex',
    };
    const afterAdd = [{ id: 101, shortName: 'Example' }];
    const afterRemove = [{ id: 1, shortName: 'Built-in' }];
    harness.webDataService.addSearchEngine.mockResolvedValue(101);
    harness.webDataService.removeSearchEngine.mockResolvedValue(false);
    harness.webDataService.getSearchEngines
      .mockResolvedValueOnce(afterAdd)
      .mockResolvedValueOnce(afterRemove);

    await expect(
      harness.handler('browser.addSearchEngine')('caller', input),
    ).resolves.toEqual({ id: 101, success: true });
    expect(harness.webDataService.addSearchEngine).toHaveBeenCalledWith(input);
    expect(harness.kartonState.searchEngines).toBe(afterAdd);

    await expect(
      harness.handler('browser.removeSearchEngine')('caller', 101),
    ).resolves.toEqual({ success: false });
    expect(harness.webDataService.removeSearchEngine).toHaveBeenCalledWith(101);
    expect(harness.kartonState.searchEngines).toBe(afterRemove);
    expect(harness.setState).toHaveBeenCalledTimes(2);
  });

  it('enriches history favicons and converts favicon bitmap maps to records', async () => {
    const harness = createHarness();
    const filter = { text: 'example', limit: 20 };
    const firstVisit = {
      visitId: 1,
      urlId: 10,
      url: 'https://one.example',
      title: 'One',
      visitTime: new Date('2026-07-13T00:00:00.000Z'),
      visitCount: 2,
      transition: 1,
    };
    const secondVisit = {
      ...firstVisit,
      visitId: 2,
      urlId: 20,
      url: 'https://two.example',
      title: 'Two',
    };
    const bitmap = {
      faviconUrl: 'https://one.example/favicon.ico',
      imageData: 'base64-image',
      width: 16,
      height: 16,
    };
    harness.historyService.queryHistory.mockResolvedValue([
      firstVisit,
      secondVisit,
    ]);
    harness.faviconService.getFaviconsForUrls.mockResolvedValue(
      new Map([['https://one.example', bitmap.faviconUrl]]),
    );
    harness.faviconService.getFaviconBitmaps.mockResolvedValue(
      new Map([[bitmap.faviconUrl, bitmap]]),
    );

    await expect(
      harness.handler('browser.getHistory')('caller', filter),
    ).resolves.toEqual([
      { ...firstVisit, faviconUrl: bitmap.faviconUrl },
      { ...secondVisit, faviconUrl: null },
    ]);
    expect(harness.historyService.queryHistory).toHaveBeenCalledWith(filter);
    expect(harness.faviconService.getFaviconsForUrls).toHaveBeenCalledWith([
      'https://one.example',
      'https://two.example',
    ]);

    await expect(
      harness.handler('browser.getFaviconBitmaps')('caller', [
        bitmap.faviconUrl,
      ]),
    ).resolves.toEqual({ [bitmap.faviconUrl]: bitmap });
    expect(harness.faviconService.getFaviconBitmaps).toHaveBeenCalledWith([
      bitmap.faviconUrl,
    ]);
  });
});
