import type { Logger } from '../../services/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const authService = {
    accessToken: 'account-token' as string | undefined,
    modelAccessToken: 'model-token' as string | undefined,
    handleAuthCallbackUrl: vi.fn(),
    registerAuthStateChangeCallback: vi.fn(),
  };
  const credentialsService = {
    setAccessTokenProvider: vi.fn(),
  };
  const mcpOAuthService = { service: 'mcp-oauth' };
  const mcpRegistryService = {
    handleOAuthCallback: vi.fn(),
    setElicitationHandler: vi.fn(),
    syncPluginServers: vi.fn(async (_servers: unknown) => {
      order.push('sync-plugin-mcp');
    }),
  };
  const mcpSettingsService = { service: 'mcp-settings' };
  const toolboxService = {
    createUserTerminal: vi.fn(),
    getAllMountedPaths: vi.fn(),
    refreshPluginSkills: vi.fn(() => {
      order.push('refresh-plugin-skills');
    }),
    requestMcpElicitation: vi.fn(),
    setBuiltinSkills: vi.fn(),
    setNetworkPolicyEvaluator: vi.fn(),
    setRemoteConnectionsService: vi.fn(),
    writeUserTerminalInput: vi.fn(),
  };
  const pluginMarketplaceState = {
    installed: [{ id: 'initial-plugin' }],
  };
  const pluginMarketplaceService = {
    getState: vi.fn(() => pluginMarketplaceState),
  };
  const remoteConnectionsService = { service: 'remote-connections' };
  const isolatedAgentTurnHandlers = { service: 'isolated-turn-handlers' };

  return {
    authCreate: vi.fn(async () => {
      order.push('auth');
      return authService;
    }),
    authService,
    authStateChangeCallback: undefined as (() => void) | undefined,
    credentialsCreate: vi.fn(async () => {
      order.push('credentials');
      return credentialsService;
    }),
    credentialsService,
    devToolCreate: vi.fn(async () => {
      order.push('dev-tool');
      return { service: 'dev-tool' };
    }),
    discoverPluginMcpServers: vi.fn(
      async (_options: {
        installedDir: string;
        installed: unknown;
        isExecutableRuntimeEnabled: () => boolean;
      }) => {
        order.push('discover-plugin-mcp');
        return [{ id: 'plugin-mcp-server' }];
      },
    ),
    discoverSkills: vi.fn(async () => {
      order.push('discover-skills');
      return [
        {
          name: 'Learn',
          description: 'Learn skill',
          path: '/builtin/learn',
          userInvocable: true,
          agentInvocable: false,
        },
        {
          name: 'Plan',
          description: 'Plan skill',
          path: '/builtin/plan',
          userInvocable: true,
          agentInvocable: true,
        },
      ];
    }),
    filePickerCreate: vi.fn(async () => {
      order.push('file-picker');
      return { service: 'file-picker' };
    }),
    hostedPullRequestCreate: vi.fn(async () => {
      order.push('hosted-pull-request');
      return { service: 'hosted-pull-request' };
    }),
    isolatedAgentTurnHandlers,
    mcpHostCreate: vi.fn(async () => ({ service: 'mcp-host' })),
    mcpOAuthCreate: vi.fn(async () => {
      order.push('mcp-oauth');
      return mcpOAuthService;
    }),
    mcpOAuthService,
    mcpRegistryCreate: vi.fn(async () => {
      order.push('mcp-registry');
      return mcpRegistryService;
    }),
    mcpRegistryOptions: undefined as Record<string, unknown> | undefined,
    mcpRegistryService,
    mcpSettingsCreate: vi.fn(async () => {
      order.push('mcp-settings');
      return mcpSettingsService;
    }),
    mcpSettingsService,
    order,
    pluginMarketplaceCreate: vi.fn(async () => {
      order.push('plugin-marketplace');
      return pluginMarketplaceService;
    }),
    pluginMarketplaceOptions: undefined as Record<string, unknown> | undefined,
    pluginMarketplaceService,
    pluginMarketplaceState,
    privateMarketplaceCreate: vi.fn(async () => {
      order.push('private-marketplace');
      return { service: 'private-marketplace' };
    }),
    remoteConnectionsCreate: vi.fn(async () => {
      order.push('remote-connections');
      return remoteConnectionsService;
    }),
    remoteConnectionsOptions: undefined as Record<string, unknown> | undefined,
    remoteConnectionsService,
    resolveFeatureGate: vi.fn(() => ({ enabled: true })),
    createBrowserIsolatedAgentTurnHandlers: vi.fn(() => {
      order.push('isolated-turn-handlers');
      return isolatedAgentTurnHandlers;
    }),
    toolboxCreate: vi.fn(async () => {
      order.push('toolbox');
      return toolboxService;
    }),
    toolboxService,
    uriHandlerCreate: vi.fn(async () => {
      order.push('uri-handler');
      return { service: 'uri-handler' };
    }),
    userExperienceCreate: vi.fn(async () => {
      order.push('user-experience');
      return { service: 'user-experience' };
    }),
    userExperienceOptions: undefined as unknown[] | undefined,
  };
});

