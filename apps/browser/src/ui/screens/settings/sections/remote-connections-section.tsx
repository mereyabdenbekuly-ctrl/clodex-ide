import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import { Select } from '@clodex/stage-ui/components/select';
import { toast } from '@clodex/stage-ui/components/toaster';
import { resolveFeatureGate } from '@shared/feature-gates';
import type {
  RemoteConnectionAuthType,
  RemoteConnectionCapabilities,
  RemoteConnectionInput,
  RemoteConnectionPublic,
} from '@shared/remote-connections';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { cn } from '@ui/utils';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDotIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  Trash2Icon,
  UnplugIcon,
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
import { DockerRunnerProfilesPanel } from './docker-runner-profiles-panel';

const EMPTY_DRAFT: RemoteConnectionInput = {
  name: '',
  host: '',
  port: 22,
  username: '',
  remotePath: '',
  hostKeyPolicy: 'strict',
  authentication: { type: 'ssh-agent' },
};

const AUTH_ITEMS = [
  { value: 'ssh-agent', label: 'SSH agent' },
  { value: 'private-key', label: 'Private key' },
  { value: 'password', label: 'Password' },
] satisfies Array<{ value: RemoteConnectionAuthType; label: string }>;

function toDraft(connection: RemoteConnectionPublic): RemoteConnectionInput {
  const authentication: RemoteConnectionInput['authentication'] =
    connection.authentication.type === 'ssh-agent'
      ? { type: 'ssh-agent' }
      : connection.authentication.type === 'private-key'
        ? {
            type: 'private-key',
            identityFile: connection.authentication.identityFile,
          }
        : { type: 'password' };
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    remotePath: connection.remotePath,
    hostKeyPolicy: connection.hostKeyPolicy,
    authentication,
  };
}

function endpoint(connection: RemoteConnectionPublic): string {
  return `${connection.username}@${connection.host}:${connection.port}`;
}

