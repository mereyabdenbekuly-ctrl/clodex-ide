import type { Logger } from '../../host/logger';
import { DisposableService } from '../shared/disposable';
import type {
  EvidenceMemoryEvent,
  EvidenceMemoryService,
  MaterializeEvidenceMemorySummariesResult,
} from './index';
import type { EvidenceMemorySummarizer } from './recursive-summarizer';

export const DEFAULT_EVIDENCE_MEMORY_SUMMARY_INTERVAL_MS = 60_000;
export const DEFAULT_EVIDENCE_MEMORY_SUMMARY_TASKS_PER_PASS = 25;
export const DEFAULT_EVIDENCE_MEMORY_SUMMARY_PENDING_TASKS = 1_000;
export const DEFAULT_EVIDENCE_MEMORY_SUMMARY_RETRY_BASE_MS = 30_000;
export const DEFAULT_EVIDENCE_MEMORY_SUMMARY_RETRY_MAX_MS = 15 * 60_000;

export interface EvidenceMemorySummarySchedulerOptions {
  evidenceMemory: Pick<
    EvidenceMemoryService,
    'listTaskIds' | 'materializeRecursiveSummaries' | 'subscribeToEvents'
  >;
  logger: Logger;
  summarize?: EvidenceMemorySummarizer;
  intervalMs?: number;
  maxTasksPerPass?: number;
  maxPendingTasks?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  autoStart?: boolean;
}

export interface EvidenceMemorySummarySchedulerRun {
  startedAt: number;
  completedAt: number;
  attemptedTasks: number;
  completedTasks: number;
  failedTasks: number;
  shortCreated: number;
  longCreated: number;
  pendingTasks: number;
  droppedTasks: number;
  backingOffTasks: number;
}

export interface EvidenceMemorySummarySchedulerSnapshot {
  running: boolean;
  intervalMs: number;
  maxTasksPerPass: number;
  maxPendingTasks: number;
  pendingTasks: number;
  backingOffTasks: number;
  droppedTasks: number;
  lastRun: EvidenceMemorySummarySchedulerRun | null;
}

/**
 * Single-flight background materializer. Event bursts collapse into one
 * pending task entry, and a bounded pass prevents summary work from starving
 * interactive agent execution.
 */
export class EvidenceMemorySummaryScheduler extends DisposableService {
  private readonly pendingTaskIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly intervalMs: number;
  private readonly maxTasksPerPass: number;
  private readonly maxPendingTasks: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeRun: Promise<EvidenceMemorySummarySchedulerRun> | undefined;
  private lastRun: EvidenceMemorySummarySchedulerRun | null = null;
  private droppedTasks = 0;
  private summarize: EvidenceMemorySummarizer | undefined;
  private readonly failureCountByTask = new Map<string, number>();
  private readonly retryAtByTask = new Map<string, number>();

