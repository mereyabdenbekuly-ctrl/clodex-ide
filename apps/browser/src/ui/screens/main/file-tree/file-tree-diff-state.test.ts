import { describe, expect, it } from 'vitest';
import type { MountedWorkspaceGitDiffSummary } from '@shared/karton-contracts/ui';
import {
  getFileTreeDiffViewState,
  type FileTreeDiffSnapshot,
} from './file-tree-diff-state';

const summary: MountedWorkspaceGitDiffSummary = {
  entries: [
    {
      path: 'src/app.ts',
      added: 2,
      deleted: 1,
      changeType: 'modified',
      staged: false,
    },
  ],
  totalAdded: 2,
  totalDeleted: 1,
};

describe('getFileTreeDiffViewState', () => {
  it('hides a previous workspace snapshot while the next workspace loads', () => {
    const snapshot: FileTreeDiffSnapshot = {
      workspaceKey: 'repo-a:/workspace/a',
      data: summary,
    };

    expect(getFileTreeDiffViewState(snapshot, 'repo-b:/workspace/b')).toEqual({
      data: null,
      isGitRepo: false,
      loading: true,
    });
  });

  it('keeps the current workspace snapshot visible during refresh', () => {
    const snapshot: FileTreeDiffSnapshot = {
      workspaceKey: 'repo-a:/workspace/a',
      data: summary,
    };

    expect(getFileTreeDiffViewState(snapshot, 'repo-a:/workspace/a')).toEqual({
      data: summary,
      isGitRepo: true,
      loading: false,
    });
  });

  it('renders a completed non-git lookup as an empty non-loading state', () => {
    const snapshot: FileTreeDiffSnapshot = {
      workspaceKey: 'repo-b:/workspace/b',
      data: null,
    };

    expect(getFileTreeDiffViewState(snapshot, 'repo-b:/workspace/b')).toEqual({
      data: null,
      isGitRepo: false,
      loading: false,
    });
  });

  it('does not show stale data when the workspace is cleared', () => {
    const snapshot: FileTreeDiffSnapshot = {
      workspaceKey: 'repo-a:/workspace/a',
      data: summary,
    };

    expect(getFileTreeDiffViewState(snapshot, null)).toEqual({
      data: null,
      isGitRepo: false,
      loading: false,
    });
  });
});
