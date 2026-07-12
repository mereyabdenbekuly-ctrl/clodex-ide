import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import { Select } from '@clodex/stage-ui/components/select';
import { Switch } from '@clodex/stage-ui/components/switch';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { resolveFeatureGate, type FeatureGateId } from '@shared/feature-gates';
import type {
  BrowserUseApprovalMode,
  BrowserUseCapability,
  ChronicleEvent,
  HookTrigger,
} from '@shared/agent-os';
import type {
  DesktopAutomationAppPolicyMode,
  DesktopAutomationPermissionKind,
  DesktopAutomationPermissionStatus,
} from '@shared/desktop-automation';
import {
  GUARDIAN_POLICY_VERSION,
  isGuardianFeedbackAllowedForDecision,
  type GuardianFeedbackLabel,
} from '@shared/guardian';
import {
  evaluateGuardianReleaseReadiness,
  GUARDIAN_RELEASE_THRESHOLDS,
} from '@shared/guardian-release-readiness';
import {
  BugIcon,
  CameraIcon,
  Gamepad2Icon,
  GlobeLockIcon,
  LinkIcon,
  MonitorCogIcon,
  OctagonIcon,
  PackageIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WorkflowIcon,
} from 'lucide-react';
import { requestChatInputPrefill } from '@ui/screens/main/agent-chat/chat/_lib/chat-input-events';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSummaryCard,
} from '../_components/settings-page';
import {
  createChronicleContext,
  resolveDroppedSkillPath,
  schedulePrefillWhenChatReady,
} from './agent-os-settings-model';

const POLICY_ITEMS = [
  { value: 'ask' as const, label: 'Ask' },
  { value: 'allow' as const, label: 'Allow' },
  { value: 'block' as const, label: 'Block' },
];

const AGENT_OS_FEATURES = [
  'agent-os-debug-inspector',
  'browser-use-policy-engine',
  'desktop-automation-macos-preview',
  'native-skill-install',
  'agent-hooks',
  'chronicle-visual-memory',
  'codex-micro-controller',
  'remote-control-pairing',
  'multi-agent-guardian',
] as const satisfies readonly FeatureGateId[];

function FeatureCard({
  feature,
  icon,
  title,
  description,
  children,
}: {
  feature: FeatureGateId;
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const resolved = useKartonState((state) =>
    resolveFeatureGate(
      feature,
      state.preferences.featureGates.overrides,
      state.appInfo.releaseChannel,
    ),
  );

  return (
    <SettingsPanel className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-codex-blue-400/18 bg-codex-blue-400/8 p-2 text-codex-blue-400">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-medium text-sm text-token-text-primary">
              {title}
            </h2>
            <span className="rounded-full border border-codex-blue-400/18 bg-codex-blue-400/8 px-2 py-0.5 font-medium text-[10px] text-codex-blue-400 uppercase tracking-[0.06em]">
              {resolved.definition.stage}
            </span>
          </div>
          <p className="mt-1 text-token-text-secondary text-xs leading-5">
            {description}
          </p>
        </div>
      </div>
      {resolved.enabled ? (
        children
      ) : (
        <p className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-3 text-token-text-secondary text-xs leading-5">
          Enable “{resolved.definition.name}” in Settings → Agent → General →
          Preview features.
        </p>
      )}
    </SettingsPanel>
  );
}

function SettingToggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3 className="font-medium text-foreground text-sm">{title}</h3>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} size="xs" />
    </div>
  );
}

