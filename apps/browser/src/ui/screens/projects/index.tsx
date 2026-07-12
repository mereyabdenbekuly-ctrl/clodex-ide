import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import type { ChatProject } from '@shared/karton-contracts/ui/agent';
import { resolveFeatureGate } from '@shared/feature-gates';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { cn } from '@ui/utils';
import {
  ArrowLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Clock3Icon,
  FolderIcon,
  FolderOpenIcon,
  Layers3Icon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSidebarCollapsed } from '../main/_components/sidebar-collapsed-context';
import { SidebarTitlebarRow } from '../main/_components/sidebar-titlebar-row';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../settings/_components/settings-page';
import {
  filterProjects,
  getProjectsSummary,
  mergeProjectPages,
} from './projects-model';
import { SpacesIndex } from './spaces-index';

const PROJECT_PAGE_SIZE = 48;
const COLLAPSED_SESSION_COUNT = 3;

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatRelativeTime(value: Date) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);
  if (absoluteSeconds < 60) return 'just now';

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60)
    return relativeTimeFormatter.format(diffMinutes, 'minute');

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24)
    return relativeTimeFormatter.format(diffHours, 'hour');

  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30)
    return relativeTimeFormatter.format(diffDays, 'day');

  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year:
      new Date(timestamp).getFullYear() === new Date().getFullYear()
        ? undefined
        : 'numeric',
  });
}

function ProjectsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="h-72 animate-pulse rounded-2xl border border-token-border-light bg-token-main-surface-primary/65 p-5 shadow-codex-sm"
        >
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-token-bg-tertiary" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-2/5 rounded bg-token-bg-tertiary" />
              <div className="h-3 w-3/5 rounded bg-token-bg-tertiary" />
            </div>
          </div>
          <div className="mt-6 space-y-2">
            <div className="h-11 rounded-xl bg-token-bg-secondary" />
            <div className="h-11 rounded-xl bg-token-bg-secondary" />
            <div className="h-11 rounded-xl bg-token-bg-secondary" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  expanded,
  currentAgentId,
  creating,
  onToggleExpanded,
  onCreateTask,
  onOpenSession,
  onReveal,
  archivedMode,
}: {
  project: ChatProject;
  expanded: boolean;
  currentAgentId: string | null;
  creating: boolean;
  onToggleExpanded: () => void;
  onCreateTask: () => void;
  onOpenSession: (sessionId: string) => void;
  onReveal: () => void;
  archivedMode: boolean;
}) {
  const visibleSessions = expanded
    ? project.sessions
    : project.sessions.slice(0, COLLAPSED_SESSION_COUNT);
  const hiddenSessionCount = project.sessions.length - visibleSessions.length;

  return (
    <SettingsPanel
      interactive
      className="flex h-full min-h-72 flex-col overflow-hidden"
    >
      <div className="flex items-start gap-3 p-5 pb-4">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl border',
            project.rootPath
              ? 'border-codex-blue-400/18 bg-codex-blue-400/9 text-codex-blue-400'
              : 'border-token-border-light bg-token-bg-secondary text-token-text-tertiary',
          )}
        >
          <FolderIcon className="size-4.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-base text-token-text-primary">
                {project.name}
              </h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-token-text-tertiary text-xs">
                <Clock3Icon className="size-3 shrink-0" />
                <time
                  dateTime={new Date(project.updatedAt).toISOString()}
                  title={new Date(project.updatedAt).toLocaleString()}
                >
                  Updated {formatRelativeTime(project.updatedAt)}
                </time>
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-token-border-light bg-token-bg-secondary/65 px-2 py-1 font-medium text-[11px] text-token-text-secondary">
              {project.sessions.length}{' '}
              {pluralize(project.sessions.length, 'task')}
            </span>
          </div>

          <div className="mt-3 flex min-w-0 items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate text-[11px] text-token-text-tertiary"
              title={project.rootPath ?? 'Tasks without a connected workspace'}
            >
              {project.rootPath ?? 'No connected workspace'}
            </code>
            {project.rootPath && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Reveal ${project.name} in file manager`}
                title="Reveal in file manager"
                className="shrink-0"
                onClick={onReveal}
              >
                <FolderOpenIcon className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-5 border-token-border-light border-t" />

      <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
        <div className="px-2 pb-2 font-medium text-[11px] text-token-text-tertiary uppercase tracking-[0.08em]">
          Recent tasks
        </div>
        <div className="flex flex-col gap-1">
          {visibleSessions.map((session) => {
            const current = session.id === currentAgentId;
            return (
              <button
                key={session.id}
                type="button"
                className={cn(
                  'group/session flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background-color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border',
                  current
                    ? 'bg-codex-blue-400/8 shadow-codex-hairline'
                    : 'hover:bg-token-list-hover-background',
                )}
                onClick={() => onOpenSession(session.id)}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-lg',
                    current
                      ? 'bg-codex-blue-400/12 text-codex-blue-400'
                      : 'bg-token-bg-secondary text-token-text-tertiary group-hover/session:text-token-text-secondary',
                  )}
                >
                  <MessageSquareIcon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm text-token-text-primary">
                    {session.title || 'Untitled task'}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-token-text-tertiary">
                    {session.messageCount}{' '}
                    {pluralize(session.messageCount, 'message')} ·{' '}
                    {formatRelativeTime(session.lastMessageAt)}
                  </span>
                </span>
                {current && (
                  <span className="shrink-0 font-medium text-[10px] text-codex-blue-400 uppercase tracking-[0.08em]">
                    Current
                  </span>
                )}
                {archivedMode && (
                  <ArchiveRestoreIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
                )}
              </button>
            );
          })}
        </div>

        {hiddenSessionCount > 0 && (
          <button
            type="button"
            className="mt-1 flex h-8 items-center justify-center gap-1.5 rounded-lg text-token-text-tertiary text-xs transition-colors hover:bg-token-list-hover-background hover:text-token-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon className="size-3.5" />
            Show {hiddenSessionCount} more
          </button>
        )}
        {expanded && project.sessions.length > COLLAPSED_SESSION_COUNT && (
          <button
            type="button"
            className="mt-1 flex h-8 items-center justify-center gap-1.5 rounded-lg text-token-text-tertiary text-xs transition-colors hover:bg-token-list-hover-background hover:text-token-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon className="size-3.5 rotate-180" />
            Show less
          </button>
        )}
      </div>

      {!archivedMode && (
        <div className="border-token-border-light border-t bg-token-bg-secondary/30 p-3">
          <Button
            variant="secondary"
            size="sm"
            className="w-full rounded-xl border-token-border-light bg-token-main-surface-primary shadow-codex-sm"
            disabled={creating}
            onClick={onCreateTask}
          >
            {creating ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            New task in project
          </Button>
        </div>
      )}
    </SettingsPanel>
  );
}

export function ProjectsIndex() {
  const { collapsed: sidebarCollapsed } = useSidebarCollapsed();
  const [currentAgentId, setOpenAgent] = useOpenAgent();
  const getChatProjects = useKartonProcedure((p) => p.agents.getChatProjects);
  const createAgent = useKartonProcedure((p) => p.agents.create);
  const resumeAgent = useKartonProcedure((p) => p.agents.resume);
  const unarchiveAgent = useKartonProcedure((p) => p.agents.unarchive);
  const setLastOpenAgentId = useKartonProcedure(
    (p) => p.browser.setLastOpenAgentId,
  );
  const closeProjects = useKartonProcedure((p) => p.appScreen.closeProjects);
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const spacesEnabled = resolveFeatureGate(
    'spaces',
    preferences.featureGates.overrides,
    releaseChannel,
  ).enabled;

  const [view, setView] = useState<'projects' | 'spaces'>('projects');
  const [query, setQuery] = useState('');
  const [archivedMode, setArchivedMode] = useState(false);
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(PROJECT_PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const requestGenerationRef = useRef(0);
  const unfilteredProjectsRef = useRef<ChatProject[]>([]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    const normalizedQuery = query.trim();

    setIsLoading(true);
    setIsLoadingMore(false);
    setError(null);
    setOffset(PROJECT_PAGE_SIZE);
    unfilteredProjectsRef.current = [];

    void getChatProjects(
      0,
      PROJECT_PAGE_SIZE,
      normalizedQuery || undefined,
      archivedMode,
    )
      .then((page) => {
        if (requestGenerationRef.current !== generation) return;

        const normalizedPage = mergeProjectPages([], page);
        if (normalizedQuery) {
          const localMatches = filterProjects(
            unfilteredProjectsRef.current,
            normalizedQuery,
          );
          setProjects(mergeProjectPages(localMatches, normalizedPage));
        } else {
          unfilteredProjectsRef.current = normalizedPage;
          setProjects(normalizedPage);
        }
        setHasMore(page.length > 0);
      })
      .catch((reason) => {
        if (requestGenerationRef.current !== generation) return;
        console.error('Failed to fetch projects:', reason);
        setProjects([]);
        setHasMore(false);
        setError('Projects could not be loaded. Try refreshing the page.');
      })
      .finally(() => {
        if (requestGenerationRef.current === generation) {
          setIsLoading(false);
        }
      });
  }, [archivedMode, getChatProjects, query, refreshVersion]);

  const summary = useMemo(() => getProjectsSummary(projects), [projects]);

  const handleLoadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    const normalizedQuery = query.trim();

    setIsLoadingMore(true);
    setError(null);
    void getChatProjects(
      offset,
      PROJECT_PAGE_SIZE,
      normalizedQuery || undefined,
      archivedMode,
    )
      .then((page) => {
        if (requestGenerationRef.current !== generation) return;
        setProjects((current) => {
          const next = mergeProjectPages(current, page);
          if (!normalizedQuery) unfilteredProjectsRef.current = next;
          return next;
        });
        setOffset((current) => current + PROJECT_PAGE_SIZE);
        setHasMore(page.length > 0);
      })
      .catch((reason) => {
        if (requestGenerationRef.current !== generation) return;
        console.error('Failed to load more projects:', reason);
        setError('More projects could not be loaded. Please try again.');
      })
      .finally(() => {
        if (requestGenerationRef.current === generation) {
          setIsLoadingMore(false);
        }
      });
  }, [archivedMode, getChatProjects, hasMore, isLoadingMore, offset, query]);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      void (async () => {
        if (archivedMode) await unarchiveAgent(sessionId);
        setOpenAgent(sessionId);
        await setLastOpenAgentId(sessionId);
        await resumeAgent(sessionId);
        await closeProjects();
      })();
    },
    [
      archivedMode,
      closeProjects,
      resumeAgent,
      setLastOpenAgentId,
      setOpenAgent,
      unarchiveAgent,
    ],
  );

  const handleCreateTask = useCallback(
    async (project: ChatProject) => {
      if (creatingProjectId) return;
      setCreatingProjectId(project.id);
      setError(null);

      try {
        const workspacePaths = project.rootPath
          ? [project.rootPath]
          : undefined;
        const agentId = await createAgent(
          undefined,
          undefined,
          undefined,
          workspacePaths,
          Boolean(project.rootPath),
        );
        setOpenAgent(agentId);
        await setLastOpenAgentId(agentId);
        await closeProjects();
      } catch (reason) {
        console.error('Failed to create a project task:', reason);
        setError('A new task could not be created. Please try again.');
      } finally {
        setCreatingProjectId(null);
      }
    },
    [
      closeProjects,
      createAgent,
      creatingProjectId,
      setLastOpenAgentId,
      setOpenAgent,
    ],
  );

  const toggleExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  if (view === 'spaces') {
    return <SpacesIndex onBack={() => setView('projects')} />;
  }

  return (
    <div className="relative h-full">
      {sidebarCollapsed && (
        <SidebarTitlebarRow absolute sidebarCollapsed agentTitle="Projects" />
      )}
      <SettingsPage
        eyebrow="Workspace"
        title="Projects"
        description="Browse tasks by workspace, reopen recent sessions, or start a new task with the right project already connected."
        actions={
          <>
            {spacesEnabled && (
              <Button
                variant="secondary"
                size="sm"
                className="rounded-lg"
                onClick={() => setView('spaces')}
              >
                <Layers3Icon className="size-3.5" />
                Spaces
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg"
              onClick={() => closeProjects()}
            >
              <ArrowLeftIcon className="size-3.5" />
              Back to task
            </Button>
          </>
        }
        toolbar={
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SettingsSummaryCard
                accent
                label={pluralize(summary.projects, 'project')}
                value={summary.projects}
                icon={<Layers3Icon className="size-4" />}
              />
              <SettingsSummaryCard
                label={pluralize(summary.sessions, 'task')}
                value={summary.sessions}
                icon={<MessageSquareIcon className="size-4" />}
              />
              <SettingsSummaryCard
                label="connected roots"
                value={summary.connectedRoots}
                icon={<FolderIcon className="size-4" />}
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-token-text-tertiary" />
                <Input
                  aria-label="Search projects and tasks"
                  placeholder="Search projects and task titles…"
                  size="md"
                  debounce={250}
                  value={query}
                  onValueChange={setQuery}
                  className="h-10 max-w-none rounded-xl border-token-border-light bg-token-main-surface-primary/70 pr-10 pl-9 shadow-codex-sm focus:border-token-border-default"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear project search"
                    className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-token-text-tertiary transition-colors hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                    onClick={() => setQuery('')}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
              <Button
                variant={archivedMode ? 'primary' : 'secondary'}
                size="md"
                className="h-10 rounded-xl border-token-border-light shadow-codex-sm"
                onClick={() => setArchivedMode((value) => !value)}
              >
                {archivedMode ? (
                  <ArchiveRestoreIcon className="size-3.5" />
                ) : (
                  <ArchiveIcon className="size-3.5" />
                )}
                {archivedMode ? 'Show active' : 'Archived'}
              </Button>
              <Button
                variant="secondary"
                size="md"
                className="h-10 rounded-xl border-token-border-light bg-token-main-surface-primary/70 shadow-codex-sm"
                disabled={isLoading}
                onClick={() => setRefreshVersion((version) => version + 1)}
              >
                <RefreshCwIcon
                  className={cn('size-3.5', isLoading && 'animate-spin')}
                />
                Refresh
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          <SettingsSectionHeader
            title={
              query.trim()
                ? 'Search results'
                : archivedMode
                  ? 'Archived projects'
                  : 'All projects'
            }
            description={
              query.trim()
                ? `Projects and tasks matching “${query.trim()}”.`
                : archivedMode
                  ? 'Select an archived task to restore and reopen it.'
                  : 'Projects are ordered by their most recently active task.'
            }
          />

          {error && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-error-solid/25 bg-error-solid/8 px-4 py-3 text-sm text-token-text-secondary"
            >
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-error-solid" />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <ProjectsSkeleton />
          ) : projects.length === 0 ? (
            <SettingsPanel className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl border border-token-border-light bg-token-bg-secondary text-token-text-tertiary shadow-codex-sm">
                <FolderIcon className="size-5" />
              </span>
              <h2 className="mt-4 font-semibold text-base text-token-text-primary">
                {query.trim()
                  ? 'No matching projects'
                  : archivedMode
                    ? 'No archived tasks'
                    : 'No projects yet'}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-token-text-secondary leading-5">
                {query.trim()
                  ? 'Try a project name, workspace path, or another task title.'
                  : archivedMode
                    ? 'Tasks you archive will appear here and can be restored by opening them.'
                    : 'Projects appear after you create a task with a connected workspace.'}
              </p>
              {query.trim() && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  onClick={() => setQuery('')}
                >
                  Clear search
                </Button>
              )}
            </SettingsPanel>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {projects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    expanded={expandedProjectIds.has(project.id)}
                    currentAgentId={currentAgentId}
                    creating={creatingProjectId === project.id}
                    onToggleExpanded={() => toggleExpanded(project.id)}
                    onCreateTask={() => void handleCreateTask(project)}
                    onOpenSession={handleOpenSession}
                    onReveal={() => {
                      if (!project.rootPath) return;
                      window.open(
                        `clodex://reveal-file/${encodeURIComponent(project.rootPath)}`,
                        '_blank',
                      );
                    }}
                    archivedMode={archivedMode}
                  />
                ))}
              </div>

              {hasMore && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-xl border-token-border-light bg-token-main-surface-primary shadow-codex-sm"
                    disabled={isLoadingMore}
                    onClick={handleLoadMore}
                  >
                    {isLoadingMore && (
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                    )}
                    {isLoadingMore ? 'Loading…' : 'Load more projects'}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </SettingsPage>
    </div>
  );
}
