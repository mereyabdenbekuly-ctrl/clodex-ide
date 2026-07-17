import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  ipcHandlers: new Map<
    string,
    (event: { sender: unknown }, ...args: unknown[]) => unknown
  >(),
  latestWindow: null as any,
  autoFinishLoad: true,
  cursorPoint: { x: 100, y: 100 },
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
  globalShortcutCallback: null as (() => void) | null,
}));

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events');

  class MockWebContents extends MockEventEmitter {
    public devToolsOpened = false;
    public setWindowOpenHandler = vi.fn();
    public send = vi.fn();
    public focus = vi.fn();
    public isDevToolsOpened = () => this.devToolsOpened;
  }

  class MockBrowserWindow extends MockEventEmitter {
    public readonly webContents = new MockWebContents();
    private destroyed = false;
    private visible = false;
    public loadURL = vi.fn(async () => {
      if (electronMock.autoFinishLoad) this.webContents.emit('did-finish-load');
    });
    public loadFile = vi.fn(async () => {
      if (electronMock.autoFinishLoad) this.webContents.emit('did-finish-load');
    });
    public show = vi.fn(() => {
      this.visible = true;
    });
    public hide = vi.fn(() => {
      this.visible = false;
    });
    public focus = vi.fn();
    public moveTop = vi.fn();
    public setBounds = vi.fn();
    public setAlwaysOnTop = vi.fn();
    public setVisibleOnAllWorkspaces = vi.fn();
    public isDestroyed = () => this.destroyed;
    public isVisible = () => this.visible;
    public destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit('closed');
    });

    constructor(_options: unknown) {
      super();
      electronMock.latestWindow = this;
    }
  }

  return {
    BrowserWindow: MockBrowserWindow,
    globalShortcut: {
      register: vi.fn((_accelerator: string, callback: () => void) => {
        electronMock.globalShortcutCallback = callback;
        return true;
      }),
      unregister: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: { sender: unknown }, ...args: unknown[]) => unknown,
        ) => {
          electronMock.ipcHandlers.set(channel, handler);
        },
      ),
      removeHandler: vi.fn((channel: string) => {
        electronMock.ipcHandlers.delete(channel);
      }),
    },
    screen: {
      getCursorScreenPoint: vi.fn(() => electronMock.cursorPoint),
      getDisplayNearestPoint: vi.fn(() => ({
        workArea: electronMock.workArea,
      })),
    },
  };
});

import type { AgentManagerService } from '@/services/agent-manager';
import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import type { WindowLayoutService } from '@/services/window-layout';
import { QUICK_TASK_WINDOW_CHANNELS } from '@shared/quick-task-window';
import {
  calculateQuickTaskWindowBounds,
  QuickTaskWindowService,
} from './index';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

function createDeps() {
  const mainRenderer = {};
  const mainWindow = new EventEmitter();
  const karton = {
    state: {
      browser: { lastOpenAgentId: null },
      agents: { instances: {} },
      toolbox: {},
    },
  } as unknown as KartonService;
  const dispatchCommand = vi.fn(async (name: string): Promise<unknown> => {
    if (name === 'agents.create') return 'agent-new';
    return undefined;
  });
  const agentManagerService = {
    dispatchCommand,
  } as unknown as AgentManagerService;
  const focusAgentFromExternalWindow = vi.fn(async () => undefined);
  const windowLayoutService = {
    getBaseWindow: () => mainWindow,
    getUIWebContents: () => mainRenderer,
    focusAgentFromExternalWindow,
  } as unknown as WindowLayoutService;

  return {
    karton,
    agentManagerService,
    windowLayoutService,
    dispatchCommand,
    focusAgentFromExternalWindow,
  };
}

