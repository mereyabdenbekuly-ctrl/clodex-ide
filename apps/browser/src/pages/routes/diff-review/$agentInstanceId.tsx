import { createFileRoute } from '@tanstack/react-router';
import {
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
  type FC,
} from 'react';
import {
  Loader2Icon,
  ChevronDownIcon,
  CheckIcon,
  XIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FilesIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
} from 'lucide-react';
import {
  useKartonProcedure,
  useKartonConnected,
  useKartonState,
} from '@pages/hooks/use-karton';
import { DiffPreview } from '@ui/screens/main/agent-chat/chat/_components/message-part-ui/tools/shared/diff-preview';
import { FileIcon } from '@ui/components/file-icon';
import type { FileDiff } from '@shared/karton-contracts/ui/shared-types';
import {
  type FormattedFileDiff,
  getLineStats,
} from '@ui/screens/main/agent-chat/chat/_components/footer-status-card/shared';
import { ExternalFilePreview } from './_components/external-file-preview';
import { getBaseName } from '@shared/path-utils';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@clodex/stage-ui/components/collapsible';
import { Button } from '@clodex/stage-ui/components/button';
import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import { cn, stripMountPrefix } from '@ui/utils';
import { IconArrowUpRightOutline18 } from 'nucleo-ui-outline-18';

export const Route = createFileRoute('/diff-review/$agentInstanceId')({
  component: Page,
  head: () => ({
    meta: [
      {
        title: 'Review changes',
      },
    ],
  }),
});

type FormattedFileDiffWithElementId = FormattedFileDiff & { elementId: string };

const FileDiffItem: FC<{
  edit: FormattedFileDiffWithElementId;
  compactDiff: boolean;
  isOpen: boolean;
  isTargeted: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: (fileId: string) => void;
  onReject: (fileId: string) => void;
}> = ({
  edit,
  compactDiff,
  isOpen,
  isTargeted,
  onOpenChange,
  onAccept,
  onReject,
}) => {
  const { added, removed } = getLineStats(edit);
  const toRelativePath = useCallback(
    (absPath: string) => stripMountPrefix(absPath),
    [],
  );
  const handleOpenInTab = useCallback(() => {
    window.open(
      `clodex://reveal-file/${encodeURIComponent(edit.path)}`,
      '_blank',
    );
  }, [edit.path]);

  return (
    <div
      id={edit.elementId}
      className="codex-review-card scroll-mt-16 overflow-hidden border"
      data-targeted={isTargeted}
    >
      <Collapsible open={isOpen} onOpenChange={onOpenChange} className="w-full">
        <CollapsibleTrigger
          size="condensed"
          render={<div />}
          className="group w-full cursor-pointer p-0 has-[button:hover]:text-token-text-secondary"
        >
          {/* File header */}
          <div
            className={`flex min-h-10 w-full items-center gap-2 bg-token-main-surface-primary px-3 ${
              isOpen ? 'border-token-border-light border-b' : ''
            }`}
          >
            <FileIcon filePath={edit.fileName} className="size-4 shrink-0" />
            <Tooltip>
              <TooltipTrigger>
                <button
                  type="button"
                  className="min-w-0 cursor-pointer truncate font-medium text-sm text-token-text-primary group-hover:text-token-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenInTab();
                  }}
                >
                  {edit.fileName}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <div className="max-w-md">
                  {toRelativePath(edit.path) ?? edit.path}
                </div>
              </TooltipContent>
            </Tooltip>
            {edit.isExternal && edit.changeType === 'created' && (
              <span className="shrink-0 rounded-full bg-success-foreground/10 px-1.5 py-0.5 text-[10px] text-success-foreground">
                new
              </span>
            )}
            {edit.isExternal && edit.changeType === 'deleted' && (
              <span className="shrink-0 rounded-full bg-error-foreground/10 px-1.5 py-0.5 text-[10px] text-error-foreground">
                deleted
              </span>
            )}
            {edit.isExternal && edit.changeType === 'modified' && (
              <span className="shrink-0 rounded-full bg-token-bg-tertiary px-1.5 py-0.5 text-[10px] text-token-text-secondary">
                modified
              </span>
            )}
            {added > 0 && (
              <span className="shrink-0 text-success-foreground text-xs">
                +{added}
              </span>
            )}
            {removed > 0 && (
              <span className="shrink-0 text-error-foreground text-xs">
                -{removed}
              </span>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="size-7 cursor-pointer rounded-full p-0 hover:bg-error-foreground/10 hover:text-error-foreground"
                    aria-label={`Reject ${edit.fileName}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReject(edit.fileId);
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reject this file</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="size-7 cursor-pointer rounded-full p-0 hover:bg-success-foreground/10 hover:text-success-foreground"
                    aria-label={`Accept ${edit.fileName}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAccept(edit.fileId);
                    }}
                  >
                    <CheckIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Accept this file</TooltipContent>
              </Tooltip>
              <ChevronDownIcon
                className={`ml-0.5 size-3.5 shrink-0 text-token-text-tertiary transition-transform ${
                  isOpen ? 'rotate-180' : ''
                }`}
              />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="relative">
          {/* Diff content */}
          <div className="overflow-hidden bg-token-bg-secondary/20">
            {edit.isExternal ? (
              <ExternalFilePreview fileDiff={edit} />
            ) : (
              <DiffPreview
                diff={edit.lineChanges}
                filePath={edit.path}
                collapsed={compactDiff}
              />
            )}
          </div>
          {/* Footer with open file action */}
          <div className="flex min-h-8 flex-row items-center justify-end rounded-b-[inherit] border-token-border-light border-t bg-token-bg-secondary/35 px-2 text-token-text-tertiary">
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 cursor-pointer rounded-full"
                  onClick={() => {
                    window.open(
                      `clodex://reveal-file/${encodeURIComponent(edit.path)}`,
                      '_blank',
                    );
                  }}
                >
                  <div className="flex flex-row items-center justify-center gap-1">
                    <IconArrowUpRightOutline18 className="size-3 shrink-0" />
                    <span className="text-xs">Open file</span>
                  </div>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <div className="flex max-w-96 flex-col gap-1">
                  <div className="break-all font-mono text-xs">
                    {toRelativePath(edit.path) ?? edit.path}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Click to see full file
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

function EmptyContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="codex-review-shell flex h-screen w-screen flex-col items-center justify-center px-4 text-token-text-primary">
      {children}
    </div>
  );
}

