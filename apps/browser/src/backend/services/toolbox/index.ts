import type { Logger } from '@/services/logger';
import {
  getInstalledPluginsDir,
  getPluginsPath,
  getRipgrepBasePath,
  getAgentAppsDir,
} from '@/utils/paths';
import { syncDerivedState } from '@/utils/sync-derived-state';
import { MountManagerService } from './services/mount-manager';
import type { FilePickerService } from '@/services/file-picker';
import type { UserExperienceService } from '@/services/experience';
import { SandboxService } from '../sandbox';
import type { BrowserUsePolicyChecker } from '../sandbox';
import {
  ShellService,
  type DetectedShell,
  type GuardianApprovalDeps,
  type ShellCapabilitySecurityDeps,
  type SmartApprovalDeps,
  executeShellCommand as executeShellCommandTool,
  createShellSession as createShellSessionTool,
} from '@clodex/agent-shell';
import { createKartonShellStreamSink } from './services/shell/karton-stream-sink';
import { ClodexMcpService } from './services/clodex-mcp';
import { isClodexCloudSelected } from '@shared/provider-consent';
import type { McpRegistryService } from '../mcp';
import { TrustedMcpApprovalBroker } from '../mcp/approval-broker';
import type {
  McpElicitationRequest,
  McpElicitationResult,
} from '@clodex/mcp-runtime';
import { createRegistryMcpTools } from '../mcp/tools';
import { classifyShellCommand } from './tools/shell/smart-approval';
import { TerminalService } from '@/services/terminal';
import {
  FULL_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  type MountDescriptor,
} from '../sandbox/ipc';
import {
  DEFAULT_TOOL_APPROVAL_MODE,
  type WorkspaceAgentSettings,
  type ToolApprovalMode,
} from '@shared/karton-contracts/ui/shared-types';
import type { Attachment } from '@shared/karton-contracts/ui/agent/metadata';
import type { KartonService } from '@/services/karton';
import { DisposableService } from '@/services/disposable';
import type { DiffHistoryService } from '@clodex/agent-core/diff-history';
import type { WindowLayoutService } from '@/services/window-layout';
import type { AuthService } from '@/services/auth';
import type { TelemetryService } from '@/services/telemetry';
import type { ModelProviderService } from '@/agents/model-provider';
import type { CredentialsService } from '@/services/credentials';
import type { PreferencesService } from '@/services/preferences';
import type { GitService } from '@/services/git';
import type { HostAgentStateMutations } from '@/services/agent-core-bridge/state/agent-instances';
import { resolveNewAgentWorkspaceMountPath } from '@/services/agent-manager/workspace-mount-normalization';
import type { CredentialTypeId } from '@shared/credential-types';
import { createAuthenticatedClient } from './utils/create-authenticated-client';
import { createFileDiffHandler } from './utils/sandbox-callbacks';
import type { AttachmentsService } from '@clodex/agent-core/attachments';
import type { MemoryNotesService } from '@clodex/agent-core/memory-notes';
import {
  CodeGraphCliEvidenceProvider,
  type EvidenceMemoryCodeEvidenceProvider,
} from '@clodex/agent-core/evidence-memory';
import type { ProtectedFileStorage } from '@clodex/agent-core/host';
import type { RemoteConnectionsService } from '@/services/remote-connections';
import { getBrowserHostPaths } from '@/services/agent-core-bridge/host-paths';
import {
  getDataRoot,
  getLogsDir,
  getMemoryDir,
  getPlansDir,
  getAgentShellLogsDir,
} from '@/utils/paths';
import { existsSync, mkdirSync, truncateSync } from 'node:fs';
import type { ApiClient } from '@clodex/api-client';
import { getLintingDiagnostics as getLintingDiagnosticsTool } from './tools/file-modification/get-linting-diagnostics';
import { listLibraryDocs as listLibraryDocsTool } from './tools/research/list-library-docs';
import { searchInLibraryDocs as searchInLibraryDocsTool } from './tools/research/search-in-library-docs';
import {
  makeUniversalTools,
  type AgentManagerToolboxPort,
  type AgentStore,
  type MountPermission as CoreMountPermission,
  type PendingEditService,
  ProjectIndexService,
} from '@clodex/agent-core';
import type { BaseAgentToolboxView } from '@clodex/agent-core/agents';
import { executeSandboxJs as executeSandboxJsTool } from './tools/browser/execute-sandbox-js';
import { readConsoleLogs as readConsoleLogsTool } from './tools/browser/read-console-logs';
import { runOpenManus as runOpenManusTool } from './tools/agents/run-openmanus';
import {
  askUserQuestions as askUserQuestionsTool,
  advanceOrCompleteQuestion,
  cancelQuestion,
  goBackQuestion,
  cleanupQuestionsForAgent,
  requestStructuredUserQuestions,
} from './tools/user-interaction/ask-user-questions';
import { toMcpElicitationQuestion } from './tools/user-interaction/mcp-elicitation';
import type { Tool } from 'ai';
import type { MountedClientRuntimes } from './utils';
import path from 'node:path';
import type { QuestionAnswerValue } from '@shared/karton-contracts/ui/agent/tools/types';
import type { TabState } from '@shared/karton-contracts/ui';
import type { BrowserSnapshot, WorkspaceSnapshot } from './types';
import type { MountPermission } from '@shared/karton-contracts/ui/agent/metadata';
import type { WorkspaceInfo } from '@/agents/shared/prompts/utils/workspace-info';
import { getWorkspaceInfo as getWorkspaceInfoUtil } from '@/agents/shared/prompts/utils/workspace-info';
import { readAgentsMd } from '@/agents/shared/prompts/utils/read-agents-md';
import {
  readWorkspaceMd,
  WORKSPACE_MD_DIR,
  WORKSPACE_MD_FILENAME,
} from '@/agents/shared/prompts/utils/read-workspace-md';
import type { ContextFilesResult } from '@shared/karton-contracts/pages-api/types';
import {
  getSkills,
  discoverSkills,
} from '@/agents/shared/prompts/utils/get-skills';
import type { SkillDefinition } from '@shared/skills';
import { toSkillDefinitionUI } from '@shared/skills';
import { PLANS_PREFIX } from '@clodex/agent-core/plans';
import { readPlans } from '@clodex/agent-core/plans/read';
import { LOGS_PREFIX } from '@clodex/agent-core/logs';
import { readLogChannels } from '@clodex/agent-core/logs/read';
import { LogIngestService } from '../log-ingest';
import { ClientRuntimeNode } from '@clodex/agent-runtime-node';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  getGlobalSkillsMounts,
  getEnabledGlobalSkillsMounts,
} from './global-skills';
import { resolveFeatureGate } from '@shared/feature-gates';
import { makeMemoryNoteTools, type MemoryToolName } from './tools/memory';
import {
  makeDesktopAutomationTools,
  type DesktopAutomationToolName,
} from './tools/desktop-automation';
import type { GuardianPolicyChecker } from '@shared/guardian';
import type {
  NetworkEgressRequest,
  NetworkPolicyDecision,
  NetworkPolicyEvaluator,
} from '@shared/network-policy';
import { createShellGuardianRequest } from '@/services/guardian/requests';
import type { DesktopAutomationService } from '@/services/agent-os/desktop-automation';
export { getGlobalSkillsMounts, getEnabledGlobalSkillsMounts };

type MountedPrefix = string;
type MountedPath = string;

