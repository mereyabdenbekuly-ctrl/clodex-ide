import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCoreActivationPhaseOptions } from './agent-core-activation';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const adapter = (id: string) => ({ id });

  return {
    calls,
    adapter,
    activeAppController: { controller: 'active-app' },
    agentCoreBridge: null as unknown as {
      activeAppController: { controller: string };
    },
    attachAgentCoreBridge: vi.fn(),
    createBrowserHostEnvironmentSources: vi.fn(),
    registerToolboxGenerateWorkspaceMd: vi.fn(),
    agentPowerSaveCreate: vi.fn(),
    closedLidCreate: vi.fn(),
    recoveryCreate: vi.fn(),
  };
});

vi.mock('@clodex/agent-core/env/adapters', () => ({
  createRuntimeContextDomainAdapter: vi.fn(() => mocks.adapter('runtime')),
  createWorkspaceDomainAdapter: vi.fn(() => mocks.adapter('workspace')),
  createAgentsMdDomainAdapter: vi.fn(() => mocks.adapter('agents-md')),
  createWorkspaceMdDomainAdapter: vi.fn(() => mocks.adapter('workspace-md')),
  createEnabledSkillsDomainAdapter: vi.fn(() =>
    mocks.adapter('enabled-skills'),
  ),
  createMemoryDomainAdapter: vi.fn(() => mocks.adapter('memory')),
  createPlansDomainAdapter: vi.fn(() => mocks.adapter('plans')),
  createLogsDomainAdapter: vi.fn(() => mocks.adapter('logs')),
  createFileDiffsDomainAdapter: vi.fn(() => mocks.adapter('file-diffs')),
}));

vi.mock('../../env-domains/host-environment-sources', () => ({
  createBrowserHostEnvironmentSources:
    mocks.createBrowserHostEnvironmentSources,
}));

vi.mock('../../env-domains/browser-domain-adapter', () => ({
  createBrowserDomainAdapter: vi.fn(() => mocks.adapter('browser')),
}));

vi.mock('@clodex/agent-shell/env', () => ({
  createShellsDomainAdapter: vi.fn(() => mocks.adapter('shells')),
}));

vi.mock('../../env-domains/sandbox-domain-adapter', () => ({
  createSandboxDomainAdapter: vi.fn(() => mocks.adapter('sandbox')),
}));

vi.mock('../../env-domains/active-app-domain-adapter', () => ({
  createActiveAppDomainAdapter: vi.fn(() => mocks.adapter('active-app')),
}));

vi.mock('../../env-domains/log-ingest-domain-adapter', () => ({
  createLogIngestDomainAdapter: vi.fn(() => mocks.adapter('log-ingest')),
}));

vi.mock('../../services/agent-core-bridge/handlers/toolbox', () => ({
  registerToolboxGenerateWorkspaceMd: mocks.registerToolboxGenerateWorkspaceMd,
}));

vi.mock('../../services/agent-core-bridge/wiring', () => ({
  attachAgentCoreBridge: mocks.attachAgentCoreBridge,
}));

vi.mock('../../services/agent-power-save-blocker', () => ({
  AgentPowerSaveBlockerService: { create: mocks.agentPowerSaveCreate },
}));

vi.mock('../../services/macos-closed-lid-sleep', () => ({
  MacOSClosedLidSleepService: { create: mocks.closedLidCreate },
}));

vi.mock('../../services/agent-runtime-recovery', () => ({
  AgentRuntimeRecoveryService: { create: mocks.recoveryCreate },
}));

import { runAgentCoreActivationPhase } from './agent-core-activation';

