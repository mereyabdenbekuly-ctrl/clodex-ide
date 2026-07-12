export const DEFAULT_SHUTDOWN_BUDGET_MS = 1_000;

export interface ShutdownEvent {
  preventDefault(): void;
}

export interface ShutdownLogger {
  debug(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string): void;
}

export interface ShutdownTask {
  name: string;
  teardown: () => Promise<void> | void;
}

export interface ShutdownCoordinatorOptions {
  logger: ShutdownLogger;
  exitApp: (exitCode: number) => void;
  synchronousTeardowns: readonly ShutdownTask[];
  asynchronousTeardowns: readonly ShutdownTask[];
  shutdownBudgetMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => void;
  scheduleImmediate?: (callback: () => void) => void;
}

/**
 * Coordinates the existing Electron main-process shutdown contract.
 *
 * The coordinator intentionally preserves the current observable behavior:
 * synchronous teardowns run in declaration order, asynchronous teardowns share
 * one deadline, individual failures are logged and ignored, and a repeated
 * will-quit event is ignored after the first invocation.
 */
export class ShutdownCoordinator {
  private isShuttingDown = false;

  private readonly logger: ShutdownLogger;
  private readonly exitApp: (exitCode: number) => void;
  private readonly synchronousTeardowns: readonly ShutdownTask[];
  private readonly asynchronousTeardowns: readonly ShutdownTask[];
  private readonly shutdownBudgetMs: number;
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => void;
  private readonly scheduleImmediate: (callback: () => void) => void;

  public constructor(options: ShutdownCoordinatorOptions) {
    this.logger = options.logger;
    this.exitApp = options.exitApp;
    this.synchronousTeardowns = options.synchronousTeardowns;
    this.asynchronousTeardowns = options.asynchronousTeardowns;
    this.shutdownBudgetMs =
      options.shutdownBudgetMs ?? DEFAULT_SHUTDOWN_BUDGET_MS;
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, delayMs) => {
        setTimeout(callback, delayMs);
      });
    this.scheduleImmediate =
      options.scheduleImmediate ??
      ((callback) => {
        setImmediate(callback);
      });
  }

  public readonly handleWillQuit = (event: ShutdownEvent): void => {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    event.preventDefault();

    const runSynchronousTeardown = (task: ShutdownTask) => {
      try {
        void task.teardown();
      } catch (error) {
        this.logger.warn(`[Main] Failed to teardown ${task.name}`, error);
      }
    };

    const exitApp = () => {
      this.logger.debug('[Main] Services shut down');
      this.exitApp(0);
    };

    try {
      this.logger.debug('[Main] Shutting down services...');
      for (const task of this.synchronousTeardowns) {
        runSynchronousTeardown(task);
      }

      const runAsynchronousTeardown = (task: ShutdownTask) =>
        Promise.resolve()
          .then(() => task.teardown())
          .catch((error) => {
            this.logger.warn(`[Main] Failed to teardown ${task.name}`, error);
          });

      const asynchronousTeardowns = Promise.all(
        this.asynchronousTeardowns.map(runAsynchronousTeardown),
      );

      void Promise.race([
        asynchronousTeardowns,
        new Promise<void>((resolve) => {
          this.scheduleTimeout(() => {
            this.logger.warn(
              `[Main] Shutdown budget of ${this.shutdownBudgetMs}ms expired, some async teardowns may be incomplete`,
            );
            resolve();
          }, this.shutdownBudgetMs);
        }),
      ]).finally(() => {
        this.scheduleImmediate(exitApp);
      });
    } catch (error) {
      this.logger.error(`[Main] Shutdown failed: ${String(error)}`);
      exitApp();
    }
  };
}
