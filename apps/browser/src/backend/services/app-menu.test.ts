import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const builtMenu = { id: 'darwin-application-menu' };

  return {
    app: {
      name: 'CLODEx',
      applicationMenu: null as unknown,
    },
    builtMenu,
    buildFromTemplate: vi.fn(() => builtMenu),
  };
});

vi.mock('electron', () => ({
  app: electronMock.app,
  Menu: {
    buildFromTemplate: electronMock.buildFromTemplate,
  },
}));

import { AppMenuService } from './app-menu';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

function createHarness() {
  let authStateChangeCallback: (() => void) | null = null;
  const authService = {
    authState: { status: 'unauthenticated' },
    registerAuthStateChangeCallback: vi.fn((callback: () => void) => {
      authStateChangeCallback = callback;
    }),
    unregisterAuthStateChangeCallback: vi.fn(),
    logout: vi.fn(),
  };
  const windowLayoutService = {
    openSettings: vi.fn(),
    openUrl: vi.fn(),
    toggleUIDevTools: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
  };

  const service = new AppMenuService(
    logger as never,
    authService as never,
    windowLayoutService as never,
  );

  return {
    service,
    authService,
    getAuthStateChangeCallback: () => authStateChangeCallback,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.app.applicationMenu = null;
});

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});

describe.each([
  'win32',
  'linux',
] as const)('AppMenuService on %s', (platform) => {
  it('keeps the native application menu removed after auth refreshes', async () => {
    setPlatform(platform);
    electronMock.app.applicationMenu = { id: 'stale-menu' };

    const harness = createHarness();

    expect(electronMock.app.applicationMenu).toBeNull();
    expect(electronMock.buildFromTemplate).not.toHaveBeenCalled();

    electronMock.app.applicationMenu = { id: 'stale-menu-after-auth' };
    harness.getAuthStateChangeCallback()?.();

    expect(electronMock.app.applicationMenu).toBeNull();
    expect(electronMock.buildFromTemplate).not.toHaveBeenCalled();

    await harness.service.teardown();
    expect(
      harness.authService.unregisterAuthStateChangeCallback,
    ).toHaveBeenCalledWith(harness.getAuthStateChangeCallback());
  });
});

describe('AppMenuService on darwin', () => {
  it('installs and refreshes the native application menu', async () => {
    setPlatform('darwin');

    const harness = createHarness();

    expect(electronMock.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(electronMock.app.applicationMenu).toBe(electronMock.builtMenu);

    harness.getAuthStateChangeCallback()?.();

    expect(electronMock.buildFromTemplate).toHaveBeenCalledTimes(2);
    expect(electronMock.app.applicationMenu).toBe(electronMock.builtMenu);

    await harness.service.teardown();
    expect(electronMock.app.applicationMenu).toBeNull();
  });
});
