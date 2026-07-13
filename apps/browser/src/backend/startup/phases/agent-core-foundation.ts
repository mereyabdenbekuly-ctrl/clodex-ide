import { type AgentHost, PendingEditService } from '@clodex/agent-core';
import type { AttachmentsService } from '@clodex/agent-core/attachments';
import type {
  DataProtection,
  ProtectedFileStorage,
} from '@clodex/agent-core/host';
import { AgentCorePersistence } from '@clodex/agent-core/persistence';
import {
  EvidenceMemoryCanaryController,
  getEvidenceMemoryRolloutPolicy,
  isEvidenceMemoryInjectionDisabled,
} from '@shared/evidence-memory-rollout';
import {
  resolveFeatureGate,
  type AppReleaseChannel,
} from '@shared/feature-gates';
import type { IsolatedAgentRuntimeRolloutPolicy } from '@shared/isolated-agent-runtime-policy';
import type { UserPreferences } from '@shared/karton-contracts/ui/shared-types';
import { AgentHostProcessService } from '../../agent-host';
import {
  applyBrowserAgentBehavior,
  createBrowserAgentHost,
} from '../../services/agent-core-bridge/host';
import {
  createLazyBrowserHostModels,
  type LazyBrowserHostModels,
} from '../../services/agent-core-bridge/host-models';
import { createAgentCoreSeam } from '../../services/agent-core-bridge/wiring';
import { EvidenceMemoryDogfoodBackfill } from '../../services/evidence-memory-dogfood-backfill';
import { EvidenceMemoryInspectorService } from '../../services/evidence-memory-inspector';
import type { KartonService } from '../../services/karton';
import type { Logger } from '../../services/logger';
import { MemoryNotesSettingsService } from '../../services/memory-notes-settings';
import { NetworkEgressControlCenterService } from '../../services/network-policy/control-center';
import type { GuardianEgressStartupResult } from '../../services/network-policy/startup';
import type { PagesService } from '../../services/pages';
import type { PreferencesService } from '../../services/preferences';
import type { P1ProtectedMigrationOrder } from '../../services/protected-files/order';
import type { TelemetryService } from '../../services/telemetry';
import { discoverPlugins } from '../../utils/discover-plugins';
import {
  getInstalledPluginsDir,
  getNetworkPolicyAuditPath,
  getPluginsPath,
} from '../../utils/paths';
import type { StartupFeatureGateResolver } from './foundational-services';

export type AgentBehaviorPreferenceListener = Parameters<
  PreferencesService['addListener']
>[0];

export interface AgentCoreFoundationPhaseOptions {
  logger: Logger;
  telemetryService: TelemetryService;
  preferencesService: PreferencesService;
  pagesService: PagesService;
  karton: KartonService;
  hostPaths: AgentHost['paths'];
  dataProtection: DataProtection;
  protectedFiles: ProtectedFileStorage;
  protectedMigrationOrder: P1ProtectedMigrationOrder;
  attachments: AttachmentsService;
  guardianEgressStartup: GuardianEgressStartupResult;
  startupFeatureEnabled: StartupFeatureGateResolver;
  isolatedAgentRuntimePolicy: IsolatedAgentRuntimeRolloutPolicy;
  isolatedAgentRuntimeKillSwitchActive: boolean;
  releaseChannel: AppReleaseChannel;
  verbose?: boolean;
}

export interface AgentCoreFoundationPhaseResult {
  agentCoreSeam: ReturnType<typeof createAgentCoreSeam>;
  agentHostProcessService: AgentHostProcessService | null;
  lazyHostModels: LazyBrowserHostModels;
  agentCoreHost: AgentHost;
  agentBehaviorPreferenceListener: AgentBehaviorPreferenceListener;
  refreshPluginDefinitions: () => Promise<void>;
  persistence: AgentCorePersistence;
  diffHistoryService: AgentCorePersistence['diffHistory'];
  pendingEditService: PendingEditService;
  networkEgressControlService: NetworkEgressControlCenterService | null;
  memoryNotesSettingsService: MemoryNotesSettingsService;
  evidenceMemoryInspectorService: EvidenceMemoryInspectorService;
}

export async function runAgentCoreFoundationPhase(
  options: AgentCoreFoundationPhaseOptions,
): Promise<AgentCoreFoundationPhaseResult> {
  const {
    logger,
    telemetryService,
    preferencesService,
    pagesService,
    karton,
    hostPaths,
    dataProtection,
    protectedFiles,
    protectedMigrationOrder,
    attachments,
    guardianEgressStartup,
    startupFeatureEnabled,
    isolatedAgentRuntimePolicy,
    isolatedAgentRuntimeKillSwitchActive,
    releaseChannel,
    verbose,
  } = options;

  // Phase 3a: build the agent-core seam (store + controllers + registry)
  // early so services that consume store-canonical state — currently
  // `DiffHistoryService` via the store itself — can receive their
  // dependency as an injected capability. The bridge itself is attached
  // later, once `agentCoreHost` exists (post-ModelProviderService).
  const agentCoreSeam = createAgentCoreSeam({ karton });
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
    releaseChannel,
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
      releaseChannel,
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
  const agentBehaviorPreferenceListener: AgentBehaviorPreferenceListener = (
    newPreferences,
    oldPreferences,
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
    karton.setState((draft: { plugins: typeof plugins }) => {
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
    getEvidenceMemoryRolloutPolicy(releaseChannel),
    isEvidenceMemoryInjectionDisabled(
      process.env.CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION,
    ),
  );
  const evidenceMemoryPromptGateEnabled = resolveFeatureGate(
    'evidence-memory-prompt-injection',
    preferencesService.get().featureGates.overrides,
    releaseChannel,
  ).enabled;
  const persistence = await AgentCorePersistence.create({
    host: agentCoreHost,
    store: agentCoreSeam.store,
    attachments,
    enableEvidenceMemory:
      resolveFeatureGate(
        'evidence-memory-shadow',
        preferencesService.get().featureGates.overrides,
        releaseChannel,
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
      releaseChannel,
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
  preferencesService.connectKarton(karton, pagesService);
  let networkEgressControlService: NetworkEgressControlCenterService | null =
    null;
  const guardianEgressControlCenter = guardianEgressStartup.controlCenter;
  if (guardianEgressControlCenter.enabled) {
    try {
      networkEgressControlService =
        await NetworkEgressControlCenterService.create({
          logger,
          karton,
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
    karton,
    preferences: preferencesService,
    memoryNotes: persistence.memoryNotes,
    isFeatureEnabled: (feature) =>
      resolveFeatureGate(
        feature,
        preferencesService.get().featureGates.overrides,
        releaseChannel,
      ).enabled,
  });
  const evidenceMemoryInspectorService =
    await EvidenceMemoryInspectorService.create({
      logger,
      karton,
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
          releaseChannel,
        ).enabled,
    });

  return {
    agentCoreSeam,
    agentHostProcessService,
    lazyHostModels,
    agentCoreHost,
    agentBehaviorPreferenceListener,
    refreshPluginDefinitions,
    persistence,
    diffHistoryService,
    pendingEditService,
    networkEgressControlService,
    memoryNotesSettingsService,
    evidenceMemoryInspectorService,
  };
}
