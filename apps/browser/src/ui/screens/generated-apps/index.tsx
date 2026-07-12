import { Button } from '@clodex/stage-ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clodex/stage-ui/components/dialog';
import { Input } from '@clodex/stage-ui/components/input';
import { resolveFeatureGate } from '@shared/feature-gates';
import type {
  GeneratedApp,
  GeneratedAppsSort,
  GeneratedAppsStatusFilter,
  GeneratedAppsSummary,
} from '@shared/generated-apps';
import { cn } from '@ui/utils';
import {
  AppWindowIcon,
  ArrowLeftIcon,
  BoxIcon,
  CircleAlertIcon,
  Clock3Icon,
  ExternalLinkIcon,
  FileCode2Icon,
  FolderGit2Icon,
  HardDriveIcon,
  LayoutGridIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  UserRoundIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useKartonState } from '@ui/hooks/use-karton';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSummaryCard,
} from '../settings/_components/settings-page';
import {
  filterGeneratedApps,
  getGeneratedAppWorkspaceOptions,
  type GeneratedAppsFilterState,
} from './generated-apps-model';
import { GeneratedAppCapabilitiesDialog } from './generated-app-capabilities-dialog';

type ActionKind = 'launch' | 'delete' | 'regenerate';

export type GeneratedAppsNotice = {
  tone: 'success' | 'error' | 'info';
  message: string;
} | null;

export type GeneratedAppsActionState = {
  kind: ActionKind;
  key: string;
} | null;

type CatalogAction = (app: GeneratedApp) => void | Promise<void>;
type ConfirmedCatalogAction = (app: GeneratedApp) => boolean | Promise<boolean>;

const statusItems: Array<{
  value: GeneratedAppsStatusFilter;
  label: string;
}> = [
  { value: 'all', label: 'All statuses' },
  { value: 'ready', label: 'Ready' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'regenerating', label: 'Regenerating' },
];

const sortItems: Array<{ value: GeneratedAppsSort; label: string }> = [
  { value: 'updated-desc', label: 'Recently updated' },
  { value: 'opened-desc', label: 'Recently opened' },
  { value: 'title-asc', label: 'Title A–Z' },
];

function CatalogSelect({
  ariaLabel,
  value,
  onChange,
  children,
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-9 min-w-40 rounded-xl border border-token-border-light bg-token-bg-secondary/45 px-3 text-sm text-token-text-primary shadow-codex-hairline outline-none transition-colors hover:bg-token-list-hover-background focus:border-token-focus-border focus:ring-1 focus:ring-token-focus-border"
    >
      {children}
    </select>
  );
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});

function formatRelativeTime(value: string | null): string {
  if (!value) return 'Never';
  const timestamp = Date.parse(value);
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
    year: 'numeric',
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function workspaceLabel(workspacePath: string | null): string {
  if (!workspacePath) return 'No connected workspace';
  return workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath;
}

function StatusBadge({ status }: { status: GeneratedApp['status'] }) {
  const content = {
    ready: {
      label: 'Ready',
      className:
        'border-success-solid/20 bg-success-solid/8 text-success-foreground',
      dot: 'bg-success-solid',
    },
    broken: {
      label: 'Needs attention',
      className: 'border-warning-solid/20 bg-warning-solid/8 text-warning',
      dot: 'bg-warning-solid',
    },
    missing: {
      label: 'Missing',
      className: 'border-error-solid/20 bg-error-solid/8 text-error',
      dot: 'bg-error-solid',
    },
    regenerating: {
      label: 'Regenerating',
      className:
        'border-codex-blue-400/20 bg-codex-blue-400/8 text-codex-blue-400',
      dot: 'bg-codex-blue-400 animate-pulse',
    },
  }[status];

  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 font-medium text-[10px] uppercase tracking-[0.06em]',
        content.className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', content.dot)} />
      {content.label}
    </span>
  );
}

