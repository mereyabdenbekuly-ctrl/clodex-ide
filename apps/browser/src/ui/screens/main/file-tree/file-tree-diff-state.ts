import type { MountedWorkspaceGitDiffSummary } from '@shared/karton-contracts/ui';

export type FileTreeDiffSnapshot = {
  workspaceKey: string;
  data: MountedWorkspaceGitDiffSummary | null;
};

export type FileTreeDiffViewState = {
  data: MountedWorkspaceGitDiffSummary | null;
  isGitRepo: boolean;
  loading: boolean;
};

/**
 * A diff summary belongs to the workspace that produced it. Keep old
 * snapshots available for same-workspace refreshes, but never let them render
 * while another workspace is selected.
 */
export function getFileTreeDiffViewState(
  snapshot: FileTreeDiffSnapshot | null,
  workspaceKey: string | null,
): FileTreeDiffViewState {
  if (!workspaceKey || snapshot?.workspaceKey !== workspaceKey) {
    return {
      data: null,
      isGitRepo: false,
      loading: workspaceKey !== null,
    };
  }

  return {
    data: snapshot.data,
    isGitRepo: snapshot.data !== null,
    loading: false,
  };
}
