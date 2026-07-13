import { beforeEach, describe, expect, it, vi } from 'vitest';

const wiringMocks = vi.hoisted(() => ({
  wirePagesHandlers: vi.fn(),
  wirePagesStateSync: vi.fn(),
}));

vi.mock('./pages-handler-wiring', () => ({
  wirePagesHandlers: wiringMocks.wirePagesHandlers,
}));

vi.mock('./pages-state-sync', () => ({
  wirePagesStateSync: wiringMocks.wirePagesStateSync,
}));

import { wirePagesRuntime } from './pages-runtime';

type PagesRuntimeDependencies = Parameters<typeof wirePagesRuntime>[0];

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createDependencies() {
  const clearPermissionExceptionsResult = Promise.resolve();
  const clearAllPermissionExceptionsForAllTypes = vi.fn(
    () => clearPermissionExceptionsResult,
  );
  const setClearPermissionExceptionsHandler = vi.fn();
  const deps = {
    uiKarton: { dependency: 'uiKarton' },
    pagesService: {
      dependency: 'pagesService',
      setClearPermissionExceptionsHandler,
    },
    globalConfigService: { dependency: 'globalConfigService' },
    diffHistoryService: { dependency: 'diffHistoryService' },
    pendingEditService: { dependency: 'pendingEditService' },
    windowLayoutService: { dependency: 'windowLayoutService' },
    getSandboxService: vi.fn(() => null),
    activeAppController: { dependency: 'activeAppController' },
    hostedPullRequestService: { dependency: 'hostedPullRequestService' },
    generatedAppLibraryService: { dependency: 'generatedAppLibraryService' },
    pluginMarketplaceService: { dependency: 'pluginMarketplaceService' },
    preferencesService: {
      dependency: 'preferencesService',
      clearAllPermissionExceptionsForAllTypes,
    },
    credentialsService: { dependency: 'credentialsService' },
    logger: { dependency: 'logger' },
  } as unknown as PagesRuntimeDependencies;

  return {
    clearAllPermissionExceptionsForAllTypes,
    clearPermissionExceptionsResult,
    deps,
    setClearPermissionExceptionsHandler,
  };
}

describe('wirePagesRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits state sync before forwarding handlers and registering the clear callback', async () => {
    const order: string[] = [];
    const stateSync = deferred();
    const {
      clearAllPermissionExceptionsForAllTypes,
      clearPermissionExceptionsResult,
      deps,
      setClearPermissionExceptionsHandler,
    } = createDependencies();

    wiringMocks.wirePagesStateSync.mockImplementation(async () => {
      order.push('state-sync:start');
      await stateSync.promise;
      order.push('state-sync:complete');
    });
    wiringMocks.wirePagesHandlers.mockImplementation(() => {
      order.push('handlers');
    });
    setClearPermissionExceptionsHandler.mockImplementation(() => {
      order.push('permission-callback');
    });

    const wiringPromise = wirePagesRuntime(deps);

    expect(order).toEqual(['state-sync:start']);
    expect(wiringMocks.wirePagesHandlers).not.toHaveBeenCalled();
    expect(setClearPermissionExceptionsHandler).not.toHaveBeenCalled();

    stateSync.resolve();
    await wiringPromise;

    expect(order).toEqual([
      'state-sync:start',
      'state-sync:complete',
      'handlers',
      'permission-callback',
    ]);
    expect(wiringMocks.wirePagesStateSync).toHaveBeenCalledWith({
      uiKarton: deps.uiKarton,
      pagesService: deps.pagesService,
      globalConfigService: deps.globalConfigService,
      logger: deps.logger,
    });
    expect(wiringMocks.wirePagesHandlers).toHaveBeenCalledWith({
      uiKarton: deps.uiKarton,
      pagesService: deps.pagesService,
      diffHistoryService: deps.diffHistoryService,
      pendingEditService: deps.pendingEditService,
      windowLayoutService: deps.windowLayoutService,
      getSandboxService: deps.getSandboxService,
      activeAppController: deps.activeAppController,
      hostedPullRequestService: deps.hostedPullRequestService,
      generatedAppLibraryService: deps.generatedAppLibraryService,
      pluginMarketplaceService: deps.pluginMarketplaceService,
      preferencesService: deps.preferencesService,
      credentialsService: deps.credentialsService,
      logger: deps.logger,
    });
    expect(clearAllPermissionExceptionsForAllTypes).not.toHaveBeenCalled();

    const clearCallback =
      setClearPermissionExceptionsHandler.mock.calls[0]?.[0];
    expect(clearCallback).toEqual(expect.any(Function));
    const clearResult = clearCallback?.();
    expect(clearResult).toBe(clearPermissionExceptionsResult);
    await clearResult;
    expect(clearAllPermissionExceptionsForAllTypes).toHaveBeenCalledOnce();
  });
});
