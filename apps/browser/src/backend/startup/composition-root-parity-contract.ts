import type { DynamicSwarmOrchestrator } from '@clodex/agent-core';
import type { KartonService } from '../services/karton';
import type { AgentManagerService } from '../services/agent-manager';

type StaticCreateServiceName<
  Module,
  ExportName extends keyof Module & string,
> = Module[ExportName] extends {
  create: (...args: never[]) => unknown;
}
  ? ExportName
  : never;

type ConstructorServiceName<
  Module,
  ExportName extends keyof Module & string,
> = Module[ExportName] extends abstract new (
  ...args: never[]
) => unknown
  ? ExportName
  : never;

type CallableExportName<
  Module,
  ExportName extends keyof Module & string,
> = Module[ExportName] extends (...args: never[]) => unknown
  ? ExportName
  : never;

type BrowserUiRuntimeStaticCreateService =
  | StaticCreateServiceName<
      typeof import('../services/history'),
      'HistoryService'
    >
  | StaticCreateServiceName<typeof import('../services/pages'), 'PagesService'>
  | StaticCreateServiceName<
      typeof import('../services/window-layout'),
      'WindowLayoutService'
    >
  | StaticCreateServiceName<
      typeof import('../services/file-tree'),
      'FileTreeService'
    >
  | StaticCreateServiceName<typeof import('../services/git'), 'GitService'>
  | StaticCreateServiceName<
      typeof import('../services/notification'),
      'NotificationService'
    >
  | StaticCreateServiceName<
      typeof import('../services/auto-update'),
      'AutoUpdateService'
    >
  | StaticCreateServiceName<
      typeof import('../services/global-config'),
      'GlobalConfigService'
    >
  | StaticCreateServiceName<
      typeof import('../services/notification-sounds'),
      'NotificationSoundsService'
    >;

type PlatformModelToolboxStaticCreateService =
  | StaticCreateServiceName<typeof import('../services/auth'), 'AuthService'>
  | StaticCreateServiceName<
      typeof import('../services/credentials'),
      'CredentialsService'
    >
  | StaticCreateServiceName<
      typeof import('../services/mcp'),
      'McpRegistryService'
    >
  | StaticCreateServiceName<
      typeof import('../services/plugin-marketplace'),
      'PluginMarketplaceService'
    >
  | StaticCreateServiceName<
      typeof import('../services/toolbox'),
      'ToolboxService'
    >
  | StaticCreateServiceName<
      typeof import('../services/remote-connections'),
      'RemoteConnectionsService'
    >
  | StaticCreateServiceName<
      typeof import('../services/dictation'),
      'DictationService'
    >
  | StaticCreateServiceName<
      typeof import('../services/asset-cache'),
      'AssetCacheService'
    >;

type PlatformModelToolboxConstructorService = ConstructorServiceName<
  typeof import('../agents/model-provider'),
  'ModelProviderService'
>;

type AgentCoreStaticCreateService =
  | StaticCreateServiceName<
      typeof import('../agent-host'),
      'AgentHostProcessService'
    >
  | StaticCreateServiceName<
      typeof import('@clodex/agent-core/persistence'),
      'AgentCorePersistence'
    >;

type AgentCoreFactoryName =
  | CallableExportName<
      typeof import('../services/agent-core-bridge/wiring'),
      'createAgentCoreSeam'
    >
  | CallableExportName<
      typeof import('../services/agent-core-bridge/host'),
      'createBrowserAgentHost'
    >
  | CallableExportName<
      typeof import('../services/agent-core-bridge/wiring'),
      'attachAgentCoreBridge'
    >
  | CallableExportName<
      typeof import('../env-domains'),
      'createBrowserHostEnvironmentSources'
    >
  | CallableExportName<
      typeof import('../env-domains'),
      'registerHostEnvDomainAdapters'
    >;

type CoreEnvAdapterFactoryName =
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createRuntimeContextDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createWorkspaceDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createAgentsMdDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createWorkspaceMdDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createEnabledSkillsDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createMemoryDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createPlansDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createLogsDomainAdapter'
    >
  | CallableExportName<
      typeof import('@clodex/agent-core/env/adapters'),
      'createFileDiffsDomainAdapter'
    >;

type SwarmConstructorService =
  | ConstructorServiceName<
      typeof import('../services/swarm-orchestrator'),
      'BrowserSwarmStore'
    >
  | ConstructorServiceName<
      typeof import('@clodex/agent-core'),
      'DynamicSwarmOrchestrator'
    >;

type AgentManagerRegistrationMethod = Extract<
  keyof AgentManagerService,
  'registerEnvAdapter' | 'setSwarmSubmitHandler'
>;

type CoreEnvAdapterRegistrationMethod = Extract<
  AgentManagerRegistrationMethod,
  'registerEnvAdapter'
>;

