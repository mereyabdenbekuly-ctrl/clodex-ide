import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import {
  automationDefinitionSchema,
  automationStoreSchema,
  createAutomationInputSchema,
  emptyAutomationStore,
  type AutomationDefinition,
  type AutomationOperationResult,
  type AutomationRun,
  type AutomationSnapshot,
  type AutomationStoreData,
  type AutomationWakeSchedulerStatus,
  updateAutomationInputSchema,
} from '@shared/automations';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';
import type { Logger } from '../logger';
import type { KartonService } from '../karton';
import type { NotificationService } from '../notification';
import { DisposableService } from '../disposable';
import {
  AutomationDispatchWal,
  type AutomationDispatchWalPersistence,
  type AutomationDispatchWalRecord,
  type AutomationDispatchPreparation,
  type AutomationDispatchTrigger,
  createAutomationDispatchCommitments,
  PersistedAutomationDispatchWal,
} from './dispatch-wal';
import { getNextAutomationRunAt } from './schedule';

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_RECENT_RUNS = 500;
type AutomationTimerHandle = ReturnType<typeof setTimeout>;

const PROCEDURES = [
  'automations.getSnapshot',
  'automations.create',
  'automations.update',
  'automations.delete',
  'automations.runNow',
  'automations.setEnabled',
] as const;

export interface AutomationPersistence {
  load(): Promise<AutomationStoreData>;
  save(data: AutomationStoreData): Promise<void>;
}

export interface AutomationDispatchInput {
  automation: AutomationDefinition;
  prompt: string;
  beforeDispatch?: () => void;
}

export interface AutomationDispatchResult {
  agentId: string;
}

export interface AutomationBeforeDispatchInput extends AutomationDispatchInput {
  attempt: number;
}

export interface AutomationManualRunOptions {
  /** Synchronous final authority check; it runs with no await before dispatch. */
  beforeDispatch?: (input: AutomationBeforeDispatchInput) => void;
  /** @deprecated Every automation dispatch is now one-shot and never retries. */
  retryMode?: 'configured' | 'no-blind-retry';
  /** Artifact Bridge propagates adapter failure after run state is recorded. */
  failureMode?: 'record' | 'propagate';
}

export interface AutomationWakeSource {
  onResume(listener: () => void): () => void;
}

export interface AutomationNativeWakeScheduler {
  getStatus(): AutomationWakeSchedulerStatus;
  sync(nextWakeAt: string | null): Promise<void>;
}

export interface AutomationServiceOptions {
  logger: Logger;
  karton: KartonService;
  notifications: NotificationService;
  isFeatureEnabled: () => boolean;
  dispatch: (
    input: AutomationDispatchInput,
  ) => Promise<AutomationDispatchResult>;
  persistence?: AutomationPersistence;
  dispatchWalPersistence?: AutomationDispatchWalPersistence;
  wakeSource?: AutomationWakeSource;
  nativeWakeScheduler?: AutomationNativeWakeScheduler;
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => AutomationTimerHandle;
  clearTimer?: (timer: AutomationTimerHandle) => void;
  /** @deprecated Automation effects are never retried or delayed in-process. */
  sleep?: (delayMs: number) => Promise<void>;
}

class PersistedAutomationStore implements AutomationPersistence {
  async load(): Promise<AutomationStoreData> {
    return await readPersistedData(
      'automations',
      automationStoreSchema,
      emptyAutomationStore,
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
  }

  async save(data: AutomationStoreData): Promise<void> {
    await writePersistedData('automations', automationStoreSchema, data, {
      encrypt: true,
      requireEncryption: true,
    });
  }
}

export class AutomationService extends DisposableService {
  private data: AutomationStoreData = structuredClone(emptyAutomationStore);
  private readonly persistence: AutomationPersistence;
  private dispatchWal!: AutomationDispatchWal;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<AutomationServiceOptions['setTimer']>;
  private readonly clearTimer: NonNullable<
    AutomationServiceOptions['clearTimer']
  >;
  private timer: AutomationTimerHandle | null = null;
  private removeWakeListener: (() => void) | null = null;
  private mutation = Promise.resolve();
  private readonly runningAutomationIds = new Set<string>();
  private shuttingDown = false;

