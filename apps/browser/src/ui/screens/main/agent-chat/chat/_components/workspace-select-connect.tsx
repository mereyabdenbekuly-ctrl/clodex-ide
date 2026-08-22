import type { KartonContract } from '@shared/karton-contracts/ui';
import { GIT_OPTIONS_STALE_MS } from './workspace-select-actions';
import {
  createDefaultWorkspaceActionConfig,
  toWorkspaceActionPayload,
  type WorkspaceAction,
  type WorkspaceActionConfig,
} from './workspace-select-actions';
import { WorkspaceActionPickerContent } from './workspace-select-picker';

type KartonState = KartonContract['state'];
type KartonProcedures = KartonContract['serverProcedures'];

import type { SelectItem } from '@clodex/stage-ui/components/select';

import {
  getBranchSelectItems,
  getBranchSelectItemsFromGit,
  getCurrentBranchValue,
  getDefaultSourceBranchValue,
  getWorktreeSelectItems,
  getWorktreeSelectItemsFromGit,
} from './worktree-utils';
import {
  IconChevronDownFill18,
  IconFolder5Outline18,
  IconPlusFill18,
} from '@clodex/icons';
import { Popover as PopoverBase } from '@base-ui/react/popover';
import { Popover, PopoverTrigger } from '@clodex/stage-ui/components/popover';

import { cn } from '@clodex/stage-ui/lib/utils';

import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useScrollFadeMask } from '@ui/hooks/use-scroll-fade-mask';
import { useTrack } from '@ui/hooks/use-track';

import { useHotKeyListener } from '@ui/hooks/use-hotkey-listener';

import { HotkeyActions } from '@shared/hotkeys';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { applyWorkspaceGitActionPreferences } from './workspace-action-preferences';
import { hydrateWorkspaceActionConfigWithDefaults } from './workspace-action-config-utils';

// ============================================================================
// Connect workspace popover
// ============================================================================
//
// Replaces the legacy flat `Select` connect popover with a custom popover.
// Recent workspace rows expose an inline action selector; clicking the parent
// row commits whichever action is selected for that row. Empty-chat recent
// connects mount the workspace and defer the selected action into the
// below-input action selector. Post-message recent connects execute the
// selected action immediately by path. Connect-new remains picker-first because
// there is no path until the native picker resolves.

// Per-row action configuration. Each recent path (and the literal
// `__new__` row) gets its own entry so configuration is preserved while the
// popover is open. The map is reset whenever the popover closes.
export type ConnectActionState = WorkspaceActionConfig;

const CONNECT_NEW_KEY = '__new__';

/**
 * How long cached git options are considered fresh. After this threshold,
 * the next call to `loadGitOptionsForPath` triggers a `git fetch --prune --all`
 * on the backend before returning branch/worktree lists.
 */
function ConnectActionSummary({ state }: { state: ConnectActionState }) {
  switch (state.selectedAction) {
    case 'create-worktree':
      return <>Create new worktree</>;
    case 'switch-worktree':
      return <>Use worktree</>;
    case 'create-branch':
      return <>Create new branch</>;
    case 'switch-branch':
      return <>Use branch</>;
  }
}

type ConnectGitOptions = {
  sourceBranchItems: SelectItem<string>[];
  checkoutBranchItems: SelectItem<string>[];
  worktreeItems: SelectItem<string>[];
  defaultBranch: string;
  checkoutDefaultBranch: string;
};

type ConnectPathGitCapability = 'unknown' | 'loading' | 'git' | 'not-git';

type ConnectInlineActionSelectProps = {
  state: ConnectActionState;
  sourceBranchItems: SelectItem<string>[];
  checkoutBranchItems: SelectItem<string>[];
  worktreeItems: SelectItem<string>[];
  onOpen?: () => void;
  onUpdate: (partial: Partial<ConnectActionState>) => void;
};

