import type { AgentCorePersistenceOptions } from '@clodex/agent-core/persistence';
import type { FeatureGateOverrides } from '@shared/feature-gates';
import type { UserPreferences } from '@shared/karton-contracts/ui/shared-types';
import type { PluginDefinition } from '@shared/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../services/logger';

const mocks = vi.hoisted(() => ({
  agentHostProcessCreate: vi.fn(),
  applyBrowserAgentBehavior: vi.fn(),
  backfillConstructor: vi.fn(),
  createAgentCoreSeam: vi.fn(),
  createBrowserAgentHost: vi.fn(),
  createLazyBrowserHostModels: vi.fn(),
  discoverPlugins: vi.fn(),
  evidenceMemoryInspectorCreate: vi.fn(),
  getInstalledPluginsDir: vi.fn(() => '/installed-plugins'),
  getNetworkPolicyAuditPath: vi.fn(() => '/network-policy-audit.jsonl'),
  getPluginsPath: vi.fn(() => '/bundled-plugins'),
  memoryNotesSettingsCreate: vi.fn(),
  networkEgressControlCenterCreate: vi.fn(),
  pendingEditConstructor: vi.fn(),
  persistenceCreate: vi.fn(),
  resolveFeatureGate: vi.fn(),
}));

vi.mock('@clodex/agent-core', () => ({
  PendingEditService: class MockPendingEditService {
    public constructor(options: unknown) {
      mocks.pendingEditConstructor(options, this);
    }
  },
}));

vi.mock('@clodex/agent-core/persistence', () => ({
  AgentCorePersistence: {
    create: mocks.persistenceCreate,
  },
}));

vi.mock('@shared/feature-gates', () => ({
  resolveFeatureGate: mocks.resolveFeatureGate,
}));

vi.mock('../../agent-host', () => ({
  AgentHostProcessService: {
    create: mocks.agentHostProcessCreate,
  },
}));

vi.mock('../../services/agent-core-bridge/host', () => ({
  applyBrowserAgentBehavior: mocks.applyBrowserAgentBehavior,
  createBrowserAgentHost: mocks.createBrowserAgentHost,
}));

vi.mock('../../services/agent-core-bridge/host-models', () => ({
  createLazyBrowserHostModels: mocks.createLazyBrowserHostModels,
}));

vi.mock('../../services/agent-core-bridge/wiring', () => ({
  createAgentCoreSeam: mocks.createAgentCoreSeam,
}));

vi.mock('../../services/evidence-memory-dogfood-backfill', () => ({
  EvidenceMemoryDogfoodBackfill: class MockEvidenceMemoryDogfoodBackfill {
    public constructor(options: unknown) {
      mocks.backfillConstructor(options, this);
    }
  },
}));

vi.mock('../../services/evidence-memory-inspector', () => ({
  EvidenceMemoryInspectorService: {
    create: mocks.evidenceMemoryInspectorCreate,
  },
}));

vi.mock('../../services/memory-notes-settings', () => ({
  MemoryNotesSettingsService: {
    create: mocks.memoryNotesSettingsCreate,
  },
}));

vi.mock('../../services/network-policy/control-center', () => ({
  NetworkEgressControlCenterService: {
    create: mocks.networkEgressControlCenterCreate,
  },
}));

vi.mock('../../utils/discover-plugins', () => ({
  discoverPlugins: mocks.discoverPlugins,
}));

vi.mock('../../utils/paths', () => ({
  getInstalledPluginsDir: mocks.getInstalledPluginsDir,
  getNetworkPolicyAuditPath: mocks.getNetworkPolicyAuditPath,
  getPluginsPath: mocks.getPluginsPath,
}));

import {
  runAgentCoreFoundationPhase,
  type AgentCoreFoundationPhaseOptions,
} from './agent-core-foundation';

const originalEvidenceMemoryDisableEnv =
  process.env.CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION;

const diffHistoryService = { service: 'diff-history' };
const memoryNotes = { service: 'memory-notes' };
const memoryNotesSettingsService = { service: 'memory-notes-settings' };
const evidenceMemoryInspectorService = {
  service: 'evidence-memory-inspector',
};
const networkEgressControlService = { service: 'network-egress-control' };
const attachments = { service: 'attachments' };

function createPreferences({
  personality = 'pragmatic',
  collaborationMode = 'default',
  overrides = {},
}: {
  personality?: UserPreferences['agent']['personality'];
  collaborationMode?: UserPreferences['agent']['collaborationMode'];
  overrides?: FeatureGateOverrides;
} = {}): UserPreferences {
  return {
    agent: { personality, collaborationMode },
    featureGates: { overrides },
  } as UserPreferences;
}

