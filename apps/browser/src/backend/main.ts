/**
 * This file stores the main setup for the CLI.
 */

import { app, ipcMain, powerMonitor } from 'electron';
import { generateText } from 'ai';
import { AgentManagerService } from './services/agent-manager';
import { enrichHistoryEntryWorkspaces } from './services/agent-manager/history-workspace-enrichment';
import { Logger } from './services/logger';
import { createMainShutdownCoordinator } from './services/shutdown-coordinator';
import { isUIEventName, parseUIEventProperties } from './services/telemetry';
import {
  ChatPersistenceService,
  createAgentSessionCheckpoint,
  createWorkspaceSnapshot,
  findCompressedHistoryReference,
  hashSessionCheckpointHistory,
  type AgentHistoryEntry,
  type AgentManagerStartupPolicy,
  type AgentMessage,
} from '@clodex/agent-core';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import { WorktreeSetupSettingsService } from './services/worktree-setup-settings';
import { resolveFeatureGate } from '@shared/feature-gates';
import {
  getIsolatedAgentRuntimeRolloutPolicy,
  ISOLATED_AGENT_RUNTIME_DISABLE_SWITCH,
  isIsolatedAgentRuntimeDisabledByEnvironment,
} from '@shared/isolated-agent-runtime-policy';
import { createBrowserAgentTypeRegistry } from './agents/agents-registry';
import { buildLocalWorkspaceSnapshotMetadata } from './agent-host/workspace-snapshot-builder';
import { wirePagesRuntime } from './wiring/pages-runtime';
import { wireFileTreeSwarmRpc } from './wiring/file-tree-swarm-rpc';
import { wireSettingsBrowserRpc } from './wiring/settings-browser-rpc';
import { wireWorkspaceCredentialsRpc } from './wiring/workspace-credentials-rpc';
import {
  ensureDataDirectories,
  getArtifactBridgeAuditPath,
  getNetworkPolicyAuditPath,
} from './utils/paths';
import { migrateLegacyPaths } from './utils/migrate-legacy-paths';
import { readPersistedDataSync } from './utils/persisted-data';
import { z } from 'zod';
import { runFoundationalServicesPhase } from './startup/phases/foundational-services';
import { isCloudTaskKillSwitchActive } from '@shared/cloud-task-rollout';
import { initializeGuardianEgressStartup } from './services/network-policy/startup';
import path from 'node:path';
import {
  createCloudTaskRuntime,
  type CloudTaskRuntimeResult,
} from './startup/phases/cloud-task-runtime';
import { handleCommandLineUrls } from './startup/url-routing';
import { runBrowserUiServicesPhase } from './startup/phases/browser-ui-services';
import { runNotificationRuntimePhase } from './startup/phases/notification-runtime';
import {
  CloudTaskExecutionLeaseRegistry,
  createBrowserAgentStepExecutor,
  createExecutionTargetRouter,
} from './agent-host';
import { CloudTaskTeleportController } from './services/cloud-task-teleport';
import { createSwarmRuntime } from './services/swarm-runtime';
import { AgentOsService } from './services/agent-os';
import { GuardianService } from './services/guardian';
import { toGuardianAssessmentObservation } from './services/guardian/audit';
import { createNetworkGuardianRequest } from './services/guardian/requests';
import {
  GeneratedAppLibraryService,
  type GeneratedAppOwnerSnapshot,
} from './services/generated-app-library';
import { QuickTaskWindowService } from './services/quick-task-window';
import { CloudTaskArtifactService } from './services/cloud-task-artifacts';
import {
  AutomationService,
  createAutomationAgentMessage,
} from './services/automations';
import { NativeWakeScheduler } from './services/automations/native-wake';
import { ArtifactBridgeService } from './services/artifact-bridge';
import { ArtifactBridgeAuditLedger } from './services/artifact-bridge/audit-ledger';
import { ArtifactBridgeFrameBroker } from './services/artifact-bridge/frame-broker';
import { GeneratedAppIdentityResolver } from './services/generated-app-library/identity-resolver';
import { SpacesService } from './services/spaces';
import {
  SessionContinuityService,
  type SessionSharingAdapter,
} from './services/session-continuity';
import {
  parseSessionRecoveryAcceptancePhase,
  runSessionRecoveryAcceptance,
} from './session-recovery-acceptance';
import { SESSION_RECOVERY_ACCEPTANCE_SWITCH } from '../shared/session-recovery-acceptance';
import { runAgentCoreActivationPhase } from './startup/phases/agent-core-activation';
import { runAgentCoreFoundationPhase } from './startup/phases/agent-core-foundation';
import { prepareProtectedStorage } from './startup/phases/prepare-protected-storage';
import { runModelToolboxRuntimePhase } from './startup/phases/model-toolbox-runtime';
import { runPlatformIntegrationServicesPhase } from './startup/phases/platform-integration-services';

export type MainParameters = {
  launchOptions: {
    verbose?: boolean;
  };
};

