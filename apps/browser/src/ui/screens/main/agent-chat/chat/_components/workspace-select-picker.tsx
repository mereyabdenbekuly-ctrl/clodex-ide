import type { TutorialId } from '@ui/tutorial-steps';
import type { KartonContract } from '@shared/karton-contracts/ui';
import {
  applyMountedWorkspaceActionDefault,
  executeWorkspaceGitAction,
  toWorkspaceActionPayload,
  workspaceActionConfigsEqual,
  GIT_OPTIONS_STALE_MS,
  createDefaultWorkspaceActionConfig,
  getWorkspaceActionValidationError,
  type WorkspaceAction,
  type WorkspaceActionConfig,
  type WorkspaceActionPickerContentProps,
} from './workspace-select-actions';
import { formatGitRef } from './workspace-select-side-panels';

type KartonState = KartonContract['state'];
type KartonProcedures = KartonContract['serverProcedures'];

import type { SelectItem } from '@clodex/stage-ui/components/select';

import type { Patch } from 'immer';
import { Combobox as ComboboxBase } from '@base-ui/react/combobox';
import {
  Combobox,
  ComboboxInput,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
} from '@clodex/stage-ui/components/combobox';
import {
  getBranchSelectItemsFromGit,
  getCurrentBranchValue,
  getDefaultBranchValue,
  getDefaultSourceBranchValue,
  getWorktreeSelectItems,
  getWorktreeSelectItemsFromGit,
} from './worktree-utils';
import {
  IconBranchOutOutline18,
  IconCheckFill18,
  IconChevronDownFill18,
  IconCodeBranchOutline18,
  IconXmarkFill18,
} from '@clodex/icons';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import { Popover as PopoverBase } from '@base-ui/react/popover';
import { Popover, PopoverTrigger } from '@clodex/stage-ui/components/popover';

import { cn } from '@clodex/stage-ui/lib/utils';

import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';

import { useTrack } from '@ui/hooks/use-track';

import { useTutorial } from '@ui/contexts/tutorial';

import { FileContextMenu } from '@ui/components/file-context-menu';
import { getWorkspaceDisplayInfo } from '@ui/utils/workspace-display';
import type {
  MountEntry,
  WorkspaceGitBranchesResult,
  WorkspaceGitWorktreesResult,
} from '@shared/karton-contracts/ui';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { applyWorkspaceGitActionPreferences } from './workspace-action-preferences';
import { hydrateWorkspaceActionConfigWithDefaults } from './workspace-action-config-utils';
import { WorkspaceSetupStatusIndicator } from './workspace-setup-status';

export function WorkspaceActionPickerContent({
  config,
  sourceBranchItems,
  checkoutBranchItems,
  worktreeItems,
  branchSelectPortalContainer,
  onCommit,
  onUpdateAction,
}: WorkspaceActionPickerContentProps) {
  const validationError = getWorkspaceActionValidationError(
    config,
    sourceBranchItems,
    checkoutBranchItems,
    worktreeItems,
  );

  return (
    <>
      <ActionGroupHeader>Worktree</ActionGroupHeader>

      <ActionRow
        active={config.selectedAction === 'create-worktree'}
        onSelect={() => onCommit('create-worktree')}
        tutorialId="action-create-worktree"
      >
        <span className="shrink-0 text-xs">Create worktree</span>
        <NameChip
          name={config.worktreeNameLabel}
          onCommit={(next) =>
            onUpdateAction('create-worktree', { worktreeNameLabel: next })
          }
        />
        <span className="shrink-0 text-xs">from</span>
        <ActionBranchSelect
          items={sourceBranchItems}
          value={config.createWorktreeFrom}
          onValueChange={(next) =>
            onUpdateAction('create-worktree', {
              createWorktreeFrom: next,
              createWorktreeFromTouched: true,
            })
          }
          portalContainer={branchSelectPortalContainer}
        />
      </ActionRow>

      <ActionRow
        active={config.selectedAction === 'switch-worktree'}
        onSelect={() => onCommit('switch-worktree')}
        tutorialId="action-switch-worktree"
      >
        <span className="shrink-0 text-xs">Use existing worktree</span>
        <ActionBranchSelect
          items={worktreeItems}
          value={config.switchWorktreeTarget}
          onValueChange={(next) =>
            onUpdateAction('switch-worktree', { switchWorktreeTarget: next })
          }
          icon="worktree"
          portalContainer={branchSelectPortalContainer}
        />
      </ActionRow>

      <ActionGroupHeader>Branch</ActionGroupHeader>

      <ActionRow
        active={config.selectedAction === 'create-branch'}
        onSelect={() => onCommit('create-branch')}
        tutorialId="action-create-branch"
      >
        <span className="shrink-0 text-xs">Create branch</span>
        <NameChip
          name={config.branchNameLabel}
          onCommit={(next) =>
            onUpdateAction('create-branch', { branchNameLabel: next })
          }
        />
        <span className="shrink-0 text-xs">from</span>
        <ActionBranchSelect
          items={sourceBranchItems}
          value={config.createBranchFrom}
          onValueChange={(next) =>
            onUpdateAction('create-branch', {
              createBranchFrom: next,
              createBranchFromTouched: true,
            })
          }
          portalContainer={branchSelectPortalContainer}
        />
      </ActionRow>

      <ActionRow
        active={config.selectedAction === 'switch-branch'}
        onSelect={() => onCommit('switch-branch')}
        tutorialId="action-switch-branch"
      >
        <span className="shrink-0 text-xs">Use existing branch</span>
        <ActionBranchSelect
          items={checkoutBranchItems}
          value={config.switchBranchTarget}
          onValueChange={(next) =>
            onUpdateAction('switch-branch', {
              switchBranchTarget: next,
              switchBranchTargetTouched: true,
            })
          }
          portalContainer={branchSelectPortalContainer}
        />
      </ActionRow>

      {validationError && (
        <div className="px-2 pt-1 pb-1 text-subtle-foreground text-xs">
          {validationError}
        </div>
      )}
    </>
  );
}

