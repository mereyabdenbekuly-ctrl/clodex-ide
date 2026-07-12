import { useCallback, useEffect, useState } from 'react';
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
import { Select } from '@clodex/stage-ui/components/select';
import { toast } from '@clodex/stage-ui/components/toaster';
import { resolveFeatureGate } from '@shared/feature-gates';
import {
  memoryNotesManagementScopeSchema,
  memoryNotesRetentionSchema,
  type MemoryNotesManagementScope,
  type MemoryNotesRetention,
  type MemoryNotesStats,
} from '@shared/memory-notes';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import {
  DatabaseIcon,
  DownloadIcon,
  Loader2Icon,
  Trash2Icon,
} from 'lucide-react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';
import { EvidenceMemoryInspectorPanel } from './evidence-memory-inspector-panel';

const RETENTION_ITEMS = [
  { value: 'forever', label: 'Keep forever' },
  { value: '30-days', label: '30 days' },
  { value: '90-days', label: '90 days' },
  { value: '1-year', label: '1 year' },
] satisfies Array<{ value: MemoryNotesRetention; label: string }>;

const SCOPE_ITEMS = [
  { value: 'all', label: 'All notes' },
  { value: 'global', label: 'Global notes' },
  { value: 'workspace', label: 'Workspace notes' },
  { value: 'agent', label: 'Agent notes' },
] satisfies Array<{ value: MemoryNotesManagementScope; label: string }>;

function scopeLabel(scope: MemoryNotesManagementScope): string {
  return SCOPE_ITEMS.find((item) => item.value === scope)?.label ?? scope;
}

function showToast(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `memory-notes-${Date.now()}`,
    title,
    message,
    type,
    duration: 4_000,
    actions: [],
  });
}

