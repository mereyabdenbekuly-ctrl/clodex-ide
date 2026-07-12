import { ModelBudgetPolicyEngine, type ModelBudgetEvent } from './budget';

describe('ModelBudgetPolicyEngine', () => {
  it('enforces hard rolling-window limits including active reservations', () => {
    let now = 1_000;
    let id = 0;
    const events: ModelBudgetEvent[] = [];
    const engine = new ModelBudgetPolicyEngine({
      policies: [
        {
          id: 'task-hour',
          scope: 'task',
          scopeRef: '*',
          windowMs: 60_000,
          limitUsd: 1,
          mode: 'hard',
        },
      ],
      now: () => now,
      idGenerator: () => `budget-${++id}`,
      onEvent: (event) => events.push(event),
    });

    const first = engine.reserve({
      taskId: 'task-a',
      providerId: 'openai',
      estimatedCostUsd: 0.6,
    });
    expect(first.allowed).toBe(true);
    expect(first.reservation).not.toBeNull();

    const denied = engine.reserve({
      taskId: 'task-a',
      providerId: 'openai',
      estimatedCostUsd: 0.5,
    });
    expect(denied).toMatchObject({
      allowed: false,
      deniedPolicyIds: ['task-hour'],
    });

    engine.commit(first.reservation!.id, 0.4);
    const second = engine.reserve({
      taskId: 'task-a',
      providerId: 'openai',
      estimatedCostUsd: 0.5,
    });
    expect(second.allowed).toBe(true);
    engine.release(second.reservation!.id);

    now += 60_001;
    const afterWindow = engine.reserve({
      taskId: 'task-a',
      providerId: 'openai',
      estimatedCostUsd: 0.9,
    });
    expect(afterWindow.allowed).toBe(true);
    expect(events.map((event) => event.status)).toContain('denied');
  });

  it('supports workspace/provider/global scopes and soft warnings', () => {
    const engine = new ModelBudgetPolicyEngine({
      policies: [
        {
          id: 'workspace-soft',
          scope: 'workspace',
          scopeRef: '*',
          windowMs: 1_000,
          limitUsd: 0.1,
          mode: 'soft',
        },
        {
          id: 'provider-hard',
          scope: 'provider',
          scopeRef: 'anthropic',
          windowMs: 1_000,
          limitUsd: 0.2,
          mode: 'hard',
        },
        {
          id: 'global-hard',
          scope: 'global',
          scopeRef: 'global',
          windowMs: 1_000,
          limitUsd: 1,
          mode: 'hard',
        },
      ],
      idGenerator: (() => {
        let id = 0;
        return () => `budget-${++id}`;
      })(),
    });

    const warned = engine.reserve({
      taskId: 'task-a',
      workspaceId: '/workspace/a',
      providerId: 'openai',
      estimatedCostUsd: 0.15,
    });
    expect(warned).toMatchObject({
      allowed: true,
      warningPolicyIds: ['workspace-soft'],
      deniedPolicyIds: [],
    });

    const denied = engine.reserve({
      taskId: 'task-b',
      workspaceId: '/workspace/b',
      providerId: 'anthropic',
      estimatedCostUsd: 0.25,
    });
    expect(denied).toMatchObject({
      allowed: false,
      warningPolicyIds: ['workspace-soft', 'provider-hard'],
      deniedPolicyIds: ['provider-hard'],
    });
  });

  it('releases expired reservations and never settles twice', () => {
    let now = 0;
    const events: ModelBudgetEvent[] = [];
    const engine = new ModelBudgetPolicyEngine({
      policies: [
        {
          id: 'global',
          scope: 'global',
          scopeRef: 'global',
          windowMs: 10_000,
          limitUsd: 1,
          mode: 'hard',
        },
      ],
      reservationTtlMs: 100,
      now: () => now,
      onEvent: (event) => events.push(event),
    });
    const reservation = engine.reserve({
      taskId: 'task',
      providerId: 'local',
      estimatedCostUsd: 0.8,
    }).reservation!;
    now = 101;
    expect(
      engine.reserve({
        taskId: 'task-2',
        providerId: 'local',
        estimatedCostUsd: 0.8,
      }).allowed,
    ).toBe(true);
    expect(engine.commit(reservation.id)).toBeNull();
    expect(
      events.some(
        (event) =>
          event.reservationId === reservation.id && event.status === 'released',
      ),
    ).toBe(true);
  });

  it('seeds committed content-free spend for startup enforcement', () => {
    const engine = new ModelBudgetPolicyEngine({
      policies: [
        {
          id: 'provider-day',
          scope: 'provider',
          scopeRef: '*',
          windowMs: 86_400_000,
          limitUsd: 1,
          mode: 'hard',
        },
      ],
      now: () => 10_000,
    });
    engine.seedCommittedSpend([
      {
        policyId: 'provider-day',
        scopeRef: 'openai',
        amountUsd: 0.75,
        createdAt: 9_000,
      },
    ]);
    expect(
      engine.reserve({
        taskId: 'task',
        providerId: 'openai',
        estimatedCostUsd: 0.3,
      }),
    ).toMatchObject({
      allowed: false,
      deniedPolicyIds: ['provider-day'],
    });
  });

  it('clears active and committed contributions for one task only', () => {
    const engine = new ModelBudgetPolicyEngine({
      policies: [
        {
          id: 'global',
          scope: 'global',
          scopeRef: 'global',
          windowMs: 10_000,
          limitUsd: 1,
          mode: 'hard',
        },
      ],
    });
    const taskA = engine.reserve({
      taskId: 'task-a',
      providerId: 'openai',
      estimatedCostUsd: 0.6,
    }).reservation!;
    engine.commit(taskA.id);
    const taskB = engine.reserve({
      taskId: 'task-b',
      providerId: 'openai',
      estimatedCostUsd: 0.3,
    }).reservation!;

    engine.clearTask('task-a');
    expect(
      engine.reserve({
        taskId: 'task-c',
        providerId: 'openai',
        estimatedCostUsd: 0.6,
      }).allowed,
    ).toBe(true);
    expect(engine.commit(taskB.id)).not.toBeNull();
  });
});
