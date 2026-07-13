import type { FileTreeService } from '../services/file-tree';
import type { KartonService } from '../services/karton';
import type { Logger } from '../services/logger';

type FileTreeRpcService = Pick<
  FileTreeService,
  | 'listDirectory'
  | 'getFilePreview'
  | 'getFileStat'
  | 'saveFile'
  | 'openFileTab'
  | 'openAttachmentTab'
  | 'renameEntry'
  | 'pasteEntry'
  | 'deleteEntry'
  | 'createFile'
  | 'recreateDeletedFile'
  | 'revealInFolder'
  | 'setVisible'
  | 'setActiveWorkspace'
  | 'setViewMode'
  | 'setDirectoryExpanded'
  | 'searchFiles'
  | 'listRecentFiles'
>;

export function wireFileTreeSwarmRpc(deps: {
  uiKarton: Pick<KartonService, 'registerServerProcedureHandler'>;
  fileTreeService: FileTreeRpcService;
  promoteFileTab: (tabId: string) => void;
  runSwarmWorkflow: (
    agentInstanceId: string,
    prompt: string,
  ) => Promise<string>;
  runForcedSwarmPreview: (
    agentInstanceId: string,
    prompt: string,
  ) => Promise<string>;
  clearSwarmRun: (runId: string) => void;
  logger: Pick<Logger, 'error'>;
}): void {
  const {
    uiKarton,
    fileTreeService,
    promoteFileTab,
    runSwarmWorkflow,
    runForcedSwarmPreview,
    clearSwarmRun,
    logger,
  } = deps;

  uiKarton.registerServerProcedureHandler(
    'fileTree.listDirectory',
    async (_cid, input) => fileTreeService.listDirectory(input),
  );
  uiKarton.registerServerProcedureHandler(
    'swarm.run',
    async (_cid, agentInstanceId: string, prompt: string) => {
      const swarmPrompt = prompt || 'Run Dynamic Swarm.';
      void runSwarmWorkflow(agentInstanceId, swarmPrompt).catch((error) => {
        logger.error('[SwarmRun] Background workflow failed', {
          agentInstanceId,
          error,
        });
      });
      return 'started';
    },
  );
  uiKarton.registerServerProcedureHandler(
    'swarm.preview',
    async (_cid, agentInstanceId: string, prompt: string) => {
      return await runForcedSwarmPreview(agentInstanceId, prompt);
    },
  );
  uiKarton.registerServerProcedureHandler(
    'swarm.clearRun',
    async (_cid, runId: string) => clearSwarmRun(runId),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.getFilePreview',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.getFilePreview(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.getFileStat',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.getFileStat(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.saveFile',
    async (
      _cid,
      workspaceKey: string,
      relativePath: string,
      text: string,
      expectedMtimeMs?: number | null,
    ) =>
      fileTreeService.saveFile(
        workspaceKey,
        relativePath,
        text,
        expectedMtimeMs,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.openFileTab',
    async (
      _cid,
      workspaceKey: string,
      relativePath: string,
      agentInstanceId?: string | null,
      options?: { preview?: boolean; temporaryGroupKey?: string },
    ) =>
      fileTreeService.openFileTab(
        workspaceKey,
        relativePath,
        agentInstanceId,
        options,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.openAttachmentTab',
    async (
      _cid,
      agentId: string,
      attachmentId: string,
      displayName?: string,
      agentInstanceId?: string | null,
      options?: { preview?: boolean; temporaryGroupKey?: string },
    ) =>
      fileTreeService.openAttachmentTab(
        agentId,
        attachmentId,
        displayName,
        agentInstanceId,
        options,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.promoteFileTab',
    async (_cid, tabId: string) => promoteFileTab(tabId),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.renameEntry',
    async (_cid, workspaceKey: string, relativePath: string, newName: string) =>
      fileTreeService.renameEntry(workspaceKey, relativePath, newName),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.pasteEntry',
    async (
      _cid,
      sourceWorkspaceKey: string,
      sourceRelativePath: string,
      targetWorkspaceKey: string,
      targetDirectoryPath: string,
      operation: 'copy' | 'cut',
      preferredName?: string,
    ) =>
      fileTreeService.pasteEntry(
        sourceWorkspaceKey,
        sourceRelativePath,
        targetWorkspaceKey,
        targetDirectoryPath,
        operation,
        preferredName,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.deleteEntry',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.deleteEntry(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.createFile',
    async (_cid, workspaceKey: string, directoryPath: string) =>
      fileTreeService.createFile(workspaceKey, directoryPath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.recreateDeletedFile',
    async (_cid, workspaceKey: string, relativePath: string, content: string) =>
      fileTreeService.recreateDeletedFile(workspaceKey, relativePath, content),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.revealInFolder',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.revealInFolder(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setVisible',
    async (_cid, visible: boolean) => fileTreeService.setVisible(visible),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setActiveWorkspace',
    async (_cid, workspaceKey: string | null) =>
      fileTreeService.setActiveWorkspace(workspaceKey),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setViewMode',
    async (_cid, mode: 'files' | 'diff') => fileTreeService.setViewMode(mode),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setDirectoryExpanded',
    async (
      _cid,
      workspaceKey: string,
      directoryPath: string,
      expanded: boolean,
    ) =>
      fileTreeService.setDirectoryExpanded(
        workspaceKey,
        directoryPath,
        expanded,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.searchFiles',
    async (
      _cid,
      query: string,
      workspaceKeys: string[],
      includeGitignored: boolean,
      searchInContent?: boolean,
    ) =>
      fileTreeService.searchFiles(
        query,
        workspaceKeys,
        includeGitignored,
        searchInContent,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.listRecentFiles',
    async (
      _cid,
      workspaceKeys: string[],
      includeGitignored: boolean,
      limit: number,
    ) =>
      fileTreeService.listRecentFiles(workspaceKeys, includeGitignored, limit),
  );
}
