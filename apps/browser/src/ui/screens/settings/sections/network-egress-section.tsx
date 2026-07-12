import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import { Select } from '@clodex/stage-ui/components/select';
import { toast } from '@clodex/stage-ui/components/toaster';
import { resolveFeatureGate } from '@shared/feature-gates';
import type {
  NetworkEgressComponentStatus,
  NetworkEgressControlSnapshot,
  NetworkEgressGrantInput,
  NetworkEgressGrantScope,
} from '@shared/network-egress-control';
import type { NetworkPolicyProtocol } from '@shared/network-policy';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  LoaderCircleIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

type ExpirationChoice =
  | '1-hour'
  | '8-hours'
  | '24-hours'
  | '7-days'
  | '30-days'
  | 'forever';

const PROTOCOL_ITEMS: Array<{
  value: NetworkPolicyProtocol;
  label: string;
}> = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS / secure tunnel' },
];

const SCOPE_ITEMS: Array<{ value: NetworkEgressGrantScope; label: string }> = [
  { value: 'session', label: 'This app session' },
  { value: 'persistent', label: 'Persist across restarts' },
];

const SESSION_EXPIRATION_ITEMS: Array<{
  value: ExpirationChoice;
  label: string;
}> = [
  { value: '1-hour', label: '1 hour' },
  { value: '8-hours', label: '8 hours' },
  { value: '24-hours', label: '24 hours' },
];

const PERSISTENT_EXPIRATION_ITEMS: Array<{
  value: ExpirationChoice;
  label: string;
}> = [
  { value: 'forever', label: 'Until revoked' },
  { value: '7-days', label: '7 days' },
  { value: '30-days', label: '30 days' },
];

const EXPIRATION_MS: Record<Exclude<ExpirationChoice, 'forever'>, number> = {
  '1-hour': 60 * 60 * 1_000,
  '8-hours': 8 * 60 * 60 * 1_000,
  '24-hours': 24 * 60 * 60 * 1_000,
  '7-days': 7 * 24 * 60 * 60 * 1_000,
  '30-days': 30 * 24 * 60 * 60 * 1_000,
};

function statusPresentation(status: NetworkEgressComponentStatus) {
  if (status === 'active') {
    return {
      label: 'Active',
      className: 'text-success-solid',
      icon: <CircleCheckIcon className="size-4" />,
    };
  }
  if (status === 'fail-closed') {
    return {
      label: 'Fail closed',
      className: 'text-warning-solid',
      icon: <CircleAlertIcon className="size-4" />,
    };
  }
  if (status === 'unavailable') {
    return {
      label: 'Unavailable',
      className: 'text-error-solid',
      icon: <CircleAlertIcon className="size-4" />,
    };
  }
  return {
    label: 'Disabled',
    className: 'text-token-text-tertiary',
    icon: <CircleAlertIcon className="size-4" />,
  };
}

