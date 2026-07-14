import { describe, expect, it, vi } from 'vitest';
import type { AutomationStoreData } from '@shared/automations';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { NotificationService } from '../notification';
import type { AutomationDispatchWalPersistence } from './dispatch-wal';
import {
  AutomationService,
  type AutomationBeforeDispatchInput,
  type AutomationDispatchInput,
  type AutomationPersistence,
} from './index';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/clodex-automation-test/${name}`,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

function createHarness(options?: {
  initial?: AutomationStoreData;
  now?: number;
  dispatch?: (input: AutomationDispatchInput) => Promise<{ agentId: string }>;
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
  let dispatchWalData: unknown = { version: 1, records: {} };
  const dispatchWalPersistence: AutomationDispatchWalPersistence = {
    load: async () => structuredClone(dispatchWalData),
    save: async (value) => {
      dispatchWalData = structuredClone(value);
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
  const configuredDispatch =
    options?.dispatch ?? (async () => ({ agentId: 'agent-1' }));
  const dispatch = vi.fn(async (input: AutomationDispatchInput) => {
    input.beforeDispatch?.();
    return await configuredDispatch(input);
  });
  const now = options?.now ?? Date.parse('2026-07-11T10:00:00.000Z');

  return {
    handlers,
    persistence,
    dispatchWalPersistence,
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
      dispatchWalPersistence: harness.dispatchWalPersistence,
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

  it('does not retry an automation effect after the first dispatch failure', async () => {
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
      dispatchWalPersistence: harness.dispatchWalPersistence,
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
      status: 'uncertain',
      attemptCount: 1,
      agentId: null,
    });
    expect(attempts).toBe(1);
    await service.teardown();
  });

  it('invokes the manual-run fence immediately before adapter dispatch', async () => {
    const events: string[] = [];
    let fencedInput: AutomationBeforeDispatchInput | undefined;
    let dispatchedInput: AutomationDispatchInput | undefined;
    const harness = createHarness({
      dispatch: async (input) => {
        events.push('dispatch');
        dispatchedInput = input;
        return { agentId: 'agent-fenced' };
      },
    });
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      dispatchWalPersistence: harness.dispatchWalPersistence,
      isFeatureEnabled: () => true,
      dispatch: harness.dispatch,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    const created = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Fenced task',
      prompt: 'Dispatch only after the final fence.',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    const id = created.snapshot.automations[0].id;

    await service.runAutomationNow(id, {
      beforeDispatch: (input) => {
        events.push(`before-dispatch:${input.attempt}`);
        fencedInput = input;
      },
    });

    expect(events).toEqual(['before-dispatch:1', 'dispatch']);
    expect(fencedInput).toMatchObject({
      attempt: 1,
      prompt: 'Dispatch only after the final fence.',
      automation: { id, title: 'Fenced task' },
    });
    expect(fencedInput?.automation).toBe(dispatchedInput?.automation);
    await service.teardown();
  });

  it('rechecks a queued manual run after serialization and blocks revoked dispatch', async () => {
    let releaseBlocker: (() => void) | undefined;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let markBlockerDispatched: (() => void) | undefined;
    const blockerDispatched = new Promise<void>((resolve) => {
      markBlockerDispatched = resolve;
    });
    let targetDispatches = 0;
    const harness = createHarness({
      dispatch: async ({ automation }) => {
        if (automation.title === 'Serialization blocker') {
          markBlockerDispatched?.();
          await blockerReleased;
          return { agentId: 'agent-blocker' };
        }
        targetDispatches += 1;
        return { agentId: 'agent-revoked-target' };
      },
    });
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      dispatchWalPersistence: harness.dispatchWalPersistence,
      isFeatureEnabled: () => true,
      dispatch: harness.dispatch,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    const blocker = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Serialization blocker',
      prompt: 'Hold the serialized section.',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    const target = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Revoked target',
      prompt: 'Must not dispatch after revocation.',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });

    const blockerRun = service.runAutomationNow(
      blocker.snapshot.automations[0].id,
    );
    await blockerDispatched;

    let revoked = false;
    let fenceCalls = 0;
    const targetId = target.snapshot.automations[1].id;
    const targetRun = service.runAutomationNow(targetId, {
      retryMode: 'no-blind-retry',
      failureMode: 'propagate',
      beforeDispatch: () => {
        fenceCalls += 1;
        if (revoked) throw new Error('Artifact Bridge grant revoked');
      },
    });
    const targetRejected = expect(targetRun).rejects.toThrow(
      'Artifact Bridge grant revoked',
    );
    await Promise.resolve();
    expect(fenceCalls).toBe(0);

    revoked = true;
    releaseBlocker?.();
    await blockerRun;
    await targetRejected;

    expect(fenceCalls).toBe(1);
    expect(targetDispatches).toBe(0);
    expect(service.getSnapshot().recentRuns[0]).toMatchObject({
      automationId: targetId,
      status: 'failed',
      attemptCount: 1,
      reason: 'FAILED_PRE_EFFECT: Artifact Bridge grant revoked',
    });
    expect(harness.getData().runs[0]).toMatchObject({
      automationId: targetId,
      status: 'failed',
      attemptCount: 1,
      reason: 'FAILED_PRE_EFFECT: Artifact Bridge grant revoked',
    });
    await service.teardown();
  });

  it('does not blindly retry an ambiguous bridge-safe dispatch failure', async () => {
    let attempts = 0;
    const harness = createHarness({
      dispatch: async () => {
        attempts += 1;
        throw new Error('dispatch result unavailable after transport close');
      },
    });
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      dispatchWalPersistence: harness.dispatchWalPersistence,
      isFeatureEnabled: () => true,
      dispatch: harness.dispatch,
      now: () => harness.now,
      sleep: async () => undefined,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    const created = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Ambiguous dispatch',
      prompt: 'Do not repeat this effect.',
      schedule: { kind: 'interval', everyMs: 60_000 },
      retryPolicy: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
        maxBackoffMs: 1_000,
      },
    });
    const id = created.snapshot.automations[0].id;

    await expect(
      service.runAutomationNow(id, {
        retryMode: 'no-blind-retry',
        failureMode: 'propagate',
      }),
    ).rejects.toThrow('dispatch result unavailable after transport close');

    expect(attempts).toBe(1);
    expect(service.getSnapshot().recentRuns[0]).toMatchObject({
      automationId: id,
      status: 'uncertain',
      attemptCount: 1,
      reason: 'UNCERTAIN: dispatch result unavailable after transport close',
    });
    expect(harness.getData().runs[0]).toMatchObject({
      automationId: id,
      status: 'uncertain',
      attemptCount: 1,
      reason: 'UNCERTAIN: dispatch result unavailable after transport close',
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
      dispatchWalPersistence: harness.dispatchWalPersistence,
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
      service.runAutomationNow(created.snapshot.automations[0].id, {
        failureMode: 'propagate',
      }),
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
      dispatchWalPersistence: harness.dispatchWalPersistence,
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

  it('does not dispatch an overdue persisted automation while startup gate is disabled', async () => {
    const seedHarness = createHarness({
      now: Date.parse('2026-07-11T10:00:00.000Z'),
    });
    const seed = await AutomationService.create({
      logger: {} as Logger,
      karton: seedHarness.karton,
      notifications: seedHarness.notifications,
      persistence: seedHarness.persistence,
      dispatchWalPersistence: seedHarness.dispatchWalPersistence,
      isFeatureEnabled: () => true,
      dispatch: seedHarness.dispatch,
      now: () => seedHarness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    await seedHarness.handlers.get('automations.create')?.('ui', {
      title: 'Overdue startup task',
      prompt: 'Must remain dormant while disabled.',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    const persisted = structuredClone(seedHarness.getData());
    await seed.teardown();

    const harness = createHarness({
      initial: persisted,
      now: Date.parse('2026-07-11T10:02:00.000Z'),
    });
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      dispatchWalPersistence: harness.dispatchWalPersistence,
      isFeatureEnabled: () => false,
      dispatch: harness.dispatch,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.getData().runs).toHaveLength(0);
    await service.teardown();
  });

  it('rechecks the automation gate at the real adapter boundary', async () => {
    let enabled = true;
    let releaseAdapter!: () => void;
    const adapterReleased = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    let markAdapterEntered!: () => void;
    const adapterEntered = new Promise<void>((resolve) => {
      markAdapterEntered = resolve;
    });
    let effectStarted = false;
    const harness = createHarness();
    harness.dispatch.mockImplementationOnce(async (input) => {
      markAdapterEntered();
      await adapterReleased;
      input.beforeDispatch?.();
      effectStarted = true;
      return { agentId: 'must-not-exist' };
    });
    const service = await AutomationService.create({
      logger: {} as Logger,
      karton: harness.karton,
      notifications: harness.notifications,
      persistence: harness.persistence,
      dispatchWalPersistence: harness.dispatchWalPersistence,
      isFeatureEnabled: () => enabled,
      dispatch: harness.dispatch,
      now: () => harness.now,
      setTimer: () => 1 as any,
      clearTimer: vi.fn(),
    });
    const created = await harness.handlers.get('automations.create')?.('ui', {
      title: 'Gate race',
      prompt: 'Must not create an agent after disable.',
      schedule: { kind: 'interval', everyMs: 60_000 },
    });
    const run = service.runAutomationNow(created.snapshot.automations[0].id, {
      retryMode: 'no-blind-retry',
      failureMode: 'propagate',
    });
    await adapterEntered;
    enabled = false;
    releaseAdapter();

    await expect(run).rejects.toThrow('feature is disabled');
    expect(effectStarted).toBe(false);
    await service.teardown();
  });
});