function statusInfo(connection: RemoteConnectionPublic) {
  if (connection.status === 'connected') {
    return {
      label: 'Connected',
      icon: <CheckCircle2Icon className="size-3" />,
      className:
        'border-success-solid/20 bg-success-solid/7 text-success-solid',
    };
  }
  if (connection.status === 'connecting') {
    return {
      label: 'Connecting',
      icon: <LoaderCircleIcon className="size-3 animate-spin" />,
      className:
        'border-clodex-green-400/20 bg-clodex-green-400/7 text-clodex-green-400',
    };
  }
  if (connection.status === 'error') {
    return {
      label: 'Needs attention',
      icon: <CircleAlertIcon className="size-3" />,
      className: 'border-error-solid/20 bg-error-solid/7 text-error-solid',
    };
  }
  return {
    label: connection.lastCheckSucceeded === true ? 'Verified' : 'Disconnected',
    icon: <CircleDotIcon className="size-3" />,
    className:
      connection.lastCheckSucceeded === true
        ? 'border-success-solid/20 bg-success-solid/7 text-success-solid'
        : 'border-token-border-light bg-token-bg-secondary/60 text-token-text-tertiary',
  };
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

function notify(
  result: { ok: boolean; message?: string },
  successTitle: string,
) {
  toast({
    id: `remote-connection-${Date.now()}`,
    title: result.ok ? successTitle : 'Remote connection failed',
    message:
      result.message ??
      (result.ok ? 'The operation completed.' : 'Please try again.'),
    type: result.ok ? 'info' : 'error',
    actions: [],
  });
}

export function RemoteConnectionsSection() {
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const sshRunnerGate = resolveFeatureGate(
    'ssh-runner',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const runnerAbstractionGate = resolveFeatureGate(
    'runner-abstraction',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const dockerRunnerGate = resolveFeatureGate(
    'docker-runner',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const runnerSelectionEnabled =
    sshRunnerGate.enabled && runnerAbstractionGate.enabled;
  const listConnections = useKartonProcedure((p) => p.remoteConnections.list);
  const saveConnection = useKartonProcedure((p) => p.remoteConnections.save);
  const deleteConnection = useKartonProcedure(
    (p) => p.remoteConnections.delete,
  );
  const testConnection = useKartonProcedure((p) => p.remoteConnections.test);
  const connectConnection = useKartonProcedure(
    (p) => p.remoteConnections.connect,
  );
  const disconnectConnection = useKartonProcedure(
    (p) => p.remoteConnections.disconnect,
  );
  const reconnectConnection = useKartonProcedure(
    (p) => p.remoteConnections.reconnect,
  );
  const openTerminal = useKartonProcedure(
    (p) => p.remoteConnections.openTerminal,
  );
  const setRunnerConnection = useKartonProcedure(
    (p) => p.remoteConnections.setRunnerConnection,
  );
  const selectIdentityFile = useKartonProcedure(
    (p) => p.remoteConnections.selectIdentityFile,
  );
  const createAgent = useKartonProcedure((p) => p.agents.create);
  const setLastOpenAgentId = useKartonProcedure(
    (p) => p.browser.setLastOpenAgentId,
  );
  const closeSettings = useKartonProcedure((p) => p.appScreen.closeSettings);
  const [, setOpenAgent] = useOpenAgent();

  const [connections, setConnections] = useState<RemoteConnectionPublic[]>([]);
  const [capabilities, setCapabilities] =
    useState<RemoteConnectionCapabilities | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runnerConnectionId, setRunnerConnectionId] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<RemoteConnectionInput>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const selected = useMemo(
    () => connections.find((item) => item.id === selectedId) ?? null,
    [connections, selectedId],
  );

  const applyConnection = useCallback((connection: RemoteConnectionPublic) => {
    setConnections((current) => [
      connection,
      ...current.filter((item) => item.id !== connection.id),
    ]);
    setSelectedId(connection.id);
    setDraft(toDraft(connection));
    setDeleteArmed(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listConnections();
      setConnections(result.connections);
      setCapabilities(result.capabilities);
      setRunnerConnectionId(result.runnerConnectionId);
      const current =
        result.connections.find((item) => item.id === selectedId) ??
        result.connections[0] ??
        null;
      setSelectedId(current?.id ?? null);
      setDraft(current ? toDraft(current) : EMPTY_DRAFT);
    } catch (error) {
      console.error('Failed to load remote connections:', error);
      notify(
        {
          ok: false,
          message: 'Encrypted connection storage is unavailable.',
        },
        'Remote connections loaded',
      );
    } finally {
      setLoading(false);
    }
  }, [listConnections, selectedId]);

  useEffect(() => {
    void refresh();
    // Refresh is intentionally run only when the backend procedure changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listConnections]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const result = await saveConnection(draft);
      if (!result.ok) {
        notify(result, 'Remote connection saved');
        return;
      }
      applyConnection(result.connection);
      notify(
        {
          ok: true,
          message: 'Connection details and credentials are encrypted at rest.',
        },
        'Remote connection saved',
      );
    } finally {
      setSaving(false);
    }
  }, [applyConnection, draft, saveConnection]);

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<{
        ok: boolean;
        message?: string;
        connection?: RemoteConnectionPublic;
      }>,
      successTitle: string,
    ) => {
      if (operation) return;
      setOperation(key);
      try {
        const result = await action();
        if (result.connection) applyConnection(result.connection);
        notify(result, successTitle);
      } finally {
        setOperation(null);
      }
    },
    [applyConnection, operation],
  );

  const handleDelete = useCallback(async () => {
    if (!selected || operation) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setOperation('delete');
    try {
      const result = await deleteConnection(selected.id);
      if (!result.ok) {
        notify(result, 'Remote connection deleted');
        return;
      }
      const remaining = connections.filter((item) => item.id !== result.id);
      setConnections(remaining);
      const next = remaining[0] ?? null;
      setSelectedId(next?.id ?? null);
      setDraft(next ? toDraft(next) : EMPTY_DRAFT);
      setDeleteArmed(false);
      notify(
        { ok: true, message: 'The encrypted profile was removed.' },
        'Remote connection deleted',
      );
    } finally {
      setOperation(null);
    }
  }, [connections, deleteArmed, deleteConnection, operation, selected]);

  const handleNewTask = useCallback(async () => {
    if (!selected || operation) return;
    setOperation('task');
    try {
      const pathHint = selected.remotePath
        ? ` Default remote directory: ${selected.remotePath}.`
        : '';
      const initialInput = `Work on the saved remote connection "${selected.name}" (connection ID: ${selected.id}, endpoint: ${endpoint(selected)}). Use mcp_clodex_remote_exec for remote shell commands and review every command with me before execution.${pathHint}\n\n`;
      const agentId = await createAgent(
        initialInput,
        undefined,
        undefined,
        undefined,
        false,
      );
      setOpenAgent(agentId);
      await setLastOpenAgentId(agentId);
      await closeSettings();
    } catch (error) {
      console.error('Failed to create remote task:', error);
      notify(
        { ok: false, message: 'A remote task could not be created.' },
        'Remote task created',
      );
    } finally {
      setOperation(null);
    }
  }, [
    closeSettings,
    createAgent,
    operation,
    selected,
    setLastOpenAgentId,
    setOpenAgent,
  ]);

  const handleRunnerSelection = useCallback(async () => {
    if (!selected || operation) return;
    const nextId = runnerConnectionId === selected.id ? null : selected.id;
    setOperation('runner');
    try {
      const result = await setRunnerConnection(nextId);
      if (!result.ok) {
        notify(result, 'SSH runner updated');
        return;
      }
      setRunnerConnectionId(result.runnerConnectionId);
      notify(result, 'SSH runner updated');
    } finally {
      setOperation(null);
    }
  }, [operation, runnerConnectionId, selected, setRunnerConnection]);

  const connectedCount = connections.filter(
    (item) => item.status === 'connected',
  ).length;
  const credentialCount = connections.filter(
    (item) =>
      item.authentication.type !== 'ssh-agent' &&
      item.authentication.credentialConfigured,
  ).length;
  const selectedStatus = selected ? statusInfo(selected) : null;

  return (
    <SettingsPage
      eyebrow="Remote development"
      title="Remote Connections"
      description="Save encrypted SSH profiles, verify connectivity, keep live sessions, and hand them to tasks or the integrated terminal."
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon
              className={cn('size-3.5', loading && 'animate-spin')}
            />
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setSelectedId(null);
              setDraft(EMPTY_DRAFT);
              setDeleteArmed(false);
            }}
          >
            <PlusIcon className="size-3.5" />
            New connection
          </Button>
        </div>
      }
      toolbar={
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SettingsSummaryCard
            accent
            label="saved profiles"
            value={connections.length}
            icon={<ServerCogIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="live sessions"
            value={connectedCount}
            icon={<PlugIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="encrypted credentials"
            value={credentialCount}
            icon={<ShieldCheckIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="task runner"
            value={runnerConnectionId ? 1 : 0}
            icon={<ServerCogIcon className="size-4" />}
          />
        </div>
      }
    >
      <div className="space-y-5">
        {dockerRunnerGate.available && (
          <DockerRunnerProfilesPanel
            sshRunnerConnectionId={runnerConnectionId}
          />
        )}

        {capabilities && !capabilities.sshExecutable && (
          <div className="flex items-start gap-3 rounded-2xl border border-warning-solid/25 bg-warning-solid/8 px-4 py-3.5">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-solid" />
            <div>
              <div className="font-medium text-sm text-token-text-primary">
                OpenSSH is unavailable
              </div>
              <p className="mt-0.5 text-token-text-secondary text-xs">
                Install the system ssh client before testing these profiles.
              </p>
            </div>
          </div>
        )}

        <div className="grid min-h-[34rem] grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <section className="space-y-3">
            <SettingsSectionHeader
              title="Saved profiles"
              description="Secrets never leave the main process."
            />
            {loading && connections.length === 0 ? (
              <SettingsPanel className="flex h-28 items-center justify-center">
                <LoaderCircleIcon className="size-5 animate-spin text-token-text-tertiary" />
              </SettingsPanel>
            ) : connections.length === 0 ? (
              <SettingsPanel className="p-5 text-center">
                <ServerCogIcon className="mx-auto size-6 text-token-text-tertiary" />
                <p className="mt-2 font-medium text-sm text-token-text-primary">
                  No remote connections
                </p>
                <p className="mt-1 text-token-text-tertiary text-xs">
                  Add an SSH profile to start a remote task.
                </p>
              </SettingsPanel>
            ) : (
              <div className="space-y-2">
                {connections.map((connection) => {
                  const info = statusInfo(connection);
                  return (
                    <button
                      key={connection.id}
                      type="button"
                      className={cn(
                        'w-full rounded-xl border p-3 text-left transition-colors',
                        selectedId === connection.id
                          ? 'border-clodex-green-400/35 bg-clodex-green-400/6'
                          : 'border-token-border-light bg-token-main-surface-primary/70 hover:border-token-border-default',
                      )}
                      onClick={() => {
                        setSelectedId(connection.id);
                        setDraft(toDraft(connection));
                        setDeleteArmed(false);
                      }}
                    >
                      <div className="truncate font-medium text-sm text-token-text-primary">
                        {connection.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-token-text-tertiary">
                        {endpoint(connection)}
                      </div>
                      <span
                        className={cn(
                          'mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[10px]',
                          info.className,
                        )}
                      >
                        {info.icon}
                        {info.label}
                      </span>
                      {runnerConnectionId === connection.id && (
                        <span className="mt-2 ml-1 inline-flex items-center gap-1 rounded-full border border-clodex-green-400/30 bg-clodex-green-400/8 px-2 py-0.5 font-medium text-[10px] text-clodex-green-400">
                          <ServerCogIcon className="size-2.5" />
                          SSH runner
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <SettingsPanel className="overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-token-border-light border-b px-5 py-4">
              <div>
                <h2 className="font-semibold text-base text-token-text-primary">
                  {draft.id ? 'Connection details' : 'New SSH connection'}
                </h2>
                <p className="mt-1 text-token-text-secondary text-xs">
                  Credentials use OS-backed encryption at rest.
                </p>
              </div>
              {selectedStatus && (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 font-medium text-[11px]',
                    selectedStatus.className,
                  )}
                >
                  {selectedStatus.icon}
                  {selectedStatus.label}
                </span>
              )}
            </div>

            <div className="space-y-5 p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Display name">
                  <Input
                    value={draft.name}
                    placeholder="Production API"
                    className="max-w-none"
                    onValueChange={(name) =>
                      setDraft((current) => ({ ...current, name }))
                    }
                  />
                </Field>
                <Field label="Username">
                  <Input
                    value={draft.username}
                    placeholder="deploy"
                    autoComplete="username"
                    className="max-w-none"
                    onValueChange={(username) =>
                      setDraft((current) => ({ ...current, username }))
                    }
                  />
                </Field>
                <Field label="Host">
                  <Input
                    value={draft.host}
                    placeholder="server.example.com"
                    spellCheck={false}
                    className="max-w-none font-mono"
                    onValueChange={(host) =>
                      setDraft((current) => ({ ...current, host }))
                    }
                  />
                </Field>
                <Field label="Port">
                  <Input
                    type="number"
                    min={1}
                    max={65_535}
                    value={String(draft.port)}
                    className="max-w-none"
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        port: Number(value),
                      }))
                    }
                  />
                </Field>
              </div>

              <Field
                label="Default remote directory"
                hint="Optional. Remote task commands begin in this directory."
              >
                <Input
                  value={draft.remotePath ?? ''}
                  placeholder="/srv/app"
                  spellCheck={false}
                  className="max-w-none font-mono"
                  onValueChange={(remotePath) =>
                    setDraft((current) => ({ ...current, remotePath }))
                  }
                />
              </Field>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Authentication">
                  <Select<RemoteConnectionAuthType>
                    value={draft.authentication.type}
                    items={AUTH_ITEMS}
                    size="sm"
                    triggerClassName="w-full"
                    onValueChange={(type) =>
                      setDraft((current) => ({
                        ...current,
                        authentication:
                          type === 'ssh-agent'
                            ? { type }
                            : type === 'private-key'
                              ? { type, identityFile: '' }
                              : { type },
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Host-key policy"
                  hint="Strict is safest. Accept-new permits only previously unknown hosts."
                >
                  <Select<RemoteConnectionInput['hostKeyPolicy']>
                    value={draft.hostKeyPolicy}
                    items={[
                      { value: 'strict', label: 'Strict verification' },
                      { value: 'accept-new', label: 'Accept new hosts' },
                    ]}
                    size="sm"
                    triggerClassName="w-full"
                    onValueChange={(hostKeyPolicy) =>
                      setDraft((current) => ({
                        ...current,
                        hostKeyPolicy,
                      }))
                    }
                  />
                </Field>
              </div>

              {draft.authentication.type === 'private-key' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Private key file">
                    <div className="flex gap-2">
                      <Input
                        value={draft.authentication.identityFile}
                        placeholder="~/.ssh/id_ed25519"
                        spellCheck={false}
                        className="min-w-0 max-w-none flex-1 font-mono"
                        onValueChange={(identityFile) =>
                          setDraft((current) => ({
                            ...current,
                            authentication: {
                              type: 'private-key',
                              identityFile,
                            },
                          }))
                        }
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void selectIdentityFile().then((identityFile) => {
                            if (!identityFile) return;
                            setDraft((current) => ({
                              ...current,
                              authentication: {
                                type: 'private-key',
                                identityFile,
                              },
                            }));
                          })
                        }
                      >
                        Choose…
                      </Button>
                    </div>
                  </Field>
                  <Field
                    label="Key passphrase"
                    hint={
                      selected?.authentication.type === 'private-key' &&
                      selected.authentication.credentialConfigured
                        ? 'A passphrase is saved. Leave blank to keep it.'
                        : 'Optional for unencrypted private keys.'
                    }
                  >
                    <Input
                      type="password"
                      value={draft.authentication.secret ?? ''}
                      placeholder="Optional passphrase"
                      autoComplete="new-password"
                      className="max-w-none"
                      onValueChange={(secret) =>
                        setDraft((current) => ({
                          ...current,
                          authentication:
                            current.authentication.type === 'private-key'
                              ? { ...current.authentication, secret }
                              : current.authentication,
                        }))
                      }
                    />
                  </Field>
                </div>
              )}

              {draft.authentication.type === 'password' && (
                <Field
                  label="SSH password"
                  hint={
                    selected?.authentication.type === 'password' &&
                    selected.authentication.credentialConfigured
                      ? 'A password is saved. Leave blank to keep it.'
                      : 'Required and encrypted before it is written to disk.'
                  }
                >
                  <div className="relative">
                    <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-token-text-tertiary" />
                    <Input
                      type="password"
                      value={draft.authentication.secret ?? ''}
                      placeholder="Password"
                      autoComplete="new-password"
                      className="max-w-none pl-9"
                      onValueChange={(secret) =>
                        setDraft((current) => ({
                          ...current,
                          authentication:
                            current.authentication.type === 'password'
                              ? { ...current.authentication, secret }
                              : current.authentication,
                        }))
                      }
                    />
                  </div>
                </Field>
              )}

              {selected?.lastError && (
                <div className="flex items-start gap-3 rounded-xl border border-error-solid/20 bg-error-solid/7 px-3.5 py-3">
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-error-solid" />
                  <div>
                    <div className="font-medium text-token-text-primary text-xs">
                      Last SSH error
                    </div>
                    <p className="mt-0.5 break-words text-[11px] text-token-text-secondary">
                      {selected.lastError}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3 border-token-border-light border-t bg-token-bg-secondary/25 px-5 py-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving || Boolean(operation)}
                  onClick={() => void handleSave()}
                >
                  {saving && (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  )}
                  {draft.id ? 'Save changes' : 'Save connection'}
                </Button>
                {selected && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={Boolean(operation)}
                      onClick={() =>
                        void run(
                          'test',
                          () => testConnection(selected.id),
                          'SSH connection verified',
                        )
                      }
                    >
                      <ShieldCheckIcon className="size-3.5" />
                      Test
                    </Button>
                    {selected.status === 'connected' ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={Boolean(operation)}
                          onClick={() =>
                            void run(
                              'reconnect',
                              () => reconnectConnection(selected.id),
                              'SSH session reconnected',
                            )
                          }
                        >
                          <RotateCwIcon className="size-3.5" />
                          Reconnect
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={Boolean(operation)}
                          onClick={() =>
                            void run(
                              'disconnect',
                              () => disconnectConnection(selected.id),
                              'SSH session disconnected',
                            )
                          }
                        >
                          <UnplugIcon className="size-3.5" />
                          Disconnect
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={
                          Boolean(operation) ||
                          capabilities?.persistentSessions === false
                        }
                        onClick={() =>
                          void run(
                            'connect',
                            () => connectConnection(selected.id),
                            'SSH session connected',
                          )
                        }
                      >
                        <PlugIcon className="size-3.5" />
                        Connect
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={
                        Boolean(operation) ||
                        capabilities?.terminalHandoff === false
                      }
                      onClick={() =>
                        void run(
                          'terminal',
                          () => openTerminal(selected.id),
                          'Remote terminal opened',
                        )
                      }
                    >
                      <SquareTerminalIcon className="size-3.5" />
                      Terminal
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={Boolean(operation)}
                      onClick={() => void handleNewTask()}
                    >
                      <MessageSquarePlusIcon className="size-3.5" />
                      New task
                    </Button>
                    {sshRunnerGate.available && (
                      <Button
                        variant={
                          runnerConnectionId === selected.id
                            ? 'primary'
                            : 'secondary'
                        }
                        size="sm"
                        disabled={Boolean(operation) || !runnerSelectionEnabled}
                        onClick={() => void handleRunnerSelection()}
                      >
                        <ServerCogIcon className="size-3.5" />
                        {runnerConnectionId === selected.id
                          ? 'Stop using as runner'
                          : 'Use as SSH runner'}
                      </Button>
                    )}
                  </>
                )}
              </div>

              {selected && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] text-token-text-tertiary">
                    {sshRunnerGate.available && !runnerSelectionEnabled
                      ? `Enable “${sshRunnerGate.definition.name}” and “${runnerAbstractionGate.definition.name}” in Preview features to route task shell commands here.`
                      : runnerConnectionId === selected.id
                        ? 'Task shell commands are routed here with snapshot verification and signed receipts.'
                        : 'Remote commands always require explicit approval.'}
                  </p>
                  <Button
                    variant={deleteArmed ? 'primary' : 'ghost'}
                    size="sm"
                    className={cn(
                      !deleteArmed && 'text-error-solid hover:text-error-solid',
                    )}
                    disabled={Boolean(operation)}
                    onClick={() => void handleDelete()}
                  >
                    <Trash2Icon className="size-3.5" />
                    {deleteArmed ? 'Confirm delete' : 'Delete'}
                  </Button>
                </div>
              )}
            </div>
          </SettingsPanel>
        </div>
      </div>
    </SettingsPage>
  );
}