function notify(type: 'info' | 'error', title: string, message: string): void {
  toast({
    id: `network-egress-${Date.now()}`,
    title,
    message,
    type,
    actions: [],
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatExpiration(value: number | null): string {
  return value === null ? 'Until revoked' : formatTimestamp(value);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block space-y-1.5">
      <span className="font-medium text-token-text-secondary text-xs">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-token-text-tertiary leading-4">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function NetworkEgressSection() {
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const gate = resolveFeatureGate(
    'egress-control-center',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const getSnapshot = useKartonProcedure(
    (procedures) => procedures.networkEgressControl.getSnapshot,
  );
  const addGrant = useKartonProcedure(
    (procedures) => procedures.networkEgressControl.addGrant,
  );
  const revokeGrant = useKartonProcedure(
    (procedures) => procedures.networkEgressControl.revokeGrant,
  );
  const exportAudit = useKartonProcedure(
    (procedures) => procedures.networkEgressControl.exportAudit,
  );
  const [snapshot, setSnapshot] = useState<NetworkEgressControlSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<NetworkPolicyProtocol>('http');
  const [hostname, setHostname] = useState('localhost');
  const [port, setPort] = useState('3000');
  const [scope, setScope] = useState<NetworkEgressGrantScope>('session');
  const [expiration, setExpiration] = useState<ExpirationChoice>('1-hour');

  const refresh = useCallback(async () => {
    if (!gate.enabled) return;
    setLoading(true);
    try {
      setSnapshot(await getSnapshot({ auditLimit: 100 }));
    } catch (error) {
      notify('error', 'Egress control unavailable', describeError(error));
    } finally {
      setLoading(false);
    }
  }, [gate.enabled, getSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const auditRecords = useMemo(
    () => [...(snapshot?.audit.records ?? [])].reverse(),
    [snapshot?.audit.records],
  );
  const expirationItems =
    scope === 'session'
      ? SESSION_EXPIRATION_ITEMS
      : PERSISTENT_EXPIRATION_ITEMS;
  const browserReady = snapshot?.browser.status === 'active';

  const handleScopeChange = (nextScope: NetworkEgressGrantScope) => {
    setScope(nextScope);
    setExpiration(nextScope === 'session' ? '1-hour' : 'forever');
  };

  const handleProtocolChange = (nextProtocol: NetworkPolicyProtocol) => {
    setProtocol(nextProtocol);
    if (port === '80' || port === '443') {
      setPort(nextProtocol === 'https' ? '443' : '80');
    }
  };

  const handleAdd = async () => {
    const numericPort = Number(port);
    if (
      !Number.isInteger(numericPort) ||
      numericPort < 1 ||
      numericPort > 65_535
    ) {
      notify('error', 'Invalid port', 'Use a port between 1 and 65535.');
      return;
    }
    const trimmedHostname = hostname.trim();
    if (!trimmedHostname) {
      notify('error', 'Invalid hostname', 'Enter an exact destination host.');
      return;
    }
    const input: NetworkEgressGrantInput = {
      scope,
      protocol,
      hostname: trimmedHostname,
      port: numericPort,
      ttlMs: expiration === 'forever' ? null : EXPIRATION_MS[expiration],
    };
    setOperation('add');
    try {
      setSnapshot(await addGrant(input));
      notify(
        'info',
        'Destination granted',
        `${protocol}://${trimmedHostname}:${numericPort} is allowed for the shared browser session.`,
      );
    } catch (error) {
      notify('error', 'Grant failed', describeError(error));
    } finally {
      setOperation(null);
    }
  };

  const handleRevoke = async (grantId: string) => {
    setOperation(grantId);
    try {
      setSnapshot(await revokeGrant(grantId));
      notify(
        'info',
        'Destination revoked',
        'Live browser connections were reset at the policy boundary.',
      );
    } catch (error) {
      notify('error', 'Revoke failed', describeError(error));
    } finally {
      setOperation(null);
    }
  };

  const handleExport = async () => {
    setOperation('export');
    try {
      const result = await exportAudit();
      if (!result.canceled) {
        notify(
          'info',
          'Audit exported',
          `${result.count} sanitized records were exported.`,
        );
      }
    } catch (error) {
      notify('error', 'Export failed', describeError(error));
    } finally {
      setOperation(null);
    }
  };

  if (!gate.enabled) {
    return (
      <SettingsPage
        title="Network Egress"
        description="Enable the Egress control center preview feature to manage exact browser destinations."
      >
        <SettingsPanel className="p-5 text-sm text-token-text-secondary">
          This surface is disabled by its feature flag.
        </SettingsPanel>
      </SettingsPage>
    );
  }

  const policyStatus = statusPresentation(
    snapshot?.policyEngine.status ?? 'unavailable',
  );
  const proxyStatus = statusPresentation(
    snapshot?.proxy.status ?? 'unavailable',
  );
  const browserStatus = statusPresentation(
    snapshot?.browser.status ?? 'unavailable',
  );

  return (
    <SettingsPage
      eyebrow="Zero-trust networking"
      title="Network Egress"
      description="Inspect the managed browser network boundary, grant exact destinations, and export a content-free tamper-evident audit."
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon
            className={cn('size-3.5', loading && 'animate-spin')}
          />
          Refresh
        </Button>
      }
      toolbar={
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SettingsSummaryCard
            accent={policyStatus.label === 'Active'}
            label="policy engine"
            value={policyStatus.label}
            icon={<ShieldCheckIcon className={policyStatus.className} />}
          />
          <SettingsSummaryCard
            accent={proxyStatus.label === 'Active'}
            label="managed proxy"
            value={proxyStatus.label}
            icon={<NetworkIcon className={proxyStatus.className} />}
          />
          <SettingsSummaryCard
            accent={browserStatus.label === 'Active'}
            label="shared browser"
            value={browserStatus.label}
            icon={browserStatus.icon}
          />
        </div>
      }
    >
      <div className="space-y-7">
        {snapshot?.browser.failClosed ? (
          <div className="flex items-start gap-3 rounded-2xl border border-warning-solid/25 bg-warning-solid/8 px-4 py-3.5">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-solid" />
            <div>
              <div className="font-medium text-sm text-token-text-primary">
                Browser networking is fail closed
              </div>
              <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
                The managed proxy capability is unavailable. Chromium remains
                attached to a dead loopback proxy instead of falling back to
                direct networking.
              </p>
            </div>
          </div>
        ) : null}

        <section className="space-y-3">
          <SettingsSectionHeader
            title="Exact destination grants"
            description="Grants bind protocol, hostname, and port. They do not enable loopback or private networks globally."
          />
          <SettingsPanel className="p-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[0.8fr_minmax(0,1.5fr)_0.6fr]">
              <Field label="Protocol">
                <Select<NetworkPolicyProtocol>
                  value={protocol}
                  items={PROTOCOL_ITEMS}
                  size="sm"
                  triggerClassName="w-full"
                  onValueChange={handleProtocolChange}
                />
              </Field>
              <Field label="Exact hostname" hint="No wildcard expansion.">
                <Input
                  value={hostname}
                  placeholder="localhost"
                  spellCheck={false}
                  className="max-w-none font-mono"
                  onValueChange={setHostname}
                />
              </Field>
              <Field label="Port">
                <Input
                  value={port}
                  inputMode="numeric"
                  placeholder="3000"
                  className="max-w-none font-mono"
                  onValueChange={setPort}
                />
              </Field>
              <Field label="Scope">
                <Select<NetworkEgressGrantScope>
                  value={scope}
                  items={SCOPE_ITEMS}
                  size="sm"
                  triggerClassName="w-full"
                  onValueChange={handleScopeChange}
                />
              </Field>
              <Field label="Expiration">
                <Select<ExpirationChoice>
                  value={expiration}
                  items={expirationItems}
                  size="sm"
                  triggerClassName="w-full"
                  onValueChange={setExpiration}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full"
                  disabled={!browserReady || operation !== null}
                  onClick={() => void handleAdd()}
                >
                  {operation === 'add' ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  Add grant
                </Button>
              </div>
            </div>
            <p className="mt-4 text-[11px] text-token-text-tertiary leading-5">
              Current enforcement scope is the shared Chromium session, not an
              individual tab. Per-tab isolation requires separate browser
              partitions or a stronger request-to-tab binding.
            </p>
          </SettingsPanel>

          {loading && !snapshot ? (
            <SettingsPanel className="flex h-24 items-center justify-center">
              <LoaderCircleIcon className="size-5 animate-spin text-token-text-tertiary" />
            </SettingsPanel>
          ) : snapshot?.grants.length ? (
            <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
              {snapshot.grants.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm text-token-text-primary">
                      {grant.protocol}://{grant.hostname}:{grant.port}
                    </div>
                    <div className="mt-0.5 text-[11px] text-token-text-tertiary">
                      {grant.scope === 'session' ? 'Session' : 'Persistent'} ·{' '}
                      {formatExpiration(grant.expiresAt)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={operation !== null}
                    onClick={() => void handleRevoke(grant.id)}
                  >
                    {operation === grant.id ? (
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    Revoke
                  </Button>
                </div>
              ))}
            </SettingsPanel>
          ) : (
            <SettingsPanel className="p-5 text-center">
              <ShieldCheckIcon className="mx-auto size-6 text-token-text-tertiary" />
              <p className="mt-2 font-medium text-sm text-token-text-primary">
                No exact grants
              </p>
              <p className="mt-1 text-token-text-tertiary text-xs">
                Public web ports remain governed by the base browser policy.
              </p>
            </SettingsPanel>
          )}
        </section>

        <section className="space-y-3">
          <SettingsSectionHeader
            title="Sanitized audit"
            description="Records contain hashes and connection metadata only—never URLs, paths, queries, cookies, headers, or response bodies."
            trailing={
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  operation !== null || snapshot?.audit.status !== 'verified'
                }
                onClick={() => void handleExport()}
              >
                {operation === 'export' ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3.5" />
                )}
                Export
              </Button>
            }
          />
          <SettingsPanel className="overflow-hidden">
            {snapshot?.audit.status === 'unavailable' ? (
              <div className="p-5 text-error-solid text-sm">
                Audit integrity could not be verified.
              </div>
            ) : auditRecords.length === 0 ? (
              <div className="p-5 text-sm text-token-text-tertiary">
                No network policy decisions have been recorded yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-left text-xs">
                  <thead className="border-token-border-light border-b bg-token-bg-secondary/45 text-token-text-tertiary">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Time</th>
                      <th className="px-3 py-2.5 font-medium">Principal</th>
                      <th className="px-3 py-2.5 font-medium">Decision</th>
                      <th className="px-3 py-2.5 font-medium">Destination</th>
                      <th className="px-3 py-2.5 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-token-border-light">
                    {auditRecords.map((record) => (
                      <tr key={record.eventHash}>
                        <td className="whitespace-nowrap px-4 py-2.5 text-token-text-secondary">
                          {formatTimestamp(record.createdAt)}
                        </td>
                        <td className="px-3 py-2.5 text-token-text-secondary">
                          {record.principalKind}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2.5 font-medium',
                            record.decision === 'allow'
                              ? 'text-success-solid'
                              : 'text-error-solid',
                          )}
                        >
                          {record.decision}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-token-text-secondary">
                          {record.protocol ?? '—'}:
                          {record.destinationPort ?? '—'} ·{' '}
                          {record.destinationHostHash
                            ? record.destinationHostHash.slice(0, 12)
                            : 'no-host'}
                        </td>
                        <td className="px-3 py-2.5 text-token-text-tertiary">
                          {record.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SettingsPanel>
          {snapshot?.audit.truncated ? (
            <p className="text-[11px] text-token-text-tertiary">
              Showing the newest 100 records. Export includes the complete
              verified ledger.
            </p>
          ) : null}
        </section>
      </div>
    </SettingsPage>
  );
}
