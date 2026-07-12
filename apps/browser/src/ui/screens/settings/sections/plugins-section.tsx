import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import { useKartonState, useKartonProcedure } from '@ui/hooks/use-karton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@ui/utils';
import { Switch } from '@clodex/stage-ui/components/switch';
import { Input } from '@clodex/stage-ui/components/input';
import { Button, buttonVariants } from '@clodex/stage-ui/components/button';
import { produceWithPatches, enablePatches } from 'immer';
import type { PluginDefinition } from '@shared/plugins';
import type {
  PluginMarketplaceCatalogItem,
  PluginMarketplaceOperationResult,
  PluginMarketplaceState,
  PrivateMarketplaceOperationResult,
  PrivateMarketplaceSourceInput,
  PrivateMarketplaceSourcesState,
} from '@shared/plugin-marketplace';
import {
  credentialTypeRegistry,
  extractSecretFieldNames,
} from '@shared/credential-types';
import type { CredentialTypeId } from '@shared/credential-types';
import type { z } from 'zod';
import {
  IconPuzzlePieceOutline18,
  IconChevronRightOutline18,
  IconChevronLeftOutline18,
} from 'nucleo-ui-outline-18';
import {
  CheckCircle2Icon,
  CircleOffIcon,
  DownloadIcon,
  FingerprintIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

enablePatches();

function PluginIcon({
  logoSvg,
  className = 'size-7',
}: {
  logoSvg: string | null;
  className?: string;
}) {
  if (logoSvg) {
    return (
      <div
        className={cn(
          className,
          'overflow-hidden text-foreground [&>svg]:size-full',
        )}
        dangerouslySetInnerHTML={{ __html: logoSvg }}
      />
    );
  }
  return <IconPuzzlePieceOutline18 className={className} />;
}

function PluginCard({
  plugin,
  isEnabled,
  onOpenDetails,
  onToggle,
}: {
  plugin: PluginDefinition;
  isEnabled: boolean;
  onOpenDetails: () => void;
  onToggle: () => void;
}) {
  const pluginMetaText = useMemo(() => {
    let text = '';
    if (plugin.skills.length > 0)
      text += `${plugin.skills.length} ${plugin.skills.length === 1 ? 'skill' : 'skills'}`;

    if (plugin.requiredCredentials?.length > 0) {
      if (text.length > 0) text += ', ';
      text += 'credentials';
    }

    return text;
  }, [plugin.requiredCredentials, plugin.skills]);
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group flex min-h-28 cursor-pointer flex-col rounded-2xl border border-token-border-light bg-token-main-surface-primary/72 p-4 shadow-codex-sm outline-none transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-token-border-default hover:bg-token-main-surface-primary hover:shadow-codex-md focus-visible:ring-1 focus-visible:ring-token-focus-border',
        !isEnabled && 'opacity-80',
      )}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      <div className="flex h-full items-start justify-between gap-3">
        <div className="flex h-full min-w-0 flex-1 items-start gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-token-border-light bg-token-bg-secondary/65 text-token-text-secondary">
            <PluginIcon logoSvg={plugin.logoSvg} className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium text-sm text-token-text-primary">
                {plugin.displayName}
              </h3>
            </div>
            <p className="mt-1 line-clamp-2 text-token-text-secondary text-xs leading-5">
              {plugin.description}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {pluginMetaText && (
                <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[11px] text-token-text-tertiary">
                  {pluginMetaText}
                </span>
              )}
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-medium text-[11px]',
                  isEnabled
                    ? 'bg-codex-blue-400/9 text-codex-blue-400'
                    : 'bg-token-bg-tertiary text-token-text-tertiary',
                )}
              >
                {isEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={isEnabled}
            onCheckedChange={onToggle}
            size="xs"
            aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${plugin.displayName}`}
          />
          <IconChevronRightOutline18 className="size-3.5 text-token-text-tertiary transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
    </div>
  );
}

function CredentialFieldCard({
  typeId,
  isConfigured,
  onSave,
  onDelete,
}: {
  typeId: CredentialTypeId;
  isConfigured: boolean;
  onSave: (typeId: string, data: Record<string, string>) => Promise<void>;
  onDelete: (typeId: string) => Promise<void>;
}) {
  const typeDef = credentialTypeRegistry[typeId];
  if (!typeDef) return null;

  const secretFields = extractSecretFieldNames(
    typeDef.schema as z.ZodObject<z.ZodRawShape>,
  );
  if (secretFields.length === 0) return null;

  return (
    <SettingsPanel className="space-y-3 p-4">
      <div>
        <h3 className="font-medium text-sm text-token-text-primary">
          {typeDef.displayName}
        </h3>
        <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
          {typeDef.description}
        </p>
      </div>

      {secretFields.map((field) => (
        <CredentialFieldInput
          key={field}
          typeId={typeId}
          field={field}
          metadata={
            typeDef.fieldMetadata[field as keyof typeof typeDef.fieldMetadata]
          }
          isConfigured={isConfigured}
          onSave={onSave}
          onDelete={onDelete}
        />
      ))}
    </SettingsPanel>
  );
}

function CredentialFieldInput({
  typeId,
  field,
  metadata,
  isConfigured,
  onSave,
  onDelete,
}: {
  typeId: string;
  field: string;
  metadata?: { description: string; helpText?: string; helpUrl?: string };
  isConfigured: boolean;
  onSave: (typeId: string, data: Record<string, string>) => Promise<void>;
  onDelete: (typeId: string) => Promise<void>;
}) {
  const DOTS = '\u2022'.repeat(32);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const showDots = isConfigured && !inputValue;

  useEffect(() => {
    if (saved) {
      const timer = setTimeout(() => setSaved(false), 2_000);
      return () => clearTimeout(timer);
    }
  }, [saved]);

  const handleSave = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setIsSaving(true);
    try {
      await onSave(typeId, { [field]: trimmed });
      setInputValue('');
      setSaved(true);
    } finally {
      setIsSaving(false);
    }
  }, [inputValue, typeId, field, onSave]);

  const handleDelete = useCallback(async () => {
    await onDelete(typeId);
    setSaved(false);
  }, [typeId, onDelete]);

  const label = metadata?.description ?? field;

  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <Input
          ref={inputRef}
          type="password"
          value={showDots ? DOTS : inputValue}
          placeholder={
            isConfigured ? undefined : `Enter ${label.toLowerCase()}...`
          }
          onValueChange={(v) => {
            const newValue = v.replaceAll('\u2022', '');
            setInputValue(newValue);
            setSaved(false);
          }}
          onFocus={() => {
            if (showDots) {
              requestAnimationFrame(() => inputRef.current?.select());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && inputValue.trim()) {
              void handleSave();
            }
          }}
          onBlur={() => {
            if (inputValue.trim()) {
              void handleSave();
            }
          }}
          disabled={isSaving}
          size="sm"
          style={{ maxWidth: 'none' }}
          className="min-w-0 flex-1"
        />
        {inputValue ? (
          <Button
            variant="primary"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void handleSave()}
            disabled={isSaving}
          >
            Save
          </Button>
        ) : isConfigured ? (
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            Clear
          </Button>
        ) : null}
      </div>
      {metadata?.helpText && (
        <div className="text-subtle-foreground text-xs">
          {metadata.helpUrl ? (
            <div className="flex items-center gap-0">
              {metadata.helpText}
              <Tooltip>
                <TooltipTrigger>
                  <a
                    href={metadata.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      buttonVariants({ variant: 'link', size: 'xs' }),
                    )}
                  >
                    (Learn more)
                  </a>
                </TooltipTrigger>
                <TooltipContent>{metadata.helpUrl}</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            metadata.helpText
          )}
        </div>
      )}
    </div>
  );
}

function PluginDetailView({
  plugin,
  isEnabled,
  onToggle,
  onBack,
  configuredCredentialIds,
  setCredential,
  deleteCredential,
}: {
  plugin: PluginDefinition;
  isEnabled: boolean;
  onToggle: () => void;
  onBack: () => void;
  configuredCredentialIds: string[];
  setCredential: (
    typeId: string,
    data: Record<string, string>,
  ) => Promise<void>;
  deleteCredential: (typeId: string) => Promise<void>;
}) {
  const userVisibleCredentials = useMemo(
    () => plugin.requiredCredentials.filter((id) => id !== 'clodex-auth'),
    [plugin.requiredCredentials],
  );

  const pluginMetaText = useMemo(() => {
    const parts: string[] = [];
    if (plugin.skills.length > 0)
      parts.push(
        `${plugin.skills.length} ${plugin.skills.length === 1 ? 'skill' : 'skills'}`,
      );
    if (userVisibleCredentials.length > 0)
      parts.push(
        `${userVisibleCredentials.length} ${userVisibleCredentials.length === 1 ? 'credential' : 'credentials'}`,
      );
    return parts.join(', ');
  }, [plugin.skills, userVisibleCredentials]);

  return (
    <SettingsPage
      eyebrow="Plugin detail"
      title={plugin.displayName}
      description={plugin.description}
      actions={
        <Button variant="ghost" size="sm" onClick={onBack}>
          <IconChevronLeftOutline18 className="size-4" />
          All plugins
        </Button>
      }
    >
      <div className="space-y-7">
        <SettingsPanel className="p-5">
          <div className="flex items-start gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-token-border-light bg-token-bg-secondary/65 text-token-text-secondary shadow-codex-sm">
              <PluginIcon logoSvg={plugin.logoSvg} className="size-8" />
            </div>
            <div className="min-w-0 flex-1">
              <SettingsSectionHeader
                title={isEnabled ? 'Plugin enabled' : 'Plugin disabled'}
                description={
                  isEnabled
                    ? 'Its skills are available to the agent when relevant.'
                    : 'Enable it to expose its skills to the agent.'
                }
                trailing={
                  <div className="flex items-center gap-2">
                    <span className="text-token-text-tertiary text-xs">
                      {isEnabled ? 'On' : 'Off'}
                    </span>
                    <Switch
                      id="plugin-toggle"
                      checked={isEnabled}
                      onCheckedChange={onToggle}
                      size="sm"
                    />
                  </div>
                }
              />
              {pluginMetaText && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {plugin.skills.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2.5 py-1 text-token-text-secondary text-xs">
                      <SparklesIcon className="size-3.5" />
                      {plugin.skills.length}{' '}
                      {plugin.skills.length === 1 ? 'skill' : 'skills'}
                    </span>
                  )}
                  {userVisibleCredentials.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2.5 py-1 text-token-text-secondary text-xs">
                      <KeyRoundIcon className="size-3.5" />
                      {userVisibleCredentials.length}{' '}
                      {userVisibleCredentials.length === 1
                        ? 'credential'
                        : 'credentials'}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </SettingsPanel>

        {plugin.skills.length > 0 && (
          <section className="space-y-3">
            <SettingsSectionHeader
              title="Capabilities"
              description="Skills contributed by this plugin."
            />
            <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
              {plugin.skills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-start gap-3 px-4 py-3.5"
                >
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-codex-blue-400/9 text-codex-blue-400">
                    <SparklesIcon className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-token-text-primary">
                      {skill.name}
                    </p>
                    <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
                      {skill.description}
                    </p>
                  </div>
                </div>
              ))}
            </SettingsPanel>
          </section>
        )}

        {userVisibleCredentials.length > 0 && (
          <section className="space-y-3">
            <SettingsSectionHeader
              title="Credentials"
              description="Secrets stay in the encrypted credential store and are only exposed to this plugin when needed."
            />
            <div className="space-y-3">
              {userVisibleCredentials.map((typeId) => (
                <CredentialFieldCard
                  key={typeId}
                  typeId={typeId as CredentialTypeId}
                  isConfigured={configuredCredentialIds.includes(typeId)}
                  onSave={setCredential}
                  onDelete={deleteCredential}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </SettingsPage>
  );
}

type PluginFilter = 'all' | 'enabled' | 'disabled';

function formatMarketplaceTime(value: number | null): string {
  if (value === null) return 'Unknown';
  return new Date(value).toLocaleString();
}

function confirmMarketplacePermissionReview(
  item: PluginMarketplaceCatalogItem,
  operation: 'install' | 'update',
): boolean {
  const { manifest } = item;
  const lines = [
    `${operation === 'install' ? 'Install' : 'Update'} ${manifest.displayName} v${manifest.version}?`,
    '',
    `Publisher: ${manifest.publisher}`,
    `Package SHA-256: ${item.sha256}`,
    `Permissions: ${manifest.permissions.join(', ') || 'none'}`,
  ];

  if ((manifest.mcpServers ?? []).length > 0) {
    lines.push('', 'MCP servers:');
    for (const server of manifest.mcpServers ?? []) {
      lines.push(
        server.transport === 'stdio'
          ? `• ${server.displayName} — local runtime ${server.runtimeId}`
          : `• ${server.displayName} — ${new URL(server.endpoint).origin} (${server.authentication})`,
      );
    }
  }

  if (manifest.permissions.includes('process')) {
    lines.push(
      '',
      'HIGH-RISK PERMISSION: this plugin can start signed local processes.',
    );
    const runtimes = manifest.executableRuntimes ?? [];
    if (runtimes.length === 0) {
      lines.push(
        'Runtime details are not listed; integrity is still verified before activation.',
      );
    } else {
      lines.push('Executable runtimes:');
      for (const runtime of runtimes) {
        lines.push(
          `• ${runtime.id} — ${runtime.platforms.join('/')} ${runtime.architectures.join('/')} · ${runtime.limits.maxMemoryMb} MB · ${runtime.limits.requestTimeoutMs} ms timeout`,
          `  SHA-256: ${runtime.sha256}`,
        );
      }
    }
  }

  lines.push(
    '',
    'MCP servers remain disabled until explicitly enabled in MCP settings.',
  );
  return window.confirm(lines.join('\n'));
}

function MarketplacePanel({
  state,
  loading,
  pendingPluginId,
  message,
  onRefresh,
  onInstall,
  onUpdate,
  onUninstall,
}: {
  state: PluginMarketplaceState | null;
  loading: boolean;
  pendingPluginId: string | null;
  message: string | null;
  onRefresh: () => Promise<void>;
  onInstall: (pluginId: string) => Promise<void>;
  onUpdate: (pluginId: string) => Promise<void>;
  onUninstall: (pluginId: string) => Promise<void>;
}) {
  const statusLabel = !state
    ? 'Loading'
    : !state.enabled
      ? 'Gate disabled'
      : state.status === 'ready'
        ? 'Verified'
        : state.status === 'error'
          ? 'Verification failed'
          : 'Unavailable';

  return (
    <section className="space-y-3">
      <SettingsSectionHeader
        title="Signed marketplace"
        description="Install official plugins only after signature, compatibility, permission, and integrity verification."
        trailing={
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || !state?.enabled}
            onClick={() => void onRefresh()}
          >
            <RefreshCwIcon
              className={cn('size-3.5', loading && 'animate-spin')}
            />
            Refresh
          </Button>
        }
      />
      <SettingsPanel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-token-border-light border-b px-4 py-3.5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ShieldCheckIcon className="size-4.5" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-sm text-token-text-primary">
                  Official catalog
                </h3>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-medium text-[11px]',
                    state?.enabled && state.status === 'ready'
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-token-bg-tertiary text-token-text-tertiary',
                  )}
                >
                  {statusLabel}
                </span>
              </div>
              <p className="mt-1 text-token-text-tertiary text-xs">
                Key {state?.keyId ?? 'not verified'} · generated{' '}
                {formatMarketplaceTime(state?.generatedAt ?? null)} · expires{' '}
                {formatMarketplaceTime(state?.expiresAt ?? null)}
              </p>
            </div>
          </div>
        </div>

        {!state?.enabled ? (
          <div className="px-4 py-5 text-sm text-token-text-secondary">
            Enable the experimental <strong>Plugin Marketplace</strong> feature
            gate to install or change marketplace plugins. Existing lockfile
            state remains read-only.
          </div>
        ) : state.error ? (
          <div className="px-4 py-5">
            <p className="font-medium text-destructive text-sm">
              Catalog verification failed
            </p>
            <p className="mt-1 text-token-text-secondary text-xs">
              {state.error}
            </p>
          </div>
        ) : state.catalog.length === 0 ? (
          <div className="px-4 py-5 text-sm text-token-text-secondary">
            No plugins are available in the verified catalog.
          </div>
        ) : (
          <div className="divide-y divide-token-border-light">
            {state.catalog.map((item) => {
              const pending = pendingPluginId === item.manifest.id;
              return (
                <div
                  key={item.manifest.id}
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-sm text-token-text-primary">
                        {item.manifest.displayName}
                      </h4>
                      <span className="text-token-text-tertiary text-xs">
                        v{item.manifest.version}
                      </span>
                      {item.installedVersion && (
                        <span className="rounded-full bg-codex-blue-400/9 px-2 py-0.5 font-medium text-[11px] text-codex-blue-400">
                          Installed v{item.installedVersion}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 max-w-2xl text-token-text-secondary text-xs leading-5">
                      {item.manifest.description}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-token-text-tertiary">
                        {item.manifest.publisher}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 font-medium text-[11px]',
                          item.publisherVerified
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-token-bg-tertiary text-token-text-tertiary',
                        )}
                      >
                        {item.publisherVerified
                          ? `Publisher signed · ${item.publisherKeyId}`
                          : 'Catalog signed'}
                      </span>
                      {item.manifest.permissions.map((permission) => (
                        <span
                          key={permission}
                          className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[11px] text-token-text-tertiary"
                        >
                          {permission}
                        </span>
                      ))}
                      {!item.compatible && (
                        <span className="text-[11px] text-destructive">
                          {item.compatibilityError}
                        </span>
                      )}
                    </div>
                    {(item.manifest.mcpServers?.length ?? 0) > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {item.manifest.mcpServers?.map((server) => (
                          <div
                            key={server.id}
                            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-token-text-tertiary"
                          >
                            <span className="font-medium text-token-text-secondary">
                              MCP: {server.displayName}
                            </span>
                            <span>
                              {server.transport === 'stdio'
                                ? `runtime:${server.runtimeId}`
                                : new URL(server.endpoint).origin}
                            </span>
                            <span>{server.transport}</span>
                            <span>auth: {server.authentication}</span>
                          </div>
                        ))}
                        <p className="text-[11px] text-token-text-tertiary">
                          Installed MCP servers remain disabled until you enable
                          them in MCP settings.
                        </p>
                      </div>
                    )}
                    {item.manifest.permissions.includes('process') && (
                      <div className="mt-2 rounded-lg border border-warning-solid/20 bg-warning-solid/7 p-2.5 text-[11px] text-token-text-secondary">
                        <p className="font-medium text-warning-solid">
                          Executable extension
                        </p>
                        {(item.manifest.executableRuntimes ?? []).length > 0 ? (
                          item.manifest.executableRuntimes?.map((runtime) => (
                            <p key={runtime.id} className="mt-1 font-mono">
                              {runtime.id} · {runtime.platforms.join('/')} ·{' '}
                              {runtime.architectures.join('/')} ·{' '}
                              {runtime.limits.maxMemoryMb} MB ·{' '}
                              {runtime.limits.requestTimeoutMs} ms
                            </p>
                          ))
                        ) : (
                          <p className="mt-1">
                            Runtime hash and limits will be verified during
                            installation.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.installedVersion ? (
                      <>
                        {item.updateAvailable && (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={pending || !item.compatible}
                            onClick={() => {
                              if (
                                !confirmMarketplacePermissionReview(
                                  item,
                                  'update',
                                )
                              ) {
                                return;
                              }
                              void onUpdate(item.manifest.id);
                            }}
                          >
                            <DownloadIcon className="size-3.5" />
                            Update
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => void onUninstall(item.manifest.id)}
                        >
                          <Trash2Icon className="size-3.5" />
                          Uninstall
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={pending || !item.compatible}
                        onClick={() => {
                          if (
                            !confirmMarketplacePermissionReview(item, 'install')
                          ) {
                            return;
                          }
                          void onInstall(item.manifest.id);
                        }}
                      >
                        <DownloadIcon className="size-3.5" />
                        Install
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {state?.warnings.map((warning) => (
          <div
            key={warning}
            className="border-amber-500/20 border-t bg-amber-500/6 px-4 py-2.5 text-amber-700 text-xs dark:text-amber-300"
          >
            {warning}
          </div>
        ))}

        {message && (
          <div className="border-token-border-light border-t bg-token-bg-secondary/45 px-4 py-2.5 text-token-text-secondary text-xs">
            {message}
          </div>
        )}
      </SettingsPanel>
    </section>
  );
}

const EMPTY_PRIVATE_SOURCE_DRAFT: PrivateMarketplaceSourceInput = {
  id: '',
  displayName: '',
  indexUrl: '',
  signingKeyId: '',
  signingPublicKey: '',
  enabled: true,
};

function PrivateMarketplacePanel({
  state,
  loading,
  pending,
  message,
  onSave,
  onRemove,
  onSetEnabled,
  onRefresh,
  onInstall,
  onUpdate,
  onUninstall,
}: {
  state: PrivateMarketplaceSourcesState | null;
  loading: boolean;
  pending: string | null;
  message: string | null;
  onSave: (input: PrivateMarketplaceSourceInput) => Promise<void>;
  onRemove: (sourceId: string) => Promise<void>;
  onSetEnabled: (sourceId: string, enabled: boolean) => Promise<void>;
  onRefresh: (sourceId: string) => Promise<void>;
  onInstall: (sourceId: string, pluginId: string) => Promise<void>;
  onUpdate: (sourceId: string, pluginId: string) => Promise<void>;
  onUninstall: (sourceId: string, pluginId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PrivateMarketplaceSourceInput>(
    EMPTY_PRIVATE_SOURCE_DRAFT,
  );
  const [showForm, setShowForm] = useState(false);
  const canSubmit =
    draft.id.trim().length > 0 &&
    draft.displayName.trim().length > 0 &&
    draft.indexUrl.trim().length > 0 &&
    draft.signingKeyId.trim().length > 0 &&
    draft.signingPublicKey.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    await onSave({
      ...draft,
      id: draft.id.trim(),
      displayName: draft.displayName.trim(),
      indexUrl: draft.indexUrl.trim(),
      signingKeyId: draft.signingKeyId.trim(),
      signingPublicKey: draft.signingPublicKey.trim(),
    });
    setDraft(EMPTY_PRIVATE_SOURCE_DRAFT);
    setShowForm(false);
  };

  return (
    <section className="space-y-3">
      <SettingsSectionHeader
        title="Private marketplaces"
        description="Add HTTPS catalogs only with an explicitly pinned Ed25519 public key. Clodex never trusts a key learned from the network."
        trailing={
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || !state?.enabled}
            onClick={() => setShowForm((value) => !value)}
          >
            <PlusIcon className="size-3.5" />
            Add source
          </Button>
        }
      />

      {showForm && (
        <SettingsPanel className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label
              htmlFor="private-marketplace-source-id"
              className="space-y-1 text-token-text-secondary text-xs"
            >
              <span>Source ID</span>
              <Input
                id="private-marketplace-source-id"
                value={draft.id}
                placeholder="engineering"
                onChange={(event) =>
                  setDraft((value) => ({ ...value, id: event.target.value }))
                }
              />
            </label>
            <label
              htmlFor="private-marketplace-display-name"
              className="space-y-1 text-token-text-secondary text-xs"
            >
              <span>Display name</span>
              <Input
                id="private-marketplace-display-name"
                value={draft.displayName}
                placeholder="Engineering Marketplace"
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    displayName: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          <label
            htmlFor="private-marketplace-index-url"
            className="block space-y-1 text-token-text-secondary text-xs"
          >
            <span>Signed index URL</span>
            <Input
              id="private-marketplace-index-url"
              value={draft.indexUrl}
              placeholder="https://plugins.example.com/clodex/index.json"
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  indexUrl: event.target.value,
                }))
              }
            />
          </label>
          <label
            htmlFor="private-marketplace-signing-key-id"
            className="block space-y-1 text-token-text-secondary text-xs"
          >
            <span>Signing key ID</span>
            <Input
              id="private-marketplace-signing-key-id"
              value={draft.signingKeyId}
              placeholder="engineering-2026-01"
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  signingKeyId: event.target.value,
                }))
              }
            />
          </label>
          <label className="block space-y-1 text-token-text-secondary text-xs">
            <span>Pinned Ed25519 public key (PEM)</span>
            <textarea
              value={draft.signingPublicKey}
              rows={5}
              spellCheck={false}
              placeholder={
                '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'
              }
              className="w-full resize-y rounded-xl border border-token-border-light bg-token-input-background px-3 py-2 font-mono text-token-text-primary text-xs outline-none transition-colors placeholder:text-token-text-tertiary focus:border-token-focus-border"
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  signingPublicKey: event.target.value,
                }))
              }
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(EMPTY_PRIVATE_SOURCE_DRAFT);
                setShowForm(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSubmit || pending === 'save'}
              onClick={() => void submit()}
            >
              Save pinned source
            </Button>
          </div>
        </SettingsPanel>
      )}

      {!state?.enabled ? (
        <SettingsPanel className="px-4 py-5 text-sm text-token-text-secondary">
          Enable the experimental <strong>Plugin Marketplace</strong> feature
          gate to manage private sources.
        </SettingsPanel>
      ) : state.sources.length === 0 ? (
        <SettingsPanel className="px-4 py-7 text-center text-sm text-token-text-secondary">
          No private marketplace sources are configured.
        </SettingsPanel>
      ) : (
        <div className="space-y-3">
          {state.sources.map((source) => {
            const sourcePending = pending?.startsWith(`${source.id}:`) ?? false;
            const statusLabel = !source.enabled
              ? 'Disabled'
              : source.status === 'ready'
                ? 'Verified'
                : source.status === 'error'
                  ? 'Verification failed'
                  : 'Not refreshed';
            return (
              <SettingsPanel key={source.id} className="overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-sm text-token-text-primary">
                        {source.displayName}
                      </h3>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 font-medium text-[11px]',
                          source.enabled && source.status === 'ready'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : source.status === 'error'
                              ? 'bg-destructive/10 text-destructive'
                              : 'bg-token-bg-tertiary text-token-text-tertiary',
                        )}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <p className="mt-1 break-all text-token-text-secondary text-xs">
                      {source.indexUrl}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-token-text-tertiary">
                      <span>Key {source.signingKeyId}</span>
                      <span className="flex items-center gap-1 font-mono">
                        <FingerprintIcon className="size-3" />
                        {source.signingKeyFingerprint}
                      </span>
                      <span>
                        expires {formatMarketplaceTime(source.expiresAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      size="xs"
                      checked={source.enabled}
                      disabled={sourcePending}
                      onCheckedChange={(enabled) =>
                        void onSetEnabled(source.id, enabled)
                      }
                      aria-label={`${source.enabled ? 'Disable' : 'Enable'} ${source.displayName}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!source.enabled || sourcePending}
                      onClick={() => void onRefresh(source.id)}
                    >
                      <RefreshCwIcon
                        className={cn(
                          'size-3.5',
                          pending === `${source.id}:refresh` && 'animate-spin',
                        )}
                      />
                      Verify
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={sourcePending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${source.displayName}? Installed plugins must be uninstalled first.`,
                          )
                        ) {
                          void onRemove(source.id);
                        }
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {source.error && (
                  <div className="border-token-border-light border-t bg-destructive/5 px-4 py-2.5 text-destructive text-xs">
                    {source.error}
                  </div>
                )}

                {source.status === 'ready' && source.catalog.length === 0 && (
                  <div className="border-token-border-light border-t px-4 py-4 text-token-text-secondary text-xs">
                    The verified index contains no plugins.
                  </div>
                )}

                {source.catalog.length > 0 && (
                  <div className="divide-y divide-token-border-light border-token-border-light border-t">
                    {source.catalog.map((item) => {
                      const pluginPending =
                        pending === `${source.id}:plugin:${item.manifest.id}`;
                      return (
                        <div
                          key={item.manifest.id}
                          className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="font-medium text-sm text-token-text-primary">
                                {item.manifest.displayName}
                              </h4>
                              <span className="text-token-text-tertiary text-xs">
                                v{item.manifest.version}
                              </span>
                              {item.installedVersion && (
                                <span className="rounded-full bg-codex-blue-400/9 px-2 py-0.5 font-medium text-[11px] text-codex-blue-400">
                                  Installed v{item.installedVersion}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 max-w-2xl text-token-text-secondary text-xs leading-5">
                              {item.manifest.description}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="text-token-text-tertiary">
                                {item.manifest.publisher}
                              </span>
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 font-medium',
                                  item.publisherVerified
                                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                    : 'bg-token-bg-tertiary text-token-text-tertiary',
                                )}
                              >
                                {item.publisherVerified
                                  ? `Publisher signed · ${item.publisherKeyId}`
                                  : 'Source catalog signed'}
                              </span>
                              {item.manifest.permissions.map((permission) => (
                                <span
                                  key={permission}
                                  className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-token-text-tertiary"
                                >
                                  {permission}
                                </span>
                              ))}
                              {!item.compatible && (
                                <span className="text-destructive">
                                  {item.compatibilityError}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {item.installedVersion ? (
                              <>
                                {item.updateAvailable && (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    disabled={pluginPending || !item.compatible}
                                    onClick={() =>
                                      void onUpdate(source.id, item.manifest.id)
                                    }
                                  >
                                    <DownloadIcon className="size-3.5" />
                                    Update
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={pluginPending}
                                  onClick={() =>
                                    void onUninstall(
                                      source.id,
                                      item.manifest.id,
                                    )
                                  }
                                >
                                  <Trash2Icon className="size-3.5" />
                                  Uninstall
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={
                                  pluginPending ||
                                  !source.enabled ||
                                  !item.compatible
                                }
                                onClick={() => {
                                  const mcpServers =
                                    item.manifest.mcpServers ?? [];
                                  if (
                                    !window.confirm(
                                      [
                                        `Install ${item.manifest.displayName} from ${source.displayName}?`,
                                        '',
                                        `Pinned source key: ${source.signingKeyId}`,
                                        `Fingerprint: ${source.signingKeyFingerprint}`,
                                        ...(mcpServers.length
                                          ? [
                                              '',
                                              'This plugin declares MCP network access:',
                                              ...mcpServers.map(
                                                (server) =>
                                                  `• ${server.displayName} — ${new URL(server.endpoint).origin} (${server.authentication})`,
                                              ),
                                              '',
                                              'MCP servers remain disabled until you enable them in MCP settings.',
                                            ]
                                          : []),
                                      ].join('\n'),
                                    )
                                  ) {
                                    return;
                                  }
                                  void onInstall(source.id, item.manifest.id);
                                }}
                              >
                                <DownloadIcon className="size-3.5" />
                                Install
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SettingsPanel>
            );
          })}
        </div>
      )}

      {message && (
        <SettingsPanel className="px-4 py-2.5 text-token-text-secondary text-xs">
          {message}
        </SettingsPanel>
      )}
    </section>
  );
}

export function PluginsSection() {
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const getConfiguredCredentialIds = useKartonProcedure(
    (p) => p.credentials.getConfiguredIds,
  );
  const [configuredCredentialIds, setConfiguredCredentialIds] = useState<
    string[]
  >([]);

  useEffect(() => {
    getConfiguredCredentialIds().then(setConfiguredCredentialIds);
  }, [getConfiguredCredentialIds]);
  const setCredential = useKartonProcedure((p) => p.credentials.set);
  const deleteCredential = useKartonProcedure((p) => p.credentials.delete);
  const getMarketplaceState = useKartonProcedure(
    (p) => p.pluginMarketplace.getState,
  );
  const refreshMarketplace = useKartonProcedure(
    (p) => p.pluginMarketplace.refresh,
  );
  const installMarketplacePlugin = useKartonProcedure(
    (p) => p.pluginMarketplace.install,
  );
  const updateMarketplacePlugin = useKartonProcedure(
    (p) => p.pluginMarketplace.update,
  );
  const uninstallMarketplacePlugin = useKartonProcedure(
    (p) => p.pluginMarketplace.uninstall,
  );
  const listPrivateMarketplaceSources = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.list,
  );
  const savePrivateMarketplaceSource = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.save,
  );
  const removePrivateMarketplaceSource = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.remove,
  );
  const setPrivateMarketplaceSourceEnabled = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.setEnabled,
  );
  const refreshPrivateMarketplaceSource = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.refresh,
  );
  const installPrivateMarketplacePlugin = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.install,
  );
  const updatePrivateMarketplacePlugin = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.update,
  );
  const uninstallPrivateMarketplacePlugin = useKartonProcedure(
    (p) => p.pluginMarketplace.privateSources.uninstall,
  );
  const [marketplaceState, setMarketplaceState] =
    useState<PluginMarketplaceState | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(true);
  const [pendingMarketplacePluginId, setPendingMarketplacePluginId] = useState<
    string | null
  >(null);
  const [marketplaceMessage, setMarketplaceMessage] = useState<string | null>(
    null,
  );
  const [privateMarketplaceState, setPrivateMarketplaceState] =
    useState<PrivateMarketplaceSourcesState | null>(null);
  const [privateMarketplaceLoading, setPrivateMarketplaceLoading] =
    useState(true);
  const [privateMarketplacePending, setPrivateMarketplacePending] = useState<
    string | null
  >(null);
  const [privateMarketplaceMessage, setPrivateMarketplaceMessage] = useState<
    string | null
  >(null);

  const handleSetCredential = useCallback(
    async (typeId: string, data: Record<string, string>) => {
      await setCredential(typeId, data);
      setConfiguredCredentialIds(await getConfiguredCredentialIds());
    },
    [setCredential, getConfiguredCredentialIds],
  );

  const handleDeleteCredential = useCallback(
    async (typeId: string) => {
      await deleteCredential(typeId);
      setConfiguredCredentialIds(await getConfiguredCredentialIds());
    },
    [deleteCredential, getConfiguredCredentialIds],
  );

  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PluginFilter>('all');

  const loadMarketplaceState = useCallback(async () => {
    setMarketplaceLoading(true);
    try {
      setMarketplaceState(await getMarketplaceState());
    } catch (error) {
      setMarketplaceMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setMarketplaceLoading(false);
    }
  }, [getMarketplaceState]);

  useEffect(() => {
    void loadMarketplaceState();
  }, [loadMarketplaceState]);

  const loadPrivateMarketplaceState = useCallback(async () => {
    setPrivateMarketplaceLoading(true);
    try {
      setPrivateMarketplaceState(await listPrivateMarketplaceSources());
    } catch (error) {
      setPrivateMarketplaceMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPrivateMarketplaceLoading(false);
    }
  }, [listPrivateMarketplaceSources]);

  useEffect(() => {
    void loadPrivateMarketplaceState();
  }, [loadPrivateMarketplaceState]);

  const handleMarketplaceRefresh = useCallback(async () => {
    setMarketplaceLoading(true);
    setMarketplaceMessage(null);
    try {
      setMarketplaceState(await refreshMarketplace());
      setMarketplaceMessage('Official catalog signature verified.');
    } catch (error) {
      setMarketplaceMessage(
        error instanceof Error ? error.message : String(error),
      );
      setMarketplaceState(await getMarketplaceState().catch(() => null));
    } finally {
      setMarketplaceLoading(false);
    }
  }, [getMarketplaceState, refreshMarketplace]);

  const runMarketplaceOperation = useCallback(
    async (
      pluginId: string,
      operation: (id: string) => Promise<PluginMarketplaceOperationResult>,
    ) => {
      setPendingMarketplacePluginId(pluginId);
      setMarketplaceMessage(null);
      try {
        const result = await operation(pluginId);
        setMarketplaceState(result.state);
        setPrivateMarketplaceState(
          await listPrivateMarketplaceSources().catch(() => null),
        );
        setMarketplaceMessage(
          result.ok
            ? `${result.operation} completed for ${pluginId}.`
            : `${result.error}${result.rolledBack ? ' Previous version restored.' : ''}`,
        );
      } catch (error) {
        setMarketplaceMessage(
          error instanceof Error ? error.message : String(error),
        );
        setMarketplaceState(await getMarketplaceState().catch(() => null));
      } finally {
        setPendingMarketplacePluginId(null);
      }
    },
    [getMarketplaceState, listPrivateMarketplaceSources],
  );

  const runPrivateMarketplaceAction = useCallback(
    async (
      pendingKey: string,
      action: () => Promise<void>,
      successMessage: string,
    ) => {
      setPrivateMarketplacePending(pendingKey);
      setPrivateMarketplaceMessage(null);
      try {
        await action();
        setPrivateMarketplaceState(await listPrivateMarketplaceSources());
        setPrivateMarketplaceMessage(successMessage);
      } catch (error) {
        setPrivateMarketplaceMessage(
          error instanceof Error ? error.message : String(error),
        );
        setPrivateMarketplaceState(
          await listPrivateMarketplaceSources().catch(() => null),
        );
      } finally {
        setPrivateMarketplacePending(null);
      }
    },
    [listPrivateMarketplaceSources],
  );

  const runPrivateMarketplaceOperation = useCallback(
    async (
      sourceId: string,
      pluginId: string,
      operation: (
        sourceId: string,
        pluginId: string,
      ) => Promise<PrivateMarketplaceOperationResult>,
    ) => {
      const pendingKey = `${sourceId}:plugin:${pluginId}`;
      setPrivateMarketplacePending(pendingKey);
      setPrivateMarketplaceMessage(null);
      try {
        const result = await operation(sourceId, pluginId);
        setPrivateMarketplaceState(result.state);
        setMarketplaceState(await getMarketplaceState().catch(() => null));
        setPrivateMarketplaceMessage(
          result.ok
            ? `${result.operation} completed for ${pluginId}.`
            : `${result.error}${result.rolledBack ? ' Previous version restored.' : ''}`,
        );
      } catch (error) {
        setPrivateMarketplaceMessage(
          error instanceof Error ? error.message : String(error),
        );
        setPrivateMarketplaceState(
          await listPrivateMarketplaceSources().catch(() => null),
        );
      } finally {
        setPrivateMarketplacePending(null);
      }
    },
    [getMarketplaceState, listPrivateMarketplaceSources],
  );

  const disabledPluginIds = useMemo(
    () => new Set(preferences?.agent.disabledPluginIds ?? []),
    [preferences?.agent.disabledPluginIds],
  );

  const plugins = useKartonState((s) => s.plugins);

  const enabledPlugins = useMemo(() => {
    return plugins.filter((plugin) => !disabledPluginIds.has(plugin.id));
  }, [plugins, disabledPluginIds]);

  const disabledPlugins = useMemo(() => {
    return plugins.filter((plugin) => disabledPluginIds.has(plugin.id));
  }, [plugins, disabledPluginIds]);

  const visiblePlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return plugins
      .filter((plugin) => {
        const isEnabled = !disabledPluginIds.has(plugin.id);
        if (filter === 'enabled' && !isEnabled) return false;
        if (filter === 'disabled' && isEnabled) return false;
        if (!normalizedQuery) return true;

        return (
          plugin.displayName.toLocaleLowerCase().includes(normalizedQuery) ||
          plugin.description.toLocaleLowerCase().includes(normalizedQuery) ||
          plugin.skills.some(
            (skill) =>
              skill.name.toLocaleLowerCase().includes(normalizedQuery) ||
              skill.description.toLocaleLowerCase().includes(normalizedQuery),
          )
        );
      })
      .sort((a, b) => {
        const enabledDelta =
          Number(disabledPluginIds.has(a.id)) -
          Number(disabledPluginIds.has(b.id));

        return (
          enabledDelta ||
          a.displayName.localeCompare(b.displayName, undefined, {
            sensitivity: 'base',
          })
        );
      });
  }, [disabledPluginIds, filter, plugins, query]);

  const totalSkills = useMemo(
    () => plugins.reduce((count, plugin) => count + plugin.skills.length, 0),
    [plugins],
  );

  const handleTogglePlugin = useCallback(
    async (pluginId: string) => {
      const [, patches] = produceWithPatches(preferences, (draft) => {
        const idx = draft.agent.disabledPluginIds.indexOf(pluginId);
        if (idx === -1) {
          draft.agent.disabledPluginIds.push(pluginId);
        } else {
          draft.agent.disabledPluginIds.splice(idx, 1);
        }
      });
      await updatePreferences(patches);
    },
    [preferences, updatePreferences],
  );

  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  );

  if (selectedPlugin) {
    return (
      <PluginDetailView
        plugin={selectedPlugin}
        isEnabled={!disabledPluginIds.has(selectedPlugin.id)}
        onToggle={() => handleTogglePlugin(selectedPlugin.id)}
        onBack={() => setSelectedPluginId(null)}
        configuredCredentialIds={configuredCredentialIds}
        setCredential={handleSetCredential}
        deleteCredential={handleDeleteCredential}
      />
    );
  }

  return (
    <SettingsPage
      eyebrow="Extensions"
      title="Plugins"
      description="Manage local capability bundles, their skills, and the credentials they are allowed to use."
      toolbar={
        <div className="flex flex-col gap-3 rounded-2xl border border-token-border-light bg-token-main-surface-primary/68 p-3 shadow-codex-sm sm:flex-row sm:items-center">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-token-border-light bg-token-input-background px-3 transition-colors focus-within:border-token-focus-border">
            <SearchIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search plugins and skills…"
              className="min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary"
            />
          </label>
          <div
            className="flex shrink-0 items-center rounded-xl bg-token-bg-secondary/75 p-1"
            role="group"
            aria-label="Plugin status filter"
          >
            {(
              [
                ['all', 'All'],
                ['enabled', 'Enabled'],
                ['disabled', 'Disabled'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                className={cn(
                  'h-7 rounded-lg px-2.5 font-medium text-xs transition-[background-color,color,box-shadow]',
                  filter === value
                    ? 'bg-token-main-surface-primary text-token-text-primary shadow-codex-sm ring-1 ring-token-border-light'
                    : 'text-token-text-tertiary hover:text-token-text-primary',
                )}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="space-y-7">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <SettingsSummaryCard
            label="Available plugins"
            value={plugins.length}
            icon={<IconPuzzlePieceOutline18 className="size-4" />}
          />
          <SettingsSummaryCard
            label="Enabled"
            value={enabledPlugins.length}
            icon={<CheckCircle2Icon className="size-4" />}
            accent
          />
          <SettingsSummaryCard
            label="Disabled"
            value={disabledPlugins.length}
            icon={<CircleOffIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Skills"
            value={totalSkills}
            icon={<SparklesIcon className="size-4" />}
          />
        </div>

        <MarketplacePanel
          state={marketplaceState}
          loading={marketplaceLoading}
          pendingPluginId={pendingMarketplacePluginId}
          message={marketplaceMessage}
          onRefresh={handleMarketplaceRefresh}
          onInstall={(pluginId) =>
            runMarketplaceOperation(pluginId, installMarketplacePlugin)
          }
          onUpdate={(pluginId) =>
            runMarketplaceOperation(pluginId, updateMarketplacePlugin)
          }
          onUninstall={(pluginId) =>
            runMarketplaceOperation(pluginId, uninstallMarketplacePlugin)
          }
        />

        <PrivateMarketplacePanel
          state={privateMarketplaceState}
          loading={privateMarketplaceLoading}
          pending={privateMarketplacePending}
          message={privateMarketplaceMessage}
          onSave={(input) =>
            runPrivateMarketplaceAction(
              'save',
              async () => {
                await savePrivateMarketplaceSource(input);
              },
              `Private marketplace ${input.displayName} saved. Verify it before installing plugins.`,
            )
          }
          onRemove={(sourceId) =>
            runPrivateMarketplaceAction(
              `${sourceId}:remove`,
              async () => {
                await removePrivateMarketplaceSource(sourceId);
              },
              `Private marketplace ${sourceId} removed.`,
            )
          }
          onSetEnabled={(sourceId, enabled) =>
            runPrivateMarketplaceAction(
              `${sourceId}:enabled`,
              async () => {
                await setPrivateMarketplaceSourceEnabled(sourceId, enabled);
              },
              `${sourceId} ${enabled ? 'enabled' : 'disabled'}.`,
            )
          }
          onRefresh={(sourceId) =>
            runPrivateMarketplaceAction(
              `${sourceId}:refresh`,
              async () => {
                await refreshPrivateMarketplaceSource(sourceId);
              },
              `Private marketplace ${sourceId} signature verified.`,
            )
          }
          onInstall={(sourceId, pluginId) =>
            runPrivateMarketplaceOperation(
              sourceId,
              pluginId,
              installPrivateMarketplacePlugin,
            )
          }
          onUpdate={(sourceId, pluginId) =>
            runPrivateMarketplaceOperation(
              sourceId,
              pluginId,
              updatePrivateMarketplacePlugin,
            )
          }
          onUninstall={(sourceId, pluginId) =>
            runPrivateMarketplaceOperation(
              sourceId,
              pluginId,
              uninstallPrivateMarketplacePlugin,
            )
          }
        />

        {visiblePlugins.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {visiblePlugins.map((plugin) => {
              const isEnabled = !disabledPluginIds.has(plugin.id);
              return (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  isEnabled={isEnabled}
                  onToggle={() => handleTogglePlugin(plugin.id)}
                  onOpenDetails={() => setSelectedPluginId(plugin.id)}
                />
              );
            })}
          </div>
        ) : (
          <SettingsPanel className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-token-bg-secondary text-token-text-tertiary">
              <SearchIcon className="size-5" />
            </span>
            <h2 className="mt-4 font-medium text-token-text-primary">
              No plugins found
            </h2>
            <p className="mt-1 max-w-sm text-sm text-token-text-secondary">
              Try a different search or status filter.
            </p>
          </SettingsPanel>
        )}
      </div>
    </SettingsPage>
  );
}