export class ToolboxService
  extends DisposableService
  implements BaseAgentToolboxView, AgentManagerToolboxPort
{
  private readonly logger: Logger;
  private readonly uiKarton: KartonService;
  private readonly diffHistoryService: DiffHistoryService;
  private readonly pendingEditService: PendingEditService;
  private readonly projectIndexService = new ProjectIndexService();
  private readonly windowLayoutService: WindowLayoutService;
  private readonly authService: AuthService;
  private readonly telemetryService: TelemetryService;
  private readonly filePickerService: FilePickerService;
  private readonly userExperienceService: UserExperienceService;
  private readonly credentialsService: CredentialsService;
  private readonly gitService: GitService;
  private readonly detectedShell: DetectedShell | null;
  private readonly resolvedEnvPromise: Promise<Record<string, string> | null>;
  private readonly agentStore: AgentStore;
  private readonly hostAgentStateMutations: HostAgentStateMutations;
  private readonly attachments: AttachmentsService;
  private readonly memoryNotesService: MemoryNotesService | undefined;
  private readonly mcpRegistryService: McpRegistryService;
  private readonly mcpApprovalBroker: TrustedMcpApprovalBroker;
  private readonly shellCapabilitySecurity: ShellCapabilitySecurityDeps;

  private sandboxService: SandboxService | null = null;
  private shellService: ShellService | null = null;
  private readonly protectedFiles: ProtectedFileStorage | undefined;
  private terminalService: TerminalService | null = null;
  private remoteConnectionsService: RemoteConnectionsService | null = null;
  private desktopAutomationService: DesktopAutomationService | null = null;
  private readonly clodexMcpService: ClodexMcpService;
  /**
   * Injected lazily via `setModelProviderService` because `ModelProviderService`
   * is constructed later in `main.ts` (after `preferencesService`) and has a
   * forward dependency on the toolbox via the agent manager. Used only by
   * smart-approval classification, which degrades gracefully if unset.
   */
  private modelProviderService: ModelProviderService | null = null;
  private guardianPolicyChecker: GuardianPolicyChecker | null = null;
  private networkPolicyEvaluator: NetworkPolicyEvaluator | null = null;
  private pluginsRuntime: ClientRuntimeNode | null = null;
  private marketplacePluginsRuntime: ClientRuntimeNode | null = null;
  private globalSkillsRuntimes = new Map<string, ClientRuntimeNode>();
  private appsRuntimes = new Map<string, ClientRuntimeNode>();

  private mountManagerService: MountManagerService | null = null;
  private readonly evidenceMemoryCodeProviders = new Map<
    string,
    CodeGraphCliEvidenceProvider
  >();
  private readonly preferencesService: PreferencesService;
  private unsubPreferenceSync: (() => void) | null = null;
  private notificationEventHandler:
    | ((
        event: 'done' | 'question' | 'error',
        agentId: string,
      ) => void | Promise<void>)
    | null = null;

  /** Cached API client - recreated when auth changes */
  private apiClient: ApiClient | null = null;

  public get globalDataPath(): string {
    return getDataRoot();
  }

  /**
   * Returns the mounted runtimes for the agent, including the
   * read-only plugins runtime, the per-agent apps runtime,
   * and the per-agent attachment blob runtime.
   */
  private getAllMountedRuntimes(
    agentInstanceId: string,
  ): MountedClientRuntimes | undefined {
    const runtimes =
      this.mountManagerService?.getMountedRuntimes(agentInstanceId);
    if (!runtimes) return undefined;
    if (this.pluginsRuntime) runtimes.set('plugins', this.pluginsRuntime);
    if (this.marketplacePluginsRuntime) {
      runtimes.set('marketplace-plugins', this.marketplacePluginsRuntime);
    }
    for (const mount of getEnabledGlobalSkillsMounts(
      this.uiKarton.state.preferences?.agent?.enabledGlobalSkillDirs ?? [],
    )) {
      const rt = this.getOrCreateGlobalSkillsRuntime(
        mount.prefix,
        mount.absolutePath,
      );
      if (rt) runtimes.set(mount.prefix, rt);
    }
    runtimes.set('apps', this.getOrCreateAppsRuntime(agentInstanceId));
    runtimes.set(PLANS_PREFIX, this.getOrCreatePlansRuntime());
    runtimes.set(LOGS_PREFIX, this.getOrCreateLogsRuntime());
    // Protected mounts are intentionally not backed by raw filesystem
    // runtimes. Native universal tools route them through ProtectedFileStorage;
    // exposing these directories here would let ripgrep/runtime-node consume
    // ciphertext and internal append segments directly.
    return runtimes;
  }

  private hasMountedPaths(agentInstanceId: string): boolean {
    return this.getMountedPathsForAgent(agentInstanceId).size > 0;
  }

  private getUniversalTool(
    toolName: string,
    agentInstanceId: string,
  ): Tool | null {
    if (!this.hasMountedPaths(agentInstanceId)) return null;
    const tools = makeUniversalTools({
      agentInstanceId,
      hostPaths: getBrowserHostPaths(),
      mountManager: this.mountManagerService,
      staticMounts: getEnabledGlobalSkillsMounts(
        this.uiKarton.state.preferences?.agent?.enabledGlobalSkillDirs ?? [],
      ).map((mount) => ({
        prefix: mount.prefix,
        absolutePath: mount.absolutePath,
        permissions: ['read'] satisfies readonly CoreMountPermission[],
      })),
      diffHistoryService: this.diffHistoryService,
      pendingEditService: this.pendingEditService,
      projectIndexService: this.projectIndexService,
      logger: this.logger,
      protectedFiles: this.protectedFiles,
      rgBinaryBasePath: getRipgrepBasePath(),
      mutations: {
        onTextFileWritten: (
          agentId: string,
          absolutePath: string,
          content: string,
        ) =>
          this.mountManagerService?.syncFileWithLsp(
            agentId,
            absolutePath,
            content,
          ),
        onTextFileClosed: (agentId: string, absolutePath: string) =>
          this.mountManagerService?.syncFileCloseWithLsp(agentId, absolutePath),
      },
    });
    return (tools as Record<string, Tool | undefined>)[toolName] ?? null;
  }

  /** Builtin commands discovered at startup — stored for refresh merging. */
  private builtinSkills: SkillDefinition[] = [];

  /** Monotonically increasing counter to discard stale `rebuildSkillsList` results. */
  private skillsRebuildGeneration = 0;
  /** Counter for stale `rebuildGlobalSkillsIndex` results. */
  private globalSkillsRebuildGeneration = 0;

  private plansRuntime: ClientRuntimeNode | null = null;
  private plansWatcher: FSWatcher | null = null;
  private plansWatcherDebounce: ReturnType<typeof setTimeout> | null = null;

  private logsRuntime: ClientRuntimeNode | null = null;
  private logsWatcher: FSWatcher | null = null;
  private logsWatcherDebounce: ReturnType<typeof setTimeout> | null = null;
  private logIngestService: LogIngestService | null = null;

  private globalSkillsWatchers: FSWatcher[] = [];
  private globalSkillsWatcherDebounce: ReturnType<typeof setTimeout> | null =
    null;

  private getOrCreatePlansRuntime(): ClientRuntimeNode {
    if (this.plansRuntime) return this.plansRuntime;
    const plansDir = getPlansDir();
    mkdirSync(plansDir, { recursive: true });
    this.plansRuntime = new ClientRuntimeNode({
      workingDirectory: plansDir,
      rgBinaryBasePath: getRipgrepBasePath(),
    });
    return this.plansRuntime;
  }

  private getOrCreateLogsRuntime(): ClientRuntimeNode {
    if (this.logsRuntime) return this.logsRuntime;
    const logsDir = getLogsDir();
    mkdirSync(logsDir, { recursive: true });
    this.logsRuntime = new ClientRuntimeNode({
      workingDirectory: logsDir,
      rgBinaryBasePath: getRipgrepBasePath(),
    });
    return this.logsRuntime;
  }

  private getOrCreateGlobalSkillsRuntime(
    prefix: string,
    absolutePath: string,
  ): ClientRuntimeNode | null {
    const existing = this.globalSkillsRuntimes.get(prefix);
    if (existing) return existing;
    if (!existsSync(absolutePath)) return null;
    const runtime = new ClientRuntimeNode({
      workingDirectory: absolutePath,
      rgBinaryBasePath: getRipgrepBasePath(),
    });
    this.globalSkillsRuntimes.set(prefix, runtime);
    return runtime;
  }

  private getOrCreateAppsRuntime(agentInstanceId: string): ClientRuntimeNode {
    const existing = this.appsRuntimes.get(agentInstanceId);
    if (existing) return existing;
    const appsDir = getAgentAppsDir(agentInstanceId);
    mkdirSync(appsDir, { recursive: true });
    const runtime = new ClientRuntimeNode({
      workingDirectory: appsDir,
      rgBinaryBasePath: getRipgrepBasePath(),
    });
    this.appsRuntimes.set(agentInstanceId, runtime);
    return runtime;
  }

  /**
   * Narrow accessor used by `DiffHistoryService` to resolve which
   * filepaths belong to a mounted workspace (for the gitignore check).
   * Returns an empty set before the mount manager has finished its
   * async initialization — callers must tolerate that window.
   */
  public getAllMountedPaths(): Set<string> {
    return this.mountManagerService?.getAllMountedPaths() ?? new Set();
  }

  /**
   * Wire the model-provider service after construction. Needed because the
   * service is built after `ToolboxService` in `main.ts`. Safe to call once.
   */
  public setModelProviderService(service: ModelProviderService): void {
    this.modelProviderService = service;
  }

  /**
   * Inject the saved remote-connections service after both services finish
   * initialization. Its tools are merged with the dynamic Clodex MCP tools.
   */
  public setRemoteConnectionsService(
    service: RemoteConnectionsService | null,
  ): void {
    this.remoteConnectionsService = service;
  }

  public setDesktopAutomationService(
    service: DesktopAutomationService | null,
  ): void {
    this.desktopAutomationService = service;
  }

  public async createUserTerminal(): Promise<string | null> {
    return (await this.terminalService?.createTerminal()) ?? null;
  }

  public writeUserTerminalInput(terminalId: string, data: string): void {
    this.terminalService?.writeTerminalInput(terminalId, data);
  }

  /**
   * Injects the read-only Guardian assessor after Agent OS initialization.
   * The checker returns `null` while its feature gate is disabled.
   */
  public setGuardianPolicyChecker(checker: GuardianPolicyChecker | null): void {
    this.guardianPolicyChecker = checker;
    this.mcpRegistryService.setGuardianPolicyChecker(checker);
  }

  /**
   * Installs the trusted destination-policy boundary. A null evaluator means
   * the experimental gate is disabled and preserves the existing runtime.
   */
  public setNetworkPolicyEvaluator(
    evaluator: NetworkPolicyEvaluator | null,
  ): void {
    this.networkPolicyEvaluator = evaluator;
  }

  /**
   * Narrow seam for future proxy and managed-runtime adapters. Callers cannot
   * supply policy objects; policy selection remains owned by the evaluator.
   */
  public evaluateNetworkEgress(
    request: NetworkEgressRequest,
  ): Promise<NetworkPolicyDecision | null> {
    return (
      this.networkPolicyEvaluator?.evaluate(request) ?? Promise.resolve(null)
    );
  }

  public setNotificationEventHandler(
    handler: (
      event: 'done' | 'question' | 'error',
      agentId: string,
    ) => void | Promise<void>,
  ): void {
    this.notificationEventHandler = handler;
  }

  public setWorkspaceLastUsedAtResolver(
    resolver: (workspacePaths: string[]) => Promise<Map<string, number>>,
  ): void {
    this.mountManagerService?.setWorkspaceLastUsedAtResolver(resolver);
  }

  public scanWorkspaceGitCleanupCandidatesOnStartup(): Promise<void> {
    return (
      this.mountManagerService?.scanWorkspaceGitCleanupCandidatesOnStartup() ??
      Promise.resolve()
    );
  }

  /**
   * Snapshot of shell sessions associated with `agentInstanceId`.
   *
   * Narrow accessor used by the host `shells` domain adapter
   * (see `apps/browser/src/backend/env-domains/shells-domain-adapter.ts`). Returns
   * the canonical empty `{ sessions: [] }` when the shell service has
   * not been initialized (defensive — production startup always
   * mounts it).
   */
  public getShellSnapshot(
    agentInstanceId: string,
  ): import('@shared/env-domain-schemas').ShellSnapshot {
    return (
      this.shellService?.getShellSnapshot(agentInstanceId) ?? { sessions: [] }
    );
  }

  /**
   * Current sandbox session id bound to `agentInstanceId`, or `null`
   * when no sandbox invocation has happened yet. Used by the host
   * `sandbox` environment provider.
   */
  public getSandboxSessionId(agentInstanceId: string): string | null {
    return this.sandboxService?.getSandboxSessionId(agentInstanceId) ?? null;
  }

  public getSandboxService(): SandboxService | null {
    return this.sandboxService;
  }

  /**
   * Endpoint descriptor of the local log-ingest HTTP service, or
   * `null` when the service is not running. Used by the host
   * `logIngest` environment provider.
   */
  public getLogIngestSnapshot(): import('@shared/env-domain-schemas').LogIngestSnapshot {
    if (!this.logIngestService) return null;
    return {
      port: this.logIngestService.getPort(),
      token: this.logIngestService.getToken(),
    };
  }

  /**
   * Forwards the `AgentCoreBridge` active-app controller (Phase 1d) to the
   * owning `SandboxService`. Called once from `main.ts` after
   * `createAgentCoreBridge` returns. The sandbox is already initialized by
   * the time this is invoked because `ToolboxService.create` resolves
   * before `main.ts` constructs the bridge.
   */
  public setActiveAppController(
    controller: import('../agent-core-bridge/state/toolbox-active-app').ActiveAppStateController,
  ): void {
    this.sandboxService?.setActiveAppController(controller);
  }

  public setBrowserUsePolicyChecker(
    checker: BrowserUsePolicyChecker | null,
  ): void {
    this.sandboxService?.setBrowserUsePolicyChecker(checker);
  }

  /**
   * Expose the package-owned `MountManager` so `main.ts` can wire it
   * into the core env-state {@link DomainAdapter}s (workspace,
   * agentsMd, workspaceMd). Returns `null` when the mount manager has
   * not yet been initialized (defensive — `ToolboxService.create`
   * always initializes it).
   */
  public getMountManager():
    | import('@clodex/agent-core/mount-manager').MountManager
    | null {
    return this.mountManagerService?.getCoreMountManager() ?? null;
  }

  private constructor(
    logger: Logger,
    uiKarton: KartonService,
    diffHistoryService: DiffHistoryService,
    pendingEditService: PendingEditService,
    windowLayoutService: WindowLayoutService,
    authService: AuthService,
    telemetryService: TelemetryService,
    filePickerService: FilePickerService,
    userExperienceService: UserExperienceService,
    credentialsService: CredentialsService,
    mcpRegistryService: McpRegistryService,
    gitService: GitService,
    preferencesService: PreferencesService,
    detectedShell: DetectedShell | null,
    resolvedEnvPromise: Promise<Record<string, string> | null>,
    agentStore: AgentStore,
    hostAgentStateMutations: HostAgentStateMutations,
    attachments: AttachmentsService,
    memoryNotesService: MemoryNotesService | undefined,
    shellCapabilitySecurity: ShellCapabilitySecurityDeps,
    protectedFiles?: ProtectedFileStorage,
  ) {
    super();
    this.logger = logger;
    this.uiKarton = uiKarton;
    this.diffHistoryService = diffHistoryService;
    this.pendingEditService = pendingEditService;
    this.windowLayoutService = windowLayoutService;
    this.authService = authService;
    this.telemetryService = telemetryService;
    this.filePickerService = filePickerService;
    this.userExperienceService = userExperienceService;
    this.credentialsService = credentialsService;
    this.mcpRegistryService = mcpRegistryService;
    this.mcpApprovalBroker = new TrustedMcpApprovalBroker(agentStore);
    this.gitService = gitService;
    this.preferencesService = preferencesService;
    this.clodexMcpService = new ClodexMcpService({
      authService,
      logger,
      gatewayUrl: process.env.CLODEX_MCP_GATEWAY_URL,
      isEnabled: () =>
        isClodexCloudSelected(
          this.preferencesService.get(),
          Boolean(this.authService.accessToken),
        ),
      recordPendingApproval: (agentInstanceId, toolCallId, explanation) => {
        this.hostAgentStateMutations.recordPendingApproval(
          agentInstanceId,
          toolCallId,
          explanation,
        );
      },
      assessGuardian: async (request) =>
        (await this.guardianPolicyChecker?.(request)) ?? null,
      stageApproval: (input) => this.mcpApprovalBroker.stage(input),
      claimApprovalAuthority: (input) => this.mcpApprovalBroker.claim(input),
    });
    this.detectedShell = detectedShell;
    this.resolvedEnvPromise = resolvedEnvPromise;
    this.agentStore = agentStore;
    this.hostAgentStateMutations = hostAgentStateMutations;
    this.attachments = attachments;
    this.memoryNotesService = memoryNotesService;
    this.protectedFiles = protectedFiles;
    this.shellCapabilitySecurity = shellCapabilitySecurity;
  }

  public static async create(
    logger: Logger,
    uiKarton: KartonService,
    diffHistoryService: DiffHistoryService,
    pendingEditService: PendingEditService,
    windowLayoutService: WindowLayoutService,
    authService: AuthService,
    telemetryService: TelemetryService,
    filePickerService: FilePickerService,
    userExperienceService: UserExperienceService,
    credentialsService: CredentialsService,
    mcpRegistryService: McpRegistryService,
    gitService: GitService,
    preferencesService: PreferencesService,
    detectedShell: DetectedShell | null,
    resolvedEnvPromise: Promise<Record<string, string> | null>,
    agentStore: AgentStore,
    hostAgentStateMutations: HostAgentStateMutations,
    attachments: AttachmentsService,
    memoryNotesService: MemoryNotesService | undefined,
    shellCapabilitySecurity: ShellCapabilitySecurityDeps,
    protectedFiles?: ProtectedFileStorage,
  ): Promise<ToolboxService> {
    const instance = new ToolboxService(
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
      memoryNotesService,
      shellCapabilitySecurity,
      protectedFiles,
    );
    await instance.initialize();
    return instance;
  }

  private report(
    error: Error,
    operation: string,
    extra?: Record<string, unknown>,
  ) {
    this.telemetryService.captureException(error, {
      service: 'toolbox',
      operation,
      ...extra,
    });
  }

  private isMemoryNotesEnabled(): boolean {
    return resolveFeatureGate(
      'memory-notes',
      this.preferencesService.get().featureGates.overrides,
      __APP_RELEASE_CHANNEL__,
    ).enabled;
  }

  public async getEvidenceMemoryRepositoryRevision(
    agentInstanceId: string,
  ): Promise<string | null> {
    const mounts = [...this.getShellMountedPathsForAgent(agentInstanceId)];
    if (mounts.length !== 1) return null;
    const workspacePath = mounts[0]?.[1];
    if (!workspacePath) return null;
    const [worktree, status] = await Promise.all([
      this.gitService.getWorktreeInfo(workspacePath),
      this.gitService.getWorktreeStatus(workspacePath),
    ]);
    if (!worktree?.headSha || !status || status.dirty) return null;
    return worktree.headSha;
  }

  public async getEvidenceMemoryCodeEvidenceProvider(
    agentInstanceId: string,
    repositoryRevision: string | null,
  ): Promise<EvidenceMemoryCodeEvidenceProvider | undefined> {
    if (!repositoryRevision) return undefined;
    const mounts = [...this.getShellMountedPathsForAgent(agentInstanceId)];
    if (mounts.length !== 1) return undefined;
    const workspaceRoot = mounts[0]?.[1];
    if (!workspaceRoot || !existsSync(path.join(workspaceRoot, '.codegraph'))) {
      return undefined;
    }
    const providerPrefix = `${agentInstanceId} ${workspaceRoot} `;
    const providerKey = `${providerPrefix}${repositoryRevision}`;
    const existing = this.evidenceMemoryCodeProviders.get(providerKey);
    if (existing) return existing;
    for (const key of this.evidenceMemoryCodeProviders.keys()) {
      if (key.startsWith(providerPrefix)) {
        this.evidenceMemoryCodeProviders.delete(key);
      }
    }
    const provider = new CodeGraphCliEvidenceProvider({
      workspaceRoot,
      commandTimeoutMs: 3_000,
      getRepositoryRevision: async () => repositoryRevision,
    });
    this.evidenceMemoryCodeProviders.set(providerKey, provider);
    return provider;
  }

  private getMemoryNoteTool(
    toolName: MemoryToolName,
    agentInstanceId: string,
  ): Tool | null {
    if (!this.isMemoryNotesEnabled() || !this.memoryNotesService) return null;

    const tools = makeMemoryNoteTools({
      service: this.memoryNotesService,
      agentInstanceId,
      getWorkspaceMounts: () =>
        (
          this.mountManagerService?.getMountedPathsWithRuntimes(
            agentInstanceId,
          ) ?? []
        ).map((mount) => ({
          prefix: mount.prefix,
          absolutePath: mount.path,
        })),
      // Recheck at execution time in case the preview gate was disabled
      // after the agent's toolset was assembled.
      isEnabled: () => this.isMemoryNotesEnabled(),
    });
    return tools[toolName];
  }

  private isDesktopAutomationEnabled(): boolean {
    return resolveFeatureGate(
      'desktop-automation-macos-preview',
      this.preferencesService.get().featureGates.overrides,
      __APP_RELEASE_CHANNEL__,
    ).enabled;
  }

  private getDesktopAutomationTool(
    toolName: DesktopAutomationToolName,
    agentInstanceId: string,
  ): Tool | null {
    if (!this.isDesktopAutomationEnabled() || !this.desktopAutomationService) {
      return null;
    }
    return makeDesktopAutomationTools({
      service: this.desktopAutomationService,
      attachments: this.attachments,
      agentInstanceId,
      isEnabled: () => this.isDesktopAutomationEnabled(),
    })[toolName];
  }

  public async getTool(
    tool: string,
    agentInstanceId: string,
  ): Promise<Tool | null>;

  /**
   * Used by the agent to get a tool that can be forwarded to the AI-SDK
   *
   * @param tool - the name of the tool that should be returned
   * @param agentInstanceId - the id of the agent instance that is requesting the tool.
   *                            Should be used to link the following tool calls to the given agent instance.
   *
   * @returns the tool that can be forwarded to the AI-SDK
   *
   * @note In order to get the specific tool call ID, the tool's `execute` function should
   *        look at the `options` parameter which includes the `toolCallId` as a property.
   *
   * @note Based on the here provided `agentInstanceId` and the `toolCallId` provided at time of tool execution,
   *        the toolbox can clearly match a tool call to it's related agent and other tool calls made by the agent.
   */
  public async getTool(
    tool: string,
    agentInstanceId: string,
  ): Promise<Tool | null> {
    const mountedRuntimes = this.getAllMountedRuntimes(agentInstanceId);
    if (!mountedRuntimes) return null;

    const mountedLspServices =
      this.mountManagerService?.getMountedLspServices(agentInstanceId);
    if (!mountedLspServices) return null;

    const getToolApprovalMode = (): ToolApprovalMode =>
      this.uiKarton.state.agents.instances[agentInstanceId]?.state
        .toolApprovalMode ?? DEFAULT_TOOL_APPROVAL_MODE;

    switch (tool) {
      case 'write':
      case 'read':
      case 'getFileSkeleton':
      case 'getSymbolBody':
      case 'searchProjectSymbols':
      case 'ls':
      case 'delete':
      case 'glob':
      case 'grepSearch':
      case 'multiEdit':
      case 'mkdir':
      case 'copy':
        return this.getUniversalTool(tool, agentInstanceId);
      case 'addMemory':
      case 'listMemories':
      case 'readMemory':
      case 'searchMemories':
      case 'deleteMemory':
        return this.getMemoryNoteTool(tool, agentInstanceId);
      case 'inspectDesktop':
      case 'captureDesktop':
      case 'pressDesktopElement':
        return this.getDesktopAutomationTool(tool, agentInstanceId);
      case 'listLibraryDocs':
        if (!this.apiClient) return null;
        return listLibraryDocsTool(this.apiClient);
      case 'searchInLibraryDocs':
        if (!this.apiClient) return null;
        return searchInLibraryDocsTool(this.apiClient);
      case 'getLintingDiagnostics': {
        if (!mountedLspServices) return null;
        return getLintingDiagnosticsTool(mountedLspServices);
      }
      case 'executeSandboxJs':
        if (!this.windowLayoutService) return null;
        return executeSandboxJsTool(this.sandboxService!, agentInstanceId, {
          assess: async (request) =>
            (await this.guardianPolicyChecker?.(request)) ?? null,
          recordPendingApproval: (toolCallId, explanation) => {
            this.hostAgentStateMutations.recordPendingApproval(
              agentInstanceId,
              toolCallId,
              explanation,
            );
          },
        });
      case 'readConsoleLogs':
        if (!this.windowLayoutService) return null;
        return readConsoleLogsTool(this.windowLayoutService, agentInstanceId);
      case 'askUserQuestions':
        return askUserQuestionsTool(
          this.uiKarton,
          this.hostAgentStateMutations,
          agentInstanceId,
          (id) => {
            void Promise.resolve(
              this.notificationEventHandler?.('question', id),
            ).catch((error) => {
              this.logger.debug(
                `[ToolboxService] Notification event failed: ${(error as Error).message}`,
              );
            });
          },
        );
      case 'runOpenManus':
        return runOpenManusTool({
          getWorkspaceMounts: () =>
            this.getWorkspaceSnapshot(agentInstanceId).mounts.map(
              ({ prefix }) => ({ prefix }),
            ),
        });
      case 'createShellSession': {
        if (!this.shellService?.isAvailable()) return null;
        return createShellSessionTool(
          this.shellService,
          agentInstanceId,
          () => this.getShellMountedPathsForAgent(agentInstanceId),
          this.shellCapabilitySecurity,
        );
      }
      case 'executeShellCommand': {
        if (!this.shellService?.isAvailable()) return null;
        const smartApproval: SmartApprovalDeps = {
          // The classifier lives in the browser host (model provider +
          // telemetry); the package only calls `classify`. Use a thin
          // forwarding shim so a late `setModelProviderService` call is
          // still honored (closure captures `this`, not the possibly-null
          // field at case-match time).
          classify: (input) =>
            classifyShellCommand(
              input,
              {
                getModelWithOptionsAsync: (modelId, traceId, props) => {
                  if (!this.modelProviderService) {
                    throw new Error(
                      'ModelProviderService not yet initialized; smart-approval classification unavailable.',
                    );
                  }
                  return this.modelProviderService.getModelWithOptionsAsync(
                    modelId,
                    traceId,
                    props,
                  );
                },
              },
              agentInstanceId,
              this.telemetryService,
            ),
          recordPendingApproval: (toolCallId, explanation) => {
            // Legacy field name: this is smart-approval explanation metadata,
            // not the canonical approval-pending state. The canonical state
            // is the assistant tool part with state === 'approval-requested'.
            this.hostAgentStateMutations.recordPendingApproval(
              agentInstanceId,
              toolCallId,
              explanation,
            );
          },
        };
        const guardianApproval: GuardianApprovalDeps = {
          assess: async (input) => {
            const assessment = await this.guardianPolicyChecker?.(
              createShellGuardianRequest(input),
            );
            if (!assessment) return null;
            return {
              decision: assessment.decision,
              risk: assessment.risk,
              irreversible: assessment.irreversible,
              explanation: assessment.explanation,
            };
          },
          recordPendingApproval: (toolCallId, explanation) => {
            this.hostAgentStateMutations.recordPendingApproval(
              agentInstanceId,
              toolCallId,
              explanation,
            );
          },
        };
        return executeShellCommandTool(
          this.shellService,
          agentInstanceId,
          getToolApprovalMode,
          () => this.getShellMountedPathsForAgent(agentInstanceId),
          smartApproval,
          guardianApproval,
          this.shellCapabilitySecurity,
        );
      }
      default:
        this.logger.error('[ToolboxService] Tool not found', { tool });
        return null;
    }
  }

  public async getClodexMcpTools(
    agentInstanceId: string,
  ): Promise<Record<string, Tool>> {
    const [cloudTools, registryTools, remoteTools] = await Promise.all([
      this.clodexMcpService.getTools(agentInstanceId),
      createRegistryMcpTools({
        registry: this.mcpRegistryService,
        agentInstanceId,
        assessGuardian: async (request) =>
          (await this.guardianPolicyChecker?.(request)) ?? null,
        recordPendingApproval: (toolCallId, explanation) => {
          this.hostAgentStateMutations.recordPendingApproval(
            agentInstanceId,
            toolCallId,
            explanation,
          );
        },
        stageApproval: (input) => this.mcpApprovalBroker.stage(input),
        claimApprovalAuthority: (input) => this.mcpApprovalBroker.claim(input),
      }),
      Promise.resolve(
        this.remoteConnectionsService?.getAgentTools({
          recordPendingApproval: (toolCallId, explanation) => {
            this.hostAgentStateMutations.recordPendingApproval(
              agentInstanceId,
              toolCallId,
              explanation,
            );
          },
        }) ?? {},
      ),
    ]);
    return {
      ...cloudTools,
      ...registryTools,
      ...remoteTools,
    };
  }

  /**
   * Used by the agent to undo all tool calls given by IDs.
   *
   * @param toolCallIds - the ids of the tool calls that should be undone
   *
   * @note The toolbox should revert all given tool calls by reverting to the
   *        last known state of affected files before the first tool call was executed.
   *
   * @note If multiple given tools calls affect the same file, the toolbox should revert to the previous version
   *        of the earliest related tool call in the list, and all other tool calls affecting the same file
   *        are also to be treated as "reverted".
   */
  public async undoToolCalls(
    toolCallIds: string[],
    agentInstanceId?: string,
  ): Promise<void> {
    return this.diffHistoryService.undoToolCalls(toolCallIds, agentInstanceId);
  }

  public getWorkspaceSnapshot(agentInstanceId: string): WorkspaceSnapshot {
    return (
      this.mountManagerService?.getWorkspaceSnapshot(agentInstanceId) ?? {
        mounts: [],
      }
    );
  }

  public async handleMountWorkspace(
    agentInstanceId: string,
    workspacePath: string,
    permissions?: MountPermission[],
  ) {
    await this.mountManagerService?.handleMountWorkspace(
      agentInstanceId,
      workspacePath,
      permissions,
    );
  }

  /**
   * `AgentManagerToolboxPort.resolveNewAgentMountPath` implementation.
   *
   * Defaults a new agent's mount to the repository's main worktree —
   * users typically expect a fresh agent to start at the canonical
   * checkout regardless of which linked worktree they happened to
   * pick. Falls back to the input path when the host's `gitService`
   * cannot determine a main worktree (non-git directory, error, ...).
   * The `agents.create` handler bypasses this when
   * `preserveWorkspacePaths` is set.
   */
  public async resolveNewAgentMountPath(
    workspacePath: string,
  ): Promise<string> {
    return await resolveNewAgentWorkspaceMountPath(
      workspacePath,
      (input) => this.gitService.getWorkspaceMainWorktreePath(input),
      this.logger,
    );
  }

  public async handleUnmountWorkspace(
    agentInstanceId: string,
    mountPrefix: string,
  ) {
    await this.mountManagerService?.handleUnmountWorkspace(
      agentInstanceId,
      mountPrefix,
    );
  }

  /**
   * Push current mount configuration for an agent to the sandbox worker
   * so the isolated fs stays in sync.
   */
  private getSandboxMounts(agentInstanceId: string): MountDescriptor[] {
    const mountsWithRt =
      this.mountManagerService?.getMountedPathsWithRuntimes(agentInstanceId);
    const mounts: MountDescriptor[] =
      mountsWithRt?.map((m) => ({
        prefix: m.prefix,
        absolutePath: m.path,
        permissions: m.permissions,
      })) ?? [];

    // Never mount protected-file ciphertext into the sandbox workspace.
    // `att/`, `shells/`, and `memory/` remain available through native
    // read/glob/grep tools, which decrypt inside the trusted host.

    mounts.push({
      prefix: 'plugins',
      absolutePath: getPluginsPath(),
      permissions: READ_ONLY_PERMISSIONS,
    });
    mounts.push({
      prefix: 'marketplace-plugins',
      absolutePath: getInstalledPluginsDir(),
      permissions: READ_ONLY_PERMISSIONS,
    });

    for (const gs of getEnabledGlobalSkillsMounts(
      this.uiKarton.state.preferences?.agent?.enabledGlobalSkillDirs ?? [],
    )) {
      mounts.push({
        prefix: gs.prefix,
        absolutePath: gs.absolutePath,
        permissions: READ_ONLY_PERMISSIONS,
      });
    }

    const appsDir = getAgentAppsDir(agentInstanceId);
    mkdirSync(appsDir, { recursive: true });
    mounts.push({
      prefix: 'apps',
      absolutePath: appsDir,
      permissions: FULL_PERMISSIONS,
    });

    mounts.push({
      prefix: LOGS_PREFIX,
      absolutePath: getLogsDir(),
      permissions: FULL_PERMISSIONS,
    });

    return mounts;
  }

  private pushMountsToSandbox(agentInstanceId: string) {
    if (!this.sandboxService) return;
    this.sandboxService.updateAgentMounts(
      agentInstanceId,
      this.getSandboxMounts(agentInstanceId),
    );
  }

  public setWorkspaceMdContent(
    workspacePath: string,
    content: string | null,
  ): void {
    this.mountManagerService?.setWorkspaceMdContent(workspacePath, content);
  }

  public async getWorkspaceInfo(
    agentInstanceId: string,
  ): Promise<WorkspaceInfo[]> {
    const mountsWithRt =
      this.mountManagerService?.getMountedRuntimes(agentInstanceId);
    if (!mountsWithRt) return [];
    if (mountsWithRt.size === 0) return [];
    return Promise.all(
      [...mountsWithRt.values()].map((m) => getWorkspaceInfoUtil(m)),
    );
  }

  public getShellInfo(): { type: string; path: string } | null {
    return this.shellService?.getShellInfo() ?? null;
  }

  public killShellSession(sessionId: string): void {
    this.shellService?.killSession(sessionId);
  }

  public getBrowserSnapshot(agentInstanceId: string): BrowserSnapshot {
    const contentTabs = this.uiKarton.state.contentTabs;

    // Filter: only global tabs (null) and tabs assigned to this agent
    const isTabVisible = (tab: { agentInstanceId: string | null }) =>
      tab.agentInstanceId === null || tab.agentInstanceId === agentInstanceId;

    // Non-browser tabs are excluded from the browser snapshot.
    const isBrowserTab = (tab: TabState) =>
      tab.type === undefined || tab.type === 'browser';

    const activeTab =
      contentTabs.activeTabId && contentTabs.tabs[contentTabs.activeTabId]
        ? contentTabs.tabs[contentTabs.activeTabId]
        : null;

    const orderedIds = [
      ...contentTabs.globalOrder,
      ...(contentTabs.agentOrders[agentInstanceId] ?? []),
      ...Object.keys(contentTabs.tabs),
    ];
    const seen = new Set<string>();
    const visibleTabs = orderedIds
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => contentTabs.tabs[id] as TabState | undefined)
      .filter((tab): tab is TabState => Boolean(tab))
      .filter(isBrowserTab)
      .filter(isTabVisible);

    const allTabs = visibleTabs
      .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
      .map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        error: tab.error
          ? { code: tab.error.code, message: tab.error.message }
          : null,
        consoleLogCount: tab.consoleLogCount,
        consoleErrorCount: tab.consoleErrorCount,
        faviconUrl: tab.faviconUrls?.[0],
        agentInstanceId: tab.agentInstanceId,
        lastFocusedAt: tab.lastFocusedAt,
      }));

    // Only show active tab if it's visible to this agent
    const activeTabVisible =
      activeTab && isTabVisible(activeTab) && isBrowserTab(activeTab)
        ? activeTab
        : null;

    return {
      activeTab: activeTabVisible
        ? {
            id: activeTabVisible.id,
            title: activeTabVisible.title,
            url: activeTabVisible.url,
            error: activeTabVisible.error,
            consoleLogCount: activeTabVisible.consoleLogCount,
            consoleErrorCount: activeTabVisible.consoleErrorCount,
            agentInstanceId: activeTabVisible.agentInstanceId,
          }
        : null,
      tabs: allTabs,
      totalTabCount: visibleTabs.length,
    };
  }

  /**
   * Store the builtin commands discovered at startup and push the
   * initial commands list to Karton state.
   */
  public setBuiltinSkills(cmds: SkillDefinition[]): void {
    this.builtinSkills = cmds;
    // Trigger a full rebuild for all active agents so builtins get
    // merged with any already-discovered workspace/plugin skills.
    const activeIds = Object.keys(this.uiKarton.state.agents.instances);
    if (activeIds.length > 0) {
      for (const id of activeIds) void this.rebuildSkillsList(id);
    } else {
      // No agents yet — push builtins directly so they're available
      // when the first agent is created.
      this.uiKarton.setState((draft) => {
        draft.skills = cmds.map(toSkillDefinitionUI);
      });
    }
    // Always populate the global skills index for the Settings UI,
    // even before any agent is created.
    void this.rebuildGlobalSkillsIndex();
  }

  /**
   * Rebuild the unified commands list (builtins + workspace skills +
   * plugin skills) for a given agent and push it to Karton state.
   * Called on mount/unmount to keep the slash-command list in sync.
   */
  private async rebuildSkillsList(agentInstanceId: string): Promise<void> {
    const gen = ++this.skillsRebuildGeneration;
    const commands = await this.getSkillsList(agentInstanceId);
    // Discard result if a newer rebuild was triggered while we
    // were awaiting (prevents stale lists from overwriting).
    if (gen !== this.skillsRebuildGeneration) return;
    this.uiKarton.setState((draft) => {
      draft.skills = commands
        .filter((c) => c.userInvocable !== false)
        .map(toSkillDefinitionUI);
    });
    // Note: rebuildGlobalSkillsIndex is NOT called here to avoid
    // N+1 filesystem scans when this method is invoked in a per-agent
    // loop. The global index is independent of per-agent state (it
    // discovers ALL skills from ALL dirs regardless of preferences),
    // so it is rebuilt once per event at the call sites that need it.
  }

  /**
   * Discover ALL global skills from every global skill directory
   * (including disabled ones), deduped by name with `.clodex` >
   * `.agents` > `.codex` > `.claude` ordering, and push the result
   * to `state.globalSkills` for the Settings UI. Unlike
   * `getSkillsList`, this does NOT filter by enabled dirs or
   * disabled skill names — the UI needs the full roster to render
   * toggles.
   */
  private async rebuildGlobalSkillsIndex(): Promise<void> {
    const gen = ++this.globalSkillsRebuildGeneration;
    const mounts = getGlobalSkillsMounts();
    const perMount = await Promise.all(
      mounts.map(async (m) => ({
        mount: m,
        skills: existsSync(m.absolutePath)
          ? await discoverSkills(m.absolutePath)
          : [],
      })),
    );
    if (gen !== this.globalSkillsRebuildGeneration) return;

    const seen = new Set<string>();
    const result: Array<{
      name: string;
      description: string;
      mountPrefix: string;
    }> = [];
    // Preserve mount order from getGlobalSkillsMounts() (clodex >
    // agents > codex > claude) for dedupe priority.
    for (const { mount, skills } of perMount) {
      for (const skill of skills) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        result.push({
          name: skill.name,
          description: skill.description,
          mountPrefix: mount.prefix,
        });
      }
    }

    this.uiKarton.setState((draft) => {
      draft.globalSkills = result;
    });
  }

  /**
   * Returns the full `SkillDefinition[]` (with `contentPath`) for
   * the given agent. Used at inference time by `resolveSlashSkill`
   * to read command/skill content from the correct disk path.
   */
  public async getSkillsList(
    agentInstanceId: string,
  ): Promise<SkillDefinition[]> {
    const result: SkillDefinition[] = [...this.builtinSkills];
    const seen = new Set(result.map((c) => c.id));

    // Workspace skills first — workspace overrides global.
    // Also collect disabled skill names so globals can be suppressed.
    const allDisabled = new Set<string>();
    const mounts =
      this.mountManagerService?.getMountedPathsWithRuntimes(agentInstanceId);
    if (mounts) {
      for (const mount of mounts) {
        const settings = this.uiKarton.state.preferences?.agent
          ?.workspaceSettings?.[mount.path] ?? {
          respectAgentsMd: false,
          disabledSkills: [],
        };
        const disabled = new Set(settings.disabledSkills);
        for (const name of disabled) allDisabled.add(name);
        const skills = await getSkills(mount.clientRuntime);

        for (const skill of skills) {
          if (disabled.has(skill.name)) continue;
          const id = `skill:${skill.name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const relativePath = path.relative(mount.path, skill.path);
          result.push({
            id,
            displayName: skill.name,
            description: skill.description,
            source: 'workspace',
            contentPath: path.resolve(skill.path, 'SKILL.md'),
            skillPath: `${mount.prefix}/${relativePath}`,
            workspacePrefix: mount.prefix,
            userInvocable: skill.userInvocable,
            agentInvocable: skill.agentInvocable,
          });
        }
      }
    }

    // Global (user-level) skills — after workspace so workspace wins on dupes.
    // Also suppressed by workspace-level disabledSkills and global-level
    // disabledGlobalSkills. Discovery is per-mount (only enabled dirs) so
    // that external dirs (codex/claude) are opt-in.
    const disabledGlobalSkills = new Set(
      this.uiKarton.state.preferences?.agent?.disabledGlobalSkills ?? [],
    );
    const enabledGlobalMounts = getEnabledGlobalSkillsMounts(
      this.uiKarton.state.preferences?.agent?.enabledGlobalSkillDirs ?? [],
    );
    for (const mount of enabledGlobalMounts) {
      const skills = await discoverSkills(mount.absolutePath);
      for (const skill of skills) {
        if (allDisabled.has(skill.name) || disabledGlobalSkills.has(skill.name))
          continue;
        const id = `skill:${skill.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const relativePath = path.relative(mount.absolutePath, skill.path);
        result.push({
          id,
          displayName: skill.name,
          description: skill.description,
          source: 'global',
          contentPath: path.resolve(skill.path, 'SKILL.md'),
          skillPath: `${mount.prefix}/${relativePath}`,
          userInvocable: skill.userInvocable,
          agentInvocable: skill.agentInvocable,
        });
      }
    }

    // Plugin skills. Bundled plugins win when a marketplace package reuses an
    // existing plugin/skill identity.
    const disabledPlugins = new Set(
      this.uiKarton.state.preferences?.agent?.disabledPluginIds ?? [],
    );
    for (const pluginRoot of [
      { absolutePath: getPluginsPath(), mountPrefix: 'plugins' },
      {
        absolutePath: getInstalledPluginsDir(),
        mountPrefix: 'marketplace-plugins',
      },
    ]) {
      const pluginSkills = await discoverSkills(pluginRoot.absolutePath);
      for (const skill of pluginSkills) {
        const pluginId = path.basename(skill.path);
        if (disabledPlugins.has(pluginId)) continue;
        const id = `plugin:${pluginId}:${skill.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
          id,
          displayName: skill.name,
          description: skill.description,
          source: 'plugin',
          contentPath: path.resolve(skill.path, 'SKILL.md'),
          skillPath: `${pluginRoot.mountPrefix}/${pluginId}/SKILL.md`,
          pluginId,
          userInvocable: skill.userInvocable,
          agentInvocable: skill.agentInvocable,
        });
      }
    }

    return result;
  }

  public getWorkspaceAgentSettings(
    agentInstanceId: string,
  ): Map<string, WorkspaceAgentSettings> {
    const mounts =
      this.mountManagerService?.getMountedPathsWithRuntimes(agentInstanceId);
    const result = new Map<string, WorkspaceAgentSettings>();
    for (const mount of mounts ?? []) {
      result.set(
        mount.prefix,
        this.uiKarton.state.preferences?.agent?.workspaceSettings?.[
          mount.path
        ] ?? { respectAgentsMd: false, disabledSkills: [] },
      );
    }
    return result;
  }

  public async getWorkspaceMd(
    agentInstanceId: string,
  ): Promise<Array<{ mountPrefix: string; path: string; content: string }>> {
    const mounts =
      this.mountManagerService?.getMountedPathsWithRuntimes(agentInstanceId);
    if (!mounts) return [];
    if (mounts.length === 0) return [];
    const results: Array<{
      mountPrefix: string;
      path: string;
      content: string;
    }> = [];
    for (const mount of mounts) {
      const content = await readWorkspaceMd(mount.path);
      if (content) {
        results.push({
          mountPrefix: mount.prefix,
          path: mount.path,
          content,
        });
      }
    }
    return results;
  }

  public async getContextFilesForAllWorkspaces(): Promise<ContextFilesResult> {
    const uniquePaths = this.mountManagerService?.getAllMountedPaths();
    const result: ContextFilesResult = {};

    await Promise.all(
      [...(uniquePaths ?? [])].map(async (wsPath) => {
        const clientRuntime =
          this.mountManagerService?.getClientRuntimeForPath(wsPath);
        if (!clientRuntime) return;

        const workspaceMdPath = path.resolve(
          wsPath,
          WORKSPACE_MD_DIR,
          WORKSPACE_MD_FILENAME,
        );
        const agentsMdPath = path.resolve(wsPath, 'AGENTS.md');

        const [workspaceMdContent, agentsMdContent] = await Promise.all([
          readWorkspaceMd(wsPath),
          clientRuntime ? readAgentsMd(clientRuntime) : null,
        ]);

        result[wsPath] = {
          workspaceMd: {
            exists: workspaceMdContent !== null,
            path: workspaceMdPath,
            content: workspaceMdContent,
          },
          agentsMd: {
            exists: agentsMdContent !== null,
            path: agentsMdPath,
            content: agentsMdContent,
          },
        };
      }),
    );

    return result;
  }

  /**
   * Get or create an authenticated API client.
   * Returns null if not authenticated.
   */
  private getOrCreateApiClient(): ApiClient | null {
    const accessToken = this.authService.accessToken;
    if (!accessToken) {
      this.apiClient = null;
      return null;
    }

    // Create new client if not cached
    if (!this.apiClient) {
      try {
        this.apiClient = createAuthenticatedClient(accessToken);
      } catch (error) {
        this.logger.error(
          '[ToolboxService] Failed to create authenticated client',
          { error },
        );
        this.report(error as Error, 'createApiClient');
        return null;
      }
    }

    return this.apiClient;
  }

  /**
   * Drain pending tool-produced attachments for the given agent (today:
   * blobs created via the sandbox `API.createAttachment()` side-channel).
   * Returns them as a flat array; clears the pending buffers as a side
   * effect.
   *
   * Satisfies the `BaseAgentToolboxView.drainPendingAttachments` seam
   * consumed by `BaseAgent.handlePostStep`.
   */
  public drainPendingAttachments(agentInstanceId: string): Attachment[] {
    if (!this.sandboxService) return [];
    return this.sandboxService.drainPendingAttachments(agentInstanceId);
  }

  public getMountedPathsForAgent(
    agentInstanceId: string,
  ): Map<MountedPrefix, MountedPath> {
    const mounts =
      this.mountManagerService?.getMountedPathsWithRuntimes(agentInstanceId);
    const result = new Map<MountedPrefix, MountedPath>();
    if (mounts) {
      for (const mount of mounts) result.set(mount.prefix, mount.path);
    }

    // Include always-available special mounts so that path references
    // from plugin skill reads (plugins/), attachment blobs (att/), and
    // agent apps (apps/) can be resolved during content injection.
    result.set('plugins', getPluginsPath());
    result.set('marketplace-plugins', getInstalledPluginsDir());
    result.set('apps', getAgentAppsDir(agentInstanceId));
    result.set('att', this.attachments.agentBlobDir(agentInstanceId));
    result.set(PLANS_PREFIX, getPlansDir());
    result.set(LOGS_PREFIX, getLogsDir());
    result.set('memory', getMemoryDir());

    for (const gs of getEnabledGlobalSkillsMounts(
      this.uiKarton.state.preferences?.agent?.enabledGlobalSkillDirs ?? [],
    )) {
      result.set(gs.prefix, gs.absolutePath);
    }

    return result;
  }

  private getShellMountedPathsForAgent(
    agentInstanceId: string,
  ): Map<MountedPrefix, MountedPath> {
    const result = this.getMountedPathsForAgent(agentInstanceId);
    result.delete('att');
    result.delete('shells');
    result.delete('memory');
    return result;
  }

  public getWorkspaceSnapshotForPersistence(
    agentInstanceId: string,
  ): Array<{ path: string; permissions: MountPermission[] }> {
    const mounts =
      this.mountManagerService?.getMountedPathsWithRuntimes(agentInstanceId);
    if (!mounts) return [];
    return mounts.map((m) => ({
      path: m.path,
      permissions: m.permissions,
    }));
  }

  /**
   * Refresh the API client (e.g., after auth state changes).
   * Call this when the auth token is refreshed.
   */
  public refreshApiClient(): void {
    this.apiClient = null;
    this.apiClient = this.getOrCreateApiClient();
  }

  public refreshPluginSkills(): void {
    const activeIds = Object.keys(this.uiKarton.state.agents.instances);
    for (const id of activeIds) void this.rebuildSkillsList(id);
  }

  public async acceptAllPendingEditsForAgent(
    agentInstanceId: string,
  ): Promise<void> {
    await this.diffHistoryService.acceptAllPendingEditsForAgent(
      agentInstanceId,
    );
  }

  /**
   * Return distinct filepaths that an agent has edited.
   * Lightweight proxy to DiffHistoryService.
   */
  public async getEditedFilePathsForAgent(
    agentInstanceId: string,
  ): Promise<string[]> {
    return this.diffHistoryService.getEditedFilePathsForAgent(agentInstanceId);
  }

  /**
   * Cancel any pending host-side user-facing dialogs for the given
   * agent (today: `askUserQuestions` form UI). Called when the agent
   * is stopped to dismiss the dialog UI.
   *
   * Satisfies the `BaseAgentToolboxView.cancelPendingAgentDialogs`
   * seam.
   */
  public cancelPendingAgentDialogs(agentInstanceId: string): void {
    cleanupQuestionsForAgent(agentInstanceId, this.uiKarton);
  }

  public async requestMcpElicitation(
    serverId: string,
    agentInstanceId: string,
    request: McpElicitationRequest,
    signal: AbortSignal,
  ): Promise<McpElicitationResult> {
    const server = this.mcpRegistryService.snapshot().servers[serverId];
    if (!server?.enabled || signal.aborted) return { action: 'cancel' };
    const result = await requestStructuredUserQuestions({
      uiKarton: this.uiKarton,
      hostAgentStateMutations: this.hostAgentStateMutations,
      agentInstanceId,
      signal,
      params: toMcpElicitationQuestion(server.displayName, request),
      onQuestionRequested: (id) =>
        this.notificationEventHandler?.('question', id),
    });
    if (result.completed) {
      return {
        action: 'accept',
        content: result.answers,
      };
    }
    return {
      action: result.cancelReason === 'user_cancelled' ? 'decline' : 'cancel',
    };
  }

  public cancelPendingEdits(agentInstanceId: string): void {
    this.pendingEditService.abortAgentEdits(agentInstanceId);
  }

  /** Resolve a specific pending question with a given reason. */
  public cancelQuestion(
    agentInstanceId: string,
    questionId: string,
    reason: 'user_cancelled' | 'user_sent_message' | 'agent_stopped',
    draftAnswers?: Record<string, QuestionAnswerValue>,
  ): void {
    cancelQuestion(
      questionId,
      reason,
      this.uiKarton,
      agentInstanceId,
      draftAnswers,
    );
  }

  /**
   * Release runtime resources (sandbox, shell, mounts, etc.) for an agent.
   *
   * @param deleteBlobs When `true`, permanently removes the agent's on-disk
   *   attachment blobs.  Pass `false` (or omit) when *archiving* an agent so
   *   that blobs survive for a later `resumeAgent` call.
   */
  public clearAgentTracking(
    agentInstanceId: string,
    { deleteBlobs = false }: { deleteBlobs?: boolean } = {},
  ): void {
    for (const key of this.evidenceMemoryCodeProviders.keys()) {
      if (key.startsWith(`${agentInstanceId} `)) {
        this.evidenceMemoryCodeProviders.delete(key);
      }
    }
    this.mountManagerService?.clearAgentMounts(agentInstanceId);
    this.sandboxService?.destroyAgent(agentInstanceId);
    this.shellService?.destroyAgent(agentInstanceId);
    this.appsRuntimes.delete(agentInstanceId);
    if (deleteBlobs) {
      void this.attachments.deleteAgentBlobs(agentInstanceId);
      this.shellService?.deleteShellLogs(agentInstanceId);
    }
    this.cancelPendingAgentDialogs(agentInstanceId);
  }

  private async initialize(): Promise<void> {
    this.logger.debug('[ToolboxService] Initializing...');

    const pluginsDir = getPluginsPath();
    this.pluginsRuntime = new ClientRuntimeNode({
      workingDirectory: pluginsDir,
      rgBinaryBasePath: getRipgrepBasePath(),
    });
    this.marketplacePluginsRuntime = new ClientRuntimeNode({
      workingDirectory: getInstalledPluginsDir(),
      rgBinaryBasePath: getRipgrepBasePath(),
    });

    // Eagerly initialize the API client if auth is already available
    this.apiClient = this.getOrCreateApiClient();

    this.mountManagerService = await MountManagerService.create(
      this.logger,
      this.filePickerService,
      this.userExperienceService,
      this.uiKarton,
      this.telemetryService,
      this.gitService,
      this.preferencesService,
      this.agentStore,
      this.resolvedEnvPromise,
    );

    this.mountManagerService.setOnMountsChanged((agentInstanceId) => {
      this.pushMountsToSandbox(agentInstanceId);
      void this.rebuildSkillsList(agentInstanceId);
    });

    // Rebuild the slash-command list whenever skill/plugin preferences change
    // so toggles in Agent Settings take effect immediately.
    this.unsubPreferenceSync = syncDerivedState(
      this.uiKarton,
      (state) => ({
        ws: state.preferences?.agent?.workspaceSettings,
        plugins: state.preferences?.agent?.disabledPluginIds,
        globalSkillDirs: state.preferences?.agent?.enabledGlobalSkillDirs,
        disabledGlobalSkills: state.preferences?.agent?.disabledGlobalSkills,
      }),
      () => {
        const activeIds = Object.keys(this.uiKarton.state.agents.instances);
        for (const id of activeIds) void this.rebuildSkillsList(id);
      },
    );

    // Start watching the global plans directory
    this.startPlansWatcher();

    // Start watching the global logs directory
    this.startLogsWatcher();

    // Start the log ingest HTTP server
    try {
      this.logIngestService = await LogIngestService.create();
      this.uiKarton.setState((draft) => {
        draft.logIngest = {
          port: this.logIngestService!.getPort(),
          token: this.logIngestService!.getToken(),
        };
      });
    } catch (err) {
      this.logIngestService = null;
      this.uiKarton.setState((draft) => {
        draft.logIngest = null;
      });
      this.logger.error(
        '[ToolboxService] Failed to start LogIngestService:',
        err,
      );
    }

    // Start watching global skills directories (~/.clodex/skills, ~/.agents/skills)
    this.startGlobalSkillsWatchers();

    const fileDiffHandler = createFileDiffHandler({
      mountManager: this.mountManagerService,
      diffHistoryService: this.diffHistoryService,
      logger: this.logger,
      telemetryService: this.telemetryService,
    });

    this.sandboxService = await SandboxService.create(
      this.windowLayoutService,
      this.logger,
      this.attachments,
      fileDiffHandler,
      (agentId) => this.getSandboxMounts(agentId),
      async (typeId) => {
        const resolved = await this.credentialsService.resolve(
          typeId as CredentialTypeId,
        );
        if (!resolved) return null;
        return {
          data: resolved.data,
          secretEntries: [...resolved.secretMap.entries()].map(
            ([placeholder, entry]) =>
              [placeholder, entry.value, entry.allowedOrigins] as [
                string,
                string,
                string[],
              ],
          ),
        };
      },
      this.uiKarton,
    );

    // ShellService needs the resolved value eagerly (configures loginFallback).
    // By this point the promise has likely already settled (SandboxService
    // creation above takes non-trivial time), so the await is ~instant.
    const resolvedEnv = await this.resolvedEnvPromise;
    this.shellService = await ShellService.create(
      this.logger,
      getAgentShellLogsDir,
      createKartonShellStreamSink(this.uiKarton),
      this.detectedShell,
      resolvedEnv,
      this.protectedFiles,
    );

    // Create TerminalService for user-controllable terminal tabs.
    // Requires a detected shell — if no shell is available, terminal
    // creation will silently fail (procedure handler not registered).
    // When resolvedEnv is null (shell-env resolution failed), pass null
    // directly — sanitizeEnv will fall back to process.env internally
    // and apply the BLOCKLIST to strip host-process contamination vars
    // (NODE_ENV, BUILD_MODE, etc.). Constructing a process.env copy here
    // would bypass the blocklist since sanitizeEnv treats any non-null
    // value as a resolved shell env.
    if (this.detectedShell) {
      this.terminalService = new TerminalService(
        this.logger,
        this.uiKarton,
        this.detectedShell,
        resolvedEnv,
      );
      this.terminalService.initialize();
      // Restore PTYs for terminal tabs persisted in loadTabState.
      this.terminalService.restoreFromState();
      // Wire terminal lifecycle so active-tab management stays
      // centralized in WindowLayoutService.
      this.windowLayoutService.setOnCloseTerminal((terminalId) => {
        this.terminalService?.handleCloseTerminal(terminalId);
      });
      this.terminalService.setOnTerminalTabCreated((terminalId) => {
        this.windowLayoutService.activateTerminalTab(terminalId);
      });
      this.terminalService.setOnTerminalTabRemoved((terminalId) => {
        this.windowLayoutService.handleTerminalTabExited(terminalId);
      });
      this.windowLayoutService.setOnBeforeSaveTabState(() => {
        this.terminalService?.syncTerminalCwds();
      });
      // Wire deferred terminal restoration — when WindowLayoutService
      // creates a restored terminal tab, spawn its PTY on-demand.
      this.windowLayoutService.setOnDeferredTerminalRestored(
        (terminalId, cwd) => {
          this.terminalService?.restoreTerminal(terminalId, cwd);
        },
      );
    }

    // Use arrow function to preserve `this` binding when called as callback
    this.authService.registerAuthStateChangeCallback(() =>
      this.refreshApiClient(),
    );

    // Register askUserQuestions procedure handlers
    this.uiKarton.registerServerProcedureHandler(
      'toolbox.submitUserQuestionStep',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        questionId: string,
        stepAnswers: Record<string, QuestionAnswerValue>,
      ) => {
        advanceOrCompleteQuestion(
          questionId,
          stepAnswers,
          this.uiKarton,
          agentInstanceId,
        );
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'toolbox.cancelUserQuestion',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        questionId: string,
        reason: 'user_cancelled' | 'user_sent_message',
      ) => {
        cancelQuestion(questionId, reason, this.uiKarton, agentInstanceId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'toolbox.goBackUserQuestion',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        questionId: string,
      ) => {
        goBackQuestion(questionId, this.uiKarton, agentInstanceId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'toolbox.killShellSession',
      async (
        _callingClientId: string,
        _agentInstanceId: string,
        sessionId: string,
      ) => {
        this.killShellSession(sessionId);
      },
    );

    // 'toolbox.dismissActiveApp' and 'toolbox.clearPendingAppMessage' are
    // registered via AgentCoreBridge
    // (apps/browser/src/backend/services/agent-core-bridge). Do not
    // re-register them here — double-registration is undefined behaviour
    // in Karton (see plans/phase-1c D-KB-6, plans/phase-1d).

    this.uiKarton.registerServerProcedureHandler(
      'toolbox.forwardAppMessage',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        appId: string,
        pluginId: string | undefined,
        data: unknown,
      ) => {
        this.sandboxService?.forwardAppMessage(
          agentInstanceId,
          appId,
          pluginId,
          data,
        );
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'toolbox.clearLogChannel',
      async (_callingClientId: string, filename: string) => {
        if (
          typeof filename !== 'string' ||
          !filename.endsWith('.jsonl') ||
          filename !== path.basename(filename)
        )
          throw new Error('Invalid log channel filename.');

        const logsDir = path.resolve(getLogsDir());
        const filePath = path.resolve(logsDir, filename);
        if (!filePath.startsWith(logsDir + path.sep))
          throw new Error('Invalid log channel filename.');

        try {
          truncateSync(filePath, 0);
        } catch {
          // File may not exist — ignore
        }
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'toolbox.getClodexMcpStatus',
      async (_callingClientId: string, refresh = false) => {
        return await this.clodexMcpService.getCapabilityStatus(refresh);
      },
    );
  }

  /**
   * Start a chokidar watcher on the global plans directory.
   * On any change, re-reads all plans and pushes updated list to Karton state.
   */
  private startPlansWatcher(): void {
    const plansDir = getPlansDir();
    this.plansWatcher = chokidar.watch(plansDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const scheduleRefresh = () => {
      if (this.plansWatcherDebounce) clearTimeout(this.plansWatcherDebounce);
      this.plansWatcherDebounce = setTimeout(() => {
        this.plansWatcherDebounce = null;
        void this.refreshGlobalPlans();
      }, 400);
    };

    this.plansWatcher
      .on('add', scheduleRefresh)
      .on('change', scheduleRefresh)
      .on('unlink', scheduleRefresh)
      .on('error', (error) => {
        this.logger.debug('[ToolboxService] Plans watcher error', { error });
      });
  }

  /**
   * Watch parent dirs (`~/.clodex/`, `~/.agents/`, `~/.codex/`,
   * `~/.claude/`) for changes to their `skills/` subdirectories. Follows
   * the workspace watcher pattern: watch parents with an ignored filter
   * so we detect `skills/` being created for the first time. Watches all
   * global mounts regardless of enabled/disabled state so toggling a dir
   * on picks up its contents immediately.
   */
  private startGlobalSkillsWatchers(): void {
    const scheduleRefresh = () => {
      if (this.globalSkillsWatcherDebounce)
        clearTimeout(this.globalSkillsWatcherDebounce);
      this.globalSkillsWatcherDebounce = setTimeout(() => {
        this.globalSkillsWatcherDebounce = null;
        // Evict stale runtimes for directories that were removed.
        for (const mount of getGlobalSkillsMounts()) {
          if (
            this.globalSkillsRuntimes.has(mount.prefix) &&
            !existsSync(mount.absolutePath)
          )
            this.globalSkillsRuntimes.delete(mount.prefix);
        }
        // Always refresh the global skills index for the Settings UI,
        // even when no agents are active.
        void this.rebuildGlobalSkillsIndex();
        // Rebuild skills list for all active agents.
        const activeIds = Object.keys(this.uiKarton.state.agents.instances);
        for (const id of activeIds) void this.rebuildSkillsList(id);
      }, 400);
    };

    for (const mount of getGlobalSkillsMounts()) {
      const parentDir = path.dirname(mount.absolutePath);
      if (!existsSync(parentDir)) continue;

      const watcher = chokidar.watch(parentDir, {
        persistent: true,
        ignoreInitial: true,
        depth: 3,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        ignored: (filePath: string) => {
          if (filePath === parentDir) return false;
          const rel = path.relative(parentDir, filePath);
          const segments = rel.split(path.sep);
          // Only allow the 'skills' subdirectory.
          if (segments.length === 1) return segments[0] !== 'skills';
          return segments[0] !== 'skills';
        },
      });

      watcher
        .on('add', scheduleRefresh)
        .on('change', scheduleRefresh)
        .on('unlink', scheduleRefresh)
        .on('addDir', scheduleRefresh)
        .on('unlinkDir', scheduleRefresh)
        .on('error', (error) => {
          this.logger.debug('[ToolboxService] Global skills watcher error', {
            error,
          });
        });

      this.globalSkillsWatchers.push(watcher);
    }
  }

  private stopGlobalSkillsWatchers(): void {
    if (this.globalSkillsWatcherDebounce) {
      clearTimeout(this.globalSkillsWatcherDebounce);
      this.globalSkillsWatcherDebounce = null;
    }
    for (const watcher of this.globalSkillsWatchers) void watcher.close();

    this.globalSkillsWatchers = [];
  }

  /**
   * Start a chokidar watcher on the global logs directory.
   * On any change, re-reads all log channels and pushes updated list to Karton state.
   */
  private startLogsWatcher(): void {
    const logsDir = getLogsDir();
    mkdirSync(logsDir, { recursive: true });
    this.logsWatcher = chokidar.watch(logsDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const scheduleRefresh = () => {
      if (this.logsWatcherDebounce) clearTimeout(this.logsWatcherDebounce);
      this.logsWatcherDebounce = setTimeout(() => {
        this.logsWatcherDebounce = null;
        void this.refreshGlobalLogs();
      }, 400);
    };

    this.logsWatcher
      .on('add', scheduleRefresh)
      .on('change', scheduleRefresh)
      .on('unlink', scheduleRefresh)
      .on('error', (error) => {
        this.logger.debug('[ToolboxService] Logs watcher error', { error });
      });
  }

  private stopLogsWatcher(): void {
    if (this.logsWatcherDebounce) {
      clearTimeout(this.logsWatcherDebounce);
      this.logsWatcherDebounce = null;
    }
    if (this.logsWatcher) {
      void this.logsWatcher.close();
      this.logsWatcher = null;
    }
  }

  private stopPlansWatcher(): void {
    if (this.plansWatcherDebounce) {
      clearTimeout(this.plansWatcherDebounce);
      this.plansWatcherDebounce = null;
    }
    if (this.plansWatcher) {
      void this.plansWatcher.close();
      this.plansWatcher = null;
    }
  }

  /** Re-read all log channels from disk and push to top-level Karton state. */
  private async refreshGlobalLogs(): Promise<void> {
    try {
      const logs = await readLogChannels(getLogsDir());
      this.uiKarton.setState((draft) => {
        draft.logChannels = logs.map((ch) => ({
          filename: ch.filename,
          byteSize: ch.byteSize,
          lineCount: ch.lineCount,
          tailLines: ch.tailLines,
        }));
      });
    } catch (error) {
      this.logger.debug('[ToolboxService] Failed to refresh global logs', {
        error,
      });
      this.report(error as Error, 'refreshGlobalLogs');
    }
  }

  /** Re-read all plans from disk and push to top-level Karton state. */
  private async refreshGlobalPlans(): Promise<void> {
    try {
      const plans = await readPlans(getPlansDir());
      this.uiKarton.setState((draft) => {
        draft.plans = plans.map((p) => ({
          name: p.name,
          description: p.description,
          filename: p.filename,
          totalTasks: p.totalTasks,
          completedTasks: p.completedTasks,
          taskGroups: p.taskGroups,
        }));
      });
    } catch (error) {
      this.logger.debug('[ToolboxService] Failed to refresh global plans', {
        error,
      });
      this.report(error as Error, 'refreshGlobalPlans');
    }
  }

  protected async onTeardown(): Promise<void> {
    this.unsubPreferenceSync?.();
    this.unsubPreferenceSync = null;

    this.apiClient = null;

    // Persist content tabs before any awaited teardown can consume the
    // shutdown budget. Normal tab operations already save, but app shutdown
    // can race the async terminal activation path and drop recently opened
    // terminal tabs without this final synchronous flush.
    this.windowLayoutService.persistTabStateNow();

    this.stopPlansWatcher();
    this.stopLogsWatcher();
    this.stopGlobalSkillsWatchers();

    await this.logIngestService?.teardown();
    this.logIngestService = null;

    await this.clodexMcpService.teardown();
    this.remoteConnectionsService = null;

    await this.mountManagerService?.teardown();
    this.mountManagerService = null;

    await this.sandboxService?.teardown();
    this.sandboxService = null;

    // User-terminal teardown — kills all terminal PTY processes.
    await this.terminalService?.teardown();
    this.terminalService = null;

    // Shell teardown last — kills all live PTY processes synchronously.
    // Ordering matters: downstream services may still hold references to
    // the shell during their own teardown, but none of the services
    // above use the shell, so tearing it down last is safe and keeps the
    // PTY kill as close to `app.exit(0)` as possible, minimizing the
    // window between kill and Node env teardown.
    await this.shellService?.teardown();
    this.shellService = null;
  }
}
