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
  /** Artifact Bridge must use no-blind-retry for effects with ambiguous errors. */
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
  wakeSource?: AutomationWakeSource;
  nativeWakeScheduler?: AutomationNativeWakeScheduler;
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => AutomationTimerHandle;
  clearTimer?: (timer: AutomationTimerHandle) => void;
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
  private readonly now: () => number;
  private readonly setTimer: NonNullable<AutomationServiceOptions['setTimer']>;
  private readonly clearTimer: NonNullable<
    AutomationServiceOptions['clearTimer']
  >;
  private readonly sleep: NonNullable<AutomationServiceOptions['sleep']>;
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
    this.sleep =
      options.sleep ??
      (async (delayMs) => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      });
  }

  public static async create(
    options: AutomationServiceOptions,
  ): Promise<AutomationService> {
    const service = new AutomationService(options);
    service.data = automationStoreSchema.parse(
      await service.persistence.load(),
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
      retryMode: options.retryMode ?? 'configured',
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
      let changed = false;
      for (const automation of this.data.automations) {
        if (!automation.enabled || !automation.nextRunAt) continue;
        const scheduledFor = Date.parse(automation.nextRunAt);
        if (!Number.isFinite(scheduledFor) || scheduledFor > now) continue;
        changed = true;
        if (automation.missedRunPolicy === 'skip') {
          this.recordSkippedRun(automation, scheduledFor, 'missed-run-policy');
          this.advanceSchedule(automation, now);
          continue;
        }
        await this.executeAutomation(automation, scheduledFor);
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
        await this.executeAutomation(automation, scheduledFor);
      }
      if (due.length > 0) await this.persistence.save(this.data);
      this.scheduleNextTimer();
      await this.syncNativeWake();
    });
  }

  private async executeAutomation(
    automation: AutomationDefinition,
    scheduledFor: number,
    advanceSchedule = true,
    manualRunOptions?: AutomationManualRunOptions,
  ): Promise<void> {
    if (this.runningAutomationIds.has(automation.id)) {
      this.recordSkippedRun(automation, scheduledFor, 'already-running');
      if (advanceSchedule) this.advanceSchedule(automation, this.now());
      return;
    }
    this.assertGrantAllowsMode(automation);
    this.runningAutomationIds.add(automation.id);

    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      scheduledFor: new Date(scheduledFor).toISOString(),
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      status: 'running',
      attemptCount: 0,
      agentId: null,
      reason: null,
    };
    this.unshiftRun(run);

    let propagateFailure = false;
    let propagatedError: unknown;
    try {
      let lastError: unknown;
      let succeeded = false;
      const maxAttempts =
        manualRunOptions?.retryMode === 'no-blind-retry'
          ? 1
          : automation.retryPolicy.maxAttempts;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        run.attemptCount = attempt;
        try {
          let finalDispatchPassed = false;
          const dispatchAutomation = structuredClone(automation);
          const dispatchInput: AutomationDispatchInput = {
            automation: dispatchAutomation,
            prompt: automation.prompt,
            beforeDispatch: () => {
              if (finalDispatchPassed) {
                throw new Error(
                  'Automation final dispatch fence was already consumed',
                );
              }
              this.assertEnabled();
              manualRunOptions?.beforeDispatch?.({
                automation: dispatchAutomation,
                prompt: automation.prompt,
                attempt,
              });
              finalDispatchPassed = true;
            },
          };
          const result = await this.options.dispatch(dispatchInput);
          if (!finalDispatchPassed) {
            throw new Error(
              'Automation adapter did not enforce the final dispatch fence',
            );
          }
          run.agentId = result.agentId;
          run.status = 'succeeded';
          succeeded = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts) break;
          const delay = Math.min(
            automation.retryPolicy.initialBackoffMs * 2 ** (attempt - 1),
            automation.retryPolicy.maxBackoffMs,
          );
          await this.sleep(delay);
        }
      }
      if (!succeeded) {
        run.status = 'failed';
        run.reason =
          lastError instanceof Error ? lastError.message : String(lastError);
        this.options.notifications.showNotification({
          title: `Automation failed: ${automation.title}`,
          message: run.reason,
          type: 'error',
          duration: 12_000,
          actions: [],
        });
        if (manualRunOptions?.failureMode === 'propagate') {
          propagateFailure = true;
          propagatedError = lastError;
        }
      }
    } finally {
      run.finishedAt = new Date(this.now()).toISOString();
      automation.lastRunAt = run.startedAt;
      if (advanceSchedule) this.advanceSchedule(automation, this.now());
      this.runningAutomationIds.delete(automation.id);
    }
    if (propagateFailure) throw propagatedError;
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
