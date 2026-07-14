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
  preAsynchronousTeardowns?: readonly ShutdownTask[];
  asynchronousTeardowns: readonly ShutdownTask[];
  shutdownBudgetMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => void;
  scheduleImmediate?: (callback: () => void) => void;
}

interface TeardownResource {
  teardown(): Promise<void> | void;
}

interface FlushResource {
  flush(): Promise<void> | void;
}

export interface MainShutdownCoordinatorOptions {
  logger: ShutdownLogger;
  exitApp: (exitCode: number) => void;
  preferenceListenerTeardowns: {
    agentBehaviorPreferenceListener: () => void;
    agentOsFeatureGatePreferenceListener: () => void;
    updateEvidenceMemorySummaryModel: () => void;
  };
  synchronousServices: {
    localPortsScannerService: TeardownResource;
    webDataService: TeardownResource;
    historyService: TeardownResource;
    faviconService: TeardownResource;
    memoryNotesSettingsService: TeardownResource;
    evidenceMemoryInspectorService: TeardownResource;
    dictationService: TeardownResource;
    hostedPullRequestService: TeardownResource;
    quickTaskWindowService: TeardownResource;
    diffHistoryService: TeardownResource;
    agentCorePersistence: TeardownResource;
    assetCacheService: TeardownResource;
    autoUpdateService: TeardownResource;
    agentPowerSaveBlockerService: TeardownResource;
    macOSClosedLidSleepService: TeardownResource;
    agentRuntimeRecoveryService: TeardownResource;
    cloudTaskArtifactService: TeardownResource | null | undefined;
  };
  asynchronousServices: {
    safeCodingProductionAuthorityService: TeardownResource;
    automationService: TeardownResource;
    artifactBridgeFrameBroker: TeardownResource;
    artifactBridgeService: TeardownResource;
    spacesService: TeardownResource;
    sessionContinuityService: TeardownResource;
    cloudTaskTeleportController: TeardownResource;
    cloudTaskTeleportRecovery: TeardownResource | null | undefined;
    cloudTaskMemorySyncJournal: FlushResource | null | undefined;
    agentOsService: TeardownResource | null | undefined;
    remoteConnectionsService: TeardownResource;
    pluginMarketplaceService: TeardownResource;
    privateMarketplaceSourcesService: TeardownResource;
    mcpSettingsService: TeardownResource;
    mcpRegistryService: TeardownResource;
    networkEgressControlService: TeardownResource | null | undefined;
    controlledBrowserEgressSession: TeardownResource | null | undefined;
    transparentEgressProxy: TeardownResource | null | undefined;
    mcpOAuthService: TeardownResource;
    toolboxService: TeardownResource;
    telemetryService: TeardownResource;
    agentHostProcessService: TeardownResource | null | undefined;
    agentManagerService: TeardownResource;
  };
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
  private readonly preAsynchronousTeardowns: readonly ShutdownTask[];
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
    this.preAsynchronousTeardowns = options.preAsynchronousTeardowns ?? [];
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

      const asynchronousTeardowns = (async () => {
        for (const task of this.preAsynchronousTeardowns) {
          await runAsynchronousTeardown(task);
        }
        await Promise.all(
          this.asynchronousTeardowns.map(runAsynchronousTeardown),
        );
      })();

      void Promise.race([
        asynchronousTeardowns,
        new Promise<void>((resolve) => {
          this.scheduleTimeout(() => {
            // Keep an observable trace when the shared deadline wins while
            // one or more service teardowns are still running.
            this.logger.warn(
              `[Main] Shutdown budget of ${this.shutdownBudgetMs}ms expired, some async teardowns may be incomplete`,
            );
            resolve();
          }, this.shutdownBudgetMs);
        }),
      ]).finally(() => {
        // Give libuv one final turn to drain pending ThreadSafeFunction calls
        // before Electron starts FreeEnvironment.
        this.scheduleImmediate(exitApp);
      });
    } catch (error) {
      this.logger.error(`[Main] Shutdown failed: ${String(error)}`);
      exitApp();
    }
  };
}

const teardownTask = (
  name: string,
  resource: TeardownResource | null | undefined,
): ShutdownTask => ({
  name,
  teardown: () => resource?.teardown(),
});

/**
 * Composes the concrete browser-main teardown inventory without keeping the
 * orchestration algorithm or the full service list inside main().
 */
