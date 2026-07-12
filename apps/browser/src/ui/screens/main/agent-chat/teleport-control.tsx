import {
  CloudIcon,
  DownloadIcon,
  Loader2Icon,
  PauseCircleIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
  UnplugIcon,
} from 'lucide-react';
import { Button } from '@clodex/stage-ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@clodex/stage-ui/components/popover';
import { useState } from 'react';
import type {
  CloudTaskTeleportActionResult,
  CloudTaskTeleportPhase,
  CloudTaskTeleportState,
} from '@shared/cloud-task-teleport';
import type {
  CloudTaskMemoryDivergenceResolution,
  CloudTaskMemorySyncExportResult,
} from '@shared/cloud-task-memory-sync';

const PHASE_LABELS: Record<CloudTaskTeleportPhase, string> = {
  restoring: 'Restoring',
  'cloud-owned': 'Cloud-owned',
  suspending: 'Suspending',
  suspended: 'Suspended',
  resuming: 'Resuming',
  failed: 'Failed',
};

export function getTeleportPhaseLabel(phase: CloudTaskTeleportPhase): string {
  return PHASE_LABELS[phase];
}

export function TeleportControl({
  state,
  onContinueLocally,
  onResumeInCloud,
  onRetryMemorySync,
  onResolveMemoryDivergence,
  onExportMemorySyncDiagnostics,
}: {
  state: CloudTaskTeleportState;
  onContinueLocally: () => Promise<CloudTaskTeleportActionResult>;
  onResumeInCloud: () => Promise<CloudTaskTeleportActionResult>;
  onRetryMemorySync: () => Promise<CloudTaskTeleportActionResult>;
  onResolveMemoryDivergence: (
    strategy: CloudTaskMemoryDivergenceResolution,
  ) => Promise<CloudTaskTeleportActionResult>;
  onExportMemorySyncDiagnostics: () => Promise<CloudTaskMemorySyncExportResult>;
}) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAcceptCloud, setConfirmAcceptCloud] = useState(false);
  const isTransitioning =
    state.phase === 'restoring' ||
    state.phase === 'suspending' ||
    state.phase === 'resuming';
  const canContinueLocally = state.phase === 'cloud-owned';
  const canResumeInCloud =
    state.phase === 'suspended' || state.phase === 'failed';
  const memoryDiverged = state.memorySyncState === 'diverged';
  const latestRecovery = state.memorySyncJournal?.find(
    (entry) => entry.recoveryDecision !== null,
  );
  const latestProtocol = state.memorySyncJournal?.find(
    (entry) => entry.protocol !== null,
  );

  const run = async (action: () => Promise<CloudTaskTeleportActionResult>) => {
    if (pending || isTransitioning) return;
    setPending(true);
    setActionError(null);
    try {
      const result = await action();
      if (!result.ok) setActionError(result.error);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  const exportDiagnostics = async () => {
    setPending(true);
    setActionError(null);
    try {
      const result = await onExportMemorySyncDiagnostics();
      if (!result.ok) setActionError(result.error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger>
        <button
          type="button"
          data-teleport-status={state.phase}
          className="app-no-drag pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-token-text-secondary text-xs transition-colors hover:bg-token-list-hover-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
          title="Session Teleport status and handoff diagnostics"
        >
          <TeleportPhaseIcon phase={state.phase} />
          <span>{getTeleportPhaseLabel(state.phase)}</span>
          {state.epoch !== null && (
            <span className="font-mono text-[10px] text-token-text-tertiary">
              e{state.epoch}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="app-no-drag pointer-events-auto w-72"
      >
        <PopoverTitle>Session Teleport</PopoverTitle>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <Diagnostic
            label="Status"
            value={getTeleportPhaseLabel(state.phase)}
          />
          <Diagnostic
            label="Epoch"
            value={state.epoch === null ? 'Pending' : String(state.epoch)}
            mono
          />
          <Diagnostic
            label="Handoff"
            value={shortenOpaqueId(state.handoffId)}
            mono
          />
          <Diagnostic
            label="Sequence"
            value={String(state.lastSequence)}
            mono
          />
          <Diagnostic
            label="Memory"
            value={shortenOpaqueId(state.memoryCheckpointId ?? null)}
            mono
          />
          <Diagnostic
            label="Memory events"
            value={
              state.memoryEventCount === undefined ||
              state.memoryEventCount === null
                ? '—'
                : String(state.memoryEventCount)
            }
            mono
          />
          <Diagnostic
            label="Memory sync"
            value={state.memorySyncState ?? '—'}
          />
          {latestRecovery && (
            <Diagnostic
              label="Recovery"
              value={`${latestRecovery.automatic ? 'auto ' : ''}${latestRecovery.recoveryDecision} · ${latestRecovery.recoveryClass}`}
            />
          )}
          {latestProtocol && (
            <Diagnostic
              label="Protocol"
              value={`${latestProtocol.protocol}${latestProtocol.idempotentReplay ? ' · replayed' : ''}`}
              mono
            />
          )}
          <Diagnostic
            label="Updated"
            value={new Date(state.updatedAt).toLocaleTimeString()}
          />
        </dl>
        {(actionError || state.error) && (
          <div
            role="alert"
            className="mt-3 rounded-md bg-red-500/10 px-2.5 py-2 text-red-600 text-xs dark:text-red-400"
          >
            {actionError || state.error}
          </div>
        )}
        {(state.memorySyncJournal?.length ?? 0) > 0 && (
          <div className="mt-3 border-token-border border-t pt-3">
            <div className="mb-2 text-token-text-tertiary text-xs">
              Memory sync journal
            </div>
            <div className="max-h-28 space-y-1 overflow-y-auto">
              {state.memorySyncJournal?.slice(0, 5).map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-2 text-[10px]"
                >
                  <span className="truncate text-token-text-secondary">
                    {entry.operation}
                    {entry.automatic ? ' · auto' : ''}
                  </span>
                  <span
                    className="shrink-0 font-mono text-token-text-tertiary"
                    title={
                      entry.recoveryClass
                        ? `${entry.recoveryClass}: ${entry.recoveryDecision}`
                        : entry.protocol
                          ? `${entry.protocol}${entry.idempotentReplay ? ': replayed' : ''}`
                          : (entry.errorCode ?? entry.status)
                    }
                  >
                    {entry.status} · #{entry.attempt}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {memoryDiverged && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
            <div className="text-amber-700 text-xs dark:text-amber-300">
              Local and cloud memory ledgers conflict.
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  void run(() => onResolveMemoryDivergence('keep-local'))
                }
              >
                Keep local
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  if (!confirmAcceptCloud) {
                    setConfirmAcceptCloud(true);
                    return;
                  }
                  setConfirmAcceptCloud(false);
                  void run(() => onResolveMemoryDivergence('accept-cloud'));
                }}
              >
                {confirmAcceptCloud ? 'Confirm cloud' : 'Accept cloud'}
              </Button>
            </div>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between border-token-border border-t pt-3">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void exportDiagnostics()}
          >
            <DownloadIcon className="size-3" />
            Export
          </Button>
          {(state.memorySyncState === 'failed' || memoryDiverged) && (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending || memoryDiverged}
              onClick={() => void run(onRetryMemorySync)}
            >
              <RefreshCcwIcon className="size-3" />
              Retry
            </Button>
          )}
        </div>
        {(canContinueLocally || canResumeInCloud) && (
          <div className="mt-4 flex justify-end">
            {canContinueLocally && (
              <Button
                size="xs"
                variant="secondary"
                disabled={pending}
                onClick={() => void run(onContinueLocally)}
              >
                {pending ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <UnplugIcon className="size-3" />
                )}
                Continue locally
              </Button>
            )}
            {canResumeInCloud && (
              <Button
                size="xs"
                variant="secondary"
                disabled={pending}
                onClick={() => void run(onResumeInCloud)}
              >
                {pending ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <RotateCcwIcon className="size-3" />
                )}
                Resume in cloud
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TeleportPhaseIcon({ phase }: { phase: CloudTaskTeleportPhase }) {
  if (phase === 'restoring' || phase === 'suspending' || phase === 'resuming') {
    return <Loader2Icon className="size-3.5 animate-spin text-blue-500" />;
  }
  if (phase === 'suspended') {
    return <PauseCircleIcon className="size-3.5 text-amber-500" />;
  }
  return (
    <CloudIcon
      className={`size-3.5 ${
        phase === 'failed' ? 'text-red-500' : 'text-blue-500'
      }`}
    />
  );
}

function Diagnostic({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-token-text-tertiary">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-token-text-secondary ${
          mono ? 'font-mono' : ''
        }`}
        title={value}
      >
        {value}
      </dd>
    </>
  );
}

function shortenOpaqueId(value: string | null): string {
  if (!value) return '—';
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