export const WorkspaceActionSelect = memo(function WorkspaceActionSelect({
  mount,
  onUnmount,
  config: controlledConfig,
  onConfigChange,
  onOpenChange,
  agentInstanceId,
}: {
  mount: MountEntry;
  onUnmount: (prefix: string) => void;
  config?: WorkspaceActionConfig;
  onConfigChange?: (mount: MountEntry, config: WorkspaceActionConfig) => void;
  onOpenChange?: (mountPrefix: string, open: boolean) => void;
  agentInstanceId: string;
}) {
  const track = useTrack();
  const display = getWorkspaceDisplayInfo(mount);
  const gitRef = useMemo(
    () => (mount.git ? formatGitRef(mount.git) : null),
    [mount.git],
  );
  const setupRun = useKartonState(
    (s: KartonState) => s.workspaceGitSetup.runsByPath[mount.path],
  );
  const listWorkspaceGitBranches = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.listWorkspaceGitBranches,
  );
  const listWorkspaceGitWorktrees = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.listWorkspaceGitWorktrees,
  );
  const createWorkspaceGitWorktree = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.createWorkspaceGitWorktree,
  );
  const createWorkspaceGitBranch = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.createWorkspaceGitBranch,
  );
  const switchWorkspaceGitBranch = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.switchWorkspaceGitBranch,
  );
  const mountWorkspace = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.mountWorkspace,
  );
  const unmountWorkspace = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.unmountWorkspace,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [branchesResult, setBranchesResult] =
    useState<WorkspaceGitBranchesResult | null>(null);
  const [worktreesResult, setWorktreesResult] =
    useState<WorkspaceGitWorktreesResult | null>(null);
  const [gitDataLoaded, setGitDataLoaded] = useState(false);
  const [gitDataLoadedAt, setGitDataLoadedAt] = useState<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openChangeTimeoutRef = useRef<number | null>(null);
  const { activeTutorial } = useTutorial();

  const sourceBranchItems = useMemo(
    () => getBranchSelectItemsFromGit(branchesResult, gitRef, 'source'),
    [branchesResult, gitRef],
  );
  const checkoutBranchItems = useMemo(
    () =>
      getBranchSelectItemsFromGit(branchesResult, gitRef, 'checkout-target'),
    [branchesResult, gitRef],
  );
  const worktreeItems = useMemo(
    () => getWorktreeSelectItemsFromGit(worktreesResult),
    [worktreesResult],
  );
  const defaultBranch = useMemo(
    () => getDefaultBranchValue(branchesResult, gitRef),
    [branchesResult, gitRef],
  );
  const checkoutDefaultBranch = useMemo(
    () => getCurrentBranchValue(branchesResult, gitRef),
    [branchesResult, gitRef],
  );
  const preferencesUpdate = useKartonProcedure(
    (p: KartonProcedures) => p.preferences.update,
  );
  const generalWorkspaceGitActionPreference = useKartonState(
    (s: KartonState) =>
      s.preferences.agent.workspaceGitActionPreferences.general,
  );
  const repositoryWorkspaceGitActionPreference = useKartonState(
    (s: KartonState) =>
      mount.git?.repositoryId
        ? s.preferences.agent.workspaceGitActionPreferences.repositories[
            mount.git.repositoryId
          ]
        : undefined,
  );

  const [open, setOpen] = useState(false);
  const [localConfig, setLocalConfig] = useState(() =>
    applyMountedWorkspaceActionDefault(
      applyWorkspaceGitActionPreferences(
        createDefaultWorkspaceActionConfig(
          sourceBranchItems,
          worktreeItems,
          checkoutBranchItems,
          getDefaultSourceBranchValue(branchesResult, gitRef),
          checkoutDefaultBranch,
        ),
        sourceBranchItems,
        worktreeItems,
        generalWorkspaceGitActionPreference,
        repositoryWorkspaceGitActionPreference,
        checkoutBranchItems,
      ),
      mount,
    ),
  );
  const config = controlledConfig ?? localConfig;

  const refreshGitData = useCallback(
    async (options?: { refresh?: boolean }) => {
      const [nextBranches, nextWorktrees] = await Promise.all([
        listWorkspaceGitBranches(agentInstanceId, mount.prefix, options),
        listWorkspaceGitWorktrees(agentInstanceId, mount.prefix),
      ]);
      setBranchesResult(nextBranches);
      setWorktreesResult(nextWorktrees);
      setGitDataLoaded(true);
      // Only advance the staleness timer when the remote refresh actually
      // succeeded — otherwise stale refs would be hidden behind a fresh
      // timestamp for the next 60 seconds.
      if (!options?.refresh || nextBranches?.refreshSucceeded) {
        setGitDataLoadedAt(Date.now());
      }
    },
    [
      agentInstanceId,
      listWorkspaceGitBranches,
      listWorkspaceGitWorktrees,
      mount.prefix,
    ],
  );

  useEffect(() => {
    if (!mount.git || gitDataLoaded) return;
    void refreshGitData();
  }, [gitDataLoaded, mount.git, refreshGitData]);

  useEffect(() => {
    if (!gitDataLoaded) return;

    const defaults = applyMountedWorkspaceActionDefault(
      applyWorkspaceGitActionPreferences(
        createDefaultWorkspaceActionConfig(
          sourceBranchItems,
          worktreeItems,
          checkoutBranchItems,
          getDefaultSourceBranchValue(branchesResult, gitRef),
          checkoutDefaultBranch,
        ),
        sourceBranchItems,
        worktreeItems,
        generalWorkspaceGitActionPreference,
        repositoryWorkspaceGitActionPreference,
        checkoutBranchItems,
      ),
      mount,
    );
    const previousCurrentBranchDefault = getCurrentBranchValue(null, gitRef);
    const previousDefaultBranchDefault = getDefaultBranchValue(null, gitRef);
    const previousWorktreeDefault =
      getWorktreeSelectItems()[0]?.value ?? 'main';
    const hydratedConfig = hydrateWorkspaceActionConfigWithDefaults(
      config,
      defaults,
      {
        sourceBranch: previousCurrentBranchDefault,
        checkoutBranch: previousCurrentBranchDefault,
        defaultBranch: previousDefaultBranchDefault,
        worktree: previousWorktreeDefault,
      },
    );
    if (workspaceActionConfigsEqual(config, hydratedConfig)) return;

    if (onConfigChange) {
      onConfigChange(mount, hydratedConfig);
    } else {
      setLocalConfig(hydratedConfig);
    }
  }, [
    checkoutBranchItems,
    config,
    checkoutDefaultBranch,
    defaultBranch,
    generalWorkspaceGitActionPreference,
    gitDataLoaded,
    gitRef,
    mount,
    onConfigChange,
    repositoryWorkspaceGitActionPreference,
    sourceBranchItems,
    worktreeItems,
  ]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (openChangeTimeoutRef.current !== null) {
        window.clearTimeout(openChangeTimeoutRef.current);
        openChangeTimeoutRef.current = null;
      }

      if (
        !next &&
        activeTutorial?.id ===
          ('workspace-selection-options' satisfies TutorialId)
      ) {
        return;
      }

      setOpen(next);

      if (next) {
        openChangeTimeoutRef.current = window.setTimeout(() => {
          onOpenChange?.(mount.prefix, true);
          openChangeTimeoutRef.current = null;
        }, 150);

        const isStale =
          gitDataLoadedAt !== null &&
          Date.now() - gitDataLoadedAt > GIT_OPTIONS_STALE_MS;

        if (!gitDataLoaded || isStale) {
          void refreshGitData({ refresh: isStale });
        }
        return;
      }

      onOpenChange?.(mount.prefix, false);
    },
    [
      activeTutorial,
      gitDataLoaded,
      gitDataLoadedAt,
      mount.prefix,
      onOpenChange,
      refreshGitData,
    ],
  );

  useEffect(() => {
    return () => {
      if (openChangeTimeoutRef.current !== null) {
        window.clearTimeout(openChangeTimeoutRef.current);
      }
    };
  }, []);

  const persistWorkspaceGitActionPreference = useCallback(
    (next: WorkspaceAction, partial: Partial<WorkspaceActionConfig>) => {
      const repositoryId = mount.git?.repositoryId;
      const patches: Patch[] = [
        {
          op: 'add',
          path: [
            'agent',
            'workspaceGitActionPreferences',
            'general',
            'selectedAction',
          ],
          value: next,
        },
      ];

      if (repositoryId) {
        if (!repositoryWorkspaceGitActionPreference) {
          patches.push({
            op: 'add',
            path: [
              'agent',
              'workspaceGitActionPreferences',
              'repositories',
              repositoryId,
            ],
            value: {},
          });
        }
        patches.push({
          op: 'add',
          path: [
            'agent',
            'workspaceGitActionPreferences',
            'repositories',
            repositoryId,
            'selectedAction',
          ],
          value: next,
        });
        if (typeof partial.createWorktreeFrom === 'string') {
          patches.push({
            op: 'add',
            path: [
              'agent',
              'workspaceGitActionPreferences',
              'repositories',
              repositoryId,
              'createWorktreeFrom',
            ],
            value: partial.createWorktreeFrom,
          });
        }
        if (typeof partial.createBranchFrom === 'string') {
          patches.push({
            op: 'add',
            path: [
              'agent',
              'workspaceGitActionPreferences',
              'repositories',
              repositoryId,
              'createBranchFrom',
            ],
            value: partial.createBranchFrom,
          });
        }
        if (typeof partial.switchWorktreeTarget === 'string') {
          patches.push({
            op: 'add',
            path: [
              'agent',
              'workspaceGitActionPreferences',
              'repositories',
              repositoryId,
              'switchWorktreeTarget',
            ],
            value: partial.switchWorktreeTarget,
          });
        }
        if (typeof partial.switchBranchTarget === 'string') {
          patches.push({
            op: 'add',
            path: [
              'agent',
              'workspaceGitActionPreferences',
              'repositories',
              repositoryId,
              'switchBranchTarget',
            ],
            value: partial.switchBranchTarget,
          });
        }
      }

      void preferencesUpdate(patches);
    },
    [
      mount.git?.repositoryId,
      preferencesUpdate,
      repositoryWorkspaceGitActionPreference,
    ],
  );

  const handleActionUpdate = useCallback(
    (next: WorkspaceAction, partial: Partial<WorkspaceActionConfig>) => {
      const nextConfig = { ...config, ...partial, selectedAction: next };
      const validationError = getWorkspaceActionValidationError(
        nextConfig,
        sourceBranchItems,
        checkoutBranchItems,
        worktreeItems,
      );
      if (validationError) {
        setActionError(validationError);
        return;
      }
      setActionError(null);
      persistWorkspaceGitActionPreference(next, partial);
      if (onConfigChange) {
        onConfigChange(mount, nextConfig);
        setOpen(false);
      } else {
        setLocalConfig(nextConfig);
        void executeWorkspaceGitAction({
          agentInstanceId,
          mount,
          config: nextConfig,
          executor: {
            createWorkspaceGitWorktree,
            createWorkspaceGitBranch,
            switchWorkspaceGitBranch,
            mountWorkspace,
            unmountWorkspace,
          },
        }).then((result) => {
          if (!result.ok) {
            setActionError(result.message);
            return;
          }
          setOpen(false);
          setGitDataLoaded(false);
          void refreshGitData();
        });
      }
      track('workspace-action-changed', {
        mount_path: mount.path,
        action: next,
        action_payload: toWorkspaceActionPayload(nextConfig),
      });
    },
    [
      agentInstanceId,
      checkoutBranchItems,
      config,
      createWorkspaceGitBranch,
      createWorkspaceGitWorktree,
      mount,
      mountWorkspace,
      onConfigChange,
      persistWorkspaceGitActionPreference,
      refreshGitData,
      sourceBranchItems,
      switchWorkspaceGitBranch,
      track,
      unmountWorkspace,
      worktreeItems,
    ],
  );

  const handleActionChange = useCallback(
    (next: WorkspaceAction) => handleActionUpdate(next, {}),
    [handleActionUpdate],
  );

  const handlePopupKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const isNextKey =
        event.key === 'ArrowDown' ||
        (event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'n');
      const isPreviousKey =
        event.key === 'ArrowUp' ||
        (event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'p');

      if (!isNextKey && !isPreviousKey) return;

      const popup = popupRef.current;
      if (!popup) return;

      const items = Array.from(
        popup.querySelectorAll<HTMLElement>('[role="radio"]'),
      ).filter(
        (item) =>
          !(item instanceof HTMLButtonElement && item.disabled) &&
          item.getAttribute('aria-disabled') !== 'true',
      );
      if (items.length === 0) return;

      const activeElement = document.activeElement;
      const currentIndex =
        activeElement instanceof HTMLElement
          ? items.indexOf(activeElement)
          : -1;
      const nextIndex = isNextKey
        ? (currentIndex + 1) % items.length
        : (currentIndex <= 0 ? items.length : currentIndex) - 1;

      event.preventDefault();
      event.stopPropagation();
      items[nextIndex]?.focus();
    },
    [],
  );

  const triggerSummary = useMemo<React.ReactNode>(() => {
    switch (config.selectedAction) {
      case 'create-worktree':
        return (
          <>
            create worktree{' '}
            <SummaryHighlight>{config.worktreeNameLabel}</SummaryHighlight> from{' '}
            <SummaryHighlight>{config.createWorktreeFrom}</SummaryHighlight>
          </>
        );
      case 'create-branch':
        return (
          <>
            create branch{' '}
            <SummaryHighlight>{config.branchNameLabel}</SummaryHighlight> from{' '}
            <SummaryHighlight>{config.createBranchFrom}</SummaryHighlight>
          </>
        );
      case 'switch-branch':
        return (
          <>
            use existing branch{' '}
            <SummaryHighlight>{config.switchBranchTarget}</SummaryHighlight>
          </>
        );
      case 'switch-worktree':
        return (
          <>
            use existing worktree{' '}
            <SummaryHighlight>
              {getSelectItemDisplayText(
                worktreeItems,
                config.switchWorktreeTarget,
              )}
            </SummaryHighlight>
          </>
        );
    }
  }, [config, worktreeItems]);

  const resolveAbsolute = useCallback((p: string) => p, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <FileContextMenu relativePath={mount.path} resolvePath={resolveAbsolute}>
        <div
          data-tutorial={mount.git ? 'workspace-badge' : undefined}
          className="group/workspace flex max-w-96 cursor-default items-center justify-start gap-1.5 text-muted-foreground text-xs"
        >
          <Tooltip>
            <TooltipTrigger>
              <span
                data-unmount
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onUnmount(mount.prefix);
                }}
                className="group/unmount relative flex size-4 shrink-0 cursor-pointer items-center justify-center"
              >
                {/*
                  Trigger icon mirrors the chosen action's domain so
                  the user can read the row at a glance: a worktree
                  icon for worktree actions, a branch icon for branch
                  actions. Both share the same hover-fade behavior
                  that swaps in the disconnect X.
                */}
                {config.selectedAction === 'create-worktree' ||
                config.selectedAction === 'switch-worktree' ? (
                  <IconBranchOutOutline18 className="size-3 shrink-0 group-hover/workspace:opacity-0" />
                ) : (
                  <IconCodeBranchOutline18 className="size-3 shrink-0 group-hover/workspace:opacity-0" />
                )}
                <IconXmarkFill18 className="absolute size-3 text-muted-foreground opacity-0 group-hover/unmount:text-foreground group-hover/workspace:opacity-100" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Disconnect workspace</TooltipContent>
          </Tooltip>
          <span className="shrink-0 truncate text-muted-foreground">
            {display.title}
          </span>
          {display.qualifier && (
            <span className="min-w-0 truncate text-subtle-foreground">
              {display.qualifier}
            </span>
          )}
          <span
            aria-hidden
            className="shrink-0 select-none text-subtle-foreground"
          >
            &middot;
          </span>
          <PopoverTrigger>
            <Button
              variant="ghost"
              size="xs"
              data-tutorial="workspace-action-trigger"
              className={cn(
                'group/action flex min-w-0 justify-start gap-1.5 px-0',
                'text-muted-foreground hover:text-muted-foreground',
                'focus-visible:text-foreground',
                'has-[[data-popup-open]]:text-foreground',
              )}
            >
              <span className="min-w-0 truncate text-subtle-foreground group-hover/action:text-muted-foreground group-has-[[data-popup-open]]/action:text-muted-foreground">
                {triggerSummary}
              </span>
              <WorkspaceSetupStatusIndicator
                setupRun={setupRun}
                failedClassName="text-muted-foreground group-hover/action:text-foreground group-focus-visible/action:text-foreground"
              />
              <IconChevronDownFill18 className="size-3 shrink-0 text-subtle-foreground group-hover/action:text-muted-foreground group-has-[[data-popup-open]]/action:text-muted-foreground" />
            </Button>
          </PopoverTrigger>
        </div>
      </FileContextMenu>

      <PopoverBase.Portal>
        <PopoverBase.Backdrop
          className="pointer-events-auto fixed inset-0 z-40 size-full"
          onClick={(e) => e.stopPropagation()}
        />
        <PopoverBase.Positioner
          sideOffset={8}
          side="top"
          align="start"
          className="z-50"
        >
          <PopoverBase.Popup
            ref={popupRef}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handlePopupKeyDown}
            className={cn(
              // `group/rows` enables the cross-row "hover steals the
              // foreground color from the active row" behavior on
              // every `ActionRow` inside.
              'group/rows flex w-fit min-w-72 max-w-[28rem] flex-col gap-0 p-1',
              'rounded-lg bg-background ring-1 ring-border-subtle',
              'text-foreground shadow-lg',
              'transition-[transform,scale,opacity] duration-150 ease-out',
              'origin-(--transform-origin)',
              'data-ending-style:scale-90 data-starting-style:scale-90',
              'data-ending-style:opacity-0 data-starting-style:opacity-0',
            )}
          >
            <WorkspaceActionPickerContent
              config={config}
              sourceBranchItems={sourceBranchItems}
              checkoutBranchItems={checkoutBranchItems}
              worktreeItems={worktreeItems}
              onCommit={handleActionChange}
              onUpdateAction={handleActionUpdate}
            />
            {actionError && (
              <div className="px-2 pt-1 pb-1 text-error-foreground text-xs">
                {actionError}
              </div>
            )}
          </PopoverBase.Popup>
        </PopoverBase.Positioner>
      </PopoverBase.Portal>
    </Popover>
  );
});