  private constructor(private readonly options: AutomationServiceOptions) {
    super();
    this.persistence = options.persistence ?? new PersistedAutomationStore();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  public static async create(
    options: AutomationServiceOptions,
  ): Promise<AutomationService> {
    const service = new AutomationService(options);
    service.data = automationStoreSchema.parse(
      await service.persistence.load(),
    );
    service.dispatchWal = await AutomationDispatchWal.create(
      options.dispatchWalPersistence ?? new PersistedAutomationDispatchWal(),
      service.now,
    );
    service.registerProcedures();
    service.removeWakeListener =
      options.wakeSource?.onResume(() => {
        void service.handleResume();
      }) ?? null;
    await service.reconcileStartup();
    service.scheduleNextTimer();
    await service.syncNativeWake();
    return service;
  }

  public getSnapshot(): AutomationSnapshot {
    const enabledRuns = this.data.automations
      .filter((automation) => automation.enabled && automation.nextRunAt)
      .map((automation) => Date.parse(automation.nextRunAt ?? ''))
      .filter(Number.isFinite);
    const nextWake = enabledRuns.length > 0 ? Math.min(...enabledRuns) : null;

    return {
      automations: structuredClone(this.data.automations),
      recentRuns: structuredClone(this.data.runs),
      nextWakeAt: nextWake === null ? null : new Date(nextWake).toISOString(),
      wakeScheduler: this.options.nativeWakeScheduler?.getStatus() ?? {
        platform: process.platform,
        mode: 'resume-only',
        canWakeSystem: false,
        scheduledFor:
          nextWake === null ? null : new Date(nextWake).toISOString(),
        registeredAt: null,
        message:
          'Native wake scheduler is not configured; runs reconcile after resume.',
      },
    };
  }

  /**
   * Returns the exact definition that a serialized manual dispatch will use.
   * Artifact Bridge commits this snapshot before entering the composite
   * create-agent -> send-message adapter and compares it with the clone passed
   * to the synchronous final-dispatch callback.
   */
  public getDefinitionForDispatch(id: string): AutomationDefinition {
    this.assertEnabled();
    return structuredClone(this.getAutomation(id));
  }

  private assertEnabled(): void {
    this.assertNotDisposed();
    if (this.shuttingDown) {
      throw new Error('Scheduled automations service is shutting down');
    }
    if (!this.options.isFeatureEnabled()) {
      throw new Error('Scheduled automations feature is disabled');
    }
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'automations.getSnapshot',
      async () => {
        this.assertEnabled();
        return this.getSnapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'automations.create',
      async (_clientId, input) => await this.createAutomation(input),
    );
    karton.registerServerProcedureHandler(
      'automations.update',
      async (_clientId, input) => await this.updateAutomation(input),
    );
    karton.registerServerProcedureHandler(
      'automations.delete',
      async (_clientId, id) => await this.deleteAutomation(id),
    );
    karton.registerServerProcedureHandler(
      'automations.runNow',
      async (_clientId, id) => await this.runAutomationNow(id),
    );
    karton.registerServerProcedureHandler(
      'automations.setEnabled',
      async (_clientId, id, enabled) => await this.setEnabled(id, enabled),
    );
  }

  private async createAutomation(
    input: unknown,
  ): Promise<AutomationOperationResult> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const parsed = createAutomationInputSchema.parse(input);
      const timestamp = this.now();
      const nextRunAt = parsed.enabled
        ? getNextAutomationRunAt(parsed.schedule, timestamp - 1)
        : null;
      if (parsed.enabled && nextRunAt === null) {
        throw new Error('Automation schedule has no future run');
      }
      const automation = automationDefinitionSchema.parse({
        ...parsed,
        id: randomUUID(),
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
        nextRunAt:
          nextRunAt === null ? null : new Date(nextRunAt).toISOString(),
        lastRunAt: null,
      });
      this.data.automations.push(automation);
      await this.persistAndReschedule();
      return this.result(true, 'Automation created');
    });
  }

  private async updateAutomation(
    input: unknown,
  ): Promise<AutomationOperationResult> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const parsed = updateAutomationInputSchema.parse(input);
      const index = this.findAutomationIndex(parsed.id);
      const existing = this.data.automations[index];
      if (!existing) throw new Error('Automation not found');
      const timestamp = this.now();
      const updated = automationDefinitionSchema.parse({
        ...existing,
        ...parsed,
        updatedAt: new Date(timestamp).toISOString(),
      });
      updated.nextRunAt = updated.enabled
        ? this.toIso(getNextAutomationRunAt(updated.schedule, timestamp - 1))
        : null;
      if (updated.enabled && updated.nextRunAt === null) {
        throw new Error('Automation schedule has no future run');
      }
      this.data.automations[index] = updated;
      await this.persistAndReschedule();
      return this.result(true, 'Automation updated');
    });
  }

  private async deleteAutomation(
    id: string,
  ): Promise<AutomationOperationResult> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const index = this.findAutomationIndex(id);
      this.data.automations.splice(index, 1);
      await this.persistAndReschedule();
      return this.result(true, 'Automation deleted');
    });
  }

  private async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<AutomationOperationResult> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const automation = this.getAutomation(id);
      automation.enabled = enabled;
      automation.updatedAt = new Date(this.now()).toISOString();
      automation.nextRunAt = enabled
        ? this.toIso(
            getNextAutomationRunAt(automation.schedule, this.now() - 1),
          )
        : null;
      if (enabled && automation.nextRunAt === null) {
        throw new Error('Automation schedule has no future run');
      }
      await this.persistAndReschedule();
      return this.result(
        true,
        enabled ? 'Automation enabled' : 'Automation disabled',
      );
    });
  }

  public async runAutomationNow(
    id: string,
    options: AutomationManualRunOptions = {},
  ): Promise<AutomationOperationResult> {
    this.assertEnabled();
    const manualRunOptions: AutomationManualRunOptions = {
      beforeDispatch: options.beforeDispatch,
      retryMode: 'no-blind-retry',
      failureMode: options.failureMode ?? 'record',
    };
    return await this.serialize(async () => {
      const automation = this.getAutomation(id);
      let executionFailed = false;
      let executionError: unknown;
      try {
        await this.executeAutomation(
          automation,
          this.now(),
          'manual',
          false,
          manualRunOptions,
        );
      } catch (error) {
        executionFailed = true;
        executionError = error;
      }
      await this.persistAndReschedule();
      if (executionFailed) throw executionError;
      return this.result(true, 'Automation submitted');
    });
  }

  private async reconcileStartup(): Promise<void> {
    if (this.shuttingDown || !this.options.isFeatureEnabled()) return;
    await this.serialize(async () => {
      const now = this.now();
      let changed = this.reconcileWalRunSummaries();
      for (const automation of this.data.automations) {
        if (!automation.enabled || !automation.nextRunAt) continue;
        const scheduledFor = Date.parse(automation.nextRunAt);
        if (!Number.isFinite(scheduledFor) || scheduledFor > now) continue;
        changed = true;
        const durableOccurrence = this.dispatchWal.findScheduledOccurrence(
          automation.id,
          automation.nextRunAt,
        );
        if (durableOccurrence) {
          this.applyWalRecordToRun(durableOccurrence);
          automation.lastRunAt = durableOccurrence.createdAt;
          this.advanceSchedule(automation, now);
          continue;
        }
        if (automation.missedRunPolicy === 'skip') {
          this.recordSkippedRun(automation, scheduledFor, 'missed-run-policy');
          this.advanceSchedule(automation, now);
          continue;
        }
        await this.executeAutomation(
          automation,
          scheduledFor,
          'startup-reconcile',
        );
      }
      if (changed) await this.persistence.save(this.data);
    });
  }

  private async handleResume(): Promise<void> {
    if (this.shuttingDown || !this.options.isFeatureEnabled()) return;
    await this.processDue('system-resumed');
  }

  private scheduleNextTimer(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.shuttingDown || !this.options.isFeatureEnabled()) return;

    const now = this.now();
    const dueTimes = this.data.automations
      .filter((automation) => automation.enabled && automation.nextRunAt)
      .map((automation) => Date.parse(automation.nextRunAt ?? ''))
      .filter(Number.isFinite);
    if (dueTimes.length === 0) return;

    const delay = Math.max(
      0,
      Math.min(Math.min(...dueTimes) - now, MAX_TIMER_DELAY_MS),
    );
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.processDue('timer');
    }, delay);
  }

  private async processDue(reason: 'timer' | 'system-resumed'): Promise<void> {
    if (this.shuttingDown || !this.options.isFeatureEnabled()) return;
    await this.serialize(async () => {
      const now = this.now();
      const due = this.data.automations.filter(
        (automation) =>
          automation.enabled &&
          automation.nextRunAt !== null &&
          Date.parse(automation.nextRunAt) <= now,
      );
      for (const automation of due) {
        const scheduledFor = Date.parse(automation.nextRunAt ?? '');
        if (
          reason === 'system-resumed' &&
          automation.missedRunPolicy === 'skip'
        ) {
          this.recordSkippedRun(
            automation,
            scheduledFor,
            'missed-after-resume',
          );
          this.advanceSchedule(automation, now);
          continue;
        }
        await this.executeAutomation(automation, scheduledFor, reason);
      }
      if (due.length > 0) await this.persistence.save(this.data);
      this.scheduleNextTimer();
      await this.syncNativeWake();
    });
  }

  private async executeAutomation(
    automation: AutomationDefinition,
    scheduledFor: number,
    trigger: AutomationDispatchTrigger,
    advanceSchedule = true,
    manualRunOptions?: AutomationManualRunOptions,
  ): Promise<void> {
    const scheduledForIso = new Date(scheduledFor).toISOString();
    if (advanceSchedule) {
      const durableOccurrence = this.dispatchWal.findScheduledOccurrence(
        automation.id,
        scheduledForIso,
      );
      if (durableOccurrence) {
        this.applyWalRecordToRun(durableOccurrence);
        automation.lastRunAt = durableOccurrence.createdAt;
        this.advanceSchedule(automation, this.now());
        return;
      }
    }
    if (this.runningAutomationIds.has(automation.id)) {
      this.recordSkippedRun(automation, scheduledFor, 'already-running');
      if (advanceSchedule) this.advanceSchedule(automation, this.now());
      return;
    }
    this.runningAutomationIds.add(automation.id);

    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      scheduledFor: scheduledForIso,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      status: 'running',
      attemptCount: 1,
      agentId: null,
      reason: null,
    };
    this.unshiftRun(run);

    let propagateFailure = false;
    let propagatedError: unknown;
    let prepared = false;
    let adapterEntered = false;
    let finalDispatchInvoked = false;
    let finalDispatchPassed = false;
    try {
      const dispatchAutomation = structuredClone(automation);
      const dispatchInput: AutomationDispatchInput = {
        automation: dispatchAutomation,
        prompt: dispatchAutomation.prompt,
      };
      const commitments = createAutomationDispatchCommitments({
        runId: run.id,
        trigger,
        scheduledFor: scheduledForIso,
        automation: dispatchInput.automation,
        prompt: dispatchInput.prompt,
      });
      const preparation: AutomationDispatchPreparation = {
        runId: run.id,
        automationId: dispatchAutomation.id,
        trigger,
        scheduledFor: scheduledForIso,
        attempt: 1,
        ...commitments,
      };
      await this.dispatchWal.prepare(preparation);
      prepared = true;

      // The UI run record is made durable after PREPARED and before the
      // adapter can enter DISPATCHING. A crash in either window is recovered
      // from the WAL and the occurrence is never replayed.
      await this.persistence.save(this.data);
      await this.dispatchWal.beginDispatch(preparation);

      dispatchInput.beforeDispatch = () => {
        if (finalDispatchInvoked) {
          throw new Error(
            'Automation final dispatch fence was already consumed',
          );
        }
        finalDispatchInvoked = true;
        this.assertEnabled();
        const finalCommitments = createAutomationDispatchCommitments({
          runId: run.id,
          trigger,
          scheduledFor: scheduledForIso,
          automation: dispatchInput.automation,
          prompt: dispatchInput.prompt,
        });
        if (
          finalCommitments.definitionHash !== preparation.definitionHash ||
          finalCommitments.occurrenceHash !== preparation.occurrenceHash ||
          finalCommitments.attemptHash !== preparation.attemptHash
        ) {
          throw new Error(
            'Automation definition or attempt changed before final dispatch',
          );
        }
        this.assertGrantAllowsMode(dispatchInput.automation);
        manualRunOptions?.beforeDispatch?.({
          automation: dispatchInput.automation,
          prompt: dispatchInput.prompt,
          attempt: 1,
        });
        finalDispatchPassed = true;
      };

      deepFreeze(dispatchInput);
      adapterEntered = true;
      const result = await this.options.dispatch(dispatchInput);
      if (!finalDispatchPassed) {
        throw new Error(
          'Automation adapter returned without enforcing the final dispatch fence',
        );
      }
      if (typeof result.agentId !== 'string' || result.agentId.length === 0) {
        throw new Error('Automation adapter returned no agent identifier');
      }
      await this.dispatchWal.markSucceeded(run.id, {
        agentId: result.agentId,
      });
      run.agentId = result.agentId;
      run.status = 'succeeded';
    } catch (error) {
      const diagnostic = this.errorDiagnostic(error);
      const failedAtFinalFence =
        adapterEntered && finalDispatchInvoked && !finalDispatchPassed;
      const uncertain = adapterEntered && !failedAtFinalFence;
      if (prepared) {
        try {
          if (uncertain) {
            await this.dispatchWal.markUncertain(run.id, diagnostic);
          } else {
            await this.dispatchWal.markFailedPreEffect(run.id, diagnostic);
          }
        } catch (walError) {
          this.options.logger.error(
            '[AutomationService] Failed to close automation dispatch WAL record',
            walError,
          );
        }
      }
      run.status = uncertain ? 'uncertain' : 'failed';
      run.reason = uncertain
        ? `UNCERTAIN: ${diagnostic}`
        : `FAILED_PRE_EFFECT: ${diagnostic}`;
      this.options.notifications.showNotification({
        title: `Automation failed: ${automation.title}`,
        message: run.reason,
        type: 'error',
        duration: 12_000,
        actions: [],
      });
      if (manualRunOptions?.failureMode === 'propagate') {
        propagateFailure = true;
        propagatedError = error;
      }
    } finally {
      run.finishedAt = new Date(this.now()).toISOString();
      automation.lastRunAt = run.startedAt;
      if (advanceSchedule) this.advanceSchedule(automation, this.now());
      this.runningAutomationIds.delete(automation.id);
    }
    if (propagateFailure) throw propagatedError;
  }

  private reconcileWalRunSummaries(): boolean {
    const walByRunId = new Map(
      this.dispatchWal.list().map((record) => [record.runId, record]),
    );
    let changed = false;
    for (const run of this.data.runs) {
      const record = walByRunId.get(run.id);
      if (record) {
        this.applyWalRecordToRun(record);
        changed = true;
      } else if (run.status === 'running') {
        run.status = 'failed';
        run.finishedAt = new Date(this.now()).toISOString();
        run.reason =
          'FAILED_PRE_EFFECT: Process stopped before durable dispatch preparation; no effect was replayed';
        changed = true;
      }
    }
    return changed;
  }

  private applyWalRecordToRun(record: AutomationDispatchWalRecord): void {
    let run = this.data.runs.find((candidate) => candidate.id === record.runId);
    if (!run) {
      run = {
        id: record.runId,
        automationId: record.automationId,
        scheduledFor: record.scheduledFor,
        startedAt: record.createdAt,
        finishedAt: null,
        status: 'running',
        attemptCount: 1,
        agentId: null,
        reason: null,
      };
      this.unshiftRun(run);
    }
    run.attemptCount = 1;
    run.finishedAt = record.terminalAt ?? record.updatedAt;
    if (record.state === 'SUCCEEDED') {
      run.status = 'succeeded';
      run.reason = null;
      return;
    }
    const diagnostic =
      record.error ?? 'Automation dispatch outcome unavailable';
    if (record.state === 'FAILED_PRE_EFFECT') {
      run.status = 'failed';
      run.reason = `FAILED_PRE_EFFECT: ${diagnostic}`;
      return;
    }
    run.status = 'uncertain';
    run.reason = `UNCERTAIN: ${diagnostic}`;
  }

  private errorDiagnostic(error: unknown): string {
    let message: string;
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      message = 'Automation dispatch failed with an unreadable error';
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these exact ASCII controls are intentionally removed from persisted error summaries.
    const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return (normalized || 'Automation dispatch failed').slice(0, 500);
  }

  private assertGrantAllowsMode(automation: AutomationDefinition): void {
    if (automation.approvalMode !== 'alwaysAllow') return;
    if (automation.grant.capabilities.length === 0) {
      throw new Error(
        'Unattended alwaysAllow automation requires an explicit capability grant',
      );
    }
    if (
      automation.grant.expiresAt &&
      Date.parse(automation.grant.expiresAt) <= this.now()
    ) {
      throw new Error('Automation capability grant has expired');
    }
  }

  private advanceSchedule(
    automation: AutomationDefinition,
    afterMs: number,
  ): void {
    if (automation.schedule.kind === 'once') {
      automation.enabled = false;
      automation.nextRunAt = null;
    } else {
      automation.nextRunAt = this.toIso(
        getNextAutomationRunAt(automation.schedule, afterMs),
      );
    }
    automation.updatedAt = new Date(this.now()).toISOString();
  }

  private recordSkippedRun(
    automation: AutomationDefinition,
    scheduledFor: number,
    reason: string,
  ): void {
    const timestamp = new Date(this.now()).toISOString();
    this.unshiftRun({
      id: randomUUID(),
      automationId: automation.id,
      scheduledFor: new Date(scheduledFor).toISOString(),
      startedAt: timestamp,
      finishedAt: timestamp,
      status: 'skipped',
      attemptCount: 0,
      agentId: null,
      reason,
    });
  }

  private unshiftRun(run: AutomationRun): void {
    this.data.runs.unshift(run);
    this.data.runs = this.data.runs.slice(0, MAX_RECENT_RUNS);
  }

  private findAutomationIndex(id: string): number {
    const index = this.data.automations.findIndex(
      (automation) => automation.id === id,
    );
    if (index < 0) throw new Error('Automation not found');
    return index;
  }

  private getAutomation(id: string): AutomationDefinition {
    const automation = this.data.automations[this.findAutomationIndex(id)];
    if (!automation) throw new Error('Automation not found');
    return automation;
  }

  private result(ok: boolean, message: string): AutomationOperationResult {
    return { ok, message, snapshot: this.getSnapshot() };
  }

  private toIso(timestamp: number | null): string | null {
    return timestamp === null ? null : new Date(timestamp).toISOString();
  }

  private async persistAndReschedule(): Promise<void> {
    await this.persistence.save(this.data);
    this.scheduleNextTimer();
    await this.syncNativeWake();
  }

  private async syncNativeWake(): Promise<void> {
    const scheduler = this.options.nativeWakeScheduler;
    if (!scheduler) return;
    const nextWakeAt = this.getSnapshot().nextWakeAt;
    await scheduler.sync(nextWakeAt);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  protected async onTeardown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.removeWakeListener?.();
    this.removeWakeListener = null;
    for (const procedure of PROCEDURES) {
      this.options.karton.removeServerProcedureHandler(procedure);
    }
    await this.mutation;
    await this.dispatchWal.flush();
  }
}

export function createAutomationAgentMessage(
  automation: AutomationDefinition,
): AgentMessage & { role: 'user' } {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: automation.prompt }],
    metadata: {
      createdAt: new Date(),
      partsMetadata: [],
      swarmMode: false,
      executionTarget: automation.executionTarget,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const field of Object.values(value)) deepFreeze(field);
  Object.freeze(value);
  return value;
}
