import type { AgentStore } from '../../../store/agent-store';
import type {
  AgentState,
  TaskGoal,
  TaskGoalStatus,
} from '../../../types/agent';
import { updateAgentInstanceState } from './internal';

/**
 * Bucket A — trivial single-field setters. Each wraps exactly one
 * `store.update()` and is a defensive no-op on missing agent ids. Kept
 * inside the `state-mutations/` folder so every per-instance write
 * lives behind the same surface as the more complex transforms.
 */

export function setTitle(
  store: AgentStore,
  agentInstanceId: string,
  args: { title: string },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.title = args.title;
  });
}

export function setUserTitle(
  store: AgentStore,
  agentInstanceId: string,
  args: { title: string },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.title = args.title;
    state.titleLockedByUser = true;
  });
}

export function setInputState(
  store: AgentStore,
  agentInstanceId: string,
  args: { inputState: string },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.inputState = args.inputState;
  });
}

export function setActiveModel(
  store: AgentStore,
  agentInstanceId: string,
  args: { modelId: AgentState['activeModelId'] },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.activeModelId = args.modelId;
  });
}

export function setIsWorkingFalse(
  store: AgentStore,
  agentInstanceId: string,
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.isWorking = false;
  });
}

export function setUsageWarning(
  store: AgentStore,
  agentInstanceId: string,
  args: {
    warning:
      | { windowType: string; usedPercent: number; resetsAt: string }
      | undefined;
  },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.usageWarning = args.warning;
  });
}

export function recordUsage(
  store: AgentStore,
  agentInstanceId: string,
  args: { totalTokens: number },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.usedTokens = args.totalTokens;
  });
}

export function setTaskGoal(
  store: AgentStore,
  agentInstanceId: string,
  args: { goal: TaskGoal },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.goal = args.goal;
  });
}

export function setTaskGoalStatus(
  store: AgentStore,
  agentInstanceId: string,
  args: { status: TaskGoalStatus; updatedAt: number },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    if (!state.goal) return;
    const wasActive = state.goal.status === 'active';
    const willBeActive = args.status === 'active';
    const accumulatedActiveMs = Math.max(
      0,
      state.goal.accumulatedActiveMs ?? 0,
    );

    if (wasActive && !willBeActive) {
      const activeStartedAt = state.goal.activeStartedAt ?? args.updatedAt;
      state.goal.accumulatedActiveMs =
        accumulatedActiveMs + Math.max(0, args.updatedAt - activeStartedAt);
      state.goal.activeStartedAt = null;
    } else if (!wasActive && willBeActive) {
      state.goal.accumulatedActiveMs = accumulatedActiveMs;
      state.goal.activeStartedAt = args.updatedAt;
    }

    state.goal.status = args.status;
    state.goal.updatedAt = args.updatedAt;
  });
}

export function clearTaskGoal(
  store: AgentStore,
  agentInstanceId: string,
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.goal = null;
  });
}
