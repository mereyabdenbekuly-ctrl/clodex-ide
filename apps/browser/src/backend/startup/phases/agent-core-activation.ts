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
import type { SkillDefinitionUI } from '@shared/skills';
import type { ModelProviderService } from '../../agents/model-provider';
import type { CloudTaskRuntimeResult } from './cloud-task-runtime';
import {
  createBrowserHostEnvironmentSources,
  registerHostEnvDomainAdapters,
} from '../../env-domains';
import { AgentPowerSaveBlockerService } from '../../services/agent-power-save-blocker';
import { registerToolboxGenerateWorkspaceMd } from '../../services/agent-core-bridge/handlers/toolbox';
import { attachAgentCoreBridge } from '../../services/agent-core-bridge/wiring';
import type { AgentManagerService } from '../../services/agent-manager';
import { AgentRuntimeRecoveryService } from '../../services/agent-runtime-recovery';
import type { KartonService } from '../../services/karton';
import type { Logger } from '../../services/logger';
import { MacOSClosedLidSleepService } from '../../services/macos-closed-lid-sleep';
import type { ToolboxService } from '../../services/toolbox';
import type { AgentCoreFoundationPhaseResult } from './agent-core-foundation';

type AgentCoreActivationFoundation = Pick<
  AgentCoreFoundationPhaseResult,
  | 'agentCoreSeam'
  | 'agentHostProcessService'
  | 'lazyHostModels'
  | 'agentCoreHost'
  | 'persistence'
  | 'diffHistoryService'
  | 'pendingEditService'
>;

export interface AgentCoreActivationPhaseOptions {
  logger: Logger;
  karton: KartonService;
  toolboxService: ToolboxService;
  agentManagerService: AgentManagerService;
  modelProviderService: ModelProviderService;
  foundation: AgentCoreActivationFoundation;
  cloudTaskRuntime: CloudTaskRuntimeResult;
  isClodexCloudEnabled: () => boolean;
}

export interface AgentCoreActivationPhaseResult {
  agentCoreBridge: ReturnType<typeof attachAgentCoreBridge>;
  agentPowerSaveBlockerService: AgentPowerSaveBlockerService;
  macOSClosedLidSleepService: MacOSClosedLidSleepService;
  agentRuntimeRecoveryService: AgentRuntimeRecoveryService;
}

export function runAgentCoreActivationPhase(
  options: AgentCoreActivationPhaseOptions,
): AgentCoreActivationPhaseResult {
  const {
    logger,
    karton,
    toolboxService,
    agentManagerService,
    modelProviderService,
    foundation,
    cloudTaskRuntime,
    isClodexCloudEnabled,
  } = options;
  const {
    agentCoreSeam,
    agentHostProcessService,
    lazyHostModels,
    agentCoreHost,
    persistence,
    diffHistoryService,
    pendingEditService,
  } = foundation;

  toolboxService.setWorkspaceLastUsedAtResolver(
    async (workspacePaths) =>
      (await persistence.agentDb.getWorkspaceLastUsedAtByPath(
        workspacePaths,
      )) ?? new Map(),
  );

  registerToolboxGenerateWorkspaceMd(agentCoreSeam.registry, karton, {
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
    karton,
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
            .filter(
              (skill) => skill.agentInvocable !== false && skill.skillPath,
            )
            .map((skill) => [
              skill.skillPath as string,
              {
                name: skill.displayName,
                description: skill.description,
                path: skill.skillPath as string,
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
    karton,
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
    karton,
  );
  const macOSClosedLidSleepService = MacOSClosedLidSleepService.create(
    logger,
    karton,
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

  return {
    agentCoreBridge,
    agentPowerSaveBlockerService,
    macOSClosedLidSleepService,
    agentRuntimeRecoveryService,
  };
}
