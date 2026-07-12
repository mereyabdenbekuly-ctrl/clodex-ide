import { describe, expect, it, vi } from 'vitest';
import {
  ShutdownCoordinator,
  type ShutdownLogger,
  type ShutdownTask,
} from './shutdown-coordinator';

const flushMicrotasks = async () => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

const createLogger = (): ShutdownLogger => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('ShutdownCoordinator', () => {
  it('runs synchronous teardowns in declaration order before starting asynchronous teardowns', async () => {
    const order: string[] = [];
    const immediateCallbacks: Array<() => void> = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const exitApp = vi.fn();
    const event = { preventDefault: vi.fn() };
    const synchronousTeardowns: ShutdownTask[] = [
      { name: 'sync-first', teardown: () => void order.push('sync-first') },
      { name: 'sync-second', teardown: () => void order.push('sync-second') },
    ];
    const asynchronousTeardowns: ShutdownTask[] = [
      {
        name: 'async-first',
        teardown: () => {
          order.push('async-first:start');
          return new Promise<void>((resolve) => {
            resolveFirst = () => {
              order.push('async-first:end');
              resolve();
            };
          });
        },
      },
      {
        name: 'async-second',
        teardown: () => {
          order.push('async-second:start');
          return new Promise<void>((resolve) => {
            resolveSecond = () => {
              order.push('async-second:end');
              resolve();
            };
          });
        },
      },
    ];
    const coordinator = new ShutdownCoordinator({
      logger: createLogger(),
      exitApp,
      synchronousTeardowns,
      asynchronousTeardowns,
      scheduleTimeout: () => undefined,
      scheduleImmediate: (callback) => immediateCallbacks.push(callback),
    });

    coordinator.handleWillQuit(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(order).toEqual(['sync-first', 'sync-second']);
    expect(exitApp).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(order).toEqual([
      'sync-first',
      'sync-second',
      'async-first:start',
      'async-second:start',
    ]);

    resolveSecond();
    await flushMicrotasks();
    expect(immediateCallbacks).toHaveLength(0);

    resolveFirst();
    await flushMicrotasks();
    expect(immediateCallbacks).toHaveLength(1);
    expect(exitApp).not.toHaveBeenCalled();

    immediateCallbacks[0]?.();
    expect(exitApp).toHaveBeenCalledOnce();
    expect(exitApp).toHaveBeenCalledWith(0);
  });

  it('logs individual synchronous and asynchronous failures and continues teardown', async () => {
    const syncFailure = new Error('sync failed');
    const asyncFailure = new Error('async failed');
    const order: string[] = [];
    const immediateCallbacks: Array<() => void> = [];
    const logger = createLogger();
    const exitApp = vi.fn();
    const coordinator = new ShutdownCoordinator({
      logger,
      exitApp,
      synchronousTeardowns: [
        {
          name: 'sync-failure',
          teardown: () => {
            throw syncFailure;
          },
        },
        {
          name: 'sync-after-failure',
          teardown: () => void order.push('sync-after-failure'),
        },
      ],
      asynchronousTeardowns: [
        {
          name: 'async-failure',
          teardown: () => Promise.reject(asyncFailure),
        },
        {
          name: 'async-after-failure',
          teardown: () => void order.push('async-after-failure'),
        },
      ],
      scheduleTimeout: () => undefined,
      scheduleImmediate: (callback) => immediateCallbacks.push(callback),
    });

    coordinator.handleWillQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(order).toEqual(['sync-after-failure', 'async-after-failure']);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Main] Failed to teardown sync-failure',
      syncFailure,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[Main] Failed to teardown async-failure',
      asyncFailure,
    );
    expect(immediateCallbacks).toHaveLength(1);

    immediateCallbacks[0]?.();
    expect(exitApp).toHaveBeenCalledWith(0);
  });

  it('logs budget expiry and exits while an asynchronous teardown is still pending', async () => {
    const immediateCallbacks: Array<() => void> = [];
    const timeoutCallbacks: Array<() => void> = [];
    const timeoutDelays: number[] = [];
    const logger = createLogger();
    const exitApp = vi.fn();
    let resolvePending!: () => void;
    const coordinator = new ShutdownCoordinator({
      logger,
      exitApp,
      synchronousTeardowns: [],
      asynchronousTeardowns: [
        {
          name: 'pending',
          teardown: () =>
            new Promise<void>((resolve) => {
              resolvePending = resolve;
            }),
        },
      ],
      shutdownBudgetMs: 25,
      scheduleTimeout: (callback, delayMs) => {
        timeoutCallbacks.push(callback);
        timeoutDelays.push(delayMs);
      },
      scheduleImmediate: (callback) => immediateCallbacks.push(callback),
    });

    coordinator.handleWillQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(timeoutDelays).toEqual([25]);
    expect(timeoutCallbacks).toHaveLength(1);
    expect(immediateCallbacks).toHaveLength(0);

    timeoutCallbacks[0]?.();
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      '[Main] Shutdown budget of 25ms expired, some async teardowns may be incomplete',
    );
    expect(immediateCallbacks).toHaveLength(1);
    immediateCallbacks[0]?.();
    expect(exitApp).toHaveBeenCalledWith(0);

    resolvePending();
    await flushMicrotasks();
    expect(immediateCallbacks).toHaveLength(1);
    expect(exitApp).toHaveBeenCalledOnce();
  });

  it('ignores repeated will-quit events after the first invocation', async () => {
    const immediateCallbacks: Array<() => void> = [];
    const teardown = vi.fn();
    const exitApp = vi.fn();
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };
    const coordinator = new ShutdownCoordinator({
      logger: createLogger(),
      exitApp,
      synchronousTeardowns: [{ name: 'single', teardown }],
      asynchronousTeardowns: [],
      scheduleTimeout: () => undefined,
      scheduleImmediate: (callback) => immediateCallbacks.push(callback),
    });

    coordinator.handleWillQuit(firstEvent);
    coordinator.handleWillQuit(repeatedEvent);
    await flushMicrotasks();

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledOnce();
    expect(immediateCallbacks).toHaveLength(1);

    immediateCallbacks[0]?.();
    expect(exitApp).toHaveBeenCalledOnce();
  });
});
