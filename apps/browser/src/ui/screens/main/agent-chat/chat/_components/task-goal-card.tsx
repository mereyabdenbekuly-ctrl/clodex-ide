import { Button } from '@clodex/stage-ui/components/button';
import type {
  TaskGoal,
  TaskGoalStatus,
} from '@shared/karton-contracts/ui/agent';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import {
  BanIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleSlash2Icon,
  Clock3Icon,
  FlagIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatGoalDuration, getTaskGoalMetrics } from './task-goal-model';

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function statusLabel(status: TaskGoalStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'completed':
      return 'Completed';
    case 'blocked':
      return 'Blocked';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function TaskGoalCard({ agentId }: { agentId: string }) {
  const state = useKartonState(
    (snapshot) => snapshot.agents.instances[agentId]?.state,
  );
  const goal = state?.goal ?? null;
  const usedTokens = state?.usedTokens ?? 0;
  const isWorking = state?.isWorking ?? false;
  const setGoal = useKartonProcedure((procedures) => procedures.agents.setGoal);
  const setGoalStatus = useKartonProcedure(
    (procedures) => procedures.agents.setGoalStatus,
  );
  const clearGoal = useKartonProcedure(
    (procedures) => procedures.agents.clearGoal,
  );

  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');
  const [timeBudgetMinutes, setTimeBudgetMinutes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!goal || goal.status !== 'active') return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [goal]);

  const metrics = useMemo(
    () => (goal ? getTaskGoalMetrics(goal, usedTokens, now) : null),
    [goal, now, usedTokens],
  );
  const tokenProgress = Math.min(100, (metrics?.tokenRatio ?? 0) * 100);
  const timeProgress = Math.min(100, (metrics?.timeRatio ?? 0) * 100);

  const beginEditing = useCallback((current?: TaskGoal | null) => {
    setObjective(current?.objective ?? '');
    setTokenBudget(current?.tokenBudget ? String(current.tokenBudget) : '');
    setTimeBudgetMinutes(
      current?.timeBudgetSeconds
        ? String(Math.ceil(current.timeBudgetSeconds / 60))
        : '',
    );
    setError(null);
    setEditing(true);
  }, []);

  const save = useCallback(async () => {
    const normalizedObjective = objective.trim();
    if (!normalizedObjective || pending) return;
    const normalizedBudget = tokenBudget.trim();
    const parsedBudget = normalizedBudget
      ? Number.parseInt(normalizedBudget, 10)
      : null;
    const normalizedTimeBudget = timeBudgetMinutes.trim();
    const parsedTimeBudgetMinutes = normalizedTimeBudget
      ? Number.parseInt(normalizedTimeBudget, 10)
      : null;
    if (
      parsedBudget !== null &&
      (!Number.isInteger(parsedBudget) || parsedBudget < 1)
    ) {
      setError('Token budget must be a positive whole number.');
      return;
    }
    if (
      parsedTimeBudgetMinutes !== null &&
      (!Number.isInteger(parsedTimeBudgetMinutes) ||
        parsedTimeBudgetMinutes < 1 ||
        parsedTimeBudgetMinutes > 525_600)
    ) {
      setError('Time budget must be between 1 minute and 365 days.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      await setGoal(
        agentId,
        normalizedObjective,
        parsedBudget,
        parsedTimeBudgetMinutes === null ? null : parsedTimeBudgetMinutes * 60,
      );
      setEditing(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The goal could not be saved.',
      );
    } finally {
      setPending(false);
    }
  }, [agentId, objective, pending, setGoal, timeBudgetMinutes, tokenBudget]);

  const updateStatus = useCallback(
    async (status: TaskGoalStatus) => {
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        await setGoalStatus(agentId, status);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'The goal status could not be updated.',
        );
      } finally {
        setPending(false);
      }
    },
    [agentId, pending, setGoalStatus],
  );

  const remove = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await clearGoal(agentId);
      setEditing(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The goal could not be removed.',
      );
    } finally {
      setPending(false);
    }
  }, [agentId, clearGoal, pending]);

  const statusTone = useMemo(() => {
    switch (goal?.status) {
      case 'completed':
        return 'text-success-foreground bg-success-solid/10';
      case 'blocked':
        return 'text-warning-foreground bg-warning-solid/10';
      case 'cancelled':
        return 'text-token-text-tertiary bg-token-bg-tertiary';
      default:
        return 'text-clodex-green-400 bg-clodex-green-400/10';
    }
  }, [goal?.status]);

  if (!goal && !editing) {
    return (
      <div className="px-3 pb-1">
        <Button
          variant="ghost"
          size="xs"
          className="h-7 rounded-lg text-token-text-tertiary"
          onClick={() => beginEditing(null)}
        >
          <FlagIcon className="size-3.5" />
          Set task goal
        </Button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="mx-2 mb-2 rounded-xl border border-token-border-light bg-token-bg-secondary/45 p-3 shadow-codex-hairline">
        <div className="flex items-center gap-2 font-medium text-sm text-token-text-primary">
          <FlagIcon className="size-3.5 text-clodex-green-400" />
          {goal ? 'Edit task goal' : 'Set task goal'}
        </div>
        <textarea
          aria-label="Task goal objective"
          placeholder="What outcome should this task achieve?"
          value={objective}
          maxLength={500}
          disabled={pending}
          className="mt-2 min-h-16 w-full resize-none rounded-lg border border-token-border-light bg-token-main-surface-primary px-3 py-2 text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary focus:border-token-border-default"
          onChange={(event) => setObjective(event.currentTarget.value)}
        />
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            type="number"
            min={1}
            max={10_000_000}
            step={1}
            aria-label="Goal token budget"
            placeholder="Token budget (optional)"
            value={tokenBudget}
            disabled={pending}
            className="h-8 min-w-0 flex-1 rounded-lg border border-token-border-light bg-token-main-surface-primary px-2.5 text-token-text-primary text-xs outline-none placeholder:text-token-text-tertiary focus:border-token-border-default"
            onChange={(event) => setTokenBudget(event.currentTarget.value)}
          />
          <input
            type="number"
            min={1}
            max={525_600}
            step={1}
            aria-label="Goal time budget in minutes"
            placeholder="Time budget in minutes (optional)"
            value={timeBudgetMinutes}
            disabled={pending}
            className="h-8 min-w-0 rounded-lg border border-token-border-light bg-token-main-surface-primary px-2.5 text-token-text-primary text-xs outline-none placeholder:text-token-text-tertiary focus:border-token-border-default"
            onChange={(event) =>
              setTimeBudgetMinutes(event.currentTarget.value)
            }
          />
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="xs"
            disabled={!objective.trim() || pending}
            onClick={() => void save()}
          >
            {pending && <LoaderCircleIcon className="size-3 animate-spin" />}
            Save
          </Button>
        </div>
        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-error-solid text-xs">
            <CircleAlertIcon className="size-3.5" />
            {error}
          </p>
        )}
      </div>
    );
  }

  if (!goal) return null;

  return (
    <div className="mx-2 mb-2 rounded-xl border border-token-border-light bg-token-bg-secondary/35 px-3 py-2.5 shadow-codex-hairline">
      <div className="flex items-start gap-2">
        <FlagIcon className="mt-0.5 size-3.5 shrink-0 text-clodex-green-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="line-clamp-2 text-sm text-token-text-primary leading-5">
              {goal.objective}
            </p>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 font-medium text-[10px] uppercase tracking-[0.06em]',
                statusTone,
              )}
            >
              {statusLabel(goal.status)}
            </span>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {goal.tokenBudget ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-token-bg-tertiary">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width]',
                      tokenProgress >= 100
                        ? 'bg-error-solid'
                        : tokenProgress >= 80
                          ? 'bg-warning-solid'
                          : 'bg-clodex-green-400',
                    )}
                    style={{ width: `${tokenProgress}%` }}
                  />
                </div>
                <span className="shrink-0 text-[11px] text-token-text-tertiary">
                  {formatTokens(metrics?.tokensUsed ?? 0)} /{' '}
                  {formatTokens(goal.tokenBudget)} tokens
                </span>
              </div>
            ) : (
              <span className="text-[11px] text-token-text-tertiary">
                {formatTokens(metrics?.tokensUsed ?? 0)} tokens used toward this
                goal
              </span>
            )}
            <div className="flex items-center gap-2 text-[11px] text-token-text-tertiary">
              <Clock3Icon className="size-3 shrink-0" />
              {goal.timeBudgetSeconds ? (
                <>
                  <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-token-bg-tertiary">
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width]',
                        timeProgress >= 100
                          ? 'bg-error-solid'
                          : timeProgress >= 80
                            ? 'bg-warning-solid'
                            : 'bg-clodex-green-400',
                      )}
                      style={{ width: `${timeProgress}%` }}
                    />
                  </div>
                  <span className="shrink-0">
                    {formatGoalDuration(metrics?.elapsedSeconds ?? 0)} /{' '}
                    {formatGoalDuration(goal.timeBudgetSeconds)}
                  </span>
                </>
              ) : (
                <span>
                  {formatGoalDuration(metrics?.elapsedSeconds ?? 0)} active time
                </span>
              )}
            </div>
          </div>
          {metrics?.pressure === 'near' && (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 flex items-center gap-1.5 text-warning-foreground text-xs"
            >
              <CircleAlertIcon className="size-3.5" />
              This goal is approaching its token or time budget.
            </p>
          )}
          {metrics?.pressure === 'exceeded' && (
            <p
              role="alert"
              className="mt-2 flex items-center gap-1.5 text-error-solid text-xs"
            >
              <CircleAlertIcon className="size-3.5" />
              This goal has exceeded its token or time budget.
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
        {goal.status !== 'active' && (
          <Button
            variant="ghost"
            size="xs"
            disabled={pending || isWorking}
            onClick={() => void updateStatus('active')}
          >
            <PlayIcon className="size-3" />
            Reopen
          </Button>
        )}
        {goal.status === 'active' && (
          <>
            <Button
              variant="ghost"
              size="xs"
              disabled={pending || isWorking}
              onClick={() => void updateStatus('blocked')}
            >
              <BanIcon className="size-3" />
              Blocked
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={pending || isWorking}
              onClick={() => void updateStatus('completed')}
            >
              <CheckIcon className="size-3" />
              Complete
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={pending || isWorking}
              onClick={() => void updateStatus('cancelled')}
            >
              <CircleSlash2Icon className="size-3" />
              Cancel
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Edit task goal"
          title="Edit task goal"
          disabled={pending || isWorking}
          onClick={() => beginEditing(goal)}
        >
          <PencilIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Remove task goal"
          title="Remove task goal"
          disabled={pending || isWorking}
          onClick={() => void remove()}
        >
          <Trash2Icon className="size-3" />
        </Button>
      </div>
      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-error-solid text-xs">
          <CircleAlertIcon className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