function NoticeBanner({ notice }: { notice: GeneratedAppsNotice }) {
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm',
        notice.tone === 'error' &&
          'border-error-solid/20 bg-error-solid/6 text-error',
        notice.tone === 'success' &&
          'border-success-solid/20 bg-success-solid/6 text-success-foreground',
        notice.tone === 'info' &&
          'border-codex-blue-400/20 bg-codex-blue-400/6 text-token-text-secondary',
      )}
    >
      {notice.tone === 'error' ? (
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      ) : (
        <SparklesIcon className="mt-0.5 size-4 shrink-0" />
      )}
      <span>{notice.message}</span>
    </div>
  );
}

function GeneratedAppsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="h-72 animate-pulse rounded-2xl border border-token-border-light bg-token-main-surface-primary/70 p-5 shadow-codex-sm"
        >
          <div className="flex gap-3">
            <div className="size-11 rounded-xl bg-token-bg-tertiary" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-2/5 rounded bg-token-bg-tertiary" />
              <div className="h-3 w-3/5 rounded bg-token-bg-secondary" />
            </div>
          </div>
          <div className="mt-6 h-16 rounded-xl bg-token-bg-secondary" />
          <div className="mt-3 h-11 rounded-xl bg-token-bg-secondary" />
          <div className="mt-6 flex gap-2">
            <div className="h-8 flex-1 rounded-lg bg-token-bg-tertiary" />
            <div className="h-8 flex-1 rounded-lg bg-token-bg-tertiary" />
          </div>
        </div>
      ))}
    </div>
  );
}