vi.mock('@shared/feature-gates', () => ({
  resolveFeatureGate: mocks.resolveFeatureGate,
}));

vi.mock('@shared/provider-consent', () => ({
  isClodexCloudSelected: vi.fn(
    (_preferences: unknown, authenticated: boolean) => authenticated,
  ),
}));

vi.mock('../../agent-host/browser-turn-adapter', () => ({
  createBrowserIsolatedAgentTurnHandlers:
    mocks.createBrowserIsolatedAgentTurnHandlers,
}));

vi.mock('../../agents/shared/prompts/utils/get-skills', () => ({
  discoverSkills: mocks.discoverSkills,
}));

vi.mock('../../mcp-host', () => ({
  McpHostSupervisor: { create: mocks.mcpHostCreate },
}));

vi.mock('../../services/auth', () => ({
  AuthService: { create: mocks.authCreate },
}));

vi.mock('../../services/credentials', () => ({
  CredentialsService: { create: mocks.credentialsCreate },
}));

vi.mock('../../services/dev-tool-api', () => ({
  DevToolAPIService: { create: mocks.devToolCreate },
}));

vi.mock('../../services/experience', () => ({
  UserExperienceService: {
    create: vi.fn((...args: unknown[]) => {
      mocks.userExperienceOptions = args;
      return mocks.userExperienceCreate();
    }),
  },
}));

vi.mock('../../services/file-picker', () => ({
  FilePickerService: { create: mocks.filePickerCreate },
}));

vi.mock('../../services/hosted-pull-request', () => ({
  HostedPullRequestService: { create: mocks.hostedPullRequestCreate },
}));

vi.mock('../../services/mcp', () => ({
  McpRegistryService: {
    create: vi.fn((options: Record<string, unknown>) => {
      mocks.mcpRegistryOptions = options;
      return mocks.mcpRegistryCreate();
    }),
  },
}));

vi.mock('../../services/mcp/oauth', () => ({
  McpOAuthService: { create: mocks.mcpOAuthCreate },
}));

vi.mock('../../services/mcp/plugin-bridge', () => ({
  discoverPluginMcpServers: mocks.discoverPluginMcpServers,
}));

vi.mock('../../services/mcp/settings', () => ({
  McpSettingsService: { create: mocks.mcpSettingsCreate },
}));

vi.mock('../../services/plugin-marketplace', () => ({
  PluginMarketplaceService: {
    create: vi.fn((options: Record<string, unknown>) => {
      mocks.pluginMarketplaceOptions = options;
      return mocks.pluginMarketplaceCreate();
    }),
  },
}));

vi.mock('../../services/plugin-marketplace/private-sources', () => ({
  PrivateMarketplaceSourcesService: {
    create: mocks.privateMarketplaceCreate,
  },
}));

vi.mock('../../services/plugin-marketplace/trusted-keys', () => ({
  OFFICIAL_PLUGIN_MARKETPLACE_KEYS: { official: 'public-key' },
}));

vi.mock('../../services/remote-connections', () => ({
  RemoteConnectionsService: {
    create: vi.fn((options: Record<string, unknown>) => {
      mocks.remoteConnectionsOptions = options;
      return mocks.remoteConnectionsCreate();
    }),
  },
}));

