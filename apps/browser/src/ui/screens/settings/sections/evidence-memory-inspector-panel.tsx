import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { toast } from '@clodex/stage-ui/components/toaster';
import { resolveFeatureGate } from '@shared/feature-gates';
import type {
  EvidenceMemoryClaimConflict,
  EvidenceMemoryClaimDetails,
  EvidenceMemoryClaimSearchHit,
  EvidenceMemoryConflictResolutionAction,
  EvidenceMemoryDogfoodCohortReport,
  EvidenceMemoryInspectorSnapshot,
  EvidenceMemoryReadinessDashboard,
} from '@shared/evidence-memory-inspector';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import {
  ActivityIcon,
  AlertTriangleIcon,
  DatabaseIcon,
  DownloadIcon,
  GitForkIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
  Undo2Icon,
} from 'lucide-react';
import {
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

function notify(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `evidence-memory-${Date.now()}`,
    title,
    message,
    type,
    duration: 4_000,
    actions: [],
  });
}

export function EvidenceMemoryInspectorPanel() {
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const firstActiveTaskId = useKartonState(
    (state) => Object.keys(state.agents.instances)[0] ?? '',
  );
  const gate = resolveFeatureGate(
    'evidence-memory-inspector',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const getSnapshot = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.getSnapshot,
  );
  const search = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.search,
  );
  const getClaimDetails = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.getClaimDetails,
  );
  const resolveConflict = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.resolveConflict,
  );
  const undoConflictResolution = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.undoConflictResolution,
  );
  const exportToFile = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.exportToFile,
  );
  const resetTask = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.resetTask,
  );
  const getDogfoodDashboard = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.getDogfoodDashboard,
  );
  const getReadinessDashboard = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.getReadinessDashboard,
  );
  const evaluateReadiness = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.evaluateReadiness,
  );
  const runDogfoodBackfill = useKartonProcedure(
    (procedures) => procedures.evidenceMemoryInspector.runDogfoodBackfill,
  );
  const [taskId, setTaskId] = useState(firstActiveTaskId);
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] =
    useState<EvidenceMemoryInspectorSnapshot | null>(null);
  const [dogfoodDashboard, setDogfoodDashboard] =
    useState<EvidenceMemoryDogfoodCohortReport | null>(null);
  const [readiness, setReadiness] =
    useState<EvidenceMemoryReadinessDashboard | null>(null);
  const [hits, setHits] = useState<EvidenceMemoryClaimSearchHit[]>([]);
  const [details, setDetails] = useState<EvidenceMemoryClaimDetails | null>(
    null,
  );
  const [busy, setBusy] = useState<
    | 'load'
    | 'search'
    | 'details'
    | 'resolve'
    | 'undo'
    | 'backfill'
    | 'readiness'
    | 'export'
    | 'reset'
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    if (!taskId && firstActiveTaskId) setTaskId(firstActiveTaskId);
  }, [firstActiveTaskId, taskId]);

  const load = useCallback(async () => {
    const normalized = taskId.trim();
    if (!gate.enabled || !normalized) return;
    setBusy('load');
    setError(null);
    try {
      const [next, dashboard, nextReadiness] = await Promise.all([
        getSnapshot({
          taskId: normalized,
          eventLimit: 100,
          claimLimit: 100,
        }),
        getDogfoodDashboard(),
        getReadinessDashboard({ taskId: normalized }),
      ]);
      setSnapshot(next);
      setDogfoodDashboard(dashboard);
      setReadiness(nextReadiness);
      setHits([]);
      setDetails(null);
    } catch (cause) {
      setSnapshot(null);
      setReadiness(null);
      setError(
        cause instanceof Error ? cause.message : 'Unable to load memory.',
      );
    } finally {
      setBusy(null);
    }
  }, [
    gate.enabled,
    getDogfoodDashboard,
    getReadinessDashboard,
    getSnapshot,
    taskId,
  ]);

  const visibleClaims = useMemo(
    () =>
      hits.length > 0 ? hits.map((hit) => hit.claim) : (snapshot?.claims ?? []),
    [hits, snapshot],
  );
  const runnerRouteEvents = useMemo(
    () =>
      snapshot?.recentEvents.filter(
        (event) =>
          event.type === 'runner_shadow_route_predicted' ||
          event.type === 'runner_shadow_route_observed' ||
          event.type === 'runner_paired_replay_observed' ||
          event.type === 'runner_paired_replay_dogfood_evaluated' ||
          event.type === 'runner_automatic_route_selected' ||
          event.type === 'runner_automatic_route_observed',
      ) ?? [],
    [snapshot],
  );
  const memoryInjectionEvents = useMemo(
    () =>
      snapshot?.recentEvents.filter(
        (event) =>
          event.type === 'context_pack_injection_admitted' ||
          event.type === 'context_pack_injection_rejected' ||
          event.type === 'context_pack_injection_consumed',
      ) ?? [],
    [snapshot],
  );
  const latestMemoryInjectionEvent = memoryInjectionEvents[0] ?? null;
  const latestMemoryInjectionPayload = latestMemoryInjectionEvent
    ? asPayloadRecord(latestMemoryInjectionEvent.payload)
    : null;
  const fingerprintRefreshEvents = useMemo(
    () =>
      snapshot?.recentEvents.filter(
        (event) =>
          event.type === 'fingerprint_refresh_current' ||
          event.type === 'fingerprint_refresh_stale' ||
          event.type === 'fingerprint_refresh_failed',
      ) ?? [],
    [snapshot],
  );
  const latestFingerprintRefreshEvent = fingerprintRefreshEvents[0] ?? null;
  const latestFingerprintRefreshPayload = latestFingerprintRefreshEvent
    ? asPayloadRecord(latestFingerprintRefreshEvent.payload)
    : null;
  const latestContextPackPayload = snapshot?.latestContextPackEvent
    ? asPayloadRecord(snapshot.latestContextPackEvent.payload)
    : null;
  const latestDogfoodEvent =
    snapshot?.recentEvents.find(
      (event) => event.type === 'memory_dogfood_evaluated',
    ) ?? null;
  const latestDogfoodPayload = latestDogfoodEvent
    ? asPayloadRecord(latestDogfoodEvent.payload)
    : null;

  const runSearch = async () => {
    if (!taskId.trim() || !query.trim()) return;
    setBusy('search');
    try {
      setHits(
        await search({
          taskId: taskId.trim(),
          query: query.trim(),
          limit: 25,
          includeStale: true,
        }),
      );
      setDetails(null);
    } catch (cause) {
      notify(
        'Evidence search failed',
        cause instanceof Error ? cause.message : 'Unable to search evidence.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const openClaim = async (claimId: string) => {
    setBusy('details');
    try {
      setDetails(await getClaimDetails({ taskId: taskId.trim(), claimId }));
    } catch (cause) {
      notify(
        'Claim details failed',
        cause instanceof Error ? cause.message : 'Unable to load provenance.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('export');
    try {
      const result = await exportToFile(taskId.trim());
      if (!result.canceled) {
        notify(
          'Evidence memory exported',
          `${result.eventCount} events and ${result.claimCount} claims saved${result.truncated ? ' (bounded export)' : ''}.`,
        );
      }
    } catch (cause) {
      notify(
        'Evidence export failed',
        cause instanceof Error ? cause.message : 'Unable to export evidence.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleConflictResolution = async (
    conflict: EvidenceMemoryClaimConflict,
    action: EvidenceMemoryConflictResolutionAction,
  ) => {
    setBusy('resolve');
    try {
      await resolveConflict({
        taskId: taskId.trim(),
        claimIds: conflict.claims.map((claim) => claim.id),
        action,
      });
      notify('Conflict resolution recorded', conflictResolutionLabel(action));
      await load();
    } catch (cause) {
      notify(
        'Conflict resolution failed',
        cause instanceof Error ? cause.message : 'Unable to resolve conflict.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleUndoResolution = async (resolutionId: string) => {
    setBusy('undo');
    try {
      await undoConflictResolution({
        taskId: taskId.trim(),
        resolutionId,
      });
      notify('Resolution undone', 'The previous claim state was restored.');
      await load();
    } catch (cause) {
      notify(
        'Undo failed',
        cause instanceof Error ? cause.message : 'Unable to undo resolution.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy('reset');
    try {
      const result = await resetTask(taskId.trim());
      setResetOpen(false);
      setSnapshot(null);
      setHits([]);
      setDetails(null);
      notify(
        'Task memory reset',
        `${result.deletedEvents} events and ${result.deletedClaims} claims deleted.`,
      );
    } catch (cause) {
      notify(
        'Task reset failed',
        cause instanceof Error ? cause.message : 'Unable to reset task memory.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDogfoodBackfill = async () => {
    setBusy('backfill');
    try {
      const result = await runDogfoodBackfill({});
      setDogfoodDashboard(await getDogfoodDashboard());
      setReadiness(await getReadinessDashboard({ taskId: taskId.trim() }));
      notify(
        'Historical memory replay complete',
        `${result.observationsReplayed} observations from ${result.archivesWithCompression}/${result.archivesScanned} compressed archives; ${result.failures} failures.`,
      );
    } catch (cause) {
      notify(
        'Historical replay failed',
        cause instanceof Error
          ? cause.message
          : 'Unable to replay memory archives.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleReadinessEvaluation = async () => {
    if (!taskId.trim()) return;
    setBusy('readiness');
    try {
      const result = await evaluateReadiness({ taskId: taskId.trim() });
      setReadiness(result.dashboard);
      notify(
        'Readiness receipt recorded',
        `${result.dashboard.status.replace('-', ' ')} · ${result.receiptEventId.slice(0, 12)}`,
      );
    } catch (cause) {
      notify(
        'Readiness evaluation failed',
        cause instanceof Error
          ? cause.message
          : 'Unable to evaluate platform readiness.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="space-y-3">
        <SettingsSectionHeader
          title="Evidence Graph Memory inspector"
          description="Inspect one task at a time. Content is loaded only after an explicit trusted-UI request and never emitted through telemetry."
        />
        {!gate.enabled ? (
          <SettingsPanel className="p-4 text-token-text-secondary text-xs leading-5">
            Enable “{gate.definition.name}” in Preview features. The inspector
            has a separate gate from prompt injection.
          </SettingsPanel>
        ) : (
          <div className="space-y-3">
            <SettingsPanel className="space-y-3 p-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={taskId}
                  onValueChange={setTaskId}
                  placeholder="Task / agent ID"
                  className="min-w-0 flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null || !taskId.trim()}
                  onClick={() => void load()}
                >
                  {busy === 'load' ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-4" />
                  )}
                  Inspect
                </Button>
              </div>
              {error ? (
                <div className="rounded-lg border border-error-solid/25 bg-error-solid/7 p-3 text-error-solid text-xs">
                  {error}
                </div>
              ) : null}
            </SettingsPanel>

            {snapshot ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <SettingsSummaryCard
                    accent
                    label="Events"
                    value={snapshot.stats.events.total}
                    icon={<ShieldCheckIcon className="size-4" />}
                  />
                  <SettingsSummaryCard
                    label="Claims"
                    value={snapshot.stats.claims.total}
                  />
                  <SettingsSummaryCard
                    label="Conflicts"
                    value={snapshot.conflicts.length}
                  />
                  <SettingsSummaryCard
                    label="Stale code"
                    value={snapshot.stats.fingerprints.stale ?? 0}
                  />
                  <SettingsSummaryCard
                    label="Automatic routes"
                    value={
                      snapshot.stats.events.byType
                        .runner_automatic_route_selected ?? 0
                    }
                    icon={<GitForkIcon className="size-4" />}
                  />
                </div>

                {readiness ? (
                  <SettingsPanel className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium text-sm">
                          Guardian + Memory readiness
                        </h3>
                        <p className="mt-1 text-token-text-secondary text-xs">
                          Content-free promotion checks across summaries,
                          scheduler health, pruning coverage, memory dogfood,
                          and Guardian labels.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            readiness.status === 'candidate'
                              ? 'rounded-full bg-success-background px-2 py-1 font-medium text-[10px] text-success-foreground uppercase'
                              : readiness.status === 'needs-tuning'
                                ? 'rounded-full bg-warning-background px-2 py-1 font-medium text-[10px] text-warning-foreground uppercase'
                                : 'rounded-full bg-token-bg-secondary px-2 py-1 font-medium text-[10px] text-token-text-secondary uppercase'
                          }
                        >
                          {readiness.status.replace('-', ' ')}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => void handleReadinessEvaluation()}
                        >
                          {busy === 'readiness' ? (
                            <Loader2Icon className="size-4 animate-spin" />
                          ) : (
                            <ShieldCheckIcon className="size-4" />
                          )}
                          Record receipt
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
                      <SettingsSummaryCard
                        accent
                        label="Summaries"
                        value={`${readiness.summaries.shortCount}/${readiness.summaries.longCount}`}
                        icon={<DatabaseIcon className="size-4" />}
                      />
                      <SettingsSummaryCard
                        label="Scheduler"
                        value={
                          readiness.scheduler
                            ? `${readiness.scheduler.pendingTasks} pending`
                            : 'Unavailable'
                        }
                      />
                      <SettingsSummaryCard
                        label="Backoff / dropped"
                        value={
                          readiness.scheduler
                            ? `${readiness.scheduler.backingOffTasks}/${readiness.scheduler.droppedTasks}`
                            : '—'
                        }
                      />
                      <SettingsSummaryCard
                        label="Prunable"
                        value={readiness.pruningPreview.eligibleEventCount}
                      />
                      <SettingsSummaryCard
                        label="Memory sample"
                        value={`${readiness.memory.sampleCount}/100`}
                        icon={<ActivityIcon className="size-4" />}
                      />
                      <SettingsSummaryCard
                        label="Guardian labels"
                        value={readiness.guardian?.labeled ?? 0}
                      />
                      <SettingsSummaryCard
                        label="Shadow observations"
                        value={`${readiness.guardianShadow?.total ?? 0}/100`}
                      />
                    </div>

                    <div className="grid gap-2 text-[11px] text-token-text-secondary sm:grid-cols-2 lg:grid-cols-4">
                      <span>
                        Orientation:{' '}
                        {readiness.summaries.orientationSummaryCount} summaries
                        · {readiness.summaries.orientationEstimatedTokens}{' '}
                        tokens
                      </span>
                      <span>
                        Pruning coverage:{' '}
                        {readiness.pruningPreview.uncoveredCount} uncovered ·{' '}
                        {readiness.pruningPreview.protectedByClaimCount}{' '}
                        claim-protected
                      </span>
                      <span>
                        Guardian: {readiness.guardian?.status ?? 'unavailable'}{' '}
                        · memory:{' '}
                        {readiness.memory.promotionReady ? 'ready' : 'blocked'}
                      </span>
                      <span>
                        Shadow:{' '}
                        {readiness.guardianShadow?.status ?? 'unavailable'} ·
                        success{' '}
                        {formatRate(
                          readiness.guardianShadow?.successRate ?? null,
                        )}{' '}
                        · decision{' '}
                        {formatRate(
                          readiness.guardianShadow?.decisionAgreementRate ??
                            null,
                        )}{' '}
                        · critical{' '}
                        {readiness.guardianShadow?.criticalRiskDisagreements ??
                          0}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {(
                        [
                          ['Model summaries', readiness.gates.modelSummaries],
                          ['Guardian shadow', readiness.gates.guardianShadow],
                          ['Prompt injection', readiness.gates.promptInjection],
                        ] as const
                      ).map(([label, enabled]) => (
                        <span
                          key={String(label)}
                          className={
                            enabled
                              ? 'rounded-full border border-success-solid/20 bg-success-solid/7 px-2 py-1 text-[10px] text-success-solid'
                              : 'rounded-full border border-token-border-light bg-token-bg-secondary/45 px-2 py-1 text-[10px] text-token-text-secondary'
                          }
                        >
                          {enabled ? '✓' : '○'} {label}
                        </span>
                      ))}
                    </div>

                    {readiness.blockers.length > 0 ? (
                      <div className="rounded-lg bg-warning-background p-3 text-warning-foreground text-xs">
                        <span className="font-medium">Promotion blockers:</span>{' '}
                        {readiness.blockers.join(', ')}
                      </div>
                    ) : (
                      <div className="rounded-lg bg-success-background p-3 text-success-foreground text-xs">
                        All automated readiness checks pass. Promotion still
                        requires explicit human sign-off.
                      </div>
                    )}
                  </SettingsPanel>
                ) : null}

                <SettingsPanel className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium text-sm">Memory quality</h3>
                      <p className="mt-1 text-token-text-secondary text-xs">
                        Deterministic ledger coverage and observed retrieval
                        behavior for this task.
                      </p>
                    </div>
                    <span
                      className={
                        snapshot.quality.status === 'healthy'
                          ? 'rounded-full bg-success-background px-2 py-1 font-medium text-[10px] text-success-foreground uppercase'
                          : snapshot.quality.status === 'degraded'
                            ? 'rounded-full bg-warning-background px-2 py-1 font-medium text-[10px] text-warning-foreground uppercase'
                            : 'rounded-full bg-token-bg-secondary px-2 py-1 font-medium text-[10px] text-token-text-secondary uppercase'
                      }
                    >
                      {snapshot.quality.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <SettingsSummaryCard
                      accent
                      label="Deterministic"
                      value={formatPercent(
                        snapshot.quality.ingestion.deterministicCoverage,
                      )}
                      icon={<DatabaseIcon className="size-4" />}
                    />
                    <SettingsSummaryCard
                      label="Source coverage"
                      value={formatPercent(
                        snapshot.quality.ingestion.sourceCoverage,
                      )}
                    />
                    <SettingsSummaryCard
                      label="Evidence-backed"
                      value={formatPercent(
                        snapshot.quality.ingestion.evidenceBackedClaimRate,
                      )}
                    />
                    <SettingsSummaryCard
                      label="Retrieval hit rate"
                      value={formatPercent(snapshot.quality.retrieval.hitRate)}
                      icon={<ActivityIcon className="size-4" />}
                    />
                    <SettingsSummaryCard
                      label="Lexical evidence"
                      value={formatPercent(
                        snapshot.quality.retrieval.lexicalEvidenceRate,
                      )}
                    />
                    <SettingsSummaryCard
                      label="Token budget"
                      value={formatPercent(
                        snapshot.quality.retrieval.tokenBudgetUtilization,
                      )}
                    />
                  </div>
                  <div className="grid gap-2 text-[11px] text-token-text-secondary sm:grid-cols-3 lg:grid-cols-6">
                    <span>
                      Context packs:{' '}
                      {snapshot.quality.retrieval.totalContextPacks}
                    </span>
                    <span>
                      Avg. claims:{' '}
                      {snapshot.quality.retrieval.averageClaimsPerPack.toFixed(
                        1,
                      )}
                    </span>
                    <span>
                      Stale exclusions:{' '}
                      {snapshot.quality.retrieval.staleExclusions}
                    </span>
                    <span>
                      Graph expansion:{' '}
                      {formatPercent(
                        snapshot.quality.retrieval.graphExpansionRate,
                      )}
                    </span>
                    <span>
                      Avg. code snippets:{' '}
                      {snapshot.quality.retrieval.averageCodeSnippets.toFixed(
                        1,
                      )}
                    </span>
                    <span>
                      Budget exclusions:{' '}
                      {snapshot.quality.retrieval.tokenBudgetExclusions}
                    </span>
                  </div>
                  <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="font-medium text-xs">
                          Contradiction automation
                        </h4>
                        <p className="mt-1 text-[10px] text-token-text-tertiary">
                          Deterministic lifecycle relations; unresolved cases
                          remain fail-closed.
                        </p>
                      </div>
                      <span className="text-[10px] text-token-text-secondary">
                        {
                          snapshot.quality.contradictionAutomation
                            .automatedRelations
                        }{' '}
                        automated
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-token-text-secondary sm:grid-cols-5">
                      <span>
                        Superseded:{' '}
                        {snapshot.quality.contradictionAutomation.superseded}
                      </span>
                      <span>
                        Invalidated:{' '}
                        {snapshot.quality.contradictionAutomation.invalidated}
                      </span>
                      <span>
                        Confirmed:{' '}
                        {snapshot.quality.contradictionAutomation.confirmations}
                      </span>
                      <span>
                        Contradictions:{' '}
                        {
                          snapshot.quality.contradictionAutomation
                            .contradictions
                        }
                      </span>
                      <span>
                        Unresolved:{' '}
                        {
                          snapshot.quality.contradictionAutomation
                            .unresolvedConflicts
                        }
                      </span>
                    </div>
                  </div>
                  {snapshot.quality.warnings.map((warning) => (
                    <div
                      key={warning}
                      className="rounded-lg bg-warning-background p-2 text-warning-foreground text-xs"
                    >
                      {warning}
                    </div>
                  ))}
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium text-sm">
                        Cross-task dogfood operations
                      </h3>
                      <p className="mt-1 text-token-text-secondary text-xs">
                        Fresh 30-day cohort across local tasks, with required
                        scenario diversity and content-free historical replay.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          dogfoodDashboard?.promotionReady
                            ? 'rounded-full bg-success-background px-2 py-1 font-medium text-[10px] text-success-foreground uppercase'
                            : 'rounded-full bg-warning-background px-2 py-1 font-medium text-[10px] text-warning-foreground uppercase'
                        }
                      >
                        {dogfoodDashboard?.promotionReady
                          ? 'promotion ready'
                          : 'collecting'}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void handleDogfoodBackfill()}
                      >
                        {busy === 'backfill' ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-4" />
                        )}
                        Replay archives
                      </Button>
                    </div>
                  </div>
                  {dogfoodDashboard ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <SettingsSummaryCard
                          accent
                          label="Fresh pairs"
                          value={`${dogfoodDashboard.sampleCount}/100`}
                          icon={<ActivityIcon className="size-4" />}
                        />
                        <SettingsSummaryCard
                          label="Distinct tasks"
                          value={dogfoodDashboard.distinctTaskCount}
                        />
                        <SettingsSummaryCard
                          label="Window total"
                          value={dogfoodDashboard.totalObservationCount}
                        />
                        <SettingsSummaryCard
                          label="Expired"
                          value={dogfoodDashboard.staleObservationCount}
                        />
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-token-bg-tertiary">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{
                            width: `${Math.min(
                              100,
                              dogfoodDashboard.sampleCount,
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px] text-token-text-secondary sm:grid-cols-5">
                        <span>
                          Exact facts:{' '}
                          {dogfoodDashboard.categoryCoverage.exact_fact}/45
                        </span>
                        <span>
                          Constraints:{' '}
                          {dogfoodDashboard.categoryCoverage.user_constraint}
                          /20
                        </span>
                        <span>
                          Staleness:{' '}
                          {dogfoodDashboard.categoryCoverage.staleness}/15
                        </span>
                        <span>
                          Supersession:{' '}
                          {dogfoodDashboard.categoryCoverage.supersession}/10
                        </span>
                        <span>
                          Restart: {dogfoodDashboard.categoryCoverage.restart}
                          /10
                        </span>
                      </div>
                      {dogfoodDashboard.promotionBlockers.length > 0 ? (
                        <div className="rounded-lg bg-warning-background p-3 text-warning-foreground text-xs">
                          <span className="font-medium">Cohort blockers:</span>{' '}
                          {dogfoodDashboard.promotionBlockers.join(', ')}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-token-text-tertiary text-xs">
                      Load a task to initialize the local cohort dashboard.
                    </p>
                  )}
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium text-sm">
                        Memory dogfood & promotion
                      </h3>
                      <p className="mt-1 text-token-text-secondary text-xs">
                        Same-scenario comparison against compressed history.
                        Receipts contain aggregate metrics and policy identity,
                        never prompts, queries, or recovered claim IDs. Long
                        tasks collect automatically after their first real
                        history compression.
                      </p>
                    </div>
                    <span
                      className={
                        payloadBoolean(
                          latestDogfoodPayload ?? {},
                          'promotionReady',
                        )
                          ? 'rounded-full bg-success-background px-2 py-1 font-medium text-[10px] text-success-foreground uppercase'
                          : 'rounded-full bg-warning-background px-2 py-1 font-medium text-[10px] text-warning-foreground uppercase'
                      }
                    >
                      {latestDogfoodPayload
                        ? payloadBoolean(latestDogfoodPayload, 'promotionReady')
                          ? 'promotion ready'
                          : 'blocked'
                        : 'no evidence'}
                    </span>
                  </div>
                  {latestDogfoodPayload ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                        <SettingsSummaryCard
                          accent
                          label="Guarded recall"
                          value={formatRate(
                            payloadNumber(
                              latestDogfoodPayload,
                              'guardedMemoryRecall',
                            ),
                          )}
                          icon={<ShieldCheckIcon className="size-4" />}
                        />
                        <SettingsSummaryCard
                          label="Baseline recall"
                          value={formatRate(
                            payloadNumber(
                              latestDogfoodPayload,
                              'compressedHistoryRecall',
                            ),
                          )}
                        />
                        <SettingsSummaryCard
                          label="Retrieval recall"
                          value={formatRate(
                            payloadNumber(
                              latestDogfoodPayload,
                              'retrievalRecall',
                            ),
                          )}
                        />
                        <SettingsSummaryCard
                          label="Admission loss"
                          value={
                            payloadNumber(
                              latestDogfoodPayload,
                              'admissionLossCount',
                            ) ?? 0
                          }
                        />
                        <SettingsSummaryCard
                          label="Recall lift"
                          value={formatSignedPercent(
                            payloadNumber(latestDogfoodPayload, 'recallLift'),
                          )}
                        />
                        <SettingsSummaryCard
                          label="Stale leakage"
                          value={formatRate(
                            payloadNumber(
                              latestDogfoodPayload,
                              'guardedMemoryStaleLeakageRate',
                            ),
                          )}
                        />
                        <SettingsSummaryCard
                          label="Token overhead"
                          value={formatSignedPercent(
                            payloadNumber(
                              latestDogfoodPayload,
                              'tokenOverheadRatio',
                            ),
                          )}
                        />
                        <SettingsSummaryCard
                          label="Guarded p95"
                          value={`${Math.round(
                            payloadNumber(
                              latestDogfoodPayload,
                              'guardedMemoryLatencyP95Ms',
                            ) ?? 0,
                          )} ms`}
                          icon={<ActivityIcon className="size-4" />}
                        />
                      </div>
                      <div className="grid gap-2 text-[11px] text-token-text-secondary sm:grid-cols-4">
                        <span>
                          Promotion window:{' '}
                          {payloadNumber(latestDogfoodPayload, 'sampleCount') ??
                            0}
                          /100
                        </span>
                        <span>
                          Missing provenance:{' '}
                          {payloadNumber(
                            latestDogfoodPayload,
                            'missingProvenanceAdmissionCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Conflict injections:{' '}
                          {payloadNumber(
                            latestDogfoodPayload,
                            'unresolvedContradictionInjectionCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Policy:{' '}
                          {shortDigest(
                            payloadString(latestDogfoodPayload, 'policyHash') ??
                              'unknown',
                          )}
                        </span>
                      </div>
                      <div className="grid gap-2 rounded-lg bg-token-bg-secondary/35 p-3 text-[11px] text-token-text-secondary sm:grid-cols-2 lg:grid-cols-4">
                        <span>
                          Retrieval packing:{' '}
                          {payloadNumber(
                            latestDogfoodPayload,
                            'retrievalSelectedCount',
                          ) ?? 0}
                          /
                          {payloadNumber(
                            latestDogfoodPayload,
                            'retrievalCandidateCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Admission packing:{' '}
                          {payloadNumber(
                            latestDogfoodPayload,
                            'admissionSelectedCount',
                          ) ?? 0}
                          /
                          {payloadNumber(
                            latestDogfoodPayload,
                            'admissionCandidateCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Guarded token split:{' '}
                          {payloadNumber(
                            latestDogfoodPayload,
                            'guardedEnvelopeTotalTokens',
                          ) ?? 0}{' '}
                          envelope +{' '}
                          {payloadNumber(
                            latestDogfoodPayload,
                            'guardedClaimTotalTokens',
                          ) ?? 0}{' '}
                          claims
                        </span>
                        <span
                          className="truncate"
                          title={formatCountRecord(
                            payloadRecord(
                              latestDogfoodPayload,
                              'admissionReasonCodeCounts',
                            ),
                          )}
                        >
                          Admission reasons:{' '}
                          {formatCountRecord(
                            payloadRecord(
                              latestDogfoodPayload,
                              'admissionReasonCodeCounts',
                            ),
                          )}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-token-bg-tertiary">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{
                            width: `${Math.min(
                              100,
                              payloadNumber(
                                latestDogfoodPayload,
                                'sampleCount',
                              ) ?? 0,
                            )}%`,
                          }}
                        />
                      </div>
                      {payloadStringArray(
                        latestDogfoodPayload,
                        'promotionBlockers',
                      ).length > 0 ? (
                        <div className="rounded-lg bg-warning-background p-3 text-warning-foreground text-xs">
                          <span className="font-medium">
                            Promotion blockers:
                          </span>{' '}
                          {payloadStringArray(
                            latestDogfoodPayload,
                            'promotionBlockers',
                          ).join(', ')}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3 text-token-text-secondary text-xs">
                      Collector armed. Waiting for this task’s first history
                      compression and a relevant Context Pack. Guarded injection
                      remains independently gated.
                    </div>
                  )}
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div>
                    <h3 className="font-medium text-sm">
                      Guarded memory injection
                    </h3>
                    <p className="mt-1 text-token-text-secondary text-xs">
                      Model-only Context Packs are admitted only with current
                      revision evidence, direct provenance, resolved truth, and
                      a bounded token budget. Rejections preserve compressed
                      history unchanged.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <SettingsSummaryCard
                      accent
                      label="Admitted"
                      value={
                        snapshot.stats.events.byType
                          .context_pack_injection_admitted ?? 0
                      }
                      icon={<ShieldCheckIcon className="size-4" />}
                    />
                    <SettingsSummaryCard
                      label="Rejected"
                      value={
                        snapshot.stats.events.byType
                          .context_pack_injection_rejected ?? 0
                      }
                    />
                    <SettingsSummaryCard
                      label="Consumed"
                      value={
                        snapshot.stats.events.byType
                          .context_pack_injection_consumed ?? 0
                      }
                    />
                    <SettingsSummaryCard
                      label="Latest tokens"
                      value={
                        latestMemoryInjectionPayload
                          ? (payloadNumber(
                              latestMemoryInjectionPayload,
                              'estimatedTokens',
                            ) ?? 0)
                          : 0
                      }
                    />
                  </div>
                  <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3 text-[11px] text-token-text-secondary">
                    {latestMemoryInjectionEvent &&
                    latestMemoryInjectionPayload ? (
                      <div className="grid gap-1 sm:grid-cols-2">
                        <span>
                          Latest decision:{' '}
                          {latestMemoryInjectionEvent.type ===
                          'context_pack_injection_rejected'
                            ? 'rejected'
                            : latestMemoryInjectionEvent.type ===
                                'context_pack_injection_consumed'
                              ? 'consumed'
                              : 'admitted'}
                        </span>
                        <span>
                          Claims:{' '}
                          {payloadNumber(
                            latestMemoryInjectionPayload,
                            'claimCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Reason:{' '}
                          {payloadStringArray(
                            latestMemoryInjectionPayload,
                            'reasonCodes',
                          ).join(', ') || 'unknown'}
                        </span>
                        <span>
                          Fallback:{' '}
                          {payloadBoolean(
                            latestMemoryInjectionPayload,
                            'fallbackToCompressedHistory',
                          )
                            ? 'compressed history'
                            : 'not required'}
                        </span>
                      </div>
                    ) : (
                      'No guarded injection decisions in this bounded task view.'
                    )}
                  </div>
                  <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="font-medium text-xs">
                          Live CodeGraph refresh
                        </h4>
                        <p className="mt-1 text-[10px] text-token-text-tertiary">
                          File and symbol hashes are refreshed under a bounded
                          deadline before code evidence can enter the model.
                        </p>
                      </div>
                      <span className="text-[10px] text-token-text-secondary">
                        {latestFingerprintRefreshEvent
                          ? latestFingerprintRefreshEvent.type.replace(
                              'fingerprint_refresh_',
                              '',
                            )
                          : 'no data'}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-token-text-secondary">
                      <span>
                        Current:{' '}
                        {snapshot.stats.events.byType
                          .fingerprint_refresh_current ?? 0}
                      </span>
                      <span>
                        Stale:{' '}
                        {snapshot.stats.events.byType
                          .fingerprint_refresh_stale ?? 0}
                      </span>
                      <span>
                        Failed:{' '}
                        {snapshot.stats.events.byType
                          .fingerprint_refresh_failed ?? 0}
                      </span>
                    </div>
                    {latestFingerprintRefreshPayload ? (
                      <div className="mt-2 grid gap-1 text-[10px] text-token-text-tertiary sm:grid-cols-3">
                        <span>
                          Entities:{' '}
                          {payloadNumber(
                            latestFingerprintRefreshPayload,
                            'entityCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Duration:{' '}
                          {payloadNumber(
                            latestFingerprintRefreshPayload,
                            'durationMs',
                          ) ?? 0}
                          ms
                        </span>
                        <span>
                          Timed out:{' '}
                          {payloadBoolean(
                            latestFingerprintRefreshPayload,
                            'timedOut',
                          )
                            ? 'yes'
                            : 'no'}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {latestContextPackPayload ? (
                    <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="font-medium text-xs">
                            Context Builder Phase 2
                          </h4>
                          <p className="mt-1 text-[10px] text-token-text-tertiary">
                            Utility-density packing with subject diversity and
                            current CodeGraph evidence.
                          </p>
                        </div>
                        <span className="text-[10px] text-token-text-secondary">
                          {payloadString(
                            latestContextPackPayload,
                            'packingStrategy',
                          ) ?? 'legacy'}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-token-text-secondary sm:grid-cols-4">
                        <span>
                          Candidates:{' '}
                          {payloadNumber(
                            latestContextPackPayload,
                            'candidateCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Selected:{' '}
                          {payloadNumber(
                            latestContextPackPayload,
                            'selectedCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Code snippets:{' '}
                          {payloadNumber(
                            latestContextPackPayload,
                            'codeSnippetCount',
                          ) ?? 0}
                        </span>
                        <span>
                          Unused tokens:{' '}
                          {payloadNumber(
                            latestContextPackPayload,
                            'unusedTokens',
                          ) ?? 0}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-2 font-medium text-sm">
                        <AlertTriangleIcon className="size-4 text-warning-foreground" />
                        Conflict inbox
                      </h3>
                      <p className="mt-1 text-token-text-secondary text-xs">
                        Human decisions are append-only audit events. Lifecycle
                        changes can be undone only while no newer resolution
                        exists.
                      </p>
                    </div>
                    <span className="rounded-full bg-token-bg-secondary px-2 py-1 text-[10px] text-token-text-secondary">
                      {snapshot.conflicts.length} open
                    </span>
                  </div>
                  <div className="space-y-3">
                    {snapshot.conflicts.map((conflict) => {
                      const ordered = [...conflict.claims].sort(
                        (left, right) =>
                          left.createdAt - right.createdAt ||
                          left.id.localeCompare(right.id),
                      );
                      const latestResolution =
                        snapshot.conflictResolutions.find(
                          (resolution) =>
                            resolution.revertedAt === null &&
                            resolution.subject === conflict.subject &&
                            sameClaimIds(
                              resolution.claimIds,
                              conflict.claims.map((claim) => claim.id),
                            ),
                        );
                      return (
                        <div
                          key={`${conflict.subject}:${ordered
                            .map((claim) => claim.id)
                            .join(':')}`}
                          className="rounded-xl border border-warning-foreground/20 bg-warning-background/40 p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-xs">
                              {conflict.subject}
                            </span>
                            {latestResolution ? (
                              <span className="rounded bg-token-bg-primary/60 px-2 py-1 text-[9px] uppercase">
                                {latestResolution.action}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {ordered.map((claim, index) => (
                              <button
                                key={claim.id}
                                type="button"
                                className="rounded-lg border border-token-border-light bg-token-bg-primary/55 p-2 text-left"
                                onClick={() => void openClaim(claim.id)}
                              >
                                <span className="text-[9px] text-token-text-tertiary uppercase">
                                  {index === 0
                                    ? 'oldest'
                                    : index === ordered.length - 1
                                      ? 'newest'
                                      : `version ${index + 1}`}
                                </span>
                                <p className="mt-1 line-clamp-3 text-xs">
                                  {claim.text}
                                </p>
                              </button>
                            ))}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void handleConflictResolution(
                                  conflict,
                                  'keep_older',
                                )
                              }
                            >
                              Keep old
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void handleConflictResolution(
                                  conflict,
                                  'accept_newer',
                                )
                              }
                            >
                              Accept new
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void handleConflictResolution(
                                  conflict,
                                  'both_valid',
                                )
                              }
                            >
                              Both valid
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void handleConflictResolution(conflict, 'defer')
                              }
                            >
                              Defer
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void handleConflictResolution(
                                  conflict,
                                  'dismiss',
                                )
                              }
                            >
                              Dismiss
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    {snapshot.conflicts.length === 0 ? (
                      <p className="text-token-text-tertiary text-xs">
                        No unresolved claim conflicts.
                      </p>
                    ) : null}
                  </div>
                  {snapshot.conflictResolutions.length > 0 ? (
                    <div className="border-token-border-light border-t pt-3">
                      <h4 className="font-medium text-xs">
                        Resolution audit history
                      </h4>
                      <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                        {snapshot.conflictResolutions.map((resolution) => (
                          <div
                            key={resolution.id}
                            className="flex items-center justify-between gap-3 rounded-lg bg-token-bg-secondary/35 p-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium text-xs">
                                {resolution.subject}
                              </p>
                              <p className="text-[10px] text-token-text-tertiary">
                                {resolution.action.replaceAll('_', ' ')} ·{' '}
                                {new Date(
                                  resolution.createdAt,
                                ).toLocaleString()}
                                {resolution.revertedAt
                                  ? ` · undone ${new Date(
                                      resolution.revertedAt,
                                    ).toLocaleString()}`
                                  : ''}
                              </p>
                            </div>
                            {!resolution.revertedAt ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy !== null}
                                onClick={() =>
                                  void handleUndoResolution(resolution.id)
                                }
                              >
                                <Undo2Icon className="size-3.5" />
                                Undo
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div>
                    <h3 className="font-medium text-sm">
                      Recent ledger events
                    </h3>
                    <p className="mt-1 text-token-text-secondary text-xs">
                      Bounded append-only timeline with ingestion provenance.
                    </p>
                  </div>
                  <div className="max-h-80 space-y-2 overflow-y-auto">
                    {snapshot.recentEvents.map((event) => (
                      <div
                        key={event.id}
                        className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-token-text-primary text-xs">
                                {event.type}
                              </span>
                              <span className="rounded bg-token-bg-tertiary px-1.5 py-0.5 text-[9px] text-token-text-secondary uppercase">
                                {event.ingestionKeyHash
                                  ? 'deterministic'
                                  : 'unkeyed'}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-[10px] text-token-text-tertiary">
                              {event.source ?? 'unknown source'} · payload{' '}
                              {shortDigest(event.payloadHash)}
                              {event.repositoryRevision
                                ? ` · revision ${shortDigest(
                                    event.repositoryRevision,
                                  )}`
                                : ''}
                            </p>
                          </div>
                          <span className="shrink-0 text-[10px] text-token-text-tertiary">
                            {new Date(event.timestamp).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    ))}
                    {snapshot.recentEvents.length === 0 ? (
                      <p className="text-token-text-tertiary text-xs">
                        No ledger events for this task.
                      </p>
                    ) : null}
                  </div>
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div>
                    <h3 className="font-medium text-sm">Runner routing</h3>
                    <p className="mt-1 text-token-text-secondary text-xs">
                      Shadow predictions stay observational. Automatic routes
                      require environment-bound evidence and may fall back only
                      before dispatch.
                    </p>
                  </div>
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {runnerRouteEvents.map((event) => {
                      const payload = asPayloadRecord(event.payload);
                      const predicted =
                        event.type === 'runner_shadow_route_predicted';
                      const automaticSelected =
                        event.type === 'runner_automatic_route_selected';
                      const automaticObserved =
                        event.type === 'runner_automatic_route_observed';
                      const pairedReplay =
                        event.type === 'runner_paired_replay_observed';
                      const dogfoodEvaluation =
                        event.type === 'runner_paired_replay_dogfood_evaluated';
                      return (
                        <div
                          key={event.id}
                          className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium text-token-text-primary text-xs">
                              {automaticSelected
                                ? 'Automatic selection'
                                : automaticObserved
                                  ? 'Automatic execution'
                                  : dogfoodEvaluation
                                    ? 'Paired replay metrics'
                                    : pairedReplay
                                      ? 'Verified paired replay'
                                      : predicted
                                        ? 'Shadow prediction'
                                        : 'Shadow observation'}
                            </span>
                            <span className="text-[10px] text-token-text-tertiary">
                              {new Date(event.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="mt-2 grid gap-1 text-[11px] text-token-text-secondary sm:grid-cols-2">
                            <span>
                              Recommended:{' '}
                              {payloadString(
                                payload,
                                'recommendedProviderKind',
                              ) ??
                                payloadString(
                                  payload,
                                  'selectedProviderKind',
                                ) ??
                                'none'}
                            </span>
                            <span>
                              Actual:{' '}
                              {payloadString(payload, 'actualProviderKind') ??
                                payloadString(
                                  payload,
                                  'configuredProviderKind',
                                ) ??
                                'unknown'}
                            </span>
                            <span>
                              Operation:{' '}
                              {payloadString(payload, 'operation') ?? 'unknown'}
                            </span>
                            <span>
                              Match:{' '}
                              {payloadBoolean(
                                payload,
                                'matchedActualProvider',
                              ) === true
                                ? 'yes'
                                : payloadBoolean(
                                      payload,
                                      'matchedActualProvider',
                                    ) === false
                                  ? 'no'
                                  : 'pending'}
                            </span>
                            {(automaticSelected || automaticObserved) && (
                              <span>
                                Route mode:{' '}
                                {payloadString(payload, 'routeMode') ??
                                  (automaticSelected ? 'automatic' : 'unknown')}
                              </span>
                            )}
                            {pairedReplay && (
                              <>
                                <span>
                                  Replay provider:{' '}
                                  {payloadString(payload, 'providerKind') ??
                                    'unknown'}
                                </span>
                                <span>
                                  Outcome:{' '}
                                  {payloadString(payload, 'outcome') ??
                                    'unknown'}
                                </span>
                              </>
                            )}
                            {dogfoodEvaluation && (
                              <>
                                <span>
                                  Candidates:{' '}
                                  {payloadNumber(payload, 'candidateCount') ??
                                    0}
                                </span>
                                <span>
                                  Verified:{' '}
                                  {payloadNumber(payload, 'completedCount') ??
                                    0}
                                </span>
                                <span>
                                  Completion coverage:{' '}
                                  {formatRate(
                                    payloadNumber(
                                      payload,
                                      'completionCoverage',
                                    ),
                                  )}
                                </span>
                                <span>
                                  Replay success:{' '}
                                  {formatRate(
                                    payloadNumber(payload, 'replaySuccessRate'),
                                  )}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {runnerRouteEvents.length === 0 ? (
                      <p className="text-token-text-tertiary text-xs">
                        No runner routing decisions in this bounded task view.
                      </p>
                    ) : null}
                  </div>
                </SettingsPanel>

                <SettingsPanel className="space-y-3 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={query}
                      onValueChange={setQuery}
                      placeholder="Exact flag, error, decision, or constraint"
                      className="min-w-0 flex-1"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null || !query.trim()}
                      onClick={() => void runSearch()}
                    >
                      <SearchIcon className="size-4" />
                      Search
                    </Button>
                  </div>
                  <div className="max-h-72 space-y-2 overflow-y-auto">
                    {visibleClaims.map((claim) => (
                      <button
                        key={claim.id}
                        type="button"
                        className="w-full rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3 text-left hover:bg-token-bg-tertiary"
                        onClick={() => void openClaim(claim.id)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-token-text-primary text-xs">
                            {claim.subject}
                          </span>
                          <span className="text-[10px] text-token-text-tertiary uppercase">
                            {claim.status}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-token-text-secondary text-xs">
                          {claim.text}
                        </p>
                      </button>
                    ))}
                    {visibleClaims.length === 0 ? (
                      <p className="text-token-text-tertiary text-xs">
                        No claims in this bounded view.
                      </p>
                    ) : null}
                  </div>
                </SettingsPanel>

                {details ? (
                  <SettingsPanel className="space-y-3 p-4">
                    <div>
                      <h3 className="font-medium text-sm">
                        {details.claim.subject}
                      </h3>
                      <p className="mt-1 text-token-text-secondary text-xs leading-5">
                        {details.claim.text}
                      </p>
                    </div>
                    <div className="grid gap-2 text-xs sm:grid-cols-3">
                      <div>Evidence: {details.evidenceEvents.length}</div>
                      <div>Relations: {details.relations.length}</div>
                      <div>Exclusions: {details.truth.exclusions.length}</div>
                    </div>
                    {details.truth.exclusions.map((exclusion) => (
                      <div
                        key={exclusion.claimId}
                        className="rounded-lg bg-warning-background p-2 text-warning-foreground text-xs"
                      >
                        Excluded {exclusion.claimId}: {exclusion.reason}
                      </div>
                    ))}
                    {details.relations.map((relation) => (
                      <div
                        key={relation.id}
                        className="rounded-lg border border-token-border-light bg-token-bg-secondary/35 p-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{relation.type}</span>
                          <span className="text-[10px] text-token-text-tertiary uppercase">
                            {relation.origin}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-token-text-secondary">
                          {relation.fromClaimId} → {relation.toClaimId}
                          {relation.reason ? ` · ${relation.reason}` : ''}
                        </p>
                      </div>
                    ))}
                    {details.evidenceEvents.map((event) => (
                      <pre
                        key={event.id}
                        className="max-h-36 overflow-auto rounded-lg bg-token-bg-primary p-3 text-[10px]"
                      >
                        {JSON.stringify(
                          {
                            id: event.id,
                            type: event.type,
                            timestamp: event.timestamp,
                            payload: event.payload,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    ))}
                  </SettingsPanel>
                ) : null}

                <SettingsPanel className="flex flex-wrap justify-end gap-2 p-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void handleExport()}
                  >
                    <DownloadIcon className="size-4" />
                    Export bounded JSON
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setResetOpen(true)}
                  >
                    <Trash2Icon className="size-4" />
                    Reset task…
                  </Button>
                </SettingsPanel>
              </>
            ) : null}
          </div>
        )}
      </section>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogClose />
          <DialogHeader>
            <DialogTitle>Reset evidence memory for this task?</DialogTitle>
            <DialogDescription>
              This permanently deletes the task ledger, claims, relations, and
              code fingerprints. Other tasks are not affected.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-error-background p-3 text-error-foreground text-xs">
            Task: <strong>{taskId}</strong>
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
              Delete task memory
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  return typeof payload[key] === 'string' ? payload[key] : null;
}

function payloadBoolean(
  payload: Record<string, unknown>,
  key: string,
): boolean | null {
  return typeof payload[key] === 'boolean' ? payload[key] : null;
}

function payloadNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadRecord(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asPayloadRecord(payload[key]);
}

function formatCountRecord(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' &&
        Number.isSafeInteger(entry[1]) &&
        entry[1] > 0,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? 'none'
    : entries.map(([key, value]) => `${key}: ${value}`).join(', ');
}

function payloadStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatSignedPercent(value: number | null): string {
  if (value === null) return 'n/a';
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function shortDigest(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}…`;
}

function sameClaimIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((claimId, index) => claimId === sortedRight[index]);
}

function conflictResolutionLabel(
  action: EvidenceMemoryConflictResolutionAction,
): string {
  switch (action) {
    case 'keep_older':
      return 'The oldest claim remains authoritative.';
    case 'accept_newer':
      return 'The newest claim is now authoritative.';
    case 'both_valid':
      return 'The claims are grouped as mutually valid.';
    case 'defer':
      return 'The conflict remains fail-closed and was deferred.';
    case 'dismiss':
      return 'The conflict was acknowledged without changing truth selection.';
  }
}
