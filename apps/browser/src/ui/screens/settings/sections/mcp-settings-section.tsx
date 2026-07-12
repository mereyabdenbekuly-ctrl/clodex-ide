import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import { Select } from '@clodex/stage-ui/components/select';
import { Switch } from '@clodex/stage-ui/components/switch';
import { toast } from '@clodex/stage-ui/components/toaster';
import type {
  ClodexMcpCapabilityStatus,
  ClodexMcpCapabilityTool,
} from '@shared/karton-contracts/ui';
import type {
  McpApplyImportInput,
  McpConnectionTestResult,
  McpCredentialOption,
  McpCustomCredentialInput,
  McpImportPreviewSettings,
  McpPromptSettings,
  McpResourceSettings,
  McpResourceTemplateSettings,
  McpServerLogSettings,
  McpServerSettings,
  McpServerSettingsInput,
  McpSettingsConfigValue,
  McpSettingsPolicy,
  McpSettingsPolicyDefault,
  McpSettingsSnapshot,
  McpSettingsToolDecision,
  McpSettingsTransportType,
  McpToolSettings,
} from '@shared/mcp-settings';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CloudCogIcon,
  FileInputIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SearchIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UnplugIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

type ConfigEntryDraft = {
  rowId: string;
  key: string;
  mode: 'literal' | 'credential';
  value: string;
  credentialRef: string;
};

type ServerDraft = {
  editingId: string | null;
  id: string;
  displayName: string;
  enabled: boolean;
  transportType: McpSettingsTransportType;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  oauthEnabled: boolean;
  oauthScopesText: string;
  entries: ConfigEntryDraft[];
  policyDefault: McpSettingsPolicyDefault;
  policyTools: Record<string, McpSettingsToolDecision>;
};

type ServerDetails = {
  loading: boolean;
  tools: McpToolSettings[];
  resources: McpResourceSettings[];
  resourceTemplates: McpResourceTemplateSettings[];
  prompts: McpPromptSettings[];
  logs: McpServerLogSettings[];
  error: string | null;
};

type CustomCredentialDraft = {
  credentialId: string;
  displayName: string;
  field: string;
  secret: string;
  allowedOriginsText: string;
};

const EMPTY_DRAFT: ServerDraft = {
  editingId: null,
  id: '',
  displayName: '',
  enabled: false,
  transportType: 'stdio',
  command: '',
  argsText: '',
  cwd: '',
  url: '',
  oauthEnabled: false,
  oauthScopesText: '',
  entries: [],
  policyDefault: 'ask',
  policyTools: {},
};

const EMPTY_CUSTOM_CREDENTIAL: CustomCredentialDraft = {
  credentialId: '',
  displayName: '',
  field: 'token',
  secret: '',
  allowedOriginsText: '',
};

const TRANSPORT_ITEMS = [
  {
    value: 'stdio',
    label: 'Local stdio',
    description: 'Launch a local executable as the current OS user.',
  },
  {
    value: 'streamable-http',
    label: 'Streamable HTTP',
    description: 'Connect to a modern remote MCP endpoint.',
  },
  {
    value: 'sse',
    label: 'Legacy SSE',
    description: 'Connect to a legacy remote MCP endpoint.',
  },
] satisfies Array<{
  value: McpSettingsTransportType;
  label: string;
  description: string;
}>;

const POLICY_ITEMS = [
  {
    value: 'ask',
    label: 'Ask by default',
    description: 'Require approval unless a tool has an explicit override.',
  },
  {
    value: 'deny',
    label: 'Deny by default',
    description: 'Hide tools unless an explicit override allows them.',
  },
  {
    value: 'allow-read-only',
    label: 'Allow trusted read-only',
    description:
      'Only built-in or signed sources can auto-run read-only tools.',
  },
] satisfies Array<{
  value: McpSettingsPolicyDefault;
  label: string;
  description: string;
}>;

function createRowId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatToolName(name: string) {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatCheckedAt(value: Date | number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function notify(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title,
    message,
    type,
    actions: [],
  });
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="block space-y-1.5">
      <span className="font-medium text-token-text-secondary text-xs">
        {label}
      </span>
      {children}
      {hint && (
        <span className="block text-[11px] text-token-text-tertiary leading-4">
          {hint}
        </span>
      )}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: McpServerSettings['runtime']['status'];
}) {
  const info = {
    disabled: {
      label: 'Disabled',
      className:
        'border-token-border-light bg-token-bg-secondary text-token-text-tertiary',
      icon: <UnplugIcon className="size-3" />,
    },
    disconnected: {
      label: 'Disconnected',
      className:
        'border-token-border-light bg-token-bg-secondary text-token-text-tertiary',
      icon: <UnplugIcon className="size-3" />,
    },
    connecting: {
      label: 'Connecting',
      className:
        'border-clodex-green-400/20 bg-clodex-green-400/7 text-clodex-green-400',
      icon: <LoaderCircleIcon className="size-3 animate-spin" />,
    },
    'authorization-required': {
      label: 'Authorize',
      className:
        'border-warning-solid/20 bg-warning-solid/8 text-warning-solid',
      icon: <KeyRoundIcon className="size-3" />,
    },
    connected: {
      label: 'Connected',
      className:
        'border-success-solid/20 bg-success-solid/7 text-success-solid',
      icon: <CheckCircle2Icon className="size-3" />,
    },
    degraded: {
      label: 'Recovering',
      className:
        'border-warning-solid/20 bg-warning-solid/8 text-warning-solid',
      icon: <RotateCwIcon className="size-3 animate-spin" />,
    },
    failed: {
      label: 'Failed',
      className: 'border-error-solid/20 bg-error-solid/7 text-error-solid',
      icon: <CircleAlertIcon className="size-3" />,
    },
  }[status];
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-[10px] uppercase tracking-[0.06em]',
        info.className,
      )}
    >
      {info.icon}
      {info.label}
    </span>
  );
}

function GatewayStatusBanner({
  status,
  onOpenAccount,
}: {
  status: ClodexMcpCapabilityStatus;
  onOpenAccount: () => void;
}) {
  if (status.state === 'connected') {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-success-solid/20 bg-success-solid/7 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 size-4.5 shrink-0 text-success-solid" />
          <div className="min-w-0">
            <div className="font-medium text-sm text-token-text-primary">
              Clodex Tools Gateway connected
            </div>
            <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
              {status.tools.length} approved cloud tool
              {status.tools.length === 1 ? '' : 's'} available.
            </p>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-token-text-tertiary">
          Checked {formatCheckedAt(status.checkedAt)}
        </span>
      </div>
    );
  }
  if (status.state === 'signed-out') {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-warning-solid/25 bg-warning-solid/8 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <KeyRoundIcon className="mt-0.5 size-4.5 shrink-0 text-warning-solid" />
          <div className="min-w-0">
            <div className="font-medium text-sm text-token-text-primary">
              Sign in and select a Clodex key
            </div>
            <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
              The cloud gateway uses the active Clodex model token.
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onOpenAccount}>
          Open Account
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-error-solid/25 bg-error-solid/8 px-4 py-3.5">
      <CircleAlertIcon className="mt-0.5 size-4.5 shrink-0 text-error-solid" />
      <div className="min-w-0">
        <div className="font-medium text-sm text-token-text-primary">
          Gateway unavailable
        </div>
        <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
          {status.error ?? 'Clodex could not inspect the cloud MCP gateway.'}
        </p>
      </div>
    </div>
  );
}