vi.mock('../../services/toolbox', () => ({
  ToolboxService: { create: mocks.toolboxCreate },
}));

vi.mock('../../services/uri-handler', () => ({
  URIHandlerService: { create: mocks.uriHandlerCreate },
}));

vi.mock('../../utils/paths', () => ({
  getBuiltinSkillsPath: () => '/builtin-skills',
  getInstalledPluginsDir: () => '/installed-plugins',
}));

import {
  runPlatformIntegrationServicesPhase,
  type PlatformIntegrationServicesPhaseOptions,
} from './platform-integration-services';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function createHarness(
  overrides: Partial<PlatformIntegrationServicesPhaseOptions> = {},
) {
  const preferences = { featureGates: { overrides: {} } };
  const preferencesService = {
    get: vi.fn(() => preferences),
    migrateProviderProfiles: vi.fn(async () => {
      mocks.order.push('migrate-provider-profiles');
    }),
    syncClodexAccountProfile: vi.fn(async () => undefined),
  };
  const agentDb = {
    getAgentCount: vi.fn(async () => 7),
    getOldestAgentCreatedAt: vi.fn(async () => 123),
  };
  const persistence = {
    agentDb,
    memoryNotes: { service: 'memory-notes' },
    setMountPathsResolver: vi.fn((_resolver: () => string[]) => {
      mocks.order.push('mount-resolver');
    }),
  };
  const agentHostProcessService = {
    setAgentTurnHandlers: vi.fn(() => {
      mocks.order.push('set-isolated-turn-handlers');
    }),
  };
  const refreshPluginDefinitions = vi.fn(async () => {
    mocks.order.push('refresh-plugin-definitions');
  });
  const registerAuthCallbackHandler = vi.fn(
    (_handler: (url: string) => boolean | Promise<boolean>) => {
      mocks.order.push('register-auth-callback');
    },
  );
  const registerMcpOAuthCallbackHandler = vi.fn(
    (_handler: (url: string) => boolean | Promise<boolean>) => {
      mocks.order.push('register-mcp-callback');
    },
  );
  const remoteMcp = {
    enabled: true as const,
    resolveNetworkProxy: vi.fn(),
    revokeNetworkProxy: vi.fn(),
  };
  const guardianEgressStartup = {
    networkPolicyEvaluator: { evaluate: vi.fn() },
    remoteMcp,
  };
  const options = {
    logger,
    verbose: true,
    releaseChannel: 'prerelease',
    appVersion: '1.2.3',
    uiKarton: { service: 'karton' },
    windowLayoutService: { service: 'window-layout' },
    identifierService: { service: 'identifier' },
    notificationService: { service: 'notification' },
    telemetryService: { capture: vi.fn() },
    gitService: { service: 'git' },
    persistence,
    preferencesService,
    registerAuthCallbackHandler,
    registerMcpOAuthCallbackHandler,
    guardianEgressStartup,
    diffHistoryService: { service: 'diff-history' },
    pendingEditService: { service: 'pending-edit' },
    detectedShell: { shell: '/bin/zsh' },
    resolvedEnvPromise: Promise.resolve({ PATH: '/bin' }),
    agentStore: { service: 'agent-store' },
    hostAgentStateMutations: { service: 'host-agent-state-mutations' },
    attachments: { service: 'attachments' },
    agentHostProcessService,
    protectedFiles: { service: 'protected-files' },
    agentCoreHost: { service: 'agent-core-host' },
    refreshPluginDefinitions,
    ...overrides,
  } as unknown as PlatformIntegrationServicesPhaseOptions;

  return {
    agentDb,
    agentHostProcessService,
    guardianEgressStartup,
    options,
    persistence,
    preferences,
    preferencesService,
    refreshPluginDefinitions,
    registerAuthCallbackHandler,
    registerMcpOAuthCallbackHandler,
    remoteMcp,
  };
}

describe('runPlatformIntegrationServicesPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.authService.accessToken = 'account-token';
    mocks.authService.modelAccessToken = 'model-token';
    mocks.pluginMarketplaceState.installed = [{ id: 'initial-plugin' }];
    mocks.mcpRegistryOptions = undefined;
    mocks.pluginMarketplaceOptions = undefined;
    mocks.remoteConnectionsOptions = undefined;
    mocks.toolboxService.createUserTerminal.mockReturnValue('terminal-1');
    mocks.toolboxService.getAllMountedPaths.mockReturnValue(['/workspace']);
    mocks.toolboxService.requestMcpElicitation.mockResolvedValue({
      action: 'accept',
    });
  });

  it('constructs and wires services in the original startup order', async () => {
    const harness = createHarness();

    const result = await runPlatformIntegrationServicesPhase(harness.options);
    result.startBuiltinSkillsSync();

    expect(mocks.order).toEqual([
      'file-picker',
      'dev-tool',
      'uri-handler',
      'auth',
      'register-auth-callback',
      'user-experience',
      'credentials',
      'migrate-provider-profiles',
      'mcp-oauth',
      'mcp-registry',
      'register-mcp-callback',
      'mcp-settings',
      'plugin-marketplace',
      'private-marketplace',
      'refresh-plugin-definitions',
      'discover-plugin-mcp',
      'sync-plugin-mcp',
      'hosted-pull-request',
      'toolbox',
      'remote-connections',
      'isolated-turn-handlers',
      'set-isolated-turn-handlers',
      'mount-resolver',
      'discover-skills',
    ]);
    expect(result).toMatchObject({
      authService: mocks.authService,
      credentialsService: mocks.credentialsService,
      mcpOAuthService: mocks.mcpOAuthService,
      mcpRegistryService: mocks.mcpRegistryService,
      mcpSettingsService: mocks.mcpSettingsService,
      pluginMarketplaceService: mocks.pluginMarketplaceService,
      toolboxService: mocks.toolboxService,
      remoteConnectionsService: mocks.remoteConnectionsService,
    });
    expect(Object.keys(result)).toEqual([
      'authService',
      'userExperienceService',
      'credentialsService',
      'mcpOAuthService',
      'mcpRegistryService',
      'mcpSettingsService',
      'pluginMarketplaceService',
      'privateMarketplaceSourcesService',
      'hostedPullRequestService',
      'toolboxService',
      'remoteConnectionsService',
      'isClodexCloudEnabled',
      'startBuiltinSkillsSync',
    ]);
    expect(mocks.toolboxCreate).toHaveBeenCalledWith(
      logger,
      harness.options.uiKarton,
      harness.options.diffHistoryService,
      harness.options.pendingEditService,
      harness.options.windowLayoutService,
      mocks.authService,
      harness.options.telemetryService,
      expect.anything(),
      expect.anything(),
      mocks.credentialsService,
      mocks.mcpRegistryService,
      harness.options.gitService,
      harness.options.preferencesService,
      harness.options.detectedShell,
      harness.options.resolvedEnvPromise,
      harness.options.agentStore,
      harness.options.hostAgentStateMutations,
      harness.options.attachments,
      harness.options.persistence.memoryNotes,
      harness.options.agentHostProcessService,
      harness.options.protectedFiles,
    );
    expect(mocks.toolboxService.setNetworkPolicyEvaluator).toHaveBeenCalledWith(
      harness.guardianEgressStartup.networkPolicyEvaluator,
    );
    expect(harness.persistence.setMountPathsResolver).toHaveBeenCalledOnce();
    const mountResolver = harness.persistence.setMountPathsResolver.mock
      .calls[0]?.[0] as () => string[];
    expect(mountResolver()).toEqual(['/workspace']);
    expect(mocks.createBrowserIsolatedAgentTurnHandlers).toHaveBeenCalledWith({
      host: harness.options.agentCoreHost,
      toolbox: mocks.toolboxService,
    });
    expect(
      harness.agentHostProcessService.setAgentTurnHandlers,
    ).toHaveBeenCalledWith(mocks.isolatedAgentTurnHandlers);

    await Promise.resolve();
    expect(mocks.toolboxService.setBuiltinSkills).toHaveBeenCalledWith([
      {
        id: 'command:plan',
        displayName: 'Plan',
        description: 'Plan skill',
        source: 'builtin',
        contentPath: '/builtin/plan/SKILL.md',
        userInvocable: true,
        agentInvocable: true,
      },
      {
        id: 'command:learn',
        displayName: 'Learn',
        description: 'Learn skill',
        source: 'builtin',
        contentPath: '/builtin/learn/SKILL.md',
        userInvocable: true,
        agentInvocable: false,
      },
    ]);
  });

  it('publishes already-resolved builtin discovery after synchronous model wiring starts', async () => {
    const harness = createHarness();
    const result = await runPlatformIntegrationServicesPhase(harness.options);
    mocks.order.length = 0;
    mocks.toolboxService.setBuiltinSkills.mockImplementationOnce(() => {
      mocks.order.push('builtin-skills-published');
    });

    result.startBuiltinSkillsSync();
    mocks.order.push('model-pre-first-await-wiring');

    expect(mocks.order).toEqual([
      'discover-skills',
      'model-pre-first-await-wiring',
    ]);
    await Promise.resolve();
    expect(mocks.order).toEqual([
      'discover-skills',
      'model-pre-first-await-wiring',
      'builtin-skills-published',
    ]);
  });

  it('forwards auth, profile, MCP, elicitation, and remote-terminal callbacks', async () => {
    const harness = createHarness();

    const result = await runPlatformIntegrationServicesPhase(harness.options);

    expect(
      harness.preferencesService.migrateProviderProfiles,
    ).toHaveBeenCalledWith(mocks.credentialsService, 'model-token');
    const tokenProvider = mocks.credentialsService.setAccessTokenProvider.mock
      .calls[0]?.[0] as () => string | undefined;
    expect(tokenProvider()).toBe('account-token');
    mocks.authService.accessToken = 'new-account-token';
    expect(tokenProvider()).toBe('new-account-token');
    expect(result.isClodexCloudEnabled()).toBe(true);

    const authCallback = harness.registerAuthCallbackHandler.mock.calls[0]?.[0];
    mocks.authService.handleAuthCallbackUrl.mockResolvedValue(true);
    await expect(authCallback?.('clodex://auth/callback')).resolves.toBe(true);
    expect(mocks.authService.handleAuthCallbackUrl).toHaveBeenCalledWith(
      'clodex://auth/callback',
    );

    const mcpCallback =
      harness.registerMcpOAuthCallbackHandler.mock.calls[0]?.[0];
    mocks.mcpRegistryService.handleOAuthCallback.mockResolvedValue(true);
    await expect(mcpCallback?.('clodex://mcp/oauth/callback')).resolves.toBe(
      true,
    );
    expect(mocks.mcpRegistryService.handleOAuthCallback).toHaveBeenCalledWith(
      'clodex://mcp/oauth/callback',
    );

    const authStateCallback =
      mocks.authService.registerAuthStateChangeCallback.mock.calls[0]?.[0];
    mocks.authService.modelAccessToken = 'rotated-model-token';
    authStateCallback?.();
    await Promise.resolve();
    expect(
      harness.preferencesService.syncClodexAccountProfile,
    ).toHaveBeenCalledWith(mocks.credentialsService, 'rotated-model-token');

    harness.preferencesService.syncClodexAccountProfile.mockRejectedValueOnce(
      new Error('profile sync failed'),
    );
    authStateCallback?.();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      '[PreferencesService] Failed to sync Clodex provider profile: Error: profile sync failed',
    );

    const elicitationHandler =
      mocks.mcpRegistryService.setElicitationHandler.mock.calls[0]?.[0];
    const signal = new AbortController().signal;
    await expect(
      elicitationHandler?.('server', 'agent', { mode: 'form' }, signal),
    ).resolves.toEqual({ action: 'accept' });
    expect(mocks.toolboxService.requestMcpElicitation).toHaveBeenCalledWith(
      'server',
      'agent',
      { mode: 'form' },
      signal,
    );

    const remoteOptions = mocks.remoteConnectionsOptions as {
      createTerminal: () => string;
      writeTerminalInput: (terminalId: string, data: string) => void;
    };
    expect(remoteOptions.createTerminal()).toBe('terminal-1');
    remoteOptions.writeTerminalInput('terminal-1', 'ls\n');
    expect(mocks.toolboxService.writeUserTerminalInput).toHaveBeenCalledWith(
      'terminal-1',
      'ls\n',
    );

    const experienceArgs = mocks.userExperienceOptions;
    expect(experienceArgs).toBeDefined();
    await expect(
      (experienceArgs?.[4] as () => Promise<number>)(),
    ).resolves.toBe(123);
    await expect(
      (experienceArgs?.[5] as () => Promise<number>)(),
    ).resolves.toBe(7);
  });

  it('preserves marketplace refresh closure semantics and MCP server sync', async () => {
    const harness = createHarness();

    await runPlatformIntegrationServicesPhase(harness.options);

    expect(harness.refreshPluginDefinitions).toHaveBeenCalledTimes(1);
    expect(mocks.discoverPluginMcpServers).toHaveBeenCalledWith({
      installedDir: '/installed-plugins',
      installed: [{ id: 'initial-plugin' }],
      isExecutableRuntimeEnabled: expect.any(Function),
    });
    expect(mocks.mcpRegistryService.syncPluginServers).toHaveBeenCalledWith([
      { id: 'plugin-mcp-server' },
    ]);

    mocks.pluginMarketplaceState.installed = [{ id: 'updated-plugin' }];
    mocks.order.length = 0;
    const refresh = deferred<void>();
    harness.refreshPluginDefinitions.mockImplementationOnce(() => {
      mocks.order.push('refresh-plugin-definitions');
      return refresh.promise;
    });
    const onPluginsChanged = mocks.pluginMarketplaceOptions?.onPluginsChanged as
      | (() => Promise<void>)
      | undefined;
    const changed = onPluginsChanged?.();
    await Promise.resolve();

    expect(mocks.order).toEqual(['refresh-plugin-definitions']);
    expect(mocks.toolboxService.refreshPluginSkills).not.toHaveBeenCalled();
    refresh.resolve();
    await changed;

    expect(mocks.order).toEqual([
      'refresh-plugin-definitions',
      'refresh-plugin-skills',
      'discover-plugin-mcp',
      'sync-plugin-mcp',
    ]);
    expect(harness.refreshPluginDefinitions).toHaveBeenCalledTimes(2);
    expect(mocks.toolboxService.refreshPluginSkills).toHaveBeenCalledOnce();
    expect(mocks.discoverPluginMcpServers).toHaveBeenLastCalledWith({
      installedDir: '/installed-plugins',
      installed: [{ id: 'updated-plugin' }],
      isExecutableRuntimeEnabled: expect.any(Function),
    });
    expect(mocks.mcpRegistryService.syncPluginServers).toHaveBeenCalledTimes(2);

    const isExecutableRuntimeEnabled = mocks.discoverPluginMcpServers.mock
      .calls[1]?.[0].isExecutableRuntimeEnabled as () => boolean;
    expect(isExecutableRuntimeEnabled()).toBe(true);
    expect(mocks.resolveFeatureGate).toHaveBeenLastCalledWith(
      'executable-extensions',
      harness.preferences.featureGates.overrides,
      'prerelease',
    );
  });

  it('wraps remote MCP host creation with the guardian egress callbacks', async () => {
    const harness = createHarness();

    await runPlatformIntegrationServicesPhase(harness.options);

    const createHost = mocks.mcpRegistryOptions?.createHost as
      | ((options: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const hostOptions = {
      onConnectionState: vi.fn(),
      onServerLog: vi.fn(),
    };
    await createHost?.(hostOptions);

    expect(mocks.mcpHostCreate).toHaveBeenCalledWith(logger, {
      ...hostOptions,
      resolveNetworkProxy: harness.remoteMcp.resolveNetworkProxy,
      revokeNetworkProxy: harness.remoteMcp.revokeNetworkProxy,
    });
  });

  it('omits the remote MCP host wrapper when guardian egress is disabled', async () => {
    const harness = createHarness({
      guardianEgressStartup: {
        networkPolicyEvaluator: null,
        remoteMcp: { enabled: false },
      } as PlatformIntegrationServicesPhaseOptions['guardianEgressStartup'],
    });

    await runPlatformIntegrationServicesPhase(harness.options);

    expect(mocks.mcpRegistryOptions).not.toHaveProperty('createHost');
    expect(mocks.mcpHostCreate).not.toHaveBeenCalled();
  });
});