  private constructor(
    private readonly options: EvidenceMemorySummarySchedulerOptions,
  ) {
    super();
    this.intervalMs = normalizePositiveInteger(
      options.intervalMs,
      DEFAULT_EVIDENCE_MEMORY_SUMMARY_INTERVAL_MS,
      'Summary scheduler interval',
    );
    this.maxTasksPerPass = normalizePositiveInteger(
      options.maxTasksPerPass,
      DEFAULT_EVIDENCE_MEMORY_SUMMARY_TASKS_PER_PASS,
      'Summary tasks per pass',
    );
    this.maxPendingTasks = normalizePositiveInteger(
      options.maxPendingTasks,
      DEFAULT_EVIDENCE_MEMORY_SUMMARY_PENDING_TASKS,
      'Summary pending task limit',
    );
    this.retryBaseMs = normalizePositiveInteger(
      options.retryBaseMs,
      DEFAULT_EVIDENCE_MEMORY_SUMMARY_RETRY_BASE_MS,
      'Summary retry base delay',
    );
    this.retryMaxMs = normalizePositiveInteger(
      options.retryMaxMs,
      DEFAULT_EVIDENCE_MEMORY_SUMMARY_RETRY_MAX_MS,
      'Summary retry maximum delay',
    );
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new Error(
        'Summary retry maximum delay must be at least the base delay',
      );
    }
    this.now = options.now ?? Date.now;
    this.summarize = options.summarize;
    this.unsubscribe = options.evidenceMemory.subscribeToEvents((event) =>
      this.observe(event),
    );
  }

  public static async create(
    options: EvidenceMemorySummarySchedulerOptions,
  ): Promise<EvidenceMemorySummaryScheduler> {
    const scheduler = new EvidenceMemorySummaryScheduler(options);
    for (const taskId of await options.evidenceMemory.listTaskIds()) {
      scheduler.enqueue(taskId);
    }
    if (options.autoStart !== false) scheduler.start();
    return scheduler;
  }

  public start(): void {
    this.assertNotDisposed();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runNow().catch((error) => {
        this.options.logger.warn(
          '[EvidenceMemory] Background summary pass failed',
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  public enqueue(taskId: string): boolean {
    this.assertNotDisposed();
    const normalized = taskId.trim();
    if (!normalized || this.pendingTaskIds.has(normalized)) return false;
    if (this.pendingTaskIds.size >= this.maxPendingTasks) {
      this.droppedTasks += 1;
      return false;
    }
    this.pendingTaskIds.add(normalized);
    return true;
  }

  public runNow(): Promise<EvidenceMemorySummarySchedulerRun> {
    this.assertNotDisposed();
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.runPass()
      .then((run) => {
        this.lastRun = run;
        return run;
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    return this.activeRun;
  }

  public getPendingTaskCount(): number {
    return this.pendingTaskIds.size;
  }

  public getSnapshot(): EvidenceMemorySummarySchedulerSnapshot {
    this.assertNotDisposed();
    return {
      running: this.activeRun !== undefined,
      intervalMs: this.intervalMs,
      maxTasksPerPass: this.maxTasksPerPass,
      maxPendingTasks: this.maxPendingTasks,
      pendingTasks: this.pendingTaskIds.size,
      backingOffTasks: this.retryAtByTask.size,
      droppedTasks: this.droppedTasks,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
    };
  }

  public setSummarizer(summarize: EvidenceMemorySummarizer | undefined): void {
    this.assertNotDisposed();
    this.summarize = summarize;
  }

  private observe(event: EvidenceMemoryEvent): void {
    if (
      event.type === 'memory_summary_materialized' ||
      event.type === 'memory_pruning_completed'
    ) {
      return;
    }
    this.enqueue(event.taskId);
  }

  private async runPass(): Promise<EvidenceMemorySummarySchedulerRun> {
    const startedAt = this.now();
    const taskIds = [...this.pendingTaskIds]
      .filter((taskId) => (this.retryAtByTask.get(taskId) ?? 0) <= startedAt)
      .slice(0, this.maxTasksPerPass);
    for (const taskId of taskIds) this.pendingTaskIds.delete(taskId);
    const results: MaterializeEvidenceMemorySummariesResult[] = [];
    let failedTasks = 0;
    for (const taskId of taskIds) {
      try {
        results.push(
          await this.options.evidenceMemory.materializeRecursiveSummaries({
            taskId,
            beforeOrAt: this.now(),
            summarize: this.summarize,
          }),
        );
        this.failureCountByTask.delete(taskId);
        this.retryAtByTask.delete(taskId);
      } catch (error) {
        failedTasks += 1;
        const failureCount = (this.failureCountByTask.get(taskId) ?? 0) + 1;
        this.failureCountByTask.set(taskId, failureCount);
        const retryDelay = Math.min(
          this.retryMaxMs,
          this.retryBaseMs * 2 ** Math.min(20, failureCount - 1),
        );
        this.retryAtByTask.set(taskId, this.now() + retryDelay);
        this.enqueue(taskId);
        this.options.logger.warn(
          `[EvidenceMemory] Summary materialization failed for task ${taskId}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return {
      startedAt,
      completedAt: this.now(),
      attemptedTasks: taskIds.length,
      completedTasks: results.length,
      failedTasks,
      shortCreated: results.reduce(
        (total, result) => total + result.shortCreated,
        0,
      ),
      longCreated: results.reduce(
        (total, result) => total + result.longCreated,
        0,
      ),
      pendingTasks: this.pendingTaskIds.size,
      droppedTasks: this.droppedTasks,
      backingOffTasks: this.retryAtByTask.size,
    };
  }

  protected async onTeardown(): Promise<void> {
    this.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeRun;
    this.pendingTaskIds.clear();
    this.failureCountByTask.clear();
    this.retryAtByTask.clear();
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return normalized;
}