function createHarness(options?: { mountManager?: object | null }) {
  const mountManager =
    options && 'mountManager' in options
      ? options.mountManager
      : { mount: 'manager' };
  let workspaceLastUsedAtResolver:
    | ((workspacePaths: string[]) => Promise<Map<string, number>>)
    | undefined;

  const logger = { service: 'logger' };
  const karton = { service: 'karton' };
  const modelProviderService = { service: 'models' };
  const agentHostProcessService = { service: 'agent-host-process' };
  const agentCoreSeam = {
    registry: { service: 'registry' },
    store: { service: 'store' },
  };
  const lazyHostModels = {
    setModelProviderService: vi.fn(() => {
      mocks.calls.push('lazy-models');
    }),
  };
  const agentCoreHost = {
    environmentSources: undefined as unknown,
    workspaceMdRelativePath: vi.fn(() => '.clodex/WORKSPACE.md'),
  };
  const persistence = {
    agentDb: {
      getWorkspaceLastUsedAtByPath: vi.fn(),
    },
  };
  const diffHistoryService = { service: 'diff-history' };
  const pendingEditService = { service: 'pending-edits' };
  const toolboxService = {
    setWorkspaceLastUsedAtResolver: vi.fn((resolver) => {
      mocks.calls.push('workspace-last-used');
      workspaceLastUsedAtResolver = resolver;
    }),
    setActiveAppController: vi.fn(() => {
      mocks.calls.push('active-app-controller');
    }),
    getMountManager: vi.fn(() => {
      mocks.calls.push('get-mount-manager');
      return mountManager;
    }),
    getSkillsList: vi.fn(async () => []),
    getShellSnapshot: vi.fn(() => ({ sessions: [] })),
    getShellInfo: vi.fn(() => null),
    getSandboxSessionId: vi.fn(() => null),
    getLogIngestSnapshot: vi.fn(() => null),
  };
  const registeredAdapters: string[] = [];
  const agentManagerService = {
    generateWorkspaceMdForPath: vi.fn(async () => undefined),
    registerEnvAdapter: vi.fn((adapter: { id: string }) => {
      mocks.calls.push(`adapter:${adapter.id}`);
      registeredAdapters.push(adapter.id);
    }),
  };
  const cloudTaskRuntime = {
    recovery: { reconcile: vi.fn(async () => undefined) },
  };
  const isClodexCloudEnabled = vi.fn(() => true);

  mocks.registerToolboxGenerateWorkspaceMd.mockImplementation(() => {
    mocks.calls.push('workspace-md-handler');
  });
  mocks.attachAgentCoreBridge.mockImplementation(() => {
    mocks.calls.push('attach-bridge');
    return mocks.agentCoreBridge;
  });
  mocks.createBrowserHostEnvironmentSources.mockImplementation(() => {
    mocks.calls.push('environment-sources');
    return { service: 'environment-sources' };
  });
  mocks.agentPowerSaveCreate.mockImplementation(() => {
    mocks.calls.push('power-save');
    return { service: 'power-save' };
  });
  mocks.closedLidCreate.mockImplementation(() => {
    mocks.calls.push('closed-lid');
    return { service: 'closed-lid' };
  });
  mocks.recoveryCreate.mockImplementation(() => {
    mocks.calls.push('recovery');
    return { service: 'recovery' };
  });

  const phaseOptions = {
    logger,
    karton,
    toolboxService,
    agentManagerService,
    modelProviderService,
    foundation: {
      agentCoreSeam,
      agentHostProcessService,
      lazyHostModels,
      agentCoreHost,
      persistence,
      diffHistoryService,
      pendingEditService,
    },
    cloudTaskRuntime,
    isClodexCloudEnabled,
  } as unknown as AgentCoreActivationPhaseOptions;

  return {
    phaseOptions,
    logger,
    karton,
    modelProviderService,
    agentHostProcessService,
    agentCoreSeam,
    lazyHostModels,
    agentCoreHost,
    persistence,
    diffHistoryService,
    pendingEditService,
    toolboxService,
    agentManagerService,
    registeredAdapters,
    cloudTaskRuntime,
    isClodexCloudEnabled,
    getWorkspaceLastUsedAtResolver: () => workspaceLastUsedAtResolver,
  };
}

