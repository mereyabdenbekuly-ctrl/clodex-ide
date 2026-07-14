import type { AgentHost } from '@clodex/agent-core/host';
import type { AgentCorePersistence } from '@clodex/agent-core/persistence';
import type { PendingEditService } from '@clodex/agent-core';
import type { DiffHistoryService } from '@clodex/agent-core/diff-history';
import {
  resolveFeatureGate,
  type AppReleaseChannel,
} from '@shared/feature-gates';
import { isClodexCloudSelected } from '@shared/provider-consent';
import type { SkillDefinition } from '@shared/skills';
import { createBrowserIsolatedAgentTurnHandlers } from '../../agent-host/browser-turn-adapter';
import type { AgentHostProcessService } from '../../agent-host';
import type { Skill } from '../../agents/shared/prompts/utils/get-skills';
import { discoverSkills } from '../../agents/shared/prompts/utils/get-skills';
import { McpHostSupervisor } from '../../mcp-host';
import { AuthService } from '../../services/auth';
import { CredentialsService } from '../../services/credentials';
import { DevToolAPIService } from '../../services/dev-tool-api';
import { UserExperienceService } from '../../services/experience';
import { FilePickerService } from '../../services/file-picker';
import type { GitService } from '../../services/git';
import { HostedPullRequestService } from '../../services/hosted-pull-request';
import { ShellCapabilityBroker } from '../../services/guardian/shell-capability-broker';
import type { IdentifierService } from '../../services/identifier';
import type { KartonService } from '../../services/karton';
import type { Logger } from '../../services/logger';
import { McpRegistryService } from '../../services/mcp';
import { McpOAuthService } from '../../services/mcp/oauth';
import { discoverPluginMcpServers } from '../../services/mcp/plugin-bridge';
import { McpSettingsService } from '../../services/mcp/settings';
import type { GuardianEgressStartupResult } from '../../services/network-policy/startup';
import type { NotificationService } from '../../services/notification';
import { PluginMarketplaceService } from '../../services/plugin-marketplace';
import { PrivateMarketplaceSourcesService } from '../../services/plugin-marketplace/private-sources';
import { OFFICIAL_PLUGIN_MARKETPLACE_KEYS } from '../../services/plugin-marketplace/trusted-keys';
import type { PreferencesService } from '../../services/preferences';
import { RemoteConnectionsService } from '../../services/remote-connections';
import type { TelemetryService } from '../../services/telemetry';
import { ToolboxService } from '../../services/toolbox';
import { URIHandlerService } from '../../services/uri-handler';
import type { WindowLayoutService } from '../../services/window-layout';
import type { setupUrlHandlers } from '../url-routing';
import {
  getBuiltinSkillsPath,
  getInstalledPluginsDir,
  getShellCapabilityAuditPath,
} from '../../utils/paths';

type ToolboxCreateParameters = Parameters<typeof ToolboxService.create>;
type UrlHandlerRegistrations = ReturnType<typeof setupUrlHandlers>;

export interface PlatformIntegrationServicesPhaseOptions {
  logger: Logger;
  verbose: boolean | undefined;
  releaseChannel: AppReleaseChannel;
  appVersion: string;
  uiKarton: KartonService;
  windowLayoutService: WindowLayoutService;
  identifierService: IdentifierService;
  notificationService: NotificationService;
  telemetryService: TelemetryService;
  gitService: GitService;
  persistence: AgentCorePersistence;
  preferencesService: PreferencesService;
  registerAuthCallbackHandler: UrlHandlerRegistrations['registerAuthCallbackHandler'];
  registerMcpOAuthCallbackHandler: UrlHandlerRegistrations['registerMcpOAuthCallbackHandler'];
  guardianEgressStartup: GuardianEgressStartupResult;
  diffHistoryService: DiffHistoryService;
  pendingEditService: PendingEditService;
  detectedShell: ToolboxCreateParameters[13];
  resolvedEnvPromise: ToolboxCreateParameters[14];
  agentStore: ToolboxCreateParameters[15];
  hostAgentStateMutations: ToolboxCreateParameters[16];
  attachments: ToolboxCreateParameters[17];
  agentHostProcessService: AgentHostProcessService | null;
  protectedFiles: NonNullable<ToolboxCreateParameters[20]>;
  agentCoreHost: AgentHost;
  refreshPluginDefinitions: () => Promise<void>;
}

export interface PlatformIntegrationServicesPhaseResult {
  authService: AuthService;
  userExperienceService: UserExperienceService;
  credentialsService: CredentialsService;
  mcpOAuthService: McpOAuthService;
  mcpRegistryService: McpRegistryService;
  mcpSettingsService: McpSettingsService;
  pluginMarketplaceService: PluginMarketplaceService;
  privateMarketplaceSourcesService: PrivateMarketplaceSourcesService;
  hostedPullRequestService: HostedPullRequestService;
  toolboxService: ToolboxService;
  remoteConnectionsService: RemoteConnectionsService;
  isClodexCloudEnabled: () => boolean;
  startBuiltinSkillsSync: () => void;
}

export async function runPlatformIntegrationServicesPhase(
  options: PlatformIntegrationServicesPhaseOptions,
): Promise<PlatformIntegrationServicesPhaseResult> {
  const {
    logger,
    verbose,
    releaseChannel,
    appVersion,
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
    agentStore,
    hostAgentStateMutations,
    attachments,
    agentHostProcessService,
    protectedFiles,
    agentCoreHost,
    refreshPluginDefinitions,
  } = options;

  // Start remaining services that are irrelevant to non-regular operation of the app.
  const filePickerService = await FilePickerService.create(logger, uiKarton);

  // DevToolAPIService handles devtools-related functionality and state.
  const _devToolAPIService = await DevToolAPIService.create(
    logger,
    uiKarton,
    windowLayoutService,
  );

  // URIHandlerService registers the app as the default protocol client for clodex://.
  // URL handling is delegated to startup/url-routing.ts.
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
          releaseChannel,
        ).enabled,
    });
    await mcpRegistryService.syncPluginServers(servers);
  };
  let toolboxServiceForMarketplace: ToolboxService | null = null;
  const pluginMarketplaceService = await PluginMarketplaceService.create({
    logger,
    karton: uiKarton,
    appVersion,
    trustedKeys: OFFICIAL_PLUGIN_MARKETPLACE_KEYS,
    isFeatureEnabled: (feature) =>
      resolveFeatureGate(
        feature,
        preferencesService.get().featureGates.overrides,
        releaseChannel,
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
      appVersion,
      installer: pluginMarketplaceService,
      isFeatureEnabled: (feature) =>
        resolveFeatureGate(
          feature,
          preferencesService.get().featureGates.overrides,
          releaseChannel,
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
  const shellCapabilitySecurity = await ShellCapabilityBroker.create({
    auditPath: getShellCapabilityAuditPath(),
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
    agentStore,
    hostAgentStateMutations,
    attachments,
    persistence.memoryNotes,
    shellCapabilitySecurity,
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

  const startBuiltinSkillsSync = (): void => {
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
  };

  return {
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
  };
}