export async function main({ launchOptions: { verbose } }: MainParameters) {
  // In this file you can include the rest of your app's specific main process
  // code. You can also put them in separate files and import them here.
  const logger = new Logger(verbose ?? false);
  let agentOsService: AgentOsService | null = null;
  const isolatedAgentRuntimePolicy = getIsolatedAgentRuntimeRolloutPolicy(
    __APP_RELEASE_CHANNEL__,
  );
  const isolatedAgentRuntimeKillSwitchActive =
    app.commandLine.hasSwitch(ISOLATED_AGENT_RUNTIME_DISABLE_SWITCH) ||
    isIsolatedAgentRuntimeDisabledByEnvironment(
      process.env.CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME,
    );
  if (isolatedAgentRuntimeKillSwitchActive) {
    logger.warn(
      '[Main] Isolated agent runtime disabled by emergency kill switch',
    );
  }

  migrateLegacyPaths(logger);

  await ensureDataDirectories();

  const {
    dataProtection,
    protectedFiles,
    protectedMigrationOrder,
    hostPaths,
    attachments,
  } = await prepareProtectedStorage(logger);

  const {
    preferencesService,
    identifierService,
    webDataService,
    faviconService,
    localPortsScannerService,
    telemetryService,
    startupFeatureEnabled,
  } = await runFoundationalServicesPhase({
    logger,
    releaseChannel: __APP_RELEASE_CHANNEL__,
  });
  const guardianEgressStartup = await initializeGuardianEgressStartup({
    logger,
    isFeatureEnabled: startupFeatureEnabled,
    getBrowserGrants: () =>
      preferencesService.get().networkEgress.browserGrants,
    getAuditPath: getNetworkPolicyAuditPath,
    controlledBrowserAllowedHosts:
      process.env.CLODEX_BROWSER_EGRESS_ALLOWED_HOSTS,
  });

  // Start launch telemetry without blocking startup. TelemetryService keeps
  // track of the pending capture so shutdown can wait for it before emitting
  // app-closed.
  telemetryService.captureAppLaunched();

  // Global safety net: capture any unhandled errors/rejections to telemetry
  process.on('uncaughtException', (error) => {
    logger.error(`[Process] Uncaught exception: ${error.message}`);
    telemetryService.captureException(error, {
      service: 'process',
      operation: 'uncaughtException',
    });
    agentOsService?.recordEvent({
      channel: 'process',
      level: 'error',
      message: 'Uncaught process exception',
      payload: { error: error.message },
    });
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`[Process] Unhandled rejection: ${error.message}`);
    telemetryService.captureException(error, {
      service: 'process',
      operation: 'unhandledRejection',
    });
    agentOsService?.recordEvent({
      channel: 'process',
      level: 'error',
      message: 'Unhandled process rejection',
      payload: { error: error.message },
    });
  });

  const {
    historyService,
    pagesService,
    windowLayoutService,
    uiKarton,
    fileTreeService,
    detectedShell,
    resolvedEnvPromise,
    gitService,
    startSearchEngineSync,
  } = await runBrowserUiServicesPhase({
    logger,
    verbose,
    webDataService,
    telemetryService,
    faviconService,
    preferencesService,
    attachments,
    controlledBrowserEgress:
      guardianEgressStartup.controlledBrowserTabEgressOptions,
  });
  startSearchEngineSync();

  // Phase 3a + 5 + D.2: compose the early Agent Core foundation at the
  // original startup point. The bridge remains unattached until activation.
  const agentCoreFoundation = await runAgentCoreFoundationPhase({
    logger,
    telemetryService,
    preferencesService,
    pagesService,
    karton: uiKarton,
    hostPaths,
    dataProtection,
    protectedFiles,
    protectedMigrationOrder,
    attachments,
    guardianEgressStartup,
    startupFeatureEnabled,
    isolatedAgentRuntimePolicy,
    isolatedAgentRuntimeKillSwitchActive,
    releaseChannel: __APP_RELEASE_CHANNEL__,
    verbose,
  });
  const {
    agentCoreSeam,
    agentHostProcessService,
    agentCoreHost,
    agentBehaviorPreferenceListener,
    refreshPluginDefinitions,
    persistence,
    diffHistoryService,
    pendingEditService,
    networkEgressControlService,
    memoryNotesSettingsService,
    evidenceMemoryInspectorService,
  } = agentCoreFoundation;

  const {
    omniboxSuggestionsService: _omniboxSuggestionsService,
    registerAuthCallbackHandler,
    registerMcpOAuthCallbackHandler,
    registerSkillInstallHandler,
    notificationService,
    autoUpdateService,
    globalConfigService,
    notificationSoundsService,
    syncAvailableSoundPacks,
    startNotificationBackgroundWork,
  } = await runNotificationRuntimePhase({
    logger,
    verbose,
    uiKarton,
    historyService,
    webDataService,
    faviconService,
    localPortsScannerService,
    windowLayoutService,
    telemetryService,
    preferencesService,
  });
  startNotificationBackgroundWork();

  logger.debug('[Main] Global services bootstrapped');

  // Register telemetry capture RPC so the UI can send events through the backend
  uiKarton.registerServerProcedureHandler(
    'telemetry.capture',
    async (
      _cid: string,
      eventName: string,
      properties?: Record<string, unknown>,
    ) => {
      if (!isUIEventName(eventName)) {
        logger.warn(`[Main] Ignoring unknown UI telemetry event: ${eventName}`);
        return;
      }

      const parsedProperties = parseUIEventProperties(eventName, properties);
      if (parsedProperties === null) {
        logger.warn(
          `[Main] Ignoring invalid UI telemetry payload for event: ${eventName}`,
        );
        return;
      }

      telemetryService.capture(eventName, parsedProperties);
    },
  );

  const {
    authService,
    userExperienceService,
    credentialsService,
    mcpOAuthService,
    mcpRegistryService,
    mcpSettingsService,
    pluginMarketplaceService,
    privateMarketplaceSourcesService,
    hostedPullRequestService,
    toolboxService,
    remoteConnectionsService,
    isClodexCloudEnabled,
    startBuiltinSkillsSync,
  } = await runPlatformIntegrationServicesPhase({
    logger,
    verbose,
    releaseChannel: __APP_RELEASE_CHANNEL__,
    appVersion: __APP_VERSION__,
    uiKarton,
    windowLayoutService,
    identifierService,
    notificationService,
    telemetryService,
    gitService,
    persistence,
    preferencesService,
    registerAuthCallbackHandler,
    registerMcpOAuthCallbackHandler,
    guardianEgressStartup,
    diffHistoryService,
    pendingEditService,
    detectedShell,
    resolvedEnvPromise,
    agentStore: agentCoreSeam.store,
    hostAgentStateMutations: agentCoreSeam.hostAgentStateMutations,
    attachments,
    agentHostProcessService,
    protectedFiles,
    agentCoreHost,
    refreshPluginDefinitions,
  });

  // Register discovery before model composition so an already-resolved skills
  // promise still publishes only after the model phase reaches its first await.
  startBuiltinSkillsSync();
  const {
    modelProviderService,
    dictationService,
    runManualGeminiDiagnostic,
    assetCacheService,
    updateEvidenceMemorySummaryModel,
  } = await runModelToolboxRuntimePhase({
    logger,
    releaseChannel: __APP_RELEASE_CHANNEL__,
    uiKarton,
    authService,
    windowLayoutService,
    telemetryService,
    preferencesService,
    credentialsService,
    persistence,
    toolboxService,
    isClodexCloudEnabled,
    dataProtection,
    hostPaths,
    attachments,
  });

  const processedImageCacheService = persistence.processedImageCache;

  // Phase 4: a single app-wide `FileReadCacheService` backs every agent
  // instance so repeated reads of the same file across agents benefit
  // from a shared cache. Owned by `AgentCorePersistence` (Phase D.2).
  const fileReadCacheService = persistence.fileReadCache;

  const agentTypeRegistry = createBrowserAgentTypeRegistry();
  const enrichAgentHistoryEntries = (entries: AgentHistoryEntry[]) =>
    enrichHistoryEntryWorkspaces(
      entries,
      (workspacePath) => gitService.getMountedWorkspaceSummary(workspacePath),
      logger,
    );
  const chatPersistenceService = new ChatPersistenceService({
    persistenceDb: persistence.agentDb,
    enrichHistoryEntries: enrichAgentHistoryEntries,
  });

  // One-shot cleanup: drop empty date-stamped chat stubs (no history, no
  // draft input) that the user never opened. Without this, the sidebar
  // accumulates "New Chat Agent - <date>" rows over time — v1 of the
  // persistent storage made them survive across restarts, where they used
  // to be in-memory and silently dropped. Threshold: 7 days quiet.
  void persistence.agentDb
    .pruneStaleEmptyAgents(7 * 24 * 60 * 60 * 1000)
    .then((pruned) => {
      logger.debug(`[Main] Pruned ${pruned} stale empty chat agents`);
    })
    .catch((error) => {
      logger.warn('[Main] Empty-agent prune failed', error);
    });

  const electronAgentManagerStartupPolicy: AgentManagerStartupPolicy = {
    kind: 'auto-create-default',
    agentType: AgentTypes.CHAT,
    mountLastWorkspaces: true,
    // Restore the last-active agent on cold start instead of always
    // booting into a blank CHAT. `WindowLayoutService.loadTabState`
    // owns writing this id; we read the same file synchronously here
    // so the manager's startup policy can attempt a resume before
    // falling through to its create-default fall-back.
    getResumeAgentId: () => {
      const state = readPersistedDataSync(
        'tab-state',
        z.object({ lastOpenAgentId: z.string().nullable().catch(null) }),
        { lastOpenAgentId: null },
      );
      return state.lastOpenAgentId;
    },
  };

  const localExecutionTarget = createBrowserAgentStepExecutor({
    process: agentHostProcessService,
    logger,
    telemetry: {
      capture(eventName, properties) {
        telemetryService.capture(eventName as never, properties as never);
      },
    },
    isKillSwitchActive: () => isolatedAgentRuntimeKillSwitchActive,
    circuitBreaker: {
      failureThreshold: isolatedAgentRuntimePolicy.failureThreshold,
      cooldownMs: isolatedAgentRuntimePolicy.cooldownMs,
    },
    isEnabled: () =>
      resolveFeatureGate(
        'isolated-agent-runtime',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
  });
  const cloudTaskKillSwitchActive = isCloudTaskKillSwitchActive(
    process.env.CLODEX_CLOUD_TASKS_KILL_SWITCH,
  );
  const cloudTaskExecutionLeaseRegistry = new CloudTaskExecutionLeaseRegistry();
  const cloudTaskRuntime: CloudTaskRuntimeResult = createCloudTaskRuntime({
    logger,
    baseUrl: process.env.CLODEX_CLOUD_TASKS_URL,
    residency: process.env.CLODEX_CLOUD_TASKS_RESIDENCY,
    killSwitchActive: cloudTaskKillSwitchActive,
    artifactRootDirectory: path.join(
      app.getPath('userData'),
      'cloud-task-artifacts',
    ),
    resumeRootDirectory: path.join(
      app.getPath('userData'),
      'cloud-task-resume',
    ),
    memorySyncJournalFilePath: path.join(
      app.getPath('userData'),
      'cloud-task-memory-sync-journal.json',
    ),
    getAccountAccessToken: () => authService.accessToken,
    isFeatureEnabled: () =>
      isClodexCloudEnabled() &&
      resolveFeatureGate(
        'cloud-tasks',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled &&
      !cloudTaskKillSwitchActive,
    leaseRegistry: cloudTaskExecutionLeaseRegistry,
    leaseHolderId: `desktop:${crypto.randomUUID()}`,
    resolveMounts: (agentInstanceId) =>
      (
        agentCoreSeam.store.get().toolbox[agentInstanceId]?.workspace.mounts ??
        []
      ).map((mount) => ({
        prefix: mount.prefix,
        path: mount.path,
      })),
    isProtectedFile: (absolutePath) =>
      protectedFiles.isProtectedFile(absolutePath),
    audit: (event) => {
      telemetryService.capture('cloud-task-control-plane-event', {
        operation: event.operation,
        success: event.success,
        residency: event.residency,
        reason: event.reason,
        duration_ms: event.durationMs,
        snapshot_bytes: event.snapshotBytes,
        snapshot_files: event.snapshotFiles,
        artifact_bytes: event.artifactBytes,
        resumed_bytes: event.resumedBytes,
        resume_sequence: event.resumeSequence,
        cost_micros: event.costMicros,
        usage_duration_ms: event.usageDurationMs,
        limit: event.limit,
        inspected_executions: event.inspectedExecutions,
        cancelled_executions: event.cancelledExecutions,
        cleared_checkpoints: event.clearedCheckpoints,
        retained_checkpoints: event.retainedCheckpoints,
        removed_artifacts: event.removedArtifacts,
        removed_bytes: event.removedBytes,
      });
    },
    evidenceMemory: persistence.evidenceMemory,
  });
  if (cloudTaskRuntime) {
    await cloudTaskRuntime.memorySyncJournal.initialize().catch((error) => {
      logger.warn('[CloudTasks] Memory sync journal recovery failed', error);
    });
    await cloudTaskRuntime.artifactStore.initialize().catch((error) => {
      logger.warn('[CloudTasks] Artifact startup cleanup failed', error);
    });
    if (isClodexCloudEnabled()) {
      void cloudTaskRuntime.recovery.reconcile('startup').catch((error) => {
        logger.warn('[CloudTasks] Startup reconciliation failed', error);
      });
    }
  }
  const cloudTaskArtifactService = cloudTaskRuntime
    ? CloudTaskArtifactService.create({
        karton: uiKarton,
        store: cloudTaskRuntime.artifactStore,
        audit: cloudTaskRuntime.audit,
      })
    : null;
  const cloudTaskGateAtStartup = resolveFeatureGate(
    'cloud-tasks',
    preferencesService.get().featureGates.overrides,
    __APP_RELEASE_CHANNEL__,
  );
  telemetryService.capture('cloud-task-rollout-observed', {
    rollout_stage: 'dogfood',
    gate_enabled: cloudTaskGateAtStartup.enabled,
    gate_source: cloudTaskGateAtStartup.source,
    control_plane_configured: Boolean(
      process.env.CLODEX_CLOUD_TASKS_URL?.trim(),
    ),
    adapter_available: Boolean(cloudTaskRuntime),
    kill_switch_active: cloudTaskKillSwitchActive,
    residency: cloudTaskRuntime?.residency,
  });
  const executionTargetRouter = createExecutionTargetRouter({
    localExecutor: localExecutionTarget,
    cloudAdapter: cloudTaskRuntime?.adapter,
    snapshotPackager: cloudTaskRuntime?.snapshotPackager,
    isCloudEnabled: () =>
      isClodexCloudEnabled() &&
      resolveFeatureGate(
        'cloud-tasks',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled &&
      !cloudTaskKillSwitchActive,
    audit: (event) => {
      telemetryService.capture('cloud-task-execution-event', {
        operation: event.operation,
        target: event.target,
        status: event.status,
        reason: event.reason,
        duration_ms: event.durationMs,
      });
    },
  });

  const agentManagerService = new AgentManagerService(
    uiKarton,
    agentCoreSeam.registry,
    toolboxService,
    agentCoreSeam.store,
    () => uiKarton.state.skills ?? [],
    electronAgentManagerStartupPolicy,
    fileReadCacheService,
    attachments,
    persistence.agentDb,
    chatPersistenceService,
    agentCoreHost,
    agentTypeRegistry,
    assetCacheService,
    processedImageCacheService,
    (event, agentId) =>
      notificationSoundsService.notifyAgentEvent(event, agentId),
    enrichAgentHistoryEntries,
    executionTargetRouter,
  );
  const cloudTaskTeleportController = new CloudTaskTeleportController({
    karton: uiKarton,
    logger,
    isFeatureEnabled: () =>
      isClodexCloudEnabled() &&
      resolveFeatureGate(
        'cloud-tasks',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled &&
      !cloudTaskKillSwitchActive,
    memorySyncJournal: cloudTaskRuntime?.memorySyncJournal,
  });
  cloudTaskRuntime?.adapter.setTeleportObserver(cloudTaskTeleportController);
  if (cloudTaskRuntime) {
    cloudTaskRuntime.teleportRecovery.setHostBindings({
      assertLocalSafePoint: async (agentInstanceId) => {
        await agentManagerService.prepareSessionCheckpoint(agentInstanceId);
      },
      replayChunk: async (agentInstanceId, input) =>
        await agentManagerService.replayRecoveredUiChunk(
          agentInstanceId,
          input,
        ),
      finishReplay: async (agentInstanceId, input) => {
        await agentManagerService.finishRecoveredUiReplay(
          agentInstanceId,
          input,
        );
      },
    });
    await cloudTaskRuntime.teleportRecovery
      .restore(cloudTaskTeleportController)
      .catch((error) => {
        logger.warn(
          '[CloudTasks] Failed to restore suspended Teleport sessions',
          error,
        );
        return 0;
      });
  }
  const spacesService = await SpacesService.create({
    logger,
    karton: uiKarton,
    isFeatureEnabled: () =>
      resolveFeatureGate(
        'spaces',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
    listProjects: async () => {
      const projects: Array<{ name: string; rootPath: string | null }> = [];
      const pageSize = 100;
      for (let offset = 0; offset < 1_000; offset += pageSize) {
        const page = await agentManagerService.dispatchCommand(
          'agents.getChatProjects',
          [offset, pageSize],
          'spaces-project-import',
        );
        if (!Array.isArray(page)) break;
        const normalized = page.flatMap((project) => {
          if (!project || typeof project !== 'object') return [];
          const candidate = project as {
            name?: unknown;
            rootPath?: unknown;
          };
          if (typeof candidate.name !== 'string') return [];
          return [
            {
              name: candidate.name,
              rootPath:
                typeof candidate.rootPath === 'string'
                  ? candidate.rootPath
                  : null,
            },
          ];
        });
        projects.push(...normalized);
        if (page.length < pageSize) break;
      }
      return projects;
    },
  });
  const nativeWakeScheduler = app.isPackaged
    ? new NativeWakeScheduler({
        logger,
        userDataPath: app.getPath('userData'),
        executablePath: process.execPath,
      })
    : undefined;
  const automationService = await AutomationService.create({
    logger,
    karton: uiKarton,
    notifications: notificationService,
    isFeatureEnabled: () =>
      resolveFeatureGate(
        'automations',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
    wakeSource: {
      onResume(listener) {
        powerMonitor.on('resume', listener);
        return () => powerMonitor.removeListener('resume', listener);
      },
    },
    nativeWakeScheduler,
    dispatch: async ({ automation, beforeDispatch }) => {
      const created = await agentManagerService.dispatchCommand(
        'agents.create',
        [
          undefined,
          automation.modelId ?? undefined,
          automation.approvalMode,
          automation.workspacePaths.length > 0
            ? automation.workspacePaths
            : undefined,
          automation.workspacePaths.length > 0,
          undefined,
          beforeDispatch,
        ],
        `automation:${automation.id}`,
      );
      if (typeof created !== 'string' || created.length === 0) {
        throw new Error('Automation agent creation returned no identifier');
      }
      await agentManagerService.dispatchCommand(
        'agents.sendUserMessage',
        [created, createAutomationAgentMessage(automation)],
        `automation:${automation.id}`,
      );
      return { agentId: created };
    },
  });
  const generatedAppIdentityResolver = new GeneratedAppIdentityResolver();
  const artifactBridgeAuditLedger = new ArtifactBridgeAuditLedger(
    getArtifactBridgeAuditPath(),
    logger,
  );
  await artifactBridgeAuditLedger.listRecent(1);
  const artifactBridgeService = await ArtifactBridgeService.create({
    logger,
    karton: uiKarton,
    mcpRegistry: mcpRegistryService,
    auditRecorder: artifactBridgeAuditLedger,
    auditReader: artifactBridgeAuditLedger,
    isFeatureEnabled: () =>
      resolveFeatureGate(
        'artifact-bridge',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
    askAgent: async (context, prompt, options) => {
      if (context.kind !== 'agent') {
        throw new Error(
          'Packaged generated apps cannot impersonate or ask an agent',
        );
      }
      const modelId =
        uiKarton.state.agents.instances[context.agentId]?.state.activeModelId;
      if (!modelId)
        throw new Error('The generated app owner has no active model');
      const model = await agentCoreHost.models.get(
        modelId,
        `artifact-bridge:${context.agentId}:${context.appId}`,
      );
      options?.beforeDispatch?.();
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 1_024,
        abortSignal: AbortSignal.timeout(30_000),
      });
      return result.text;
    },
    runAutomation: async (automationId, options) =>
      await automationService.runAutomationNow(automationId, options),
    resolveApp: async (context) =>
      await generatedAppIdentityResolver.resolve(context),
  });
  const artifactBridgeFrameBroker = new ArtifactBridgeFrameBroker({
    ipc: ipcMain,
    artifactBridge: artifactBridgeService,
    logger,
  }).start();
  const sessionSharingBaseUrl = process.env.CLODEX_SESSION_SHARING_URL?.trim();
  const sessionSharingAdapter: SessionSharingAdapter | undefined =
    sessionSharingBaseUrl &&
    new URL(sessionSharingBaseUrl).protocol === 'https:'
      ? {
          available: () =>
            isClodexCloudEnabled() && Boolean(authService.accessToken),
          createShare: async (payload, expiresInHours) => {
            if (!isClodexCloudEnabled() || !authService.accessToken) {
              throw new Error(
                'Select Clodex Cloud and sign in before sharing a session',
              );
            }
            const response = await fetch(
              new URL('/v1/session-shares', sessionSharingBaseUrl),
              {
                method: 'POST',
                redirect: 'error',
                headers: {
                  Authorization: `Bearer ${authService.accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ payload, expiresInHours }),
              },
            );
            if (!response.ok) {
              throw new Error(
                `Session sharing failed with status ${response.status}`,
              );
            }
            const result = (await response.json()) as {
              id?: unknown;
              url?: unknown;
              expiresAt?: unknown;
            };
            if (
              typeof result.id !== 'string' ||
              typeof result.url !== 'string' ||
              typeof result.expiresAt !== 'string'
            ) {
              throw new Error('Session sharing service returned invalid data');
            }
            return {
              id: result.id,
              url: result.url,
              expiresAt: result.expiresAt,
            };
          },
          revokeShare: async (shareId) => {
            if (!isClodexCloudEnabled() || !authService.accessToken) {
              throw new Error(
                'Select Clodex Cloud and sign in before revoking a session share',
              );
            }
            const response = await fetch(
              new URL(
                `/v1/session-shares/${encodeURIComponent(shareId)}`,
                sessionSharingBaseUrl,
              ),
              {
                method: 'DELETE',
                redirect: 'error',
                headers: {
                  Authorization: `Bearer ${authService.accessToken}`,
                },
              },
            );
            if (!response.ok && response.status !== 404) {
              throw new Error(
                `Session share revocation failed with status ${response.status}`,
              );
            }
          },
        }
      : undefined;
  const sessionContinuityService = await SessionContinuityService.create({
    logger,
    karton: uiKarton,
    isFeatureEnabled: () =>
      resolveFeatureGate(
        'session-continuity',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
    isCloudAvailable: () =>
      isClodexCloudEnabled() &&
      Boolean(cloudTaskRuntime) &&
      resolveFeatureGate(
        'cloud-tasks',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled &&
      !cloudTaskKillSwitchActive,
    getSessionInfo: async (sessionId) => {
      const stored =
        await persistence.agentDb.getStoredAgentInstanceById(sessionId);
      return {
        exists: Boolean(stored),
        messageCount: stored?.history.length ?? 0,
        workspacePaths:
          stored?.mountedWorkspaces?.map((workspace) => workspace.path) ?? [],
      };
    },
    prepareCheckpoint: async (sessionId) => {
      const flushed =
        await agentManagerService.prepareSessionCheckpoint(sessionId);
      const stored =
        await persistence.agentDb.getStoredAgentInstanceById(sessionId);
      if (!stored) throw new Error('Session not found after checkpoint flush');

      const liveMounts =
        agentCoreSeam.store.get().toolbox[sessionId]?.workspace.mounts ?? [];
      const liveMountByPath = new Map(
        liveMounts.map((mount) => [mount.path, mount]),
      );
      const createdAt = new Date().toISOString();
      const history = (
        Array.isArray(stored.history) ? stored.history : []
      ) as AgentMessage[];
      const snapshotMetadata = await buildLocalWorkspaceSnapshotMetadata({
        mounts: liveMounts.map((mount) => ({
          prefix: mount.prefix,
          path: mount.path,
        })),
        entries: [],
        selection: 'mounted-workspaces',
      });
      const workspaceSnapshot = createWorkspaceSnapshot({
        createdAt: Date.parse(createdAt),
        selection: 'mounted-workspaces',
        entries: [],
        mounts: snapshotMetadata.mounts,
        environment: snapshotMetadata.environment,
      });
      const evidenceCheckpoint = persistence.evidenceMemory
        ? await persistence.evidenceMemory.createCheckpoint(sessionId)
        : null;
      return createAgentSessionCheckpoint({
        createdAt,
        task: {
          agentInstanceId: sessionId,
          agentType: stored.type,
          title: stored.title,
          goal: stored.goal ?? null,
          lineage: {
            parentAgentInstanceId: stored.parentAgentInstanceId ?? null,
            forkedFromAgentId: stored.forkedFromAgentId ?? null,
            forkedFromMessageId: stored.forkedFromMessageId ?? null,
          },
        },
        execution: {
          state: 'idle',
          target: 'local',
          activeModelId: stored.activeModelId,
          approvalProfile: stored.toolApprovalMode,
          usedTokens: stored.usedTokens,
          historyMessageCount: history.length,
          lastMessageId: history.at(-1)?.id ?? null,
        },
        memory: {
          history: {
            kind: 'agent-memory-jsonl',
            agentInstanceId: sessionId,
            messageCount: history.length,
            contentHash: hashSessionCheckpointHistory(history),
          },
          compressedHistory: findCompressedHistoryReference(history),
          evidence: evidenceCheckpoint
            ? {
                version: evidenceCheckpoint.version,
                checkpointId: evidenceCheckpoint.checkpointId,
                eventCount: evidenceCheckpoint.eventCount,
                headEventId: evidenceCheckpoint.headEventId,
                headTimestamp: evidenceCheckpoint.headTimestamp,
                ledgerHash: evidenceCheckpoint.ledgerHash,
              }
            : null,
        },
        workspace: {
          capturedAt: createdAt,
          snapshot: workspaceSnapshot,
          workspaces: (stored.mountedWorkspaces ?? []).map((workspace) => {
            const live = liveMountByPath.get(workspace.path);
            return {
              path: workspace.path,
              permissions: workspace.permissions,
              repositoryId: live?.git?.repositoryId ?? null,
              worktreeId: live?.git?.worktreeId ?? null,
              revision: live?.git?.headSha ?? null,
            };
          }),
        },
        persistence: {
          agentStateFlushedAt: flushed.agentStateFlushedAt,
          memoryFlushedAt: flushed.memoryFlushedAt,
        },
      });
    },
    teleport: async (sessionId, prompt, checkpoint) => {
      await agentManagerService.dispatchCommand(
        'agents.resume',
        [sessionId],
        'session-continuity',
      );
      const message: AgentMessage & { role: 'user' } = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          swarmMode: false,
          executionTarget: 'cloud',
          cloudHandoffScope: 'session-workspaces',
          sessionCheckpoint: checkpoint,
        },
      };
      await agentManagerService.dispatchCommand(
        'agents.sendUserMessage',
        [sessionId, message],
        'session-continuity',
      );
      return { agentId: sessionId };
    },
    buildSharePayload: async (sessionId) => {
      const stored =
        await persistence.agentDb.getStoredAgentInstanceById(sessionId);
      if (!stored) throw new Error('Session not found');
      const messages = (Array.isArray(stored.history) ? stored.history : [])
        .slice(-200)
        .flatMap((rawMessage) => {
          if (!rawMessage || typeof rawMessage !== 'object') return [];
          const message = rawMessage as {
            role?: unknown;
            parts?: unknown;
            metadata?: { createdAt?: unknown };
          };
          if (message.role !== 'user' && message.role !== 'assistant') {
            return [];
          }
          const role = message.role as 'user' | 'assistant';
          const parts = Array.isArray(message.parts) ? message.parts : [];
          const text = parts
            .flatMap((part) => {
              if (
                !part ||
                typeof part !== 'object' ||
                !('type' in part) ||
                part.type !== 'text' ||
                !('text' in part) ||
                typeof part.text !== 'string'
              ) {
                return [];
              }
              return [part.text];
            })
            .join('\n')
            .trim()
            .slice(0, 50_000);
          if (!text) return [];
          const createdAt =
            message.metadata?.createdAt instanceof Date
              ? message.metadata.createdAt.toISOString()
              : null;
          return [
            {
              role,
              text,
              createdAt,
            },
          ];
        });
      return {
        sessionId,
        title: stored.title,
        createdAt: stored.createdAt.toISOString(),
        messages,
      };
    },
    sharingAdapter: sessionSharingAdapter,
  });
  const generatedAppLibraryService = GeneratedAppLibraryService.create({
    logger,
    getOwnerSnapshots: async (agentIds) => {
      const result = await agentManagerService.dispatchCommand(
        'agents.getAgentHistoryEntriesByIds',
        [agentIds],
        'generated-app-library',
      );
      const historyEntries = Array.isArray(result)
        ? (result as AgentHistoryEntry[])
        : [];
      const historyById = new Map(
        historyEntries.map((entry) => [entry.id, entry]),
      );
      const owners = new Map<string, GeneratedAppOwnerSnapshot>();

      for (const agentId of agentIds) {
        const history = historyById.get(agentId);
        const liveAgent = uiKarton.state.agents.instances[agentId];
        const liveMount = uiKarton.state.toolbox[agentId]?.workspace.mounts[0];
        owners.set(agentId, {
          taskTitle:
            history?.title?.trim() || liveAgent?.state.title?.trim() || null,
          workspacePath:
            history?.mountedWorkspaces?.[0]?.path ??
            history?.projectRootPath ??
            liveMount?.path ??
            null,
        });
      }

      return owners;
    },
    openPreview: async (generatedApp) => {
      await windowLayoutService.createTabForAgent(
        generatedApp.previewUrl,
        generatedApp.owner.agentId,
        true,
      );
    },
    regenerateOwnerApp: async ({ agentId, appId, title }) => {
      await agentManagerService.dispatchCommand(
        'agents.resume',
        [agentId],
        'generated-app-library',
      );
      const message: AgentMessage & { role: 'user' } = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [
          {
            type: 'text',
            text: [
              `Regenerate the generated mini-app "${title}" with app ID "${appId}".`,
              `Keep the same app identity and write the finished replacement to the existing agent app directory for "${appId}".`,
              'Preserve the current files until the replacement is ready, then update the app in place.',
              'Review the current implementation, repair any broken state, improve the UX where appropriate, and verify index.html before finishing.',
            ].join('\n\n'),
          },
        ],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          swarmMode: false,
        },
      };
      await agentManagerService.dispatchCommand(
        'agents.sendUserMessage',
        [agentId, message],
        'generated-app-library',
      );
      await windowLayoutService.focusAgentFromExternalWindow(agentId);
    },
  });
  const quickTaskWindowService = await QuickTaskWindowService.create({
    logger,
    karton: uiKarton,
    agentManagerService,
    windowLayoutService,
  });

  const isAgentOsFeatureEnabled = (
    feature: Parameters<typeof resolveFeatureGate>[0],
  ) =>
    resolveFeatureGate(
      feature,
      uiKarton.state.preferences.featureGates.overrides,
      uiKarton.state.appInfo.releaseChannel,
    ).enabled;

  agentOsService = await AgentOsService.create({
    logger,
    karton: uiKarton,
    protectedFiles,
    isFeatureEnabled: isAgentOsFeatureEnabled,
    remoteControlEnvironment: {
      appVersion: app.getVersion(),
      releaseChannel: uiKarton.state.appInfo.releaseChannel,
    },
    remoteControlAuditHandler: (event) => {
      telemetryService.capture('remote-control-security-event', {
        operation: event.operation,
        success: event.success,
        protocol_version: event.protocolVersion,
        command: event.command,
        decision: event.decision,
        risk_level: event.risk,
        irreversible: event.irreversible,
        latency_ms: event.latencyMs,
        reason: event.reason,
        trust_level: event.trustLevel,
        attestation_provider: event.attestationProvider,
        attestation_reason: event.attestationReason,
      });
    },
    desktopAutomationAuditHandler: (event) => {
      telemetryService.capture('desktop-automation-security-event', {
        operation: event.operation,
        success: event.success,
        bundle_id: event.bundleId,
        risk: event.risk,
        decision: event.decision,
        reason: event.reason,
        element_role: event.elementRole,
        latency_ms: event.latencyMs,
      });
    },
    guardianFeedbackHandler: ({ assessment, previousFeedback, readiness }) => {
      if (!assessment.feedback) return;
      telemetryService.capture('guardian-feedback-submitted', {
        policy_version: assessment.policyVersion,
        action_kind: assessment.kind,
        risk_level: assessment.risk,
        decision: assessment.decision,
        feedback: assessment.feedback,
        previous_feedback: previousFeedback,
        irreversible: assessment.irreversible,
        assessment_age_ms: Math.max(0, Date.now() - assessment.createdAt),
        readiness_status: readiness.status,
        local_assessment_count: readiness.assessments,
        local_labeled_count: readiness.labeled,
        local_approved_labeled_count: readiness.approvedLabeled,
        local_restricted_labeled_count: readiness.restrictedLabeled,
        local_false_positive_count: readiness.falsePositive,
        local_false_negative_count: readiness.falseNegative,
      });
    },
    captureProvider: async () => {
      const window = windowLayoutService.getBaseWindow();
      const webContents = windowLayoutService.getUIWebContents();
      if (
        !window ||
        window.isDestroyed() ||
        !webContents ||
        webContents.isDestroyed()
      ) {
        return null;
      }
      const image = await webContents.capturePage();
      return {
        image: image.toPNG(),
        windowTitle: window.getTitle(),
      };
    },
    remoteCommandHandler: async (command, payload) => {
      const agentId =
        typeof payload.agentId === 'string' ? payload.agentId : undefined;
      switch (command) {
        case 'pushToTalkStart':
          if (!isAgentOsFeatureEnabled('global-dictation')) {
            throw new Error('Global dictation preview feature is disabled');
          }
          if (
            !isAgentOsFeatureEnabled('codex-micro-controller') ||
            !agentOsService?.snapshot().micro.enabled
          ) {
            throw new Error('Micro controller is disabled');
          }
          await agentOsService?.micro.setPushToTalkActive(true);
          return { ok: true };
        case 'pushToTalkStop':
          await agentOsService?.micro.setPushToTalkActive(false);
          return { ok: true };
        case 'newAgent':
          return await agentManagerService.dispatchCommand(
            'agents.create',
            [],
            'remote-control',
          );
        case 'stopAgent':
          if (!agentId) throw new Error('agentId is required');
          await agentManagerService.dispatchCommand(
            'agents.stop',
            [agentId],
            'remote-control',
          );
          return { ok: true };
        case 'openThread':
          if (!agentId) throw new Error('agentId is required');
          await agentManagerService.dispatchCommand(
            'agents.resume',
            [agentId],
            'remote-control',
          );
          return { ok: true };
        case 'approveTool':
        case 'rejectTool': {
          const approvalId =
            typeof payload.approvalId === 'string'
              ? payload.approvalId
              : undefined;
          if (!agentId || !approvalId) {
            throw new Error('agentId and approvalId are required');
          }
          await agentManagerService.dispatchCommand(
            'agents.sendToolApprovalResponse',
            [agentId, approvalId, command === 'approveTool'],
            'remote-control',
          );
          return { ok: true };
        }
        case 'sendMessage': {
          const text =
            typeof payload.text === 'string' ? payload.text.trim() : '';
          if (!agentId || !text) {
            throw new Error('agentId and text are required');
          }
          const message: AgentMessage & { role: 'user' } = {
            id: crypto.randomUUID(),
            role: 'user',
            parts: [{ type: 'text', text }],
            metadata: {
              createdAt: new Date(),
              partsMetadata: [],
            },
          };
          await agentManagerService.dispatchCommand(
            'agents.sendUserMessage',
            [agentId, message],
            'remote-control',
          );
          return { ok: true };
        }
      }
    },
  });
  const guardianService = new GuardianService({
    isFeatureEnabled: isAgentOsFeatureEnabled,
    telemetry: telemetryService,
    recordAudit: (metadata) => {
      void agentOsService
        ?.recordGuardianAssessment(toGuardianAssessmentObservation(metadata))
        .catch((error) => {
          logger.warn(
            '[GuardianService] Failed to persist dogfood assessment',
            error,
          );
        });
      agentOsService?.recordEvent({
        channel: 'guardian',
        level:
          metadata.decision === 'deny'
            ? 'error'
            : metadata.decision === 'escalate'
              ? 'warn'
              : 'info',
        message: `Guardian assessment: ${metadata.decision}`,
        payload: {
          kind: metadata.kind,
          policyVersion: metadata.policyVersion,
          risk: metadata.risk,
          irreversible: metadata.irreversible,
          readOnly: metadata.readOnly,
          evidenceCount: metadata.evidenceCount,
          capabilityCount: metadata.capabilityCount,
          latencyMs: metadata.latencyMs,
          validContext: metadata.validContext,
          assessmentId: metadata.assessmentId,
        },
      });
    },
  });
  agentOsService.setRemoteGuardianPolicyChecker((request) =>
    guardianService.assess(request),
  );
  toolboxService.setGuardianPolicyChecker((request) =>
    guardianService.assess(request),
  );
  toolboxService.setBrowserUsePolicyChecker(
    async ({ origin, capability, description }) => {
      const guardianAssessment = await guardianService.assess(
        createNetworkGuardianRequest({ origin, capability }),
      );
      if (guardianAssessment?.decision === 'deny') return false;

      return (
        (await agentOsService?.authorizeBrowserAction(
          origin,
          capability,
          description,
          {
            forceAsk:
              guardianAssessment?.irreversible === true ||
              guardianAssessment?.decision === 'escalate',
          },
        )) ?? true
      );
    },
  );
  toolboxService.setDesktopAutomationService(agentOsService.desktopAutomation);
  agentManagerService.setLifecycleHookRunner((trigger, context) =>
    agentOsService!.runHooks(trigger, context),
  );
  agentManagerService.setDebugEventSink((event) =>
    agentOsService?.recordEvent(event),
  );
  const handleAgentOsSkillInstallUrl = (url: string) => {
    void agentOsService
      ?.handleSkillInstallUrl(url)
      .then((preview) => {
        if (!preview) return;
        uiKarton.setState((draft) => {
          draft.appScreen.mode = 'settings';
          draft.appScreen.settingsRoute = { section: 'agent-os' };
        });
      })
      .catch((error) => {
        logger.error('[AgentOsService] Skill deep-link failed', error);
      });
    return true;
  };
  registerSkillInstallHandler(handleAgentOsSkillInstallUrl);
  const agentOsFeatureGatePreferenceListener = () => {
    void agentOsService?.enforceFeatureGates().catch((error) => {
      logger.warn('[AgentOsService] Failed to enforce feature gates', error);
    });
  };
  preferencesService.addListener(agentOsFeatureGatePreferenceListener);

  // Keep activation synchronous at this exact point: every legacy Karton
  // handler is registered, so the bridge drift guard sees the final registry.
  const agentCoreActivation = runAgentCoreActivationPhase({
    logger,
    karton: uiKarton,
    toolboxService,
    agentManagerService,
    modelProviderService,
    foundation: agentCoreFoundation,
    cloudTaskRuntime,
    isClodexCloudEnabled,
  });
  const {
    agentCoreBridge,
    agentPowerSaveBlockerService,
    macOSClosedLidSleepService,
    agentRuntimeRecoveryService,
  } = agentCoreActivation;

  const { browserSwarmStore, runSwarmWorkflow, runForcedSwarmPreview } =
    createSwarmRuntime({
      uiKarton,
      agentStore: agentCoreSeam.store,
      models: agentCoreHost.models,
      attachments,
      logger,
      toolboxService,
      agentDb: persistence.agentDb,
      userExperienceService,
      pendingEditService,
      agentManagerService,
    });

  const getWorkspaceLastUsedAtByPath = async (workspacePaths: string[]) =>
    (await persistence.agentDb.getWorkspaceLastUsedAtByPath(workspacePaths)) ??
    new Map();

  const worktreeSetupSettingsService = WorktreeSetupSettingsService.create({
    logger,
    userExperienceService,
    gitService,
    getWorkspaceLastUsedAtByPath,
    getMountedWorkspacePaths: () => toolboxService.getAllMountedPaths(),
  });

  await wirePagesRuntime({
    uiKarton,
    pagesService,
    globalConfigService,
    diffHistoryService,
    pendingEditService,
    windowLayoutService,
    getSandboxService: () => toolboxService.getSandboxService(),
    activeAppController: agentCoreBridge.activeAppController,
    hostedPullRequestService,
    generatedAppLibraryService,
    pluginMarketplaceService,
    preferencesService,
    credentialsService,
    logger,
  });

  wireFileTreeSwarmRpc({
    uiKarton,
    fileTreeService,
    promoteFileTab: (tabId) => windowLayoutService.promoteFileTab(tabId),
    runSwarmWorkflow,
    runForcedSwarmPreview,
    clearSwarmRun: (runId) => browserSwarmStore.clearRun(runId),
    logger,
  });

  // --- Wire main UI settings RPC procedures ---

  wireSettingsBrowserRpc({
    uiKarton,
    notificationSoundsService,
    syncAvailableSoundPacks,
    macOSClosedLidSleepService,
    webDataService,
    pagesService,
    historyService,
    faviconService,
    logger,
  });

  wireWorkspaceCredentialsRpc({
    uiKarton,
    toolboxService,
    agentManagerService,
    worktreeSetupSettingsService,
    credentialsService,
  });

  logger.debug('[Main] Normal operation services bootstrapped');

  if (process.env.CLODEX_DIAG_GEMINI === '1') {
    void runManualGeminiDiagnostic();
  }

  void toolboxService
    .scanWorkspaceGitCleanupCandidatesOnStartup()
    .catch((error) => {
      logger.warn(
        `[Main] Failed to scan worktree cleanup candidates: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  logger.debug('[Main] Startup complete');

  // Handle command line arguments for URLs on initial startup
  handleCommandLineUrls(
    process.argv,
    windowLayoutService,
    logger,
    (url) => authService.handleAuthCallbackUrl(url),
    (url) => mcpRegistryService.handleOAuthCallback(url),
    handleAgentOsSkillInstallUrl,
  );

  // Set up graceful shutdown to clean up database connections
  const shutdownCoordinator = createMainShutdownCoordinator({
    logger,
    exitApp: (exitCode) => app.exit(exitCode),
    preferenceListenerTeardowns: {
      agentBehaviorPreferenceListener: () => {
        preferencesService.removeListener(agentBehaviorPreferenceListener);
      },
      agentOsFeatureGatePreferenceListener: () => {
        preferencesService.removeListener(agentOsFeatureGatePreferenceListener);
      },
      updateEvidenceMemorySummaryModel: () => {
        preferencesService.removeListener(updateEvidenceMemorySummaryModel);
      },
    },
    synchronousServices: {
      localPortsScannerService,
      webDataService,
      historyService,
      faviconService,
      memoryNotesSettingsService,
      evidenceMemoryInspectorService,
      dictationService,
      hostedPullRequestService,
      quickTaskWindowService,
      diffHistoryService,
      agentCorePersistence: persistence,
      assetCacheService,
      autoUpdateService,
      agentPowerSaveBlockerService,
      macOSClosedLidSleepService,
      agentRuntimeRecoveryService,
      cloudTaskArtifactService,
    },
    asynchronousServices: {
      automationService,
      artifactBridgeFrameBroker,
      artifactBridgeService,
      spacesService,
      sessionContinuityService,
      cloudTaskTeleportController,
      cloudTaskTeleportRecovery: cloudTaskRuntime?.teleportRecovery,
      cloudTaskMemorySyncJournal: cloudTaskRuntime?.memorySyncJournal,
      agentOsService,
      remoteConnectionsService,
      pluginMarketplaceService,
      privateMarketplaceSourcesService,
      mcpSettingsService,
      mcpRegistryService,
      networkEgressControlService,
      controlledBrowserEgressSession:
        guardianEgressStartup.controlledBrowserEgressSession,
      transparentEgressProxy: guardianEgressStartup.transparentEgressProxy,
      mcpOAuthService,
      toolboxService,
      telemetryService,
      agentHostProcessService,
      agentManagerService,
    },
  });

  app.on('will-quit', shutdownCoordinator.handleWillQuit);

  if (app.commandLine.hasSwitch(SESSION_RECOVERY_ACCEPTANCE_SWITCH)) {
    const phase = parseSessionRecoveryAcceptancePhase(
      app.commandLine.getSwitchValue(SESSION_RECOVERY_ACCEPTANCE_SWITCH),
    );
    const artifact = await runSessionRecoveryAcceptance({
      phase,
      explicitUserDataDirectory:
        app.commandLine.getSwitchValue('user-data-dir'),
      userDataDirectory: app.getPath('userData'),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      agentManager: agentManagerService,
      agentStore: agentCoreSeam.store,
      agentDb: persistence.agentDb,
      windowLayout: windowLayoutService,
    });
    logger.info(
      `[session-recovery-acceptance] phase=${artifact.phase} status=passed`,
    );
    app.quit();
  }
}
