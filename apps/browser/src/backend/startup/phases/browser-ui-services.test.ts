import type { AttachmentsService } from '@clodex/agent-core/attachments';
import type { DetectedShell } from '@clodex/agent-shell';
import type {
  AttachmentAgentResolver,
  AttachmentContentReader,
  AttachmentDirResolver,
  OpenFileTabHandler,
} from '../../services/file-tree';
import type { FaviconService } from '../../services/favicon';
import type { Logger } from '../../services/logger';
import type { ControlledBrowserTabEgressOptions } from '../../services/network-policy/controlled-browser';
import type { PreferencesService } from '../../services/preferences';
import type { TelemetryService } from '../../services/telemetry';
import type { WebDataService } from '../../services/webdata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  detectShell: vi.fn(),
  fileTreeCreate: vi.fn(),
  gitCreate: vi.fn(),
  historyCreate: vi.fn(),
  pagesCreate: vi.fn(),
  resolveShellEnv: vi.fn(),
  windowLayoutCreate: vi.fn(),
}));

vi.mock('@clodex/agent-shell', () => ({
  detectShell: mocks.detectShell,
  resolveShellEnv: mocks.resolveShellEnv,
}));

vi.mock('../../services/file-tree', () => ({
  FileTreeService: { create: mocks.fileTreeCreate },
}));

vi.mock('../../services/git', () => ({
  GitService: { create: mocks.gitCreate },
}));

vi.mock('../../services/history', () => ({
  HistoryService: { create: mocks.historyCreate },
}));

vi.mock('../../services/pages', () => ({
  PagesService: { create: mocks.pagesCreate },
}));

vi.mock('../../services/window-layout', () => ({
  WindowLayoutService: { create: mocks.windowLayoutCreate },
}));

import {
  runBrowserUiServicesPhase,
  type BrowserUiServicesPhaseOptions,
} from './browser-ui-services';

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
  searchEngines: unknown[];
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;
const historyService = { service: 'history' };
const pagesService = { service: 'pages' };
const gitService = { service: 'git' };
const faviconService = { service: 'favicon' } as unknown as FaviconService;
const preferencesService = {
  service: 'preferences',
} as unknown as PreferencesService;
const telemetryService = {
  service: 'telemetry',
} as unknown as TelemetryService;
const controlledBrowserEgress = {
  allowFaviconNetworkFetch: false,
} satisfies ControlledBrowserTabEgressOptions;
const detectedShell = {
  path: '/bin/zsh',
  type: 'zsh',
} as DetectedShell;

let uiState: TestUiState;
let uiKarton: {
  setState: ReturnType<typeof vi.fn>;
};
let windowLayoutService: {
  readonly uiKarton: typeof uiKarton;
  openFileTab: ReturnType<typeof vi.fn>;
};
let fileTreeService: {
  setOpenFileTabHandler: ReturnType<typeof vi.fn>;
  setAttachmentDirResolver: ReturnType<typeof vi.fn>;
  setAttachmentReader: ReturnType<typeof vi.fn>;
  revealInFileTree: ReturnType<typeof vi.fn>;
};
let attachments: {
  agentBlobDir: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
};
let webDataService: {
  getSearchEngines: ReturnType<typeof vi.fn>;
};
let openFileTabHandler: OpenFileTabHandler | undefined;
let attachmentDirResolver: AttachmentDirResolver | undefined;
let attachmentAgentResolver: AttachmentAgentResolver | undefined;
let attachmentContentReader: AttachmentContentReader | undefined;

