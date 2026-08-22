import type { KartonContract } from '@shared/karton-contracts/ui';

import {
  IconArrowUpRightOutline18,
  IconBranchOutOutline18,
  IconChevronDownFill18,
  IconChevronRightOutline18,
  IconCodeBranchOutline18,
  IconCopyOutline18,
  IconFolder5Outline18,
  IconFolderOpenOutline18,
  IconPenDrawSparkleOutline18,
  IconSquareTerminalOutline18,
  IconXmarkFill18,
} from '@clodex/icons';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import { Popover as PopoverBase } from '@base-ui/react/popover';
import { Popover, PopoverTrigger } from '@clodex/stage-ui/components/popover';
import { Switch } from '@clodex/stage-ui/components/switch';
import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import { cn } from '@clodex/stage-ui/lib/utils';
import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react';

import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useScrollFadeMask } from '@ui/hooks/use-scroll-fade-mask';

import { nativeFileManagerLabel } from '@ui/utils';

import { FileContextMenu } from '@ui/components/file-context-menu';
import { getWorkspaceDisplayInfo } from '@ui/utils/workspace-display';
import type {
  MountEntry,
  MountedWorkspaceGitStatusSummary,
  MountedWorkspaceGitSummary,
  WorkspaceGitSetupRun,
} from '@shared/karton-contracts/ui';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { useContentCollapsed } from '@ui/screens/main/_components/content-collapsed-context';
import { useTabUIState } from '@ui/hooks/use-tab-ui-state';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@clodex/stage-ui/components/button';

import {
  SetupRunSidePanel,
  WorkspaceSetupStatusIndicator,
} from './workspace-setup-status';

type KartonState = KartonContract['state'];
type KartonProcedures = KartonContract['serverProcedures'];

const EMPTY_SKILLS: string[] = [];

export function formatGitRef(git: MountedWorkspaceGitSummary): string | null {
  return git.branch ?? git.headSha?.slice(0, 7) ?? null;
}