function createPlugin(
  id: string,
  source: PluginDefinition['source'],
): PluginDefinition {
  return {
    id,
    displayName: id,
    description: `${id} description`,
    requiredCredentials: [],
    logoSvg: null,
    skills: [],
    source,
    version: null,
    permissions: [],
  };
}

function createHealthyCohortReport() {
  return {
    sampleCount: 0,
    guardedMemoryRecall: 1,
    guardedMemoryStaleLeakageRate: 0,
    guardedMemoryLatencyP95Ms: 0,
    missingProvenanceAdmissionCount: 0,
    unresolvedContradictionInjectionCount: 0,
  };
}

function createPhaseOptions({
  preferences = createPreferences(),
  controlCenterEnabled = false,
  verbose = false,
}: {
  preferences?: UserPreferences;
  controlCenterEnabled?: boolean;
  verbose?: boolean;
} = {}) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const addListener = vi.fn();
  const removeListener = vi.fn();
  const connectKarton = vi.fn();
  const preferencesService = {
    get: vi.fn(() => preferences),
    addListener,
    removeListener,
    connectKarton,
  };
  const telemetryService = { capture: vi.fn() };
  const pagesService = { service: 'pages' };
  const kartonState = { plugins: [] as PluginDefinition[] };
  const karton = {
    setState: vi.fn((update: (draft: typeof kartonState) => void) => {
      update(kartonState);
    }),
  };
  const store = { service: 'agent-store' };
  const agentCoreSeam = {
    store,
    registry: { service: 'registry' },
    activeAppController: { service: 'active-app-controller' },
    hostAgentStateMutations: { service: 'host-agent-state-mutations' },
    karton,
  };
  const bindAgentStore = vi.fn();
  const agentHostProcessService = {
    canExecuteAgentWorkloads: true,
    bindAgentStore,
  };
  const lazyHostModels = {
    hostModels: { service: 'lazy-host-models' },
    setModelProviderService: vi.fn(),
  };
  const protectedFiles = { service: 'protected-files' };
  const hostPaths = { memoryDir: vi.fn(() => '/memory') };
  const agentCoreHost = {
    paths: hostPaths,
    protectedFiles,
  };
  const protectedMigrationOrder = {
    mark: vi.fn(),
    assertComplete: vi.fn(),
  };
  const getRuntimeStatus = vi.fn();
  const getBrowserPolicy = vi.fn();
  const applyBrowserGrants = vi.fn();
  const controlCenter = controlCenterEnabled
    ? {
        enabled: true as const,
        getRuntimeStatus,
        getBrowserPolicy,
        applyBrowserGrants,
      }
    : { enabled: false as const };
  const guardianEgressStartup = { controlCenter };
  const startupFeatureEnabled = vi.fn(() => false);

  mocks.createAgentCoreSeam.mockReturnValue(agentCoreSeam);
  mocks.agentHostProcessCreate.mockResolvedValue(agentHostProcessService);
  mocks.createLazyBrowserHostModels.mockReturnValue(lazyHostModels);
  mocks.createBrowserAgentHost.mockReturnValue(agentCoreHost);

  const options = {
    logger,
    telemetryService,
    preferencesService,
    pagesService,
    karton,
    hostPaths,
    dataProtection: { service: 'data-protection' },
    protectedFiles,
    protectedMigrationOrder,
    attachments,
    guardianEgressStartup,
    startupFeatureEnabled,
    isolatedAgentRuntimePolicy: {
      defaultEnabled: true,
      rolloutStage: 'canary',
      failureThreshold: 3,
      cooldownMs: 60_000,
    },
    isolatedAgentRuntimeKillSwitchActive: false,
    releaseChannel: 'dev',
    verbose,
  } as unknown as AgentCoreFoundationPhaseOptions;

  return {
    addListener,
    agentCoreHost,
    agentCoreSeam,
    agentHostProcessService,
    applyBrowserGrants,
    bindAgentStore,
    connectKarton,
    getBrowserPolicy,
    getRuntimeStatus,
    karton,
    kartonState,
    lazyHostModels,
    logger,
    options,
    pagesService,
    preferencesService,
    protectedMigrationOrder,
    removeListener,
    startupFeatureEnabled,
    telemetryService,
  };
}