// Group header inside the workspace action popover. Mirrors the
// agents-list group header styling (subtle-foreground, semibold xs).
export function ActionGroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 px-2 pt-2 pb-0.5 font-semibold text-subtle-foreground text-xs first:pt-1">
      {children}
    </div>
  );
}

// Inline highlight inside the workspace action trigger summary. Default
// rests at `text-muted-foreground` so the trigger reads as a subdued
// preview; it lifts to `text-foreground` only when the trigger row is
// hovered/focused or the popover is open.
export function SummaryHighlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground group-hover/action:text-foreground group-focus-visible/action:text-foreground group-has-[[data-popup-open]]/action:text-foreground">
      {children}
    </span>
  );
}

// Single radio-style row inside the workspace action popover. The whole row
// is the click target; embedded interactive controls (Selects) sit inside
// and bubble their click up so picking inside an inactive row's Select
// also activates that row.
export function ActionRow({
  active,
  onSelect,
  children,
  tutorialId,
}: {
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  tutorialId?: string;
}) {
  return (
    <div
      role="radio"
      aria-checked={active}
      tabIndex={0}
      data-action-row=""
      data-tutorial={tutorialId}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        // Keep rows adjacent in layout so crossing from one row to the next
        // never leaves all `[data-action-row]` hitboxes. The active row's
        // highlight is muted while another row is hovered; parent `gap` would
        // create a dead zone where the active row briefly re-highlights.
        'flex min-h-6 items-center gap-1.5 rounded-md px-2 py-0.5',
        // Color rules:
        //   – base rest: muted
        //   – active rest: foreground (the "selected" row reads as the
        //     current choice)
        //   – any row hovered: foreground (the hovered row "steals" it)
        //   – active + a sibling hovered: muted (the active row gives
        //     up its foreground while a different row is being
        //     considered). A self-hovered active row keeps the same
        //     foreground hover treatment as every other row.
        // Requires the wrapping popup to carry `group/rows`.
        'text-muted-foreground hover:text-foreground',
        'data-[active]:text-foreground',
        'group-has-[[data-action-row]:hover]/rows:data-[active]:text-muted-foreground',
        'data-[active]:hover:!text-foreground',
        'hover:bg-hover-derived focus-visible:bg-hover-derived focus-visible:outline-none',
        // Unselected rows are actionable — pointer cursor. The selected
        // row is already the current choice; default cursor signals that
        // clicking it again is a no-op.
        active ? 'cursor-default bg-hover-derived' : 'cursor-pointer',
      )}
      data-active={active ? '' : undefined}
    >
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        {active && <IconCheckFill18 className="size-full" />}
      </span>
      {children}
    </div>
  );
}