export function MemorySettingsSection() {
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const gate = resolveFeatureGate(
    'memory-notes',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const getStats = useKartonProcedure(
    (procedures) => procedures.memoryNotes.getStats,
  );
  const setRetention = useKartonProcedure(
    (procedures) => procedures.memoryNotes.setRetention,
  );
  const exportToFile = useKartonProcedure(
    (procedures) => procedures.memoryNotes.exportToFile,
  );
  const reset = useKartonProcedure(
    (procedures) => procedures.memoryNotes.reset,
  );
  const [stats, setStats] = useState<MemoryNotesStats | null>(null);
  const [scope, setScope] = useState<MemoryNotesManagementScope>('all');
  const [busy, setBusy] = useState<
    'stats' | 'retention' | 'export' | 'reset' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const selectedCount =
    stats === null ? 0 : scope === 'all' ? stats.total : stats.byScope[scope];

  const refreshStats = useCallback(async () => {
    if (!gate.enabled) {
      setStats(null);
      return;
    }
    setBusy((current) => current ?? 'stats');
    setError(null);
    try {
      setStats(await getStats());
    } catch (cause) {
      setStats(null);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Memory notes storage is unavailable.',
      );
    } finally {
      setBusy((current) => (current === 'stats' ? null : current));
    }
  }, [gate.enabled, getStats]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const handleRetentionChange = async (value: unknown) => {
    const parsed = memoryNotesRetentionSchema.safeParse(value);
    if (!parsed.success || parsed.data === preferences.memoryNotes.retention) {
      return;
    }
    setBusy('retention');
    try {
      const result = await setRetention(parsed.data);
      await refreshStats();
      showToast(
        'Retention updated',
        result.deleted > 0
          ? `Policy saved and ${result.deleted} expired note${result.deleted === 1 ? '' : 's'} removed.`
          : 'Policy saved. No notes were old enough to remove.',
      );
    } catch (cause) {
      showToast(
        'Retention update failed',
        cause instanceof Error ? cause.message : 'Unable to update retention.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleScopeChange = (value: unknown) => {
    const parsed = memoryNotesManagementScopeSchema.safeParse(value);
    if (parsed.success) setScope(parsed.data);
  };

  const handleExport = async () => {
    setBusy('export');
    try {
      const result = await exportToFile(scope);
      if (!result.canceled) {
        showToast(
          'Memory notes exported',
          `${result.count} note${result.count === 1 ? '' : 's'} saved as portable JSON.`,
        );
      }
    } catch (cause) {
      showToast(
        'Memory export failed',
        cause instanceof Error ? cause.message : 'Unable to export notes.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy('reset');
    try {
      const result = await reset(scope);
      setResetOpen(false);
      await refreshStats();
      showToast(
        'Memory notes reset',
        `${result.deleted} note${result.deleted === 1 ? '' : 's'} permanently deleted from ${scopeLabel(scope).toLowerCase()}.`,
      );
    } catch (cause) {
      showToast(
        'Memory reset failed',
        cause instanceof Error ? cause.message : 'Unable to reset notes.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SettingsPage
        eyebrow="Agent context"
        title="Memory"
        description="Manage explicit long-term notes. The read-only session memory archive is separate and is not affected by these controls."
        toolbar={
          gate.enabled ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['All notes', stats?.total ?? 0],
                ['Global', stats?.byScope.global ?? 0],
                ['Workspace', stats?.byScope.workspace ?? 0],
                ['Agent', stats?.byScope.agent ?? 0],
              ].map(([label, count], index) => (
                <SettingsSummaryCard
                  key={label}
                  accent={index === 0}
                  label={String(label)}
                  value={busy === 'stats' ? '—' : count}
                  icon={
                    index === 0 ? (
                      <DatabaseIcon className="size-4" />
                    ) : undefined
                  }
                />
              ))}
            </div>
          ) : undefined
        }
      >
        {!gate.enabled ? (
          <SettingsPanel className="p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-token-bg-tertiary text-token-text-secondary">
                <DatabaseIcon className="size-4.5" />
              </span>
              <div>
                <h2 className="font-medium text-sm text-token-text-primary">
                  Long-term memory notes are disabled
                </h2>
                <p className="mt-1 text-token-text-secondary text-xs leading-5">
                  Enable “{gate.definition.name}” in Settings → Agent → General
                  → Preview features to manage stored notes.
                </p>
              </div>
            </div>
          </SettingsPanel>
        ) : (
          <div className="space-y-8">
            <section className="space-y-3">
              <SettingsSectionHeader
                title="Retention"
                description="Notes older than the selected period are removed using their latest update time. Changing this policy applies immediately."
              />
              <SettingsPanel className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <h3 className="font-medium text-sm text-token-text-primary">
                    Keep notes for
                  </h3>
                  <p className="mt-1 text-token-text-secondary text-xs leading-5">
                    Default is forever. Expired notes cannot be recovered.
                  </p>
                </div>
                <Select
                  value={preferences.memoryNotes.retention}
                  items={RETENTION_ITEMS}
                  onValueChange={handleRetentionChange}
                  disabled={busy !== null}
                  size="sm"
                  triggerClassName="rounded-lg"
                />
              </SettingsPanel>
            </section>

            <section className="space-y-3">
              <SettingsSectionHeader
                title="Stored notes"
                description="Counts contain metadata only. Note contents are loaded only for an explicit export or agent read/search tool."
              />
              <SettingsPanel className="p-4">
                {error ? (
                  <div className="rounded-xl border border-error-solid/25 bg-error-solid/7 p-3.5 text-error-solid text-sm">
                    {error}
                  </div>
                ) : (
                  <p className="text-token-text-secondary text-xs leading-5">
                    {stats?.oldestCreatedAt
                      ? `Oldest stored note: ${new Date(
                          stats.oldestCreatedAt,
                        ).toLocaleString()}`
                      : 'No long-term memory notes are currently stored.'}
                  </p>
                )}
              </SettingsPanel>
            </section>

            <section className="space-y-3">
              <SettingsSectionHeader
                title="Export or reset"
                description="Export creates a portable decrypted JSON file, never a copy of the raw SQLite database. Store exported files securely."
              />
              <SettingsPanel className="overflow-hidden">
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <h3 className="font-medium text-sm text-token-text-primary">
                      Scope
                    </h3>
                    <p className="mt-1 text-token-text-secondary text-xs leading-5">
                      Workspace and agent choices include every stored note of
                      that scope type.
                    </p>
                  </div>
                  <Select
                    value={scope}
                    items={SCOPE_ITEMS}
                    onValueChange={handleScopeChange}
                    disabled={busy !== null}
                    size="sm"
                    triggerClassName="rounded-lg"
                  />
                </div>
                <div className="flex flex-wrap justify-end gap-2 border-token-border-light border-t bg-token-bg-secondary/35 p-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-xl"
                    disabled={busy !== null || selectedCount === 0}
                    onClick={() => void handleExport()}
                  >
                    {busy === 'export' ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <DownloadIcon className="size-4" />
                    )}
                    Export JSON
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="rounded-xl"
                    disabled={busy !== null || selectedCount === 0}
                    onClick={() => setResetOpen(true)}
                  >
                    <Trash2Icon className="size-4" />
                    Reset…
                  </Button>
                </div>
              </SettingsPanel>
            </section>
          </div>
        )}
        <EvidenceMemoryInspectorPanel />
      </SettingsPage>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogClose />
          <DialogHeader>
            <DialogTitle>Reset {scopeLabel(scope).toLowerCase()}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the selected long-term notes and cannot
              be undone. The separate read-only session memory archive is not
              affected.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-error-background p-3 text-error-foreground text-sm">
            Selected scope: <strong>{scopeLabel(scope)}</strong>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === 'reset'}
              onClick={() => setResetOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy === 'reset'}
              onClick={() => void handleReset()}
            >
              {busy === 'reset' && (
                <Loader2Icon className="size-4 animate-spin" />
              )}
              Permanently delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
