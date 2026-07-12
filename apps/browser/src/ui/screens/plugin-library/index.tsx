import { Button } from '@clodex/stage-ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clodex/stage-ui/components/dialog';
import { Input } from '@clodex/stage-ui/components/input';
import { Switch } from '@clodex/stage-ui/components/switch';
import {
  credentialTypeRegistry,
  extractSecretFieldNames,
  type CredentialTypeId,
} from '@shared/credential-types';
import type { PluginLibrarySnapshot } from '@shared/plugin-library';
import type { PluginMarketplacePermission } from '@shared/plugin-marketplace';
import { cn } from '@ui/utils';
import {
  ArrowLeftIcon,
  BlocksIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleOffIcon,
  DownloadIcon,
  Layers3Icon,
  LoaderCircleIcon,
  PackageCheckIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../settings/_components/settings-page';
import {
  createPluginLibraryItems,
  createPluginLibrarySkills,
  filterPluginLibraryItems,
  filterPluginLibrarySkills,
  getPluginLibrarySummary,
  type PluginLibraryFilters,
  type PluginLibraryItem,
  type PluginLibrarySourceFilter,
  type PluginLibraryStatusFilter,
} from './plugin-library-model';

export type PluginLibraryView = 'plugins' | 'skills';
export type PluginLibraryActionKind =
  | 'install'
  | 'update'
  | 'uninstall'
  | 'toggle'
  | 'credential';

export type PluginLibraryActionState = {
  kind: PluginLibraryActionKind;
  pluginId: string;
} | null;

export type PluginLibraryNotice = {
  tone: 'success' | 'error' | 'info';
  message: string;
} | null;

type MarketplaceAction = (
  kind: 'install' | 'update' | 'uninstall',
  pluginId: string,
) => void | Promise<void>;

const permissionDescriptions: Record<PluginMarketplacePermission, string> = {
  skills: 'Contributes agent skills and prompt capabilities.',
  apps: 'Can provide interactive mini-app surfaces.',
  mcp: 'Can register MCP servers, tools, prompts, or resources.',
  network: 'May communicate with declared external network services.',
  filesystem: 'May read or write files through approved agent tools.',
  credentials: 'May request access to explicitly configured credentials.',
  process: 'May launch an integrity-checked local extension runtime.',
};

function PluginIcon({
  item,
  className = 'size-6',
}: {
  item: Pick<PluginLibraryItem, 'logoSvg'>;
  className?: string;
}) {
  if (item.logoSvg) {
    return (
      <span
        className={cn(
          className,
          'block overflow-hidden text-token-text-secondary [&>svg]:size-full',
        )}
        dangerouslySetInnerHTML={{ __html: item.logoSvg }}
      />
    );
  }
  return <BlocksIcon className={className} />;
}

function NoticeBanner({ notice }: { notice: PluginLibraryNotice }) {
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm',
        notice.tone === 'error' &&
          'border-error-solid/20 bg-error-solid/6 text-error',
        notice.tone === 'success' &&
          'border-success-solid/20 bg-success-solid/6 text-success-foreground',
        notice.tone === 'info' &&
          'border-clodex-green-400/20 bg-clodex-green-400/6 text-token-text-secondary',
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

function MarketplaceStatus({
  snapshot,
  refreshing,
  onRefresh,
}: {
  snapshot: PluginLibrarySnapshot;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
}) {
  const state = snapshot.marketplace;
  const verified = state.enabled && state.status === 'ready' && !state.error;
  return (
    <SettingsPanel className="overflow-hidden">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl',
              verified
                ? 'bg-success-solid/10 text-success-foreground'
                : 'bg-token-bg-secondary text-token-text-tertiary',
            )}
          >
            <ShieldCheckIcon className="size-4.5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium text-sm text-token-text-primary">
                Signed official marketplace
              </h2>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-medium text-[10px] uppercase tracking-[0.05em]',
                  verified
                    ? 'bg-success-solid/10 text-success-foreground'
                    : 'bg-token-bg-tertiary text-token-text-tertiary',
                )}
              >
                {!state.enabled
                  ? 'Disabled'
                  : state.status === 'ready'
                    ? 'Verified'
                    : state.status === 'error'
                      ? 'Failed'
                      : 'Unavailable'}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-token-text-secondary text-xs leading-5">
              Packages are verified for signature, integrity, compatibility,
              permissions, and path safety before activation.
            </p>
            {state.error && (
              <p className="mt-1 text-error text-xs">{state.error}</p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={refreshing || !state.enabled}
          onClick={() => void onRefresh()}
        >
          <RefreshCwIcon
            className={cn('size-3.5', refreshing && 'animate-spin')}
          />
          Refresh catalog
        </Button>
      </div>
      {state.warnings.map((warning) => (
        <div
          key={warning}
          className="border-warning-solid/20 border-t bg-warning-solid/6 px-4 py-2.5 text-warning text-xs"
        >
          {warning}
        </div>
      ))}
    </SettingsPanel>
  );
}