/**
 * Editable name chip rendered as a real `<input>` so the user gets a
 * visible "this is editable" affordance (subtle box + caret) without
 * breaking the row's compact rhythm. Width tracks the value via `ch`
 * units so the input is only as wide as the text it holds.
 */
export function NameChip({
  name,
  onCommit,
}: {
  name: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(name);

  // Keep local draft in sync with external updates (e.g. when the
  // parent regenerates the suggested name).
  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next.length > 0 && next !== name) {
      onCommit(next);
    } else {
      setDraft(name);
    }
  }, [draft, name, onCommit]);

  // Auto-size the input to its value by overlaying it on top of an
  // invisible span that mirrors the text. The grid track collapses to
  // the span's intrinsic width, then the input stretches to fill it.
  // This is more reliable across fonts than `field-sizing: content` /
  // `ch` units (which use the "0" character width and over-shoot for
  // narrow letters like "i" / "l").
  return (
    <span
      className="mx-0.5 inline-grid h-5 min-w-12 max-w-40 shrink-0 align-middle"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        aria-hidden
        className="invisible col-start-1 row-start-1 whitespace-pre rounded px-1.5 py-0 font-normal text-xs leading-none"
      >
        {draft || '\u00A0'}
      </span>
      <input
        type="text"
        value={draft}
        // `size={1}` neutralises the input's default intrinsic width
        // (which is derived from the `size` attribute, default 20).
        // Without this, the auto grid track sizes to that 20-char
        // intrinsic width and ignores the mirror span.
        size={1}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(name);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        className={cn(
          'col-start-1 row-start-1 size-full min-w-0 rounded bg-surface-1 px-1.5 py-0',
          'font-normal text-foreground text-xs leading-none',
          'outline-none ring-1 ring-border-subtle transition-shadow',
          'focus:ring-border-derived',
        )}
      />
    </span>
  );
}