describe('runAgentCoreFoundationPhase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION;

    mocks.resolveFeatureGate.mockImplementation(
      (feature: string, overrides: Record<string, boolean | undefined>) => ({
        enabled: overrides[feature] ?? false,
        source: overrides[feature] === undefined ? 'default' : 'override',
      }),
    );
    mocks.persistenceCreate.mockImplementation(
      async (options: AgentCorePersistenceOptions) => {
        options.onProtectedMigrationStage?.('caches');
        options.onProtectedMigrationStage?.('titles/search');
        return {
          diffHistory: diffHistoryService,
          memoryNotes,
          evidenceMemory: undefined,
          evidenceMemorySummaryScheduler: undefined,
        };
      },
    );
    mocks.memoryNotesSettingsCreate.mockResolvedValue(
      memoryNotesSettingsService,
    );
    mocks.evidenceMemoryInspectorCreate.mockResolvedValue(
      evidenceMemoryInspectorService,
    );
    mocks.networkEgressControlCenterCreate.mockResolvedValue(
      networkEgressControlService,
    );
    mocks.discoverPlugins.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalEvidenceMemoryDisableEnv === undefined) {
      delete process.env.CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION;
    } else {
      process.env.CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION =
        originalEvidenceMemoryDisableEnv;
    }
  });

  it('applies only effective behavior changes and preserves listener identity for teardown', async () => {
    const initialPreferences = createPreferences({
      personality: 'pragmatic',
      collaborationMode: 'plan',
      overrides: { 'collaboration-presets': false },
    });
    const context = createPhaseOptions({ preferences: initialPreferences });

    const result = await runAgentCoreFoundationPhase(context.options);

    expect(context.addListener).toHaveBeenCalledOnce();
    expect(context.addListener).toHaveBeenCalledWith(
      result.agentBehaviorPreferenceListener,
    );
    expect(mocks.createBrowserAgentHost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPersonality: 'pragmatic',
        collaborationMode: 'default',
      }),
    );

    result.agentBehaviorPreferenceListener(
      createPreferences({
        personality: 'pragmatic',
        collaborationMode: 'review',
        overrides: { 'collaboration-presets': false },
      }),
      initialPreferences,
    );
    expect(mocks.applyBrowserAgentBehavior).not.toHaveBeenCalled();

    result.agentBehaviorPreferenceListener(
      createPreferences({
        personality: 'friendly',
        collaborationMode: 'review',
        overrides: { 'collaboration-presets': false },
      }),
      initialPreferences,
    );
    expect(mocks.applyBrowserAgentBehavior).toHaveBeenCalledOnce();
    expect(mocks.applyBrowserAgentBehavior).toHaveBeenCalledWith(
      context.agentCoreHost,
      'friendly',
      'default',
    );

    context.preferencesService.removeListener(
      result.agentBehaviorPreferenceListener,
    );
    expect(context.removeListener).toHaveBeenCalledWith(
      context.addListener.mock.calls[0]?.[0],
    );
  });

  it('keeps bundled plugins first and filters marketplace ID collisions', async () => {
    const bundled = [
      createPlugin('bundled-a', 'bundled'),
      createPlugin('shared-id', 'bundled'),
    ];
    const marketplace = [
      createPlugin('marketplace-a', 'marketplace'),
      createPlugin('shared-id', 'marketplace'),
      createPlugin('marketplace-b', 'marketplace'),
    ];
    mocks.discoverPlugins.mockImplementation(
      async (_directory: string, source: PluginDefinition['source']) =>
        source === 'bundled' ? bundled : marketplace,
    );
    const context = createPhaseOptions({ verbose: true });
    const result = await runAgentCoreFoundationPhase(context.options);

    await result.refreshPluginDefinitions();

    expect(mocks.discoverPlugins.mock.calls).toEqual([
      ['/bundled-plugins', 'bundled'],
      ['/installed-plugins', 'marketplace'],
    ]);
    expect(context.kartonState.plugins).toEqual([
      bundled[0],
      bundled[1],
      marketplace[0],
      marketplace[2],
    ]);
    expect(context.logger.warn).toHaveBeenCalledWith(
      '[Main] Ignoring marketplace plugins that collide with bundled IDs: shared-id',
    );
    expect(context.logger.debug).toHaveBeenCalledWith(
      '[Main] Pushed 2 bundled and 2 marketplace plugins to UI karton',
    );
  });

  it('restores durable canary health only after persistence migrations and asserts completion before dependent services', async () => {
    const order: string[] = [];
    const evidenceMemory = {
      getDogfoodCohortReport: vi.fn(async () => {
        order.push('restore-canary-health');
        return createHealthyCohortReport();
      }),
    };
    mocks.persistenceCreate.mockImplementation(
      async (options: AgentCorePersistenceOptions) => {
        order.push('persistence-create');
        options.onProtectedMigrationStage?.('caches');
        options.onProtectedMigrationStage?.('titles/search');
        return {
          diffHistory: diffHistoryService,
          memoryNotes,
          evidenceMemory,
          evidenceMemorySummaryScheduler: undefined,
        };
      },
    );
    mocks.pendingEditConstructor.mockImplementation(() => {
      order.push('pending-edit');
    });
    mocks.memoryNotesSettingsCreate.mockImplementation(async () => {
      order.push('memory-notes-settings');
      return memoryNotesSettingsService;
    });
    const context = createPhaseOptions();
    context.protectedMigrationOrder.mark.mockImplementation((stage) => {
      order.push(`migration:${stage}`);
    });
    context.protectedMigrationOrder.assertComplete.mockImplementation(() => {
      order.push('migration:assert-complete');
    });
    context.connectKarton.mockImplementation(() => {
      order.push('preferences-connect');
    });

    const result = await runAgentCoreFoundationPhase(context.options);

    expect(order).toEqual([
      'persistence-create',
      'migration:caches',
      'migration:titles/search',
      'restore-canary-health',
      'migration:assert-complete',
      'pending-edit',
      'preferences-connect',
      'memory-notes-settings',
    ]);
    expect(result.persistence).toBe(
      await mocks.persistenceCreate.mock.results[0]?.value,
    );
    expect(result.diffHistoryService).toBe(diffHistoryService);
    expect(mocks.backfillConstructor).toHaveBeenCalledWith(
      {
        memoryDir: '/memory',
        protectedFiles: context.agentCoreHost.protectedFiles,
        evidenceMemory,
      },
      expect.anything(),
    );
  });

  it('fails canary admission closed when durable health restoration fails', async () => {
    const restoreFailure = new Error('cohort database unavailable');
    const evidenceMemory = {
      getDogfoodCohortReport: vi.fn().mockRejectedValue(restoreFailure),
    };
    let admission: ((taskId: string) => boolean) | undefined;
    mocks.persistenceCreate.mockImplementation(
      async (options: AgentCorePersistenceOptions) => {
        admission = options.evidenceMemoryPromptInjectionAdmission;
        expect(admission?.('task-before-restore')).toBe(true);
        options.onProtectedMigrationStage?.('caches');
        options.onProtectedMigrationStage?.('titles/search');
        return {
          diffHistory: diffHistoryService,
          memoryNotes,
          evidenceMemory,
          evidenceMemorySummaryScheduler: undefined,
        };
      },
    );
    const context = createPhaseOptions({
      preferences: createPreferences({
        overrides: { 'evidence-memory-prompt-injection': true },
      }),
    });

    await runAgentCoreFoundationPhase(context.options);

    expect(admission?.('task-after-restore-failure')).toBe(false);
    expect(context.logger.warn).toHaveBeenCalledWith(
      '[EvidenceMemory] Failed to restore canary health; prompt injection remains fail-closed by task admission',
      restoreFailure,
    );
    expect(
      context.protectedMigrationOrder.assertComplete,
    ).toHaveBeenCalledOnce();
  });

  it('propagates an incomplete protected migration sequence before constructing dependents', async () => {
    const migrationFailure = new Error('protected migration incomplete');
    const context = createPhaseOptions();
    context.protectedMigrationOrder.assertComplete.mockImplementation(() => {
      throw migrationFailure;
    });

    await expect(runAgentCoreFoundationPhase(context.options)).rejects.toBe(
      migrationFailure,
    );
    expect(mocks.pendingEditConstructor).not.toHaveBeenCalled();
    expect(context.connectKarton).not.toHaveBeenCalled();
    expect(mocks.networkEgressControlCenterCreate).not.toHaveBeenCalled();
    expect(mocks.memoryNotesSettingsCreate).not.toHaveBeenCalled();
    expect(mocks.evidenceMemoryInspectorCreate).not.toHaveBeenCalled();
  });

  it('continues without a control center when its creation fails', async () => {
    const controlCenterFailure = new Error('control center unavailable');
    mocks.networkEgressControlCenterCreate.mockRejectedValue(
      controlCenterFailure,
    );
    const context = createPhaseOptions({ controlCenterEnabled: true });

    const result = await runAgentCoreFoundationPhase(context.options);

    expect(mocks.networkEgressControlCenterCreate).toHaveBeenCalledWith({
      logger: context.logger,
      karton: context.karton,
      preferences: context.preferencesService,
      auditPath: '/network-policy-audit.jsonl',
      isFeatureEnabled: context.startupFeatureEnabled,
      getRuntimeStatus: context.getRuntimeStatus,
      getBrowserPolicy: context.getBrowserPolicy,
      applyBrowserGrants: context.applyBrowserGrants,
    });
    expect(context.logger.error).toHaveBeenCalledWith(
      '[NetworkEgressControl] Initialization failed; control surface unavailable',
      controlCenterFailure,
    );
    expect(result.networkEgressControlService).toBeNull();
    expect(result.memoryNotesSettingsService).toBe(memoryNotesSettingsService);
    expect(result.evidenceMemoryInspectorService).toBe(
      evidenceMemoryInspectorService,
    );
  });
});
