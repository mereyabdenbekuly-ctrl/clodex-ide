import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../host/logger';
import type { EvidenceMemoryEvent } from './index';
import { EvidenceMemorySummaryScheduler } from './summary-scheduler';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const event = (taskId: string): EvidenceMemoryEvent => ({
  id: `event-${taskId}`,
  taskId,
  workspaceId: null,
  type: 'tool_completed',
  timestamp: 1,
  messageId: null,
  repositoryRevision: null,
  source: null,
  sourceIdHash: null,
  ingestionKeyHash: null,
  payloadHash: 'hash',
  contentHash: null,
  payload: {},
  createdAt: 1,
});

describe('EvidenceMemorySummaryScheduler', () => {
  it('collapses event bursts and processes tasks in bounded single-flight passes', async () => {
    let observer: ((event: EvidenceMemoryEvent) => void) | undefined;
    const materializeRecursiveSummaries = vi.fn(async ({ taskId }) => ({
      taskId,
      shortCreated: 1,
      longCreated: 0,
      summaries: [],
    }));
    const scheduler = await EvidenceMemorySummaryScheduler.create({
      evidenceMemory: {
        listTaskIds: async () => ['startup-task'],
        subscribeToEvents: (listener) => {
          observer = listener;
          return () => {
            observer = undefined;
          };
        },
        materializeRecursiveSummaries,
      },
      logger,
      autoStart: false,
      maxTasksPerPass: 2,
    });

    observer?.(event('burst-task'));
    observer?.(event('burst-task'));
    const run = await scheduler.runNow();

    expect(run).toMatchObject({
      attemptedTasks: 2,
      completedTasks: 2,
      shortCreated: 2,
      failedTasks: 0,
    });
    expect(materializeRecursiveSummaries).toHaveBeenCalledTimes(2);
    expect(scheduler.getSnapshot()).toMatchObject({
      running: false,
      pendingTasks: 0,
      droppedTasks: 0,
      lastRun: { attemptedTasks: 2, completedTasks: 2 },
    });
    await scheduler.teardown();
    expect(observer).toBeUndefined();
  });

  it('applies pending-task backpressure without throwing', async () => {
    const scheduler = await EvidenceMemorySummaryScheduler.create({
      evidenceMemory: {
        listTaskIds: async () => [],
        subscribeToEvents: () => () => {},
        materializeRecursiveSummaries: async ({ taskId }) => ({
          taskId,
          shortCreated: 0,
          longCreated: 0,
          summaries: [],
        }),
      },
      logger,
      autoStart: false,
      maxPendingTasks: 1,
    });

    expect(scheduler.enqueue('first')).toBe(true);
    expect(scheduler.enqueue('second')).toBe(false);
    await expect(scheduler.runNow()).resolves.toMatchObject({
      attemptedTasks: 1,
      droppedTasks: 1,
    });
    await scheduler.teardown();
  });

  it('requeues failed tasks with bounded exponential backoff', async () => {
    let now = 1_000;
    const materializeRecursiveSummaries = vi
      .fn()
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValue({
        taskId: 'retry-task',
        shortCreated: 0,
        longCreated: 0,
        summaries: [],
      });
    const scheduler = await EvidenceMemorySummaryScheduler.create({
      evidenceMemory: {
        listTaskIds: async () => ['retry-task'],
        subscribeToEvents: () => () => {},
        materializeRecursiveSummaries,
      },
      logger,
      autoStart: false,
      now: () => now,
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    await expect(scheduler.runNow()).resolves.toMatchObject({
      failedTasks: 1,
      pendingTasks: 1,
      backingOffTasks: 1,
    });
    await expect(scheduler.runNow()).resolves.toMatchObject({
      attemptedTasks: 0,
      pendingTasks: 1,
    });
    now += 100;
    await expect(scheduler.runNow()).resolves.toMatchObject({
      completedTasks: 1,
      backingOffTasks: 0,
    });
    await scheduler.teardown();
  });
});