export function formatGitStatus(
  status: MountedWorkspaceGitStatusSummary | null,
): string | null {
  if (!status?.dirty) return null;

  const parts = [
    status.stagedCount > 0 ? `+${status.stagedCount}` : null,
    status.unstagedCount > 0 ? `*${status.unstagedCount}` : null,
    status.untrackedCount > 0 ? `!${status.untrackedCount}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : null;
}

export const WorkspaceBadge = memo(function WorkspaceBadge({
  mount,
  onUnmount,
  agentInstanceId,
}: {
  mount: MountEntry;
  onUnmount: (prefix: string) => void;
  agentInstanceId: string;
}) {
  const display = getWorkspaceDisplayInfo(mount);
  const gitRef = mount.git ? formatGitRef(mount.git) : null;
  const setupRun = useKartonState(
    (s: KartonState) => s.workspaceGitSetup.runsByPath[mount.path],
  );
  const [open, setOpen] = useState(false);
  const [seenSucceededSetupRunIds, setSeenSucceededSetupRunIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const showSucceededSetupReceipt =
    setupRun?.status === 'succeeded' &&
    !seenSucceededSetupRunIds.has(setupRun.id);
  const showSetupRunDetails =
    setupRun?.status === 'running' ||
    setupRun?.status === 'failed' ||
    showSucceededSetupReceipt;

  const respectAgentsMd = useKartonState(
    (s: KartonState) =>
      s.preferences?.agent?.workspaceSettings?.[mount.path]?.respectAgentsMd ??
      false,
  );
  const preferences = useKartonState((s: KartonState) => s.preferences);
  const preferencesUpdate = useKartonProcedure(
    (p: KartonProcedures) => p.preferences.update,
  );
  const generateWorkspaceMd = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.generateWorkspaceMd,
  );

  const isGeneratingWorkspaceMd = useKartonState((s: KartonState) => {
    for (const id in s.agents.instances) {
      const inst = s.agents.instances[id];
      if (!inst) continue;
      if (inst.type !== AgentTypes.WORKSPACE_MD) continue;
      if (!inst.state.isWorking) continue;
      const agentPath = s.toolbox[id]?.workspace?.mounts?.[0]?.path;
      if (agentPath === mount.path) return true;
    }
    return false;
  });

  const handleGenerateWorkspaceMd = useCallback(() => {
    void generateWorkspaceMd(agentInstanceId, mount.prefix);
  }, [agentInstanceId, mount.prefix, generateWorkspaceMd]);

  const handleToggleAgentsMd = useCallback(
    (checked: boolean) => {
      const currentSettings =
        preferences?.agent?.workspaceSettings?.[mount.path];
      const patches = currentSettings
        ? [
            {
              op: 'replace' as const,
              path: [
                'agent',
                'workspaceSettings',
                mount.path,
                'respectAgentsMd',
              ],
              value: checked,
            },
          ]
        : [
            {
              op: 'add' as const,
              path: ['agent', 'workspaceSettings', mount.path],
              value: { respectAgentsMd: checked },
            },
          ];
      void preferencesUpdate(patches);
    },
    [mount.path, preferences, preferencesUpdate],
  );

  const disabledSkills = useKartonState(
    (s: KartonState) =>
      s.preferences?.agent?.workspaceSettings?.[mount.path]?.disabledSkills ??
      EMPTY_SKILLS,
  );

  const handleToggleSkill = useCallback(
    (skillName: string, enabled: boolean) => {
      const currentSettings =
        preferences?.agent?.workspaceSettings?.[mount.path];
      const current = currentSettings?.disabledSkills ?? [];
      const next = enabled
        ? current.filter((s: string) => s !== skillName)
        : [...current, skillName];

      const patches = currentSettings
        ? [
            {
              op: 'replace' as const,
              path: [
                'agent',
                'workspaceSettings',
                mount.path,
                'disabledSkills',
              ],
              value: next,
            },
          ]
        : [
            {
              op: 'add' as const,
              path: ['agent', 'workspaceSettings', mount.path],
              value: { respectAgentsMd: false, disabledSkills: next },
            },
          ];
      void preferencesUpdate(patches);
    },
    [mount.path, preferences, preferencesUpdate],
  );

  const resolveAbsolute = useCallback((p: string) => p, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const sidePanelRef = useRef<HTMLDivElement>(null);
  const [sidePanelContent, setSidePanelContent] =
    useState<SidePanelContent | null>(null);
  const [itemCenterY, setItemCenterY] = useState(0);
  const [sidePanelOffset, setSidePanelOffset] = useState(0);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Separate timer for the *initial* open of the side panel. The panel
  // would otherwise pop in instantly when the cursor passes over a row
  // on the way to other actions (e.g. "Create worktree"), which is
  // distracting. Once a panel is already shown, switches between rows
  // remain instant.
  const openTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cancelPendingClear = useCallback(() => {
    if (clearTimerRef.current !== undefined) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = undefined;
    }
  }, []);

  const cancelPendingOpen = useCallback(() => {
    if (openTimerRef.current !== undefined) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = undefined;
    }
  }, []);

  const scheduleClear = useCallback(() => {
    cancelPendingClear();
    cancelPendingOpen();
    clearTimerRef.current = setTimeout(() => {
      setSidePanelContent(null);
      clearTimerRef.current = undefined;
    }, 150);
  }, [cancelPendingClear, cancelPendingOpen]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) return;
      cancelPendingOpen();
      setSidePanelContent(null);
      if (setupRun?.status !== 'succeeded' || !showSucceededSetupReceipt) {
        return;
      }
      setSeenSucceededSetupRunIds((current) => {
        if (current.has(setupRun.id)) return current;
        return new Set([...Array.from(current), setupRun.id]);
      });
    },
    [cancelPendingOpen, setupRun, showSucceededSetupReceipt],
  );

  useEffect(
    () => () => {
      cancelPendingClear();
      cancelPendingOpen();
    },
    [cancelPendingClear, cancelPendingOpen],
  );

  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(
    null,
  );
  const scrollViewportRef = useMemo(
    () => ({ current: scrollViewport }),
    [scrollViewport],
  ) as React.RefObject<HTMLElement>;

  const { maskStyle } = useScrollFadeMask(scrollViewportRef, {
    axis: 'vertical',
    fadeDistance: 24,
  });

  const updateSidePanelOffset = useCallback(() => {
    if (!sidePanelContent || !sidePanelRef.current || !containerRef.current)
      return;
    const panelHeight = sidePanelRef.current.offsetHeight;
    const containerHeight = containerRef.current.offsetHeight;

    let offset = itemCenterY - panelHeight / 2;
    offset = Math.max(0, offset);
    offset = Math.min(offset, containerHeight - panelHeight);

    setSidePanelOffset(offset);
  }, [sidePanelContent, itemCenterY]);

  useLayoutEffect(() => {
    updateSidePanelOffset();
  }, [updateSidePanelOffset]);

  useEffect(() => {
    if (!sidePanelContent || !sidePanelRef.current || !containerRef.current)
      return;

    const observer = new ResizeObserver(() => {
      updateSidePanelOffset();
    });
    observer.observe(sidePanelRef.current);
    observer.observe(containerRef.current);
    updateSidePanelOffset();

    return () => observer.disconnect();
  }, [sidePanelContent, updateSidePanelOffset]);

  const handleItemHover = useCallback(
    (content: SidePanelContent, event: React.MouseEvent<HTMLElement>) => {
      cancelPendingClear();
      cancelPendingOpen();
      const target = event.currentTarget;
      const container = containerRef.current;

      const apply = () => {
        if (!container) {
          setSidePanelContent(content);
          return;
        }
        const containerRect = container.getBoundingClientRect();
        const itemRect = target.getBoundingClientRect();
        const centerY = itemRect.top + itemRect.height / 2 - containerRect.top;
        setItemCenterY(centerY);
        setSidePanelContent(content);
      };

      // Switching between rows once a panel is open is instant; the
      // very first open is delayed so quick traversals don't trigger
      // the side panel.
      if (sidePanelContent) {
        apply();
      } else {
        openTimerRef.current = setTimeout(() => {
          openTimerRef.current = undefined;
          apply();
        }, 200);
      }
    },
    [cancelPendingClear, cancelPendingOpen, sidePanelContent],
  );

  const unmountIcon = (
    <Tooltip>
      <TooltipTrigger>
        <span
          data-unmount
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onUnmount(mount.prefix);
          }}
          className={cn(
            'group/unmount relative flex size-4 shrink-0 cursor-pointer items-center justify-center',
          )}
        >
          {/*
            Match the action-selector trigger icon vocabulary so the
            post-message badge reads the same way: worktree icon when
            the mount is a git worktree, branch icon for a plain
            repo, folder otherwise.
          */}
          {mount.git?.isWorktree ? (
            <IconBranchOutOutline18 className="size-3 shrink-0 group-hover/workspace:opacity-0 group-focus-visible/workspace:opacity-0" />
          ) : mount.git ? (
            <IconCodeBranchOutline18 className="size-3 shrink-0 group-hover/workspace:opacity-0 group-focus-visible/workspace:opacity-0" />
          ) : (
            <IconFolder5Outline18 className="size-3 shrink-0 group-hover/workspace:opacity-0 group-focus-visible/workspace:opacity-0" />
          )}
          <IconXmarkFill18 className="absolute size-3 text-muted-foreground opacity-0 group-hover/unmount:text-foreground group-hover/workspace:opacity-100 group-focus-visible/workspace:opacity-100" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Disconnect workspace</TooltipContent>
    </Tooltip>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <FileContextMenu relativePath={mount.path} resolvePath={resolveAbsolute}>
        <PopoverTrigger>
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              'group/workspace max-w-56 justify-start gap-1 px-0',
              'text-muted-foreground hover:text-muted-foreground',
              'focus-visible:text-foreground',
              'has-[[data-popup-open]]:text-foreground',
            )}
          >
            {unmountIcon}
            <span className="min-w-0 truncate group-hover/workspace:text-foreground group-focus-visible/workspace:text-foreground group-has-[[data-unmount]:hover]/workspace:text-muted-foreground">
              {display.title}
            </span>
            {gitRef && (
              <span className="min-w-0 truncate text-subtle-foreground group-hover/workspace:text-muted-foreground group-focus-visible/workspace:text-muted-foreground group-has-[[data-unmount]:hover]/workspace:text-subtle-foreground">
                {gitRef}
              </span>
            )}
            <WorkspaceSetupStatusIndicator
              setupRun={setupRun}
              failedClassName="text-muted-foreground group-hover/workspace:text-foreground group-focus-visible/workspace:text-foreground group-has-[[data-unmount]:hover]/workspace:text-muted-foreground"
            />
            <IconChevronDownFill18 className="size-3 shrink-0 text-subtle-foreground group-hover/workspace:text-muted-foreground group-focus-visible/workspace:text-muted-foreground group-has-[[data-unmount]:hover]/workspace:text-subtle-foreground" />
          </Button>
        </PopoverTrigger>
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
          <div
            ref={containerRef}
            className="relative flex flex-row items-start gap-1"
            onMouseLeave={scheduleClear}
          >
            <PopoverBase.Popup
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'flex min-w-72 max-w-[28rem] flex-col gap-0 p-0',
                'rounded-lg bg-background ring-1 ring-border-subtle',
                'text-foreground shadow-lg',
                'transition-[transform,scale,opacity] duration-150 ease-out',
                'origin-(--transform-origin)',
                'data-ending-style:scale-90 data-starting-style:scale-90',
                'data-ending-style:opacity-0 data-starting-style:opacity-0',
              )}
            >
              <WorkspacePreviewCardContent
                mount={mount}
                name={display.label}
                setupRun={setupRun}
                showSetupRunDetails={showSetupRunDetails}
                onItemHover={handleItemHover}
                onItemLeave={cancelPendingOpen}
                activeRow={
                  sidePanelContent?.type === 'contextFiles'
                    ? 'contextFiles'
                    : sidePanelContent?.type === 'skillsList'
                      ? 'skillsList'
                      : sidePanelContent?.type === 'setupRun'
                        ? 'setupRun'
                        : null
                }
              />
            </PopoverBase.Popup>

            {sidePanelContent && (
              <div
                ref={sidePanelRef}
                onMouseEnter={cancelPendingClear}
                className={cn(
                  'absolute left-full ml-1 flex w-72 flex-col rounded-lg border border-derived bg-background text-foreground text-xs shadow-lg transition-[top] duration-100 ease-out',
                  'fade-in-0 slide-in-from-left-1 animate-in duration-150',
                  'p-0',
                )}
                style={{ top: sidePanelOffset }}
              >
                {sidePanelContent.type === 'workspaceMd' ||
                sidePanelContent.type === 'agentsMd' ? (
                  <MdSidePanelContent
                    sidePanelContent={sidePanelContent}
                    isIncludedInAgentContext={
                      sidePanelContent.type === 'agentsMd'
                        ? respectAgentsMd
                        : true
                    }
                    maskStyle={maskStyle}
                    onViewportRef={setScrollViewport}
                  />
                ) : sidePanelContent.type === 'contextFiles' ? (
                  <ContextFilesSidePanel
                    mount={mount}
                    name={display.label}
                    respectAgentsMd={respectAgentsMd}
                    onToggleAgentsMd={handleToggleAgentsMd}
                    isGeneratingWorkspaceMd={isGeneratingWorkspaceMd}
                    onGenerateWorkspaceMd={handleGenerateWorkspaceMd}
                  />
                ) : sidePanelContent.type === 'setupRun' && setupRun ? (
                  <SetupRunSidePanel setupRun={setupRun} />
                ) : (
                  <SkillsListSidePanel
                    skills={mount.skills}
                    disabledSkills={disabledSkills}
                    onToggleSkill={handleToggleSkill}
                  />
                )}
              </div>
            )}
          </div>
        </PopoverBase.Positioner>
      </PopoverBase.Portal>
    </Popover>
  );
});

export function MdSidePanelContent({
  sidePanelContent,
  maskStyle,
  onViewportRef,
  isIncludedInAgentContext,
}: {
  sidePanelContent: Extract<
    SidePanelContent,
    { type: 'workspaceMd' | 'agentsMd' }
  >;
  maskStyle: React.CSSProperties;
  onViewportRef: (el: HTMLElement | null) => void;
  isIncludedInAgentContext: boolean;
}) {
  const openFileTab = useKartonProcedure((p) => p.fileTree.openFileTab);
  const filePath =
    sidePanelContent.type === 'workspaceMd'
      ? '.clodex/WORKSPACE.md'
      : 'AGENTS.md';

  return (
    <>
      <div
        className={cn(
          'border-derived-subtle border-b px-2.5 py-2',
          !isIncludedInAgentContext && 'opacity-60',
        )}
      >
        <span className="font-semibold">
          {sidePanelContent.type === 'workspaceMd'
            ? 'WORKSPACE.md'
            : 'AGENTS.md'}
        </span>
      </div>
      <div
        className={cn(
          'relative overflow-hidden rounded-b-lg',
          !isIncludedInAgentContext && 'opacity-60',
        )}
      >
        <OverlayScrollbar
          className="mask-alpha max-h-64"
          style={
            {
              ...maskStyle,
              '--os-scrollbar-inset-top': '8px',
              '--os-scrollbar-inset-bottom': '24px',
            } as React.CSSProperties
          }
          options={{ overflow: { x: 'hidden', y: 'scroll' } }}
          onViewportRef={onViewportRef}
        >
          <pre className="wrap-break-word whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] text-muted-foreground leading-relaxed">
            {sidePanelContent.content}
          </pre>
        </OverlayScrollbar>
        <button
          type="button"
          onClick={() => {
            void openFileTab(sidePanelContent.workspacePath, filePath);
          }}
          className="absolute right-0 bottom-0 flex h-6 items-center gap-1 rounded-tl-lg border-derived border-t border-l bg-background px-2 py-1 text-muted-foreground text-xs hover:bg-muted hover:text-foreground dark:bg-surface-1"
        >
          <IconArrowUpRightOutline18 className="size-3" />
          <span>Open in file view</span>
        </button>
      </div>
    </>
  );
}

export type SidePanelContent =
  | { type: 'workspaceMd'; content: string; workspacePath: string }
  | { type: 'agentsMd'; content: string; workspacePath: string }
  | { type: 'contextFiles' }
  | { type: 'skillsList' }
  | { type: 'setupRun' };

export function ContextFilesSidePanel({
  mount,
  name,
  respectAgentsMd,
  onToggleAgentsMd,
  isGeneratingWorkspaceMd,
  onGenerateWorkspaceMd,
}: {
  mount: MountEntry;
  name: string;
  respectAgentsMd: boolean;
  onToggleAgentsMd: (checked: boolean) => void;
  isGeneratingWorkspaceMd: boolean;
  onGenerateWorkspaceMd: () => void;
}) {
  const agentsMdDisabled = mount.agentsMdContent === null;
  const [hoveredContextFile, setHoveredContextFile] = useState<Extract<
    SidePanelContent,
    { type: 'workspaceMd' | 'agentsMd' }
  > | null>(null);
  const [nestedPanelOffset, setNestedPanelOffset] = useState(0);
  const workspaceMdRowRef = useRef<HTMLDivElement>(null);
  const agentsMdRowRef = useRef<HTMLDivElement>(null);
  const nestedPanelRef = useRef<HTMLDivElement>(null);
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(
    null,
  );
  const scrollViewportRef = useMemo(
    () => ({ current: scrollViewport }),
    [scrollViewport],
  ) as React.RefObject<HTMLElement>;
  const { maskStyle } = useScrollFadeMask(scrollViewportRef, {
    axis: 'vertical',
    fadeDistance: 16,
  });

  useLayoutEffect(() => {
    if (!hoveredContextFile) return;
    const itemEl =
      hoveredContextFile.type === 'workspaceMd'
        ? workspaceMdRowRef.current
        : agentsMdRowRef.current;
    const panel = nestedPanelRef.current;
    if (!itemEl || !panel) return;

    const containerHeight = itemEl.parentElement?.offsetHeight ?? 0;
    const itemCenterY = itemEl.offsetTop + itemEl.offsetHeight / 2;
    const panelHeight = panel.offsetHeight;

    let offset = itemCenterY - panelHeight / 2;
    offset = Math.max(0, offset);
    offset = Math.min(offset, containerHeight - panelHeight);

    setNestedPanelOffset(offset);
  }, [hoveredContextFile]);

  return (
    <>
      <div className="border-derived-subtle border-b px-2.5 py-2">
        <span className="font-semibold">Context files</span>
      </div>
      <div
        className="relative flex flex-col gap-1 px-2.5 py-2"
        onMouseLeave={() => setHoveredContextFile(null)}
      >
        {/* WORKSPACE.md row */}
        <div
          ref={workspaceMdRowRef}
          className="flex items-center gap-1.5"
          onMouseEnter={
            mount.workspaceMdContent
              ? () =>
                  setHoveredContextFile({
                    type: 'workspaceMd',
                    content: mount.workspaceMdContent!,
                    workspacePath: mount.path,
                  })
              : undefined
          }
        >
          {mount.workspaceMdContent !== null ? (
            <>
              <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="flex-1 px-0 text-muted-foreground text-xs">
                WORKSPACE.md
              </span>
            </>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger>
                  <span className="inline-flex items-center gap-1.5 text-subtle-foreground">
                    <XIcon className="size-3 shrink-0" />
                    <span className="text-xs">WORKSPACE.md</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  No WORKSPACE.md available for {name}.
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-auto shrink-0 pr-0.5"
                    disabled={isGeneratingWorkspaceMd}
                    onClick={(e) => {
                      e.stopPropagation();
                      onGenerateWorkspaceMd();
                    }}
                  >
                    {isGeneratingWorkspaceMd ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <IconPenDrawSparkleOutline18 className="size-3" />
                    )}
                    {isGeneratingWorkspaceMd ? 'Generating...' : 'Generate'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Automatically generate a WORKSPACE.md to improve agent
                  performance.
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        {/* AGENTS.md toggle */}
        {mount.agentsMdContent !== null && (
          <Tooltip>
            <TooltipTrigger>
              <div
                ref={agentsMdRowRef}
                className="flex items-center gap-1.5"
                onMouseEnter={
                  mount.agentsMdContent
                    ? () =>
                        setHoveredContextFile({
                          type: 'agentsMd',
                          content: mount.agentsMdContent!,
                          workspacePath: mount.path,
                        })
                    : undefined
                }
              >
                {respectAgentsMd ? (
                  <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <XIcon className="size-3 shrink-0 text-subtle-foreground" />
                )}
                <label
                  htmlFor="agents-md-toggle"
                  className={cn(
                    'flex-1 px-0 text-xs',
                    respectAgentsMd
                      ? 'text-muted-foreground'
                      : 'text-subtle-foreground',
                  )}
                >
                  AGENTS.md
                </label>
                <div onClick={(e) => e.stopPropagation()}>
                  <Switch
                    size="xs"
                    id="agents-md-toggle"
                    checked={respectAgentsMd}
                    onCheckedChange={onToggleAgentsMd}
                    disabled={agentsMdDisabled}
                  />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {respectAgentsMd
                ? 'Included in agent context'
                : 'Not included in agent context'}
            </TooltipContent>
          </Tooltip>
        )}

        {hoveredContextFile && (
          <div
            ref={nestedPanelRef}
            className={cn(
              'absolute left-full z-10 ml-1 flex w-72 flex-col rounded-lg border border-derived bg-background text-foreground text-xs shadow-lg transition-[top] duration-100 ease-out',
              'fade-in-0 slide-in-from-left-1 animate-in duration-150',
            )}
            style={{ top: nestedPanelOffset }}
          >
            <MdSidePanelContent
              sidePanelContent={hoveredContextFile}
              isIncludedInAgentContext={
                hoveredContextFile.type === 'agentsMd' ? respectAgentsMd : true
              }
              maskStyle={maskStyle}
              onViewportRef={setScrollViewport}
            />
          </div>
        )}
      </div>
    </>
  );
}

export function SkillsListSidePanel({
  skills,
  disabledSkills,
  onToggleSkill,
}: {
  skills: MountEntry['skills'];
  disabledSkills: string[];
  onToggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  const sortedSkills = useMemo(
    () => [...skills].sort((a, b) => a.name.localeCompare(b.name)),
    [skills],
  );

  const [hoveredSkillName, setHoveredSkillName] = useState<string | null>(null);
  const [nestedPanelOffset, setNestedPanelOffset] = useState(0);
  const itemRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const nestedPanelRef = useRef<HTMLDivElement>(null);
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(
    null,
  );
  const scrollViewportRef = useMemo(
    () => ({ current: scrollViewport }),
    [scrollViewport],
  ) as React.RefObject<HTMLElement>;
  const { maskStyle } = useScrollFadeMask(scrollViewportRef, {
    axis: 'vertical',
    fadeDistance: 16,
  });

  // Position the third-level (skill description) panel relative to the
  // hovered skill row's vertical center, clamped to the scroll viewport.
  useLayoutEffect(() => {
    if (!hoveredSkillName) return;
    const itemEl = itemRefs.current.get(hoveredSkillName);
    const container = scrollViewport;
    const panel = nestedPanelRef.current;
    if (!itemEl || !container || !panel) return;

    const containerRect = container.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const centerY = itemRect.top + itemRect.height / 2 - containerRect.top;

    const panelHeight = panel.offsetHeight;
    const containerHeight = container.offsetHeight;

    let offset = centerY - panelHeight / 2;
    offset = Math.max(0, offset);
    offset = Math.min(offset, containerHeight - panelHeight);

    setNestedPanelOffset(offset);
  }, [hoveredSkillName, scrollViewport]);

  const hoveredSkill = hoveredSkillName
    ? sortedSkills.find((s) => s.name === hoveredSkillName)
    : undefined;

  return (
    <>
      <div className="border-derived-subtle border-b px-2.5 py-2">
        <span className="font-semibold">Skills</span>
      </div>
      <div className="relative">
        <OverlayScrollbar
          className="mask-alpha max-h-64"
          style={maskStyle}
          options={{ overflow: { x: 'hidden', y: 'scroll' } }}
          onViewportRef={setScrollViewport}
        >
          <div
            className="flex flex-col gap-0.75 px-2.5 py-2"
            onMouseLeave={() => setHoveredSkillName(null)}
          >
            {sortedSkills.map((skill) => {
              const isEnabled = !disabledSkills.includes(skill.name);
              const toggleId = `skill-toggle-${skill.name}`;
              return (
                <div
                  key={skill.name}
                  ref={(el) => {
                    itemRefs.current.set(skill.name, el);
                  }}
                  className="flex items-center gap-1.5"
                  onMouseEnter={() => setHoveredSkillName(skill.name)}
                >
                  <label
                    htmlFor={toggleId}
                    className={cn(
                      'flex-1 truncate text-xs leading-normal',
                      isEnabled
                        ? 'text-muted-foreground'
                        : 'text-subtle-foreground',
                    )}
                  >
                    {skill.name}
                  </label>
                  <Tooltip>
                    <TooltipTrigger>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Switch
                          size="xs"
                          id={toggleId}
                          checked={isEnabled}
                          onCheckedChange={(checked) =>
                            onToggleSkill(skill.name, checked)
                          }
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isEnabled
                        ? `${skill.name} is included in agent context`
                        : `Include ${skill.name} in agent context`}
                    </TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </OverlayScrollbar>
        {hoveredSkill && (
          <div
            ref={nestedPanelRef}
            className={cn(
              'absolute left-full ml-1 flex w-64 flex-col gap-1 rounded-lg border border-derived bg-background p-2.5 text-foreground text-xs shadow-lg transition-[top] duration-100 ease-out',
              'fade-in-0 slide-in-from-left-1 animate-in duration-150',
              disabledSkills.includes(hoveredSkill.name) && 'opacity-60',
            )}
            style={{ top: nestedPanelOffset }}
          >
            <div className="font-semibold">{hoveredSkill.name}</div>
            <div className="text-muted-foreground">
              {hoveredSkill.description}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export function WorkspacePreviewCardContent({
  mount,
  name,
  setupRun,
  showSetupRunDetails,
  onItemHover,
  onItemLeave,
  activeRow,
}: {
  mount: MountEntry;
  name: string;
  setupRun?: WorkspaceGitSetupRun;
  showSetupRunDetails: boolean;
  onItemHover: (
    content: SidePanelContent,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  /** Cancels a pending open if the cursor leaves the row before the
   * open delay elapses. */
  onItemLeave: () => void;
  activeRow: 'contextFiles' | 'skillsList' | 'setupRun' | null;
}) {
  const hasSkills = mount.skills.length > 0;
  const gitRef = mount.git ? formatGitRef(mount.git) : null;
  const gitStatus = mount.git ? formatGitStatus(mount.git.status) : null;
  const [openAgent] = useOpenAgent();
  const createTerminal = useKartonProcedure(
    (p: KartonProcedures) => p.browser.createTerminal,
  );
  const copyText = useKartonProcedure(
    (p: KartonProcedures) => p.browser.copyText,
  );
  const { collapsed: contentCollapsed, setCollapsed: setContentCollapsed } =
    useContentCollapsed();
  const { requestTerminalFocus } = useTabUIState();
  const setupTitle = setupRun
    ? setupRun.status === 'running'
      ? 'Worktree setup running'
      : setupRun.status === 'failed'
        ? 'Worktree setup failed'
        : 'Worktree setup done'
    : null;

  const handleCopyPath = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      // Route through the main process: the renderer's `navigator.clipboard`
      // rejects when focus is inside a web-content view, which silently
      // dropped the copy here.
      void copyText(mount.path);
    },
    [mount.path, copyText],
  );

  const handleOpenTerminal = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      if (contentCollapsed) setContentCollapsed(false);
      void createTerminal(mount.path, openAgent).then((terminalId) => {
        if (terminalId) requestTerminalFocus(terminalId);
      });
    },
    [
      mount.path,
      openAgent,
      createTerminal,
      contentCollapsed,
      setContentCollapsed,
      requestTerminalFocus,
    ],
  );

  const handleRevealInFileManager = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      window.open(
        `clodex://reveal-file/${encodeURIComponent(mount.path)}`,
        '_blank',
      );
    },
    [mount.path],
  );

  return (
    <div className="flex flex-col">
      {/* Header: folder name + git branch + path */}
      <div className="flex flex-col items-start gap-0.5 px-2.5 pt-1.5 pb-2">
        <div className="flex max-w-full items-center gap-1.5 text-xs leading-none">
          <span className="min-w-0 truncate font-semibold text-foreground">
            {name}
          </span>
          {mount.git && gitRef && (
            <>
              {/* Match the WorkspaceBadge icon vocabulary so the header label
                  reads consistently across surfaces: worktree icon when this
                  mount is a git worktree, branch icon for a plain repo. */}
              {mount.git.isWorktree ? (
                <IconBranchOutOutline18 className="size-3 shrink-0 text-subtle-foreground" />
              ) : (
                <IconCodeBranchOutline18 className="size-3 shrink-0 text-subtle-foreground" />
              )}
              <span className="max-w-36 shrink-0 truncate text-2xs text-subtle-foreground leading-none">
                {gitRef}
              </span>
            </>
          )}
          {gitStatus && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums leading-none">
              {gitStatus}
            </span>
          )}
        </div>
        <span
          className="max-w-full truncate text-2xs text-subtle-foreground leading-normal"
          dir="rtl"
        >
          <span dir="ltr">{mount.path}</span>
        </span>
      </div>

      <div className="mx-2.5 border-border-subtle border-t" />

      {setupRun && showSetupRunDetails && setupTitle && (
        <div
          data-active={activeRow === 'setupRun' ? '' : undefined}
          className={cn(
            'group/row flex cursor-default items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground',
            'hover:text-foreground data-[active]:text-foreground',
            setupRun.status === 'succeeded' &&
              'text-subtle-foreground hover:text-muted-foreground data-[active]:text-muted-foreground',
          )}
          onMouseEnter={(e) => onItemHover({ type: 'setupRun' }, e)}
          onMouseLeave={onItemLeave}
        >
          <span className="min-w-0 flex-1 truncate font-medium text-xs">
            {setupTitle}
          </span>
          <IconChevronRightOutline18 className="ml-auto size-3 shrink-0" />
        </div>
      )}

      {/* Context files row — opens side panel on hover */}
      <div
        data-active={activeRow === 'contextFiles' ? '' : undefined}
        className={cn(
          'group/row flex cursor-default items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground',
          'hover:text-foreground data-[active]:text-foreground',
        )}
        onMouseEnter={(e) => onItemHover({ type: 'contextFiles' }, e)}
        onMouseLeave={onItemLeave}
      >
        <span className="font-medium text-xs">Context files</span>
        <IconChevronRightOutline18 className="ml-auto size-3 shrink-0" />
      </div>

      {/* Skills row — opens side panel on hover */}
      {hasSkills && (
        <div
          data-active={activeRow === 'skillsList' ? '' : undefined}
          className={cn(
            'group/row flex cursor-default items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground',
            'hover:text-foreground data-[active]:text-foreground',
          )}
          onMouseEnter={(e) => onItemHover({ type: 'skillsList' }, e)}
          onMouseLeave={onItemLeave}
        >
          <span className="font-medium text-xs">Skills</span>
          <IconChevronRightOutline18 className="ml-auto size-3 shrink-0" />
        </div>
      )}

      <div className="flex justify-end gap-1.5 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-2xs"
              aria-label="Open terminal"
              onClick={handleOpenTerminal}
              className="text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <IconSquareTerminalOutline18 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open terminal</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-2xs"
              aria-label={`Reveal in ${nativeFileManagerLabel}`}
              onClick={handleRevealInFileManager}
              className="text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <IconFolderOpenOutline18 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reveal in {nativeFileManagerLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-2xs"
              aria-label="Copy path"
              onClick={handleCopyPath}
              className="text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <IconCopyOutline18 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy path</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
