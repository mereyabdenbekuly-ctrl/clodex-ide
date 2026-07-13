/**
 * This file stores the main setup for the CLI.
 */

import { app, clipboard, dialog, powerMonitor } from 'electron';
import {
  generateText,
  stepCountIs,
  tool,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { AuthService } from './services/auth';
import { AgentManagerService } from './services/agent-manager';
import { enrichHistoryEntryWorkspaces } from './services/agent-manager/history-workspace-enrichment';
import { UserExperienceService } from './services/experience';
import { FilePickerService } from './services/file-picker';
import { FileTreeService } from './services/file-tree';
import { AppMenuService } from './services/app-menu';
import { URIHandlerService } from './services/uri-handler';
import { Logger } from './services/logger';
import { createMainShutdownCoordinator } from './services/shutdown-coordinator';
import { isUIEventName, parseUIEventProperties } from './services/telemetry';
import { GlobalConfigService } from './services/global-config';
import { NotificationService } from './services/notification';
import { PagesService } from './services/pages';
import { NotificationSoundsService } from './services/notification-sounds';
import { WindowLayoutService } from './services/window-layout';
import { HistoryService } from './services/history';
import { AgentCorePersistence } from '@clodex/agent-core/persistence';
import {
  ChatPersistenceService,
  DynamicSwarmOrchestrator,
  PendingEditService,
  SwarmRunner,
  createBattleSwarmPlan,
  createAgentSessionCheckpoint,
  createWorkspaceSnapshot,
  findCompressedHistoryReference,
  hashSessionCheckpointHistory,
  createFallbackSwarmPlan,
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
  updateAgentInstanceState,
  type AgentHistoryEntry,
  type AgentManagerStartupPolicy,
  type AgentMessage,
  type ModelTaskRole,
  type SwarmTaskRole,
} from '@clodex/agent-core';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import type { MountPermission } from '@shared/karton-contracts/ui/agent/metadata';
import type { UserPreferences } from '@shared/karton-contracts/ui/shared-types';
import { AutoUpdateService } from './services/auto-update';
import { WorktreeSetupSettingsService } from './services/worktree-setup-settings';
import type { WorktreeSetupScriptVariant } from '@shared/worktree-setup';
import { DevToolAPIService } from './services/dev-tool-api';
import { OmniboxSuggestionsService } from './services/omnibox-suggestions';
import { ensureRipgrepInstalled } from '@clodex/agent-runtime-node';
import { ToolboxService } from './services/toolbox';
import { GitService } from './services/git';
import {
  createAgentCoreSeam,
  attachAgentCoreBridge,
} from './services/agent-core-bridge/wiring';
import { registerToolboxGenerateWorkspaceMd } from './services/agent-core-bridge/handlers/toolbox';
import {
  applyBrowserAgentBehavior,
  createBrowserAgentHost,
} from './services/agent-core-bridge/host';
import { resolveFeatureGate } from '@shared/feature-gates';
import {
  getIsolatedAgentRuntimeRolloutPolicy,
  ISOLATED_AGENT_RUNTIME_DISABLE_SWITCH,
  isIsolatedAgentRuntimeDisabledByEnvironment,
} from '@shared/isolated-agent-runtime-policy';
import { createLazyBrowserHostModels } from './services/agent-core-bridge/host-models';
import { createBrowserAgentTypeRegistry } from './agents/agents-registry';
import { buildLocalWorkspaceSnapshotMetadata } from './agent-host/workspace-snapshot-builder';
import { CredentialsService } from './services/credentials';
import { McpRegistryService } from './services/mcp';
import { McpHostSupervisor } from './mcp-host';
import { McpOAuthService } from './services/mcp/oauth';
import { discoverPluginMcpServers } from './services/mcp/plugin-bridge';
import { McpSettingsService } from './services/mcp/settings';
import type { CredentialTypeId } from '@shared/credential-types';
import { ModelProviderService } from './agents/model-provider';
import { wirePagesStateSync } from './wiring/pages-state-sync';
import { wirePagesHandlers } from './wiring/pages-handler-wiring';
import {
  ensureDataDirectories,
  getNetworkPolicyAuditPath,
  getInstalledPluginsDir,
  getPluginsPath,
  getBuiltinSkillsPath,
  getRipgrepBasePath,
} from './utils/paths';
import { migrateLegacyPaths } from './utils/migrate-legacy-paths';
import { readPersistedDataSync } from './utils/persisted-data';
import { z } from 'zod';
import { runFoundationalServicesPhase } from './startup/phases/foundational-services';
import { discoverPlugins } from './utils/discover-plugins';
import { discoverSkills } from './agents/shared/prompts/utils/get-skills';
import type { Skill } from './agents/shared/prompts/utils/get-skills';
import type { SkillDefinition, SkillDefinitionUI } from '@shared/skills';
import { isCloudTaskKillSwitchActive } from '@shared/cloud-task-rollout';
import { isClodexCloudSelected } from '@shared/provider-consent';
import {
  EvidenceMemoryCanaryController,
  getEvidenceMemoryRolloutPolicy,
  isEvidenceMemoryInjectionDisabled,
} from '@shared/evidence-memory-rollout';
import { AssetCacheService } from './services/asset-cache';
import { detectShell, resolveShellEnv } from '@clodex/agent-shell';
import { NetworkEgressControlCenterService } from './services/network-policy/control-center';
import { initializeGuardianEgressStartup } from './services/network-policy/startup';
import path from 'node:path';
import { readFile as readFsFile } from 'node:fs/promises';
import {
  createCloudTaskRuntime,
  type CloudTaskRuntimeResult,
} from './startup/phases/cloud-task-runtime';
import { handleCommandLineUrls, setupUrlHandlers } from './startup/url-routing';
import { AgentPowerSaveBlockerService } from './services/agent-power-save-blocker';
import { AgentRuntimeRecoveryService } from './services/agent-runtime-recovery';
import { MacOSClosedLidSleepService } from './services/macos-closed-lid-sleep';
import {
  AgentHostProcessService,
  CloudTaskExecutionLeaseRegistry,
  createBrowserAgentStepExecutor,
  createExecutionTargetRouter,
} from './agent-host';
import { CloudTaskTeleportController } from './services/cloud-task-teleport';
import { createBrowserIsolatedAgentTurnHandlers } from './agent-host/browser-turn-adapter';
import { BrowserSwarmStore } from './services/swarm-orchestrator';
import type {
  HistoryFilter,
  HistoryResult,
  FaviconBitmapResult,
} from '@shared/karton-contracts/pages-api/types';
import {
  createAgentsMdDomainAdapter,
  createEnabledSkillsDomainAdapter,
  createFileDiffsDomainAdapter,
  createLogsDomainAdapter,
  createMemoryDomainAdapter,
  createPlansDomainAdapter,
  createRuntimeContextDomainAdapter,
  createWorkspaceDomainAdapter,
  createWorkspaceMdDomainAdapter,
} from '@clodex/agent-core/env/adapters';
import {
  createBrowserHostEnvironmentSources,
  registerHostEnvDomainAdapters,
} from './env-domains';
import { AgentOsService } from './services/agent-os';
import { GuardianService } from './services/guardian';
import { toGuardianAssessmentObservation } from './services/guardian/audit';
import { createNetworkGuardianRequest } from './services/guardian/requests';
import { MemoryNotesSettingsService } from './services/memory-notes-settings';
import { EvidenceMemoryInspectorService } from './services/evidence-memory-inspector';
import { EvidenceMemoryDogfoodBackfill } from './services/evidence-memory-dogfood-backfill';
import { createEvidenceMemoryModelSummarizer } from './services/evidence-memory-model-summarizer';
import { DictationService } from './services/dictation';
import { HostedPullRequestService } from './services/hosted-pull-request';
import {
  GeneratedAppLibraryService,
  type GeneratedAppOwnerSnapshot,
} from './services/generated-app-library';
import { QuickTaskWindowService } from './services/quick-task-window';
import { CloudTaskArtifactService } from './services/cloud-task-artifacts';
import { RemoteConnectionsService } from './services/remote-connections';
import { PluginMarketplaceService } from './services/plugin-marketplace';
import { PrivateMarketplaceSourcesService } from './services/plugin-marketplace/private-sources';
import { OFFICIAL_PLUGIN_MARKETPLACE_KEYS } from './services/plugin-marketplace/trusted-keys';
import {
  AutomationService,
  createAutomationAgentMessage,
} from './services/automations';
import { NativeWakeScheduler } from './services/automations/native-wake';
import { ArtifactBridgeService } from './services/artifact-bridge';
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
import { prepareProtectedStorage } from './startup/phases/prepare-protected-storage';

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

  // HistoryService depends on WebDataService (created above) + telemetry.
  const historyService = await HistoryService.create(
    logger,
    webDataService,
    telemetryService,
  );

  // Create PagesService early so it can be passed to WindowLayoutService
  const pagesService = await PagesService.create(
    logger,
    historyService,
    faviconService,
    telemetryService,
  );

  // Create WindowLayoutService with all dependencies including PreferencesService
  // This also applies the startup page preference during initialization
  const windowLayoutService = await WindowLayoutService.create(
    logger,
    historyService,
    faviconService,
    pagesService,
    preferencesService,
    attachments,
    telemetryService,
    guardianEgressStartup.controlledBrowserTabEgressOptions,
  );
  const uiKarton = windowLayoutService.uiKarton;
  const fileTreeService = await FileTreeService.create(logger, uiKarton);
  fileTreeService.setOpenFileTabHandler(
    async (metadata, agentInstanceId, options) => {
      const tabId = await windowLayoutService.openFileTab(
        metadata,
        agentInstanceId,
        options,
      );
      // Read-only, agent-internal files (e.g. `att/` attachment blobs) are
      // not part of any listed workspace tree, so revealing them would only
      // force the panel open on a non-existent workspace. Skip the reveal.
      if (!metadata.readOnly) {
        fileTreeService.revealInFileTree(
          metadata.workspaceKey,
          metadata.relativePath,
        );
      }
      return tabId;
    },
  );
  // Let the file-tree service resolve a given agent's attachment blob
  // directory so it can open `att/` blobs as read-only tabs.
  fileTreeService.setAttachmentDirResolver((agentId) =>
    attachments.agentBlobDir(agentId),
  );
  fileTreeService.setAttachmentReader(
    (attachmentDir) => {
      const normalized = path.resolve(attachmentDir);
      if (path.basename(normalized) !== 'data-attachments') return null;
      const agentId = path.basename(path.dirname(normalized));
      return agentId || null;
    },
    (agentId, attachmentId) => attachments.read(agentId, attachmentId),
  );

  const detectedShell = detectShell();
  const resolvedEnvPromise = detectedShell
    ? resolveShellEnv(detectedShell)
    : Promise.resolve(null);
  const gitService = await GitService.create({
    logger,
    telemetryService,
    resolvedEnvPromise,
  });

  // Push search engine definitions to UI karton state.
  webDataService
    .getSearchEngines()
    .then((engines) => {
      uiKarton.setState((draft) => {
        draft.searchEngines = engines;
      });
      if (verbose)
        logger.debug(
          `[Main] Pushed ${engines.length} search engines to UI karton`,
        );
    })
    .catch((error) => {
      logger.warn('[Main] Failed to load search engines', error);
    });

  // Phase 3a: build the agent-core seam (store + controllers + registry)
  // early so services that consume store-canonical state — currently
  // `DiffHistoryService` via the store itself — can receive their
  // dependency as an injected capability. The bridge itself is attached
  // later, once `agentCoreHost` exists (post-ModelProviderService).
  const agentCoreSeam = createAgentCoreSeam({ karton: uiKarton });
  const agentHostProcessService = await AgentHostProcessService.create(logger, {
    telemetry: {
      capture(eventName, properties) {
        telemetryService.capture(eventName as never, properties as never);
      },
    },
  }).catch((error) => {
    // This first split-process slice is a control-plane watchdog and
    // content-free runtime ledger. Keep startup available if the worker
    // cannot launch and let AgentRuntimeRecoveryService retain its local
    // watchdog fallback.
    logger.warn(
      '[Main] Agent utility process failed to start; using main-process recovery watchdog',
      error,
    );
    return null;
  });
  agentHostProcessService?.bindAgentStore(agentCoreSeam.store);
  const isolatedAgentRuntimeLaunchGate = resolveFeatureGate(
    'isolated-agent-runtime',
    preferencesService.get().featureGates.overrides,
    __APP_RELEASE_CHANNEL__,
  );
  const isolatedAgentRuntimeWorkerAvailable =
    agentHostProcessService?.canExecuteAgentWorkloads ?? false;
  telemetryService.capture('isolated-agent-runtime-rollout-observed', {
    rollout_stage: isolatedAgentRuntimePolicy.rolloutStage,
    policy_default_enabled: isolatedAgentRuntimePolicy.defaultEnabled,
    gate_enabled: isolatedAgentRuntimeLaunchGate.enabled,
    gate_source: isolatedAgentRuntimeLaunchGate.source,
    kill_switch_active: isolatedAgentRuntimeKillSwitchActive,
    worker_available: isolatedAgentRuntimeWorkerAvailable,
    effective_enabled:
      isolatedAgentRuntimeLaunchGate.enabled &&
      !isolatedAgentRuntimeKillSwitchActive &&
      isolatedAgentRuntimeWorkerAvailable,
    failure_threshold: isolatedAgentRuntimePolicy.failureThreshold,
    cooldown_ms: isolatedAgentRuntimePolicy.cooldownMs,
  });

  // Phase 5: assemble a partial `AgentHost` early so `DiffHistoryService`
  // (now a package-side service) can receive the host + store as
  // injected dependencies. `ModelProviderService` does not exist yet —
  // `createLazyBrowserHostModels()` returns a proxy whose `get()` throws
  // until `setModelProviderService(...)` is called further down. The
  // `DiffHistoryService` itself never consults `host.models`, so the
  // lazy slot is invisible in practice.
  const lazyHostModels = createLazyBrowserHostModels();
  const resolveAgentBehavior = (preferences: UserPreferences) => {
    const collaborationPresets = resolveFeatureGate(
      'collaboration-presets',
      preferences.featureGates.overrides,
      __APP_RELEASE_CHANNEL__,
    );

    return {
      personality: preferences.agent.personality,
      collaborationMode: collaborationPresets.enabled
        ? preferences.agent.collaborationMode
        : ('default' as const),
    };
  };
  const initialAgentBehavior = resolveAgentBehavior(preferencesService.get());
  const agentCoreHost = createBrowserAgentHost({
    logger,
    telemetryService,
    paths: hostPaths,
    models: lazyHostModels.hostModels,
    dataProtection,
    protectedFiles,
    agentPersonality: initialAgentBehavior.personality,
    collaborationMode: initialAgentBehavior.collaborationMode,
  });
  const agentBehaviorPreferenceListener = (
    newPreferences: UserPreferences,
    oldPreferences: UserPreferences,
  ) => {
    const nextBehavior = resolveAgentBehavior(newPreferences);
    const previousBehavior = resolveAgentBehavior(oldPreferences);
    if (
      nextBehavior.personality === previousBehavior.personality &&
      nextBehavior.collaborationMode === previousBehavior.collaborationMode
    ) {
      return;
    }

    applyBrowserAgentBehavior(
      agentCoreHost,
      nextBehavior.personality,
      nextBehavior.collaborationMode,
    );
  };
  preferencesService.addListener(agentBehaviorPreferenceListener);

  const refreshPluginDefinitions = async (): Promise<void> => {
    const [bundledPlugins, marketplacePlugins] = await Promise.all([
      discoverPlugins(getPluginsPath(), 'bundled'),
      discoverPlugins(getInstalledPluginsDir(), 'marketplace'),
    ]);
    const bundledIds = new Set(bundledPlugins.map((plugin) => plugin.id));
    const collisionIds = marketplacePlugins
      .filter((plugin) => bundledIds.has(plugin.id))
      .map((plugin) => plugin.id);
    if (collisionIds.length > 0) {
      logger.warn(
        `[Main] Ignoring marketplace plugins that collide with bundled IDs: ${collisionIds.join(', ')}`,
      );
    }
    const plugins = [
      ...bundledPlugins,
      ...marketplacePlugins.filter((plugin) => !bundledIds.has(plugin.id)),
    ];
    uiKarton.setState((draft: { plugins: typeof plugins }) => {
      draft.plugins = plugins;
    });
    if (verbose) {
      logger.debug(
        `[Main] Pushed ${bundledPlugins.length} bundled and ${plugins.length - bundledPlugins.length} marketplace plugins to UI karton`,
      );
    }
  };

  // Phase D.2: the host enumerates `AgentCorePersistence` once instead
  // of constructing each persistence service by name. The facade owns
  // construction order, schema-migration sequencing, and teardown for
  // `DiffHistoryService`, `FileReadCacheService`,
  // `ProcessedImageCacheService`, `AttachmentsService`, and
  // `AgentPersistenceDB`. `attachments` is passed in so we share the
  // already-constructed instance with `WindowLayoutService`.
  const evidenceMemoryCanary = new EvidenceMemoryCanaryController(
    getEvidenceMemoryRolloutPolicy(__APP_RELEASE_CHANNEL__),
    isEvidenceMemoryInjectionDisabled(
      process.env.CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION,
    ),
  );
  const evidenceMemoryPromptGateEnabled = resolveFeatureGate(
    'evidence-memory-prompt-injection',
    preferencesService.get().featureGates.overrides,
    __APP_RELEASE_CHANNEL__,
  ).enabled;
  const persistence = await AgentCorePersistence.create({
    host: agentCoreHost,
    store: agentCoreSeam.store,
    attachments,
    enableEvidenceMemory:
      resolveFeatureGate(
        'evidence-memory-shadow',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled || evidenceMemoryPromptGateEnabled,
    enableEvidenceMemoryPromptInjection: evidenceMemoryPromptGateEnabled,
    evidenceMemoryPromptInjectionAdmission: (taskId) =>
      evidenceMemoryCanary.isTaskAdmitted(taskId),
    onEvidenceMemoryDogfoodCohortEvaluated: (report) => {
      const before = evidenceMemoryCanary.snapshot();
      const after = evidenceMemoryCanary.observe(report);
      if (!before.rolledBack && after.rolledBack) {
        logger.error(
          `[EvidenceMemory] Canary rolled back automatically: ${after.rollbackReasons.join(', ')}`,
        );
      }
    },
    enableEvidenceMemoryHybridRetrieval: resolveFeatureGate(
      'evidence-memory-hybrid-retrieval',
      preferencesService.get().featureGates.overrides,
      __APP_RELEASE_CHANNEL__,
    ).enabled,
    onProtectedMigrationStage: (stage) => {
      protectedMigrationOrder.mark(stage);
    },
  });
  if (persistence.evidenceMemory) {
    try {
      const restoredCohort =
        await persistence.evidenceMemory.getDogfoodCohortReport();
      const restoredSnapshot = evidenceMemoryCanary.observe(restoredCohort);
      if (restoredSnapshot.rolledBack) {
        logger.warn(
          `[EvidenceMemory] Canary starts rolled back from durable cohort evidence: ${restoredSnapshot.rollbackReasons.join(', ')}`,
        );
      }
    } catch (error) {
      evidenceMemoryCanary.rollback('health-restore-failed');
      logger.warn(
        '[EvidenceMemory] Failed to restore canary health; prompt injection remains fail-closed by task admission',
        error,
      );
    }
  }
  protectedMigrationOrder.assertComplete();
  const diffHistoryService = persistence.diffHistory;
  const pendingEditService = new PendingEditService({
    store: agentCoreSeam.store,
    logger,
  });

  // Connect PreferencesService to Karton for reactive sync
  preferencesService.connectKarton(uiKarton, pagesService);
  let networkEgressControlService: NetworkEgressControlCenterService | null =
    null;
  const guardianEgressControlCenter = guardianEgressStartup.controlCenter;
  if (guardianEgressControlCenter.enabled) {
    try {
      networkEgressControlService =
        await NetworkEgressControlCenterService.create({
          logger,
          karton: uiKarton,
          preferences: preferencesService,
          auditPath: getNetworkPolicyAuditPath(),
          isFeatureEnabled: startupFeatureEnabled,
          getRuntimeStatus: guardianEgressControlCenter.getRuntimeStatus,
          getBrowserPolicy: guardianEgressControlCenter.getBrowserPolicy,
          applyBrowserGrants: guardianEgressControlCenter.applyBrowserGrants,
        });
    } catch (error) {
      logger.error(
        '[NetworkEgressControl] Initialization failed; control surface unavailable',
        error,
      );
    }
  }
  const memoryNotesSettingsService = await MemoryNotesSettingsService.create({
    logger,
    karton: uiKarton,
    preferences: preferencesService,
    memoryNotes: persistence.memoryNotes,
    isFeatureEnabled: (feature) =>
      resolveFeatureGate(
        feature,
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
  });
  const evidenceMemoryInspectorService =
    await EvidenceMemoryInspectorService.create({
      logger,
      karton: uiKarton,
      evidenceMemory: persistence.evidenceMemory,
      summaryScheduler: persistence.evidenceMemorySummaryScheduler,
      dogfoodBackfill: persistence.evidenceMemory
        ? new EvidenceMemoryDogfoodBackfill({
            memoryDir: agentCoreHost.paths.memoryDir(),
            protectedFiles: agentCoreHost.protectedFiles,
            evidenceMemory: persistence.evidenceMemory,
          })
        : undefined,
      isFeatureEnabled: (feature) =>
        resolveFeatureGate(
          feature,
          preferencesService.get().featureGates.overrides,
          __APP_RELEASE_CHANNEL__,
        ).enabled,
    });

  // Create OmniboxSuggestionsService for omnibox autocomplete
  const _omniboxSuggestionsService = await OmniboxSuggestionsService.create(
    logger,
    uiKarton,
    historyService,
    webDataService,
    faviconService,
    localPortsScannerService,
  );

  // Set up URL handlers, capturing the auth callback registration function
  const {
    registerAuthCallbackHandler,
    registerMcpOAuthCallbackHandler,
    registerSkillInstallHandler,
  } = setupUrlHandlers(windowLayoutService, logger);

  const notificationService = await NotificationService.create(
    logger,
    uiKarton,
  );

  // Initialize auto-update service (only runs on macOS and Windows, skipped for dev builds)
  const autoUpdateService = await AutoUpdateService.create(
    logger,
    notificationService,
    telemetryService,
    preferencesService,
    uiKarton,
  );

  const globalConfigService = await GlobalConfigService.create(
    logger,
    uiKarton,
  );

  // Resolve the sounds directory.
  // Packaged: extraResource copies leaf dirs directly into Resources/.
  // So ./assets/sounds → Resources/sounds/, NOT Resources/assets/sounds/.
  // Dev: app.getAppPath() = project root where assets/sounds/ exists.
  const soundsDir = app.isPackaged
    ? path.join(process.resourcesPath!, 'sounds')
    : path.join(app.getAppPath(), 'assets', 'sounds');
  const importedPacksDir = path.join(
    app.getPath('userData'),
    'imported-sound-packs',
  );

  const notificationSoundsService = await NotificationSoundsService.create(
    logger,
    uiKarton,
    soundsDir,
    importedPacksDir,
    globalConfigService.get(),
  );

  notificationSoundsService.setWindowRef(() =>
    windowLayoutService.getBaseWindow(),
  );
  notificationSoundsService.setWebContentsRef(() =>
    windowLayoutService.getUIWebContents(),
  );

  const notificationSoundsConfigListener: Parameters<
    typeof globalConfigService.addConfigUpdatedListener
  >[0] = (newConfig) => {
    notificationSoundsService.onConfigUpdated(newConfig);
  };
  globalConfigService.addConfigUpdatedListener(
    notificationSoundsConfigListener,
  );

  const syncAvailableSoundPacks = async (
    selectedPack?: string,
  ): Promise<void> => {
    const packs = notificationSoundsService.listPacks();
    const displayNames = notificationSoundsService.getPackDisplayNames();

    uiKarton.setState((draft) => {
      draft.notificationSoundPacks = {
        available: packs,
        displayNames,
      };
    });

    if (selectedPack) {
      await globalConfigService.set({
        ...globalConfigService.get(),
        notificationSoundPack: selectedPack,
      });
    }
  };

  void syncAvailableSoundPacks().catch((err) => {
    logger.error('[Main] Failed to save discovered sound packs', err);
  });

  ensureRipgrepInstalled({
    rgBinaryBasePath: getRipgrepBasePath(),
    onLog: logger.debug,
  })
    .then((result) => {
      if (!result.success) {
        telemetryService.captureException(
          new Error(result.error ?? 'Unknown error'),
          { service: 'main', operation: 'ensureRipgrep' },
        );
        logger.warn(
          `Ripgrep installation failed: ${result.error}. Grep/glob operations will use slower Node.js implementations.`,
        );
      } else {
        if (verbose)
          logger.debug('Ripgrep is available for grep/glob operations');
      }
    })
    .catch((error) => {
      logger.warn(
        `Ripgrep installation failed: ${error}. Grep/glob operations will use slower Node.js implementations.`,
      );
      telemetryService.captureException(error as Error, {
        service: 'main',
        operation: 'ensureRipgrep',
      });
    });

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

  // Start remaining services that are irrelevant to non-regular operation of the app.
  const filePickerService = await FilePickerService.create(logger, uiKarton);

  // DevToolAPIService handles devtools-related functionality and state
  const _devToolAPIService = await DevToolAPIService.create(
    logger,
    uiKarton,
    windowLayoutService,
  );

  // URIHandlerService registers the app as the default protocol client for clodex://
  // URL handling is delegated to startup/url-routing.ts
  await URIHandlerService.create(logger);

  const authService = await AuthService.create(
    identifierService,
    uiKarton,
    notificationService,
    logger,
  );

  // Wire auth callback handler so social sign-in / protocol URLs are
  // routed to AuthService instead of opened as browser tabs.
  registerAuthCallbackHandler((url) => authService.handleAuthCallbackUrl(url));

  const userExperienceService = await UserExperienceService.create(
    logger,
    uiKarton,
    telemetryService,
    gitService,
    () => persistence.agentDb.getOldestAgentCreatedAt(),
    () => persistence.agentDb.getAgentCount(),
  );

  const credentialsService = await CredentialsService.create(logger);

  credentialsService.setAccessTokenProvider(() => authService.accessToken);
  await preferencesService.migrateProviderProfiles(
    credentialsService,
    authService.modelAccessToken,
  );
  authService.registerAuthStateChangeCallback(() => {
    void preferencesService
      .syncClodexAccountProfile(
        credentialsService,
        authService.modelAccessToken,
      )
      .catch((error) =>
        logger.error(
          `[PreferencesService] Failed to sync Clodex provider profile: ${error}`,
        ),
      );
  });
  const isClodexCloudEnabled = () =>
    isClodexCloudSelected(
      preferencesService.get(),
      Boolean(authService.accessToken),
    );
  const mcpOAuthService = await McpOAuthService.create({ logger });
  const guardianEgressRemoteMcp = guardianEgressStartup.remoteMcp;
  const mcpRegistryService = await McpRegistryService.create({
    logger,
    credentialsService,
    oauthService: mcpOAuthService,
    ...(guardianEgressRemoteMcp.enabled
      ? {
          createHost: async (hostOptions) =>
            await McpHostSupervisor.create(logger, {
              ...hostOptions,
              resolveNetworkProxy: guardianEgressRemoteMcp.resolveNetworkProxy,
              revokeNetworkProxy: guardianEgressRemoteMcp.revokeNetworkProxy,
            }),
        }
      : {}),
  });
  registerMcpOAuthCallbackHandler((url) =>
    mcpRegistryService.handleOAuthCallback(url),
  );
  const mcpSettingsService = await McpSettingsService.create({
    logger,
    karton: uiKarton,
    registry: mcpRegistryService,
    credentials: credentialsService,
  });
  const syncMarketplaceMcpServers = async (
    installed: ReturnType<PluginMarketplaceService['getState']>['installed'],
  ) => {
    const servers = await discoverPluginMcpServers({
      installedDir: getInstalledPluginsDir(),
      installed,
      isExecutableRuntimeEnabled: () =>
        resolveFeatureGate(
          'executable-extensions',
          preferencesService.get().featureGates.overrides,
          __APP_RELEASE_CHANNEL__,
        ).enabled,
    });
    await mcpRegistryService.syncPluginServers(servers);
  };
  let toolboxServiceForMarketplace: ToolboxService | null = null;
  const pluginMarketplaceService = await PluginMarketplaceService.create({
    logger,
    karton: uiKarton,
    appVersion: __APP_VERSION__,
    trustedKeys: OFFICIAL_PLUGIN_MARKETPLACE_KEYS,
    isFeatureEnabled: (feature) =>
      resolveFeatureGate(
        feature,
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
    onPluginsChanged: async () => {
      await refreshPluginDefinitions();
      toolboxServiceForMarketplace?.refreshPluginSkills();
      await syncMarketplaceMcpServers(
        pluginMarketplaceService.getState().installed,
      );
    },
    audit: (event) => {
      telemetryService.capture('plugin-marketplace-operation', {
        operation: event.operation,
        success: event.success,
        duration_ms: event.durationMs,
        plugin_id: event.pluginId,
        version: event.version,
        permission_count: event.permissionCount,
        catalog_size: event.catalogSize,
        key_id: event.keyId,
      });
    },
  });
  const privateMarketplaceSourcesService =
    await PrivateMarketplaceSourcesService.create({
      logger,
      karton: uiKarton,
      appVersion: __APP_VERSION__,
      installer: pluginMarketplaceService,
      isFeatureEnabled: (feature) =>
        resolveFeatureGate(
          feature,
          preferencesService.get().featureGates.overrides,
          __APP_RELEASE_CHANNEL__,
        ).enabled,
    });
  await refreshPluginDefinitions();
  await syncMarketplaceMcpServers(
    pluginMarketplaceService.getState().installed,
  );

  const hostedPullRequestService = await HostedPullRequestService.create({
    logger,
    telemetryService,
    credentialsService,
    gitService,
  });
  const toolboxService = await ToolboxService.create(
    logger,
    uiKarton,
    diffHistoryService,
    pendingEditService,
    windowLayoutService,
    authService,
    telemetryService,
    filePickerService,
    userExperienceService,
    credentialsService,
    mcpRegistryService,
    gitService,
    preferencesService,
    detectedShell,
    resolvedEnvPromise,
    agentCoreSeam.store,
    agentCoreSeam.hostAgentStateMutations,
    attachments,
    persistence.memoryNotes,
    agentHostProcessService,
    protectedFiles,
  );
  toolboxService.setNetworkPolicyEvaluator(
    guardianEgressStartup.networkPolicyEvaluator,
  );
  toolboxServiceForMarketplace = toolboxService;
  mcpRegistryService.setElicitationHandler(
    async (serverId, agentInstanceId, request, signal) =>
      await toolboxService.requestMcpElicitation(
        serverId,
        agentInstanceId,
        request,
        signal,
      ),
  );
  const remoteConnectionsService = await RemoteConnectionsService.create({
    logger,
    karton: uiKarton,
    createTerminal: () => toolboxService.createUserTerminal(),
    writeTerminalInput: (terminalId, data) =>
      toolboxService.writeUserTerminalInput(terminalId, data),
  });
  toolboxService.setRemoteConnectionsService(remoteConnectionsService);
  agentHostProcessService?.setAgentTurnHandlers(
    createBrowserIsolatedAgentTurnHandlers({
      host: agentCoreHost,
      toolbox: toolboxService,
    }),
  );

  // Give DiffHistoryService a way to resolve workspace roots for the
  // gitignore-aware filter in `registerAgentEdit`. Evaluated lazily per
  // call, so the (still-async) MountManager initialization inside
  // ToolboxService does not need to be awaited before wiring.
  persistence.setMountPathsResolver(() => toolboxService.getAllMountedPaths());

  // Push bundled skill definitions via the toolbox so it can
  // merge them with workspace/plugin skills on mount changes.
  // Display order for builtin slash commands (unlisted ones sort last).
  const BUILTIN_ORDER: Record<string, number> = {
    plan: 0,
    debug: 1,
    preview: 2,
    learn: 3,
  };

  discoverSkills(getBuiltinSkillsPath()).then((skills: Skill[]) => {
    const builtins: SkillDefinition[] = skills
      .map((s) => ({
        id: `command:${s.name.toLowerCase()}`,
        displayName: s.name,
        description: s.description,
        source: 'builtin' as const,
        contentPath: `${s.path}/SKILL.md`,
        userInvocable: s.userInvocable,
        agentInvocable: s.agentInvocable,
      }))
      .sort(
        (a, b) =>
          (BUILTIN_ORDER[a.displayName.toLowerCase()] ?? 99) -
          (BUILTIN_ORDER[b.displayName.toLowerCase()] ?? 99),
      );
    toolboxService.setBuiltinSkills(builtins);
    if (verbose)
      logger.debug(
        `[Main] Pushed ${builtins.length} bundled skills to UI karton`,
      );
  });

  const _appMenuService = new AppMenuService(
    logger,
    authService,
    windowLayoutService,
  );

  const modelProviderService = new ModelProviderService(
    telemetryService,
    authService,
    preferencesService,
    credentialsService,
  );
  const evidenceMemoryModelSummarizer =
    createEvidenceMemoryModelSummarizer(modelProviderService);
  const updateEvidenceMemorySummaryModel = () => {
    const enabled = resolveFeatureGate(
      'evidence-memory-model-summaries',
      preferencesService.get().featureGates.overrides,
      __APP_RELEASE_CHANNEL__,
    ).enabled;
    persistence.evidenceMemorySummaryScheduler?.setSummarizer(
      enabled ? evidenceMemoryModelSummarizer : undefined,
    );
  };
  updateEvidenceMemorySummaryModel();
  preferencesService.addListener(updateEvidenceMemorySummaryModel);
  uiKarton.registerServerProcedureHandler(
    'preferences.testProviderProfile',
    async (_callingClientId: string, profileId: string) =>
      modelProviderService.validateProviderProfile(profileId),
  );
  uiKarton.registerServerProcedureHandler(
    'preferences.listProviderProfileModels',
    async (_callingClientId: string, profileId: string) =>
      modelProviderService.listProviderProfileModels(profileId),
  );
  const dictationService = DictationService.create({
    logger,
    karton: uiKarton,
    modelProvider: modelProviderService,
    isFeatureEnabled: (feature) =>
      resolveFeatureGate(
        feature,
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
  });
  const runManualGeminiDiagnostic = async () => {
    const modelId = process.env.CLODEX_DIAG_GEMINI_MODEL ?? 'gemini-3.5-flash';
    const traceBase = `manual-gemini-diagnostic:${crypto.randomUUID()}`;
    const truncate = (value: string, maxLength = 900) =>
      value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
    const stringifyErrorPart = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const getErrorSearchText = (
      error: unknown,
      seen = new WeakSet<object>(),
    ): string => {
      if (error === null || error === undefined) return '';
      if (typeof error !== 'object') return String(error);
      if (seen.has(error)) return '';
      seen.add(error);

      const record = error as Record<string, unknown>;
      const parts = [
        error instanceof Error ? error.name : undefined,
        error instanceof Error ? error.message : undefined,
        record.message,
        record.statusText,
        record.responseBody,
        record.body,
        record.data,
        record.error,
        record.errors,
        record.cause,
      ];

      return parts
        .flatMap((part) => [
          stringifyErrorPart(part),
          getErrorSearchText(part, seen),
        ])
        .filter(Boolean)
        .join('\n');
    };
    const withTimeout = async <T>(
      name: string,
      run: (abortSignal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 45_000);
      try {
        return await run(abortController.signal);
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`${name} timed out after 45s`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    const runCase = async <
      TResult extends {
        finishReason: string;
        text: string;
        usage: { totalTokens?: number | null };
      },
    >(
      name: string,
      run: (abortSignal: AbortSignal) => Promise<TResult>,
    ) => {
      logger.info(`[GeminiDiag] ${name}: START model=${modelId}`);
      try {
        const result = await withTimeout(name, run);
        logger.info(
          `[GeminiDiag] ${name}: PASS finishReason=${result.finishReason} totalTokens=${result.usage.totalTokens ?? 'unknown'} text="${truncate(result.text.trim(), 220)}"`,
        );
        return true;
      } catch (error) {
        logger.error(
          `[GeminiDiag] ${name}: FAIL ${truncate(getErrorSearchText(error))}`,
        );
        return false;
      }
    };

    logger.info(
      `[GeminiDiag] Starting manual Gemini route test for ${modelId}`,
    );
    try {
      const modelWithOptions =
        await modelProviderService.getModelWithOptionsAsync(
          modelId,
          traceBase,
          {
            $ai_span_name: 'manual-gemini-diagnostic',
            [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'manual-gemini-diagnostic',
            [MODEL_TASK_ROLE_METADATA_KEY]: 'analysis',
            preferred_model_id: modelId,
          },
        );
      logger.info(
        `[GeminiDiag] Model resolved providerMode=${modelWithOptions.providerMode} contextWindow=${modelWithOptions.contextWindowSize}`,
      );

      const minimalPassed = await runCase('minimal-no-tools', (abortSignal) =>
        generateText({
          model: modelWithOptions.model,
          headers: modelWithOptions.headers,
          abortSignal,
          messages: [
            {
              role: 'user',
              content: 'Reply exactly: GEMINI_OK',
            },
          ],
          temperature: 0,
          maxOutputTokens: 32,
          maxRetries: 0,
        }),
      );

      const providerOptionsPassed = await runCase(
        'provider-options-no-tools',
        (abortSignal) =>
          generateText({
            model: modelWithOptions.model,
            providerOptions: modelWithOptions.providerOptions,
            headers: modelWithOptions.headers,
            abortSignal,
            messages: [
              {
                role: 'user',
                content: 'Reply exactly: GEMINI_OPTIONS_OK',
              },
            ],
            temperature: 0,
            maxOutputTokens: 32,
            maxRetries: 0,
          }),
      );

      const toolsPassed = await runCase('required-tool-call', (abortSignal) =>
        generateText({
          model: modelWithOptions.model,
          providerOptions: modelWithOptions.providerOptions,
          headers: modelWithOptions.headers,
          abortSignal,
          messages: [
            {
              role: 'user',
              content:
                'Call the echo diagnostic tool with value "GEMINI_TOOL_OK", then reply with the returned value.',
            },
          ],
          temperature: 0,
          maxOutputTokens: 96,
          maxRetries: 0,
          tools: {
            echo: tool({
              description:
                'Diagnostic echo tool. Use it when the user asks for a Gemini tool-call test.',
              inputSchema: z.object({
                value: z.string(),
              }),
              execute: async ({ value }) => ({ value }),
            }),
          },
          toolChoice: 'required',
          stopWhen: stepCountIs(2),
        }),
      );

      logger.info(
        `[GeminiDiag] Summary minimal=${minimalPassed ? 'PASS' : 'FAIL'} providerOptions=${providerOptionsPassed ? 'PASS' : 'FAIL'} tools=${toolsPassed ? 'PASS' : 'FAIL'}`,
      );
    } catch (error) {
      logger.error(
        `[GeminiDiag] Setup failed: ${truncate(getErrorSearchText(error))}`,
      );
    }
  };

  // Wire the model-provider into the toolbox so the shell tool can run the
  // smart-approval classifier on demand. Done here because
  // `ModelProviderService` depends on `preferencesService`, which is
  // constructed after the toolbox itself.
  toolboxService.setModelProviderService(modelProviderService);

  const assetCacheService = await AssetCacheService.create(
    () => (isClodexCloudEnabled() ? authService.accessToken : undefined),
    logger,
    {
      dataProtection,
      readFile: async (filePath) => {
        const relative = path.relative(hostPaths.agentsDir(), filePath);
        const parts = relative.split(path.sep);
        if (
          !relative.startsWith(`..${path.sep}`) &&
          parts.length === 3 &&
          parts[0] &&
          parts[1] === 'data-attachments' &&
          parts[2]
        ) {
          return attachments.read(parts[0], parts[2]);
        }
        return readFsFile(filePath);
      },
    },
  );

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
    dispatch: async ({ automation }) => {
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
  const artifactBridgeService = await ArtifactBridgeService.create({
    logger,
    karton: uiKarton,
    mcpRegistry: mcpRegistryService,
    isFeatureEnabled: () =>
      resolveFeatureGate(
        'artifact-bridge',
        preferencesService.get().featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
    askAgent: async (context, prompt) => {
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
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 1_024,
        abortSignal: AbortSignal.timeout(30_000),
      });
      return result.text;
    },
    runAutomation: async (automationId) =>
      await automationService.runAutomationNow(automationId),
    resolveApp: async () => null,
  });
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

  toolboxService.setWorkspaceLastUsedAtResolver(
    async (workspacePaths) =>
      (await persistence.agentDb.getWorkspaceLastUsedAtByPath(
        workspacePaths,
      )) ?? new Map(),
  );

  registerToolboxGenerateWorkspaceMd(agentCoreSeam.registry, uiKarton, {
    store: agentCoreSeam.store,
    generateWorkspaceMdForPath: (workspacePath) =>
      agentManagerService.generateWorkspaceMdForPath(workspacePath),
  });

  // Phase 5: now that `ModelProviderService` exists, activate the lazy
  // `HostModels` slot inside the already-assembled `agentCoreHost`. Must
  // happen before `attachAgentCoreBridge` so any attach-phase handler
  // that consults `host.models` sees a ready adapter.
  lazyHostModels.setModelProviderService(modelProviderService);

  // Phase 1c+1d+5: attach the bridge. Bridges every migrated Karton
  // procedure (`toolbox.dismissActiveApp`, `toolbox.clearPendingAppMessage`,
  // `toolbox.acceptHunks`, `toolbox.rejectHunks`) through the
  // `CommandRegistry`, and starts mirroring the AgentStore-canonical
  // `activeApp`, `pendingAppMessage`, `pendingFileDiffs`, `editSummary`,
  // and `workspace.mounts` slices into Karton for the UI.
  //
  // Must run AFTER every legacy service has finished registering its own
  // Karton handlers — the bridge's drift guard runs against the final
  // registry, and Karton rejects double-registrations. Handles are kept
  // alive for the host lifetime.
  const agentCoreBridge = attachAgentCoreBridge(agentCoreSeam, {
    host: agentCoreHost,
    diffHistory: diffHistoryService,
    pendingEdits: pendingEditService,
  });
  // Phase 1d: route `SandboxService` app-lifecycle writes through the
  // AgentStore-backed controller instead of Karton.
  toolboxService.setActiveAppController(agentCoreBridge.activeAppController);

  // Register every env-state {@link DomainAdapter} (core + host) on
  // the agent manager. Core adapters are wired here so `AgentManager`
  // stays host-agnostic; host adapters reuse the same `toolboxService`
  // closures previously used by the legacy environment providers.
  agentCoreHost.environmentSources = createBrowserHostEnvironmentSources({
    karton: uiKarton,
    toolbox: toolboxService,
  });
  const coreMountManager = toolboxService.getMountManager();
  if (!coreMountManager) {
    throw new Error(
      '[Main] toolboxService.getMountManager() returned null — mount manager must be initialized before env-state adapter wiring',
    );
  }
  agentManagerService.registerEnvAdapter(
    createRuntimeContextDomainAdapter({
      host: agentCoreHost,
      mountManager: coreMountManager,
    }),
  );
  agentManagerService.registerEnvAdapter(
    createWorkspaceDomainAdapter({
      host: agentCoreHost,
      mountManager: coreMountManager,
    }),
  );
  const workspaceMdRelativePath = agentCoreHost.workspaceMdRelativePath?.();
  agentManagerService.registerEnvAdapter(
    createAgentsMdDomainAdapter({
      host: agentCoreHost,
      mountManager: coreMountManager,
      workspaceMdRelativePath,
    }),
  );
  agentManagerService.registerEnvAdapter(
    createWorkspaceMdDomainAdapter({
      mountManager: coreMountManager,
      workspaceMdRelativePath,
    }),
  );
  agentManagerService.registerEnvAdapter(
    createEnabledSkillsDomainAdapter({
      host: agentCoreHost,
      getSkillDetails: async (agentInstanceId: string) => {
        const skills: SkillDefinitionUI[] =
          await toolboxService.getSkillsList(agentInstanceId);
        return new Map(
          skills
            .filter((s) => s.agentInvocable !== false && s.skillPath)
            .map((s) => [
              s.skillPath as string,
              {
                name: s.displayName,
                description: s.description,
                path: s.skillPath as string,
              },
            ]),
        );
      },
    }),
  );
  agentManagerService.registerEnvAdapter(createMemoryDomainAdapter());
  agentManagerService.registerEnvAdapter(
    createPlansDomainAdapter({
      host: agentCoreHost,
      store: agentCoreSeam.store,
    }),
  );
  agentManagerService.registerEnvAdapter(
    createLogsDomainAdapter({
      host: agentCoreHost,
      store: agentCoreSeam.store,
    }),
  );
  agentManagerService.registerEnvAdapter(
    createFileDiffsDomainAdapter({ store: agentCoreSeam.store }),
  );

  registerHostEnvDomainAdapters(agentManagerService, {
    karton: uiKarton,
    store: agentCoreSeam.store,
    getShellSnapshot: (agentInstanceId) =>
      toolboxService.getShellSnapshot(agentInstanceId),
    getShellInfo: () => {
      const info = toolboxService.getShellInfo();
      if (!info) return null;
      return { platform: process.platform, type: info.type, path: info.path };
    },
    getSandboxSessionId: (agentInstanceId) =>
      toolboxService.getSandboxSessionId(agentInstanceId),
    getLogIngestSnapshot: () => toolboxService.getLogIngestSnapshot(),
  });

  const agentPowerSaveBlockerService = AgentPowerSaveBlockerService.create(
    logger,
    uiKarton,
  );
  const macOSClosedLidSleepService = MacOSClosedLidSleepService.create(
    logger,
    uiKarton,
  );
  const agentRuntimeRecoveryService = AgentRuntimeRecoveryService.create(
    logger,
    agentManagerService,
    agentHostProcessService ?? undefined,
    cloudTaskRuntime
      ? {
          reconcile: async (reason) =>
            isClodexCloudEnabled()
              ? cloudTaskRuntime.recovery.reconcile(reason)
              : undefined,
        }
      : undefined,
  );
  const browserSwarmStore = new BrowserSwarmStore(uiKarton);
  const appendSwarmMessage = (
    agentInstanceId: string,
    message: AgentMessage,
  ): void => {
    updateAgentInstanceState(agentCoreSeam.store, agentInstanceId, (state) => {
      state.history.push(message);
    });
  };
  const createSwarmTextMessage = (
    role: 'user' | 'assistant',
    text: string,
    metadata?: Partial<AgentMessage['metadata']>,
  ): AgentMessage => ({
    id: crypto.randomUUID(),
    role,
    parts: [{ type: 'text', text }],
    metadata: {
      createdAt: new Date(),
      partsMetadata: [],
      ...metadata,
    },
  });
  type SwarmExecutionResult = Awaited<
    ReturnType<DynamicSwarmOrchestrator['execute']>
  >;
  const summarizeSwarmRun = (result: SwarmExecutionResult): string => {
    if (result.type === 'direct') {
      return [
        'Swarm triage completed.',
        '',
        `Complexity: ${result.triage.taskComplexity}.`,
        result.triage.reason
          ? `Reason: ${result.triage.reason}`
          : 'This task is small enough for the regular chat agent.',
      ].join('\n');
    }

    const completedTasks = result.run.results.length;
    const phases = result.run.plan.workflow.phases.length;
    return [
      'Swarm workflow completed successfully.',
      '',
      `Run: ${result.run.runId}`,
      `Complexity: ${result.triage.taskComplexity}`,
      `Phases: ${phases}`,
      `Tasks completed: ${completedTasks}`,
      '',
      'Check the Swarm panel above for phase and agent details.',
    ].join('\n');
  };
  const extractSwarmPromptFromMessage = async (
    agentInstanceId: string,
    message: AgentMessage,
  ): Promise<string> => {
    const textParts = message.parts
      .filter((part): part is { type: 'text'; text: string } => {
        return part.type === 'text' && typeof (part as any).text === 'string';
      })
      .map((part) => part.text.trim())
      .filter(Boolean);
    const attachmentTexts: string[] = [];
    for (const attachment of message.metadata?.attachments ?? []) {
      const originalFileName = attachment.originalFileName?.toLowerCase() ?? '';
      if (
        !attachment.path.startsWith('att/') ||
        !originalFileName.endsWith('.textclip')
      ) {
        continue;
      }
      try {
        const buffer = await attachments.read(
          agentInstanceId,
          attachment.path.slice('att/'.length),
        );
        attachmentTexts.push(buffer.toString('utf8').trim());
      } catch (error) {
        logger.warn('[SwarmRun] Failed to read textclip attachment', {
          attachmentPath: attachment.path,
          error,
        });
      }
    }

    return [...textParts, ...attachmentTexts].filter(Boolean).join('\n\n');
  };
  const resolveSwarmModel = async ({
    agentInstanceId,
    taskRole,
    traceId,
    metadata,
    preferredModelId,
    unavailableModelIds,
  }: {
    agentInstanceId: string;
    taskRole: ModelTaskRole;
    traceId: string;
    metadata: Record<string, unknown>;
    preferredModelId?: string;
    unavailableModelIds?: string[];
  }) => {
    const state =
      agentCoreSeam.store.get().agents.instances[agentInstanceId]?.state;
    const currentModelId = state?.activeModelId;
    if (!currentModelId) {
      throw new Error('Cannot run swarm: active model is missing.');
    }

    let resolvedModelId = preferredModelId ?? currentModelId;
    const usedPreferredModel = Boolean(preferredModelId);

    try {
      const routedModelId = await agentCoreHost.models.selectModelForTask?.({
        currentModelId,
        taskRole,
        agentType: 'swarm',
        traceId,
        preferredModelId,
        unavailableModelIds,
      });
      if (routedModelId) resolvedModelId = routedModelId;
    } catch (error) {
      logger.warn(
        usedPreferredModel
          ? `[SwarmRun] Preferred model routing failed for ${preferredModelId}; falling back to requested preferred model`
          : `[SwarmRun] Model routing failed for role ${taskRole}; falling back to ${currentModelId}`,
        { error },
      );
    }

    const modelMetadata = {
      $ai_parent_id: agentInstanceId,
      [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'agent-step',
      [MODEL_TASK_ROLE_METADATA_KEY]: taskRole,
      task_role: taskRole,
      requested_model_id: currentModelId,
      preferred_model_id: preferredModelId,
      routed_model_id: resolvedModelId,
      ...metadata,
    };

    let modelWithOptions: Awaited<
      ReturnType<typeof agentCoreHost.models.getWithOptions>
    >;
    try {
      modelWithOptions = await agentCoreHost.models.getWithOptions(
        resolvedModelId,
        traceId,
        modelMetadata,
      );
    } catch (error) {
      logger.warn(`[SwarmRun] Failed to resolve model ${resolvedModelId}`, {
        error,
        taskRole,
        currentModelId,
        preferredModelId,
      });
      throw error;
    }

    return { currentModelId, resolvedModelId, modelWithOptions };
  };
  const truncateSwarmReporterText = (
    text: string,
    maxChars: number,
  ): string => {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
  };
  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizeSwarmVisiblePaths = (
    text: string,
    mounts: ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts'],
  ): string => {
    let normalized = text;
    for (const mount of mounts) {
      if (!mount.prefix) continue;
      const mountPrefixPattern = new RegExp(
        `(^|[^\\w./-])${escapeRegExp(mount.prefix)}/`,
        'g',
      );
      normalized = normalized.replace(mountPrefixPattern, '$1./');
    }
    return normalized;
  };
  const formatSwarmReporterContext = (
    result: Extract<SwarmExecutionResult, { type: 'swarm' }>,
    mounts: ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts'],
  ): string =>
    [
      `<workflow description="${result.run.plan.workflow.description}">`,
      `Run ID: ${result.run.runId}`,
      `Complexity: ${result.triage.taskComplexity}`,
      `Phases: ${result.run.plan.workflow.phases.length}`,
      `Completed tasks: ${result.run.results.length}`,
      '</workflow>',
      '<worker-results>',
      ...result.run.results.map((task) =>
        [
          `<task name="${task.taskName}" role="${task.role}" modelRole="${task.modelTaskRole}">`,
          truncateSwarmReporterText(
            normalizeSwarmVisiblePaths(task.output, mounts),
            2_400,
          ),
          '</task>',
        ].join('\n'),
      ),
      '</worker-results>',
    ].join('\n');
  const generateSwarmReporterSummary = async ({
    agentInstanceId,
    prompt,
    result,
  }: {
    agentInstanceId: string;
    prompt: string;
    result: SwarmExecutionResult;
  }): Promise<string> => {
    if (result.type === 'direct') return summarizeSwarmRun(result);

    const traceId = `${agentInstanceId}:${result.run.runId}:swarm-reporter`;
    const { resolvedModelId, modelWithOptions } = await resolveSwarmModel({
      agentInstanceId,
      taskRole: 'analysis',
      traceId,
      metadata: {
        $ai_span_name: 'swarm-reporter',
        swarm_run_id: result.run.runId,
        swarm_stage: 'reporter',
      },
    });
    logger.debug(`[SwarmRun] Calling reporter with model ${resolvedModelId}`);
    const reporterMounts =
      toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts;

    const reporter = await generateText({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers: modelWithOptions.headers,
      system: [
        'You are the final reporter for a Dynamic Swarm workflow in an IDE.',
        'Tools are disabled. Write a concise Markdown answer for the user.',
        'Use the same language as the original user request.',
        'Synthesize what the swarm actually inspected, decided, changed, proposed, or could not complete.',
        'Mention concrete files or symbols when worker results provide them.',
        'Do not expose internal run IDs unless the user needs them for debugging.',
        'Never show internal workspace mount prefixes or hashes such as "w48b2/". When reporting files, use clean project-relative paths like "./index.html" or "./src/app.ts".',
        'Do not claim that files were changed unless worker results or pending edit results explicitly say so.',
        'End with the most relevant next verification step if there is one.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `<user-request>\n${prompt}\n</user-request>`,
            formatSwarmReporterContext(result, reporterMounts),
          ].join('\n\n'),
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 1_200,
      maxRetries: 1,
    });

    return reporter.text.trim() || summarizeSwarmRun(result);
  };
  const getSwarmWorkerTools = async (
    agentInstanceId: string,
    role: string,
  ): Promise<ToolSet> => {
    const readOnlyTools = [
      'searchProjectSymbols',
      'getFileSkeleton',
      'getSymbolBody',
      'read',
      'grepSearch',
      'glob',
      'ls',
    ];
    const writeTools = role === 'coder' ? ['write', 'multiEdit'] : [];
    const entries = await Promise.all(
      [...readOnlyTools, ...writeTools].map(async (toolName) => {
        const t = await toolboxService.getTool(toolName, agentInstanceId);
        return t ? ([toolName, t] as const) : null;
      }),
    );

    const availableEntries = entries.filter(
      (entry): entry is readonly [string, ToolSet[string]] => entry !== null,
    );
    return Object.fromEntries(availableEntries) as ToolSet;
  };
  const waitForSwarmWorkspaceMounts = async (
    agentInstanceId: string,
    timeoutMs = 5_000,
  ): Promise<
    ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts']
  > => {
    const startedAt = Date.now();
    let mounts = toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts;

    while (mounts.length === 0 && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      mounts = toolboxService.getWorkspaceSnapshot(agentInstanceId).mounts;
    }

    const durationMs = Date.now() - startedAt;
    const mountSummary = mounts.map((mount) => ({
      prefix: mount.prefix,
      path: mount.path,
      permissions: mount.permissions,
    }));

    if (mounts.length === 0) {
      logger.warn('[SwarmRun] Workspace mounts not ready before timeout', {
        agentInstanceId,
        durationMs,
      });
    } else {
      logger.debug('[SwarmRun] Workspace mounts ready', {
        agentInstanceId,
        durationMs,
        mounts: mountSummary,
      });
    }

    return mounts;
  };
  const collectSwarmFallbackWorkspacePaths = async (
    agentInstanceId: string,
  ): Promise<Array<{ path: string; permissions?: MountPermission[] }>> => {
    const candidates: Array<{ path: string; permissions?: MountPermission[] }> =
      [];
    const addCandidate = (
      pathValue: string | null | undefined,
      permissions?: MountPermission[],
    ) => {
      if (!pathValue) return;
      if (candidates.some((candidate) => candidate.path === pathValue)) return;
      candidates.push({ path: pathValue, permissions });
    };

    const storedAgent =
      await persistence.agentDb.getStoredAgentInstanceById(agentInstanceId);
    for (const workspace of storedAgent?.mountedWorkspaces ?? []) {
      addCandidate(workspace.path, workspace.permissions);
    }

    for (const mountPath of toolboxService.getAllMountedPaths()) {
      addCandidate(mountPath);
    }

    const lastWorkspaces =
      (await persistence.agentDb.getLastNonEmptyChatWorkspacePaths()) ??
      (await persistence.agentDb.getLastChatWorkspacePaths());
    for (const workspace of lastWorkspaces ?? []) {
      addCandidate(workspace.path, workspace.permissions);
    }

    const recentWorkspaces = await userExperienceService
      .getRecentlyOpenedWorkspaces()
      .catch((error) => {
        logger.warn('[SwarmRun] Failed to read recent workspaces', { error });
        return [];
      });
    for (const workspace of recentWorkspaces) {
      addCandidate(workspace.path);
    }

    return candidates;
  };
  const ensureSwarmWorkspaceMounts = async (
    agentInstanceId: string,
  ): Promise<
    ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts']
  > => {
    let mounts = await waitForSwarmWorkspaceMounts(agentInstanceId);
    if (mounts.length > 0) return mounts;

    const fallbackPaths =
      await collectSwarmFallbackWorkspacePaths(agentInstanceId);
    for (const candidate of fallbackPaths) {
      try {
        const mountPath = await toolboxService.resolveNewAgentMountPath(
          candidate.path,
        );
        logger.debug('[SwarmRun] Auto-mounting fallback workspace', {
          agentInstanceId,
          path: candidate.path,
          mountPath,
        });
        await toolboxService.handleMountWorkspace(
          agentInstanceId,
          mountPath,
          candidate.permissions,
        );
        mounts = await waitForSwarmWorkspaceMounts(agentInstanceId, 1_500);
        if (mounts.length > 0) return mounts;
      } catch (error) {
        logger.warn('[SwarmRun] Failed to auto-mount fallback workspace', {
          agentInstanceId,
          path: candidate.path,
          error,
        });
      }
    }

    return mounts;
  };
  const formatSwarmWorkspaceMountContext = (
    mounts: ReturnType<typeof toolboxService.getWorkspaceSnapshot>['mounts'],
  ): string => {
    if (mounts.length === 0) {
      return [
        '<workspace-mounts>',
        'No writable/readable workspace mounts are currently available.',
        '</workspace-mounts>',
      ].join('\n');
    }

    return [
      '<workspace-mounts>',
      'Use these mount prefixes exactly when calling project file tools:',
      ...mounts.map((mount) => {
        const permissions =
          mount.permissions && mount.permissions.length > 0
            ? mount.permissions.join(',')
            : 'read,write';
        return `- ${mount.prefix}/ -> ${mount.path} (${permissions})`;
      }),
      'Example: call read/ls/grepSearch with paths under "<prefix>/relative/path".',
      'For tool parameters named mount_prefix, pass only the bare prefix, for example "<prefix>".',
      '</workspace-mounts>',
    ].join('\n');
  };
  const formatSwarmMissingWorkspaceMessage = (prompt: string): string => {
    const isRussian = /[А-Яа-яЁё]/.test(prompt);
    if (isRussian) {
      return [
        'Не запустил Swarm: рабочая папка еще не подключилась к агенту.',
        '',
        'Я подождал workspace mounts перед стартом воркеров, но mount-manager вернул пустой список. Подключи или переподключи папку проекта и запусти задачу еще раз.',
      ].join('\n');
    }

    return [
      'I did not start the Swarm because no workspace folder is mounted for this agent yet.',
      '',
      'I waited for workspace mounts before launching workers, but the mount manager still returned an empty list. Connect or reconnect the project folder and try again.',
    ].join('\n');
  };
  const formatSwarmWorkerOutput = (result: {
    text: string;
    finishReason: string;
    steps: ReadonlyArray<{
      toolCalls: readonly unknown[];
      toolResults: readonly unknown[];
    }>;
  }): string => {
    const toolCalls = result.steps.reduce(
      (count, step) => count + step.toolCalls.length,
      0,
    );
    const text = result.text.trim() || '(No final text returned.)';
    if (toolCalls === 0) return text;
    return [
      text,
      '',
      `[Swarm worker used ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} across ${result.steps.length} step${result.steps.length === 1 ? '' : 's'}; finishReason=${result.finishReason}.]`,
    ].join('\n');
  };
  const getSwarmWorkerStepLimit = (role: string): number => {
    if (role === 'coder') return 16;
    if (role === 'reviewer') return 10;
    return 8;
  };
  const buildSwarmWorkerSystemPrompt = (role: SwarmTaskRole): string => {
    const baseRules = [
      'You are one worker inside a Dynamic Swarm workflow for Clodex IDE.',
      'Complete only your assigned task. Be concise, concrete, and preserve the language of the user request.',
      'No yapping: do not begin with greetings, apologies, or "I can help".',
      'Use searchProjectSymbols before broad directory exploration when locating existing code.',
      'Use read/getFileSkeleton/getSymbolBody/grepSearch to inspect the project before making claims.',
      'Do not claim that files were modified or commands were executed unless a tool result explicitly confirms it.',
      'After you finish using tools, you MUST write a short final textual summary. Do not end your worker turn immediately after a tool call.',
      'Return actionable findings, decisions, implementation notes, and any pending approval status for the next swarm phase.',
    ];

    const roleRules: Record<SwarmTaskRole, string[]> = {
      researcher: [
        'ROLE: Senior codebase researcher.',
        'Your job is to locate concrete files, symbols, APIs, dependencies, and constraints.',
        'You MUST use searchProjectSymbols when looking for existing components, functions, classes, routes, or APIs.',
        'Do not write code. Do not call write or multiEdit. Do not produce implementation patches.',
        'Final output: list exact files/symbols and the relevant logic that later workers should touch.',
      ],
      planner: [
        'ROLE: Senior software architect.',
        'Your job is to convert discovery context into an implementation plan for coder workers.',
        'Do not write code. Do not call write or multiEdit. Do not produce implementation patches.',
        'Final output: concrete files/functions to change, ordered steps, risk notes, and verification commands.',
      ],
      coder: [
        'ROLE: Senior implementation engineer.',
        'Your job is to apply the plan by using write or multiEdit for the smallest safe code changes.',
        'Do not stop at analysis when implementation is possible and the target files are known.',
        'If a planned file does not exist and the task requires it, create it.',
        'Before write/multiEdit, inspect the relevant current code and validate imports/syntax mentally against the surrounding project.',
        'Writes are human-approved pending edits, not direct disk writes.',
        'If a write or multiEdit result says a file is locked, switch to another file or summarize the conflict instead of retrying in a tight loop.',
      ],
      reviewer: [
        'ROLE: Strict code reviewer.',
        'Your job is to inspect proposed changes and find blocking defects before the user receives the result.',
        'Check imports, obvious type errors, missing exports, unsafe any usage, stale paths, and integration gaps.',
        'Do not write code unless the task explicitly asks the reviewer to fix a critical blocker.',
        'If the changes are acceptable, return "PASS" followed by a brief summary.',
        'If there is a critical bug, return "FAIL" followed by the exact file/symbol and the required fix.',
      ],
    };

    return [...baseRules, ...roleRules[role]].join('\n');
  };
  const stringifyErrorPart = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const getSwarmErrorSearchText = (
    error: unknown,
    seen = new WeakSet<object>(),
  ): string => {
    if (error === null || error === undefined) return '';
    if (typeof error !== 'object') return String(error);
    if (seen.has(error)) return '';
    seen.add(error);

    const record = error as Record<string, unknown>;
    const parts = [
      error instanceof Error ? error.name : undefined,
      error instanceof Error ? error.message : undefined,
      record.message,
      record.statusText,
      record.responseBody,
      record.body,
      record.data,
      record.error,
      record.errors,
      record.cause,
    ];

    return parts
      .flatMap((part) => [
        stringifyErrorPart(part),
        getSwarmErrorSearchText(part, seen),
      ])
      .filter(Boolean)
      .join('\n');
  };
  const isUnavailableGatewayChannelError = (error: unknown): boolean =>
    /no available channel/i.test(getSwarmErrorSearchText(error));
  const isRetryableGeminiGatewayError = (
    error: unknown,
    preferredModelId: string | undefined,
  ): boolean => {
    if (!preferredModelId?.startsWith('gemini-')) return false;
    const errorSearchText = getSwarmErrorSearchText(error);
    return (
      /no available channel/i.test(errorSearchText) ||
      /openai[_-]?error/i.test(errorSearchText) ||
      /empty visible response/i.test(errorSearchText)
    );
  };
  const needsSwarmWorkerFinalSummary = (result: {
    text: string;
    finishReason: string;
  }): boolean =>
    result.text.trim().length === 0 || result.finishReason === 'tool-calls';
  const generateSwarmWorkerFinalSummary = async ({
    modelWithOptions,
    headers,
    context,
    prompt,
    responseMessages,
    abortSignal,
  }: {
    modelWithOptions: Awaited<
      ReturnType<typeof resolveSwarmModel>
    >['modelWithOptions'];
    headers: Awaited<
      ReturnType<typeof resolveSwarmModel>
    >['modelWithOptions']['headers'];
    context: Parameters<
      NonNullable<
        ConstructorParameters<typeof DynamicSwarmOrchestrator>[0]['executor']
      >
    >[0];
    prompt: string;
    responseMessages: ModelMessage[];
    abortSignal: AbortSignal;
  }): Promise<{
    text: string;
    usage: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
    finishReason: string;
  }> => {
    const summary = await generateText({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers,
      abortSignal,
      system: [
        'You are finishing one Dynamic Swarm worker turn.',
        'Tools are now disabled. Do not request or mention new tool calls.',
        'Write a concise final worker report in the same language as the user request.',
        'Include: what you inspected, what you changed or proposed, files/symbols touched if known, blockers, and next verification step.',
        'If no file changes were proposed, say that clearly and summarize the useful findings.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `<user-request>\n${prompt}\n</user-request>`,
            `<worker-task name="${context.task.name}" role="${context.task.role}">`,
            context.task.prompt,
            '</worker-task>',
          ].join('\n'),
        },
        ...responseMessages,
        {
          role: 'user',
          content:
            'Now provide the final textual summary for this worker. Do not call tools.',
        },
      ],
      temperature: 0.1,
      maxOutputTokens: 900,
      maxRetries: 1,
    });

    return {
      text: summary.text.trim(),
      usage: summary.usage,
      finishReason: summary.finishReason,
    };
  };
  type SwarmRunMode = 'standard' | 'battle';

  const runSwarmWorkflow = async (
    agentInstanceId: string,
    prompt: string,
    mode: SwarmRunMode = 'standard',
  ): Promise<string> => {
    logger.debug(
      `[SwarmRun] Starting DynamicSwarmOrchestrator for agent ${agentInstanceId} (${mode})`,
    );
    appendSwarmMessage(agentInstanceId, createSwarmTextMessage('user', prompt));
    const workspaceMounts = await ensureSwarmWorkspaceMounts(agentInstanceId);
    if (workspaceMounts.length === 0) {
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage(
          'assistant',
          formatSwarmMissingWorkspaceMessage(prompt),
        ),
      );
      return 'no-workspace';
    }
    const workspaceMountContext =
      formatSwarmWorkspaceMountContext(workspaceMounts);
    const forceBattleMode = mode === 'battle';
    const getSwarmWorkerTimeoutMs = (role: SwarmTaskRole): number => {
      if (role === 'coder') return forceBattleMode ? 240_000 : 180_000;
      return forceBattleMode ? 240_000 : 120_000;
    };

    const orchestrator = new DynamicSwarmOrchestrator({
      triage: async (triagePrompt) => {
        if (forceBattleMode) {
          logger.debug(
            '[SwarmRun] Battle Agent mode forced fan-out/fan-in plan',
          );
          return {
            type: 'swarm',
            ...createBattleSwarmPlan(prompt),
          };
        }

        const traceId = `${agentInstanceId}:swarm-triage:${crypto.randomUUID()}`;
        const { resolvedModelId, modelWithOptions } = await resolveSwarmModel({
          agentInstanceId,
          taskRole: 'analysis',
          traceId,
          metadata: {
            $ai_span_name: 'swarm-triage',
            swarm_stage: 'triage',
          },
        });
        logger.debug(
          `[SwarmRun] Calling LLM triage with model ${resolvedModelId}`,
        );
        const result = await generateText({
          model: modelWithOptions.model,
          providerOptions: modelWithOptions.providerOptions,
          headers: modelWithOptions.headers,
          messages: [
            {
              role: 'user',
              content: triagePrompt,
            },
          ],
          temperature: 0.1,
          maxOutputTokens: 2400,
          maxRetries: 1,
        });
        logger.debug(
          `[SwarmRun] LLM triage completed | finishReason=${result.finishReason} | totalTokens=${result.usage.totalTokens ?? 'unknown'}`,
        );
        return result.text;
      },
      executor: async (context) => {
        const traceId = `${agentInstanceId}:${context.runId}:${context.task.id}`;
        const isBattleSynthesizerTask =
          forceBattleMode &&
          context.phase.id === 'p3' &&
          context.task.id === 'p3-t1' &&
          context.task.preferredModelId === 'gemini-3.5-flash';
        const swarmWorkerTools = await getSwarmWorkerTools(
          agentInstanceId,
          context.task.role,
        );
        let { resolvedModelId, modelWithOptions } = await resolveSwarmModel({
          agentInstanceId,
          taskRole: context.modelTaskRole,
          traceId,
          preferredModelId: context.task.preferredModelId,
          metadata: {
            $ai_span_name: `swarm-${context.task.role}`,
            swarm_run_id: context.runId,
            swarm_phase_id: context.phase.id,
            swarm_task_id: context.task.id,
            swarm_task_name: context.task.name,
            preferred_model_id: context.task.preferredModelId,
          },
        });
        context.emitProgress({
          resolvedModelId,
          log: {
            level: 'info',
            message: `Resolved model ${resolvedModelId}.`,
          },
        });

        const logWorkerCall = () => {
          logger.debug(
            `[SwarmRun] Calling LLM for task ${context.task.name} (${context.modelTaskRole}) with model ${resolvedModelId}${context.task.preferredModelId ? ` preferred=${context.task.preferredModelId}` : ''} and ${Object.keys(swarmWorkerTools).length} tools`,
          );
        };
        logWorkerCall();

        const workerTimeoutMs = getSwarmWorkerTimeoutMs(context.task.role);
        const abortController = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          context.emitProgress({
            log: {
              level: 'error',
              message: `Timed out after ${Math.round(workerTimeoutMs / 1000)}s on ${resolvedModelId}.`,
            },
          });
          abortController.abort();
        }, workerTimeoutMs);

        const systemPrompt = buildSwarmWorkerSystemPrompt(context.task.role);
        const workerMessages: ModelMessage[] = [
          {
            role: 'user',
            content: [
              `<user-request>\n${prompt}\n</user-request>`,
              workspaceMountContext,
              `<workflow-description>\n${context.plan.workflow.description}\n</workflow-description>`,
              `<current-phase title="${context.phase.title}">`,
              `<task name="${context.task.name}" role="${context.task.role}" modelRole="${context.modelTaskRole}">`,
              context.task.prompt,
              '</task>',
              '</current-phase>',
              context.sharedContext
                ? `<previous-swarm-results>\n${context.sharedContext}\n</previous-swarm-results>`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ];

        try {
          const runWorkerAttempt = () =>
            generateText({
              model: modelWithOptions.model,
              providerOptions: modelWithOptions.providerOptions,
              headers: modelWithOptions.headers,
              abortSignal: abortController.signal,
              system: systemPrompt,
              messages: workerMessages,
              temperature: context.task.role === 'coder' ? 0.2 : 0.1,
              maxOutputTokens: 1600,
              maxRetries: 1,
              tools: swarmWorkerTools,
              stopWhen: stepCountIs(getSwarmWorkerStepLimit(context.task.role)),
              experimental_context: {
                lockOwnerId: `${context.runId}:${context.task.id}`,
                swarmRunId: context.runId,
                swarmPhaseId: context.phase.id,
                swarmTaskId: context.task.id,
                swarmTaskName: context.task.name,
              },
              experimental_onToolCallStart: ({ toolCall }) => {
                logger.debug(
                  `[SwarmRun] Tool call started for ${context.task.name}: ${toolCall.toolName}`,
                );
                context.emitProgress({
                  toolsUsed: 1,
                  log: {
                    level: 'info',
                    message: `Tool started: ${toolCall.toolName}.`,
                  },
                });
              },
              experimental_onToolCallFinish: (event) => {
                if (!event.success) {
                  logger.warn(
                    `[SwarmRun] Tool call failed for ${context.task.name}: ${event.toolCall.toolName}`,
                    { durationMs: event.durationMs, error: event.error },
                  );
                  context.emitProgress({
                    log: {
                      level: 'error',
                      message: `Tool failed: ${event.toolCall.toolName} (${Math.round(event.durationMs)}ms).`,
                    },
                  });
                } else {
                  logger.debug(
                    `[SwarmRun] Tool call finished for ${context.task.name}: ${event.toolCall.toolName} (${event.durationMs}ms)`,
                  );
                  context.emitProgress({
                    log: {
                      level: 'info',
                      message: `Tool finished: ${event.toolCall.toolName} (${Math.round(event.durationMs)}ms).`,
                    },
                  });
                }
              },
            });

          const runGeminiNoToolsProbe = async (
            includeProviderOptions: boolean,
          ) => {
            const probeAbortController = new AbortController();
            const probeTimeout = setTimeout(
              () => probeAbortController.abort(),
              45_000,
            );
            try {
              return await generateText({
                model: modelWithOptions.model,
                providerOptions: includeProviderOptions
                  ? modelWithOptions.providerOptions
                  : undefined,
                headers: modelWithOptions.headers,
                abortSignal: probeAbortController.signal,
                system: [
                  systemPrompt,
                  'Diagnostic mode: do not call tools. If previous code-search context is present, use it. Return a concise critique for this worker task.',
                ].join('\n'),
                messages: workerMessages,
                temperature: 0.1,
                maxOutputTokens: 1000,
                maxRetries: 0,
              });
            } finally {
              clearTimeout(probeTimeout);
            }
          };

          let result: Awaited<ReturnType<typeof runWorkerAttempt>> | undefined;
          try {
            result = await runWorkerAttempt();
          } catch (error) {
            if (timedOut || abortController.signal.aborted) {
              throw new Error(
                `${context.task.name} timed out after ${Math.round(workerTimeoutMs / 1000)}s while using ${resolvedModelId}.`,
                { cause: error },
              );
            }
            const errorSearchText = getSwarmErrorSearchText(error);
            const unavailableChannel = isUnavailableGatewayChannelError(error);
            const retryableGatewayError = isRetryableGeminiGatewayError(
              error,
              context.task.preferredModelId,
            );
            const allowBattleSynthesizerFallback =
              isBattleSynthesizerTask &&
              context.task.preferredModelId === 'gemini-3.5-flash';
            logger.warn(
              `[SwarmRun] Worker model call failed for ${context.task.name} on ${resolvedModelId}`,
              {
                preferredModelId: context.task.preferredModelId,
                unavailableChannel,
                retryableGatewayError,
                errorSearchText: errorSearchText.slice(0, 4_000),
              },
            );
            logger.warn(
              `[SwarmRun] Worker model error detail for ${context.task.name}: ${errorSearchText.slice(0, 1_500)}`,
            );
            if (
              !context.task.preferredModelId ||
              (!retryableGatewayError && !allowBattleSynthesizerFallback)
            ) {
              throw error;
            }

            const failedModelId = resolvedModelId;
            if (failedModelId.startsWith('gemini-')) {
              context.emitProgress({
                log: {
                  level: 'warn',
                  message:
                    'Gemini tools request failed; probing no-tools request with the same runtime token.',
                },
              });
              try {
                result = await runGeminiNoToolsProbe(true);
                context.emitProgress({
                  log: {
                    level: 'info',
                    message:
                      'Gemini no-tools probe passed with provider options; tool-calling payload is the failing path.',
                  },
                });
              } catch (probeError) {
                const probeDetail = getSwarmErrorSearchText(probeError);
                logger.warn(
                  `[SwarmRun] Gemini no-tools probe with provider options failed for ${context.task.name}: ${probeDetail.slice(0, 1_500)}`,
                );
                context.emitProgress({
                  log: {
                    level: 'warn',
                    message:
                      'Gemini no-tools probe with provider options failed; retrying minimal payload.',
                  },
                });
                try {
                  result = await runGeminiNoToolsProbe(false);
                  context.emitProgress({
                    log: {
                      level: 'warn',
                      message:
                        'Gemini minimal no-tools probe passed; provider options are incompatible on this route.',
                    },
                  });
                } catch (minimalProbeError) {
                  const minimalProbeDetail =
                    getSwarmErrorSearchText(minimalProbeError);
                  logger.warn(
                    `[SwarmRun] Gemini minimal no-tools probe failed for ${context.task.name}: ${minimalProbeDetail.slice(0, 1_500)}`,
                  );
                  context.emitProgress({
                    log: {
                      level: 'error',
                      message:
                        'Gemini minimal no-tools probe failed; this is a gateway/channel connection issue.',
                    },
                  });
                }
              }
            }

            if (!result && allowBattleSynthesizerFallback) {
              let fallbackError: unknown = error;
              for (const fallbackPreferredModelId of [
                'gpt-5.5',
                'claude-opus-4.8',
              ]) {
                context.emitProgress({
                  log: {
                    level: 'warn',
                    message: `[Synthesizer] Gemini 3.5 unavailable. Falling back to ${fallbackPreferredModelId}.`,
                  },
                });
                try {
                  const fallback = await resolveSwarmModel({
                    agentInstanceId,
                    taskRole: context.modelTaskRole,
                    traceId,
                    preferredModelId: fallbackPreferredModelId,
                    unavailableModelIds: [failedModelId],
                    metadata: {
                      $ai_span_name: `swarm-${context.task.role}`,
                      swarm_run_id: context.runId,
                      swarm_phase_id: context.phase.id,
                      swarm_task_id: context.task.id,
                      swarm_task_name: context.task.name,
                      preferred_model_id: fallbackPreferredModelId,
                      fallback_from_model_id: failedModelId,
                    },
                  });
                  if (fallback.resolvedModelId === failedModelId) continue;
                  resolvedModelId = fallback.resolvedModelId;
                  modelWithOptions = fallback.modelWithOptions;
                  context.emitProgress({
                    resolvedModelId,
                    log: {
                      level: 'warn',
                      message: `[Synthesizer] Running fallback on ${resolvedModelId}.`,
                    },
                  });
                  logWorkerCall();
                  result = await runWorkerAttempt();
                  break;
                } catch (candidateError) {
                  fallbackError = candidateError;
                  logger.warn(
                    `[SwarmRun] Battle synthesizer fallback ${fallbackPreferredModelId} failed for ${context.task.name}`,
                    {
                      errorSearchText: getSwarmErrorSearchText(
                        candidateError,
                      ).slice(0, 1_500),
                    },
                  );
                  context.emitProgress({
                    log: {
                      level: 'error',
                      message: `[Synthesizer] Fallback ${fallbackPreferredModelId} failed.`,
                    },
                  });
                }
              }

              if (!result) {
                throw fallbackError instanceof Error
                  ? fallbackError
                  : new Error(String(fallbackError));
              }
            }

            if (!result) {
              const fallback = await resolveSwarmModel({
                agentInstanceId,
                taskRole: context.modelTaskRole,
                traceId,
                preferredModelId: context.task.preferredModelId,
                unavailableModelIds: [failedModelId],
                metadata: {
                  $ai_span_name: `swarm-${context.task.role}`,
                  swarm_run_id: context.runId,
                  swarm_phase_id: context.phase.id,
                  swarm_task_id: context.task.id,
                  swarm_task_name: context.task.name,
                  preferred_model_id: context.task.preferredModelId,
                  unavailable_model_id: failedModelId,
                },
              });

              if (fallback.resolvedModelId === failedModelId) {
                logger.warn(
                  `[SwarmRun] No same-provider fallback available for ${context.task.name} after ${failedModelId} failed`,
                  {
                    preferredModelId: context.task.preferredModelId,
                    failedModelId,
                  },
                );
                context.emitProgress({
                  log: {
                    level: 'error',
                    message: `Model ${failedModelId} failed and no same-provider fallback is available.`,
                  },
                });
                throw error;
              }

              logger.warn(
                `[SwarmRun] Retrying task ${context.task.name} after gateway failure for ${failedModelId}; fallback=${fallback.resolvedModelId}`,
                { error },
              );
              resolvedModelId = fallback.resolvedModelId;
              modelWithOptions = fallback.modelWithOptions;
              context.emitProgress({
                resolvedModelId,
                log: {
                  level: 'warn',
                  message: `Model fallback: ${failedModelId} -> ${resolvedModelId}.`,
                },
              });
              logWorkerCall();
              result = await runWorkerAttempt();
            }
          }

          if (!result) {
            throw new Error(
              `Swarm worker ${context.task.name} did not return a result.`,
            );
          }

          let tokenCount =
            result.totalUsage.totalTokens ??
            result.usage.totalTokens ??
            (result.totalUsage.inputTokens ?? result.usage.inputTokens ?? 0) +
              (result.totalUsage.outputTokens ??
                result.usage.outputTokens ??
                0);

          let finalText = result.text.trim();
          let finalFinishReason: string = result.finishReason;
          if (needsSwarmWorkerFinalSummary(result)) {
            logger.debug(
              `[SwarmRun] Requesting no-tools final summary for ${context.task.name} after finishReason=${result.finishReason}`,
            );
            const summary = await generateSwarmWorkerFinalSummary({
              modelWithOptions,
              headers: modelWithOptions.headers,
              context,
              prompt,
              responseMessages: result.response.messages,
              abortSignal: abortController.signal,
            });
            finalText = summary.text;
            finalFinishReason = `${result.finishReason}+summary:${summary.finishReason}`;
            tokenCount +=
              summary.usage.totalTokens ??
              (summary.usage.inputTokens ?? 0) +
                (summary.usage.outputTokens ?? 0);
          }

          context.emitProgress({ newTokens: tokenCount });
          logger.debug(
            `[SwarmRun] LLM task completed: ${context.task.name} | finishReason=${finalFinishReason} | totalTokens=${tokenCount} | toolCalls=${result.steps.reduce((count, step) => count + step.toolCalls.length, 0)}`,
          );
          return {
            output: formatSwarmWorkerOutput({
              text: finalText,
              finishReason: finalFinishReason,
              steps: result.steps,
            }),
            modelTaskRole: context.modelTaskRole,
            resolvedModelId,
            metrics: { newTokens: tokenCount },
          };
        } finally {
          clearTimeout(timeout);
          (
            pendingEditService as PendingEditService & {
              releaseLocksForOwner?: (ownerId: string) => void;
            }
          ).releaseLocksForOwner?.(`${context.runId}:${context.task.id}`);
        }
      },
      onTriageError: (error) => {
        logger.debug(`[SwarmRun] Falling back to heuristic triage`, { error });
      },
    });

    orchestrator.on((event) => {
      logger.debug(`[SwarmRun] Event: ${event.type}`);
      browserSwarmStore.applyEvent(agentInstanceId, event);
    });

    try {
      const result = await orchestrator.execute(prompt);
      if (result.type === 'swarm') {
        browserSwarmStore.completeRunFromResult(agentInstanceId, result.run);
      }
      const summary = await generateSwarmReporterSummary({
        agentInstanceId,
        prompt,
        result,
      }).catch((error) => {
        logger.warn('[SwarmRun] Reporter failed; falling back to summary', {
          error,
        });
        return summarizeSwarmRun(result);
      });
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage('assistant', summary, {
          swarmResultRunId:
            result.type === 'swarm' ? result.run.runId : undefined,
          swarmDiffArtifact: result.type === 'swarm',
        }),
      );
      logger.debug(`[SwarmRun] Completed workflow`);
      return result.type === 'swarm' ? result.run.runId : 'direct';
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Swarm workflow failed unexpectedly.';
      appendSwarmMessage(
        agentInstanceId,
        createSwarmTextMessage(
          'assistant',
          `Swarm workflow failed.\n\n${message}`,
        ),
      );
      throw error;
    }
  };
  agentManagerService.setSwarmSubmitHandler(
    async (agentInstanceId, message) => {
      const prompt = await extractSwarmPromptFromMessage(
        agentInstanceId,
        message,
      );
      const metadata = message.metadata as AgentMessage['metadata'] & {
        swarmMode?: boolean;
        swarmModeVariant?: 'standard' | 'battle';
      };
      const shouldRunSwarm = metadata?.swarmMode === true;

      logger.debug('[SwarmRun] sendUserMessage guard', {
        agentInstanceId,
        swarmMode: metadata?.swarmMode,
        swarmModeVariant: metadata?.swarmModeVariant,
        promptLength: prompt.length,
        shouldRunSwarm,
      });

      if (!shouldRunSwarm) return false;

      const swarmPrompt = prompt || 'Run Dynamic Swarm.';
      const swarmModeVariant =
        metadata?.swarmModeVariant === 'battle' ? 'battle' : 'standard';
      void runSwarmWorkflow(
        agentInstanceId,
        swarmPrompt,
        swarmModeVariant,
      ).catch((error) => {
        logger.error('[SwarmRun] Background workflow failed', {
          agentInstanceId,
          error,
        });
      });
      return true;
    },
  );
  const runForcedSwarmPreview = async (
    agentInstanceId: string,
    prompt: string,
  ): Promise<string> => {
    logger.debug(
      `[SwarmPreview] Starting forced high-complexity preview for agent ${agentInstanceId}`,
    );
    const plan = createFallbackSwarmPlan(prompt, 'high');
    const runner = new SwarmRunner({
      executor: async (context) => {
        logger.debug(
          `[SwarmPreview] Task started: ${context.task.name} (${context.modelTaskRole})`,
        );
        context.emitProgress({ newTokens: 120, toolsUsed: 1 });
        await new Promise((resolve) => setTimeout(resolve, 650));
        return `${context.task.name} completed preview for: ${context.task.prompt}`;
      },
    });
    runner.on((event) => {
      logger.debug(`[SwarmPreview] Event: ${event.type}`);
      browserSwarmStore.applyEvent(agentInstanceId, event);
    });
    const result = await runner.run(plan);
    logger.debug(`[SwarmPreview] Completed run ${result.runId}`);
    return result.runId;
  };

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

  // Wire all uiKarton-to-pages state syncs (pending edits, mounts,
  // workspace-md generating, search engines, global config, auth)
  await wirePagesStateSync({
    uiKarton,
    pagesService,
    globalConfigService,
    logger,
  });

  // Wire all pages-api handler setters (pending edits accept/reject,
  // context files, certificate trust, auth, home page, etc.)
  wirePagesHandlers({
    uiKarton,
    pagesService,
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

  // Wire permission-exceptions clear handler (used by clearBrowsingData)
  pagesService.setClearPermissionExceptionsHandler(() =>
    preferencesService.clearAllPermissionExceptionsForAllTypes(),
  );

  uiKarton.registerServerProcedureHandler(
    'fileTree.listDirectory',
    async (_cid, input) => fileTreeService.listDirectory(input),
  );
  uiKarton.registerServerProcedureHandler(
    'swarm.run',
    async (_cid, agentInstanceId: string, prompt: string) => {
      const swarmPrompt = prompt || 'Run Dynamic Swarm.';
      void runSwarmWorkflow(agentInstanceId, swarmPrompt).catch((error) => {
        logger.error('[SwarmRun] Background workflow failed', {
          agentInstanceId,
          error,
        });
      });
      return 'started';
    },
  );
  uiKarton.registerServerProcedureHandler(
    'swarm.preview',
    async (_cid, agentInstanceId: string, prompt: string) => {
      return await runForcedSwarmPreview(agentInstanceId, prompt);
    },
  );
  uiKarton.registerServerProcedureHandler(
    'swarm.clearRun',
    async (_cid, runId: string) => browserSwarmStore.clearRun(runId),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.getFilePreview',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.getFilePreview(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.getFileStat',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.getFileStat(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.saveFile',
    async (
      _cid,
      workspaceKey: string,
      relativePath: string,
      text: string,
      expectedMtimeMs?: number | null,
    ) =>
      fileTreeService.saveFile(
        workspaceKey,
        relativePath,
        text,
        expectedMtimeMs,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.openFileTab',
    async (
      _cid,
      workspaceKey: string,
      relativePath: string,
      agentInstanceId?: string | null,
      options?: { preview?: boolean; temporaryGroupKey?: string },
    ) =>
      fileTreeService.openFileTab(
        workspaceKey,
        relativePath,
        agentInstanceId,
        options,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.openAttachmentTab',
    async (
      _cid,
      agentId: string,
      attachmentId: string,
      displayName?: string,
      agentInstanceId?: string | null,
      options?: { preview?: boolean; temporaryGroupKey?: string },
    ) =>
      fileTreeService.openAttachmentTab(
        agentId,
        attachmentId,
        displayName,
        agentInstanceId,
        options,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.promoteFileTab',
    async (_cid, tabId: string) => windowLayoutService.promoteFileTab(tabId),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.renameEntry',
    async (_cid, workspaceKey: string, relativePath: string, newName: string) =>
      fileTreeService.renameEntry(workspaceKey, relativePath, newName),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.pasteEntry',
    async (
      _cid,
      sourceWorkspaceKey: string,
      sourceRelativePath: string,
      targetWorkspaceKey: string,
      targetDirectoryPath: string,
      operation: 'copy' | 'cut',
      preferredName?: string,
    ) =>
      fileTreeService.pasteEntry(
        sourceWorkspaceKey,
        sourceRelativePath,
        targetWorkspaceKey,
        targetDirectoryPath,
        operation,
        preferredName,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.deleteEntry',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.deleteEntry(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.createFile',
    async (_cid, workspaceKey: string, directoryPath: string) =>
      fileTreeService.createFile(workspaceKey, directoryPath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.recreateDeletedFile',
    async (_cid, workspaceKey: string, relativePath: string, content: string) =>
      fileTreeService.recreateDeletedFile(workspaceKey, relativePath, content),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.revealInFolder',
    async (_cid, workspaceKey: string, relativePath: string) =>
      fileTreeService.revealInFolder(workspaceKey, relativePath),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setVisible',
    async (_cid, visible: boolean) => fileTreeService.setVisible(visible),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setActiveWorkspace',
    async (_cid, workspaceKey: string | null) =>
      fileTreeService.setActiveWorkspace(workspaceKey),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setViewMode',
    async (_cid, mode: 'files' | 'diff') => fileTreeService.setViewMode(mode),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.setDirectoryExpanded',
    async (
      _cid,
      workspaceKey: string,
      directoryPath: string,
      expanded: boolean,
    ) =>
      fileTreeService.setDirectoryExpanded(
        workspaceKey,
        directoryPath,
        expanded,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.searchFiles',
    async (
      _cid,
      query: string,
      workspaceKeys: string[],
      includeGitignored: boolean,
      searchInContent?: boolean,
    ) =>
      fileTreeService.searchFiles(
        query,
        workspaceKeys,
        includeGitignored,
        searchInContent,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'fileTree.listRecentFiles',
    async (
      _cid,
      workspaceKeys: string[],
      includeGitignored: boolean,
      limit: number,
    ) =>
      fileTreeService.listRecentFiles(workspaceKeys, includeGitignored, limit),
  );

  // --- Wire main UI settings RPC procedures ---

  uiKarton.registerServerProcedureHandler(
    'config.previewSoundPack',
    async (
      _cid: string,
      packId: string,
      loudness: 'off' | 'subtle' | 'default',
    ) => ({
      ok: await notificationSoundsService.previewPackDoneSound(
        packId,
        loudness,
      ),
    }),
  );

  uiKarton.registerServerProcedureHandler(
    'config.importSoundPack',
    async () => {
      const result = await dialog.showOpenDialog({
        title: 'Use Custom Sound',
        filters: [
          { name: 'Sound files', extensions: ['mp3', 'json'] },
          { name: 'MP3 audio', extensions: ['mp3'] },
          { name: 'Sound pack JSON', extensions: ['json'] },
        ],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { error: '' };
      }

      const imported = await notificationSoundsService.importPack(
        result.filePaths[0],
      );
      if ('error' in imported) return imported;

      try {
        await syncAvailableSoundPacks(imported.id);
      } catch (err) {
        logger.error('[Main] Failed to save imported sound pack', err);
        return {
          error: 'Sound pack imported, but saving the selection failed.',
        };
      }

      return imported;
    },
  );

  uiKarton.registerServerProcedureHandler('closedLidSleep.toggle', async () => {
    return macOSClosedLidSleepService.toggle();
  });
  uiKarton.registerServerProcedureHandler(
    'closedLidSleep.refresh',
    async () => {
      return macOSClosedLidSleepService.refresh();
    },
  );

  // browser.addSearchEngine / removeSearchEngine
  uiKarton.registerServerProcedureHandler(
    'browser.addSearchEngine',
    async (
      _cid: string,
      input: { name: string; url: string; keyword: string },
    ) => {
      const id = await webDataService.addSearchEngine(input);
      await webDataService.getSearchEngines().then((engines) => {
        uiKarton.setState((draft) => {
          draft.searchEngines = engines;
        });
      });
      return { id, success: true };
    },
  );
  uiKarton.registerServerProcedureHandler(
    'browser.removeSearchEngine',
    async (_cid: string, id: number) => {
      const removed = await webDataService.removeSearchEngine(id);
      await webDataService.getSearchEngines().then((engines) => {
        uiKarton.setState((draft) => {
          draft.searchEngines = engines;
        });
      });
      return { success: removed };
    },
  );

  // browser.copyText - write text to the system clipboard from the main
  // process. The UI renderer's navigator.clipboard rejects when focus is
  // inside a web-content view, so clipboard writes are routed through here.
  uiKarton.registerServerProcedureHandler(
    'browser.copyText',
    async (_cid: string, text: string) => {
      clipboard.writeText(text);
    },
  );

  // browser.clearBrowsingData
  uiKarton.registerServerProcedureHandler(
    'browser.clearBrowsingData',
    async (
      _cid: string,
      options: Parameters<typeof pagesService.clearBrowsingData>[0],
    ) => {
      return pagesService.clearBrowsingData(options);
    },
  );

  // browser.getHistory / browser.getFaviconBitmaps (history settings section)
  uiKarton.registerServerProcedureHandler(
    'browser.getHistory',
    async (_cid: string, filter: HistoryFilter): Promise<HistoryResult[]> => {
      const results = await historyService.queryHistory(filter);
      const pageUrls = results.map((r) => r.url);
      const faviconMap = await faviconService.getFaviconsForUrls(pageUrls);
      return results.map((r) => ({
        ...r,
        faviconUrl: faviconMap.get(r.url) ?? null,
      }));
    },
  );
  uiKarton.registerServerProcedureHandler(
    'browser.getFaviconBitmaps',
    async (
      _cid: string,
      faviconUrls: string[],
    ): Promise<Record<string, FaviconBitmapResult>> => {
      const bitmapMap = await faviconService.getFaviconBitmaps(faviconUrls);
      const result: Record<string, FaviconBitmapResult> = {};
      for (const [url, bitmap] of bitmapMap) {
        result[url] = bitmap;
      }
      return result;
    },
  );

  // toolbox.getContextFiles / toolbox.generateWorkspaceMdForPath
  uiKarton.registerServerProcedureHandler(
    'toolbox.getContextFiles',
    async (_cid: string) => {
      return toolboxService.getContextFilesForAllWorkspaces();
    },
  );
  uiKarton.registerServerProcedureHandler(
    'toolbox.generateWorkspaceMdForPath',
    async (_cid: string, workspacePath: string) => {
      await agentManagerService.generateWorkspaceMdForPath(workspacePath);
    },
  );

  // toolbox worktree setup settings procedures
  uiKarton.registerServerProcedureHandler(
    'toolbox.listWorktreeSetupRepositories',
    async () => worktreeSetupSettingsService.listRepositories(),
  );
  uiKarton.registerServerProcedureHandler(
    'toolbox.saveWorktreeSetupScript',
    async (
      _cid: string,
      mainWorktreePath: string,
      variant: WorktreeSetupScriptVariant,
      content: string,
    ) =>
      worktreeSetupSettingsService.saveScript(
        mainWorktreePath,
        variant,
        content,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'toolbox.deleteWorktreeSetupWorktree',
    async (_cid: string, worktreePath: string) =>
      worktreeSetupSettingsService.deleteManagedWorktree(worktreePath),
  );

  // credentials.set / credentials.delete / credentials.getConfiguredIds
  uiKarton.registerServerProcedureHandler(
    'credentials.set',
    async (_cid: string, typeId: string, data: Record<string, string>) => {
      await credentialsService.set(
        typeId as CredentialTypeId,
        data as Parameters<typeof credentialsService.set>[1],
      );
    },
  );
  uiKarton.registerServerProcedureHandler(
    'credentials.delete',
    async (_cid: string, typeId: string) => {
      await credentialsService.delete(typeId as CredentialTypeId);
    },
  );
  uiKarton.registerServerProcedureHandler(
    'credentials.getConfiguredIds',
    async (_cid: string) => {
      return credentialsService.listConfigured();
    },
  );

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