export function getSelectItemDisplayText(
  items: SelectItem<string>[],
  value: string,
): React.ReactNode {
  const item = items.find((candidate) => candidate.value === value);
  return item?.triggerLabel ?? item?.label ?? value;
}

export function getSelectItemSearchText(item: SelectItem<string>): string {
  return [item.value, item.label, item.triggerLabel]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

export function groupSelectItems(
  items: SelectItem<string>[],
): Array<{ group: string | undefined; items: SelectItem<string>[] }> {
  const groups: Array<{
    group: string | undefined;
    items: SelectItem<string>[];
  }> = [];
  let currentGroup: string | undefined;
  let currentItems: SelectItem<string>[] = [];

  for (const item of items) {
    if (item.group !== currentGroup) {
      if (currentItems.length > 0) {
        groups.push({ group: currentGroup, items: currentItems });
      }
      currentGroup = item.group;
      currentItems = [item];
    } else {
      currentItems.push(item);
    }
  }

  if (currentItems.length > 0) {
    groups.push({ group: currentGroup, items: currentItems });
  }

  return groups;
}

export function ActionBranchSelect({
  items,
  value,
  onValueChange,
  icon = 'branch',
  portalContainer,
  onPopupMouseEnter,
  onPopupMouseLeave,
  onPopupOpenChange,
}: {
  items: SelectItem<string>[];
  value: string;
  onValueChange: (v: string) => void;
  icon?: 'branch' | 'worktree';
  portalContainer?: React.RefObject<HTMLElement | null>;
  onPopupMouseEnter?: () => void;
  onPopupMouseLeave?: () => void;
  onPopupOpenChange?: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      getSelectItemSearchText(item).toLowerCase().includes(needle),
    );
  }, [items, query]);
  const groupedFiltered = useMemo(() => groupSelectItems(filtered), [filtered]);

  const handleValueChange = useCallback(
    (next: string | null) => {
      if (next != null) onValueChange(next);
    },
    [onValueChange],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      onPopupOpenChange?.(open);
      if (!open) setQuery('');
    },
    [onPopupOpenChange],
  );

  return (
    <span
      className="ml-1 shrink-0"
      // Stop popover-row clicks from re-firing when interacting with
      // the combobox trigger / chevron.
      onClick={(e) => e.stopPropagation()}
    >
      <Combobox
        value={value}
        onValueChange={handleValueChange}
        onOpenChange={handleOpenChange}
        filter={null}
      >
        <ComboboxBase.Trigger
          className={cn(
            'inline-flex h-5 cursor-pointer items-center gap-1 rounded p-0 font-normal text-xs shadow-none',
            'focus-visible:outline-1 focus-visible:outline-muted-foreground/35 focus-visible:-outline-offset-2',
            'bg-transparent text-muted-foreground hover:text-foreground data-popup-open:text-foreground',
          )}
        >
          {icon === 'worktree' ? (
            <IconBranchOutOutline18 className="size-3 shrink-0" />
          ) : (
            <IconCodeBranchOutline18 className="size-3 shrink-0" />
          )}
          <span className="truncate">
            {getSelectItemDisplayText(items, value)}
          </span>
          <ComboboxBase.Icon className="shrink-0">
            <IconChevronDownFill18 className="size-3" />
          </ComboboxBase.Icon>
        </ComboboxBase.Trigger>

        <ComboboxBase.Portal container={portalContainer}>
          <ComboboxBase.Backdrop className="fixed inset-0 z-50" />
          <ComboboxBase.Positioner
            side="bottom"
            sideOffset={4}
            align="start"
            className="z-50"
          >
            <ComboboxBase.Popup
              onMouseEnter={onPopupMouseEnter}
              onMouseLeave={onPopupMouseLeave}
              // This popup is rendered in a portal. React events from
              // portals still bubble through the React tree, so a click
              // on a ComboboxItem would otherwise reach the enclosing
              // ActionRow and trigger its commit/close handler.
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className={cn(
                'flex w-72 max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col gap-0.5 text-xs',
                'rounded-lg border border-border-subtle bg-background p-1 shadow-lg',
                'transition-[transform,scale,opacity] duration-150 ease-out',
                'data-ending-style:scale-90 data-ending-style:opacity-0',
                'data-starting-style:scale-90 data-starting-style:opacity-0',
              )}
            >
              <div className="mb-1 rounded-md">
                <ComboboxInput
                  size="xs"
                  placeholder="Search…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <ComboboxList className="scrollbar-subtle max-h-48 min-w-0 overflow-y-auto">
                {groupedFiltered.map(({ group, items: groupItems }, index) => (
                  <ComboboxGroup
                    key={group ?? `ungrouped-${index}`}
                    className="shrink-0"
                  >
                    {group && <ComboboxGroupLabel>{group}</ComboboxGroupLabel>}
                    {groupItems.map((item) => {
                      const label =
                        typeof item.label === 'string'
                          ? item.label
                          : String(item.value);
                      const isSelected = item.value === value;
                      return (
                        <ComboboxItem
                          key={String(item.value)}
                          value={item.value}
                          size="xs"
                          disabled={item.disabled}
                          onClick={() => {
                            if (isSelected) onValueChange(item.value);
                          }}
                          // Selected item: already the current value, so a
                          // default cursor signals "no-op". Other rows are
                          // actionable — keep the pointer cursor.
                          className={cn(
                            'min-h-6 shrink-0 items-center text-xs leading-4',
                            isSelected ? 'cursor-default' : 'cursor-pointer',
                          )}
                        >
                          <ComboboxItemIndicator className="self-center" />
                          <span className="col-start-2 min-w-0 truncate leading-4">
                            {label}
                          </span>
                        </ComboboxItem>
                      );
                    })}
                  </ComboboxGroup>
                ))}
                {filtered.length === 0 && (
                  <div className="px-2 py-1.5 text-muted-foreground text-xs">
                    No results
                  </div>
                )}
              </ComboboxList>
            </ComboboxBase.Popup>
          </ComboboxBase.Positioner>
        </ComboboxBase.Portal>
      </Combobox>
    </span>
  );
}
