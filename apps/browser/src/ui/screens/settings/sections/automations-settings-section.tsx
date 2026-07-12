import type { ToolApprovalMode } from '@clodex/agent-core/types/tool-approval';
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
import { Select } from '@clodex/stage-ui/components/select';
import { Switch } from '@clodex/stage-ui/components/switch';
import { toast } from '@clodex/stage-ui/components/toaster';
import type {
  AutomationCapability,
  AutomationDefinition,
  AutomationMissedRunPolicy,
  AutomationSnapshot,
  CreateAutomationInput,
} from '@shared/automations';
import { resolveFeatureGate } from '@shared/feature-gates';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import {
  CalendarClockIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CloudIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

type ScheduleKind = AutomationDefinition['schedule']['kind'];

interface AutomationFormState {
  title: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  runAt: string;
  intervalMinutes: string;
  cronExpression: string;
  timezone: string;
  missedRunPolicy: AutomationMissedRunPolicy;
  maxAttempts: string;
  initialBackoffSeconds: string;
  executionTarget: 'local' | 'cloud';
  workspacePaths: string;
  approvalMode: ToolApprovalMode;
  capabilities: AutomationCapability[];
}

const CAPABILITIES = [
  { value: 'workspace:read', label: 'Read workspace' },
  { value: 'workspace:write', label: 'Write workspace' },
  { value: 'network', label: 'Network' },
  { value: 'shell', label: 'Shell' },
  { value: 'mcp', label: 'MCP tools' },
  { value: 'desktop', label: 'Desktop control' },
] satisfies Array<{ value: AutomationCapability; label: string }>;

function defaultRunAt() {
  const value = new Date(Date.now() + 60 * 60_000);
  value.setSeconds(0, 0);
  return toLocalDateTime(value.toISOString());
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyForm(): AutomationFormState {
  return {
    title: '',
    prompt: '',
    scheduleKind: 'interval',
    runAt: defaultRunAt(),
    intervalMinutes: '60',
    cronExpression: '0 9 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    missedRunPolicy: 'run-on-wake',
    maxAttempts: '3',
    initialBackoffSeconds: '5',
    executionTarget: 'local',
    workspacePaths: '',
    approvalMode: 'alwaysAsk',
    capabilities: ['workspace:read'],
  };
}

function formFromAutomation(
  automation: AutomationDefinition,
): AutomationFormState {
  return {
    title: automation.title,
    prompt: automation.prompt,
    scheduleKind: automation.schedule.kind,
    runAt:
      automation.schedule.kind === 'once'
        ? toLocalDateTime(automation.schedule.runAt)
        : defaultRunAt(),
    intervalMinutes:
      automation.schedule.kind === 'interval'
        ? String(automation.schedule.everyMs / 60_000)
        : '60',
    cronExpression:
      automation.schedule.kind === 'cron'
        ? automation.schedule.expression
        : '0 9 * * 1-5',
    timezone:
      automation.schedule.kind === 'cron'
        ? automation.schedule.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    missedRunPolicy: automation.missedRunPolicy,
    maxAttempts: String(automation.retryPolicy.maxAttempts),
    initialBackoffSeconds: String(
      automation.retryPolicy.initialBackoffMs / 1_000,
    ),
    executionTarget: automation.executionTarget,
    workspacePaths: automation.workspacePaths.join('\n'),
    approvalMode: automation.approvalMode,
    capabilities: automation.grant.capabilities,
  };
}

function showToast(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `automations-${Date.now()}`,
    title,
    message,
    type,
    duration: 4_000,
    actions: [],
  });
}