function CloudToolCard({ tool }: { tool: ClodexMcpCapabilityTool }) {
  return (
    <SettingsPanel className="p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl border',
            tool.requiresApproval
              ? 'border-warning-solid/20 bg-warning-solid/8 text-warning-solid'
              : 'border-clodex-green-400/18 bg-clodex-green-400/8 text-clodex-green-400',
          )}
        >
          {tool.requiresApproval ? (
            <LockKeyholeIcon className="size-4" />
          ) : (
            <WrenchIcon className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-medium text-sm text-token-text-primary">
            {formatToolName(tool.name)}
          </h4>
          <p className="mt-1 line-clamp-2 text-token-text-secondary text-xs leading-5">
            {tool.description}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-1 font-medium text-[10px] uppercase tracking-[0.06em]',
            tool.requiresApproval
              ? 'border-warning-solid/20 bg-warning-solid/8 text-warning-solid'
              : 'border-success-solid/20 bg-success-solid/7 text-success-solid',
          )}
        >
          {tool.requiresApproval ? 'Approval' : 'Read only'}
        </span>
      </div>
    </SettingsPanel>
  );
}

function credentialItems(credentials: McpCredentialOption[]) {
  return credentials.flatMap((credential) =>
    credential.fields.map((field) => ({
      value: `${credential.credentialId}::${field.name}`,
      label: `${credential.displayName} · ${field.label}`,
      description: credential.configured
        ? credential.allowedOrigins.length > 0
          ? `Allowed origins: ${credential.allowedOrigins.join(', ')}`
          : 'Available to explicitly selected local processes.'
        : 'Configure this credential in Plugins settings first.',
      disabled: !credential.configured,
    })),
  );
}

function toConfigEntries(
  values: Record<string, McpSettingsConfigValue>,
): ConfigEntryDraft[] {
  return Object.entries(values).map(([key, value]) => ({
    rowId: createRowId(),
    key,
    mode: value.kind,
    value: value.kind === 'literal' ? value.value : '',
    credentialRef:
      value.kind === 'credential'
        ? `${value.credentialId}::${value.field}`
        : '',
  }));
}

function toDraft(server: McpServerSettings): ServerDraft {
  if (server.transport.type === 'stdio') {
    return {
      editingId: server.id,
      id: server.id,
      displayName: server.displayName,
      enabled: server.enabled,
      transportType: server.transport.type,
      command: server.transport.command,
      argsText: server.transport.args.join('\n'),
      cwd: server.transport.cwd ?? '',
      url: '',
      oauthEnabled: false,
      oauthScopesText: '',
      entries: toConfigEntries(server.transport.env),
      policyDefault: server.policy.default,
      policyTools: { ...server.policy.tools },
    };
  }
  return {
    editingId: server.id,
    id: server.id,
    displayName: server.displayName,
    enabled: server.enabled,
    transportType: server.transport.type,
    command: '',
    argsText: '',
    cwd: '',
    url: server.transport.url,
    oauthEnabled: Boolean(server.transport.oauth),
    oauthScopesText: server.transport.oauth?.scopes.join('\n') ?? '',
    entries: toConfigEntries(server.transport.headers),
    policyDefault: server.policy.default,
    policyTools: { ...server.policy.tools },
  };
}

function parseCredentialRef(value: string) {
  const separator = value.indexOf('::');
  if (separator <= 0 || separator >= value.length - 2) {
    throw new Error('Select a configured credential and field.');
  }
  return {
    credentialId: value.slice(0, separator),
    field: value.slice(separator + 2),
  };
}

