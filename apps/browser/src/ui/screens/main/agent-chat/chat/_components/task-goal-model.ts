import type { TaskGoal } from '@shared/karton-contracts/ui/agent';

export const TASK_GOAL_NEAR_BUDGET_RATIO = 0.8;

export type TaskGoalBudgetPressure = 'none' | 'normal' | 'near' | 'exceeded';

export type TaskGoalMetrics = {
  tokensUsed: number;
  tokenRatio: number | null;
  elapsedSeconds: number;
  timeRatio: number | null;
  pressure: TaskGoalBudgetPressure;
};

function budgetRatio(used: number, budget: number | null | undefined) {
  if (!budget || budget <= 0) return null;
  return Math.max(0, used / budget);
}

export function getTaskGoalElapsedMs(goal: TaskGoal, now: number): number {
  const accumulated = Math.max(0, goal.accumulatedActiveMs ?? 0);
  if (goal.status !== 'active' || goal.activeStartedAt == null) {
    return accumulated;
  }
  return accumulated + Math.max(0, now - goal.activeStartedAt);
}

export function getTaskGoalMetrics(
  goal: TaskGoal,
  usedTokens: number,
  now = Date.now(),
): TaskGoalMetrics {
  const tokensUsed = Math.max(0, usedTokens - goal.startedUsedTokens);
  const elapsedSeconds = Math.floor(getTaskGoalElapsedMs(goal, now) / 1_000);
  const tokenRatio = budgetRatio(tokensUsed, goal.tokenBudget);
  const timeRatio = budgetRatio(elapsedSeconds, goal.timeBudgetSeconds);
  const highestRatio = Math.max(tokenRatio ?? 0, timeRatio ?? 0);
  const hasBudget = tokenRatio !== null || timeRatio !== null;

  return {
    tokensUsed,
    tokenRatio,
    elapsedSeconds,
    timeRatio,
    pressure: !hasBudget
      ? 'none'
      : highestRatio >= 1
        ? 'exceeded'
        : highestRatio >= TASK_GOAL_NEAR_BUDGET_RATIO
          ? 'near'
          : 'normal',
  };
}

export function formatGoalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}