function ChronicleSettings() {
  const state = useKartonState((item) => item.agentOs.chronicle);
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.agentOs.chronicle.setEnabled,
  );
  const setSettings = useKartonProcedure(
    (procedures) => procedures.agentOs.chronicle.setSettings,
  );
  const captureNow = useKartonProcedure(
    (procedures) => procedures.agentOs.chronicle.captureNow,
  );
  const clear = useKartonProcedure(
    (procedures) => procedures.agentOs.chronicle.clear,
  );
  const search = useKartonProcedure(
    (procedures) => procedures.agentOs.chronicle.search,
  );
  const getRecent = useKartonProcedure(
    (procedures) => procedures.agentOs.chronicle.getRecent,
  );
  const closeSettings = useKartonProcedure(
    (procedures) => procedures.appScreen.closeSettings,
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChronicleEvent[]>([]);
  const [searching, setSearching] = useState(false);

  const runSearch = async () => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      setResults(await search(query));
    } finally {
      setSearching(false);
    }
  };

  const attachRecent = async () => {
    const recent = await getRecent(5);
    if (recent.length === 0) return;
    const prefill = createChronicleContext(recent);
    await closeSettings();
    schedulePrefillWhenChatReady({
      isReady: () =>
        document.querySelector('#chat-input-container-box') !== null,
      requestPrefill: () => requestChatInputPrefill(prefill),
      scheduleFrame: (callback) => window.requestAnimationFrame(callback),
    });
  };

  return (
    <div className="space-y-4">
      <SettingToggle
        title="Enable Chronicle"
        description="No screenshot is captured before this is explicitly enabled."
        checked={state.enabled}
        onChange={(checked) => void setEnabled(checked)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 text-muted-foreground text-xs">
          <span>Retention</span>
          <Select
            value={state.retention}
            items={[
              { value: 'off', label: 'Off' },
              { value: '1-hour', label: '1 hour' },
              { value: '24-hours', label: '24 hours' },
              { value: '7-days', label: '7 days' },
            ]}
            onValueChange={(retention) =>
              void setSettings({
                retention: retention as typeof state.retention,
              })
            }
            size="sm"
          />
        </div>
        <div className="space-y-1 text-muted-foreground text-xs">
          <span>Privacy mode</span>
          <Select
            value={state.privacyMode}
            items={[
              { value: 'strict', label: 'Strict' },
              { value: 'balanced', label: 'Balanced' },
            ]}
            onValueChange={(privacyMode) =>
              void setSettings({
                privacyMode: privacyMode as typeof state.privacyMode,
              })
            }
            size="sm"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!state.enabled || state.recording}
          onClick={() => void captureNow()}
        >
          {state.recording ? 'Capturing…' : 'Capture now'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.events.length === 0}
          onClick={() => void clear()}
        >
          <Trash2Icon className="size-3.5" />
          Clear Chronicle
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.events.length === 0}
          onClick={() => void attachRecent()}
        >
          Attach recent context
        </Button>
      </div>
      <div className="space-y-2 rounded-lg bg-surface-1 p-3">
        <div className="flex gap-2">
          <Input
            value={query}
            onValueChange={setQuery}
            placeholder="Search visual memory"
            size="sm"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch();
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!query.trim() || searching}
            onClick={() => void runSearch()}
          >
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </div>
        {results.length > 0 && (
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {results.map((event) => (
              <div
                key={event.id}
                className="rounded-md border border-derived-subtle px-2.5 py-2 text-xs"
              >
                <p className="text-foreground">{event.text}</p>
                <p className="mt-1 text-muted-foreground">
                  {new Date(event.capturedAt).toLocaleString()} · {event.source}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {state.events.length} local events
        {state.lastCaptureAt
          ? ` · last capture ${new Date(state.lastCaptureAt).toLocaleString()}`
          : ''}
      </p>
    </div>
  );
}

function MicroSettings() {
  const state = useKartonState((item) => item.agentOs.micro);
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.agentOs.micro.setEnabled,
  );
  return (
    <div className="space-y-4">
      <SettingToggle
        title="Show virtual controller"
        description="Displays a draggable command deck in the main agent view."
        checked={state.enabled}
        onChange={(checked) => void setEnabled(checked)}
      />
      <div className="flex flex-wrap gap-1.5">
        {state.actions.map((action) => (
          <span
            key={action.id}
            className="rounded-md border border-derived bg-surface-1 px-2 py-1 text-muted-foreground text-xs"
          >
            {action.title}
          </span>
        ))}
      </div>
    </div>
  );
}

function OriginPolicySelect({
  value,
  onChange,
}: {
  value: BrowserUseApprovalMode;
  onChange: (value: BrowserUseApprovalMode) => void;
}) {
  return (
    <Select
      value={value}
      items={POLICY_ITEMS}
      onValueChange={onChange}
      size="xs"
      triggerClassName="w-24"
    />
  );
}

function BrowserUseSettings() {
  const state = useKartonState((item) => item.agentOs.browserUse);
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.agentOs.browserUse.setEnabled,
  );
  const setPolicy = useKartonProcedure(
    (procedures) => procedures.agentOs.browserUse.setOriginPolicy,
  );
  const removePolicy = useKartonProcedure(
    (procedures) => procedures.agentOs.browserUse.removeOriginPolicy,
  );
  const [origin, setOrigin] = useState('https://');
  const policies = Object.values(state.policies).sort((a, b) =>
    a.origin.localeCompare(b.origin),
  );

  const addOrigin = () => {
    void setPolicy({
      origin,
      read: 'ask',
      click: 'ask',
      fileTransfer: 'ask',
      fullCdpAccess: 'block',
      history: 'ask',
      routeCapture: false,
      updatedAt: Date.now(),
    });
  };

  return (
    <div className="space-y-4">
      <SettingToggle
        title="Enable policy enforcement"
        description="Unknown origins ask for normal actions; full CDP access is blocked."
        checked={state.enabled}
        onChange={(checked) => void setEnabled(checked)}
      />
      <div className="flex gap-2">
        <Input
          value={origin}
          onValueChange={setOrigin}
          placeholder="https://example.com"
          size="sm"
        />
        <Button variant="secondary" size="sm" onClick={addOrigin}>
          Add origin
        </Button>
      </div>
      <div className="space-y-3">
        {policies.map((policy) => {
          const update = (
            capability: BrowserUseCapability,
            value: BrowserUseApprovalMode,
          ) => {
            void setPolicy({
              ...policy,
              [capability]: value,
              updatedAt: Date.now(),
            });
          };
          return (
            <div
              key={policy.origin}
              className="space-y-3 rounded-lg border border-derived-subtle p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="truncate text-foreground text-xs">
                  {policy.origin}
                </code>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void removePolicy(policy.origin)}
                  aria-label={`Remove ${policy.origin}`}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                {(
                  [
                    ['read', 'Read'],
                    ['click', 'Click'],
                    ['fileTransfer', 'Files'],
                    ['fullCdpAccess', 'Full CDP'],
                    ['history', 'History'],
                  ] as const
                ).map(([capability, label]) => (
                  <div
                    key={capability}
                    className="space-y-1 text-muted-foreground text-xs"
                  >
                    <span>{label}</span>
                    <OriginPolicySelect
                      value={policy[capability]}
                      onChange={(value) => update(capability, value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DESKTOP_POLICY_ITEMS = [
  { value: 'ask' as const, label: 'Ask' },
  { value: 'allow' as const, label: 'Allow' },
  { value: 'block' as const, label: 'Block' },
];

function permissionLabel(status: DesktopAutomationPermissionStatus): string {
  switch (status) {
    case 'granted':
      return 'Granted';
    case 'not-determined':
      return 'Not requested';
    case 'denied':
      return 'Denied';
    case 'restricted':
      return 'Restricted';
    case 'unsupported':
      return 'Unsupported';
    default:
      return 'Unknown';
  }
}

function DesktopAutomationSettings() {
  const state = useKartonState((item) => item.agentOs.desktopAutomation);
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.setEnabled,
  );
  const refreshPermissions = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.refreshPermissions,
  );
  const requestPermission = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.requestPermission,
  );
  const openPermissionSettings = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.openPermissionSettings,
  );
  const getFrontmostApp = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.getFrontmostApp,
  );
  const setAppPolicy = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.setAppPolicy,
  );
  const removeAppPolicy = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.removeAppPolicy,
  );
  const startSession = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.startSession,
  );
  const stopSession = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.stopSession,
  );
  const engageKillSwitch = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.engageKillSwitch,
  );
  const resetKillSwitch = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.resetKillSwitch,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const permissionsReady =
    state.permissions.screenRecording === 'granted' &&
    state.permissions.accessibility === 'granted';
  const policies = Object.values(state.policies).sort((a, b) =>
    a.appName.localeCompare(b.appName),
  );
  const permissionRows: Array<{
    kind: DesktopAutomationPermissionKind;
    label: string;
    status: DesktopAutomationPermissionStatus;
  }> = [
    {
      kind: 'screen-recording',
      label: 'Screen Recording',
      status: state.permissions.screenRecording,
    },
    {
      kind: 'accessibility',
      label: 'Accessibility & Automation',
      status: state.permissions.accessibility,
    },
  ];

  if (!state.supported) {
    return (
      <p className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-3 text-token-text-secondary text-xs leading-5">
        This preview is available only in the macOS desktop build. Browser/CDP
        automation remains available on every supported platform.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-warning-solid/25 bg-warning-solid/6 p-3 text-muted-foreground text-xs leading-5">
        Browser/CDP remains the preferred path. Desktop automation captures only
        the frontmost app window and exposes only bounded pressable
        accessibility controls. Text entry and secure/password fields are not
        supported.
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {permissionRows.map((permission) => (
          <div
            key={permission.kind}
            className="space-y-2 rounded-lg border border-derived-subtle p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground text-sm">
                {permission.label}
              </span>
              <span className="text-muted-foreground text-xs">
                {permissionLabel(permission.status)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || permission.status === 'granted'}
                onClick={() =>
                  void run(() => requestPermission(permission.kind))
                }
              >
                Request
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() => openPermissionSettings(permission.kind))
                }
              >
                Open settings
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void run(refreshPermissions)}
        >
          Refresh permissions
        </Button>
        <Button
          variant={state.enabled ? 'ghost' : 'secondary'}
          size="sm"
          disabled={busy || (!state.enabled && !permissionsReady)}
          onClick={() => void run(() => setEnabled(!state.enabled))}
        >
          {state.enabled ? 'Disable provider' : 'Enable provider'}
        </Button>
      </div>

      {state.enabled && (
        <div className="space-y-3 rounded-xl border border-derived-subtle p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium text-foreground text-sm">
                Protected automation session
              </p>
              <p className="text-muted-foreground text-xs">
                {state.active
                  ? `Active · kill switch ${state.killSwitchAccelerator}`
                  : state.killSwitchEngaged
                    ? 'Kill switch engaged'
                    : 'Inactive'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {state.killSwitchEngaged ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(resetKillSwitch)}
                >
                  Reset kill switch
                </Button>
              ) : state.active ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(stopSession)}
                  >
                    Stop session
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(engageKillSwitch)}
                  >
                    <OctagonIcon className="size-3.5" />
                    Kill switch
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    busy || !permissionsReady || !state.killSwitchRegistered
                  }
                  onClick={() => void run(startSession)}
                >
                  Start session
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(getFrontmostApp)}
            >
              Detect frontmost app
            </Button>
            {state.currentApp && (
              <>
                <span className="text-muted-foreground text-xs">
                  {state.currentApp.name}{' '}
                  <code>({state.currentApp.bundleId})</code>
                </span>
                {(
                  [
                    'ask',
                    'allow',
                    'block',
                  ] as const satisfies readonly DesktopAutomationAppPolicyMode[]
                ).map((mode) => (
                  <Button
                    key={mode}
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() => setAppPolicy(state.currentApp!, mode))
                    }
                  >
                    {mode}
                  </Button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {policies.map((policy) => (
          <div
            key={policy.bundleId}
            className="flex items-center justify-between gap-3 rounded-lg border border-derived-subtle p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground text-sm">
                {policy.appName}
              </p>
              <code className="block truncate text-[10px] text-muted-foreground">
                {policy.bundleId}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={policy.mode}
                items={DESKTOP_POLICY_ITEMS}
                onValueChange={(mode) =>
                  void run(() =>
                    setAppPolicy(
                      {
                        name: policy.appName,
                        bundleId: policy.bundleId,
                      },
                      mode as DesktopAutomationAppPolicyMode,
                    ),
                  )
                }
                size="xs"
                triggerClassName="w-24"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                onClick={() => void run(() => removeAppPolicy(policy.bundleId))}
                aria-label={`Remove ${policy.appName}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="rounded-lg border border-danger-solid/25 bg-danger-solid/6 p-2 text-danger-solid text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function DebugSettings() {
  const state = useKartonState((item) => item.agentOs.debugInspector);
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.agentOs.debug.setEnabled,
  );
  const setPaused = useKartonProcedure(
    (procedures) => procedures.agentOs.debug.setPaused,
  );
  const clear = useKartonProcedure(
    (procedures) => procedures.agentOs.debug.clear,
  );
  const exportJson = useKartonProcedure(
    (procedures) => procedures.agentOs.debug.exportJson,
  );
  const copyText = useKartonProcedure(
    (procedures) => procedures.browser.copyText,
  );
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('all');
  const events = useMemo(
    () =>
      state.events
        .filter((event) => channel === 'all' || event.channel === channel)
        .filter(
          (event) =>
            !query ||
            `${event.message} ${JSON.stringify(event.payload ?? {})}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
        )
        .slice()
        .reverse(),
    [channel, query, state.events],
  );

  return (
    <div className="space-y-4">
      <SettingToggle
        title="Enable debug inspector"
        description="Payloads are recursively sanitized before they enter the event stream."
        checked={state.enabled}
        onChange={(checked) => void setEnabled(checked)}
      />
      <div className="flex flex-wrap gap-2">
        <Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search events"
          size="sm"
          className="max-w-64"
        />
        <Select
          value={channel}
          items={[
            { value: 'all', label: 'All channels' },
            { value: 'rpc', label: 'RPC' },
            { value: 'agent', label: 'Agent' },
            { value: 'process', label: 'Process' },
            { value: 'browser', label: 'Browser' },
            { value: 'desktop', label: 'Desktop' },
            { value: 'guardian', label: 'Guardian' },
            { value: 'hook', label: 'Hook' },
            { value: 'remote', label: 'Remote' },
          ]}
          onValueChange={setChannel}
          size="sm"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!state.enabled}
          onClick={() => void setPaused(!state.paused)}
        >
          {state.paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void exportJson().then((json) => copyText(json))}
        >
          Copy JSON
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void clear()}>
          Clear
        </Button>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg bg-surface-1 p-2 font-mono text-[11px]">
        {events.length === 0 ? (
          <p className="p-2 text-muted-foreground">No matching events.</p>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="rounded-md border border-derived-subtle p-2"
            >
              <div className="flex gap-2 text-muted-foreground">
                <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                <span>{event.channel}</span>
                <span>{event.level}</span>
              </div>
              <p className="text-foreground">{event.message}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const GUARDIAN_FEEDBACK_OPTIONS: Array<{
  value: GuardianFeedbackLabel;
  label: string;
  title: string;
}> = [
  {
    value: 'correct',
    label: 'Correct',
    title: 'Guardian decision and risk were appropriate',
  },
  {
    value: 'false-positive',
    label: 'Too strict',
    title: 'Guardian overestimated risk or escalated unnecessarily',
  },
  {
    value: 'false-negative',
    label: 'Too permissive',
    title: 'Guardian underestimated risk or approved too easily',
  },
];

function formatGuardianRate(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(value === 0 ? 0 : 1)}%`;
}

function GuardianDogfoodSettings() {
  const state = useKartonState((item) => item.agentOs.guardian);
  const submitFeedback = useKartonProcedure(
    (procedures) => procedures.agentOs.guardian.submitFeedback,
  );
  const clearRecent = useKartonProcedure(
    (procedures) => procedures.agentOs.guardian.clearRecent,
  );
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const recent = useMemo(() => {
    const newestFirst = state.recentAssessments.slice().reverse();
    return [
      ...newestFirst.filter((assessment) => assessment.feedback === null),
      ...newestFirst.filter((assessment) => assessment.feedback !== null),
    ];
  }, [state.recentAssessments]);
  const unlabeledRecent = recent.filter(
    (assessment) => assessment.feedback === null,
  ).length;
  const readiness = useMemo(
    () => evaluateGuardianReleaseReadiness(state),
    [state],
  );
  const readinessPresentation = {
    collecting: {
      label: 'Collecting labels',
      description:
        'The current policy still needs a representative reviewed sample.',
      className:
        'border-codex-blue-400/18 bg-codex-blue-400/8 text-codex-blue-400',
    },
    'needs-tuning': {
      label: 'Needs tuning',
      description:
        'Sample gates pass, but at least one error rate exceeds the rollout threshold.',
      className:
        'border-warning-solid/20 bg-warning-solid/8 text-warning-solid',
    },
    candidate: {
      label: 'Release candidate',
      description:
        'Dogfood thresholds pass. Release still requires explicit human sign-off.',
      className:
        'border-success-solid/20 bg-success-solid/7 text-success-solid',
    },
  }[readiness.status];
  const distributionItems = [
    ['Approve', state.distribution.approve],
    ['Escalate', state.distribution.escalate],
    ['Deny', state.distribution.deny],
  ] as const;

  const labelAssessment = async (
    assessmentId: string,
    feedback: GuardianFeedbackLabel,
  ) => {
    if (submittingId) return;
    setSubmittingId(assessmentId);
    try {
      await submitFeedback(assessmentId, feedback);
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-3 text-token-text-secondary text-xs leading-5">
        Dogfood data contains decision metadata only. Commands, scripts, URLs,
        prompts, files, arguments, and credentials are never stored here.
      </p>

      <div className="space-y-3 rounded-xl border border-token-border-light p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium text-sm text-token-text-primary">
              Policy v{GUARDIAN_POLICY_VERSION} release readiness
            </p>
            <p className="mt-1 text-token-text-secondary text-xs">
              {readinessPresentation.description}
            </p>
          </div>
          <span
            className={`rounded-full border px-2.5 py-1 font-medium text-[10px] uppercase tracking-[0.06em] ${readinessPresentation.className}`}
          >
            {readinessPresentation.label}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            [
              'Reviewed',
              `${readiness.labeled}/${GUARDIAN_RELEASE_THRESHOLDS.minimumLabeled}`,
            ],
            [
              'Coverage',
              `${formatGuardianRate(readiness.labelCoverage)} / ${formatGuardianRate(GUARDIAN_RELEASE_THRESHOLDS.minimumLabelCoverage)}`,
            ],
            [
              'False positive',
              `${formatGuardianRate(readiness.falsePositiveRate)} ≤ ${formatGuardianRate(GUARDIAN_RELEASE_THRESHOLDS.maximumFalsePositiveRate)}`,
            ],
            [
              'False negative',
              `${formatGuardianRate(readiness.falseNegativeRate)} ≤ ${formatGuardianRate(GUARDIAN_RELEASE_THRESHOLDS.maximumFalseNegativeRate)}`,
            ],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg bg-token-bg-secondary/45 px-3 py-2"
            >
              <p className="text-[10px] text-token-text-secondary">{label}</p>
              <p className="font-medium text-sm text-token-text-primary">
                {value}
              </p>
            </div>
          ))}
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <p className="rounded-lg bg-token-bg-secondary/45 px-3 py-2 text-token-text-secondary">
            Decision sample:{' '}
            <span className="text-token-text-primary">
              approvals {readiness.approvedLabeled}/
              {GUARDIAN_RELEASE_THRESHOLDS.minimumApprovedLabeled} · restricted{' '}
              {readiness.restrictedLabeled}/
              {GUARDIAN_RELEASE_THRESHOLDS.minimumRestrictedLabeled}
            </span>
          </p>
          <p className="rounded-lg bg-token-bg-secondary/45 px-3 py-2 text-token-text-secondary">
            Domain sample:{' '}
            <span className="text-token-text-primary">
              shell {readiness.labeledByKind.shell} · network{' '}
              {readiness.labeledByKind.network} · MCP{' '}
              {readiness.labeledByKind.mcp} · sandbox{' '}
              {readiness.labeledByKind.sandbox} /{' '}
              {GUARDIAN_RELEASE_THRESHOLDS.minimumLabeledPerKind} each
            </span>
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {readiness.checks.map((check) => (
            <span
              key={check.id}
              title={`${check.label}: ${check.passed ? 'pass' : 'not ready'}`}
              className={
                check.passed
                  ? 'rounded-full border border-success-solid/20 bg-success-solid/7 px-2 py-1 text-[10px] text-success-solid'
                  : 'rounded-full border border-token-border-light bg-token-bg-secondary/45 px-2 py-1 text-[10px] text-token-text-secondary'
              }
            >
              {check.passed ? '✓' : '○'} {check.label}
            </span>
          ))}
        </div>

        <p className="text-[11px] text-token-text-secondary leading-4">
          False-positive rate is measured across reviewed escalations and
          denials. False-negative rate is measured across reviewed approvals.
          Passing this card never changes the release feature gate
          automatically.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-token-border-light p-3">
          <p className="text-[10px] text-token-text-secondary uppercase tracking-[0.08em]">
            Assessments
          </p>
          <p className="mt-1 font-semibold text-lg text-token-text-primary">
            {state.distribution.total}
          </p>
        </div>
        {distributionItems.map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-token-border-light p-3"
          >
            <p className="text-[10px] text-token-text-secondary uppercase tracking-[0.08em]">
              {label}
            </p>
            <p className="mt-1 font-semibold text-lg text-token-text-primary">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <p className="rounded-lg bg-token-bg-secondary/45 px-3 py-2 text-token-text-secondary">
          Risk:{' '}
          <span className="text-token-text-primary">
            low {state.distribution.low} · medium {state.distribution.medium} ·
            high {state.distribution.high} · critical{' '}
            {state.distribution.critical}
          </span>
        </p>
        <p className="rounded-lg bg-token-bg-secondary/45 px-3 py-2 text-token-text-secondary">
          Domain:{' '}
          <span className="text-token-text-primary">
            shell {state.distribution.shell} · network{' '}
            {state.distribution.network} · MCP {state.distribution.mcp} ·
            sandbox {state.distribution.sandbox}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Labeled', state.feedback.labeled],
          ['Correct', state.feedback.correct],
          ['Too strict', state.feedback.falsePositive],
          ['Too permissive', state.feedback.falseNegative],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg bg-token-bg-secondary/45 px-3 py-2"
          >
            <p className="text-[10px] text-token-text-secondary">{label}</p>
            <p className="font-medium text-sm text-token-text-primary">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground text-sm">
            Recent assessments
          </h3>
          <p className="text-muted-foreground text-xs">
            {unlabeledRecent} waiting for review · unlabeled decisions appear
            first.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={recent.length === 0}
          onClick={() => void clearRecent()}
        >
          Clear recent
        </Button>
      </div>

      <div className="max-h-[32rem] space-y-2 overflow-y-auto">
        {recent.length === 0 ? (
          <p className="rounded-xl border border-token-border-light border-dashed p-4 text-center text-muted-foreground text-xs">
            No Guardian assessments yet.
          </p>
        ) : (
          recent.map((assessment) => (
            <div
              key={assessment.assessmentId}
              className="rounded-xl border border-token-border-light p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.06em]">
                <span className="rounded-full bg-token-bg-secondary px-2 py-1 text-token-text-primary">
                  {assessment.kind} · v{assessment.policyVersion}
                </span>
                <span className="text-token-text-secondary">
                  {assessment.risk} risk
                </span>
                <span className="font-medium text-token-text-primary">
                  {assessment.decision}
                </span>
                {assessment.irreversible && (
                  <span className="text-warning-solid">irreversible</span>
                )}
                {assessment.readOnly && (
                  <span className="text-token-text-secondary">read-only</span>
                )}
                {!assessment.validContext && (
                  <span className="text-danger-solid">invalid context</span>
                )}
                <span className="text-token-text-secondary normal-case tracking-normal">
                  {assessment.latencyMs} ms
                </span>
                <span className="ml-auto text-token-text-secondary normal-case tracking-normal">
                  {new Date(assessment.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {GUARDIAN_FEEDBACK_OPTIONS.filter((option) =>
                  isGuardianFeedbackAllowedForDecision(
                    assessment.decision,
                    option.value,
                  ),
                ).map((option) => (
                  <Button
                    key={option.value}
                    variant={
                      assessment.feedback === option.value ? 'primary' : 'ghost'
                    }
                    size="sm"
                    title={option.title}
                    disabled={submittingId !== null}
                    onClick={() =>
                      void labelAssessment(
                        assessment.assessmentId,
                        option.value,
                      )
                    }
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SkillsSettings() {
  const state = useKartonState((item) => item.agentOs);
  const pickPackage = useKartonProcedure(
    (procedures) => procedures.agentOs.skills.pickPackage,
  );
  const inspect = useKartonProcedure(
    (procedures) => procedures.agentOs.skills.inspect,
  );
  const install = useKartonProcedure(
    (procedures) => procedures.agentOs.skills.installFromPath,
  );
  const uninstall = useKartonProcedure(
    (procedures) => procedures.agentOs.skills.uninstall,
  );

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    const filePath = resolveDroppedSkillPath(event.dataTransfer, (file) =>
      window.electron.getPathForFile(file),
    );
    if (filePath) void inspect(filePath);
  };

  return (
    <div className="space-y-4">
      <div
        className="rounded-lg border border-derived border-dashed p-4 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <PackageIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          Drop a .skill, .clodex-skill, or SKILL.md package here.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => void pickPackage()}
        >
          Choose package
        </Button>
      </div>
      {state.pendingSkillInstall && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <h3 className="font-medium text-foreground text-sm">
            {state.pendingSkillInstall.name}{' '}
            <span className="text-muted-foreground">
              v{state.pendingSkillInstall.version}
            </span>
          </h3>
          <p className="text-muted-foreground text-xs">
            {state.pendingSkillInstall.description}
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-3"
            onClick={() =>
              void install(
                state.pendingSkillInstall!.sourcePath,
                state.pendingSkillInstall!.conflict,
              )
            }
          >
            {state.pendingSkillInstall.conflict ? 'Replace skill' : 'Install'}
          </Button>
        </div>
      )}
      <div className="space-y-2">
        {state.installedSkills.map((skill) => (
          <div
            key={skill.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-derived-subtle p-3"
          >
            <div>
              <p className="font-medium text-foreground text-sm">
                {skill.name} v{skill.version}
              </p>
              <p className="text-muted-foreground text-xs">
                {skill.description}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void uninstall(skill.id)}
            >
              Uninstall
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function HooksSettings() {
  const state = useKartonState((item) => item.agentOs);
  const hooks = state.hooks;
  const createHook = useKartonProcedure(
    (procedures) => procedures.agentOs.hooks.create,
  );
  const updateHook = useKartonProcedure(
    (procedures) => procedures.agentOs.hooks.update,
  );
  const deleteHook = useKartonProcedure(
    (procedures) => procedures.agentOs.hooks.delete,
  );
  const runHooks = useKartonProcedure(
    (procedures) => procedures.agentOs.hooks.run,
  );
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [trigger, setTrigger] = useState<HookTrigger>('before-turn');
  const [kind, setKind] = useState<'prompt' | 'command' | 'agent'>('prompt');
  const [editingHookId, setEditingHookId] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setBody('');
    setTrigger('before-turn');
    setKind('prompt');
    setEditingHookId(null);
  };

  const save = () => {
    if (!name.trim() || !body.trim()) return;
    if (editingHookId) {
      void updateHook(editingHookId, {
        name: name.trim(),
        body: body.trim(),
        trigger,
        kind,
      });
    } else {
      void createHook({
        name: name.trim(),
        body: body.trim(),
        trigger,
        kind,
        enabled: false,
        timeoutMs: 10_000,
      });
    }
    resetForm();
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={name} onValueChange={setName} placeholder="Hook name" />
        <Select
          value={trigger}
          items={[
            { value: 'before-turn', label: 'Before turn' },
            { value: 'after-turn', label: 'After turn' },
            { value: 'before-command', label: 'Before command' },
            { value: 'after-command', label: 'After command' },
            { value: 'before-file-edit', label: 'Before file edit' },
            { value: 'after-file-edit', label: 'After file edit' },
            { value: 'approval-requested', label: 'Approval requested' },
          ]}
          onValueChange={(value) => setTrigger(value as HookTrigger)}
          size="sm"
        />
        <Select
          value={kind}
          items={[
            { value: 'prompt', label: 'Prompt' },
            { value: 'command', label: 'Command' },
            { value: 'agent', label: 'Agent' },
          ]}
          onValueChange={(value) =>
            setKind(value as 'prompt' | 'command' | 'agent')
          }
          size="sm"
        />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={save}>
            {editingHookId ? 'Save hook' : 'Create disabled hook'}
          </Button>
          {editingHookId && (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      <textarea
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        placeholder="Prompt or command body"
        className="min-h-24 w-full resize-y rounded-lg border border-derived bg-surface-1 p-3 font-mono text-foreground text-xs outline-none"
      />
      <div className="space-y-2">
        {hooks.map((hook) => (
          <div
            key={hook.id}
            className="flex items-start justify-between gap-3 rounded-lg border border-derived-subtle p-3"
          >
            <div>
              <p className="font-medium text-foreground text-sm">{hook.name}</p>
              <p className="text-muted-foreground text-xs">
                {hook.trigger} · {hook.kind}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setEditingHookId(hook.id);
                  setName(hook.name);
                  setBody(hook.body);
                  setTrigger(hook.trigger);
                  setKind(hook.kind);
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const approved =
                    hook.kind !== 'command' ||
                    window.confirm(
                      `Run local command hook “${hook.name}” now?`,
                    );
                  if (!approved) return;
                  void runHooks(hook.trigger, {
                    commandApproved: hook.kind === 'command',
                    workspaceTrusted: hook.kind === 'command',
                  });
                }}
              >
                Test
              </Button>
              <Switch
                checked={hook.enabled}
                onCheckedChange={(enabled) =>
                  void updateHook(hook.id, { enabled })
                }
                size="xs"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => void deleteHook(hook.id)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      {state.hookRuns.length > 0 && (
        <div className="space-y-2 rounded-lg bg-surface-1 p-3">
          <h3 className="font-medium text-foreground text-sm">Recent runs</h3>
          {state.hookRuns
            .slice()
            .reverse()
            .slice(0, 8)
            .map((run) => {
              const hook = hooks.find(
                (candidate) => candidate.id === run.hookId,
              );
              return (
                <div
                  key={run.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="truncate text-muted-foreground">
                    {hook?.name ?? run.hookId}
                  </span>
                  <span className="shrink-0 text-foreground">
                    {run.status} · {run.finishedAt - run.startedAt} ms
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function RemoteSettings() {
  const state = useKartonState((item) => item.agentOs.remoteControl);
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.agentOs.remote.setEnabled,
  );
  const setAllowCommands = useKartonProcedure(
    (procedures) => procedures.agentOs.remote.setAllowRemoteCommands,
  );
  const startPairing = useKartonProcedure(
    (procedures) => procedures.agentOs.remote.startPairing,
  );
  const cancelPairing = useKartonProcedure(
    (procedures) => procedures.agentOs.remote.cancelPairing,
  );
  const revokeClient = useKartonProcedure(
    (procedures) => procedures.agentOs.remote.revokeClient,
  );
  const resolveCommandApproval = useKartonProcedure(
    (procedures) => procedures.agentOs.remote.resolveCommandApproval,
  );

  return (
    <div className="space-y-4">
      <SettingToggle
        title="Enable local remote control"
        description="Starts a LAN-only server. Command payloads use an encrypted, signed, replay-protected protocol; no cloud relay is used."
        checked={state.enabled}
        onChange={(checked) => void setEnabled(checked)}
      />
      <SettingToggle
        title="Allow remote commands"
        description="Master switch only. Guardian still evaluates every command and risky actions require per-command desktop approval."
        checked={state.allowRemoteCommands}
        onChange={(checked) => void setAllowCommands(checked)}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-derived-subtle p-3">
          <p className="text-muted-foreground text-xs">Protocol</p>
          <p className="mt-1 font-medium text-foreground text-sm">
            v{state.protocolVersion} · P-256 + AES-256-GCM
          </p>
        </div>
        <div className="rounded-lg border border-derived-subtle p-3">
          <p className="text-muted-foreground text-xs">Environment identity</p>
          <p className="mt-1 truncate font-mono text-foreground text-xs">
            {state.serverFingerprint ?? 'Created when enabled'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!state.enabled}
          onClick={() => void startPairing()}
        >
          Start pairing
        </Button>
        {state.pairingCode && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void cancelPairing()}
          >
            Cancel
          </Button>
        )}
      </div>
      {state.pairingCode && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          {state.pairingQrDataUrl && (
            <img
              src={state.pairingQrDataUrl}
              alt="Remote control pairing QR code"
              className="size-36 rounded-lg bg-white p-1"
            />
          )}
          <div>
            <p className="font-semibold text-3xl text-foreground tracking-[0.25em]">
              {state.pairingCode}
            </p>
            <p className="mt-2 max-w-sm break-all text-muted-foreground text-xs">
              {state.pairingUrl}
            </p>
          </div>
        </div>
      )}
      {state.pendingApprovals.length > 0 && (
        <div className="space-y-2">
          <p className="font-medium text-foreground text-sm">
            Remote commands awaiting approval
          </p>
          {state.pendingApprovals.map((approval) => (
            <div
              key={approval.id}
              className="space-y-2 rounded-lg border border-warning-solid/30 bg-warning-solid/5 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground text-sm">
                    {approval.command} · {approval.clientLabel}
                  </p>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {approval.explanation}
                  </p>
                </div>
                <span className="rounded-full border border-warning-solid/30 px-2 py-0.5 font-medium text-[10px] text-warning-solid uppercase">
                  {approval.risk}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void resolveCommandApproval(approval.id, true)}
                >
                  Approve once
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void resolveCommandApproval(approval.id, false)
                  }
                >
                  Deny
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {Object.values(state.clients).map((client) => (
          <div
            key={client.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-derived-subtle p-3"
          >
            <div>
              <p className="font-medium text-foreground text-sm">
                {client.label}
              </p>
              <p className="text-muted-foreground text-xs">
                {client.revoked
                  ? 'Revoked'
                  : `${client.trustLevel === 'hardware-backed' ? 'Hardware-backed' : 'Software key possession'} · protocol v${client.protocolVersion} · paired ${new Date(client.pairedAt).toLocaleString()}`}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground uppercase tracking-wide">
                Trust: {client.trustLevel}
                {client.attestationProvider
                  ? ` · ${client.attestationProvider}`
                  : ''}
              </p>
              {client.keyFingerprint && (
                <p className="mt-1 max-w-72 truncate font-mono text-[10px] text-muted-foreground">
                  {client.keyFingerprint}
                </p>
              )}
            </div>
            {!client.revoked && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void revokeClient(client.id)}
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentOsSettingsSection() {
  const enabledCount = useKartonState(
    (state) =>
      AGENT_OS_FEATURES.filter(
        (feature) =>
          resolveFeatureGate(
            feature,
            state.preferences.featureGates.overrides,
            state.appInfo.releaseChannel,
          ).enabled,
      ).length,
  );

  return (
    <SettingsPage
      eyebrow="Experimental runtime"
      title="Agent OS"
      description="Local operating-layer features for memory, control, policy, inspection, skills, hooks, and remote pairing."
      toolbar={
        <div className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
          <SettingsSummaryCard
            accent
            label="capabilities enabled"
            value={`${enabledCount} / ${AGENT_OS_FEATURES.length}`}
            icon={<WorkflowIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="execution boundary"
            value="Local"
            icon={<GlobeLockIcon className="size-4" />}
          />
        </div>
      }
    >
      <div className="space-y-5">
        <FeatureCard
          feature="multi-agent-guardian"
          icon={<ShieldCheckIcon className="size-4" />}
          title="Guardian dogfood"
          description="Review privacy-safe decision distribution and label false positives or false negatives."
        >
          <GuardianDogfoodSettings />
        </FeatureCard>
        <FeatureCard
          feature="agent-os-debug-inspector"
          icon={<BugIcon className="size-4" />}
          title="Debug inspector"
          description="Inspect sanitized RPC, agent, process, browser, hook, and remote events."
        >
          <DebugSettings />
        </FeatureCard>
        <FeatureCard
          feature="browser-use-policy-engine"
          icon={<GlobeLockIcon className="size-4" />}
          title="Browser use policy"
          description="Origin-scoped controls for agent browser automation."
        >
          <BrowserUseSettings />
        </FeatureCard>
        <FeatureCard
          feature="desktop-automation-macos-preview"
          icon={<MonitorCogIcon className="size-4" />}
          title="Desktop automation for macOS"
          description="Explicit permissions, app allowlists, bounded accessibility actions, a persistent indicator, and a global kill switch."
        >
          <DesktopAutomationSettings />
        </FeatureCard>
        <FeatureCard
          feature="native-skill-install"
          icon={<PackageIcon className="size-4" />}
          title="Native skill install"
          description="Validate, preview, install, replace, and uninstall local skill packages."
        >
          <SkillsSettings />
        </FeatureCard>
        <FeatureCard
          feature="agent-hooks"
          icon={<WorkflowIcon className="size-4" />}
          title="Lifecycle hooks"
          description="Run safe prompt, command, and helper-agent hooks around agent activity."
        >
          <HooksSettings />
        </FeatureCard>
        <FeatureCard
          feature="chronicle-visual-memory"
          icon={<CameraIcon className="size-4" />}
          title="Chronicle visual memory"
          description="Explicit, privacy-filtered local visual memory with retention controls."
        >
          <ChronicleSettings />
        </FeatureCard>
        <FeatureCard
          feature="codex-micro-controller"
          icon={<Gamepad2Icon className="size-4" />}
          title="Micro virtual controller"
          description="A floating command deck for common agent actions."
        >
          <MicroSettings />
        </FeatureCard>
        <FeatureCard
          feature="remote-control-pairing"
          icon={<LinkIcon className="size-4" />}
          title="Remote Control + Attestation"
          description="Pair a device with a one-time code, device-bound keys, encrypted sessions, Guardian routing, and signed environment identity."
        >
          <RemoteSettings />
        </FeatureCard>
      </div>
    </SettingsPage>
  );
}