function formatDate(value: string | null) {
  if (!value) return 'Not scheduled';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function scheduleLabel(automation: AutomationDefinition) {
  switch (automation.schedule.kind) {
    case 'once':
      return `Once · ${formatDate(automation.schedule.runAt)}`;
    case 'interval':
      return `Every ${automation.schedule.everyMs / 60_000} min`;
    case 'cron':
      return `${automation.schedule.expression} · ${automation.schedule.timezone}`;
  }
}

function buildInput(form: AutomationFormState): CreateAutomationInput {
  const maxAttempts = Number(form.maxAttempts);
  const initialBackoffMs = Number(form.initialBackoffSeconds) * 1_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('Retry attempts must be between 1 and 10.');
  }
  if (
    !Number.isFinite(initialBackoffMs) ||
    initialBackoffMs < 1_000 ||
    initialBackoffMs > 3_600_000
  ) {
    throw new Error('Initial retry delay must be between 1 and 3600 seconds.');
  }

  let schedule: CreateAutomationInput['schedule'];
  if (form.scheduleKind === 'once') {
    const runAt = new Date(form.runAt);
    if (!Number.isFinite(runAt.getTime())) {
      throw new Error('Choose a valid run date.');
    }
    schedule = { kind: 'once', runAt: runAt.toISOString() };
  } else if (form.scheduleKind === 'interval') {
    const intervalMinutes = Number(form.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
      throw new Error('Interval must be at least one minute.');
    }
    schedule = {
      kind: 'interval',
      everyMs: Math.round(intervalMinutes * 60_000),
    };
  } else {
    schedule = {
      kind: 'cron',
      expression: form.cronExpression.trim(),
      timezone: form.timezone.trim(),
    };
  }

  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    enabled: true,
    schedule,
    missedRunPolicy: form.missedRunPolicy,
    retryPolicy: {
      maxAttempts,
      initialBackoffMs,
      maxBackoffMs: Math.max(initialBackoffMs, 5 * 60_000),
    },
    executionTarget: form.executionTarget,
    workspacePaths: form.workspacePaths
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean),
    modelId: null,
    approvalMode: form.approvalMode,
    grant: {
      capabilities: form.capabilities,
      expiresAt: null,
    },
  };
}