beforeEach(() => {
  electronMock.ipcHandlers.clear();
  electronMock.latestWindow = null;
  electronMock.autoFinishLoad = true;
  electronMock.cursorPoint = { x: 100, y: 100 };
  electronMock.workArea = { x: 0, y: 0, width: 1440, height: 900 };
  electronMock.globalShortcutCallback = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QuickTaskWindowService', () => {
  it('blocks window creation and submission until the required choice is complete', async () => {
    const deps = createDeps();
    let allowed = false;
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
      canUseQuickTask: () => allowed,
    });

    await expect(service.show('Blocked task')).resolves.toBe(false);
    expect(electronMock.latestWindow).toBeNull();

    allowed = true;
    await expect(service.show('Allowed task')).resolves.toBe(true);
    expect(electronMock.latestWindow).not.toBeNull();

    allowed = false;
    const submit = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.submit,
    );
    const result = await submit?.(
      { sender: electronMock.latestWindow?.webContents },
      { requestId: 1, prompt: 'Still blocked' },
    );
    expect(result).toEqual({
      ok: false,
      error:
        'Complete the required privacy choice in the main CLODEx window before starting a task.',
      retryable: true,
    });
    expect(deps.dispatchCommand).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('opens a dedicated window and exposes the current context', async () => {
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });

    await expect(service.show('Review this branch')).resolves.toBe(true);
    expect(electronMock.latestWindow).not.toBeNull();
    expect(electronMock.latestWindow?.show).toHaveBeenCalled();

    const getContext = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.getContext,
    );
    const context = await getContext?.({
      sender: electronMock.latestWindow?.webContents,
    });
    expect(context).toMatchObject({
      initialPrompt: 'Review this branch',
      modelLabel: 'Last used',
      approvalLabel: 'Default',
      hasCurrentWorkspace: false,
    });

    await service.teardown();
  });

  it('creates an agent, sends the prompt, and focuses the main window', async () => {
    vi.useFakeTimers();
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });
    await service.show();

    const submit = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.submit,
    );
    const result = await submit?.(
      { sender: electronMock.latestWindow?.webContents },
      { requestId: 1, prompt: 'Run the tests', useCurrentWorkspace: false },
    );

    expect(result).toEqual({ ok: true, agentId: 'agent-new' });
    expect(deps.dispatchCommand).toHaveBeenNthCalledWith(
      1,
      'agents.create',
      [undefined, undefined, undefined, undefined, false],
      'quick-task-window',
    );
    expect(deps.dispatchCommand).toHaveBeenNthCalledWith(
      2,
      'agents.sendUserMessage',
      [
        'agent-new',
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Run the tests' }],
        }),
      ],
      'quick-task-window',
    );
    expect(deps.focusAgentFromExternalWindow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(650);

    expect(deps.focusAgentFromExternalWindow).toHaveBeenCalledWith('agent-new');
    expect(electronMock.latestWindow?.hide).toHaveBeenCalled();

    await service.teardown();
  });

  it('rejects show requests from non-main renderers', async () => {
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });
    const show = electronMock.ipcHandlers.get(QUICK_TASK_WINDOW_CHANNELS.show);

    await expect(
      Promise.resolve(
        show?.({ sender: {} }, { initialPrompt: '', toggle: false }),
      ),
    ).resolves.toBe(false);
    expect(electronMock.latestWindow).toBeNull();

    await service.teardown();
  });

  it('keeps a repeated shortcut closed while the renderer is still loading', async () => {
    electronMock.autoFinishLoad = false;
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });

    await expect(service.toggle()).resolves.toBe(true);
    expect(electronMock.latestWindow?.show).not.toHaveBeenCalled();

    await expect(service.toggle()).resolves.toBe(true);
    electronMock.latestWindow?.webContents.emit('did-finish-load');

    expect(electronMock.latestWindow?.show).not.toHaveBeenCalled();
    expect(electronMock.latestWindow?.hide).toHaveBeenCalled();

    await service.teardown();
  });

  it('focuses both the native window and its renderer when reopening', async () => {
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });

    await service.show('First');
    const firstShowCount = electronMock.latestWindow?.show.mock.calls.length;
    await service.show('Second');

    expect(electronMock.latestWindow?.show.mock.calls.length).toBeGreaterThan(
      firstShowCount,
    );
    expect(electronMock.latestWindow?.moveTop).toHaveBeenCalled();
    expect(electronMock.latestWindow?.focus).toHaveBeenCalled();
    expect(electronMock.latestWindow?.webContents.focus).toHaveBeenCalled();

    const getContext = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.getContext,
    );
    await expect(
      getContext?.({ sender: electronMock.latestWindow?.webContents }),
    ).resolves.toMatchObject({
      requestId: 2,
      initialPrompt: 'Second',
    });

    await service.teardown();
  });

  it('rejects stale submissions after the window context is refreshed', async () => {
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });
    await service.show('First');
    await service.show('Second');

    const submit = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.submit,
    );
    const result = await submit?.(
      { sender: electronMock.latestWindow?.webContents },
      { requestId: 1, prompt: 'Stale task', useCurrentWorkspace: false },
    );

    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(deps.dispatchCommand).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('coalesces duplicate submissions while agent creation is in flight', async () => {
    const deps = createDeps();
    let resolveCreate: (agentId: string) => void = (_agentId) => {
      throw new Error('Agent creation was not started');
    };
    deps.dispatchCommand.mockImplementation(async (name: string) => {
      if (name !== 'agents.create') return undefined;
      return new Promise<string>((resolve) => {
        resolveCreate = resolve;
      });
    });
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });
    await service.show();
    const submit = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.submit,
    );
    const input = {
      requestId: 1,
      prompt: 'Run once',
      useCurrentWorkspace: false,
    };

    const first = Promise.resolve(
      submit?.({ sender: electronMock.latestWindow?.webContents }, input),
    );
    const second = Promise.resolve(
      submit?.({ sender: electronMock.latestWindow?.webContents }, input),
    );
    resolveCreate('agent-new');

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, agentId: 'agent-new' },
      { ok: true, agentId: 'agent-new' },
    ]);
    expect(
      deps.dispatchCommand.mock.calls.filter(
        ([command]) => command === 'agents.create',
      ),
    ).toHaveLength(1);
    expect(
      deps.dispatchCommand.mock.calls.filter(
        ([command]) => command === 'agents.sendUserMessage',
      ),
    ).toHaveLength(1);

    await service.teardown();
  });

  it('reuses the draft task when retrying after message delivery fails', async () => {
    const deps = createDeps();
    let sendAttempts = 0;
    deps.dispatchCommand.mockImplementation(async (name: string) => {
      if (name === 'agents.create') return 'agent-new';
      if (name === 'agents.sendUserMessage' && sendAttempts++ === 0) {
        throw new Error('temporary send failure');
      }
      return undefined;
    });
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });
    await service.show();
    const submit = electronMock.ipcHandlers.get(
      QUICK_TASK_WINDOW_CHANNELS.submit,
    );
    const input = {
      requestId: 1,
      prompt: 'Retry this task',
      useCurrentWorkspace: false,
    };

    await expect(
      submit?.({ sender: electronMock.latestWindow?.webContents }, input),
    ).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(
      submit?.({ sender: electronMock.latestWindow?.webContents }, input),
    ).resolves.toEqual({ ok: true, agentId: 'agent-new' });
    expect(
      deps.dispatchCommand.mock.calls.filter(
        ([command]) => command === 'agents.create',
      ),
    ).toHaveLength(1);
    expect(
      deps.dispatchCommand.mock.calls.filter(
        ([command]) => command === 'agents.sendUserMessage',
      ),
    ).toHaveLength(2);

    await service.teardown();
  });

  it('hides the floating window when it loses focus', async () => {
    const deps = createDeps();
    const service = await QuickTaskWindowService.create({
      logger,
      karton: deps.karton,
      agentManagerService: deps.agentManagerService,
      windowLayoutService: deps.windowLayoutService,
    });
    await service.show();

    electronMock.latestWindow?.emit('blur');

    expect(electronMock.latestWindow?.hide).toHaveBeenCalled();
    await service.teardown();
  });

  it('positions the window within work areas on displays with negative coordinates', () => {
    expect(
      calculateQuickTaskWindowBounds({
        x: -1920,
        y: 24,
        width: 1920,
        height: 1056,
      }),
    ).toEqual({
      x: -1320,
      y: 174,
      width: 720,
      height: 520,
    });

    expect(
      calculateQuickTaskWindowBounds({
        x: 1600,
        y: -900,
        width: 600,
        height: 480,
      }),
    ).toEqual({
      x: 1600,
      y: -900,
      width: 720,
      height: 520,
    });
  });
});