function Page() {
  const { agentInstanceId } = Route.useParams();
  const isConnected = useKartonConnected();
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filePanelOpen, setFilePanelOpen] = useState(true);
  const [compactDiff, setCompactDiff] = useState(true);
  const [openFileIds, setOpenFileIds] = useState<Set<string>>(new Set());
  const [targetFileId, setTargetFileId] = useState<string | null>(null);
  const initializedFileIdsRef = useRef<Set<string>>(new Set());
  const initializedEditsFingerprintRef = useRef<string | null>(null);

  // Subscribe to real-time state updates for pending edits
  const pendingEditsFromState = useKartonState(
    (s) => s.pendingEditsByAgentInstanceId[agentInstanceId] ?? null,
  );

  // Procedures for fetching and modifying edits
  const getPendingEdits = useKartonProcedure((p) => p.getPendingEdits);
  const acceptAllPendingEdits = useKartonProcedure(
    (p) => p.acceptAllPendingEdits,
  );
  const rejectAllPendingEdits = useKartonProcedure(
    (p) => p.rejectAllPendingEdits,
  );
  const acceptPendingEdit = useKartonProcedure((p) => p.acceptPendingEdit);
  const rejectPendingEdit = useKartonProcedure((p) => p.rejectPendingEdit);

  // Store refs for procedures to avoid stale closures
  const getPendingEditsRef = useRef(getPendingEdits);
  const acceptAllRef = useRef(acceptAllPendingEdits);
  const rejectAllRef = useRef(rejectAllPendingEdits);
  const acceptOneRef = useRef(acceptPendingEdit);
  const rejectOneRef = useRef(rejectPendingEdit);

  useEffect(() => {
    getPendingEditsRef.current = getPendingEdits;
    acceptAllRef.current = acceptAllPendingEdits;
    rejectAllRef.current = rejectAllPendingEdits;
    acceptOneRef.current = acceptPendingEdit;
    rejectOneRef.current = rejectPendingEdit;
  }, [
    getPendingEdits,
    acceptAllPendingEdits,
    rejectAllPendingEdits,
    acceptPendingEdit,
    rejectPendingEdit,
  ]);

  const [pendingEdits, setPendingEdits] = useState<FileDiff[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chatFound, setChatFound] = useState(true);

  // Sync state updates to local state
  useEffect(() => {
    if (pendingEditsFromState !== null) {
      setPendingEdits(pendingEditsFromState);
      setIsLoading(false);
      setChatFound(true);
    }
  }, [pendingEditsFromState]);

  // Initial fetch when connected (fallback for first load before state sync)
  useEffect(() => {
    if (!isConnected || !agentInstanceId) return;
    // If we already have state, don't fetch
    if (pendingEditsFromState !== null) return;

    let cancelled = false;

    async function fetchEdits() {
      setIsLoading(true);
      try {
        const result = await getPendingEditsRef.current(agentInstanceId);
        if (!cancelled) {
          setChatFound(result.found);
          setPendingEdits(result.edits);
          setIsLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch pending edits:', error);
          setChatFound(false);
          setIsLoading(false);
        }
      }
    }

    void fetchEdits();

    return () => {
      cancelled = true;
    };
  }, [isConnected, agentInstanceId, pendingEditsFromState]);

  // Handlers for accept/reject actions
  const handleAcceptAll = useCallback(() => {
    void acceptAllRef.current(agentInstanceId);
  }, [agentInstanceId]);

  const handleRejectAll = useCallback(() => {
    void rejectAllRef.current(agentInstanceId);
  }, [agentInstanceId]);

  const handleAcceptOne = useCallback(
    (fileId: string) => {
      void acceptOneRef.current(agentInstanceId, fileId);
    },
    [agentInstanceId],
  );

  const handleRejectOne = useCallback(
    (fileId: string) => {
      void rejectOneRef.current(agentInstanceId, fileId);
    },
    [agentInstanceId],
  );

  const formattedEdits = useMemo((): FormattedFileDiffWithElementId[] => {
    return pendingEdits.map((edit) => ({
      ...edit,
      fileName: getBaseName(edit.path),
      // Diff links use fileId in the URL fragment. Keep the DOM id aligned
      // with that contract so opening a specific file reliably scrolls to it.
      elementId: `file-${encodeURIComponent(edit.fileId)}`,
    }));
  }, [pendingEdits]);

  const filteredEdits = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return formattedEdits;

    return formattedEdits.filter((edit) => {
      const relativePath = stripMountPrefix(edit.path) ?? edit.path;
      return (
        edit.fileName.toLowerCase().includes(normalizedQuery) ||
        relativePath.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [formattedEdits, searchQuery]);

  const totalStats = useMemo(
    () =>
      formattedEdits.reduce(
        (stats, edit) => {
          const { added, removed } = getLineStats(edit);
          stats.added += added;
          stats.removed += removed;
          return stats;
        },
        { added: 0, removed: 0 },
      ),
    [formattedEdits],
  );

  const editsFingerprint = useMemo(
    () => formattedEdits.map((edit) => edit.fileId).join('|'),
    [formattedEdits],
  );

  useEffect(() => {
    if (initializedEditsFingerprintRef.current === editsFingerprint) return;

    const previousFileIds = initializedFileIdsRef.current;
    const nextFileIds = formattedEdits.map((edit) => edit.fileId);
    const nextFileIdSet = new Set(nextFileIds);
    const changedLines = totalStats.added + totalStats.removed;
    const shouldOpenAll = formattedEdits.length <= 25 && changedLines <= 2000;

    setOpenFileIds((current) => {
      if (previousFileIds.size === 0) {
        return new Set(
          shouldOpenAll
            ? nextFileIds
            : nextFileIds.length > 0
              ? [nextFileIds[0]!]
              : [],
        );
      }

      const next = new Set(
        [...current].filter((fileId) => nextFileIdSet.has(fileId)),
      );
      if (shouldOpenAll) {
        for (const fileId of nextFileIds) {
          if (!previousFileIds.has(fileId)) next.add(fileId);
        }
      }
      return next;
    });

    initializedFileIdsRef.current = nextFileIdSet;
    initializedEditsFingerprintRef.current = editsFingerprint;
  }, [editsFingerprint, formattedEdits, totalStats.added, totalStats.removed]);

  const scrollToFile = useCallback(
    (fileId: string, behavior: ScrollBehavior = 'smooth') => {
      const edit = formattedEdits.find((item) => item.fileId === fileId);
      const scrollContainer = scrollContainerRef.current;
      if (!edit || !scrollContainer) return;

      setTargetFileId(fileId);
      window.history.replaceState(null, '', `#${encodeURIComponent(fileId)}`);
      setOpenFileIds((current) => {
        if (current.has(fileId)) return current;
        const next = new Set(current);
        next.add(fileId);
        return next;
      });

      requestAnimationFrame(() => {
        const element = document.getElementById(edit.elementId);
        if (!element) return;
        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const relativeTop =
          elementRect.top - containerRect.top + scrollContainer.scrollTop - 12;

        scrollContainer.scrollTo({ top: relativeTop, behavior });
      });
    },
    [formattedEdits],
  );

  // Scroll to file if hash is present in URL
  useEffect(() => {
    if (isLoading || formattedEdits.length === 0) return;

    const hash = window.location.hash;
    if (!hash) return;

    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    // Current links use fileId. Path matching remains as a compatibility
    // fallback for older tabs that were opened before this contract changed.
    const target = decodeURIComponent(hash.slice(1));
    const targetEdit =
      formattedEdits.find((edit) => edit.fileId === target) ??
      formattedEdits.find((edit) => edit.path === target);
    if (!targetEdit) return;
    setTargetFileId(targetEdit.fileId);
    setOpenFileIds((current) => {
      if (current.has(targetEdit.fileId)) return current;
      const next = new Set(current);
      next.add(targetEdit.fileId);
      return next;
    });
    const element = document.getElementById(targetEdit.elementId);

    if (element) {
      // Use ResizeObserver to wait for the element to have actual content
      // (CodeBlock uses async Shiki highlighting which renders content later)
      let scrolled = false;
      const scrollToElement = () => {
        if (scrolled) return;
        scrolled = true;

        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const relativeTop =
          elementRect.top - containerRect.top + scrollContainer.scrollTop;

        scrollContainer.scrollTo({
          top: relativeTop,
          behavior: 'smooth',
        });
      };

      // Watch for size changes on the element (content loading)
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // Once the element has meaningful height, scroll to it
          if (entry.contentRect.height > 50) {
            resizeObserver.disconnect();
            scrollToElement();
          }
        }
      });

      resizeObserver.observe(element);

      // Fallback timeout in case content is already loaded or observer doesn't trigger
      const timeoutId = setTimeout(() => {
        resizeObserver.disconnect();
        scrollToElement();
      }, 500);

      return () => {
        resizeObserver.disconnect();
        clearTimeout(timeoutId);
      };
    }
  }, [isLoading, formattedEdits]);

  useEffect(() => {
    if (isLoading || formattedEdits.length === 0) return;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    let frame = 0;
    const updateActiveFile = () => {
      frame = 0;
      const containerTop = scrollContainer.getBoundingClientRect().top;
      let closest: { fileId: string; distance: number } | null = null;

      for (const edit of formattedEdits) {
        const element = document.getElementById(edit.elementId);
        if (!element) continue;
        const distance = Math.abs(
          element.getBoundingClientRect().top - containerTop - 12,
        );
        if (!closest || distance < closest.distance) {
          closest = { fileId: edit.fileId, distance };
        }
      }

      if (closest) setTargetFileId(closest.fileId);
    };

    const handleScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveFile);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    updateActiveFile();
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [isLoading, formattedEdits]);

  const allFilteredFilesOpen =
    filteredEdits.length > 0 &&
    filteredEdits.every((edit) => openFileIds.has(edit.fileId));

  const handleToggleAllFiles = useCallback(() => {
    setOpenFileIds((current) => {
      const allOpen =
        filteredEdits.length > 0 &&
        filteredEdits.every((edit) => current.has(edit.fileId));
      if (allOpen) {
        const visibleIds = new Set(filteredEdits.map((edit) => edit.fileId));
        return new Set([...current].filter((id) => !visibleIds.has(id)));
      }

      const next = new Set(current);
      for (const edit of filteredEdits) next.add(edit.fileId);
      return next;
    });
  }, [filteredEdits]);

  // Loading state while waiting for connection or fetching
  if (!isConnected || isLoading) {
    return (
      <EmptyContainer>
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </EmptyContainer>
    );
  }

  // No chat found
  if (!chatFound) {
    return (
      <EmptyContainer>
        <p className="text-muted-foreground text-sm">Chat not found</p>
      </EmptyContainer>
    );
  }

  // No pending edits
  if (pendingEdits.length === 0) {
    return (
      <EmptyContainer>
        <p className="text-muted-foreground text-sm">No pending changes</p>
      </EmptyContainer>
    );
  }

  return (
    <div className="codex-review-shell flex h-screen w-screen flex-col overflow-hidden text-token-text-primary">
      <header className="codex-review-toolbar z-20 flex min-h-12 shrink-0 items-center gap-2 border-b px-2.5 sm:px-4">
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-full"
              aria-label={
                filePanelOpen ? 'Hide changed files' : 'Show changed files'
              }
              aria-pressed={filePanelOpen}
              onClick={() => setFilePanelOpen((open) => !open)}
            >
              {filePanelOpen ? (
                <PanelLeftCloseIcon className="size-4" />
              ) : (
                <PanelLeftOpenIcon className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {filePanelOpen ? 'Hide changed files' : 'Show changed files'}
          </TooltipContent>
        </Tooltip>

        <div className="flex min-w-0 items-center gap-2">
          <FilesIcon className="hidden size-4 shrink-0 text-token-text-tertiary sm:block" />
          <h1 className="truncate font-semibold text-sm text-token-text-primary">
            Review changes
          </h1>
          <span className="hidden shrink-0 text-token-text-tertiary text-xs md:inline">
            {formattedEdits.length} file
            {formattedEdits.length !== 1 ? 's' : ''}
          </span>
          <span className="hidden shrink-0 items-center gap-1 font-mono text-xs tabular-nums lg:flex">
            {totalStats.added > 0 && (
              <span className="text-success-foreground">
                +{totalStats.added}
              </span>
            )}
            {totalStats.removed > 0 && (
              <span className="text-error-foreground">
                -{totalStats.removed}
              </span>
            )}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div className="hidden items-center rounded-lg border border-token-border-light bg-token-bg-secondary/50 p-0.5 sm:flex">
            <button
              type="button"
              className={cn(
                'h-6 rounded-md px-2 text-xs transition-colors',
                compactDiff
                  ? 'bg-token-main-surface-primary text-token-text-primary shadow-codex-sm'
                  : 'text-token-text-tertiary hover:text-token-text-primary',
              )}
              aria-pressed={compactDiff}
              onClick={() => setCompactDiff(true)}
            >
              Compact
            </button>
            <button
              type="button"
              className={cn(
                'h-6 rounded-md px-2 text-xs transition-colors',
                !compactDiff
                  ? 'bg-token-main-surface-primary text-token-text-primary shadow-codex-sm'
                  : 'text-token-text-tertiary hover:text-token-text-primary',
              )}
              aria-pressed={!compactDiff}
              onClick={() => setCompactDiff(false)}
            >
              Full
            </button>
          </div>

          <Tooltip>
            <TooltipTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full"
                aria-label={
                  allFilteredFilesOpen
                    ? 'Collapse all files'
                    : 'Expand all files'
                }
                onClick={handleToggleAllFiles}
              >
                {allFilteredFilesOpen ? (
                  <ChevronsDownUpIcon className="size-4" />
                ) : (
                  <ChevronsUpDownIcon className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {allFilteredFilesOpen ? 'Collapse all files' : 'Expand all files'}
            </TooltipContent>
          </Tooltip>

          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-2.5 text-token-text-secondary hover:bg-error-foreground/10 hover:text-error-foreground sm:px-3"
            aria-label="Reject all changes"
            onClick={handleRejectAll}
          >
            <XIcon className="size-3.5" />
            <span className="hidden sm:inline">Reject all</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="rounded-full border-codex-blue-400 bg-codex-blue-400 px-3 shadow-codex-sm hover:bg-codex-blue-500"
            onClick={handleAcceptAll}
          >
            <CheckIcon className="size-3.5" />
            <span className="hidden sm:inline">Accept all</span>
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {filePanelOpen && (
          <button
            type="button"
            aria-label="Close changed files"
            className="absolute inset-0 z-20 bg-black/20 backdrop-blur-[1px] md:hidden"
            onClick={() => setFilePanelOpen(false)}
          />
        )}
        {filePanelOpen && (
          <aside className="codex-review-sidebar absolute inset-y-0 left-0 z-30 flex w-[min(82vw,280px)] shrink-0 flex-col border-r shadow-codex-xl md:relative md:z-auto md:w-[280px] md:shadow-none">
            <div className="shrink-0 p-2.5">
              <div className="flex h-8 items-center gap-2 rounded-lg border border-token-border-light bg-token-main-surface-primary/60 px-2.5 focus-within:border-token-border-default">
                <SearchIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Filter changed files…"
                  aria-label="Filter changed files"
                  className="min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary"
                />
              </div>
            </div>
            <OverlayScrollbar
              className="min-h-0 flex-1"
              contentClassName="px-2 pb-3"
            >
              <div className="flex flex-col gap-0.5">
                {filteredEdits.map((edit) => {
                  const { added, removed } = getLineStats(edit);
                  const relativePath = stripMountPrefix(edit.path) ?? edit.path;
                  return (
                    <button
                      key={edit.fileId}
                      type="button"
                      aria-current={
                        targetFileId === edit.fileId ? 'true' : undefined
                      }
                      className={cn(
                        'flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                        targetFileId === edit.fileId
                          ? 'bg-token-list-hover-background text-token-text-primary'
                          : 'text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary',
                      )}
                      onClick={() => {
                        scrollToFile(edit.fileId);
                        if (window.innerWidth < 768) setFilePanelOpen(false);
                      }}
                      title={relativePath}
                    >
                      <FileIcon
                        filePath={edit.fileName}
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">
                          {edit.fileName}
                        </span>
                        <span className="block truncate text-[10px] text-token-text-tertiary">
                          {relativePath}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-1 font-mono text-[10px] tabular-nums">
                        {added > 0 && (
                          <span className="text-success-foreground">
                            +{added}
                          </span>
                        )}
                        {removed > 0 && (
                          <span className="text-error-foreground">
                            -{removed}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {filteredEdits.length === 0 && (
                  <div className="px-3 py-8 text-center text-token-text-tertiary text-xs">
                    No matching files
                  </div>
                )}
              </div>
            </OverlayScrollbar>
          </aside>
        )}

        <OverlayScrollbar
          onViewportRef={(element) => {
            scrollContainerRef.current = element;
          }}
          className="min-w-0 flex-1"
          contentClassName="px-3 py-4 sm:px-5 sm:py-5"
        >
          <main className="mx-auto flex w-full max-w-5xl flex-col gap-3">
            {filteredEdits.map((edit) => (
              <FileDiffItem
                key={edit.fileId}
                edit={edit}
                compactDiff={compactDiff}
                isOpen={openFileIds.has(edit.fileId)}
                isTargeted={targetFileId === edit.fileId}
                onOpenChange={(open) => {
                  setOpenFileIds((current) => {
                    const next = new Set(current);
                    if (open) next.add(edit.fileId);
                    else next.delete(edit.fileId);
                    return next;
                  });
                }}
                onAccept={handleAcceptOne}
                onReject={handleRejectOne}
              />
            ))}
            {filteredEdits.length === 0 && (
              <div className="flex min-h-64 items-center justify-center rounded-xl border border-token-border-light bg-token-bg-secondary/25 text-sm text-token-text-tertiary">
                No changed files match “{searchQuery}”
              </div>
            )}
          </main>
        </OverlayScrollbar>
      </div>
    </div>
  );
}