export function createMainShutdownCoordinator(
  options: MainShutdownCoordinatorOptions,
): ShutdownCoordinator {
  const {
    preferenceListenerTeardowns,
    synchronousServices,
    asynchronousServices,
  } = options;

  return new ShutdownCoordinator({
    logger: options.logger,
    exitApp: options.exitApp,
    shutdownBudgetMs: DEFAULT_SHUTDOWN_BUDGET_MS,
    preAsynchronousTeardowns: [
      // Stop admitting production authority operations and drain any active
      // operation before effect-serving dependencies begin teardown.
      teardownTask(
        'safeCodingProductionAuthorityService',
        asynchronousServices.safeCodingProductionAuthorityService,
      ),
    ],
    synchronousTeardowns: [
      {
        name: 'agentBehaviorPreferenceListener',
        teardown: preferenceListenerTeardowns.agentBehaviorPreferenceListener,
      },
      {
        name: 'agentOsFeatureGatePreferenceListener',
        teardown:
          preferenceListenerTeardowns.agentOsFeatureGatePreferenceListener,
      },
      {
        name: 'updateEvidenceMemorySummaryModel',
        teardown: preferenceListenerTeardowns.updateEvidenceMemorySummaryModel,
      },
      teardownTask(
        'localPortsScannerService',
        synchronousServices.localPortsScannerService,
      ),
      teardownTask('webDataService', synchronousServices.webDataService),
      teardownTask('historyService', synchronousServices.historyService),
      teardownTask('faviconService', synchronousServices.faviconService),
      teardownTask(
        'memoryNotesSettingsService',
        synchronousServices.memoryNotesSettingsService,
      ),
      teardownTask(
        'evidenceMemoryInspectorService',
        synchronousServices.evidenceMemoryInspectorService,
      ),
      teardownTask('dictationService', synchronousServices.dictationService),
      teardownTask(
        'hostedPullRequestService',
        synchronousServices.hostedPullRequestService,
      ),
      teardownTask(
        'quickTaskWindowService',
        synchronousServices.quickTaskWindowService,
      ),
      teardownTask(
        'diffHistoryService',
        synchronousServices.diffHistoryService,
      ),
      teardownTask(
        'agentCorePersistence',
        synchronousServices.agentCorePersistence,
      ),
      teardownTask('assetCacheService', synchronousServices.assetCacheService),
      teardownTask('autoUpdateService', synchronousServices.autoUpdateService),
      teardownTask(
        'agentPowerSaveBlockerService',
        synchronousServices.agentPowerSaveBlockerService,
      ),
      teardownTask(
        'macOSClosedLidSleepService',
        synchronousServices.macOSClosedLidSleepService,
      ),
      teardownTask(
        'agentRuntimeRecoveryService',
        synchronousServices.agentRuntimeRecoveryService,
      ),
      teardownTask(
        'cloudTaskArtifactService',
        synchronousServices.cloudTaskArtifactService,
      ),
    ],
    // Shared budget for async teardowns. Toolbox teardown kills live PTY
    // sessions before Node env teardown begins — this prevents the node-pty
    // ThreadSafeFunction crash during app.exit(). Telemetry flush shares it.
    asynchronousTeardowns: [
      teardownTask('automationService', asynchronousServices.automationService),
      {
        name: 'artifactBridgeFrameBrokerAndService',
        teardown: async () => {
          try {
            await asynchronousServices.artifactBridgeFrameBroker.teardown();
          } finally {
            await asynchronousServices.artifactBridgeService.teardown();
          }
        },
      },
      teardownTask('spacesService', asynchronousServices.spacesService),
      teardownTask(
        'sessionContinuityService',
        asynchronousServices.sessionContinuityService,
      ),
      teardownTask(
        'cloudTaskTeleportController',
        asynchronousServices.cloudTaskTeleportController,
      ),
      teardownTask(
        'cloudTaskTeleportRecovery',
        asynchronousServices.cloudTaskTeleportRecovery,
      ),
      {
        name: 'cloudTaskMemorySyncJournal',
        teardown: () =>
          asynchronousServices.cloudTaskMemorySyncJournal?.flush(),
      },
      teardownTask('agentOsService', asynchronousServices.agentOsService),
      teardownTask(
        'remoteConnectionsService',
        asynchronousServices.remoteConnectionsService,
      ),
      teardownTask(
        'pluginMarketplaceService',
        asynchronousServices.pluginMarketplaceService,
      ),
      teardownTask(
        'privateMarketplaceSourcesService',
        asynchronousServices.privateMarketplaceSourcesService,
      ),
      teardownTask(
        'mcpSettingsService',
        asynchronousServices.mcpSettingsService,
      ),
      teardownTask(
        'mcpRegistryService',
        asynchronousServices.mcpRegistryService,
      ),
      teardownTask(
        'networkEgressControlService',
        asynchronousServices.networkEgressControlService,
      ),
      teardownTask(
        'controlledBrowserEgressSession',
        asynchronousServices.controlledBrowserEgressSession,
      ),
      teardownTask(
        'transparentEgressProxy',
        asynchronousServices.transparentEgressProxy,
      ),
      teardownTask('mcpOAuthService', asynchronousServices.mcpOAuthService),
      teardownTask('toolboxService', asynchronousServices.toolboxService),
      teardownTask('telemetryService', asynchronousServices.telemetryService),
      teardownTask(
        'agentHostProcessService',
        asynchronousServices.agentHostProcessService,
      ),
      // Tail-flush active agents so the latest in-flight stream chunk lands in
      // `agentMessages`; AgentManager awaits one final persist per agent.
      teardownTask(
        'agentManagerService',
        asynchronousServices.agentManagerService,
      ),
    ],
  });
}