function toServerInput(draft: ServerDraft): McpServerSettingsInput {
  const values: Record<string, McpSettingsConfigValue> = {};
  for (const entry of draft.entries) {
    const key = entry.key.trim();
    if (!key) continue;
    if (entry.mode === 'literal') {
      values[key] = { kind: 'literal', value: entry.value };
    } else {
      const reference = parseCredentialRef(entry.credentialRef);
      values[key] = { kind: 'credential', ...reference };
    }
  }
  const common = {
    id: draft.id.trim(),
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    policy: {
      default: draft.policyDefault,
      tools: { ...draft.policyTools },
    },
  };
  if (draft.transportType === 'stdio') {
    return {
      ...common,
      transport: {
        type: 'stdio',
        command: draft.command.trim(),
        args: draft.argsText
          .split('\n')
          .map((argument) => argument.trim())
          .filter(Boolean),
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
        env: values,
      },
    };
  }
  return {
    ...common,
    transport: {
      type: draft.transportType,
      url: draft.url.trim(),
      headers: values,
      oauth: draft.oauthEnabled
        ? {
            clientRegistrationId: 'clodex-dynamic',
            scopes: draft.oauthScopesText
              .split(/\s+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
            redirectMode: 'custom-scheme',
          }
        : undefined,
    },
  };
}

function ConfigEntriesEditor({
  entries,
  credentials,
  target,
  onChange,
}: {
  entries: ConfigEntryDraft[];
  credentials: McpCredentialOption[];
  target: 'Environment variables' | 'HTTP headers';
  onChange: (entries: ConfigEntryDraft[]) => void;
}) {
  const items = useMemo(() => credentialItems(credentials), [credentials]);
  const update = (rowId: string, patch: Partial<ConfigEntryDraft>) =>
    onChange(
      entries.map((entry) =>
        entry.rowId === rowId ? { ...entry, ...patch } : entry,
      ),
    );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-token-text-secondary text-xs">
            {target}
          </div>
          <p className="mt-0.5 text-[11px] text-token-text-tertiary">
            Sensitive keys must use an encrypted credential reference.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onChange([
              ...entries,
              {
                rowId: createRowId(),
                key: '',
                mode: 'literal',
                value: '',
                credentialRef: '',
              },
            ])
          }
        >
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>
      {entries.map((entry) => (
        <div
          key={entry.rowId}
          className="grid grid-cols-1 gap-2 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-2 sm:grid-cols-[minmax(0,0.8fr)_9rem_minmax(0,1.2fr)_2rem]"
        >
          <Input
            value={entry.key}
            placeholder={target === 'HTTP headers' ? 'Header name' : 'ENV_NAME'}
            spellCheck={false}
            className="max-w-none font-mono text-xs"
            onValueChange={(key) => update(entry.rowId, { key })}
          />
          <Select<ConfigEntryDraft['mode']>
            value={entry.mode}
            items={[
              { value: 'literal', label: 'Plain value' },
              { value: 'credential', label: 'Credential' },
            ]}
            size="sm"
            triggerClassName="w-full"
            onValueChange={(mode) => update(entry.rowId, { mode })}
          />
          {entry.mode === 'literal' ? (
            <Input
              value={entry.value}
              placeholder="Non-secret value"
              className="max-w-none text-xs"
              onValueChange={(value) => update(entry.rowId, { value })}
            />
          ) : (
            <Select<string>
              value={entry.credentialRef}
              items={items}
              placeholder="Select credential…"
              size="sm"
              triggerClassName="w-full"
              onValueChange={(credentialRef) =>
                update(entry.rowId, { credentialRef })
              }
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${entry.key || 'configuration'} row`}
            onClick={() =>
              onChange(entries.filter((item) => item.rowId !== entry.rowId))
            }
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function ServerEditor({
  draft,
  credentials,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ServerDraft;
  credentials: McpCredentialOption[];
  saving: boolean;
  onChange: (draft: ServerDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isEditing = draft.editingId !== null;
  return (
    <SettingsPanel className="overflow-hidden border-clodex-green-400/20">
      <div className="border-token-border-light border-b p-4">
        <SettingsSectionHeader
          title={isEditing ? `Edit ${draft.displayName}` : 'Add MCP server'}
          description="Local MCP executables run with your OS user privileges. Remote endpoints require HTTPS except for loopback development."
          trailing={
            <Button variant="ghost" size="icon-sm" onClick={onCancel}>
              <XIcon className="size-4" />
            </Button>
          }
        />
      </div>
      <div className="space-y-5 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Display name">
            <Input
              value={draft.displayName}
              placeholder="My MCP server"
              className="max-w-none"
              onValueChange={(displayName) =>
                onChange({ ...draft, displayName })
              }
            />
          </Field>
          <Field
            label="Stable server ID"
            hint="Lowercase letters, digits, dots, dashes, and underscores."
          >
            <Input
              value={draft.id}
              disabled={isEditing}
              placeholder="my-mcp-server"
              spellCheck={false}
              className="max-w-none font-mono"
              onValueChange={(id) => onChange({ ...draft, id })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Transport">
            <Select<McpSettingsTransportType>
              value={draft.transportType}
              items={TRANSPORT_ITEMS}
              size="sm"
              triggerClassName="w-full"
              onValueChange={(transportType) =>
                onChange({ ...draft, transportType })
              }
            />
          </Field>
          <Field
            label="Default approval policy"
            hint="Destructive tools always require human approval."
          >
            <Select<McpSettingsPolicyDefault>
              value={draft.policyDefault}
              items={POLICY_ITEMS}
              size="sm"
              triggerClassName="w-full"
              onValueChange={(policyDefault) =>
                onChange({ ...draft, policyDefault })
              }
            />
          </Field>
        </div>

        {draft.transportType === 'stdio' ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Executable command">
                <Input
                  value={draft.command}
                  placeholder="/absolute/path/to/mcp-server"
                  spellCheck={false}
                  className="max-w-none font-mono"
                  onValueChange={(command) => onChange({ ...draft, command })}
                />
              </Field>
              <Field
                label="Working directory"
                hint="Optional; must be absolute."
              >
                <Input
                  value={draft.cwd}
                  placeholder="/absolute/project/path"
                  spellCheck={false}
                  className="max-w-none font-mono"
                  onValueChange={(cwd) => onChange({ ...draft, cwd })}
                />
              </Field>
            </div>
            <Field
              label="Arguments"
              hint="One argument per line. Secrets in arguments are rejected; use environment credential references."
            >
              <textarea
                value={draft.argsText}
                placeholder={'--mode\nstdio'}
                spellCheck={false}
                rows={4}
                className="w-full resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary px-3 py-2 font-mono text-token-text-primary text-xs outline-none focus:border-token-focus-border"
                onChange={(event) =>
                  onChange({ ...draft, argsText: event.target.value })
                }
              />
            </Field>
            <ConfigEntriesEditor
              entries={draft.entries}
              credentials={credentials}
              target="Environment variables"
              onChange={(entries) => onChange({ ...draft, entries })}
            />
          </>
        ) : (
          <>
            <Field
              label="MCP endpoint URL"
              hint="HTTPS is required unless the endpoint is localhost or loopback."
            >
              <Input
                value={draft.url}
                placeholder="https://mcp.example.com/rpc"
                spellCheck={false}
                className="max-w-none font-mono"
                onValueChange={(url) => onChange({ ...draft, url })}
              />
            </Field>
            <div className="flex flex-col gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-medium text-token-text-primary text-xs">
                  OAuth 2.1 with PKCE
                </div>
                <p className="mt-0.5 text-[11px] text-token-text-tertiary">
                  Uses Clodex dynamic client registration, encrypted token
                  storage, exact state validation, and an origin-bound callback.
                </p>
              </div>
              <Switch
                checked={draft.oauthEnabled}
                size="sm"
                onCheckedChange={(oauthEnabled) =>
                  onChange({ ...draft, oauthEnabled })
                }
              />
            </div>
            {draft.oauthEnabled && (
              <Field
                label="OAuth scopes"
                hint="Optional. Separate scopes with spaces or new lines."
              >
                <textarea
                  value={draft.oauthScopesText}
                  placeholder={'mcp:tools\nmcp:resources'}
                  spellCheck={false}
                  rows={3}
                  className="w-full resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary px-3 py-2 font-mono text-token-text-primary text-xs outline-none focus:border-token-focus-border"
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      oauthScopesText: event.target.value,
                    })
                  }
                />
              </Field>
            )}
            <ConfigEntriesEditor
              entries={draft.entries}
              credentials={credentials}
              target="HTTP headers"
              onChange={(entries) => onChange({ ...draft, entries })}
            />
          </>
        )}

        <div className="flex flex-col gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium text-token-text-primary text-xs">
              Enable after saving
            </div>
            <p className="mt-0.5 text-[11px] text-token-text-tertiary">
              Leave disabled to review the normalized config before connecting.
            </p>
          </div>
          <Switch
            checked={draft.enabled}
            size="sm"
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving || !draft.id.trim() || !draft.displayName.trim()}
            onClick={onSave}
          >
            {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            {isEditing ? 'Save changes' : 'Add server'}
          </Button>
        </div>
      </div>
    </SettingsPanel>
  );
}

function CredentialManager({
  credentials,
  draft,
  saving,
  operation,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  credentials: McpCredentialOption[];
  draft: CustomCredentialDraft;
  saving: boolean;
  operation: string | null;
  onChange: (draft: CustomCredentialDraft) => void;
  onSave: () => void;
  onDelete: (credentialId: string) => void;
  onClose: () => void;
}) {
  const customCredentials = credentials.filter(
    (credential) => credential.custom,
  );
  return (
    <SettingsPanel className="overflow-hidden border-clodex-green-400/20">
      <div className="border-token-border-light border-b p-4">
        <SettingsSectionHeader
          title="Custom MCP credentials"
          description="Create named secrets for arbitrary MCP servers. Saved values are encrypted and never returned to the UI."
          trailing={
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <XIcon className="size-4" />
            </Button>
          }
        />
      </div>
      <div className="space-y-5 p-4">
        {customCredentials.length > 0 && (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {customCredentials.map((credential) => (
              <div
                key={credential.credentialId}
                className="flex items-start justify-between gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3"
              >
                <div className="min-w-0">
                  <div className="font-medium text-token-text-primary text-xs">
                    {credential.displayName}
                  </div>
                  <code className="mt-1 block truncate text-[10px] text-token-text-tertiary">
                    {credential.credentialId}
                  </code>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {credential.fields.map((field) => (
                      <span
                        key={field.name}
                        className="rounded-md border border-token-border-light px-1.5 py-0.5 text-[10px] text-token-text-secondary"
                      >
                        {field.name}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-token-text-tertiary leading-4">
                    {credential.allowedOrigins.length > 0
                      ? `Remote origins: ${credential.allowedOrigins.join(', ')}`
                      : 'Local stdio only'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-error-solid"
                  disabled={operation === `${credential.credentialId}:delete`}
                  aria-label={`Delete ${credential.displayName}`}
                  onClick={() => onDelete(credential.credentialId)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Credential ID"
            hint='Use a stable ID such as "github-enterprise"; the mcp-custom. prefix is added automatically.'
          >
            <Input
              value={draft.credentialId}
              placeholder="my-service"
              spellCheck={false}
              className="max-w-none font-mono"
              onValueChange={(credentialId) =>
                onChange({ ...draft, credentialId })
              }
            />
          </Field>
          <Field label="Display name">
            <Input
              value={draft.displayName}
              placeholder="My service API token"
              className="max-w-none"
              onValueChange={(displayName) =>
                onChange({ ...draft, displayName })
              }
            />
          </Field>
          <Field
            label="Secret field"
            hint='Referenced by env/header mappings, for example "token" or "apiKey".'
          >
            <Input
              value={draft.field}
              placeholder="token"
              spellCheck={false}
              className="max-w-none font-mono"
              onValueChange={(field) => onChange({ ...draft, field })}
            />
          </Field>
          <Field label="Secret value" hint="Never displayed again after save.">
            <Input
              type="password"
              value={draft.secret}
              placeholder="Paste secret"
              autoComplete="new-password"
              className="max-w-none"
              onValueChange={(secret) => onChange({ ...draft, secret })}
            />
          </Field>
        </div>
        <Field
          label="Allowed remote origins"
          hint="Optional, one HTTPS origin per line. Leave empty for local stdio use only. Paths are normalized to origins."
        >
          <textarea
            value={draft.allowedOriginsText}
            placeholder={'https://mcp.example.com\nhttp://127.0.0.1:8787'}
            spellCheck={false}
            rows={3}
            className="w-full resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary px-3 py-2 font-mono text-token-text-primary text-xs outline-none focus:border-token-focus-border"
            onChange={(event) =>
              onChange({
                ...draft,
                allowedOriginsText: event.target.value,
              })
            }
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={
              saving ||
              !draft.credentialId.trim() ||
              !draft.displayName.trim() ||
              !draft.field.trim() ||
              !draft.secret
            }
            onClick={onSave}
          >
            {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            Save encrypted secret
          </Button>
        </div>
      </div>
    </SettingsPanel>
  );
}

function ToolPolicyRow({
  tool,
  override,
  disabled,
  onChange,
}: {
  tool: McpToolSettings;
  override: McpSettingsToolDecision | 'default';
  disabled: boolean;
  onChange: (decision: McpSettingsToolDecision | 'default') => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 border-token-border-light border-t px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-[11px] text-token-text-primary">
            {tool.name}
          </code>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.05em]',
              tool.effectiveDecision === 'deny'
                ? 'border-error-solid/20 bg-error-solid/7 text-error-solid'
                : tool.effectiveDecision === 'ask'
                  ? 'border-warning-solid/20 bg-warning-solid/8 text-warning-solid'
                  : 'border-success-solid/20 bg-success-solid/7 text-success-solid',
            )}
          >
            effective {tool.effectiveDecision}
          </span>
          {tool.destructive && (
            <span className="rounded-full border border-error-solid/20 bg-error-solid/7 px-2 py-0.5 text-[10px] text-error-solid uppercase">
              destructive
            </span>
          )}
          {tool.readOnly && (
            <span className="rounded-full border border-token-border-light px-2 py-0.5 text-[10px] text-token-text-tertiary uppercase">
              read only
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-token-text-secondary text-xs leading-5">
          {tool.description}
        </p>
      </div>
      <Select<McpSettingsToolDecision | 'default'>
        value={override}
        disabled={disabled}
        items={[
          { value: 'default', label: 'Use server default' },
          { value: 'allow', label: 'Allow' },
          { value: 'ask', label: 'Ask' },
          { value: 'deny', label: 'Deny' },
        ]}
        size="sm"
        triggerClassName="w-full"
        onValueChange={onChange}
      />
    </div>
  );
}

function ServerCard({
  server,
  details,
  operation,
  onToggleEnabled,
  onConnect,
  onDisconnect,
  onRestart,
  onTest,
  onEdit,
  onRemove,
  onToggleDetails,
  onSetDefaultPolicy,
  onSetToolPolicy,
}: {
  server: McpServerSettings;
  details: ServerDetails | undefined;
  operation: string | null;
  onToggleEnabled: (enabled: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRestart: () => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToggleDetails: () => void;
  onSetDefaultPolicy: (policy: McpSettingsPolicyDefault) => void;
  onSetToolPolicy: (
    toolName: string,
    decision: McpSettingsToolDecision | 'default',
  ) => void;
}) {
  const busy = operation?.startsWith(`${server.id}:`) === true;
  const expanded = details !== undefined;
  return (
    <SettingsPanel className="overflow-hidden">
      <div className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-token-border-light bg-token-bg-secondary/65 text-token-text-secondary">
              {server.transport.type === 'stdio' ? (
                <ServerCogIcon className="size-4.5" />
              ) : (
                <CloudCogIcon className="size-4.5" />
              )}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-sm text-token-text-primary">
                  {server.displayName}
                </h3>
                <StatusBadge status={server.runtime.status} />
              </div>
              <code className="mt-1 block text-[10px] text-token-text-tertiary">
                {server.id}
              </code>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[10px] text-token-text-secondary">
                  {server.transport.type}
                </span>
                <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[10px] text-token-text-secondary">
                  {server.source.label}
                </span>
                <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 text-[10px] text-token-text-secondary">
                  trust: {server.trust.replace('-', ' ')}
                </span>
                {server.runtime.restartCount > 0 && (
                  <span className="rounded-full border border-warning-solid/20 bg-warning-solid/8 px-2 py-0.5 text-[10px] text-warning-solid">
                    host restarts: {server.runtime.restartCount}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              checked={server.enabled}
              disabled={busy}
              size="xs"
              aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.displayName}`}
              onCheckedChange={onToggleEnabled}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onTest}
            >
              <FlaskConicalIcon className="size-3.5" />
              Test
            </Button>
            {server.runtime.status === 'connected' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={onDisconnect}
              >
                <UnplugIcon className="size-3.5" />
                Disconnect
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !server.enabled}
                onClick={onConnect}
              >
                <PlugIcon className="size-3.5" />
                Connect
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !server.enabled}
              onClick={onRestart}
            >
              <RotateCwIcon className="size-3.5" />
              Restart
            </Button>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-token-border-light bg-token-bg-secondary/35 px-3 py-2.5">
          <div className="mb-1 text-[10px] text-token-text-tertiary uppercase tracking-[0.06em]">
            Sanitized endpoint / command
          </div>
          <code className="block break-all text-[11px] text-token-text-secondary leading-5">
            {server.transportPreview}
          </code>
        </div>

        {server.runtime.lastError && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-error-solid/20 bg-error-solid/7 px-3 py-2.5 text-error-solid text-xs">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{server.runtime.lastError}</span>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3 border-token-border-light border-t pt-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full max-w-xs">
            <div className="mb-1.5 font-medium text-token-text-secondary text-xs">
              Default policy
            </div>
            <Select<McpSettingsPolicyDefault>
              value={server.policy.default}
              disabled={busy}
              items={POLICY_ITEMS}
              size="sm"
              triggerClassName="w-full"
              onValueChange={onSetDefaultPolicy}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onToggleDetails}
            >
              <ScrollTextIcon className="size-3.5" />
              Context & logs
              {expanded ? (
                <ChevronUpIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </Button>
            {server.canEdit && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onEdit}
              >
                <PencilIcon className="size-3.5" />
                Edit
              </Button>
            )}
            {server.canRemove && (
              <Button
                variant="ghost"
                size="sm"
                className="text-error-solid"
                disabled={busy}
                onClick={onRemove}
              >
                <Trash2Icon className="size-3.5" />
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>

      {details && (
        <div className="border-token-border-light border-t bg-token-bg-secondary/20">
          {details.loading ? (
            <div className="flex min-h-24 items-center justify-center">
              <LoaderCircleIcon className="size-4 animate-spin text-clodex-green-400" />
            </div>
          ) : (
            <div className="space-y-4 p-4">
              {details.error && (
                <div className="rounded-xl border border-warning-solid/20 bg-warning-solid/8 px-3 py-2 text-warning-solid text-xs">
                  {details.error}
                </div>
              )}
              <div>
                <SettingsSectionHeader
                  title={`Tools (${details.tools.length})`}
                  description="Effective policy includes source trust, annotations, explicit overrides, and the destructive-action floor."
                />
                <div className="mt-3 overflow-hidden rounded-xl border border-token-border-light bg-token-main-surface-primary/70">
                  {details.tools.length > 0 ? (
                    details.tools.map((tool) => (
                      <ToolPolicyRow
                        key={tool.name}
                        tool={tool}
                        override={server.policy.tools[tool.name] ?? 'default'}
                        disabled={busy}
                        onChange={(decision) =>
                          onSetToolPolicy(tool.name, decision)
                        }
                      />
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-token-text-tertiary text-xs">
                      {server.enabled
                        ? 'No tools were reported by this server.'
                        : 'Enable or test the server to inspect its tools.'}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ContextList
                  title={`Resources (${details.resources.length})`}
                  empty="No static resources were reported."
                  items={details.resources.map((resource) => ({
                    key: resource.uri,
                    name: resource.title ?? resource.name,
                    code: resource.uri,
                    description:
                      resource.description ??
                      resource.mimeType ??
                      'MCP resource',
                  }))}
                />
                <ContextList
                  title={`Templates (${details.resourceTemplates.length})`}
                  empty="No resource templates were reported."
                  items={details.resourceTemplates.map((template) => ({
                    key: template.uriTemplate,
                    name: template.title ?? template.name,
                    code: template.uriTemplate,
                    description:
                      template.description ??
                      template.mimeType ??
                      'MCP resource template',
                  }))}
                />
                <ContextList
                  title={`Prompts (${details.prompts.length})`}
                  empty="No prompts were reported."
                  items={details.prompts.map((prompt) => ({
                    key: prompt.name,
                    name: prompt.title ?? prompt.name,
                    code: prompt.name,
                    description:
                      prompt.description ??
                      `${prompt.arguments.length} argument${prompt.arguments.length === 1 ? '' : 's'}`,
                  }))}
                />
              </div>
              <div>
                <SettingsSectionHeader
                  title={`Diagnostic logs (${details.logs.length})`}
                  description="Bounded and sanitized. Saved credential values are redacted before reaching the UI."
                />
                <div className="mt-3 max-h-52 overflow-auto rounded-xl border border-token-border-light bg-[#111318] p-3">
                  {details.logs.length > 0 ? (
                    details.logs.map((entry, index) => (
                      <div
                        key={`${entry.timestamp}-${index}`}
                        className="font-mono text-[10px] text-white/75 leading-5"
                      >
                        <span className="text-white/40">
                          {formatCheckedAt(entry.timestamp)}
                        </span>{' '}
                        <span
                          className={cn(
                            entry.level === 'error'
                              ? 'text-red-300'
                              : entry.level === 'warn'
                                ? 'text-amber-300'
                                : 'text-sky-300',
                          )}
                        >
                          {entry.level.toUpperCase()}
                        </span>{' '}
                        {entry.message}
                      </div>
                    ))
                  ) : (
                    <div className="font-mono text-[10px] text-white/40">
                      No diagnostic entries.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </SettingsPanel>
  );
}

function ContextList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{
    key: string;
    name: string;
    code: string;
    description: string;
  }>;
}) {
  return (
    <div>
      <SettingsSectionHeader title={title} />
      <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-token-border-light bg-token-main-surface-primary/70">
        {items.length > 0 ? (
          items.map((item) => (
            <div
              key={item.key}
              className="border-token-border-light border-t px-3 py-2.5 first:border-t-0"
            >
              <div className="truncate font-medium text-token-text-primary text-xs">
                {item.name}
              </div>
              <code className="mt-1 block truncate text-[10px] text-token-text-tertiary">
                {item.code}
              </code>
              <p className="mt-1 line-clamp-2 text-[11px] text-token-text-secondary leading-4">
                {item.description}
              </p>
            </div>
          ))
        ) : (
          <div className="px-3 py-6 text-center text-token-text-tertiary text-xs">
            {empty}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerGroup({
  title,
  description,
  servers,
  renderServer,
  empty,
}: {
  title: string;
  description: string;
  servers: McpServerSettings[];
  renderServer: (server: McpServerSettings) => ReactNode;
  empty: string;
}) {
  return (
    <section className="space-y-3">
      <SettingsSectionHeader
        title={title}
        description={description}
        trailing={
          <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2.5 py-1 text-[10px] text-token-text-tertiary uppercase tracking-[0.06em]">
            {servers.length} server{servers.length === 1 ? '' : 's'}
          </span>
        }
      />
      {servers.length > 0 ? (
        <div className="space-y-3">{servers.map(renderServer)}</div>
      ) : (
        <SettingsPanel className="px-5 py-8 text-center text-token-text-tertiary text-xs">
          {empty}
        </SettingsPanel>
      )}
    </section>
  );
}

function ImportPreviewPanel({
  preview,
  credentials,
  selected,
  mappings,
  applying,
  onSelectedChange,
  onMappingChange,
  onCancel,
  onApply,
}: {
  preview: McpImportPreviewSettings;
  credentials: McpCredentialOption[];
  selected: Record<string, boolean>;
  mappings: Record<string, Record<string, string>>;
  applying: boolean;
  onSelectedChange: (serverId: string, selected: boolean) => void;
  onMappingChange: (serverId: string, key: string, value: string) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const items = useMemo(() => credentialItems(credentials), [credentials]);
  const selectedServers = preview.servers.filter(
    (server) => selected[server.proposedId],
  );
  const ready =
    selectedServers.length > 0 &&
    selectedServers.every(
      (server) =>
        server.supported &&
        server.requiredSecrets.every(
          (secret) =>
            mappings[server.proposedId]?.[`${secret.target}:${secret.key}`],
        ),
    );
  return (
    <SettingsPanel className="overflow-hidden border-clodex-green-400/20">
      <div className="border-token-border-light border-b p-4">
        <SettingsSectionHeader
          title="Claude Desktop import preview"
          description="This is a one-time normalized preview. Clodex does not watch or remain coupled to the source file."
          trailing={
            <Button variant="ghost" size="icon-sm" onClick={onCancel}>
              <XIcon className="size-4" />
            </Button>
          }
        />
        <code className="mt-2 block break-all text-[10px] text-token-text-tertiary">
          {preview.sourcePath}
        </code>
      </div>
      <div className="space-y-3 p-4">
        {preview.servers.map((server) => {
          const checked = selected[server.proposedId] === true;
          return (
            <div
              key={server.proposedId}
              className={cn(
                'rounded-2xl border p-4',
                server.supported
                  ? 'border-token-border-light bg-token-bg-secondary/25'
                  : 'border-error-solid/20 bg-error-solid/7',
              )}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!server.supported}
                  aria-label={`Import ${server.displayName}`}
                  className="mt-1 size-4 accent-clodex-green-400"
                  onChange={(event) =>
                    onSelectedChange(server.proposedId, event.target.checked)
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-medium text-sm text-token-text-primary">
                      {server.displayName}
                    </h4>
                    <code className="rounded-md bg-token-bg-secondary px-1.5 py-0.5 text-[10px] text-token-text-tertiary">
                      {server.proposedId}
                    </code>
                  </div>
                  {server.transportPreview && (
                    <code className="mt-2 block break-all rounded-lg border border-token-border-light bg-token-main-surface-primary/60 px-2.5 py-2 text-[10px] text-token-text-secondary">
                      {server.transportPreview}
                    </code>
                  )}
                  {server.warnings.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-warning-solid">
                      {server.warnings.map((warning, index) => (
                        <li key={`${warning}-${index}`}>• {warning}</li>
                      ))}
                    </ul>
                  )}
                  {checked && server.requiredSecrets.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {server.requiredSecrets.map((secret) => {
                        const mappingKey = `${secret.target}:${secret.key}`;
                        return (
                          <div
                            key={mappingKey}
                            className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:items-center"
                          >
                            <div>
                              <code className="text-[11px] text-token-text-primary">
                                {secret.key}
                              </code>
                              <div className="text-[10px] text-token-text-tertiary">
                                {secret.target === 'env'
                                  ? 'Environment variable'
                                  : 'HTTP header'}
                              </div>
                            </div>
                            <Select<string>
                              value={
                                mappings[server.proposedId]?.[mappingKey] ?? ''
                              }
                              items={items}
                              placeholder={
                                secret.suggestedCredentialId
                                  ? `Suggested: ${secret.suggestedCredentialId}`
                                  : 'Select credential…'
                              }
                              size="sm"
                              triggerClassName="w-full"
                              onValueChange={(value) =>
                                onMappingChange(
                                  server.proposedId,
                                  mappingKey,
                                  value,
                                )
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div className="flex justify-end gap-2 border-token-border-light border-t pt-4">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready || applying} onClick={onApply}>
            {applying && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            Confirm import
          </Button>
        </div>
      </div>
    </SettingsPanel>
  );
}

export function McpSettingsSection() {
  const getGatewayStatus = useKartonProcedure(
    (p) => p.toolbox.getClodexMcpStatus,
  );
  const listMcp = useKartonProcedure((p) => p.mcp.list);
  const upsertMcp = useKartonProcedure((p) => p.mcp.upsert);
  const setEnabled = useKartonProcedure((p) => p.mcp.setEnabled);
  const setPolicy = useKartonProcedure((p) => p.mcp.setPolicy);
  const removeMcp = useKartonProcedure((p) => p.mcp.remove);
  const connectMcp = useKartonProcedure((p) => p.mcp.connect);
  const disconnectMcp = useKartonProcedure((p) => p.mcp.disconnect);
  const restartMcp = useKartonProcedure((p) => p.mcp.restart);
  const testConnection = useKartonProcedure((p) => p.mcp.testConnection);
  const listTools = useKartonProcedure((p) => p.mcp.listTools);
  const listResources = useKartonProcedure((p) => p.mcp.listResources);
  const listResourceTemplates = useKartonProcedure(
    (p) => p.mcp.listResourceTemplates,
  );
  const listPrompts = useKartonProcedure((p) => p.mcp.listPrompts);
  const getLogs = useKartonProcedure((p) => p.mcp.getLogs);
  const setCustomCredential = useKartonProcedure(
    (p) => p.mcp.setCustomCredential,
  );
  const deleteCustomCredential = useKartonProcedure(
    (p) => p.mcp.deleteCustomCredential,
  );
  const previewClaudeImport = useKartonProcedure(
    (p) => p.mcp.previewClaudeDesktopImport,
  );
  const applyClaudeImport = useKartonProcedure(
    (p) => p.mcp.applyClaudeDesktopImport,
  );
  const pickFile = useKartonProcedure((p) => p.filePicker.createRequest);
  const setSettingsRoute = useKartonProcedure(
    (p) => p.appScreen.setSettingsRoute,
  );

  const [gatewayStatus, setGatewayStatus] =
    useState<ClodexMcpCapabilityStatus | null>(null);
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [credentialManagerOpen, setCredentialManagerOpen] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState<CustomCredentialDraft>(
    EMPTY_CUSTOM_CREDENTIAL,
  );
  const [savingCredential, setSavingCredential] = useState(false);
  const [details, setDetails] = useState<Record<string, ServerDetails>>({});
  const [cloudQuery, setCloudQuery] = useState('');
  const [importPreview, setImportPreview] =
    useState<McpImportPreviewSettings | null>(null);
  const [importSelected, setImportSelected] = useState<Record<string, boolean>>(
    {},
  );
  const [importMappings, setImportMappings] = useState<
    Record<string, Record<string, string>>
  >({});
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(
    async (forceGateway = false) => {
      setLoading(true);
      const [nextSnapshot, nextGateway] = await Promise.all([
        listMcp(),
        getGatewayStatus(forceGateway).catch(
          () =>
            ({
              state: 'unavailable',
              gatewayUrl: 'Configured MCP gateway',
              checkedAt: new Date(),
              cacheExpiresAt: null,
              tools: [],
              error: 'Clodex could not inspect the cloud MCP gateway.',
            }) satisfies ClodexMcpCapabilityStatus,
        ),
      ]);
      setSnapshot(nextSnapshot);
      setGatewayStatus(nextGateway);
      setLoading(false);
    },
    [getGatewayStatus, listMcp],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSnapshotOperation = useCallback(
    async (
      key: string,
      action: () => Promise<McpSettingsSnapshot>,
      successTitle: string,
    ) => {
      if (operation) return;
      setOperation(key);
      try {
        const next = await action();
        setSnapshot(next);
        notify(successTitle, 'MCP registry and runtime state were updated.');
      } catch (error) {
        notify(
          'MCP operation failed',
          error instanceof Error ? error.message : String(error),
          'error',
        );
      } finally {
        setOperation(null);
      }
    },
    [operation],
  );

  const loadDetails = useCallback(
    async (server: McpServerSettings, knownTools?: McpToolSettings[]) => {
      setDetails((current) => ({
        ...current,
        [server.id]: {
          loading: true,
          tools: knownTools ?? current[server.id]?.tools ?? [],
          resources: current[server.id]?.resources ?? [],
          resourceTemplates: current[server.id]?.resourceTemplates ?? [],
          prompts: current[server.id]?.prompts ?? [],
          logs: current[server.id]?.logs ?? [],
          error: null,
        },
      }));
      const [
        toolsResult,
        resourcesResult,
        resourceTemplatesResult,
        promptsResult,
        logsResult,
      ] = await Promise.allSettled([
        knownTools
          ? Promise.resolve(knownTools)
          : server.enabled
            ? listTools(server.id)
            : Promise.resolve([]),
        server.enabled ? listResources(server.id) : Promise.resolve([]),
        server.enabled ? listResourceTemplates(server.id) : Promise.resolve([]),
        server.enabled ? listPrompts(server.id) : Promise.resolve([]),
        getLogs(server.id),
      ]);
      setDetails((current) => ({
        ...current,
        [server.id]: {
          loading: false,
          tools: toolsResult.status === 'fulfilled' ? toolsResult.value : [],
          resources:
            resourcesResult.status === 'fulfilled' ? resourcesResult.value : [],
          resourceTemplates:
            resourceTemplatesResult.status === 'fulfilled'
              ? resourceTemplatesResult.value
              : [],
          prompts:
            promptsResult.status === 'fulfilled' ? promptsResult.value : [],
          logs: logsResult.status === 'fulfilled' ? logsResult.value : [],
          error:
            toolsResult.status === 'rejected'
              ? toolsResult.reason instanceof Error
                ? toolsResult.reason.message
                : String(toolsResult.reason)
              : resourcesResult.status === 'rejected'
                ? resourcesResult.reason instanceof Error
                  ? resourcesResult.reason.message
                  : String(resourcesResult.reason)
                : resourceTemplatesResult.status === 'rejected'
                  ? resourceTemplatesResult.reason instanceof Error
                    ? resourceTemplatesResult.reason.message
                    : String(resourceTemplatesResult.reason)
                  : promptsResult.status === 'rejected'
                    ? promptsResult.reason instanceof Error
                      ? promptsResult.reason.message
                      : String(promptsResult.reason)
                    : logsResult.status === 'rejected'
                      ? logsResult.reason instanceof Error
                        ? logsResult.reason.message
                        : String(logsResult.reason)
                      : null,
        },
      }));
    },
    [getLogs, listPrompts, listResourceTemplates, listResources, listTools],
  );

  const handleTest = useCallback(
    async (server: McpServerSettings) => {
      if (operation) return;
      setOperation(`${server.id}:test`);
      try {
        const result: McpConnectionTestResult = await testConnection(server.id);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                servers: current.servers.map((item) =>
                  item.id === server.id ? result.server : item,
                ),
                updatedAt: Date.now(),
              }
            : current,
        );
        await loadDetails(result.server, result.tools);
        notify(
          result.ok ? 'Connection test passed' : 'Connection test failed',
          result.message,
          result.ok ? 'info' : 'error',
        );
      } finally {
        setOperation(null);
      }
    },
    [loadDetails, operation, testConnection],
  );

  const handleSave = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const next = await upsertMcp(toServerInput(draft));
      setSnapshot(next);
      setDraft(null);
      notify(
        draft.editingId ? 'MCP server updated' : 'MCP server added',
        draft.enabled
          ? 'The server was saved and connection was attempted.'
          : 'The server was saved disabled for review.',
      );
    } catch (error) {
      notify(
        'Could not save MCP server',
        error instanceof Error ? error.message : String(error),
        'error',
      );
    } finally {
      setSaving(false);
    }
  }, [draft, saving, upsertMcp]);

  const handleSelectImport = useCallback(async () => {
    try {
      const paths = await pickFile({
        type: 'file',
        multiple: false,
        title: 'Select Claude Desktop MCP config',
        description:
          'Choose a JSON config to preview. Nothing is imported yet.',
      });
      const sourcePath = paths[0];
      if (!sourcePath) return;
      const preview = await previewClaudeImport(sourcePath);
      setImportPreview(preview);
      setImportSelected(
        Object.fromEntries(
          preview.servers.map((server) => [
            server.proposedId,
            server.supported,
          ]),
        ),
      );
      setImportMappings({});
    } catch (error) {
      notify(
        'Import preview failed',
        error instanceof Error ? error.message : String(error),
        'error',
      );
    }
  }, [pickFile, previewClaudeImport]);

  const handleSaveCustomCredential = useCallback(async () => {
    if (savingCredential) return;
    const rawId = credentialDraft.credentialId.trim().toLowerCase();
    const credentialId = rawId.startsWith('mcp-custom.')
      ? rawId
      : `mcp-custom.${rawId}`;
    const input: McpCustomCredentialInput = {
      credentialId,
      displayName: credentialDraft.displayName.trim(),
      field: credentialDraft.field.trim(),
      secret: credentialDraft.secret,
      allowedOrigins: credentialDraft.allowedOriginsText
        .split(/[\n,]+/)
        .map((origin) => origin.trim())
        .filter(Boolean),
    };
    setSavingCredential(true);
    try {
      const next = await setCustomCredential(input);
      setSnapshot(next);
      setCredentialDraft(EMPTY_CUSTOM_CREDENTIAL);
      notify(
        'Custom MCP credential saved',
        'The secret was encrypted and will not be displayed again.',
      );
    } catch (error) {
      notify(
        'Could not save credential',
        error instanceof Error ? error.message : String(error),
        'error',
      );
    } finally {
      setSavingCredential(false);
    }
  }, [credentialDraft, savingCredential, setCustomCredential]);

  const handleApplyImport = useCallback(async () => {
    if (!importPreview || importing) return;
    const serverIds = importPreview.servers
      .filter((server) => importSelected[server.proposedId])
      .map((server) => server.proposedId);
    const mappings: McpApplyImportInput['mappings'] = {};
    try {
      for (const server of importPreview.servers) {
        if (!importSelected[server.proposedId]) continue;
        const serverMappings: Record<
          string,
          {
            kind: 'credential';
            credentialId: string;
            field: string;
          }
        > = {};
        for (const secret of server.requiredSecrets) {
          const mappingKey = `${secret.target}:${secret.key}`;
          const selected = importMappings[server.proposedId]?.[mappingKey];
          if (!selected) {
            throw new Error(
              `Select a credential for ${server.displayName}/${secret.key}.`,
            );
          }
          serverMappings[mappingKey] = {
            kind: 'credential',
            ...parseCredentialRef(selected),
          };
        }
        mappings[server.proposedId] = serverMappings;
      }
      setImporting(true);
      const next = await applyClaudeImport({
        previewId: importPreview.previewId,
        serverIds,
        mappings,
      });
      setSnapshot(next);
      setImportPreview(null);
      setImportSelected({});
      setImportMappings({});
      notify(
        'MCP import complete',
        `${serverIds.length} server${serverIds.length === 1 ? '' : 's'} imported disabled for review.`,
      );
    } catch (error) {
      notify(
        'MCP import failed',
        error instanceof Error ? error.message : String(error),
        'error',
      );
    } finally {
      setImporting(false);
    }
  }, [
    applyClaudeImport,
    importMappings,
    importPreview,
    importSelected,
    importing,
  ]);

  const localServers =
    snapshot?.servers.filter((server) => server.group === 'local-custom') ?? [];
  const pluginServers =
    snapshot?.servers.filter(
      (server) => server.group === 'installed-plugins',
    ) ?? [];
  const cloudRegistryServers =
    snapshot?.servers.filter((server) => server.group === 'clodex-cloud') ?? [];
  const connectedCount =
    snapshot?.servers.filter((server) => server.runtime.status === 'connected')
      .length ?? 0;
  const cloudTools = useMemo(() => {
    const normalized = cloudQuery.trim().toLowerCase();
    if (!normalized) return gatewayStatus?.tools ?? [];
    return (gatewayStatus?.tools ?? []).filter(
      (tool) =>
        tool.name.toLowerCase().includes(normalized) ||
        tool.description.toLowerCase().includes(normalized),
    );
  }, [cloudQuery, gatewayStatus]);

  const renderServer = (server: McpServerSettings) => (
    <ServerCard
      key={server.id}
      server={server}
      details={details[server.id]}
      operation={operation}
      onToggleEnabled={(enabled) =>
        void runSnapshotOperation(
          `${server.id}:toggle`,
          () => setEnabled(server.id, enabled),
          enabled ? 'MCP server enabled' : 'MCP server disabled',
        )
      }
      onConnect={() =>
        void runSnapshotOperation(
          `${server.id}:connect`,
          () => connectMcp(server.id),
          'MCP server connected',
        )
      }
      onDisconnect={() =>
        void runSnapshotOperation(
          `${server.id}:disconnect`,
          () => disconnectMcp(server.id),
          'MCP server disconnected',
        )
      }
      onRestart={() =>
        void runSnapshotOperation(
          `${server.id}:restart`,
          () => restartMcp(server.id),
          'MCP server restarted',
        )
      }
      onTest={() => void handleTest(server)}
      onEdit={() => setDraft(toDraft(server))}
      onRemove={() => {
        if (
          !window.confirm(
            `Remove MCP server "${server.displayName}"? Credentials remain in the encrypted credential store.`,
          )
        ) {
          return;
        }
        void runSnapshotOperation(
          `${server.id}:remove`,
          () => removeMcp(server.id),
          'MCP server removed',
        );
      }}
      onToggleDetails={() => {
        if (details[server.id]) {
          setDetails((current) => {
            const next = { ...current };
            delete next[server.id];
            return next;
          });
        } else {
          void loadDetails(server);
        }
      }}
      onSetDefaultPolicy={(policyDefault) =>
        void runSnapshotOperation(
          `${server.id}:policy`,
          () =>
            setPolicy(server.id, {
              ...server.policy,
              default: policyDefault,
            }),
          'MCP policy updated',
        ).then(() => {
          if (details[server.id]) void loadDetails(server);
        })
      }
      onSetToolPolicy={(toolName, decision) => {
        const tools = { ...server.policy.tools };
        if (decision === 'default') delete tools[toolName];
        else tools[toolName] = decision;
        const policy: McpSettingsPolicy = {
          ...server.policy,
          tools,
        };
        void runSnapshotOperation(
          `${server.id}:tool-policy`,
          () => setPolicy(server.id, policy),
          'Tool policy updated',
        ).then(() => {
          if (details[server.id]) {
            const refreshedServer = snapshot?.servers.find(
              (item) => item.id === server.id,
            );
            void loadDetails(refreshedServer ?? server);
          }
        });
      }}
    />
  );

  return (
    <SettingsPage
      eyebrow="Capabilities"
      title="MCP runtime"
      description="Manage the built-in Clodex cloud gateway, local and remote custom servers, and MCP capabilities delivered by signed plugins."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => void refresh(true)}
          >
            <RefreshCwIcon
              className={cn('size-3.5', loading && 'animate-spin')}
            />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleSelectImport()}
          >
            <FileInputIcon className="size-3.5" />
            Import config
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCredentialManagerOpen(true)}
          >
            <KeyRoundIcon className="size-3.5" />
            Credentials
          </Button>
          <Button size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <PlusIcon className="size-3.5" />
            Add server
          </Button>
        </div>
      }
      toolbar={
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SettingsSummaryCard
            accent
            label="configured servers"
            value={snapshot?.servers.length ?? 0}
            icon={<ServerCogIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="connected custom"
            value={connectedCount}
            icon={<PlugIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="Clodex cloud tools"
            value={gatewayStatus?.tools.length ?? 0}
            icon={<CloudCogIcon className="size-4" />}
          />
        </div>
      }
    >
      <div className="space-y-8">
        {loading && !snapshot ? (
          <div className="flex min-h-48 items-center justify-center rounded-2xl border border-token-border-light bg-token-main-surface-primary/65">
            <LoaderCircleIcon className="size-5 animate-spin text-clodex-green-400" />
          </div>
        ) : (
          <>
            {draft && snapshot && (
              <ServerEditor
                draft={draft}
                credentials={snapshot.credentials}
                saving={saving}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSave={() => void handleSave()}
              />
            )}

            {credentialManagerOpen && snapshot && (
              <CredentialManager
                credentials={snapshot.credentials}
                draft={credentialDraft}
                saving={savingCredential}
                operation={operation}
                onChange={setCredentialDraft}
                onSave={() => void handleSaveCustomCredential()}
                onDelete={(credentialId) => {
                  if (
                    !window.confirm(
                      `Delete custom MCP credential "${credentialId}"? Servers that reference it will fail closed until another credential is selected.`,
                    )
                  ) {
                    return;
                  }
                  void runSnapshotOperation(
                    `${credentialId}:delete`,
                    () => deleteCustomCredential(credentialId),
                    'Custom MCP credential deleted',
                  );
                }}
                onClose={() => setCredentialManagerOpen(false)}
              />
            )}

            {importPreview && snapshot && (
              <ImportPreviewPanel
                preview={importPreview}
                credentials={snapshot.credentials}
                selected={importSelected}
                mappings={importMappings}
                applying={importing}
                onSelectedChange={(serverId, selected) =>
                  setImportSelected((current) => ({
                    ...current,
                    [serverId]: selected,
                  }))
                }
                onMappingChange={(serverId, key, value) =>
                  setImportMappings((current) => ({
                    ...current,
                    [serverId]: {
                      ...current[serverId],
                      [key]: value,
                    },
                  }))
                }
                onCancel={() => {
                  setImportPreview(null);
                  setImportSelected({});
                  setImportMappings({});
                }}
                onApply={() => void handleApplyImport()}
              />
            )}

            <section className="space-y-4">
              <SettingsSectionHeader
                title="Clodex Cloud"
                description="The authenticated Clodex Tools Gateway remains isolated from user-installed MCP servers and keeps its existing Guardian boundary."
              />
              {gatewayStatus && (
                <GatewayStatusBanner
                  status={gatewayStatus}
                  onOpenAccount={() => setSettingsRoute({ section: 'account' })}
                />
              )}
              <SettingsPanel className="overflow-hidden">
                <div className="p-4">
                  <SettingsSectionHeader
                    title="Gateway endpoint"
                    description="Credentials and query parameters are never displayed."
                    trailing={
                      gatewayStatus?.state === 'connected' ? (
                        <StatusBadge status="connected" />
                      ) : (
                        <StatusBadge status="disconnected" />
                      )
                    }
                  />
                </div>
                <div className="border-token-border-light border-t bg-token-bg-secondary/35 px-4 py-3">
                  <code className="block truncate text-[11px] text-token-text-secondary">
                    {gatewayStatus?.gatewayUrl ??
                      'Loading gateway configuration…'}
                  </code>
                </div>
              </SettingsPanel>

              {cloudRegistryServers.map(renderServer)}

              <div className="space-y-3">
                <SettingsSectionHeader
                  title="Cloud tools"
                  description="Read-only tools can run automatically; destructive tools retain the established approval flow."
                  trailing={
                    gatewayStatus?.tools.length ? (
                      <div className="relative w-56">
                        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-token-text-tertiary" />
                        <Input
                          aria-label="Search Clodex cloud MCP tools"
                          placeholder="Search cloud tools…"
                          value={cloudQuery}
                          onValueChange={setCloudQuery}
                          className="h-8 max-w-none rounded-lg pr-8 pl-8 text-xs"
                        />
                        {cloudQuery && (
                          <button
                            type="button"
                            aria-label="Clear cloud MCP tool search"
                            className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-token-text-tertiary hover:bg-token-list-hover-background"
                            onClick={() => setCloudQuery('')}
                          >
                            <XIcon className="size-3" />
                          </button>
                        )}
                      </div>
                    ) : undefined
                  }
                />
                {cloudTools.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {cloudTools.map((tool) => (
                      <CloudToolCard key={tool.id} tool={tool} />
                    ))}
                  </div>
                ) : (
                  <SettingsPanel className="px-5 py-8 text-center text-token-text-tertiary text-xs">
                    {cloudQuery
                      ? 'No cloud tools match this search.'
                      : 'No Clodex cloud tools are currently available.'}
                  </SettingsPanel>
                )}
              </div>
            </section>

            <ServerGroup
              title="Local & Custom"
              description="User-configured stdio, Streamable HTTP, legacy SSE, and reviewed imports. All custom tools default to approval."
              servers={localServers}
              renderServer={renderServer}
              empty="No local or custom MCP servers are configured."
            />

            <ServerGroup
              title="Installed Plugins"
              description="MCP servers declared by signed marketplace plugins with the mcp permission. Plugin transports are managed by the plugin lifecycle."
              servers={pluginServers}
              renderServer={renderServer}
              empty="No installed plugin currently declares an MCP server."
            />

            <SettingsPanel className="flex items-start gap-3 border-warning-solid/15 bg-warning-solid/5 p-4">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-warning-solid" />
              <div>
                <h3 className="font-medium text-sm text-token-text-primary">
                  Security boundary
                </h3>
                <p className="mt-1 text-token-text-secondary text-xs leading-5">
                  Process isolation is a fault boundary, not an OS sandbox.
                  Local MCP servers run as your current user. Saved credential
                  values remain encrypted and are resolved only in the main
                  process for the explicitly selected environment variable or
                  remote header.
                </p>
              </div>
            </SettingsPanel>
          </>
        )}
      </div>
    </SettingsPage>
  );
}
