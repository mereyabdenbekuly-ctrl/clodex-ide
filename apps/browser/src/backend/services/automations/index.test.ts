import { describe, expect, it, vi } from 'vitest';
import type { AutomationStoreData } from '@shared/automations';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { NotificationService } from '../notification';
import { AutomationService, type AutomationPersistence } from './index';

function createHarness(options?: {
  initial?: AutomationStoreData;
  now?: number;
  dispatch?: () => Promise<{ agentId: string }>;
}) {
  let data: AutomationStoreData = structuredClone(
    options?.initial ?? { version: 1, automations: [], runs: [] },
  );
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const persistence: AutomationPersistence = {
    load: async () => structuredClone(data),
    save: async (value) => {
      data = structuredClone(value);
    },
  };
  const karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: (...args: any[]) => Promise<any>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  const notifications = {
    showNotification: vi.fn(),
  } as unknown as NotificationService;
  const dispatch = vi.fn(
    options?.dispatch ?? (async () => ({ agentId: 'agent-1' })),
  );
  const now = options?.now ?? Date.parse('2026-07-11T10:00:00.000Z');

  return {
    handlers,
    persistence,
    karton,
    notifications,
    dispatch,
    now,
    getData: () => data,
  };
}

describe('AutomationService', () => {
  it('persists a scheduled automation and calculates its next run', async () => {
    const harness = createHarness();
    const nativeWakeScheduler = {
      getStatus: () => ({
        platform: 'linux' as const,
        mode: 'native' as const,
        canWakeSystem: false,
        scheduledFor: '2026-07-11T10:00:00.000Z',
        registeredAt: '2026-07-11T09:59:00.000Z',
        message: 'registered',
      }),
      sync: vi.fn(async () => undefined),
    };
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      dispatch: harness.dispatch,
      nativeWakeScheduler,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });

    const result = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Daily review',
      prompt: 'Review the repository.',
      schedule: {
        kind: 'cron',
        expression: '0 15 * * *',
        timezone: 'Asia/Almaty',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot.automations[0]?.nextRunAt).toBe(
      '2026-07-11T10:00:00.000Z',
    );
    expect(harness.getData().automations).toHaveLength(1);
    expect(nativeWakeScheduler.sync).toHaveBeenLastCalledWith(
      '2026-07-11T10:00:00.000Z',
    );
    await service.teardown();
  });

  it('runs an automation with retries and records the submitted agent', async () => {
    let attempts = 0;
    const harness = createHarness({
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary');
        return { agentId: 'agent-retry' };
      },
    });
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      dispatch: harness.dispatch,
      now: () => harness.now,
      sleep: async () => undefined,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    const created = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Retry task',
      prompt: 'Do the work.',
      schedule: { kind: 'interval', everyMs: 60_000 },
      retryPolicy: {
        maxAttempts: 2,
        initialBackoffMs: 1_000,
        maxBackoffMs: 1_000,
      },
    });
    const id = created.snapshot.automations[0].id;

    const result = await harness.handlers.get('automations.runNow')?.('ui', id);

    expect(result.snapshot.recentRuns[0]).toMatchObject({
      automationId: id,
      status: 'succeeded',
      attemptCount: 2,
      agentId: 'agent-retry',
    });
    await service.teardown();
  });

  it('requires an explicit unexpired grant for alwaysAllow', async () => {
    const harness = createHarness();
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      isFeatureEnabled: () => true,
      dispatch: harness.dispatch,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    const created = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Unsafe task',
      prompt: 'Run.',
      approvalMode: 'alwaysAllow',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });

    await expect(
      harness.handlers.get('automations.runNow')?.(
        'ui',
        created.snapshot.automations[0].id,
      ),
    ).rejects.toThrow('explicit capability grant');
    await service.teardown();
  });

  it('rejects all procedures when the feature gate is disabled', async () => {
    const harness = createHarness();
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      isFeatureEnabled: () => false,
      dispatch: harness.dispatch,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });

    await expect(
      harness.handlers.get('automations.getSnapshot')?.('ui'),
    ).rejects.toThrow('feature is disabled');
    await service.teardown();
  });
});