function ConnectInlineActionSelect({
  state,
  sourceBranchItems,
  checkoutBranchItems,
  worktreeItems,
  onOpen,
  onUpdate,
}: ConnectInlineActionSelectProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const handleActionUpdate = useCallback(
    (selectedAction: WorkspaceAction, partial: Partial<ConnectActionState>) => {
      onUpdate({ ...partial, selectedAction });
      setOpen(false);
    },
    [onUpdate],
  );

  const handleSelect = useCallback(
    (selectedAction: WorkspaceAction) => {
      handleActionUpdate(selectedAction, {});
    },
    [handleActionUpdate],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) onOpen?.();
    },
    [onOpen],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger>
        <button
          type="button"
          data-connect-action-trigger=""
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'group/connect-action inline-flex min-w-0 max-w-full cursor-pointer items-baseline gap-1 rounded p-0 font-normal text-muted-foreground text-xs shadow-none',
            'bg-transparent hover:text-foreground',
            'focus-visible:outline-1 focus-visible:outline-muted-foreground/35 focus-visible:-outline-offset-2 data-popup-open:text-foreground',
          )}
        >
          <span className="min-w-0 truncate whitespace-nowrap">
            <ConnectActionSummary state={state} />
          </span>
          <IconChevronDownFill18 className="size-3 shrink-0 self-center text-muted-foreground group-hover/connect-action:text-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverBase.Portal>
        <PopoverBase.Backdrop
          className="pointer-events-auto fixed inset-0 z-50"
          // The nested action picker lives inside a clickable recent-workspace
          // row. Portal events still bubble through the React tree, so outside
          // clicks on this backdrop must close only the nested picker and must
          // not reach the parent row where they would commit/connect it.
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <PopoverBase.Positioner
          side="top"
          sideOffset={8}
          align="end"
          className="z-50"
        >
          <PopoverBase.Popup
            ref={popupRef}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'group/rows flex w-fit min-w-72 max-w-[28rem] flex-col gap-0 p-1',
              'rounded-lg bg-background ring-1 ring-border-subtle',
              'text-foreground shadow-lg',
              'transition-[transform,scale,opacity] duration-150 ease-out',
              'origin-(--transform-origin)',
              'data-ending-style:scale-90 data-starting-style:scale-90',
              'data-ending-style:opacity-0 data-starting-style:opacity-0',
            )}
          >
            <div data-connect-action-popup="">
              <WorkspaceActionPickerContent
                config={state}
                sourceBranchItems={sourceBranchItems}
                checkoutBranchItems={checkoutBranchItems}
                worktreeItems={worktreeItems}
                branchSelectPortalContainer={popupRef}
                onCommit={handleSelect}
                onUpdateAction={handleActionUpdate}
              />
            </div>
          </PopoverBase.Popup>
        </PopoverBase.Positioner>
      </PopoverBase.Portal>
    </Popover>
  );
}

export type ConnectMountResult = { ok: true } | { ok: false; message: string };

type ConnectWorkspaceSelectProps = {
  hasMounts: boolean;
  recentPaths: ReadonlyArray<{
    path: string;
    name: string;
    openedAt: number;
  }>;
  onMount: (
    path: string | undefined,
    config: ConnectActionState | null,
  ) => Promise<ConnectMountResult>;
};

