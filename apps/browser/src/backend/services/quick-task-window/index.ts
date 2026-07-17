import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
} from 'electron';
import type { AgentManagerService } from '@/services/agent-manager';
import { DisposableService } from '@/services/disposable';
import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import type { WindowLayoutService } from '@/services/window-layout';
import { getAvailableModel } from '@shared/available-models';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import {
  QUICK_TASK_WINDOW_CHANNELS,
  type QuickTaskWindowContext,
  type QuickTaskWindowSubmitInput,
  type QuickTaskWindowSubmitResult,
} from '@shared/quick-task-window';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const QUICK_TASK_ACCELERATOR = 'CommandOrControl+Shift+N';
const QUICK_TASK_WIDTH = 720;
const QUICK_TASK_HEIGHT = 520;
const MAX_PROMPT_LENGTH = 100_000;
const SUCCESS_REVEAL_DURATION_MS = 650;

type QuickTaskWindowServiceDeps = {
  logger: Logger;
  karton: KartonService;
  agentManagerService: AgentManagerService;
  windowLayoutService: WindowLayoutService;
  canUseQuickTask?: () => boolean;
};

export class QuickTaskWindowService extends DisposableService {
  private readonly logger: Logger;
  private readonly karton: KartonService;
  private readonly agentManagerService: AgentManagerService;
  private readonly windowLayoutService: WindowLayoutService;
  private readonly canUseQuickTask: () => boolean;
  private window: BrowserWindow | null = null;
  private loaded = false;
  private desiredVisibility = false;
  private requestId = 0;
  private currentContext: QuickTaskWindowContext;
  private draftAgentId: string | null = null;
  private activeSubmission: Promise<QuickTaskWindowSubmitResult> | null = null;
  private completedAgentId: string | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private registeredGlobalShortcut = false;
  private readonly mainWindowCloseListener = () => this.destroyWindow();

  private constructor(deps: QuickTaskWindowServiceDeps) {
    super();
    this.logger = deps.logger;
    this.karton = deps.karton;
    this.agentManagerService = deps.agentManagerService;
    this.windowLayoutService = deps.windowLayoutService;
    this.canUseQuickTask = deps.canUseQuickTask ?? (() => true);
    this.currentContext = this.buildContext('');
  }

  public static async create(
    deps: QuickTaskWindowServiceDeps,
  ): Promise<QuickTaskWindowService> {
    const service = new QuickTaskWindowService(deps);
    service.registerIpcHandlers();
    service.registerGlobalShortcut();
    deps.windowLayoutService
      .getBaseWindow()
      ?.on('close', service.mainWindowCloseListener);
    return service;
  }

  public async show(initialPrompt = ''): Promise<boolean> {
    this.assertNotDisposed();
    if (!this.canUseQuickTask()) {
      this.logger.debug(
        '[QuickTaskWindowService] Blocked until the required first-run choice is complete',
      );
      return false;
    }
    try {
      if (this.completedAgentId) await this.finalizeCompletedTask();
      if (this.activeSubmission) {
        this.desiredVisibility = true;
        const activeWindow = this.ensureWindow();
        this.positionOnActiveDisplay(activeWindow);
        if (this.loaded) this.revealWindow(activeWindow);
        return true;
      }
      this.requestId += 1;
      this.draftAgentId = null;
      this.currentContext = this.buildContext(initialPrompt);
      this.desiredVisibility = true;
      const window = this.ensureWindow();
      this.positionOnActiveDisplay(window);
      if (this.loaded) {
        this.sendContext();
        this.revealWindow(window);
      }
      return true;
    } catch (error) {
      this.desiredVisibility = false;
      this.logger.warn('[QuickTaskWindowService] Failed to show window', error);
      return false;
    }
  }

