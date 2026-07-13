import type { KartonService } from '../services/karton';

export type UiRpcProcedureName = Parameters<
  KartonService['registerServerProcedureHandler']
>[0];

export type UiRpcWiringGroup =
  | 'pages'
  | 'fileTreeAndSwarm'
  | 'settingsAndBrowser'
  | 'workspaceAndCredentials'
  | 'modelToolboxRuntime';

export const EXPECTED_UI_RPC_PROCEDURE_NAMES = {
  // Pages runtime wiring configures state sync and PagesService callbacks, but
  // does not directly register a UI Karton procedure.
  pages: [],
  fileTreeAndSwarm: [
    'fileTree.listDirectory',
    'swarm.run',
    'swarm.preview',
    'swarm.clearRun',
    'fileTree.getFilePreview',
    'fileTree.getFileStat',
    'fileTree.saveFile',
    'fileTree.openFileTab',
    'fileTree.openAttachmentTab',
    'fileTree.promoteFileTab',
    'fileTree.renameEntry',
    'fileTree.pasteEntry',
    'fileTree.deleteEntry',
    'fileTree.createFile',
    'fileTree.recreateDeletedFile',
    'fileTree.revealInFolder',
    'fileTree.setVisible',
    'fileTree.setActiveWorkspace',
    'fileTree.setViewMode',
    'fileTree.setDirectoryExpanded',
    'fileTree.searchFiles',
    'fileTree.listRecentFiles',
  ],
  settingsAndBrowser: [
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
  ],
  workspaceAndCredentials: [
    'toolbox.getContextFiles',
    'toolbox.generateWorkspaceMdForPath',
    'toolbox.listWorktreeSetupRepositories',
    'toolbox.saveWorktreeSetupScript',
    'toolbox.deleteWorktreeSetupWorktree',
    'credentials.set',
    'credentials.delete',
    'credentials.getConfiguredIds',
  ],
  modelToolboxRuntime: [
    'preferences.testProviderProfile',
    'preferences.listProviderProfileModels',
  ],
} as const satisfies Record<UiRpcWiringGroup, readonly UiRpcProcedureName[]>;
