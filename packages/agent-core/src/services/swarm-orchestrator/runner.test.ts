import { describe, expect, it } from 'vitest';
import type { SwarmPlan, SwarmRunEvent } from './types';
import {
  formatSharedContext,
  mapSwarmRoleToModelTaskRole,
  SwarmRunner,
} from './runner';

const plan: SwarmPlan = {
  task_complexity: 'high',
  workflow: {
    description: 'Test workflow',
    phases: [
      {
        id: 'p1',
        title: 'Discovery',
        tasks: [
          {
            id: 'p1-t1',
            name: 'Scanner',
            role: 'researcher',
            prompt: 'Find files',
          },
        ],
      },
      {
        id: 'p2',
        title: 'Implementation',
        tasks: [
          {
            id: 'p2-t1',
            name: 'Coder API',
            role: 'coder',
            prompt: 'Backend',
          },
          {
            id: 'p2-t2',
            name: 'Coder UI',
            role: 'coder',
            prompt: 'Frontend',
          },
        ],
      },
      {
        id: 'p3',
        title: 'Review',
        tasks: [
          {
            id: 'p3-t1',
            name: 'Reviewer',
            role: 'reviewer',
            prompt: 'Review',
          },
        ],
      },
    ],
  },
};

describe('SwarmRunner', () => {
  it('maps swarm roles to model task roles', () => {
    expect(mapSwarmRoleToModelTaskRole('researcher')).toBe('analysis');
    expect(mapSwarmRoleToModelTaskRole('planner')).toBe('analysis');
    expect(mapSwarmRoleToModelTaskRole('coder')).toBe('coding');
    expect(mapSwarmRoleToModelTaskRole('reviewer')).toBe('review');
  });

  it('runs phases sequentially and tasks inside a phase in parallel', async () => {
    const events: SwarmRunEvent[] = [];
    const started: string[] = [];
    let releaseCoders: (() => void) | null = null;
    const codersReleased = new Promise<void>((resolve) => {
      releaseCoders = resolve;
    });

    const runner = new SwarmRunner({
      idGenerator: () => 'run-1',
      executor: async (context) => {
        started.push(context.task.id);
        context.emitProgress({ toolsUsed: 1 });
        if (context.phase.id === 'p2') {
          if (started.includes('p2-t1') && started.includes('p2-t2')) {
            releaseCoders?.();
          }
          await codersReleased;
          expect(context.sharedContext).toContain('Scanner');
        }
        if (context.phase.id === 'p3') {
          expect(context.sharedContext).toContain('Coder API');
          expect(context.sharedContext).toContain('Coder UI');
        }
        return `${context.task.name} done`;
      },
    });
    runner.on((event) => events.push(event));

    const result = await runner.run(plan);

    expect(result.runId).toBe('run-1');
    expect(result.results.map((item) => item.taskId)).toEqual([
      'p1-t1',
      'p2-t1',
      'p2-t2',
      'p3-t1',
    ]);
    expect(started.slice(0, 1)).toEqual(['p1-t1']);
    expect(started.slice(1, 3).sort()).toEqual(['p2-t1', 'p2-t2']);
    expect(started[3]).toBe('p3-t1');
    expect(events.map((event) => event.type)).toContain('task_progress');
    expect(events.at(-1)?.type).toBe('workflow_completed');
  });

  it('uses task modelTaskRole overrides without changing swarm tool role', async () => {
    const events: SwarmRunEvent[] = [];
    const debatePlan: SwarmPlan = {
      task_complexity: 'medium',
      workflow: {
        description: 'Debate workflow',
        phases: [
          {
            id: 'p1',
            title: 'Strategy Debate',
            tasks: [
              {
                id: 'p1-t1',
                name: 'Builder',
                role: 'planner',
                modelTaskRole: 'coding',
                preferredModelId: 'claude-opus-4.8',
                prompt: 'Argue for robust implementation',
              },
            ],
          },
        ],
      },
    };
    const runner = new SwarmRunner({
      idGenerator: () => 'run-model-role',
      executor: async (context) => {
        expect(context.task.role).toBe('planner');
        expect(context.modelTaskRole).toBe('coding');
        expect(context.task.preferredModelId).toBe('claude-opus-4.8');
        return {
          output: 'builder argued for robust implementation',
          modelTaskRole: context.modelTaskRole,
          resolvedModelId: 'claude-opus-4.8',
        };
      },
    });
    runner.on((event) => events.push(event));

    const result = await runner.run(debatePlan);

    expect(result.results[0]).toMatchObject({
      role: 'planner',
      modelTaskRole: 'coding',
      preferredModelId: 'claude-opus-4.8',
      resolvedModelId: 'claude-opus-4.8',
    });
    const taskStarted = events.find((event) => event.type === 'task_started');
    expect(taskStarted).toMatchObject({
      role: 'planner',
      modelTaskRole: 'coding',
      preferredModelId: 'claude-opus-4.8',
    });
  });

  it('emits task_failed and workflow_failed when a task throws', async () => {
    const events: SwarmRunEvent[] = [];
    const runner = new SwarmRunner({
      idGenerator: () => 'run-fail',
      executor: async (context) => {
        if (context.task.id === 'p2-t1') throw new Error('boom');
        return `${context.task.name} done`;
      },
    });
    runner.on((event) => events.push(event));

    await expect(runner.run(plan)).rejects.toThrow('boom');
    expect(events.some((event) => event.type === 'task_failed')).toBe(true);
    expect(events.at(-1)?.type).toBe('workflow_failed');
  });

  it('keeps running when a soft-fail debate phase has a failed participant', async () => {
    const events: SwarmRunEvent[] = [];
    const debatePlan: SwarmPlan = {
      task_complexity: 'high',
      workflow: {
        description: 'Battle workflow',
        phases: [
          {
            id: 'p1',
            title: 'Strategy Debate',
            failureMode: 'soft',
            tasks: [
              {
                id: 'p1-t1',
                name: 'Minimalist',
                role: 'planner',
                prompt: 'Argue small',
              },
              {
                id: 'p1-t2',
                name: 'Skeptic',
                role: 'planner',
                preferredModelId: 'gemini-3.5-flash',
                prompt: 'Find risks',
              },
            ],
          },
          {
            id: 'p2',
            title: 'Arbiter Decision',
            tasks: [
              {
                id: 'p2-t1',
                name: 'Arbiter',
                role: 'planner',
                prompt: 'Choose plan',
              },
            ],
          },
        ],
      },
    };
    const runner = new SwarmRunner({
      idGenerator: () => 'run-soft-fail',
      executor: async (context) => {
        if (context.task.name === 'Skeptic') {
          throw new Error('openai_error');
        }
        if (context.task.name === 'Arbiter') {
          expect(context.sharedContext).toContain('Skeptic unavailable');
          return 'arbiter used remaining debate';
        }
        return `${context.task.name} completed`;
      },
    });
    runner.on((event) => events.push(event));

    const result = await runner.run(debatePlan);

    expect(result.results.map((item) => item.taskName)).toEqual([
      'Minimalist',
      'Skeptic',
      'Arbiter',
    ]);
    expect(result.results[1]?.output).toContain('openai_error');
    expect(events.some((event) => event.type === 'task_failed')).toBe(true);
    expect(events.at(-1)?.type).toBe('workflow_completed');
  });

  it('runs Battle Agent as GPT/Opus fan-out, rebuttal fan-out, then Gemini fan-in', async () => {
    const started: string[] = [];
    let releaseFirstRound: (() => void) | null = null;
    let releaseRebuttalRound: (() => void) | null = null;
    const firstRoundReleased = new Promise<void>((resolve) => {
      releaseFirstRound = resolve;
    });
    const rebuttalRoundReleased = new Promise<void>((resolve) => {
      releaseRebuttalRound = resolve;
    });
    const battlePlan: SwarmPlan = {
      task_complexity: 'high',
      workflow: {
        description: 'Battle workflow',
        phases: [
          {
            id: 'p1',
            title: 'Round 1: Independent Analysis',
            failureMode: 'soft',
            tasks: [
              {
                id: 'p1-t1',
                name: 'GPT-5.5 Pragmatist',
                role: 'planner',
                preferredModelId: 'gpt-5.5',
                prompt: 'Pragmatic plan',
              },
              {
                id: 'p1-t2',
                name: 'Opus 4.8 Architect',
                role: 'planner',
                preferredModelId: 'claude-opus-4.8',
                prompt: 'Architecture plan',
              },
            ],
          },
          {
            id: 'p2',
            title: 'Round 2: Rebuttals',
            failureMode: 'soft',
            tasks: [
              {
                id: 'p2-t1',
                name: 'GPT-5.5 Rebuttal',
                role: 'planner',
                preferredModelId: 'gpt-5.5',
                prompt: 'Rebut Opus',
              },
              {
                id: 'p2-t2',
                name: 'Opus 4.8 Rebuttal',
                role: 'planner',
                preferredModelId: 'claude-opus-4.8',
                prompt: 'Rebut GPT',
              },
            ],
          },
          {
            id: 'p3',
            title: 'Synthesizer: Gemini 3.5',
            tasks: [
              {
                id: 'p3-t1',
                name: 'Gemini 3.5 Synthesizer',
                role: 'planner',
                preferredModelId: 'gemini-3.5-flash',
                prompt: 'Synthesize',
              },
            ],
          },
        ],
      },
    };
    const runner = new SwarmRunner({
      idGenerator: () => 'run-battle',
      executor: async (context) => {
        started.push(context.task.id);
        if (context.phase.id === 'p1') {
          if (started.includes('p1-t1') && started.includes('p1-t2')) {
            releaseFirstRound?.();
          }
          await firstRoundReleased;
        }
        if (context.phase.id === 'p2') {
          expect(context.sharedContext).toContain('GPT-5.5 Pragmatist');
          expect(context.sharedContext).toContain('Opus 4.8 Architect');
          if (started.includes('p2-t1') && started.includes('p2-t2')) {
            releaseRebuttalRound?.();
          }
          await rebuttalRoundReleased;
        }
        if (context.phase.id === 'p3') {
          expect(context.task.preferredModelId).toBe('gemini-3.5-flash');
          expect(context.sharedContext).toContain('GPT-5.5 Pragmatist');
          expect(context.sharedContext).toContain('Opus 4.8 Architect');
          expect(context.sharedContext).toContain('GPT-5.5 Rebuttal');
          expect(context.sharedContext).toContain('Opus 4.8 Rebuttal');
        }
        return `${context.task.name} completed`;
      },
    });

    const result = await runner.run(battlePlan);

    expect(started.slice(0, 2).sort()).toEqual(['p1-t1', 'p1-t2']);
    expect(started.slice(2, 4).sort()).toEqual(['p2-t1', 'p2-t2']);
    expect(started[4]).toBe('p3-t1');
    expect(result.results.map((item) => item.taskName)).toEqual([
      'GPT-5.5 Pragmatist',
      'Opus 4.8 Architect',
      'GPT-5.5 Rebuttal',
      'Opus 4.8 Rebuttal',
      'Gemini 3.5 Synthesizer',
    ]);
  });

  it('formats previous task results as bounded shared context', () => {
    const context = formatSharedContext([
      {
        taskId: 'p1-t1',
        taskName: 'Scanner',
        role: 'researcher',
        modelTaskRole: 'analysis',
        output: 'Found <AuthService>',
      },
    ]);

    expect(context).toContain('<swarm-context>');
    expect(context).toContain('Found <AuthService>');
    expect(context).toContain('name="Scanner"');
  });

  it('truncates very large previous task outputs before sharing them with later phases', () => {
    const context = formatSharedContext([
      {
        taskId: 'p1-t1',
        taskName: 'Scanner',
        role: 'researcher',
        modelTaskRole: 'analysis',
        output: 'x'.repeat(80_000),
      },
    ]);

    expect(context.length).toBeLessThan(50_000);
    expect(context).toContain('[truncated for swarm context]');
  });
});