  public async toggle(initialPrompt = ''): Promise<boolean> {
    this.assertNotDisposed();
    if (!this.canUseQuickTask()) return false;
    if (this.completedAgentId) {
      await this.finalizeCompletedTask();
      return true;
    }
    if (this.desiredVisibility || this.window?.isVisible()) {
      this.hide();
      return true;
    }
    return this.show(initialPrompt);
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const preloadPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'quick-task-preload/index.js',
    );
    const window = new BrowserWindow({
      width: QUICK_TASK_WIDTH,
      height: QUICK_TASK_HEIGHT,
      minWidth: QUICK_TASK_WIDTH,
      minHeight: QUICK_TASK_HEIGHT,
      maxWidth: QUICK_TASK_WIDTH,
      maxHeight: QUICK_TASK_HEIGHT,
      show: false,
      frame: false,
      transparent: process.platform === 'darwin',
      backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f9f9f9',
      roundedCorners: true,
      hasShadow: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Quick task',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:clodex-quick-task',
      },
    });
    this.window = window;
    this.loaded = false;

    if (process.platform === 'darwin') {
      window.setAlwaysOnTop(true, 'floating');
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.once('did-finish-load', () => {
      if (window.isDestroyed()) return;
      this.loaded = true;
      this.sendContext();
      if (this.desiredVisibility) {
        this.positionOnActiveDisplay(window);
        this.revealWindow(window);
      }
    });
    window.on('blur', () => {
      if (!window.webContents.isDevToolsOpened()) this.hide();
    });
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null;
        this.loaded = false;
        this.desiredVisibility = false;
      }
    });

    const devServerUrl =
      typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
        ? MAIN_WINDOW_VITE_DEV_SERVER_URL
        : '';
    if (devServerUrl) {
      const url = new URL(devServerUrl);
      url.searchParams.set('window', 'quick-task');
      void window.loadURL(url.toString());
    } else {
      const rendererName =
        typeof MAIN_WINDOW_VITE_NAME === 'string'
          ? MAIN_WINDOW_VITE_NAME
          : 'main_window';
      const rendererPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `../renderer/${rendererName}/index.html`,
      );
      void window.loadFile(rendererPath, {
        query: { window: 'quick-task' },
      });
    }

    return window;
  }

  private buildContext(initialPrompt: string): QuickTaskWindowContext {
    const currentAgentId = this.karton.state.browser.lastOpenAgentId;
    const currentAgent = currentAgentId
      ? this.karton.state.agents.instances[currentAgentId]?.state
      : undefined;
    const mounts = currentAgentId
      ? (this.karton.state.toolbox[currentAgentId]?.workspace.mounts ?? [])
      : [];
    const model = currentAgent?.activeModelId
      ? getAvailableModel(currentAgent.activeModelId)
      : undefined;

    return {
      requestId: this.requestId,
      initialPrompt: initialPrompt.slice(0, MAX_PROMPT_LENGTH),
      modelLabel:
        model?.modelDisplayName ?? currentAgent?.activeModelId ?? 'Last used',
      approvalLabel: currentAgent?.toolApprovalMode ?? 'Default',
      workspaceLabels: mounts.map(
        (mount) => path.basename(mount.path) || mount.path,
      ),
      hasCurrentWorkspace: mounts.length > 0,
    };
  }

  private async submit(input: unknown): Promise<QuickTaskWindowSubmitResult> {
    if (!this.canUseQuickTask()) {
      return {
        ok: false,
        error:
          'Complete the required privacy choice in the main CLODEx window before starting a task.',
        retryable: true,
      };
    }
    const payload =
      input && typeof input === 'object'
        ? (input as Partial<QuickTaskWindowSubmitInput>)
        : {};
    if (
      typeof payload.requestId !== 'number' ||
      payload.requestId !== this.currentContext.requestId
    ) {
      return {
        ok: false,
        error:
          'This Quick Task window was refreshed. Review the task and submit it again.',
        retryable: true,
      };
    }

    const prompt =
      typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) {
      return {
        ok: false,
        error: 'Enter a task before submitting.',
        retryable: true,
      };
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return {
        ok: false,
        error: 'The task is too long. Shorten it and try again.',
        retryable: true,
      };
    }

    if (this.activeSubmission) return this.activeSubmission;

    const submission = this.performSubmit(
      prompt,
      payload.useCurrentWorkspace === true,
    );
    this.activeSubmission = submission;
    try {
      return await submission;
    } finally {
      if (this.activeSubmission === submission) this.activeSubmission = null;
    }
  }

  private async performSubmit(
    prompt: string,
    useCurrentWorkspace: boolean,
  ): Promise<QuickTaskWindowSubmitResult> {
    const currentAgentId = this.karton.state.browser.lastOpenAgentId;
    const currentAgent = currentAgentId
      ? this.karton.state.agents.instances[currentAgentId]?.state
      : undefined;
    const currentMounts = currentAgentId
      ? (this.karton.state.toolbox[currentAgentId]?.workspace.mounts ?? [])
      : [];

    try {
      let agentId = this.draftAgentId;
      if (!agentId) {
        const workspacePaths =
          useCurrentWorkspace && currentMounts.length > 0
            ? currentMounts.map((mount) => mount.path)
            : undefined;
        const created = await this.agentManagerService.dispatchCommand(
          'agents.create',
          [
            undefined,
            currentAgent?.activeModelId,
            currentAgent?.toolApprovalMode,
            workspacePaths,
            Boolean(workspacePaths?.length),
          ],
          'quick-task-window',
        );
        if (typeof created !== 'string' || !created) {
          throw new Error('Agent creation returned an invalid identifier');
        }
        agentId = created;
        this.draftAgentId = agentId;
      }

      const message: AgentMessage & { role: 'user' } = {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          swarmMode: false,
        },
      };
      await this.agentManagerService.dispatchCommand(
        'agents.sendUserMessage',
        [agentId, message],
        'quick-task-window',
      );

      this.draftAgentId = null;
      if (!this.disposed) this.scheduleCompletedTaskOpen(agentId);
      return { ok: true, agentId };
    } catch (error) {
      this.logger.warn('[QuickTaskWindowService] Submit failed', {
        error: error instanceof Error ? error.message : String(error),
        draftCreated: this.draftAgentId !== null,
      });
      return {
        ok: false,
        error: this.draftAgentId
          ? 'The task was created, but the message could not be sent. Retry to continue in the same task.'
          : 'The quick task could not be created. Please try again.',
        retryable: true,
      };
    }
  }

  private registerIpcHandlers(): void {
    ipcMain.handle(
      QUICK_TASK_WINDOW_CHANNELS.show,
      async (event, request: unknown) => {
        if (!this.isMainRenderer(event)) return false;
        const payload =
          request && typeof request === 'object'
            ? (request as {
                initialPrompt?: unknown;
                toggle?: unknown;
              })
            : { initialPrompt: request };
        const initialPrompt =
          typeof payload.initialPrompt === 'string'
            ? payload.initialPrompt
            : '';
        return payload.toggle === true
          ? this.toggle(initialPrompt)
          : this.show(initialPrompt);
      },
    );
    ipcMain.handle(QUICK_TASK_WINDOW_CHANNELS.getContext, async (event) => {
      this.assertQuickTaskRenderer(event);
      return this.currentContext;
    });
    ipcMain.handle(
      QUICK_TASK_WINDOW_CHANNELS.submit,
      async (event, input: unknown) => {
        this.assertQuickTaskRenderer(event);
        return this.submit(input);
      },
    );
    ipcMain.handle(QUICK_TASK_WINDOW_CHANNELS.close, async (event) => {
      this.assertQuickTaskRenderer(event);
      this.hide();
    });
  }

  private registerGlobalShortcut(): void {
    this.registeredGlobalShortcut = globalShortcut.register(
      QUICK_TASK_ACCELERATOR,
      () => void this.toggle(),
    );
    if (!this.registeredGlobalShortcut) {
      this.logger.warn(
        `[QuickTaskWindowService] Could not register ${QUICK_TASK_ACCELERATOR}; in-app fallback remains available`,
      );
    }
  }

  private isMainRenderer(event: IpcMainInvokeEvent): boolean {
    return event.sender === this.windowLayoutService.getUIWebContents();
  }

  private assertQuickTaskRenderer(event: IpcMainInvokeEvent): void {
    if (!this.window || event.sender !== this.window.webContents) {
      throw new Error('Quick Task IPC rejected for an unknown renderer');
    }
  }

  private positionOnActiveDisplay(window: BrowserWindow): void {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    window.setBounds(calculateQuickTaskWindowBounds(display.workArea));
  }

  private revealWindow(window: BrowserWindow): void {
    if (!this.desiredVisibility || window.isDestroyed()) return;
    window.show();
    window.moveTop();
    window.focus();
    window.webContents.focus();
  }

  private sendContext(): void {
    if (!this.window || this.window.isDestroyed() || !this.loaded) return;
    this.window.webContents.send(
      QUICK_TASK_WINDOW_CHANNELS.context,
      this.currentContext,
    );
  }

  private hide(): void {
    this.desiredVisibility = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  private scheduleCompletedTaskOpen(agentId: string): void {
    this.clearCompletionTimer();
    this.completedAgentId = agentId;
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      void this.finalizeCompletedTask();
    }, SUCCESS_REVEAL_DURATION_MS);
  }

  private async finalizeCompletedTask(): Promise<void> {
    const agentId = this.completedAgentId;
    if (!agentId) return;
    this.completedAgentId = null;
    this.clearCompletionTimer();
    this.hide();
    try {
      await this.windowLayoutService.focusAgentFromExternalWindow(agentId);
    } catch (error) {
      this.logger.warn(
        '[QuickTaskWindowService] Failed to focus completed task',
        error,
      );
    }
  }

  private clearCompletionTimer(): void {
    if (this.completionTimer === null) return;
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  private destroyWindow(): void {
    this.draftAgentId = null;
    this.activeSubmission = null;
    this.completedAgentId = null;
    this.clearCompletionTimer();
    this.desiredVisibility = false;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loaded = false;
  }

  protected onTeardown(): void {
    this.windowLayoutService
      .getBaseWindow()
      ?.removeListener('close', this.mainWindowCloseListener);
    if (this.registeredGlobalShortcut) {
      globalShortcut.unregister(QUICK_TASK_ACCELERATOR);
      this.registeredGlobalShortcut = false;
    }
    for (const channel of [
      QUICK_TASK_WINDOW_CHANNELS.show,
      QUICK_TASK_WINDOW_CHANNELS.getContext,
      QUICK_TASK_WINDOW_CHANNELS.submit,
      QUICK_TASK_WINDOW_CHANNELS.close,
    ]) {
      ipcMain.removeHandler(channel);
    }
    this.destroyWindow();
    this.logger.debug('[QuickTaskWindowService] Teardown complete');
  }
}

export function calculateQuickTaskWindowBounds(
  workArea: Electron.Rectangle,
): Electron.Rectangle {
  const centeredX = Math.round(
    workArea.x + (workArea.width - QUICK_TASK_WIDTH) / 2,
  );
  const maximumX = workArea.x + workArea.width - QUICK_TASK_WIDTH;
  const yOffset = Math.max(
    24,
    Math.round((workArea.height - QUICK_TASK_HEIGHT) * 0.28),
  );
  const maximumY = workArea.y + workArea.height - QUICK_TASK_HEIGHT;

  return {
    width: QUICK_TASK_WIDTH,
    height: QUICK_TASK_HEIGHT,
    x:
      workArea.width < QUICK_TASK_WIDTH
        ? workArea.x
        : Math.min(centeredX, maximumX),
    y:
      workArea.height < QUICK_TASK_HEIGHT
        ? workArea.y
        : Math.min(workArea.y + yOffset, maximumY),
  };
}
