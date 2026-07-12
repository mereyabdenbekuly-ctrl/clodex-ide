import { describe, expect, it } from 'vitest';
import type { TaskGoal } from '@shared/karton-contracts/ui/agent';
import {
  formatGoalDuration,
  getTaskGoalElapsedMs,
  getTaskGoalMetrics,
} from './task-goal-model';

function goal(overrides: Partial<TaskGoal> = {}): TaskGoal {
  return {
    objective: 'Ship the release',
    status: 'active',
    tokenBudget: 1_000,
    timeBudgetSeconds: 100,
    startedUsedTokens: 100,
    accumulatedActiveMs: 5_000,
    activeStartedAt: 10_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('task goal metrics', () => {
  it('combines accumulated and current active time', () => {
    expect(getTaskGoalElapsedMs(goal(), 25_000)).toBe(20_000);
  });

  it('does not advance a paused goal', () => {
    expect(
      getTaskGoalElapsedMs(
        goal({
          status: 'blocked',
          accumulatedActiveMs: 42_000,
          activeStartedAt: null,
        }),
        100_000,
      ),
    ).toBe(42_000);
  });

  it('reports near and exceeded pressure across both budgets', () => {
    expect(getTaskGoalMetrics(goal(), 900, 25_000).pressure).toBe('near');
    expect(getTaskGoalMetrics(goal(), 1_101, 25_000).pressure).toBe('exceeded');
    expect(
      getTaskGoalMetrics(goal({ tokenBudget: null }), 100, 111_000).pressure,
    ).toBe('exceeded');
  });

  it('supports legacy goals without time-tracking fields', () => {
    const metrics = getTaskGoalMetrics(
      goal({
        timeBudgetSeconds: undefined,
        accumulatedActiveMs: undefined,
        activeStartedAt: undefined,
      }),
      200,
      50_000,
    );
    expect(metrics.elapsedSeconds).toBe(0);
    expect(metrics.timeRatio).toBeNull();
  });

  it('formats compact elapsed durations', () => {
    expect(formatGoalDuration(59)).toBe('59s');
    expect(formatGoalDuration(90)).toBe('1m');
    expect(formatGoalDuration(3_900)).toBe('1h 5m');
    expect(formatGoalDuration(90_000)).toBe('1d 1h');
  });
});