type SwarmSubmitRegistrationMethod = Extract<
  AgentManagerRegistrationMethod,
  'setSwarmSubmitHandler'
>;

type DynamicSwarmMethod = Extract<
  keyof DynamicSwarmOrchestrator,
  'execute' | 'on'
>;

type UiProcedureRegistrationMethod = Extract<
  keyof KartonService,
  'registerServerProcedureHandler'
>;

type UiProcedureName = Parameters<
  KartonService['registerServerProcedureHandler']
>[0];

export type CompositionRootContractGroup =
  | 'browserUiRuntime'
  | 'platformModelToolbox'
  | 'agentCore'
  | 'swarm';

export type CompositionInvocationExecution = 'awaited' | 'sync' | 'void';

type StaticCreateConstructionContract = {
  kind: 'construction';
  target:
    | BrowserUiRuntimeStaticCreateService
    | PlatformModelToolboxStaticCreateService
    | AgentCoreStaticCreateService;
  via: 'static-create';
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

type ConstructorConstructionContract = {
  kind: 'construction';
  target: PlatformModelToolboxConstructorService | SwarmConstructorService;
  via: 'constructor';
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

type FactoryContract = {
  kind: 'factory';
  target: AgentCoreFactoryName;
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

type RegisteredFactoryContract = {
  kind: 'registered-factory';
  registration: CoreEnvAdapterRegistrationMethod;
  target: CoreEnvAdapterFactoryName;
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

type MethodRegistrationContract = {
  kind: 'method-registration';
  method: SwarmSubmitRegistrationMethod;
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

type InstanceMethodContract = {
  kind: 'instance-method';
  owner: Extract<SwarmConstructorService, 'DynamicSwarmOrchestrator'>;
  method: DynamicSwarmMethod;
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

type ProcedureRegistrationContract = {
  kind: 'procedure-registration';
  method: UiProcedureRegistrationMethod;
  procedure: UiProcedureName;
  execution: CompositionInvocationExecution;
  expectedCount: 1;
};

export type CompositionRootContractEntry =
  | StaticCreateConstructionContract
  | ConstructorConstructionContract
  | FactoryContract
  | RegisteredFactoryContract
  | MethodRegistrationContract
  | InstanceMethodContract
  | ProcedureRegistrationContract;

/**
 * Phase 2 extraction may relocate these calls from main.ts into startup,
 * wiring, or the swarm runtime, but it must not duplicate or drop them. The
 * AST test normalizes static create calls, direct constructors, factories,
 * and registrations into this typed inventory.
 */
export const COMPOSITION_ROOT_PARITY_CONTRACT = {
  browserUiRuntime: [
    {
      kind: 'construction',
      target: 'HistoryService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'PagesService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'WindowLayoutService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'FileTreeService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'GitService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'NotificationService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'AutoUpdateService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'GlobalConfigService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'NotificationSoundsService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
  ],
  platformModelToolbox: [
    {
      kind: 'construction',
      target: 'AuthService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'CredentialsService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'McpRegistryService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'PluginMarketplaceService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'ToolboxService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'RemoteConnectionsService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'ModelProviderService',
      via: 'constructor',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'DictationService',
      via: 'static-create',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'AssetCacheService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
  ],
  agentCore: [
    {
      kind: 'factory',
      target: 'createAgentCoreSeam',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'AgentHostProcessService',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'factory',
      target: 'createBrowserAgentHost',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'AgentCorePersistence',
      via: 'static-create',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'factory',
      target: 'attachAgentCoreBridge',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'factory',
      target: 'createBrowserHostEnvironmentSources',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createRuntimeContextDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createWorkspaceDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createAgentsMdDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createWorkspaceMdDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createEnabledSkillsDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createMemoryDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createPlansDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createLogsDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'registered-factory',
      registration: 'registerEnvAdapter',
      target: 'createFileDiffsDomainAdapter',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'factory',
      target: 'registerHostEnvDomainAdapters',
      execution: 'sync',
      expectedCount: 1,
    },
  ],
  swarm: [
    {
      kind: 'construction',
      target: 'BrowserSwarmStore',
      via: 'constructor',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'construction',
      target: 'DynamicSwarmOrchestrator',
      via: 'constructor',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'instance-method',
      owner: 'DynamicSwarmOrchestrator',
      method: 'on',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'instance-method',
      owner: 'DynamicSwarmOrchestrator',
      method: 'execute',
      execution: 'awaited',
      expectedCount: 1,
    },
    {
      kind: 'method-registration',
      method: 'setSwarmSubmitHandler',
      execution: 'sync',
      expectedCount: 1,
    },
    {
      kind: 'procedure-registration',
      method: 'registerServerProcedureHandler',
      procedure: 'swarm.run',
      execution: 'sync',
      expectedCount: 1,
    },
  ],
} as const satisfies Record<
  CompositionRootContractGroup,
  readonly CompositionRootContractEntry[]
>;
