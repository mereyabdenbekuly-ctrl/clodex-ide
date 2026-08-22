import type { SelectItem } from '@clodex/stage-ui/components/select';
import type { WorkspaceGitAction } from '@shared/karton-contracts/ui/shared-types';

import { generateWorktreeName } from './worktree-utils';

import { getBaseName } from '@shared/path-utils';

import type {
  MountEntry,
  WorkspaceGitCreateBranchOptions,
  WorkspaceGitCreateWorktreeOptions,
  WorkspaceGitCreateWorktreeResult,
  WorkspaceGitMutationResult,
} from '@shared/karton-contracts/ui';

// ============================================================================
// Inline workspace action selector
// ============================================================================
//
// Renders in place of the regular WorkspaceBadge for git-rooted mounts while
// the chat is empty. Collapses workspace identity, the chosen action, and
// its parameters into a single trigger; clicking the trigger opens a popover
// with four mutually-exclusive options (radio-style, first preselected).
//

export type WorkspaceAction = WorkspaceGitAction;

export type WorkspaceActionConfig = {
  selectedAction: WorkspaceAction;
  worktreeNameLabel: string;
  branchNameLabel: string;
  createWorktreeFrom: string;
  createWorktreeFromTouched?: boolean;
  createBranchFrom: string;
  createBranchFromTouched?: boolean;
  switchBranchTarget: string;
  switchBranchTargetTouched?: boolean;
  switchWorktreeTarget: string;
};

export type WorkspaceActionPayload =
  | {
      type: 'create-worktree';
      worktreeName: string;
      sourceBranch: string;
    }
  | {
      type: 'switch-worktree';
      targetWorktreePath: string;
    }
  | {
      type: 'create-branch';
      branchName: string;
      sourceBranch: string;
    }
  | {
      type: 'switch-branch';
      targetBranch: string;
    };

export const GIT_OPTIONS_STALE_MS = 60_000;

export function applyMountedWorkspaceActionDefault(
  config: WorkspaceActionConfig,
  mount: MountEntry,
): WorkspaceActionConfig {
  if (!mount.git) return config;

  if (mount.git.isWorktree) {
    return {
      ...config,
      selectedAction: 'switch-worktree',
      switchWorktreeTarget: mount.path,
    };
  }

  return {
    ...config,
    selectedAction: 'create-worktree',
  };
}

export function toWorkspaceActionPayload(
  config: WorkspaceActionConfig,
): WorkspaceActionPayload {
  switch (config.selectedAction) {
    case 'create-worktree':
      return {
        type: 'create-worktree',
        worktreeName: config.worktreeNameLabel,
        sourceBranch: config.createWorktreeFrom,
      };
    case 'switch-worktree':
      return {
        type: 'switch-worktree',
        targetWorktreePath: config.switchWorktreeTarget,
      };
    case 'create-branch':
      return {
        type: 'create-branch',
        branchName: config.branchNameLabel,
        sourceBranch: config.createBranchFrom,
      };
    case 'switch-branch':
      return {
        type: 'switch-branch',
        targetBranch: config.switchBranchTarget,
      };
  }
}

export type WorkspaceGitActionExecutor = {
  createWorkspaceGitWorktree: (
    agentInstanceId: string,
    mountPrefix: string,
    options: WorkspaceGitCreateWorktreeOptions,
  ) => Promise<WorkspaceGitCreateWorktreeResult>;
  createWorkspaceGitBranch: (
    agentInstanceId: string,
    mountPrefix: string,
    options: WorkspaceGitCreateBranchOptions,
  ) => Promise<WorkspaceGitMutationResult>;
  switchWorkspaceGitBranch: (
    agentInstanceId: string,
    mountPrefix: string,
    branchName: string,
  ) => Promise<WorkspaceGitMutationResult>;
  mountWorkspace: (
    agentInstanceId: string,
    workspacePath?: string,
  ) => Promise<void>;
  unmountWorkspace: (
    agentInstanceId: string,
    mountPrefix: string,
  ) => Promise<void>;
};

export type WorkspaceGitActionByPathExecutor = {
  createGitWorktreeByPath: (
    workspacePath: string,
    options: WorkspaceGitCreateWorktreeOptions,
  ) => Promise<WorkspaceGitCreateWorktreeResult>;
  createGitBranchByPath: (
    workspacePath: string,
    options: WorkspaceGitCreateBranchOptions,
  ) => Promise<WorkspaceGitMutationResult>;
  switchGitBranchByPath: (
    workspacePath: string,
    branchName: string,
  ) => Promise<WorkspaceGitMutationResult>;
  mountWorkspace: (
    agentInstanceId: string,
    workspacePath?: string,
  ) => Promise<void>;
};

