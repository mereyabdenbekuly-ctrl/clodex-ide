import { describe, expect, it, vi } from 'vitest';
import { DynamicSwarmOrchestrator } from './orchestrator';

describe('DynamicSwarmOrchestrator', () => {
  it('returns direct mode without running swarm tasks for low-complexity triage', async () => {
    const executor = vi.fn();
    const orchestrator = new DynamicSwarmOrchestrator({
      triage: async () => ({
        type: 'direct',
        task_complexity: 'low',
        reason: 'Small change',
      }),
      executor,
    });

    const result = await orchestrator.execute('fix typo');

    expect(result.type).toBe('direct');
    expect(executor).not.toHaveBeenCalled();
  });

  it('runs the swarm plan returned by triage', async () => {
    const events: string[] = [];
    const orchestrator = new DynamicSwarmOrchestrator({
      idGenerator: () => 'run-1',
      triage: async () => ({
        type: 'swarm',
        task_complexity: 'medium',
        workflow: {
          description: 'Implement feature',
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
      }),
      executor: async (context) => {
        expect(context.modelTaskRole).toBe('coding');
        return 'implemented';
      },
    });
    orchestrator.on((event) => events.push(event.type));

    const result = await orchestrator.execute('implement provider switch');

    expect(result.type).toBe('swarm');
    if (result.type !== 'swarm') throw new Error('Expected swarm result');
    expect(result.run.results[0]?.output).toBe('implemented');
    expect(events).toEqual([
      'workflow_started',
      'phase_started',
      'task_started',
      'task_completed',
      'phase_completed',
      'workflow_completed',
    ]);
  });

  it('falls back to deterministic planning when triage output is invalid', async () => {
    const onTriageError = vi.fn();
    const orchestrator = new DynamicSwarmOrchestrator({
      idGenerator: () => 'run-fallback',
      triage: async () => ({ nope: true }),
      onTriageError,
      executor: async (context) => `${context.task.name} done`,
    });

    const result = await orchestrator.execute(
      'security audit the whole project and refactor architecture',
    );

    expect(onTriageError).toHaveBeenCalledOnce();
    expect(result.type).toBe('swarm');
    if (result.type !== 'swarm') throw new Error('Expected swarm result');
    expect(result.triage.taskComplexity).toBe('high');
    expect(result.run.results.length).toBeGreaterThan(3);
  });
});