export const ConnectWorkspaceSelect = memo(
  function ConnectWorkspaceSelectInner({
    hasMounts,
    recentPaths,
    onMount,
  }: ConnectWorkspaceSelectProps) {
    const track = useTrack();
    const listGitBranchesByPath = useKartonProcedure(
      (p: KartonProcedures) => p.toolbox.listGitBranchesByPath,
    );
    const listGitWorktreesByPath = useKartonProcedure(
      (p: KartonProcedures) => p.toolbox.listGitWorktreesByPath,
    );
    const preferencesUpdate = useKartonProcedure(
      (p: KartonProcedures) => p.preferences.update,
    );
    const workspaceGitActionGeneralPreference = useKartonState(
      (s: KartonState) =>
        s.preferences.agent.workspaceGitActionPreferences.general,
    );
    const fallbackBranchItems = useMemo(() => getBranchSelectItems(null), []);
    const fallbackWorktreeItems = useMemo(() => getWorktreeSelectItems(), []);

    const createPreferredDefaultConfig = useCallback(
      (
        sourceBranchItems: SelectItem<string>[],
        worktreeItems: SelectItem<string>[],
        checkoutBranchItems: SelectItem<string>[] = sourceBranchItems,
        defaultBranch?: string,
        checkoutDefaultBranch?: string,
      ) =>
        applyWorkspaceGitActionPreferences(
          createDefaultWorkspaceActionConfig(
            sourceBranchItems,
            worktreeItems,
            checkoutBranchItems,
            defaultBranch,
            checkoutDefaultBranch,
          ),
          sourceBranchItems,
          worktreeItems,
          workspaceGitActionGeneralPreference,
          undefined,
          checkoutBranchItems,
        ),
      [workspaceGitActionGeneralPreference],
    );

    const persistGeneralWorkspaceGitActionPreference = useCallback(
      (selectedAction: WorkspaceAction) => {
        void preferencesUpdate([
          {
            op: 'add',
            path: [
              'agent',
              'workspaceGitActionPreferences',
              'general',
              'selectedAction',
            ],
            value: selectedAction,
          },
        ]);
      },
      [preferencesUpdate],
    );

    const [open, setOpen] = useState(false);
    const [pathGitOptions, setPathGitOptions] = useState<
      ReadonlyMap<string, ConnectGitOptions>
    >(() => new Map());
    const [pathGitOptionsTimestamp, setPathGitOptionsTimestamp] = useState<
      ReadonlyMap<string, number>
    >(() => new Map());
    const [pathGitCapability, setPathGitCapability] = useState<
      ReadonlyMap<string, ConnectPathGitCapability>
    >(() => new Map());
    const [pathStates, setPathStates] = useState<
      ReadonlyMap<string, ConnectActionState>
    >(() => new Map());
    const [connectError, setConnectError] = useState<string | null>(null);
    const [pendingRowKey, setPendingRowKey] = useState<string | null>(null);
    const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    const recentListScrollRef = useRef<HTMLDivElement>(null);
    const { maskStyle: recentListMaskStyle } = useScrollFadeMask(
      recentListScrollRef,
      {
        axis: 'vertical',
        fadeDistances: { bottom: 28 },
      },
    );

    const getOrInitState = useCallback(
      (rowKey: string): ConnectActionState => {
        const existing = pathStates.get(rowKey);
        if (existing) return existing;
        const next = createPreferredDefaultConfig(
          fallbackBranchItems,
          fallbackWorktreeItems,
        );
        setPathStates((prev) => {
          if (prev.has(rowKey)) return prev;
          const map = new Map(prev);
          map.set(rowKey, next);
          return map;
        });
        return next;
      },
      [
        pathStates,
        fallbackBranchItems,
        fallbackWorktreeItems,
        createPreferredDefaultConfig,
      ],
    );

    const updateRowState = useCallback(
      (rowKey: string, partial: Partial<ConnectActionState>) => {
        setPathStates((prev) => {
          const map = new Map(prev);
          const current =
            map.get(rowKey) ??
            createPreferredDefaultConfig(
              fallbackBranchItems,
              fallbackWorktreeItems,
            );
          map.set(rowKey, { ...current, ...partial });
          return map;
        });
      },
      [
        fallbackBranchItems,
        fallbackWorktreeItems,
        createPreferredDefaultConfig,
      ],
    );

    const initializePathStates = useCallback(() => {
      setPathStates((prev) => {
        const map = new Map(prev);
        let changed = false;

        for (const workspace of recentPaths) {
          const rowKey = `workspace:${workspace.path}`;
          if (!map.has(rowKey)) {
            map.set(
              rowKey,
              createPreferredDefaultConfig(
                fallbackBranchItems,
                fallbackWorktreeItems,
              ),
            );
            changed = true;
          }
        }

        if (!map.has(CONNECT_NEW_KEY)) {
          map.set(
            CONNECT_NEW_KEY,
            createPreferredDefaultConfig(
              fallbackBranchItems,
              fallbackWorktreeItems,
            ),
          );
          changed = true;
        }

        return changed ? map : prev;
      });
    }, [
      fallbackBranchItems,
      fallbackWorktreeItems,
      recentPaths,
      createPreferredDefaultConfig,
    ]);

    const loadGitOptionsForPath = useCallback(
      async (
        workspacePath: string,
        rowKey: string,
      ): Promise<ConnectGitOptions | null> => {
        const cached = pathGitOptions.get(workspacePath);
        const cachedAt = pathGitOptionsTimestamp.get(workspacePath);
        const isStale =
          !cachedAt || Date.now() - cachedAt > GIT_OPTIONS_STALE_MS;
        if (cached && !isStale) return cached;

        const needsRemoteRefresh = isStale;

        setPathGitCapability((prev) => {
          if (prev.get(workspacePath) === 'loading') return prev;
          const next = new Map(prev);
          next.set(workspacePath, 'loading');
          return next;
        });

        let branchesResult: Awaited<ReturnType<typeof listGitBranchesByPath>>;
        let worktreesResult: Awaited<ReturnType<typeof listGitWorktreesByPath>>;
        try {
          [branchesResult, worktreesResult] = await Promise.all([
            listGitBranchesByPath(
              workspacePath,
              needsRemoteRefresh ? { refresh: true } : undefined,
            ),
            listGitWorktreesByPath(workspacePath),
          ]);
        } catch {
          setPathGitCapability((prev) => {
            const next = new Map(prev);
            next.set(workspacePath, 'not-git');
            return next;
          });
          return null;
        }

        if (!branchesResult || !worktreesResult) {
          setPathGitCapability((prev) => {
            const next = new Map(prev);
            next.set(workspacePath, 'not-git');
            return next;
          });
          return null;
        }

        const sourceBranchItems = getBranchSelectItemsFromGit(
          branchesResult,
          null,
          'source',
        );
        const checkoutBranchItems = getBranchSelectItemsFromGit(
          branchesResult,
          null,
          'checkout-target',
        );
        const worktreeItems = getWorktreeSelectItemsFromGit(worktreesResult);
        const defaultBranch = getDefaultSourceBranchValue(branchesResult, null);
        const checkoutDefaultBranch = getCurrentBranchValue(
          branchesResult,
          null,
        );
        const options = {
          sourceBranchItems,
          checkoutBranchItems,
          worktreeItems,
          defaultBranch,
          checkoutDefaultBranch,
        };
        setPathGitOptions((prev) => {
          const next = new Map(prev);
          next.set(workspacePath, options);
          return next;
        });
        // Only advance the staleness timer when the remote refresh actually
        // succeeded — otherwise the fetch was silently swallowed and the
        // on-disk refs are still stale.
        if (!needsRemoteRefresh || branchesResult.refreshSucceeded) {
          setPathGitOptionsTimestamp((prev) => {
            const next = new Map(prev);
            next.set(workspacePath, Date.now());
            return next;
          });
        }
        setPathGitCapability((prev) => {
          const next = new Map(prev);
          next.set(workspacePath, 'git');
          return next;
        });
        setPathStates((prev) => {
          const current = prev.get(rowKey);
          if (!current) return prev;

          const defaults = createPreferredDefaultConfig(
            sourceBranchItems,
            worktreeItems,
            checkoutBranchItems,
            defaultBranch,
            checkoutDefaultBranch,
          );
          const sourceBranchValues = new Set(
            sourceBranchItems.map((item) => item.value),
          );
          const checkoutBranchValues = new Set(
            checkoutBranchItems.map((item) => item.value),
          );
          const worktreeValues = new Set(
            worktreeItems.map((item) => item.value),
          );
          const hydrated = hydrateWorkspaceActionConfigWithDefaults(
            current,
            defaults,
            {
              sourceBranch: 'main',
              checkoutBranch: 'main',
              defaultBranch: 'main',
              worktree: getWorktreeSelectItems()[0]?.value ?? 'main',
            },
          );
          const next = new Map(prev);
          next.set(rowKey, {
            ...hydrated,
            createWorktreeFrom: sourceBranchValues.has(
              hydrated.createWorktreeFrom,
            )
              ? hydrated.createWorktreeFrom
              : defaults.createWorktreeFrom,
            createBranchFrom: sourceBranchValues.has(hydrated.createBranchFrom)
              ? hydrated.createBranchFrom
              : defaults.createBranchFrom,
            switchBranchTarget: checkoutBranchValues.has(
              hydrated.switchBranchTarget,
            )
              ? hydrated.switchBranchTarget
              : defaults.switchBranchTarget,
            switchWorktreeTarget: worktreeValues.has(
              hydrated.switchWorktreeTarget,
            )
              ? hydrated.switchWorktreeTarget
              : defaults.switchWorktreeTarget,
          });
          return next;
        });
        return options;
      },
      [
        createPreferredDefaultConfig,
        listGitBranchesByPath,
        listGitWorktreesByPath,
        pathGitOptions,
        pathGitOptionsTimestamp,
      ],
    );

    const commitConnect = useCallback(
      async (rowKey: string, state: ConnectActionState) => {
        if (pendingRowKey) return;

        const source = rowKey === CONNECT_NEW_KEY ? 'picker' : 'recent';
        track('workspace-connect-action-chosen', {
          action: state.selectedAction,
          action_payload: toWorkspaceActionPayload(state),
          source,
        });
        const path =
          rowKey === CONNECT_NEW_KEY
            ? undefined
            : rowKey.replace('workspace:', '');
        const gitOptions =
          path === undefined ? null : await loadGitOptionsForPath(path, rowKey);
        if (path === undefined || gitOptions) {
          // Path-based connect flows do not expose a stable repository ID here.
          // Keep persistence limited to the general action preference to avoid
          // leaking worktree paths across repositories.
          persistGeneralWorkspaceGitActionPreference(state.selectedAction);
        }
        const config =
          path === undefined
            ? state
            : gitOptions
              ? hydrateWorkspaceActionConfigWithDefaults(
                  state,
                  createDefaultWorkspaceActionConfig(
                    gitOptions.sourceBranchItems,
                    gitOptions.worktreeItems,
                    gitOptions.checkoutBranchItems,
                    gitOptions.defaultBranch,
                    gitOptions.checkoutDefaultBranch,
                  ),
                  {
                    sourceBranch: 'main',
                    checkoutBranch: 'main',
                    defaultBranch: 'main',
                    worktree: getWorktreeSelectItems()[0]?.value ?? 'main',
                  },
                )
              : null;

        setConnectError(null);
        setPendingRowKey(rowKey);
        const result = await onMount(path, config);
        setPendingRowKey(null);

        if (!result.ok) {
          setConnectError(result.message);
          return;
        }

        setOpen(false);
      },
      [
        loadGitOptionsForPath,
        onMount,
        pendingRowKey,
        persistGeneralWorkspaceGitActionPreference,
        track,
      ],
    );

    const getConnectNavigationItems = useCallback(() => {
      const popup = popupRef.current;
      if (!popup) return [];

      return Array.from(
        popup.querySelectorAll<HTMLElement>(
          '[data-connect-row], [data-connect-new-row]',
        ),
      ).filter(
        (item) =>
          !(item instanceof HTMLButtonElement && item.disabled) &&
          item.getAttribute('aria-disabled') !== 'true',
      );
    }, []);

    const focusFirstConnectItem = useCallback(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          getConnectNavigationItems()[0]?.focus();
        });
      });
    }, [getConnectNavigationItems]);

    const openConnectPopover = useCallback(() => {
      setOpen(true);
      setConnectError(null);
      initializePathStates();
      for (const workspace of recentPaths) {
        const rowKey = `workspace:${workspace.path}`;
        void loadGitOptionsForPath(workspace.path, rowKey);
      }
      focusFirstConnectItem();
    }, [
      focusFirstConnectItem,
      initializePathStates,
      loadGitOptionsForPath,
      recentPaths,
    ]);

    const handleOpenChange = useCallback(
      (next: boolean) => {
        if (next) {
          openConnectPopover();
          return;
        }

        setOpen(false);
        // Reset transient state on close so each open is a fresh
        // decision.
        setConnectError(null);
        setPendingRowKey(null);
        setFocusedRowKey(null);
        setPathStates(new Map());
        setPathGitOptions(new Map());
        setPathGitCapability(new Map());
      },
      [openConnectPopover],
    );

    useHotKeyListener(
      useCallback(() => {
        openConnectPopover();
      }, [openConnectPopover]),
      HotkeyActions.OPEN_WORKSPACE_SELECT,
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

        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest(
            '[data-connect-action-trigger], [data-connect-action-popup]',
          )
        )
          return;

        const items = getConnectNavigationItems();
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
      [getConnectNavigationItems],
    );

    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger>
          {/*
          PopoverTrigger uses Base UI's `render` prop and forwards the
          trigger's button-like behavior onto its single child. Wrapping
          the Button in a Tooltip breaks that contract — the popover
          never gets wired to the actual Button. The previous tooltip
          ("Give the agent access to your files.") is dropped here;
          the with-label variant is self-explanatory, and the icon-only
          variant can grow a tooltip later via a different pattern.
        */}
          {hasMounts ? (
            <Button
              variant="ghost"
              size="xs"
              aria-label="Connect workspace"
              data-tutorial="connect-workspace"
              className="h-6 shrink-0 px-0 text-muted-foreground hover:text-foreground"
            >
              <IconFolder5Outline18 className="size-3 shrink-0" />
              <IconPlusFill18 className="size-2.5 shrink-0" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              data-tutorial="connect-workspace"
              className="h-6 shrink-0 px-0 text-muted-foreground hover:text-foreground"
            >
              <IconFolder5Outline18 className="size-3 shrink-0" />
              <span>Connect workspace</span>
              <IconPlusFill18 className="size-3 shrink-0" />
            </Button>
          )}
        </PopoverTrigger>

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
                'group/connect-list flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-0 p-1',
                'rounded-lg bg-background ring-1 ring-border-subtle',
                'text-foreground shadow-lg',
                'transition-[transform,scale,opacity] duration-150 ease-out',
                'origin-(--transform-origin)',
                'data-ending-style:scale-90 data-starting-style:scale-90',
                'data-ending-style:opacity-0 data-starting-style:opacity-0',
              )}
            >
              {recentPaths.length > 0 && (
                <div className="px-2 pt-1 pb-1 font-semibold text-subtle-foreground text-xs">
                  Recent workspaces
                </div>
              )}
              {recentPaths.length > 0 && (
                <div
                  ref={recentListScrollRef}
                  className="mask-alpha scrollbar-subtle max-h-[8.75rem] overflow-y-auto"
                  style={recentListMaskStyle}
                >
                  {recentPaths.map((workspace, index) => {
                    const rowKey = `workspace:${workspace.path}`;
                    const rowState =
                      pathStates.get(rowKey) ??
                      createPreferredDefaultConfig(
                        fallbackBranchItems,
                        fallbackWorktreeItems,
                      );
                    const gitOptions = pathGitOptions.get(workspace.path);
                    const gitCapability =
                      pathGitCapability.get(workspace.path) ?? 'unknown';
                    const sourceBranchItems =
                      gitOptions?.sourceBranchItems ?? fallbackBranchItems;
                    const checkoutBranchItems =
                      gitOptions?.checkoutBranchItems ?? fallbackBranchItems;
                    const worktreeItems =
                      gitOptions?.worktreeItems ?? fallbackWorktreeItems;
                    const showActionByDefault = index === 0 && !focusedRowKey;
                    const showActionForFocus = focusedRowKey === rowKey;
                    return (
                      <div
                        key={rowKey}
                        role="button"
                        tabIndex={0}
                        data-connect-row=""
                        onFocus={() => setFocusedRowKey(rowKey)}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Parent-row click commits whichever action is
                          // currently selected in the inline action select
                          // for this row (defaults to `create-worktree`).
                          const state = getOrInitState(rowKey);
                          void commitConnect(rowKey, state);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            const state = getOrInitState(rowKey);
                            void commitConnect(rowKey, state);
                          }
                        }}
                        className={cn(
                          'group/connect-row relative flex w-full cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-left text-foreground text-xs',
                          'hover:bg-hover-derived',
                          'focus-visible:bg-hover-derived focus-visible:outline-none',
                        )}
                      >
                        <div className="flex min-w-0 items-baseline">
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {workspace.name}
                          </span>
                          <span
                            className={cn(
                              'flex shrink-0 text-subtle-foreground transition-opacity group-hover/connect-row:text-muted-foreground',
                              'group-hover/connect-row:!pointer-events-auto group-hover/connect-row:!opacity-100',
                              'has-[[data-popup-open]]:!pointer-events-auto has-[[data-popup-open]]:!opacity-100',
                              showActionForFocus || showActionByDefault
                                ? 'pointer-events-auto opacity-100'
                                : 'pointer-events-none opacity-0',
                              showActionByDefault
                                ? 'group-has-[[data-connect-row]:hover]/connect-list:pointer-events-none group-has-[[data-connect-row]:hover]/connect-list:opacity-0'
                                : null,
                            )}
                          >
                            {gitCapability === 'git' && (
                              <ConnectInlineActionSelect
                                state={rowState}
                                sourceBranchItems={sourceBranchItems}
                                checkoutBranchItems={checkoutBranchItems}
                                worktreeItems={worktreeItems}
                                onOpen={() =>
                                  void loadGitOptionsForPath(
                                    workspace.path,
                                    rowKey,
                                  )
                                }
                                onUpdate={(partial) =>
                                  updateRowState(rowKey, partial)
                                }
                              />
                            )}
                          </span>
                        </div>
                        <span
                          className="truncate text-subtle-foreground text-xs leading-normal"
                          dir="rtl"
                        >
                          <span dir="ltr">{workspace.path}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {connectError && (
                <div className="px-2.5 py-1 text-error-foreground text-xs">
                  {connectError}
                </div>
              )}

              <button
                type="button"
                data-connect-new-row=""
                onFocus={() => setFocusedRowKey(CONNECT_NEW_KEY)}
                onClick={(e) => {
                  e.stopPropagation();
                  const state = getOrInitState(CONNECT_NEW_KEY);
                  void commitConnect(CONNECT_NEW_KEY, state);
                }}
                disabled={pendingRowKey !== null}
                className={cn(
                  'group/connect-row flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-foreground text-xs',
                  'hover:bg-hover-derived',
                  'focus-visible:bg-hover-derived focus-visible:outline-none',
                  'disabled:pointer-events-none disabled:opacity-50',
                )}
              >
                <IconPlusFill18 className="size-3.5 shrink-0" />
                <span>Connect new workspace</span>
              </button>
            </PopoverBase.Popup>
          </PopoverBase.Positioner>
        </PopoverBase.Portal>
      </Popover>
    );
  },
);