export type WorkspaceGitActionExecutionResult =
  | { ok: true }
  | { ok: false; message: string };

export async function executeWorkspaceGitAction({
  agentInstanceId,
  mount,
  config,
  executor,
}: {
  agentInstanceId: string;
  mount: MountEntry;
  config: WorkspaceActionConfig;
  executor: WorkspaceGitActionExecutor;
}): Promise<WorkspaceGitActionExecutionResult> {
  const payload = toWorkspaceActionPayload(config);

  switch (payload.type) {
    case 'create-worktree': {
      const result = await executor.createWorkspaceGitWorktree(
        agentInstanceId,
        mount.prefix,
        {
          worktreeName: payload.worktreeName,
          sourceBranch: payload.sourceBranch,
        },
      );
      if (!result.ok) return { ok: false, message: result.message };
      await executor.mountWorkspace(agentInstanceId, result.path);
      await executor.unmountWorkspace(agentInstanceId, mount.prefix);
      return { ok: true };
    }
    case 'switch-worktree':
      if (payload.targetWorktreePath !== mount.path) {
        await executor.mountWorkspace(
          agentInstanceId,
          payload.targetWorktreePath,
        );
        await executor.unmountWorkspace(agentInstanceId, mount.prefix);
      }
      return { ok: true };
    case 'create-branch': {
      const result = await executor.createWorkspaceGitBranch(
        agentInstanceId,
        mount.prefix,
        {
          branchName: payload.branchName,
          sourceBranch: payload.sourceBranch,
        },
      );
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true };
    }
    case 'switch-branch': {
      const result = await executor.switchWorkspaceGitBranch(
        agentInstanceId,
        mount.prefix,
        payload.targetBranch,
      );
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true };
    }
  }
}

export async function executeWorkspaceGitActionByPath({
  agentInstanceId,
  workspacePath,
  config,
  executor,
}: {
  agentInstanceId: string;
  workspacePath: string;
  config: WorkspaceActionConfig;
  executor: WorkspaceGitActionByPathExecutor;
}): Promise<WorkspaceGitActionExecutionResult> {
  const payload = toWorkspaceActionPayload(config);

  switch (payload.type) {
    case 'create-worktree': {
      const result = await executor.createGitWorktreeByPath(workspacePath, {
        worktreeName: payload.worktreeName,
        sourceBranch: payload.sourceBranch,
      });
      if (!result.ok) return { ok: false, message: result.message };
      await executor.mountWorkspace(agentInstanceId, result.path);
      return { ok: true };
    }
    case 'switch-worktree':
      await executor.mountWorkspace(
        agentInstanceId,
        payload.targetWorktreePath,
      );
      return { ok: true };
    case 'create-branch': {
      const result = await executor.createGitBranchByPath(workspacePath, {
        branchName: payload.branchName,
        sourceBranch: payload.sourceBranch,
      });
      if (!result.ok) return { ok: false, message: result.message };
      await executor.mountWorkspace(agentInstanceId, workspacePath);
      return { ok: true };
    }
    case 'switch-branch': {
      const result = await executor.switchGitBranchByPath(
        workspacePath,
        payload.targetBranch,
      );
      if (!result.ok) return { ok: false, message: result.message };
      await executor.mountWorkspace(agentInstanceId, workspacePath);
      return { ok: true };
    }
  }
}

export function getSelectItemTextValues(item: SelectItem<string>): string[] {
  return [item.value, item.label, item.triggerLabel].filter(
    (value): value is string => typeof value === 'string',
  );
}

export function getWorktreeNameFromPath(value: string): string | null {
  return getBaseName(value) ?? null;
}

export function getReservedWorkspaceActionNames(
  sourceBranchItems: SelectItem<string>[],
  worktreeItems: SelectItem<string>[],
  checkoutBranchItems: SelectItem<string>[] = sourceBranchItems,
): Set<string> {
  const reserved = new Set<string>();

  for (const item of [...sourceBranchItems, ...checkoutBranchItems]) {
    for (const value of getSelectItemTextValues(item)) {
      const trimmed = value?.trim();
      if (trimmed) reserved.add(trimmed);
    }
  }

  for (const item of worktreeItems) {
    for (const value of getSelectItemTextValues(item)) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      reserved.add(trimmed);
      const basename = getWorktreeNameFromPath(trimmed);
      if (basename) reserved.add(basename);
    }
  }

  return reserved;
}

