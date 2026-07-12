import { describe, expect, it, vi } from 'vitest';
import { BrowserSwarmStore, recomputeRunStatuses } from './index';
import type { AppState } from '@shared/karton-contracts/ui';
import type { KartonService } from '@/services/karton';
import type { SwarmPlan } from '@clodex/agent-core/swarm-orchestrator';

function createState(): Pick<AppState, 'swarmRuns'> {
  return { swarmRuns: {} };
}

function createKarton(state: Pick<AppState, 'swarmRuns'>): KartonService {
  return {
    setState: vi.fn((recipe: (draft: Pick<AppState, 'swarmRuns'>) => void) =>
      recipe(state),
    ),
  } as unknown as KartonService;
}

const plan: SwarmPlan = {
  task_complexity: 'medium',
  workflow: {
    description: 'Implement provider routing',
    phases: [
      {
        id: 'p1',
        title: 'Implementation',
        tasks: [
          {
            id: 'p1-t1',
            name: 'Coder',
            role: 'coder',
            prompt: 'Implement',
          },
        ],
      },
    ],
  },
};

describe('BrowserSwarmStore', () => {
  it('seeds a run from a swarm plan', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);

    expect(state.swarmRuns['run-1']).toMatchObject({
      id: 'run-1',
      agentInstanceId: 'agent-1',
      description: 'Implement provider routing',
      status: 'running',
    });
    expect(state.swarmRuns['run-1']?.phases[0]?.tasks[0]).toMatchObject({
      id: 'p1-t1',
      role: 'coder',
      modelTaskRole: 'coding',
      status: 'pending',
    });
  });

  it('applies task progress and completion events', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    store.applyEvent('agent-1', {
      type: 'task_started',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      taskName: 'Coder',
      role: 'coder',
      modelTaskRole: 'coding',
    });
    store.applyEvent('agent-1', {
      type: 'task_progress',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      metrics: { newTokens: 42, toolsUsed: 2 },
    });
    store.applyEvent('agent-1', {
      type: 'task_completed',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      result: {
        taskId: 'p1-t1',
        taskName: 'Coder',
        role: 'coder',
        modelTaskRole: 'coding',
        output: 'done',
      },
      sharedContext: '',
    });

    expect(state.swarmRuns['run-1']?.phases[0]?.tasks[0]).toMatchObject({
      status: 'completed',
      output: 'done',
      metrics: { tokens: 42, toolsUsed: 2 },
    });
  });

  it('stores task progress logs for sidebar diagnostics', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    store.applyEvent('agent-1', {
      type: 'task_progress',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      metrics: {
        log: {
          level: 'info',
          message: 'Tool started: searchProjectSymbols.',
          timestamp: 123,
        },
      },
    });

    expect(state.swarmRuns['run-1']?.phases[0]?.tasks[0]?.logs).toEqual([
      {
        level: 'info',
        message: 'Tool started: searchProjectSymbols.',
        timestamp: 123,
      },
    ]);
  });

  it('marks failed runs from workflow_failed events', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    store.applyEvent('agent-1', {
      type: 'workflow_failed',
      runId: 'run-1',
      error: new Error('boom'),
      partialResults: [],
      sharedContext: '',
    });

    expect(state.swarmRuns['run-1']).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
  });

  it('demotes phase and run to failed when one of its tasks fails', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    store.applyEvent('agent-1', {
      type: 'task_failed',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      error: new Error('task exploded'),
    });

    const run = state.swarmRuns['run-1'];
    expect(run?.phases[0]?.status).toBe('failed');
    // A failed task in a phase fails the whole phase, which fails the
    // whole run. The runner may still emit workflow_failed separately
    // for additional context, but the recompute reaches `failed` first.
    expect(run?.status).toBe('failed');
  });

  it('promotes phase and run to completed when all children finish', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    store.applyEvent('agent-1', {
      type: 'task_started',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      taskName: 'Coder',
      role: 'coder',
      modelTaskRole: 'coding',
    });
    store.applyEvent('agent-1', {
      type: 'task_completed',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      result: {
        taskId: 'p1-t1',
        taskName: 'Coder',
        role: 'coder',
        modelTaskRole: 'coding',
        output: 'done',
      },
      sharedContext: '',
    });

    const run = state.swarmRuns['run-1'];
    expect(run?.phases[0]?.status).toBe('completed');
    expect(run?.status).toBe('completed');
  });

  it('recomputes phase status to running when a task starts under a pending parent', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    // No phase_started event — task_started arrives first.
    store.applyEvent('agent-1', {
      type: 'task_started',
      runId: 'run-1',
      phaseId: 'p1',
      taskId: 'p1-t1',
      taskName: 'Coder',
      role: 'coder',
      modelTaskRole: 'coding',
    });

    expect(state.swarmRuns['run-1']?.phases[0]?.status).toBe('running');
  });

  it('recomputeRunStatuses is a no-op on an already-consistent run', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));
    store.seedRun('agent-1', 'run-1', plan, 100);
    store.applyEvent('agent-1', {
      type: 'workflow_completed',
      runId: 'run-1',
      results: [],
      sharedContext: '',
    });

    const run = state.swarmRuns['run-1']!;
    // Workflow completed but no phase_completed ever fired — phase is
    // still `pending` even though run is `completed`. The recompute
    // should NOT override an explicit `workflow_completed` by demoting
    // the run back to `running`.
    recomputeRunStatuses(run);
    expect(run.status).toBe('completed');
  });

  it('closes a run from the final swarm result even if task events were missed', () => {
    const state = createState();
    const store = new BrowserSwarmStore(createKarton(state));

    store.seedRun('agent-1', 'run-1', plan, 100);
    store.completeRunFromResult('agent-1', {
      runId: 'run-1',
      plan,
      results: [
        {
          taskId: 'p1-t1',
          taskName: 'Coder',
          role: 'coder',
          modelTaskRole: 'coding',
          output: 'created index.html',
        },
      ],
    });

    const run = state.swarmRuns['run-1'];
    expect(run?.status).toBe('completed');
    expect(run?.completedAt).toEqual(expect.any(Number));
    expect(run?.phases[0]?.status).toBe('completed');
    expect(run?.phases[0]?.tasks[0]).toMatchObject({
      status: 'completed',
      output: 'created index.html',
    });
  });
});