function GeneratedAppCard({
  app,
  actionState,
  onOpenDetails,
  onLaunch,
  onDelete,
  onRegenerate,
}: {
  app: GeneratedApp;
  actionState: GeneratedAppsActionState;
  onOpenDetails: CatalogAction;
  onLaunch: CatalogAction;
  onDelete: CatalogAction;
  onRegenerate: CatalogAction;
}) {
  const isBusy = actionState?.key === app.key;
  const canLaunch = app.status === 'ready' || app.status === 'regenerating';

  return (
    <SettingsPanel
      interactive
      className="group/app flex h-full min-h-72 flex-col overflow-hidden"
    >
      <div className="flex items-start gap-3 p-5 pb-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-codex-blue-400/18 bg-codex-blue-400/8 text-codex-blue-400 shadow-codex-hairline">
          <AppWindowIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button
                type="button"
                className="block max-w-full truncate text-left font-semibold text-base text-token-text-primary hover:text-codex-blue-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                onClick={() => onOpenDetails(app)}
              >
                {app.title}
              </button>
              <p className="mt-0.5 truncate font-mono text-[11px] text-token-text-tertiary">
                {app.appId}
              </p>
            </div>
            <StatusBadge status={app.status} />
          </div>
        </div>
      </div>

      <div className="px-5">
        <p className="line-clamp-2 min-h-10 text-sm text-token-text-secondary leading-5">
          {app.description ??
            'Agent-generated local application ready for preview and iteration.'}
        </p>
      </div>

      <div className="mx-5 mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] text-token-text-tertiary uppercase tracking-[0.06em]">
            <UserRoundIcon className="size-3" />
            Owner task
          </div>
          <div className="mt-1 truncate font-medium text-token-text-primary text-xs">
            {app.owner.taskTitle ?? 'Unknown task'}
          </div>
        </div>
        <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] text-token-text-tertiary uppercase tracking-[0.06em]">
            <FolderGit2Icon className="size-3" />
            Workspace
          </div>
          <div
            className="mt-1 truncate font-medium text-token-text-primary text-xs"
            title={app.owner.workspacePath ?? undefined}
          >
            {workspaceLabel(app.owner.workspacePath)}
          </div>
        </div>
      </div>

      {app.error && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl border border-warning-solid/18 bg-warning-solid/6 px-3 py-2 text-warning text-xs">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{app.error}</span>
        </div>
      )}

      <div className="mt-auto flex items-center gap-3 px-5 py-4 text-[11px] text-token-text-tertiary">
        <span className="flex items-center gap-1">
          <Clock3Icon className="size-3" />
          Updated {formatRelativeTime(app.updatedAt)}
        </span>
        <span className="flex items-center gap-1">
          <FileCode2Icon className="size-3" />
          {app.fileCount} files
        </span>
        <span className="flex items-center gap-1">
          <HardDriveIcon className="size-3" />
          {formatBytes(app.totalBytes)}
        </span>
      </div>

      <div className="flex items-center gap-2 border-token-border-light border-t bg-token-bg-secondary/30 p-3">
        <Button
          variant="secondary"
          size="sm"
          className="rounded-xl border-token-border-light bg-token-main-surface-primary shadow-codex-sm"
          onClick={() => onOpenDetails(app)}
        >
          Details
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-xl"
          disabled={isBusy}
          onClick={() => onRegenerate(app)}
        >
          {isBusy && actionState?.kind === 'regenerate' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <RotateCwIcon className="size-3.5" />
          )}
          Regenerate
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto rounded-xl"
          disabled={!canLaunch || isBusy}
          onClick={() => onLaunch(app)}
        >
          {isBusy && actionState?.kind === 'launch' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <ExternalLinkIcon className="size-3.5" />
          )}
          Launch
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${app.title}`}
          title={`Delete ${app.title}`}
          className="rounded-xl text-token-text-tertiary hover:text-error"
          disabled={isBusy}
          onClick={() => onDelete(app)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </SettingsPanel>
  );
}

function ConfirmationDialog({
  kind,
  app,
  busy,
  onOpenChange,
  onConfirm,
}: {
  kind: 'delete' | 'regenerate';
  app: GeneratedApp | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const deleting = kind === 'delete';
  return (
    <Dialog open={Boolean(app)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {!busy && <DialogClose />}
        <DialogHeader>
          <DialogTitle>
            {deleting ? 'Delete generated app?' : 'Regenerate this app?'}
          </DialogTitle>
          <DialogDescription>
            {deleting
              ? `This permanently deletes the local files for “${app?.title ?? 'this app'}”. The owner task and its conversation are not deleted.`
              : `Clodex will resume the owner task for “${app?.title ?? 'this app'}” and send a regeneration request. Existing files remain available until the agent writes replacements.`}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-3 text-token-text-secondary text-xs">
          {deleting
            ? 'Only agent-owned generated app files are in scope. Plugin apps and task history are never removed by this action.'
            : 'The app keeps the same app ID so existing preview links and ownership stay stable.'}
        </div>
        <DialogFooter>
          <Button
            variant={deleting ? 'destructive' : 'primary'}
            size="sm"
            className="rounded-xl"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : deleting ? (
              <Trash2Icon className="size-3.5" />
            ) : (
              <WandSparklesIcon className="size-3.5" />
            )}
            {deleting ? 'Delete app' : 'Regenerate'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-xl"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GeneratedAppsCatalog({
  apps,
  summary,
  isLoading,
  error,
  notice,
  actionState,
  onRefresh,
  onOpenDetails,
  onLaunch,
  onDelete,
  onRegenerate,
}: {
  apps: GeneratedApp[];
  summary: GeneratedAppsSummary;
  isLoading: boolean;
  error: string | null;
  notice: GeneratedAppsNotice;
  actionState: GeneratedAppsActionState;
  onRefresh: () => void | Promise<void>;
  onOpenDetails: CatalogAction;
  onLaunch: CatalogAction;
  onDelete: ConfirmedCatalogAction;
  onRegenerate: ConfirmedCatalogAction;
}) {
  const [filters, setFilters] = useState<GeneratedAppsFilterState>({
    query: '',
    status: 'all',
    workspacePath: null,
    sort: 'updated-desc',
  });
  const [deleteTarget, setDeleteTarget] = useState<GeneratedApp | null>(null);
  const [regenerateTarget, setRegenerateTarget] = useState<GeneratedApp | null>(
    null,
  );
  const filteredApps = useMemo(
    () => filterGeneratedApps(apps, filters),
    [apps, filters],
  );
  const workspaces = useMemo(
    () => getGeneratedAppWorkspaceOptions(apps),
    [apps],
  );
  const hasFilters =
    filters.query.trim().length > 0 ||
    filters.status !== 'all' ||
    filters.workspacePath !== null;

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (await onDelete(deleteTarget)) setDeleteTarget(null);
  };
  const confirmRegenerate = async () => {
    if (!regenerateTarget) return;
    if (await onRegenerate(regenerateTarget)) setRegenerateTarget(null);
  };

  return (
    <div className="h-screen min-h-screen bg-token-main-surface-primary text-token-text-primary">
      <SettingsPage
        eyebrow="Apps"
        title="Generated apps"
        description="Find, launch, repair, and iterate on local mini-apps created by your Clodex tasks."
        contentClassName="max-sm:pt-16"
        actions={
          <Button
            variant="secondary"
            size="sm"
            className="rounded-xl border-token-border-light bg-token-main-surface-primary shadow-codex-sm"
            disabled={isLoading}
            onClick={() => onRefresh()}
          >
            <RefreshCwIcon
              className={cn('size-3.5', isLoading && 'animate-spin')}
            />
            Refresh
          </Button>
        }
      >
        <NoticeBanner notice={notice} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SettingsSummaryCard
            label="Generated apps"
            value={summary.total}
            icon={<LayoutGridIcon className="size-4" />}
            accent
          />
          <SettingsSummaryCard
            label="Ready to launch"
            value={summary.ready}
            icon={<AppWindowIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Needs attention"
            value={summary.needsAttention}
            icon={<CircleAlertIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Regenerating"
            value={summary.regenerating}
            icon={<WandSparklesIcon className="size-4" />}
          />
        </div>

        <SettingsPanel className="mt-5 p-3">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
            <div className="relative block">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-token-text-tertiary" />
              <Input
                aria-label="Search generated apps"
                placeholder="Search apps, tasks, or workspaces…"
                value={filters.query}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    query: String(value),
                  }))
                }
                className="h-9 max-w-none rounded-xl border-token-border-light bg-token-bg-secondary/45 pl-9"
              />
            </div>
            <CatalogSelect
              ariaLabel="Filter generated apps by status"
              value={filters.status}
              onChange={(status) =>
                setFilters((current) => ({
                  ...current,
                  status: status as GeneratedAppsStatusFilter,
                }))
              }
            >
              {statusItems.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </CatalogSelect>
            <CatalogSelect
              ariaLabel="Filter generated apps by workspace"
              value={filters.workspacePath ?? ''}
              onChange={(workspacePath) =>
                setFilters((current) => ({
                  ...current,
                  workspacePath: workspacePath || null,
                }))
              }
            >
              <option value="">All workspaces</option>
              {workspaces.map((workspacePath) => (
                <option key={workspacePath} value={workspacePath}>
                  {workspaceLabel(workspacePath)}
                </option>
              ))}
            </CatalogSelect>
            <CatalogSelect
              ariaLabel="Sort generated apps"
              value={filters.sort}
              onChange={(sort) =>
                setFilters((current) => ({
                  ...current,
                  sort: sort as GeneratedAppsSort,
                }))
              }
            >
              {sortItems.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </CatalogSelect>
          </div>
        </SettingsPanel>

        {error && apps.length > 0 && (
          <div
            role="alert"
            className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-error-solid/20 bg-error-solid/6 px-3.5 py-3 text-error text-sm"
          >
            <span className="flex items-center gap-2">
              <CircleAlertIcon className="size-4 shrink-0" />
              {error}
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="rounded-lg"
              onClick={() => onRefresh()}
            >
              Retry
            </Button>
          </div>
        )}

        <div className="mt-5">
          {isLoading && apps.length === 0 ? (
            <GeneratedAppsSkeleton />
          ) : error && apps.length === 0 ? (
            <SettingsPanel className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl border border-error-solid/20 bg-error-solid/8 text-error">
                <CircleAlertIcon className="size-5" />
              </span>
              <h2 className="mt-4 font-semibold text-base">
                Generated apps could not be loaded
              </h2>
              <p className="mt-1 max-w-md text-sm text-token-text-secondary">
                {error}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4 rounded-xl"
                onClick={() => onRefresh()}
              >
                <RefreshCwIcon className="size-3.5" />
                Try again
              </Button>
            </SettingsPanel>
          ) : apps.length === 0 ? (
            <SettingsPanel className="flex min-h-80 flex-col items-center justify-center p-8 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl border border-codex-blue-400/18 bg-codex-blue-400/8 text-codex-blue-400">
                <BoxIcon className="size-6" />
              </span>
              <h2 className="mt-4 font-semibold text-lg">
                No generated apps yet
              </h2>
              <p className="mt-1 max-w-md text-sm text-token-text-secondary leading-5">
                Ask a task to build a mini-app. Once it writes an app under its
                agent-owned apps directory, it will appear here automatically.
              </p>
            </SettingsPanel>
          ) : filteredApps.length === 0 ? (
            <SettingsPanel className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
              <SearchIcon className="size-6 text-token-text-tertiary" />
              <h2 className="mt-3 font-semibold text-base">
                No apps match these filters
              </h2>
              <p className="mt-1 text-sm text-token-text-secondary">
                Clear the search or broaden the selected status and workspace.
              </p>
              {hasFilters && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4 rounded-xl"
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      query: '',
                      status: 'all',
                      workspacePath: null,
                    }))
                  }
                >
                  Clear filters
                </Button>
              )}
            </SettingsPanel>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {filteredApps.map((app) => (
                <GeneratedAppCard
                  key={app.key}
                  app={app}
                  actionState={actionState}
                  onOpenDetails={onOpenDetails}
                  onLaunch={onLaunch}
                  onDelete={setDeleteTarget}
                  onRegenerate={setRegenerateTarget}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsPage>

      <ConfirmationDialog
        kind="delete"
        app={deleteTarget}
        busy={
          actionState?.kind === 'delete' &&
          actionState.key === deleteTarget?.key
        }
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmationDialog
        kind="regenerate"
        app={regenerateTarget}
        busy={
          actionState?.kind === 'regenerate' &&
          actionState.key === regenerateTarget?.key
        }
        onOpenChange={(open) => !open && setRegenerateTarget(null)}
        onConfirm={() => void confirmRegenerate()}
      />
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="flex items-start gap-3 border-token-border-light border-t py-3 first:border-t-0">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-token-text-tertiary uppercase tracking-[0.08em]">
          {label}
        </div>
        <div
          className="mt-0.5 truncate text-sm text-token-text-primary"
          title={title}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

export function GeneratedAppDetail({
  app,
  isLoading,
  error,
  notice,
  actionState,
  previewEnabled = true,
  onBack,
  onRefresh,
  onLaunch,
  onDelete,
  onRegenerate,
}: {
  app: GeneratedApp | null;
  isLoading: boolean;
  error: string | null;
  notice: GeneratedAppsNotice;
  actionState: GeneratedAppsActionState;
  previewEnabled?: boolean;
  onBack: () => void;
  onRefresh: () => void | Promise<void>;
  onLaunch: CatalogAction;
  onDelete: ConfirmedCatalogAction;
  onRegenerate: ConfirmedCatalogAction;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const bridgeEnabled = resolveFeatureGate(
    'artifact-bridge',
    preferences.featureGates.overrides,
    releaseChannel,
  ).enabled;

  if (isLoading && !app) {
    return (
      <div className="flex h-screen items-center justify-center bg-token-main-surface-primary">
        <div className="flex items-center gap-2 text-sm text-token-text-secondary">
          <LoaderCircleIcon className="size-4 animate-spin text-codex-blue-400" />
          Loading generated app…
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex h-screen items-center justify-center bg-token-main-surface-primary p-6">
        <SettingsPanel className="flex min-h-72 w-full max-w-lg flex-col items-center justify-center p-8 text-center">
          <CircleAlertIcon className="size-8 text-error" />
          <h1 className="mt-4 font-semibold text-lg">App not available</h1>
          <p className="mt-1 text-sm text-token-text-secondary">
            {error ?? 'This generated app no longer exists in the library.'}
          </p>
          <div className="mt-5 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="rounded-xl"
              onClick={onBack}
            >
              <ArrowLeftIcon className="size-3.5" />
              Back to library
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="rounded-xl"
              onClick={() => onRefresh()}
            >
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          </div>
        </SettingsPanel>
      </div>
    );
  }

  const runnable = app.status === 'ready' || app.status === 'regenerating';
  const busy = actionState?.key === app.key;
  const confirmDelete = async () => {
    if (await onDelete(app)) setDeleteOpen(false);
  };
  const confirmRegenerate = async () => {
    if (await onRegenerate(app)) setRegenerateOpen(false);
  };

  return (
    <div className="h-screen min-h-screen bg-token-main-surface-primary text-token-text-primary">
      <SettingsPage
        eyebrow="Generated app"
        title={app.title}
        description={
          app.description ??
          'Agent-generated local application with task-owned source files.'
        }
        actions={
          <>
            {bridgeEnabled && (
              <Button
                variant="secondary"
                size="sm"
                className="rounded-xl"
                disabled={busy}
                onClick={() => setCapabilitiesOpen(true)}
              >
                <ShieldCheckIcon className="size-3.5" />
                Capabilities
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="rounded-xl"
              disabled={busy}
              onClick={() => setRegenerateOpen(true)}
            >
              <RotateCwIcon className="size-3.5" />
              Regenerate
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="rounded-xl"
              disabled={!runnable || busy}
              onClick={() => onLaunch(app)}
            >
              {actionState?.kind === 'launch' && busy ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <ExternalLinkIcon className="size-3.5" />
              )}
              Launch
            </Button>
          </>
        }
      >
        <button
          type="button"
          className="mb-5 inline-flex items-center gap-1.5 rounded-lg text-sm text-token-text-secondary hover:text-token-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-3.5" />
          Generated apps
        </button>

        <NoticeBanner notice={notice} />
        {error && (
          <div
            role="alert"
            className="mb-5 flex items-center gap-2 rounded-xl border border-error-solid/20 bg-error-solid/6 px-3.5 py-3 text-error text-sm"
          >
            <CircleAlertIcon className="size-4" />
            {error}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
          <SettingsPanel className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-token-border-light border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-codex-blue-400/10 text-codex-blue-400">
                  <AppWindowIcon className="size-4" />
                </span>
                <div>
                  <div className="font-medium text-sm">Live preview</div>
                  <div className="font-mono text-[10px] text-token-text-tertiary">
                    {app.appId}
                  </div>
                </div>
              </div>
              <StatusBadge status={app.status} />
            </div>
            <div className="relative aspect-[16/10] min-h-96 bg-token-bg-secondary/55">
              {runnable && previewEnabled ? (
                <iframe
                  src={app.previewUrl}
                  title={`${app.title} embedded preview`}
                  className="absolute inset-0 size-full border-0 bg-token-main-surface-primary"
                  sandbox="allow-scripts allow-same-origin"
                  referrerPolicy="origin"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                  <span
                    className={cn(
                      'flex size-14 items-center justify-center rounded-2xl border',
                      runnable
                        ? 'border-codex-blue-400/18 bg-codex-blue-400/8 text-codex-blue-400'
                        : 'border-warning-solid/18 bg-warning-solid/8 text-warning',
                    )}
                  >
                    {runnable ? (
                      <AppWindowIcon className="size-6" />
                    ) : (
                      <CircleAlertIcon className="size-6" />
                    )}
                  </span>
                  <h2 className="mt-4 font-semibold text-base">
                    {runnable
                      ? 'Preview available in the desktop app'
                      : 'Preview unavailable'}
                  </h2>
                  <p className="mt-1 max-w-md text-sm text-token-text-secondary">
                    {runnable
                      ? 'Launch the app to open its full owner-scoped preview.'
                      : (app.error ??
                        'Regenerate the app to restore its entry file.')}
                  </p>
                </div>
              )}
            </div>
          </SettingsPanel>

          <div className="space-y-4">
            <SettingsPanel className="p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="font-semibold text-sm">App details</h2>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Refresh app details"
                  title="Refresh app details"
                  disabled={isLoading}
                  onClick={() => onRefresh()}
                >
                  <RefreshCwIcon
                    className={cn('size-3.5', isLoading && 'animate-spin')}
                  />
                </Button>
              </div>
              <DetailRow
                icon={<UserRoundIcon className="size-3.5" />}
                label="Owner task"
                value={app.owner.taskTitle ?? 'Unknown task'}
              />
              <DetailRow
                icon={<FolderGit2Icon className="size-3.5" />}
                label="Workspace"
                value={workspaceLabel(app.owner.workspacePath)}
                title={app.owner.workspacePath ?? undefined}
              />
              <DetailRow
                icon={<FileCode2Icon className="size-3.5" />}
                label="Entry file"
                value={<code>{app.entryPath}</code>}
              />
              <DetailRow
                icon={<LayoutGridIcon className="size-3.5" />}
                label="Files"
                value={`${app.fileCount} · ${formatBytes(app.totalBytes)}`}
              />
              <DetailRow
                icon={<Clock3Icon className="size-3.5" />}
                label="Last updated"
                value={formatRelativeTime(app.updatedAt)}
              />
              <DetailRow
                icon={<ExternalLinkIcon className="size-3.5" />}
                label="Last opened"
                value={formatRelativeTime(app.lastOpenedAt)}
              />
            </SettingsPanel>

            <SettingsPanel className="p-4">
              <h2 className="font-semibold text-sm">Ownership boundary</h2>
              <p className="mt-1 text-token-text-secondary text-xs leading-5">
                Source files belong to the originating task. Library metadata
                such as last-opened time is local user state. Plugin apps are
                not included here.
              </p>
            </SettingsPanel>

            <SettingsPanel className="border-error-solid/12 p-4">
              <h2 className="font-semibold text-sm">Danger zone</h2>
              <p className="mt-1 text-token-text-secondary text-xs leading-5">
                Delete the local app files without removing the owner task or
                its conversation history.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 rounded-xl text-error"
                disabled={busy}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon className="size-3.5" />
                Delete generated app
              </Button>
            </SettingsPanel>
          </div>
        </div>
      </SettingsPage>

      <ConfirmationDialog
        kind="delete"
        app={deleteOpen ? app : null}
        busy={actionState?.kind === 'delete' && busy}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void confirmDelete()}
      />
      <GeneratedAppCapabilitiesDialog
        context={{
          kind: 'agent',
          agentId: app.owner.agentId,
          appId: app.appId,
        }}
        open={capabilitiesOpen}
        onOpenChange={setCapabilitiesOpen}
      />
      <ConfirmationDialog
        kind="regenerate"
        app={regenerateOpen ? app : null}
        busy={actionState?.kind === 'regenerate' && busy}
        onOpenChange={setRegenerateOpen}
        onConfirm={() => void confirmRegenerate()}
      />
    </div>
  );
}