function phaseOptions(verbose = true): BrowserUiServicesPhaseOptions {
  return {
    logger,
    verbose,
    webDataService: webDataService as unknown as WebDataService,
    telemetryService,
    faviconService,
    preferencesService,
    attachments: attachments as unknown as AttachmentsService,
    controlledBrowserEgress,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  openFileTabHandler = undefined;
  attachmentDirResolver = undefined;
  attachmentAgentResolver = undefined;
  attachmentContentReader = undefined;

  uiState = { searchEngines: [] };
  uiKarton = {
    setState: vi.fn((update: (draft: TestUiState) => void) => {
      update(uiState);
    }),
  };
  windowLayoutService = {
    get uiKarton() {
      mocks.calls.push('ui-karton');
      return uiKarton;
    },
    openFileTab: vi.fn().mockResolvedValue('tab-1'),
  };
  fileTreeService = {
    setOpenFileTabHandler: vi.fn((handler: OpenFileTabHandler) => {
      mocks.calls.push('file-tree-open-handler');
      openFileTabHandler = handler;
    }),
    setAttachmentDirResolver: vi.fn((resolver: AttachmentDirResolver) => {
      mocks.calls.push('file-tree-attachment-dir');
      attachmentDirResolver = resolver;
    }),
    setAttachmentReader: vi.fn(
      (
        agentResolver: AttachmentAgentResolver,
        contentReader: AttachmentContentReader,
      ) => {
        mocks.calls.push('file-tree-attachment-reader');
        attachmentAgentResolver = agentResolver;
        attachmentContentReader = contentReader;
      },
    ),
    revealInFileTree: vi.fn(),
  };
  attachments = {
    agentBlobDir: vi.fn(
      (agentId: string) => `/agents/${agentId}/data-attachments`,
    ),
    read: vi.fn().mockResolvedValue(Buffer.from('attachment')),
  };
  webDataService = {
    getSearchEngines: vi.fn(),
  };

  mocks.historyCreate.mockImplementation(() => {
    mocks.calls.push('history');
    return Promise.resolve(historyService);
  });
  mocks.pagesCreate.mockImplementation(() => {
    mocks.calls.push('pages');
    return Promise.resolve(pagesService);
  });
  mocks.windowLayoutCreate.mockImplementation(() => {
    mocks.calls.push('window-layout');
    return Promise.resolve(windowLayoutService);
  });
  mocks.fileTreeCreate.mockImplementation(() => {
    mocks.calls.push('file-tree');
    return Promise.resolve(fileTreeService);
  });
  mocks.detectShell.mockImplementation(() => {
    mocks.calls.push('detect-shell');
    return detectedShell;
  });
  mocks.gitCreate.mockImplementation(() => {
    mocks.calls.push('git');
    return Promise.resolve(gitService);
  });
});

