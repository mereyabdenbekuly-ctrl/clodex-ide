import type { WorkspaceGitSummary } from '@clodex/agent-core/types/metadata';
import type { WorktreeSetupScriptVariant } from '@shared/worktree-setup';

export type WorkspaceGitBranchKind = 'local' | 'remote';

export type WorkspaceGitBranchInfo = {
  name: string;
  kind: WorkspaceGitBranchKind;
  remoteName?: string;
  remoteBranchName?: string;
  current: boolean;
  checkedOut: boolean;
  checkedOutPath?: string;
};

export type WorkspaceGitBranchesResult = {
  current: string | null;
  defaultBranch: string | null;
  defaultRemoteBranch: string | null;
  branches: WorkspaceGitBranchInfo[];
  /**
   * Whether the remote refresh succeeded. `false` when no refresh was
   * requested or when the fetch failed. Callers should only reset their
   * staleness timer when this is `true`.
   */
  refreshSucceeded: boolean;
};

export type WorkspaceGitWorktreeInfo = {
  worktreeId: string;
  path: string;
  branch: string | null;
  headSha: string | null;
  isDetached: boolean;
  isMainWorktree: boolean;
  current: boolean;
  /**
   * Worktree creation time in epoch ms (birthtime of the worktree's `.git`
   * entry), or `null` when unavailable. The sidebar orders worktrees
   * newest-first by this value; `git worktree list` order is not age-based.
   */
  createdAt: number | null;
};

export type WorkspaceGitWorktreesResult = {
  currentPath: string | null;
  worktrees: WorkspaceGitWorktreeInfo[];
};

export type WorkspaceGitCleanupCandidate = {
  path: string;
  branch: string | null;
  headSha: string | null;
  repositoryId: string;
  repoRoot: string;
  lastUsedAt: number | null;
  mergedInto: string;
  status: {
    dirty: false;
    stagedCount: 0;
    unstagedCount: 0;
    untrackedCount: 0;
  };
};

export type WorkspaceGitCleanupResult = {
  removed: Array<{ path: string; branch: string | null }>;
  failed: Array<{ path: string; message: string }>;
};

export type WorkspaceGitWorktreeDeletionInfo = {
  path: string;
  branch: string | null;
  isMainWorktree: boolean;
  status: MountedWorkspaceGitStatusSummary | null;
  hasUncommittedChanges: boolean;
};

export type WorkspaceGitWorktreeDeleteResult =
  | { ok: true; path: string; branch: string | null }
  | { ok: false; message: string };

export type WorkspaceGitWorktreeDeleteOptions = {
  force?: boolean;
  /**
   * When true, callers are responsible for deleting the agents that live
   * in this worktree before invoking deletion. The mount manager always
   * detaches the deleted path from surviving agents regardless of this
   * flag; it exists so the UI can record intent / telemetry.
   */
  deleteAgents?: boolean;
};

export type WorkspaceGitCleanupState = {
  checkedAt: number | null;
  dismissed: boolean;
  cleaning: boolean;
  candidates: WorkspaceGitCleanupCandidate[];
  lastResult: WorkspaceGitCleanupResult | null;
};

export type WorkspaceGitSetupStatus = 'running' | 'succeeded' | 'failed';

export type WorkspaceGitSetupRun = {
  id: string;
  workspacePath: string;
  sourceWorktreePath: string;
  mainWorktreePath: string;
  scriptPath: string;
  status: WorkspaceGitSetupStatus;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  message: string | null;
  stdoutTail: string;
  stderrTail: string;
};

export type WorkspaceGitSetupState = {
  runsByPath: Record<string, WorkspaceGitSetupRun>;
};

export type WorktreeSetupManagedWorktree = {
  path: string;
  name: string;
  branch: string | null;
  headSha: string | null;
  lastUsedAt: number | null;
  clean: boolean;
  current: boolean;
  removable: boolean;
  disabledReason: string | null;
};

export type WorktreeSetupScriptFile = {
  variant: WorktreeSetupScriptVariant;
  path: string;
  exists: boolean;
  content: string;
};

export type WorktreeSetupRepositorySettings = {
  id: string;
  name: string;
  mainWorktreePath: string;
  repositoryId: string | null;
  scripts: Record<WorktreeSetupScriptVariant, WorktreeSetupScriptFile>;
  managedWorktrees: WorktreeSetupManagedWorktree[];
};

export type WorktreeSetupRepositoriesResult = {
  repositories: WorktreeSetupRepositorySettings[];
};

export type SaveWorktreeSetupScriptResult =
  | { ok: true; repository: WorktreeSetupRepositorySettings }
  | { ok: false; message: string };

export type DeleteWorktreeSetupWorktreeResult =
  | { ok: true; repository: WorktreeSetupRepositorySettings | null }
  | { ok: false; message: string };

export type WorkspaceGitFailureReason =
  | 'not-git-repo'
  | 'branch-not-found'
  | 'branch-already-exists'
  | 'branch-checked-out'
  | 'worktree-already-exists'
  | 'invalid-name'
  | 'branch-create-failed'
  | 'checkout-failed'
  | 'worktree-create-failed';

export type WorkspaceGitFailure = {
  ok: false;
  reason: WorkspaceGitFailureReason;
  message: string;
};

export type WorkspaceGitMutationResult =
  | { ok: true; git: WorkspaceGitSummary | null }
  | WorkspaceGitFailure;

export type WorkspaceGitCreateWorktreeResult =
  | {
      ok: true;
      path: string;
      branchName: string;
      git: WorkspaceGitSummary | null;
    }
  | WorkspaceGitFailure;

export type WorkspaceGitCreateBranchOptions = {
  branchName: string;
  sourceBranch: string;
};

export type WorkspaceGitCreateWorktreeOptions = {
  worktreeName: string;
  sourceBranch: string;
};

/**
 * Convenience alias used by host UI code. Identical to {@link
 * WorkspaceGitSummary.status} — kept as a named type so call-sites
 * reading just the status block don't have to pierce the parent shape.
 */
export type MountedWorkspaceGitStatusSummary = NonNullable<
  WorkspaceGitSummary['status']
>;

/**
 * Host-side alias for the canonical {@link WorkspaceGitSummary} carried
 * on a mount. Re-exported for parity with the legacy naming used across
 * the karton contract and UI.
 */
export type MountedWorkspaceGitSummary = WorkspaceGitSummary;

export type MountedWorkspaceGitDiffEntry = {
  path: string;
  added: number;
  deleted: number;
  changeType: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  oldPath?: string;
  staged: boolean;
};

export type MountedWorkspaceGitDiffSummary = {
  entries: MountedWorkspaceGitDiffEntry[];
  totalAdded: number;
  totalDeleted: number;
};