describe('runAgentCoreActivationPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.agentCoreBridge = {
      activeAppController: mocks.activeAppController,
    };
  });

  it('preserves bridge timing, adapter order, and runtime service order', () => {
    const harness = createHarness();

    const result = runAgentCoreActivationPhase(harness.phaseOptions);

    expect(mocks.calls).toEqual([
      'workspace-last-used',
      'workspace-md-handler',
      'lazy-models',
      'attach-bridge',
      'active-app-controller',
      'environment-sources',
      'get-mount-manager',
      'adapter:runtime',
      'adapter:workspace',
      'adapter:agents-md',
      'adapter:workspace-md',
      'adapter:enabled-skills',
      'adapter:memory',
      'adapter:plans',
      'adapter:logs',
      'adapter:file-diffs',
      'adapter:browser',
      'adapter:shells',
      'adapter:sandbox',
      'adapter:active-app',
      'adapter:log-ingest',
      'power-save',
      'closed-lid',
      'recovery',
    ]);
    expect(harness.registeredAdapters).toEqual([
      'runtime',
      'workspace',
      'agents-md',
      'workspace-md',
      'enabled-skills',
      'memory',
      'plans',
      'logs',
      'file-diffs',
      'browser',
      'shells',
      'sandbox',
      'active-app',
      'log-ingest',
    ]);
    expect(harness.lazyHostModels.setModelProviderService).toHaveBeenCalledWith(
      harness.modelProviderService,
    );
    expect(mocks.attachAgentCoreBridge).toHaveBeenCalledWith(
      harness.agentCoreSeam,
      {
        host: harness.agentCoreHost,
        diffHistory: harness.diffHistoryService,
        pendingEdits: harness.pendingEditService,
      },
    );
    expect(harness.toolboxService.setActiveAppController).toHaveBeenCalledWith(
      mocks.activeAppController,
    );
    expect(mocks.recoveryCreate).toHaveBeenCalledWith(
      harness.logger,
      harness.agentManagerService,
      harness.agentHostProcessService,
      expect.objectContaining({ reconcile: expect.any(Function) }),
    );
    expect(result).toEqual({
      agentCoreBridge: mocks.agentCoreBridge,
      agentPowerSaveBlockerService: { service: 'power-save' },
      macOSClosedLidSleepService: { service: 'closed-lid' },
      agentRuntimeRecoveryService: { service: 'recovery' },
    });
  });

  it('installs the workspace-last-used resolver with the existing empty-map fallback', async () => {
    const harness = createHarness();
    harness.persistence.agentDb.getWorkspaceLastUsedAtByPath.mockResolvedValue(
      null,
    );

    runAgentCoreActivationPhase(harness.phaseOptions);
    const resolver = harness.getWorkspaceLastUsedAtResolver();

    await expect(resolver?.(['/workspace'])).resolves.toEqual(new Map());
    expect(
      harness.persistence.agentDb.getWorkspaceLastUsedAtByPath,
    ).toHaveBeenCalledWith(['/workspace']);
  });

  it('fails fast on a missing mount manager after bridge activation and before adapter wiring', () => {
    const harness = createHarness({ mountManager: null });

    expect(() => runAgentCoreActivationPhase(harness.phaseOptions)).toThrow(
      '[Main] toolboxService.getMountManager() returned null — mount manager must be initialized before env-state adapter wiring',
    );

    expect(mocks.calls).toEqual([
      'workspace-last-used',
      'workspace-md-handler',
      'lazy-models',
      'attach-bridge',
      'active-app-controller',
      'environment-sources',
      'get-mount-manager',
    ]);
    expect(
      harness.agentManagerService.registerEnvAdapter,
    ).not.toHaveBeenCalled();
    expect(mocks.agentPowerSaveCreate).not.toHaveBeenCalled();
    expect(mocks.closedLidCreate).not.toHaveBeenCalled();
    expect(mocks.recoveryCreate).not.toHaveBeenCalled();
  });
});
