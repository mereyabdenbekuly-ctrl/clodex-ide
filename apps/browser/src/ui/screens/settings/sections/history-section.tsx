import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import { IconGlobe2Fill18 } from 'nucleo-ui-fill-18';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlertIcon,
  HistoryIcon,
  LinkIcon,
  Loader2Icon,
  Trash2Icon,
} from 'lucide-react';
import { IconChevronRightOutline18 } from 'nucleo-ui-outline-18';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import { createRafResizeObserver } from '@ui/utils/resize-observer';
import type {
  HistoryFilter,
  HistoryResult,
  FaviconBitmapResult,
} from '@shared/karton-contracts/pages-api/types';
import { List } from 'react-window';

// =============================================================================
// Constants
// =============================================================================

const PAGE_SIZE = 50;
const DATE_HEADER_HEIGHT = 64;
const ENTRY_ROW_HEIGHT = 56;
const ORIGIN_GROUP_HEADER_HEIGHT = 48;

// =============================================================================
// Row Types
// =============================================================================

type DateHeaderRow = {
  type: 'date-header';
  date: string;
};

type OriginGroupHeaderRow = {
  type: 'origin-group-header';
  groupId: string;
  origin: string;
  faviconUrl: string | null;
  entryCount: number;
};

type EntryRow = {
  type: 'entry';
  id: number;
  time: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  groupId: string | null;
};

type Row = DateHeaderRow | OriginGroupHeaderRow | EntryRow;