function PluginActionButtons({
  item,
  actionState,
  onMarketplaceAction,
  onToggle,
}: {
  item: PluginLibraryItem;
  actionState: PluginLibraryActionState;
  onMarketplaceAction: MarketplaceAction;
  onToggle: (pluginId: string, enabled: boolean) => void | Promise<void>;
}) {
  const pending = actionState?.pluginId === item.id;
  if (!item.installed) {
    return (
      <Button
        variant="primary"
        size="sm"
        disabled={pending || !item.compatible}
        onClick={() => void onMarketplaceAction('install', item.id)}
      >
        {pending ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <DownloadIcon className="size-3.5" />
        )}
        Install
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {item.updateAvailable && (
        <Button
          variant="primary"
          size="sm"
          disabled={pending || !item.compatible}
          onClick={() => void onMarketplaceAction('update', item.id)}
        >
          {pending && actionState?.kind === 'update' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <DownloadIcon className="size-3.5" />
          )}
          Update
        </Button>
      )}
      <div className="flex items-center gap-2 rounded-lg border border-token-border-light bg-token-bg-secondary/45 px-2.5 py-1.5">
        <span className="text-token-text-tertiary text-xs">
          {item.enabled ? 'Enabled' : 'Disabled'}
        </span>
        <Switch
          checked={item.enabled}
          disabled={pending}
          size="xs"
          aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.displayName}`}
          onCheckedChange={(enabled) => void onToggle(item.id, enabled)}
        />
      </div>
    </div>
  );
}

function PluginCard({
  item,
  actionState,
  onOpen,
  onMarketplaceAction,
  onToggle,
}: {
  item: PluginLibraryItem;
  actionState: PluginLibraryActionState;
  onOpen: (pluginId: string) => void;
  onMarketplaceAction: MarketplaceAction;
  onToggle: (pluginId: string, enabled: boolean) => void | Promise<void>;
}) {
  return (
    <SettingsPanel
      interactive
      className="flex min-h-64 flex-col overflow-hidden"
    >
      <div className="flex items-start gap-3.5 p-5 pb-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-token-border-light bg-token-bg-secondary/65 text-token-text-secondary shadow-codex-hairline">
          <PluginIcon item={item} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button
                type="button"
                className="block max-w-full truncate text-left font-semibold text-base text-token-text-primary hover:text-clodex-green-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                onClick={() => onOpen(item.id)}
              >
                {item.displayName}
              </button>
              <p className="mt-0.5 font-mono text-[11px] text-token-text-tertiary">
                {item.id}
              </p>
            </div>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-medium text-[10px] uppercase tracking-[0.05em]',
                item.installed
                  ? item.enabled
                    ? 'bg-success-solid/10 text-success-foreground'
                    : 'bg-token-bg-tertiary text-token-text-tertiary'
                  : 'bg-clodex-green-400/9 text-clodex-green-400',
              )}
            >
              {item.installed
                ? item.enabled
                  ? 'Enabled'
                  : 'Disabled'
                : 'Available'}
            </span>
          </div>
        </div>
      </div>
      <p className="line-clamp-3 px-5 text-sm text-token-text-secondary leading-5">
        {item.description}
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5 px-5">
        <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[11px] text-token-text-tertiary">
          {item.source === 'bundled' ? 'Bundled' : 'Marketplace'}
        </span>
        {item.latestVersion && (
          <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[11px] text-token-text-tertiary">
            v{item.latestVersion}
          </span>
        )}
        {item.skills.length > 0 && (
          <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[11px] text-token-text-tertiary">
            {item.skills.length} {item.skills.length === 1 ? 'skill' : 'skills'}
          </span>
        )}
        {item.updateAvailable && (
          <span className="rounded-full bg-clodex-green-400/9 px-2 py-0.5 font-medium text-[11px] text-clodex-green-400">
            Update available
          </span>
        )}
      </div>
      {!item.compatible && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl border border-error-solid/18 bg-error-solid/6 px-3 py-2 text-error text-xs">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {item.compatibilityError ?? 'This plugin is not compatible.'}
        </div>
      )}
      <div className="mt-auto flex items-center gap-2 border-token-border-light border-t bg-token-bg-secondary/30 p-3">
        <Button variant="secondary" size="sm" onClick={() => onOpen(item.id)}>
          Details
        </Button>
        <div className="ml-auto">
          <PluginActionButtons
            item={item}
            actionState={actionState}
            onMarketplaceAction={onMarketplaceAction}
            onToggle={onToggle}
          />
        </div>
      </div>
    </SettingsPanel>
  );
}

function PluginLibrarySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="h-64 animate-pulse rounded-2xl border border-token-border-light bg-token-main-surface-primary/70 p-5"
        >
          <div className="flex gap-3">
            <div className="size-11 rounded-xl bg-token-bg-tertiary" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-2/5 rounded bg-token-bg-tertiary" />
              <div className="h-3 w-3/5 rounded bg-token-bg-secondary" />
            </div>
          </div>
          <div className="mt-5 h-14 rounded-xl bg-token-bg-secondary" />
          <div className="mt-4 h-7 w-1/2 rounded-lg bg-token-bg-secondary" />
        </div>
      ))}
    </div>
  );
}

export function PluginLibraryCatalog({
  snapshot,
  isLoading,
  error,
  notice,
  actionState,
  initialView = 'plugins',
  onRefresh,
  onOpenPlugin,
  onMarketplaceAction,
  onToggle,
}: {
  snapshot: PluginLibrarySnapshot | null;
  isLoading: boolean;
  error: string | null;
  notice: PluginLibraryNotice;
  actionState: PluginLibraryActionState;
  initialView?: PluginLibraryView;
  onRefresh: () => void | Promise<void>;
  onOpenPlugin: (pluginId: string) => void;
  onMarketplaceAction: MarketplaceAction;
  onToggle: (pluginId: string, enabled: boolean) => void | Promise<void>;
}) {
  const [view, setView] = useState<PluginLibraryView>(initialView);
  const [filters, setFilters] = useState<PluginLibraryFilters>({
    query: '',
    status: 'all',
    source: 'all',
  });
  const items = useMemo(
    () => (snapshot ? createPluginLibraryItems(snapshot) : []),
    [snapshot],
  );
  const summary = useMemo(() => getPluginLibrarySummary(items), [items]);
  const visiblePlugins = useMemo(
    () => filterPluginLibraryItems(items, filters),
    [filters, items],
  );
  const visibleSkills = useMemo(
    () =>
      filterPluginLibrarySkills(
        createPluginLibrarySkills(items),
        filters.query,
      ),
    [filters.query, items],
  );

  const toolbar = (
    <div className="space-y-3 rounded-2xl border border-token-border-light bg-token-main-surface-primary/68 p-3 shadow-codex-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div
          className="flex shrink-0 items-center rounded-xl bg-token-bg-secondary/75 p-1"
          role="group"
          aria-label="Library view"
        >
          {(
            [
              ['plugins', 'Plugins'],
              ['skills', 'Skills'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              className={cn(
                'h-7 rounded-lg px-3 font-medium text-xs transition-colors',
                view === value
                  ? 'bg-token-main-surface-primary text-token-text-primary shadow-codex-sm ring-1 ring-token-border-light'
                  : 'text-token-text-tertiary hover:text-token-text-primary',
              )}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-token-border-light bg-token-input-background px-3 focus-within:border-token-focus-border">
          <SearchIcon className="size-3.5 text-token-text-tertiary" />
          <input
            type="search"
            aria-label={`Search ${view}`}
            value={filters.query}
            onChange={(event) => {
              const query = event.currentTarget.value;
              setFilters((current) => ({
                ...current,
                query,
              }));
            }}
            placeholder={`Search ${view}, capabilities, and publishers…`}
            className="min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary"
          />
        </label>
      </div>
      {view === 'plugins' && (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Plugin status"
            value={filters.status}
            onChange={(event) => {
              const status = event.currentTarget
                .value as PluginLibraryStatusFilter;
              setFilters((current) => ({
                ...current,
                status,
              }));
            }}
            className="h-8 rounded-lg border border-token-border-light bg-token-bg-secondary/45 px-2.5 text-token-text-primary text-xs outline-none focus:border-token-focus-border"
          >
            <option value="all">All statuses</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
            <option value="updates">Updates</option>
            <option value="incompatible">Incompatible</option>
          </select>
          <select
            aria-label="Plugin source"
            value={filters.source}
            onChange={(event) => {
              const source = event.currentTarget
                .value as PluginLibrarySourceFilter;
              setFilters((current) => ({
                ...current,
                source,
              }));
            }}
            className="h-8 rounded-lg border border-token-border-light bg-token-bg-secondary/45 px-2.5 text-token-text-primary text-xs outline-none focus:border-token-focus-border"
          >
            <option value="all">All sources</option>
            <option value="bundled">Bundled</option>
            <option value="marketplace">Marketplace</option>
          </select>
        </div>
      )}
    </div>
  );

  return (
    <SettingsPage
      eyebrow="Extensions"
      title="Skills & Plugins"
      description="Discover verified capability bundles, inspect their permissions, and control exactly what agents can use."
      toolbar={toolbar}
      actions={
        <Button
          variant="secondary"
          size="sm"
          disabled={isLoading}
          onClick={() => void onRefresh()}
        >
          <RefreshCwIcon
            className={cn('size-3.5', isLoading && 'animate-spin')}
          />
          Refresh
        </Button>
      }
    >
      <div className="space-y-6">
        <NoticeBanner notice={notice} />
        {snapshot && (
          <MarketplaceStatus
            snapshot={snapshot}
            refreshing={isLoading}
            onRefresh={onRefresh}
          />
        )}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
          <SettingsSummaryCard
            label="Available"
            value={summary.total}
            icon={<BlocksIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Installed"
            value={summary.installed}
            icon={<PackageCheckIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Enabled"
            value={summary.enabled}
            icon={<CheckCircle2Icon className="size-4" />}
            accent
          />
          <SettingsSummaryCard
            label="Updates"
            value={summary.updates}
            icon={<DownloadIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Skills"
            value={summary.skills}
            icon={<SparklesIcon className="size-4" />}
          />
        </div>

        {isLoading && !snapshot ? (
          <PluginLibrarySkeleton />
        ) : error ? (
          <SettingsPanel className="flex flex-col items-center px-6 py-12 text-center">
            <CircleAlertIcon className="size-6 text-error" />
            <h2 className="mt-3 font-medium text-token-text-primary">
              Library unavailable
            </h2>
            <p className="mt-1 max-w-md text-sm text-token-text-secondary">
              {error}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              onClick={() => void onRefresh()}
            >
              Try again
            </Button>
          </SettingsPanel>
        ) : view === 'plugins' ? (
          visiblePlugins.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {visiblePlugins.map((item) => (
                <PluginCard
                  key={item.id}
                  item={item}
                  actionState={actionState}
                  onOpen={onOpenPlugin}
                  onMarketplaceAction={onMarketplaceAction}
                  onToggle={onToggle}
                />
              ))}
            </div>
          ) : (
            <EmptyResult label="No plugins match these filters." />
          )
        ) : visibleSkills.length > 0 ? (
          <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
            {visibleSkills.map((skill) => (
              <button
                key={skill.key}
                type="button"
                className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-token-list-hover-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:ring-inset"
                onClick={() => onOpenPlugin(skill.pluginId)}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-clodex-green-400/9 text-clodex-green-400">
                  <SparklesIcon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm text-token-text-primary">
                      {skill.name}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px]',
                        skill.pluginEnabled
                          ? 'bg-success-solid/10 text-success-foreground'
                          : 'bg-token-bg-tertiary text-token-text-tertiary',
                      )}
                    >
                      {skill.pluginEnabled ? 'Available to agents' : 'Disabled'}
                    </span>
                  </span>
                  <span className="mt-1 block text-token-text-secondary text-xs leading-5">
                    {skill.description}
                  </span>
                  <span className="mt-1.5 block text-[11px] text-token-text-tertiary">
                    From {skill.pluginName} · {skill.pluginSource}
                  </span>
                </span>
              </button>
            ))}
          </SettingsPanel>
        ) : (
          <EmptyResult label="No skills match this search." />
        )}
      </div>
    </SettingsPage>
  );
}

function EmptyResult({ label }: { label: string }) {
  return (
    <SettingsPanel className="flex flex-col items-center px-6 py-12 text-center">
      <SearchIcon className="size-5 text-token-text-tertiary" />
      <h2 className="mt-3 font-medium text-token-text-primary">{label}</h2>
      <p className="mt-1 text-sm text-token-text-secondary">
        Adjust the search term or filters and try again.
      </p>
    </SettingsPanel>
  );
}

function CredentialEditor({
  typeId,
  configured,
  busy,
  onSave,
  onDelete,
}: {
  typeId: CredentialTypeId;
  configured: boolean;
  busy: boolean;
  onSave: (typeId: string, data: Record<string, string>) => Promise<void>;
  onDelete: (typeId: string) => Promise<void>;
}) {
  const definition = credentialTypeRegistry[typeId];
  const fields = extractSecretFieldNames(
    definition.schema as z.ZodObject<z.ZodRawShape>,
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.every((field) => values[field]?.trim());

  return (
    <SettingsPanel className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm text-token-text-primary">
              {definition.displayName}
            </h3>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px]',
                configured
                  ? 'bg-success-solid/10 text-success-foreground'
                  : 'bg-token-bg-tertiary text-token-text-tertiary',
              )}
            >
              {configured ? 'Configured' : 'Required'}
            </span>
          </div>
          <p className="mt-1 max-w-xl text-token-text-secondary text-xs leading-5">
            {definition.description}
          </p>
        </div>
        {configured && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void onDelete(typeId)}
          >
            Clear
          </Button>
        )}
      </div>
      <div className="mt-3 grid gap-2">
        {fields.map((field) => {
          const fieldMetadata = definition.fieldMetadata as Record<
            string,
            | {
                description: string;
                helpText?: string;
                helpUrl?: string;
              }
            | undefined
          >;
          const metadata = fieldMetadata[field];
          return (
            <Input
              key={field}
              type="password"
              size="sm"
              aria-label={`${definition.displayName} ${metadata?.description ?? field}`}
              value={values[field] ?? ''}
              placeholder={
                configured
                  ? `Replace ${metadata?.description ?? field}`
                  : `Enter ${metadata?.description ?? field}`
              }
              disabled={busy}
              onValueChange={(value) =>
                setValues((current) => ({ ...current, [field]: value }))
              }
            />
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !complete}
          onClick={async () => {
            await onSave(typeId, values);
            setValues({});
          }}
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          {configured ? 'Replace credential' : 'Save credential'}
        </Button>
      </div>
    </SettingsPanel>
  );
}

export function PluginLibraryDetail({
  item,
  snapshot,
  isLoading,
  error,
  notice,
  actionState,
  onBack,
  onRefresh,
  onMarketplaceAction,
  onToggle,
  onSaveCredential,
  onDeleteCredential,
}: {
  item: PluginLibraryItem | null;
  snapshot: PluginLibrarySnapshot | null;
  isLoading: boolean;
  error: string | null;
  notice: PluginLibraryNotice;
  actionState: PluginLibraryActionState;
  onBack: () => void;
  onRefresh: () => void | Promise<void>;
  onMarketplaceAction: MarketplaceAction;
  onToggle: (pluginId: string, enabled: boolean) => void | Promise<void>;
  onSaveCredential: (
    typeId: string,
    data: Record<string, string>,
  ) => Promise<void>;
  onDeleteCredential: (typeId: string) => Promise<void>;
}) {
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const visibleCredentialIds =
    item?.requiredCredentials.filter(
      (typeId): typeId is CredentialTypeId =>
        typeId !== 'clodex-auth' && typeId in credentialTypeRegistry,
    ) ?? [];

  return (
    <SettingsPage
      eyebrow="Plugin detail"
      title={item?.displayName ?? 'Plugin'}
      description={
        item?.description ??
        (isLoading
          ? 'Loading plugin metadata…'
          : 'This plugin is not available in the current library.')
      }
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeftIcon className="size-3.5" />
            Skills & Plugins
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={isLoading}
            onClick={() => void onRefresh()}
          >
            <RefreshCwIcon
              className={cn('size-3.5', isLoading && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <NoticeBanner notice={notice} />
        {error && !item ? (
          <SettingsPanel className="p-6 text-center">
            <CircleAlertIcon className="mx-auto size-6 text-error" />
            <p className="mt-3 text-sm text-token-text-secondary">{error}</p>
          </SettingsPanel>
        ) : item && snapshot ? (
          <>
            <SettingsPanel className="p-5">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-token-border-light bg-token-bg-secondary/65 text-token-text-secondary shadow-codex-sm">
                  <PluginIcon item={item} className="size-9" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-token-text-tertiary">
                      {item.id}
                    </span>
                    <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[10px] text-token-text-tertiary">
                      {item.source}
                    </span>
                    {item.latestVersion && (
                      <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[10px] text-token-text-tertiary">
                        v{item.latestVersion}
                      </span>
                    )}
                    {item.publisher && (
                      <span className="text-token-text-tertiary text-xs">
                        by {item.publisher}
                      </span>
                    )}
                  </div>
                  <p className="mt-3 max-w-3xl text-sm text-token-text-secondary leading-6">
                    {item.description}
                  </p>
                  {!item.compatible && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-error-solid/18 bg-error-solid/6 px-3 py-2 text-error text-xs">
                      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                      {item.compatibilityError ??
                        'This plugin is not compatible with this version.'}
                    </div>
                  )}
                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <PluginActionButtons
                      item={item}
                      actionState={actionState}
                      onMarketplaceAction={onMarketplaceAction}
                      onToggle={onToggle}
                    />
                    {item.installed && item.source === 'marketplace' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-error"
                        disabled={actionState?.pluginId === item.id}
                        onClick={() => setUninstallOpen(true)}
                      >
                        <Trash2Icon className="size-3.5" />
                        Uninstall
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </SettingsPanel>

            <section className="space-y-3">
              <SettingsSectionHeader
                title="Permissions"
                description="Capabilities declared by the signed plugin manifest."
              />
              {item.permissions.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {item.permissions.map((permission) => (
                    <SettingsPanel key={permission} className="p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-clodex-green-400/9 text-clodex-green-400">
                          <ShieldCheckIcon className="size-4" />
                        </span>
                        <div>
                          <h3 className="font-medium text-sm text-token-text-primary capitalize">
                            {permission}
                          </h3>
                          <p className="mt-1 text-token-text-secondary text-xs leading-5">
                            {permissionDescriptions[permission]}
                          </p>
                        </div>
                      </div>
                    </SettingsPanel>
                  ))}
                </div>
              ) : (
                <SettingsPanel className="p-4 text-sm text-token-text-secondary">
                  No privileged capabilities are declared.
                </SettingsPanel>
              )}
            </section>

            <section className="space-y-3">
              <SettingsSectionHeader
                title="Skills"
                description="Agent-facing capabilities contributed by this plugin."
              />
              {item.skills.length > 0 ? (
                <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
                  {item.skills.map((skill) => (
                    <div
                      key={skill.name}
                      className="flex items-start gap-3 px-4 py-4"
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-clodex-green-400/9 text-clodex-green-400">
                        <SparklesIcon className="size-4" />
                      </span>
                      <div>
                        <h3 className="font-medium text-sm text-token-text-primary">
                          {skill.name}
                        </h3>
                        <p className="mt-1 text-token-text-secondary text-xs leading-5">
                          {skill.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </SettingsPanel>
              ) : (
                <SettingsPanel className="flex items-start gap-3 p-4">
                  <WrenchIcon className="mt-0.5 size-4 text-token-text-tertiary" />
                  <p className="text-sm text-token-text-secondary">
                    {item.installed
                      ? 'This plugin does not currently expose any skills.'
                      : 'Install the plugin to inspect its packaged skill metadata.'}
                  </p>
                </SettingsPanel>
              )}
            </section>

            {visibleCredentialIds.length > 0 && (
              <section className="space-y-3">
                <SettingsSectionHeader
                  title="Credentials"
                  description="Secrets remain encrypted locally and are only resolved for approved plugin operations."
                />
                <div className="space-y-3">
                  {visibleCredentialIds.map((typeId) => (
                    <CredentialEditor
                      key={typeId}
                      typeId={typeId}
                      configured={snapshot.configuredCredentialIds.includes(
                        typeId,
                      )}
                      busy={
                        actionState?.kind === 'credential' &&
                        actionState.pluginId === item.id
                      }
                      onSave={onSaveCredential}
                      onDelete={onDeleteCredential}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-3">
              <SettingsSectionHeader
                title="Installation"
                description="Local ownership and version state."
              />
              <SettingsPanel className="grid gap-4 p-4 sm:grid-cols-3">
                <DetailMetric
                  icon={<PackageCheckIcon className="size-4" />}
                  label="State"
                  value={item.installed ? 'Installed' : 'Not installed'}
                />
                <DetailMetric
                  icon={<Layers3Icon className="size-4" />}
                  label="Installed version"
                  value={item.installedVersion ?? '—'}
                />
                <DetailMetric
                  icon={
                    item.enabled ? (
                      <CheckCircle2Icon className="size-4" />
                    ) : (
                      <CircleOffIcon className="size-4" />
                    )
                  }
                  label="Agent access"
                  value={
                    item.installed
                      ? item.enabled
                        ? 'Enabled'
                        : 'Disabled'
                      : 'Unavailable'
                  }
                />
              </SettingsPanel>
            </section>
          </>
        ) : (
          <PluginLibrarySkeleton />
        )}
      </div>

      <Dialog open={uninstallOpen} onOpenChange={setUninstallOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {item?.displayName}?</DialogTitle>
            <DialogDescription>
              The marketplace-managed package will be removed. Stored
              credentials are preserved unless you clear them separately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUninstallOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!item) return;
                setUninstallOpen(false);
                void onMarketplaceAction('uninstall', item.id);
              }}
            >
              Uninstall plugin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}

function DetailMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-tertiary">
        {icon}
      </span>
      <div>
        <p className="text-[10px] text-token-text-tertiary uppercase tracking-[0.06em]">
          {label}
        </p>
        <p className="mt-1 font-medium text-sm text-token-text-primary">
          {value}
        </p>
      </div>
    </div>
  );
}
