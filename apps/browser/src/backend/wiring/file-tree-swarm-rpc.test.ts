import { describe, expect, it, vi } from 'vitest';
import type { FileTreeService } from '../services/file-tree';
import type { KartonService } from '../services/karton';
import type { Logger } from '../services/logger';
import { wireFileTreeSwarmRpc } from './file-tree-swarm-rpc';

type Handler = (clientId: string, ...args: unknown[]) => Promise<unknown>;

function createHarness() {
  const handlers = new Map<string, Handler>();
  const registeredNames: string[] = [];
  const uiKarton = {
    registerServerProcedureHandler(name: string, handler: Handler) {
      registeredNames.push(name);
      handlers.set(name, handler);
    },
  } as unknown as KartonService;

  const directoryResult = { kind: 'directory-result' };
  const saveResult = { kind: 'save-result' };
  const attachmentTabResult = 'attachment-tab-id';
  const pasteResult = { success: true, relativePath: 'target/copied.ts' };
  const recentFilesResult = [{ relativePath: 'src/recent.ts' }];
  const listDirectory = vi.fn(async (_input: unknown) => directoryResult);
  const saveFile = vi.fn(
    async (
      _workspaceKey: string,
      _relativePath: string,
      _text: string,
      _expectedMtimeMs?: number | null,
    ) => saveResult,
  );
  const openAttachmentTab = vi.fn(
    async (
      _agentId: string,
      _attachmentId: string,
      _displayName?: string,
      _agentInstanceId?: string | null,
      _options?: { preview?: boolean; temporaryGroupKey?: string },
    ) => attachmentTabResult,
  );
  const pasteEntry = vi.fn(
    async (
      _sourceWorkspaceKey: string,
      _sourceRelativePath: string,
      _targetWorkspaceKey: string,
      _targetDirectoryPath: string,
      _operation: 'copy' | 'cut',
      _preferredName?: string,
    ) => pasteResult,
  );
  const listRecentFiles = vi.fn(
    async (
      _workspaceKeys: string[],
      _includeGitignored: boolean,
      _limit: number,
    ) => recentFilesResult,
  );
  const fileTreeService = {
    listDirectory,
    saveFile,
    openAttachmentTab,
    pasteEntry,
    listRecentFiles,
  } as unknown as FileTreeService;

  const promoteFileTab = vi.fn();
  const runSwarmWorkflow = vi.fn(async () => 'swarm-run-id');
  const runForcedSwarmPreview = vi.fn(async () => 'preview-run-id');
  const clearSwarmRun = vi.fn();
  const logger = {
    error: vi.fn(),
  } as unknown as Logger;

  wireFileTreeSwarmRpc({
    uiKarton,
    fileTreeService,
    promoteFileTab,
    runSwarmWorkflow,
    runForcedSwarmPreview,
    clearSwarmRun,
    logger,
  });

  return {
    attachmentTabResult,
    clearSwarmRun,
    directoryResult,
    handlers,
    listDirectory,
    listRecentFiles,
    logger,
    openAttachmentTab,
    pasteEntry,
    pasteResult,
    promoteFileTab,
    recentFilesResult,
    registeredNames,
    runForcedSwarmPreview,
    runSwarmWorkflow,
    saveFile,
    saveResult,
  };
}

describe('wireFileTreeSwarmRpc', () => {
  it('registers exactly the extracted procedures in their original order', () => {
    const { registeredNames } = createHarness();

    expect(registeredNames).toEqual([
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
    ]);
  });

  it('forwards representative file-tree arguments and return values unchanged', async () => {
    const harness = createHarness();
    const listInput = {
      workspaceKey: 'local:/workspace',
      directoryPath: 'src',
      cursor: '20',
      limit: 10,
    };
    const attachmentOptions = {
      preview: true,
      temporaryGroupKey: 'preview-group',
    };

    await expect(
      harness.handlers.get('fileTree.listDirectory')!('client', listInput),
    ).resolves.toBe(harness.directoryResult);
    expect(harness.listDirectory).toHaveBeenCalledWith(listInput);

    await expect(
      harness.handlers.get('fileTree.saveFile')!(
        'client',
        'local:/workspace',
        'src/file.ts',
        'updated text',
        null,
      ),
    ).resolves.toBe(harness.saveResult);
    expect(harness.saveFile).toHaveBeenCalledWith(
      'local:/workspace',
      'src/file.ts',
      'updated text',
      null,
    );

    await expect(
      harness.handlers.get('fileTree.openAttachmentTab')!(
        'client',
        'agent-1',
        'attachment-1',
        'notes.md',
        'agent-instance-1',
        attachmentOptions,
      ),
    ).resolves.toBe(harness.attachmentTabResult);
    expect(harness.openAttachmentTab).toHaveBeenCalledWith(
      'agent-1',
      'attachment-1',
      'notes.md',
      'agent-instance-1',
      attachmentOptions,
    );

    await expect(
      harness.handlers.get('fileTree.pasteEntry')!(
        'client',
        'local:/source',
        'src/original.ts',
        'local:/target',
        'target',
        'copy',
        'copied.ts',
      ),
    ).resolves.toBe(harness.pasteResult);
    expect(harness.pasteEntry).toHaveBeenCalledWith(
      'local:/source',
      'src/original.ts',
      'local:/target',
      'target',
      'copy',
      'copied.ts',
    );

    await expect(
      harness.handlers.get('fileTree.promoteFileTab')!('client', 'file-tab-1'),
    ).resolves.toBeUndefined();
    expect(harness.promoteFileTab).toHaveBeenCalledWith('file-tab-1');

    await expect(
      harness.handlers.get('fileTree.listRecentFiles')!(
        'client',
        ['local:/workspace', 'git:/other'],
        false,
        25,
      ),
    ).resolves.toBe(harness.recentFilesResult);
    expect(harness.listRecentFiles).toHaveBeenCalledWith(
      ['local:/workspace', 'git:/other'],
      false,
      25,
    );
  });

  it('returns started and logs a background swarm failure', async () => {
    const harness = createHarness();
    const error = new Error('swarm failed');
    harness.runSwarmWorkflow.mockRejectedValueOnce(error);

    await expect(
      harness.handlers.get('swarm.run')!('client', 'agent-7', ''),
    ).resolves.toBe('started');
    expect(harness.runSwarmWorkflow).toHaveBeenCalledWith(
      'agent-7',
      'Run Dynamic Swarm.',
    );
    await vi.waitFor(() => {
      expect(harness.logger.error).toHaveBeenCalledWith(
        '[SwarmRun] Background workflow failed',
        {
          agentInstanceId: 'agent-7',
          error,
        },
      );
    });
  });

  it('forwards swarm preview and clear handlers', async () => {
    const harness = createHarness();

    await expect(
      harness.handlers.get('swarm.preview')!(
        'client',
        'agent-9',
        'preview prompt',
      ),
    ).resolves.toBe('preview-run-id');
    expect(harness.runForcedSwarmPreview).toHaveBeenCalledWith(
      'agent-9',
      'preview prompt',
    );

    await expect(
      harness.handlers.get('swarm.clearRun')!('client', 'run-3'),
    ).resolves.toBeUndefined();
    expect(harness.clearSwarmRun).toHaveBeenCalledWith('run-3');
  });
});