// =============================================================================
// Helpers
// =============================================================================

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getUrlOrigin(url: string): string {
  try {
    if (url.startsWith('file://')) return 'file://';
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getUrlDisplayPath(url: string): string {
  try {
    if (url.startsWith('file://')) return url;
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  } catch {
    return url;
  }
}

function historyToRows(history: HistoryResult[]): Row[] {
  const rows: Row[] = [];
  let currentDate: string | null = null;

  const dateGroups: { date: string; entries: HistoryResult[] }[] = [];
  for (const entry of history) {
    const dateKey = formatDate(entry.visitTime);
    if (dateKey !== currentDate) {
      currentDate = dateKey;
      dateGroups.push({ date: dateKey, entries: [] });
    }
    dateGroups[dateGroups.length - 1]!.entries.push(entry);
  }

  for (const dateGroup of dateGroups) {
    rows.push({ type: 'date-header', date: dateGroup.date });

    let i = 0;
    while (i < dateGroup.entries.length) {
      const origin = getUrlOrigin(dateGroup.entries[i]!.url);
      let j = i + 1;
      while (
        j < dateGroup.entries.length &&
        getUrlOrigin(dateGroup.entries[j]!.url) === origin
      ) {
        j++;
      }
      const runLength = j - i;

      if (runLength >= 2) {
        const groupId = `group-${dateGroup.entries[i]!.visitId}`;
        rows.push({
          type: 'origin-group-header',
          groupId,
          origin,
          faviconUrl: dateGroup.entries[i]!.faviconUrl,
          entryCount: runLength,
        });
        for (let k = i; k < j; k++) {
          const e = dateGroup.entries[k]!;
          rows.push({
            type: 'entry',
            id: e.visitId,
            time: formatTime(e.visitTime),
            title: e.title || 'Untitled',
            url: e.url,
            faviconUrl: e.faviconUrl,
            groupId,
          });
        }
      } else {
        const e = dateGroup.entries[i]!;
        rows.push({
          type: 'entry',
          id: e.visitId,
          time: formatTime(e.visitTime),
          title: e.title || 'Untitled',
          url: e.url,
          faviconUrl: e.faviconUrl,
          groupId: null,
        });
      }

      i = j;
    }
  }

  return rows;
}

function filterCollapsedRows(rows: Row[], collapsedGroups: Set<string>): Row[] {
  if (collapsedGroups.size === 0) return rows;
  return rows.filter((row) => {
    if (
      row.type === 'entry' &&
      row.groupId &&
      collapsedGroups.has(row.groupId)
    ) {
      return false;
    }
    return true;
  });
}

// =============================================================================
// Favicon Component
// =============================================================================

function Favicon({
  faviconUrl,
  bitmaps,
}: {
  faviconUrl: string | null;
  bitmaps: Record<string, FaviconBitmapResult>;
}) {
  if (!faviconUrl) {
    return (
      <IconGlobe2Fill18 className="size-4 shrink-0 text-muted-foreground" />
    );
  }

  const bitmap = bitmaps[faviconUrl];
  if (!bitmap?.imageData) {
    return (
      <IconGlobe2Fill18 className="size-4 shrink-0 text-muted-foreground" />
    );
  }

  const mimeType = faviconUrl.endsWith('.ico')
    ? 'image/x-icon'
    : faviconUrl.endsWith('.svg')
      ? 'image/svg+xml'
      : 'image/png';

  return (
    <img
      src={`data:${mimeType};base64,${bitmap.imageData}`}
      alt=""
      className="size-4 shrink-0 rounded-sm object-contain"
      onError={(e) => {
        e.currentTarget.style.display = 'none';
      }}
    />
  );
}

// =============================================================================
// Row Component
// =============================================================================

type RowProps = {
  rows: Row[];
  faviconBitmaps: Record<string, FaviconBitmapResult>;
  collapsedGroups: Set<string>;
  onOpenUrl: (url: string) => void;
  onToggleGroup: (groupId: string) => void;
};

function RowComponent({
  index,
  style,
  rows,
  faviconBitmaps,
  collapsedGroups,
  onOpenUrl,
  onToggleGroup,
}: {
  index: number;
  style: React.CSSProperties;
  ariaAttributes: {
    'aria-posinset': number;
    'aria-setsize': number;
    role: 'listitem';
  };
} & RowProps) {
  const [copyTooltipText, setCopyTooltipText] = useState('Copy link');
  const row = rows[index]!;

  if (row.type === 'date-header') {
    return (
      <div style={style} className="flex items-end px-4 pt-6 pb-3">
        <h2 className="font-medium text-sm text-token-text-primary">
          {row.date}
        </h2>
      </div>
    );
  }

  if (row.type === 'origin-group-header') {
    const isCollapsed = collapsedGroups.has(row.groupId);
    return (
      <div style={style} className="flex items-center px-3 pt-2">
        <div
          className="flex h-full w-full cursor-pointer select-none items-center gap-3 rounded-xl px-3 transition-colors hover:bg-token-list-hover-background"
          onClick={() => onToggleGroup(row.groupId)}
        >
          <span className="flex min-w-12 items-center justify-end">
            <IconChevronRightOutline18
              className={`size-3.5 text-token-text-tertiary transition-transform ${
                isCollapsed ? '' : 'rotate-90'
              }`}
            />
          </span>
          <Favicon faviconUrl={row.faviconUrl} bitmaps={faviconBitmaps} />
          <span className="font-medium text-sm text-token-text-primary">
            {row.origin}
          </span>
          <span className="text-token-text-tertiary text-xs">
            {row.entryCount} {row.entryCount === 1 ? 'page' : 'pages'}
          </span>
        </div>
      </div>
    );
  }

  const handleCopyUrl = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(row.url);
    setCopyTooltipText('Copied!');
    setTimeout(() => setCopyTooltipText('Copy link'), 1500);
  };

  return (
    <div style={style} className="px-3">
      <div
        className="group flex h-full cursor-pointer select-none items-center gap-3 rounded-xl px-3 transition-colors hover:bg-token-list-hover-background"
        onClick={() => onOpenUrl(row.url)}
      >
        <span className="min-w-12 text-right text-token-text-tertiary text-xs tabular-nums">
          {row.time}
        </span>
        <Favicon faviconUrl={row.faviconUrl} bitmaps={faviconBitmaps} />
        <div className="flex-1 truncate">
          <div className="truncate text-sm text-token-text-primary">
            {row.title}
          </div>
          <div className="truncate text-token-text-tertiary text-xs">
            {getUrlDisplayPath(row.url)}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              onClick={handleCopyUrl}
            >
              <LinkIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copyTooltipText}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function HistorySection() {
  const [searchText, setSearchText] = useState('');
  const [debouncedSearchText, setDebouncedSearchText] = useState('');
  const [history, setHistory] = useState<HistoryResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [faviconBitmaps, setFaviconBitmaps] = useState<
    Record<string, FaviconBitmapResult>
  >({});

  const getHistory = useKartonProcedure((p) => p.browser.getHistory);
  const getFaviconBitmaps = useKartonProcedure(
    (p) => p.browser.getFaviconBitmaps,
  );
  const openExternalUrl = useKartonProcedure((p) => p.openExternalUrl);
  const setSettingsRoute = useKartonProcedure(
    (p) => p.appScreen.setSettingsRoute,
  );
  const getHistoryRef = useRef(getHistory);
  const getFaviconBitmapsRef = useRef(getFaviconBitmaps);
  const listRef = useRef<{
    readonly element: HTMLDivElement | null;
    scrollToRow: (config: {
      align?: 'auto' | 'center' | 'end' | 'smart' | 'start';
      behavior?: 'auto' | 'instant' | 'smooth';
      index: number;
    }) => void;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Update refs when procedures change
  useEffect(() => {
    getHistoryRef.current = getHistory;
  }, [getHistory]);
  useEffect(() => {
    getFaviconBitmapsRef.current = getFaviconBitmaps;
  }, [getFaviconBitmaps]);

  // Debounce search text
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [searchText]);

  // Measure container size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { observer: resizeObserver, disconnect: disconnectResizeObserver } =
      createRafResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerSize((prev) => {
            const next = {
              width: entry.contentRect.width,
              height: entry.contentRect.height,
            };
            if (prev.width === next.width && prev.height === next.height) {
              return prev;
            }
            return next;
          });
        }
      });

    resizeObserver.observe(container);
    setContainerSize({
      width: container.clientWidth,
      height: container.clientHeight,
    });

    return () => disconnectResizeObserver();
  }, []);

  // Fetch favicon bitmaps for a batch of history results
  const fetchFavicons = useCallback(async (historyResults: HistoryResult[]) => {
    const faviconUrls = historyResults
      .map((r) => r.faviconUrl)
      .filter((url): url is string => url !== null);
    const uniqueUrls = Array.from(new Set(faviconUrls));
    if (uniqueUrls.length === 0) return;
    try {
      const bitmaps = await getFaviconBitmapsRef.current(uniqueUrls);
      setFaviconBitmaps((prev) => ({ ...prev, ...bitmaps }));
    } catch (err) {
      console.debug('Failed to fetch favicons:', err);
    }
  }, []);

  // Load initial history when search changes
  useEffect(() => {
    let cancelled = false;

    async function fetchInitialHistory() {
      setIsLoading(true);
      setError(null);
      setHistory([]);
      setHasMore(true);

      if (listRef.current) {
        listRef.current.scrollToRow({ index: 0 });
      }

      try {
        const filter: HistoryFilter = {
          text: debouncedSearchText.trim() || undefined,
          limit: PAGE_SIZE,
          offset: 0,
        };
        const results = await getHistoryRef.current(filter);
        if (!cancelled) {
          setHistory(results);
          setHasMore(results.length === PAGE_SIZE);
          setIsLoading(false);
          fetchFavicons(results);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err : new Error('Failed to load history'),
          );
          setIsLoading(false);
        }
      }
    }

    fetchInitialHistory();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearchText, fetchFavicons]);

  // Load more history (infinite scroll)
  const loadMoreHistory = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const filter: HistoryFilter = {
        text: debouncedSearchText.trim() || undefined,
        limit: PAGE_SIZE,
        offset: history.length,
      };
      const results = await getHistoryRef.current(filter);
      setHistory((prev) => [...prev, ...results]);
      setHasMore(results.length === PAGE_SIZE);
      fetchFavicons(results);
    } catch (err) {
      console.error('Failed to load more history:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    isLoadingMore,
    hasMore,
    debouncedSearchText,
    history.length,
    fetchFavicons,
  ]);

  // Collapsed origin groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Convert history to rows + filter collapsed
  const allRows = useMemo(() => historyToRows(history), [history]);
  const rows = useMemo(
    () => filterCollapsedRows(allRows, collapsedGroups),
    [allRows, collapsedGroups],
  );

  const getRowHeight = useCallback(
    (index: number): number => {
      if (index >= rows.length) return ENTRY_ROW_HEIGHT;
      const row = rows[index]!;
      if (row.type === 'date-header') return DATE_HEADER_HEIGHT;
      if (row.type === 'origin-group-header') return ORIGIN_GROUP_HEADER_HEIGHT;
      return ENTRY_ROW_HEIGHT;
    },
    [rows],
  );

  // Trigger load more when near bottom
  const handleRowsRendered = useCallback(
    (
      visibleRows: { startIndex: number; stopIndex: number },
      _allRows: { startIndex: number; stopIndex: number },
    ) => {
      if (
        hasMore &&
        !isLoadingMore &&
        !isLoading &&
        visibleRows.stopIndex >= rows.length - 10
      ) {
        loadMoreHistory();
      }
    },
    [hasMore, isLoadingMore, isLoading, rows.length, loadMoreHistory],
  );

  // Handle opening URL in the user's default browser.
  const handleOpenUrl = useCallback(
    (url: string) => {
      void openExternalUrl(url);
    },
    [openExternalUrl],
  );

  // Row props
  const rowProps = useMemo(
    () => ({
      rows,
      faviconBitmaps,
      collapsedGroups,
      onOpenUrl: handleOpenUrl,
      onToggleGroup: toggleGroup,
    }),
    [rows, faviconBitmaps, collapsedGroups, handleOpenUrl, toggleGroup],
  );

  return (
    <div className="h-full w-full overflow-hidden px-4 pt-16 pb-8 sm:px-6 sm:pt-20 lg:px-8">
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
        <header className="shrink-0 pb-6">
          <p className="mb-1.5 font-medium text-clodex-green-400 text-xs uppercase tracking-[0.12em]">
            Browser
          </p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 max-w-xl">
              <h1 className="font-semibold text-2xl text-token-text-primary tracking-[-0.02em]">
                History
              </h1>
              <p className="mt-1.5 text-sm text-token-text-secondary leading-6">
                Search browsing activity, reopen pages, or jump to privacy
                controls.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="self-start rounded-xl sm:self-auto"
              onClick={() => setSettingsRoute({ section: 'clear-data' })}
            >
              <Trash2Icon className="size-3.5" />
              Clear data
            </Button>
          </div>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Input
              type="text"
              placeholder="Search history"
              value={searchText}
              onValueChange={setSearchText}
              className="w-full rounded-xl sm:max-w-sm"
            />
            <div className="flex items-center gap-2 text-token-text-tertiary text-xs">
              <HistoryIcon className="size-3.5" />
              <span>
                {history.length} loaded{' '}
                {history.length === 1 ? 'visit' : 'visits'}
                {hasMore ? ' · more available' : ''}
              </span>
            </div>
          </div>
        </header>

        <div
          ref={containerRef}
          className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-token-border-light bg-token-main-surface-primary/72 shadow-codex-sm"
        >
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2Icon className="size-6 animate-spin text-clodex-green-400" />
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center px-4">
              <div className="max-w-md space-y-2 text-center">
                <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-error-solid/20 bg-error-solid/7 text-error-solid">
                  <CircleAlertIcon className="size-4.5" />
                </span>
                <p className="font-medium text-error-solid text-sm">
                  {error.message}
                </p>
                {import.meta.env.DEV && error.stack && (
                  <details className="mt-4 text-left">
                    <summary className="cursor-pointer text-token-text-tertiary text-xs">
                      Technical details (dev mode)
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-xl border border-token-border-light bg-token-bg-secondary/55 p-3 text-token-text-secondary text-xs">
                      {error.stack}
                    </pre>
                  </details>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4 rounded-xl"
                onClick={async () => {
                  setError(null);
                  setIsLoading(true);
                  try {
                    const filter: HistoryFilter = {
                      text: debouncedSearchText.trim() || undefined,
                      limit: PAGE_SIZE,
                      offset: 0,
                    };
                    const results = await getHistoryRef.current(filter);
                    setHistory(results);
                    setHasMore(results.length === PAGE_SIZE);
                    setIsLoading(false);
                    fetchFavicons(results);
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err
                        : new Error('Failed to load history'),
                    );
                    setIsLoading(false);
                  }
                }}
              >
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div>
                <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-token-bg-tertiary text-token-text-secondary">
                  <HistoryIcon className="size-4.5" />
                </span>
                <h2 className="mt-3 font-medium text-sm text-token-text-primary">
                  {searchText ? 'No matching history' : 'No history yet'}
                </h2>
                <p className="mt-1 text-token-text-secondary text-xs leading-5">
                  {searchText
                    ? 'Try a different page title, URL, or search term.'
                    : 'Pages you visit in Clodex will appear here.'}
                </p>
              </div>
            </div>
          ) : containerSize.height > 0 ? (
            <>
              <List
                listRef={listRef}
                rowCount={rows.length}
                rowHeight={getRowHeight}
                rowComponent={RowComponent}
                rowProps={rowProps}
                onRowsRendered={handleRowsRendered}
                overscanCount={5}
                className="scrollbar-subtle"
                style={{
                  height: containerSize.height,
                  width: containerSize.width,
                }}
              />
              {isLoadingMore && (
                <div className="absolute inset-x-0 bottom-0 flex h-14 items-center justify-center bg-linear-to-t from-token-bg-primary to-transparent">
                  <Loader2Icon className="size-5 animate-spin text-clodex-green-400" />
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