export function createDefaultWorkspaceActionConfig(
  sourceBranchItems: SelectItem<string>[],
  worktreeItems: SelectItem<string>[],
  checkoutBranchItems: SelectItem<string>[] = sourceBranchItems,
  defaultBranch = 'main',
  checkoutDefaultBranch = defaultBranch,
): WorkspaceActionConfig {
  const sourceBranchDefault =
    sourceBranchItems.find((item) => item.value === defaultBranch)?.value ??
    sourceBranchItems[0]?.value ??
    'main';
  const checkoutBranchDefault =
    checkoutBranchItems.find(
      (item) => item.value === checkoutDefaultBranch && !item.disabled,
    )?.value ??
    checkoutBranchItems.find(
      (item) => item.value === defaultBranch && !item.disabled,
    )?.value ??
    checkoutBranchItems.find((item) => !item.disabled)?.value ??
    checkoutDefaultBranch;
  const mainWorktreeDefault =
    worktreeItems.find((item) => item.value === defaultBranch)?.value ??
    worktreeItems[0]?.value ??
    defaultBranch;
  const reservedNames = getReservedWorkspaceActionNames(
    sourceBranchItems,
    worktreeItems,
    checkoutBranchItems,
  );

  const worktreeNameLabel =
    generateWorktreeName({
      reservedNames,
    }) ?? '';
  if (worktreeNameLabel) reservedNames.add(worktreeNameLabel);
  const branchNameLabel =
    generateWorktreeName({
      reservedNames,
    }) ?? '';

  return {
    selectedAction: 'create-worktree',
    worktreeNameLabel,
    branchNameLabel,
    createWorktreeFrom: sourceBranchDefault,
    createBranchFrom: sourceBranchDefault,
    switchBranchTarget: checkoutBranchDefault,
    switchWorktreeTarget: mainWorktreeDefault,
  };
}

export function workspaceActionConfigsEqual(
  a: WorkspaceActionConfig,
  b: WorkspaceActionConfig,
): boolean {
  return (
    a.selectedAction === b.selectedAction &&
    a.worktreeNameLabel === b.worktreeNameLabel &&
    a.branchNameLabel === b.branchNameLabel &&
    a.createWorktreeFrom === b.createWorktreeFrom &&
    Boolean(a.createWorktreeFromTouched) ===
      Boolean(b.createWorktreeFromTouched) &&
    a.createBranchFrom === b.createBranchFrom &&
    Boolean(a.createBranchFromTouched) === Boolean(b.createBranchFromTouched) &&
    a.switchBranchTarget === b.switchBranchTarget &&
    Boolean(a.switchBranchTargetTouched) ===
      Boolean(b.switchBranchTargetTouched) &&
    a.switchWorktreeTarget === b.switchWorktreeTarget
  );
}

export type WorkspaceActionPickerContentProps = {
  config: WorkspaceActionConfig;
  sourceBranchItems: SelectItem<string>[];
  checkoutBranchItems: SelectItem<string>[];
  worktreeItems: SelectItem<string>[];
  branchSelectPortalContainer?: React.RefObject<HTMLElement | null>;
  onCommit: (action: WorkspaceAction) => void;
  onUpdateAction: (
    action: WorkspaceAction,
    partial: Partial<WorkspaceActionConfig>,
  ) => void;
};

export function getWorkspaceActionValidationError(
  config: WorkspaceActionConfig,
  sourceBranchItems: SelectItem<string>[],
  checkoutBranchItems: SelectItem<string>[],
  worktreeItems: SelectItem<string>[],
): string | null {
  const existingBranches = new Set(sourceBranchItems.map((item) => item.value));
  const existingWorktreeNames = new Set<string>();
  for (const item of worktreeItems) {
    for (const value of getSelectItemTextValues(item)) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      existingWorktreeNames.add(trimmed);
      const basename = getWorktreeNameFromPath(trimmed);
      if (basename) existingWorktreeNames.add(basename);
    }
  }

  switch (config.selectedAction) {
    case 'create-worktree':
      if (config.worktreeNameLabel.trim().length === 0) {
        return 'Worktree name is required.';
      }
      if (existingBranches.has(config.worktreeNameLabel)) {
        return 'A branch with this name already exists.';
      }
      if (existingWorktreeNames.has(config.worktreeNameLabel)) {
        return 'A worktree with this name already exists.';
      }
      return null;
    case 'create-branch':
      if (config.branchNameLabel.trim().length === 0) {
        return 'Branch name is required.';
      }
      if (existingBranches.has(config.branchNameLabel)) {
        return 'A branch with this name already exists.';
      }
      return null;
    case 'switch-branch': {
      const target = checkoutBranchItems.find(
        (item) => item.value === config.switchBranchTarget,
      );
      if (!target) return 'Branch is unavailable.';
      if (target.disabled) return 'Branch is checked out in another worktree.';
      return null;
    }
    case 'switch-worktree':
      if (
        !worktreeItems.some(
          (item) => item.value === config.switchWorktreeTarget,
        )
      ) {
        return 'Worktree is unavailable.';
      }
      return null;
  }
}