describe('runBrowserUiServicesPhase', () => {
  it('preserves construction order and forwards each dependency', async () => {
    const searchEngines = deferred<unknown[]>();
    const resolvedEnvPromise = Promise.resolve({ PATH: '/shell/bin' });
    webDataService.getSearchEngines.mockImplementation(() => {
      mocks.calls.push('search-engines');
      return searchEngines.promise;
    });
    mocks.resolveShellEnv.mockImplementation(() => {
      mocks.calls.push('resolve-shell-env');
      return resolvedEnvPromise;
    });

    const result = await runBrowserUiServicesPhase(phaseOptions());
    result.startSearchEngineSync();

    expect(mocks.calls).toEqual([
      'history',
      'pages',
      'window-layout',
      'ui-karton',
      'file-tree',
      'file-tree-open-handler',
      'file-tree-attachment-dir',
      'file-tree-attachment-reader',
      'detect-shell',
      'resolve-shell-env',
      'git',
      'search-engines',
    ]);
    expect(mocks.historyCreate).toHaveBeenCalledWith(
      logger,
      webDataService,
      telemetryService,
    );
    expect(mocks.pagesCreate).toHaveBeenCalledWith(
      logger,
      historyService,
      faviconService,
      telemetryService,
    );
    expect(mocks.windowLayoutCreate).toHaveBeenCalledWith(
      logger,
      historyService,
      faviconService,
      pagesService,
      preferencesService,
      attachments,
      telemetryService,
      controlledBrowserEgress,
    );
    expect(mocks.fileTreeCreate).toHaveBeenCalledWith(logger, uiKarton);
    expect(mocks.resolveShellEnv).toHaveBeenCalledWith(detectedShell);
    expect(mocks.gitCreate).toHaveBeenCalledWith({
      logger,
      telemetryService,
      resolvedEnvPromise,
    });
    expect(result).toMatchObject({
      historyService,
      pagesService,
      windowLayoutService,
      uiKarton,
      fileTreeService,
      detectedShell,
      resolvedEnvPromise,
      gitService,
    });
    expect(uiKarton.setState).not.toHaveBeenCalled();
  });

  it('preserves editable and read-only file-tree attachment callbacks', async () => {
    webDataService.getSearchEngines.mockReturnValue(new Promise(() => {}));
    mocks.resolveShellEnv.mockResolvedValue({ PATH: '/shell/bin' });
    await runBrowserUiServicesPhase(phaseOptions());

    const editableMetadata = {
      workspaceKey: 'w:/workspace',
      relativePath: 'src/index.ts',
      absolutePath: '/workspace/src/index.ts',
      kind: 'text',
      mimeType: 'text/typescript',
      size: 12,
    } as Parameters<OpenFileTabHandler>[0];
    const openOptions = { preview: true };

    await expect(
      openFileTabHandler?.(editableMetadata, 'agent-1', openOptions),
    ).resolves.toBe('tab-1');
    expect(windowLayoutService.openFileTab).toHaveBeenCalledWith(
      editableMetadata,
      'agent-1',
      openOptions,
    );
    expect(fileTreeService.revealInFileTree).toHaveBeenCalledWith(
      editableMetadata.workspaceKey,
      editableMetadata.relativePath,
    );

    const readOnlyMetadata = { ...editableMetadata, readOnly: true };
    await openFileTabHandler?.(readOnlyMetadata, 'agent-2');
    expect(fileTreeService.revealInFileTree).toHaveBeenCalledTimes(1);

    expect(attachmentDirResolver?.('agent-a')).toBe(
      '/agents/agent-a/data-attachments',
    );
    expect(attachments.agentBlobDir).toHaveBeenCalledWith('agent-a');
    expect(attachmentAgentResolver?.('/agents/agent-a/data-attachments')).toBe(
      'agent-a',
    );
    expect(attachmentAgentResolver?.('/agents/agent-a/other')).toBeNull();
    expect(attachmentAgentResolver?.('/data-attachments')).toBeNull();

    await expect(
      attachmentContentReader?.('agent-a', 'attachment-1'),
    ).resolves.toEqual(Buffer.from('attachment'));
    expect(attachments.read).toHaveBeenCalledWith('agent-a', 'attachment-1');
  });

  it('pushes search-engine state in the background and honors verbose logging', async () => {
    const engines = [
      { id: 1, shortName: 'Example', keyword: 'example.com' },
      { id: 2, shortName: 'Search', keyword: 'search.test' },
    ];
    const searchEngines = deferred<typeof engines>();
    webDataService.getSearchEngines.mockReturnValue(searchEngines.promise);
    mocks.resolveShellEnv.mockResolvedValue({ PATH: '/shell/bin' });

    const result = await runBrowserUiServicesPhase(phaseOptions(true));
    result.startSearchEngineSync();
    expect(uiState.searchEngines).toEqual([]);

    searchEngines.resolve(engines);
    await flushMicrotasks();

    expect(uiState.searchEngines).toBe(engines);
    expect(logger.debug).toHaveBeenCalledWith(
      '[Main] Pushed 2 search engines to UI karton',
    );
  });

  it('logs search-engine failures without rejecting the phase', async () => {
    const failure = new Error('search failed');
    webDataService.getSearchEngines.mockRejectedValue(failure);
    mocks.detectShell.mockReturnValue(null);

    const result = await runBrowserUiServicesPhase(phaseOptions(false));
    result.startSearchEngineSync();
    await flushMicrotasks();

    expect(result.detectedShell).toBeNull();
    await expect(result.resolvedEnvPromise).resolves.toBeNull();
    expect(mocks.resolveShellEnv).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[Main] Failed to load search engines',
      failure,
    );
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('search engines to UI karton'),
    );
  });
});