function AutomationEditor({
  open,
  automation,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  automation: AutomationDefinition | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: CreateAutomationInput) => Promise<void>;
}) {
  const [form, setForm] = useState<AutomationFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(automation ? formFromAutomation(automation) : emptyForm());
    setError(null);
  }, [automation, open]);

  const update = <K extends keyof AutomationFormState>(
    key: K,
    value: AutomationFormState[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    try {
      setError(null);
      const input = buildInput(form);
      if (!input.title || !input.prompt) {
        throw new Error('Title and prompt are required.');
      }
      await onSave(input);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Automation could not be saved.',
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-[min(760px,calc(100vw-2rem))] overflow-y-auto sm:min-w-0">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>
            {automation ? 'Edit automation' : 'Create automation'}
          </DialogTitle>
          <DialogDescription>
            Scheduled prompts run through the same permission system as normal
            tasks. Permanent approval requires an explicit capability grant.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Title
            </span>
            <Input
              value={form.title}
              onValueChange={(value) => update('title', value)}
              placeholder="Daily repository review"
            />
          </div>

          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Prompt
            </span>
            <textarea
              value={form.prompt}
              onChange={(event) => update('prompt', event.currentTarget.value)}
              placeholder="Review open work and prepare a concise status update…"
              className="min-h-28 w-full resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary p-3 text-sm text-token-text-primary outline-none focus:border-token-border-default focus:ring-1 focus:ring-token-focus-border"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <span className="font-medium text-sm text-token-text-primary">
                Schedule type
              </span>
              <Select
                value={form.scheduleKind}
                items={[
                  { value: 'once', label: 'One time' },
                  { value: 'interval', label: 'Interval' },
                  { value: 'cron', label: 'Cron expression' },
                ]}
                onValueChange={(value) =>
                  update('scheduleKind', value as ScheduleKind)
                }
              />
            </div>
            {form.scheduleKind === 'once' && (
              <div className="grid gap-1.5">
                <span className="font-medium text-sm text-token-text-primary">
                  Run at
                </span>
                <Input
                  type="datetime-local"
                  value={form.runAt}
                  onValueChange={(value) => update('runAt', value)}
                />
              </div>
            )}
            {form.scheduleKind === 'interval' && (
              <div className="grid gap-1.5">
                <span className="font-medium text-sm text-token-text-primary">
                  Every (minutes)
                </span>
                <Input
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onValueChange={(value) => update('intervalMinutes', value)}
                />
              </div>
            )}
            {form.scheduleKind === 'cron' && (
              <>
                <div className="grid gap-1.5">
                  <span className="font-medium text-sm text-token-text-primary">
                    5-field cron
                  </span>
                  <Input
                    value={form.cronExpression}
                    onValueChange={(value) => update('cronExpression', value)}
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-start-2">
                  <span className="font-medium text-sm text-token-text-primary">
                    Timezone
                  </span>
                  <Input
                    value={form.timezone}
                    onValueChange={(value) => update('timezone', value)}
                    placeholder="America/New_York"
                  />
                </div>
              </>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <span className="font-medium text-sm text-token-text-primary">
                Execution
              </span>
              <Select
                value={form.executionTarget}
                items={[
                  { value: 'local', label: 'Local device' },
                  { value: 'cloud', label: 'Cloud' },
                ]}
                onValueChange={(value) =>
                  update('executionTarget', value as 'local' | 'cloud')
                }
              />
            </div>
            <div className="grid gap-1.5">
              <span className="font-medium text-sm text-token-text-primary">
                Missed run
              </span>
              <Select
                value={form.missedRunPolicy}
                items={[
                  { value: 'run-on-wake', label: 'Run on wake' },
                  { value: 'coalesce', label: 'Coalesce missed runs' },
                  { value: 'skip', label: 'Skip' },
                ]}
                onValueChange={(value) =>
                  update('missedRunPolicy', value as AutomationMissedRunPolicy)
                }
              />
            </div>
            <div className="grid gap-1.5">
              <span className="font-medium text-sm text-token-text-primary">
                Approval
              </span>
              <Select
                value={form.approvalMode}
                items={[
                  { value: 'alwaysAsk', label: 'Always ask' },
                  { value: 'smart', label: 'Smart approval' },
                  { value: 'alwaysAllow', label: 'Use saved grant' },
                ]}
                onValueChange={(value) =>
                  update('approvalMode', value as ToolApprovalMode)
                }
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <span className="font-medium text-sm text-token-text-primary">
                Retry attempts
              </span>
              <Input
                type="number"
                min={1}
                max={10}
                value={form.maxAttempts}
                onValueChange={(value) => update('maxAttempts', value)}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="font-medium text-sm text-token-text-primary">
                Initial retry delay (seconds)
              </span>
              <Input
                type="number"
                min={1}
                value={form.initialBackoffSeconds}
                onValueChange={(value) =>
                  update('initialBackoffSeconds', value)
                }
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Workspace paths
            </span>
            <textarea
              value={form.workspacePaths}
              onChange={(event) =>
                update('workspacePaths', event.currentTarget.value)
              }
              placeholder="/path/to/workspace&#10;/path/to/another"
              className="min-h-20 w-full resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary p-3 font-mono text-token-text-primary text-xs outline-none focus:border-token-border-default focus:ring-1 focus:ring-token-focus-border"
            />
          </div>

          <fieldset className="grid gap-2">
            <legend className="font-medium text-sm text-token-text-primary">
              Saved capabilities
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAPABILITIES.map((capability) => {
                const checked = form.capabilities.includes(capability.value);
                return (
                  <div
                    key={capability.value}
                    className="flex items-center justify-between gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 px-3 py-2.5 text-sm text-token-text-secondary"
                  >
                    {capability.label}
                    <Switch
                      checked={checked}
                      onCheckedChange={(value) =>
                        update(
                          'capabilities',
                          value
                            ? [...form.capabilities, capability.value]
                            : form.capabilities.filter(
                                (item) => item !== capability.value,
                              ),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>

          {error && (
            <div className="flex gap-2 rounded-xl border border-error-solid/25 bg-error-solid/8 p-3 text-error-solid text-sm">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            {automation ? 'Save changes' : 'Create automation'}
          </Button>
          <Button
            variant="secondary"
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

export function AutomationsSettingsSection() {
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const gate = resolveFeatureGate(
    'automations',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const getSnapshot = useKartonProcedure(
    (procedures) => procedures.automations.getSnapshot,
  );
  const createAutomation = useKartonProcedure(
    (procedures) => procedures.automations.create,
  );
  const updateAutomation = useKartonProcedure(
    (procedures) => procedures.automations.update,
  );
  const deleteAutomation = useKartonProcedure(
    (procedures) => procedures.automations.delete,
  );
  const runNow = useKartonProcedure(
    (procedures) => procedures.automations.runNow,
  );
  const setEnabled = useKartonProcedure(
    (procedures) => procedures.automations.setEnabled,
  );

  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);

  const refresh = useCallback(async () => {
    if (!gate.enabled) return;
    setError(null);
    try {
      setSnapshot(await getSnapshot());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Automations could not be loaded.',
      );
    }
  }, [gate.enabled, getSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = useMemo(
    () => snapshot?.automations.filter((item) => item.enabled).length ?? 0,
    [snapshot],
  );
  const failedCount = useMemo(
    () =>
      snapshot?.recentRuns.filter((run) => run.status === 'failed').length ?? 0,
    [snapshot],
  );

  const operate = async (
    id: string,
    action: () => Promise<{ snapshot: AutomationSnapshot; message: string }>,
    successTitle: string,
  ) => {
    setBusyId(id);
    try {
      const result = await action();
      setSnapshot(result.snapshot);
      showToast(successTitle, result.message);
    } catch (cause) {
      showToast(
        'Automation operation failed',
        cause instanceof Error ? cause.message : 'Please try again.',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  };

  const save = async (input: CreateAutomationInput) => {
    setBusyId(editing?.id ?? 'create');
    try {
      const result = editing
        ? await updateAutomation({
            id: editing.id,
            ...input,
            enabled: editing.enabled,
          })
        : await createAutomation(input);
      setSnapshot(result.snapshot);
      setEditorOpen(false);
      setEditing(null);
      showToast(
        editing ? 'Automation updated' : 'Automation created',
        result.message,
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsPage
      eyebrow="Agent"
      title="Automations"
      description="Schedule reliable one-time, interval, or cron tasks. Runs are reconciled after sleep and can execute locally or in the cloud."
      actions={
        gate.enabled ? (
          <Button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon className="size-4" />
            New automation
          </Button>
        ) : undefined
      }
      toolbar={
        gate.enabled && snapshot ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SettingsSummaryCard
              accent
              label="enabled automations"
              value={activeCount}
              icon={<CalendarClockIcon className="size-4" />}
            />
            <SettingsSummaryCard
              label={
                snapshot.wakeScheduler.mode === 'native'
                  ? snapshot.wakeScheduler.canWakeSystem
                    ? 'native system wake'
                    : 'native launch after resume'
                  : 'resume reconciliation'
              }
              value={
                snapshot.nextWakeAt
                  ? new Date(snapshot.nextWakeAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Idle'
              }
              icon={<RotateCcwIcon className="size-4" />}
            />
            <SettingsSummaryCard
              label="recent failed runs"
              value={failedCount}
              icon={<CircleAlertIcon className="size-4" />}
            />
          </div>
        ) : undefined
      }
    >
      {!gate.enabled ? (
        <SettingsPanel className="p-5">
          <h2 className="font-medium text-token-text-primary">
            Automations preview is disabled
          </h2>
          <p className="mt-1 text-sm text-token-text-secondary leading-6">
            Enable “{gate.definition.name}” in Agent → General → Preview
            features to use the scheduler.
          </p>
        </SettingsPanel>
      ) : error ? (
        <SettingsPanel className="p-5">
          <div className="flex items-start gap-3 text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 text-error-solid" />
            <div className="flex-1">
              <p className="font-medium text-token-text-primary">
                Automations unavailable
              </p>
              <p className="mt-1 text-token-text-secondary">{error}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
            >
              Retry
            </Button>
          </div>
        </SettingsPanel>
      ) : !snapshot ? (
        <SettingsPanel className="flex min-h-52 items-center justify-center">
          <Loader2Icon className="size-5 animate-spin text-token-text-tertiary" />
        </SettingsPanel>
      ) : (
        <div className="space-y-8">
          <div
            className={`rounded-xl border px-4 py-3 text-xs leading-5 ${
              snapshot.wakeScheduler.mode === 'native'
                ? 'border-clodex-green-400/18 bg-clodex-green-400/7 text-token-text-secondary'
                : 'border-warning-solid/20 bg-warning-solid/7 text-token-text-secondary'
            }`}
          >
            <span className="font-medium text-token-text-primary">
              Wake scheduler:{' '}
            </span>
            {snapshot.wakeScheduler.message}
          </div>
          <section className="space-y-3">
            <SettingsSectionHeader
              title="Scheduled tasks"
              description="Run now does not change the next scheduled occurrence."
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refresh()}
                >
                  <RefreshCwIcon className="size-3.5" />
                  Refresh
                </Button>
              }
            />
            {snapshot.automations.length === 0 ? (
              <SettingsPanel className="flex min-h-56 flex-col items-center justify-center p-8 text-center">
                <CalendarClockIcon className="size-8 text-token-text-tertiary" />
                <h3 className="mt-3 font-medium text-token-text-primary">
                  No scheduled tasks
                </h3>
                <p className="mt-1 max-w-sm text-sm text-token-text-secondary">
                  Create an automation for recurring reviews, reports, cleanup,
                  or any prompt you want Clodex to execute later.
                </p>
              </SettingsPanel>
            ) : (
              <div className="grid gap-3">
                {snapshot.automations.map((automation) => (
                  <SettingsPanel key={automation.id} className="p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                      <div className="flex min-w-0 flex-1 gap-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-token-border-light bg-token-bg-secondary text-token-text-secondary">
                          {automation.executionTarget === 'cloud' ? (
                            <CloudIcon className="size-4" />
                          ) : (
                            <CalendarClockIcon className="size-4" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-medium text-sm text-token-text-primary">
                              {automation.title}
                            </h3>
                            <span className="rounded-full border border-token-border-light bg-token-bg-secondary px-2 py-0.5 text-[10px] text-token-text-tertiary uppercase">
                              {automation.executionTarget}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-token-text-secondary text-xs leading-5">
                            {automation.prompt}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-token-text-tertiary">
                            <span>{scheduleLabel(automation)}</span>
                            <span>
                              Next: {formatDate(automation.nextRunAt)}
                            </span>
                            <span>
                              Retry: {automation.retryPolicy.maxAttempts}×
                            </span>
                            <span>{automation.missedRunPolicy}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Switch
                          checked={automation.enabled}
                          disabled={busyId === automation.id}
                          aria-label={
                            automation.enabled
                              ? 'Disable automation'
                              : 'Enable automation'
                          }
                          onCheckedChange={(enabled) =>
                            void operate(
                              automation.id,
                              () => setEnabled(automation.id, enabled),
                              enabled
                                ? 'Automation enabled'
                                : 'Automation disabled',
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Run now"
                          disabled={busyId === automation.id}
                          onClick={() =>
                            void operate(
                              automation.id,
                              () => runNow(automation.id),
                              'Run started',
                            )
                          }
                        >
                          <PlayIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Edit"
                          onClick={() => {
                            setEditing(automation);
                            setEditorOpen(true);
                          }}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Delete"
                          disabled={busyId === automation.id}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete automation “${automation.title}”?`,
                              )
                            ) {
                              void operate(
                                automation.id,
                                () => deleteAutomation(automation.id),
                                'Automation deleted',
                              );
                            }
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </SettingsPanel>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SettingsSectionHeader
              title="Recent runs"
              description="The local ledger keeps the latest scheduler outcomes and retry details."
            />
            <SettingsPanel className="overflow-hidden">
              {snapshot.recentRuns.length === 0 ? (
                <p className="p-4 text-sm text-token-text-secondary">
                  No automation has run yet.
                </p>
              ) : (
                snapshot.recentRuns.slice(0, 12).map((run, index) => {
                  const automation = snapshot.automations.find(
                    (item) => item.id === run.automationId,
                  );
                  return (
                    <div
                      key={run.id}
                      className={`flex items-start gap-3 p-4 ${
                        index ? 'border-token-border-light border-t' : ''
                      }`}
                    >
                      {run.status === 'succeeded' ? (
                        <CheckCircle2Icon className="mt-0.5 size-4 text-success-solid" />
                      ) : run.status === 'failed' ? (
                        <CircleAlertIcon className="mt-0.5 size-4 text-error-solid" />
                      ) : (
                        <Loader2Icon className="mt-0.5 size-4 text-token-text-tertiary" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm text-token-text-primary">
                          {automation?.title ?? 'Deleted automation'}
                        </p>
                        <p className="mt-0.5 text-token-text-tertiary text-xs">
                          {run.status} · {formatDate(run.startedAt)} · attempt{' '}
                          {run.attemptCount}
                        </p>
                        {run.reason && (
                          <p className="mt-1 line-clamp-2 text-error-solid text-xs">
                            {run.reason}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </SettingsPanel>
          </section>
        </div>
      )}

      <AutomationEditor
        open={editorOpen}
        automation={editing}
        busy={busyId === (editing?.id ?? 'create')}
        onOpenChange={(open) => {
          if (busyId) return;
          setEditorOpen(open);
          if (!open) setEditing(null);
        }}
        onSave={save}
      />
    </SettingsPage>
  );
}
