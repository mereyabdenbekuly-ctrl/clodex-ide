import type { ModelId } from '@shared/available-models';
import type { PluginDefinition } from '@shared/plugins';
import type { SkillDefinitionUI } from '@shared/skills';
import type {
  MountPermission,
  MentionFileCandidate,
  AttachmentMetadata,
  ShellSessionSnapshot,
} from './agent/metadata';
import type { MountEntry } from '@clodex/agent-core/types/metadata';
import type { SendUserMessageResult } from '@clodex/agent-core/agents';
import type { SelectedElement } from '../../selected-elements';
import type { AIModelInfo, ProviderValidationResult } from '../../ai-provider';
import type { FileDiff, PendingEditPreview } from './shared-types';
import type { QuestionAnswerValue } from './agent/tools/types';
import type { WorktreeSetupScriptVariant } from '@shared/worktree-setup';
import type {
  GlobalConfig,
  ModelSettings,
  ModelProvider,
  ProviderProfile,
  ProviderProfileSaveInput,
  UserPreferences,
  Patch,
  SearchEngine,
  SocialAuthProvider,
  FileEditApprovalMode,
  ToolApprovalMode,
  FilePickerRequest,
  WidgetId,
  DevToolbarOriginSettings,
} from './shared-types';
import { defaultUserPreferences } from './shared-types';
import type {
  PageTransition,
  HistoryFilter,
  HistoryResult,
  FaviconBitmapResult,
} from '../pages-api/types';
import type {
  AddSearchEngineInput,
  AddSearchEngineResult,
  RemoveSearchEngineResult,
  ClearBrowsingDataOptions,
  ClearBrowsingDataResult,
  ContextFilesResult,
} from '../pages-api/types';
import type { CodingPlanId } from '../../coding-plans';
import type { SettingsRoute } from '../../settings-route';
import type {
  MemoryNotesExportResult,
  MemoryNotesManagementScope,
  MemoryNotesResetResult,
  MemoryNotesRetention,
  MemoryNotesRetentionResult,
  MemoryNotesStats,
} from '../../memory-notes';
import type {
  EvidenceMemoryClaimDetails,
  EvidenceMemoryClaimDetailsInput,
  EvidenceMemoryClaimSearchHit,
  EvidenceMemoryInspectorExportResult,
  EvidenceMemoryDogfoodBackfillInput,
  EvidenceMemoryDogfoodBackfillResult,
  EvidenceMemoryDogfoodCohortReport,
  EvidenceMemoryDogfoodEvaluationInput,
  EvidenceMemoryDogfoodReport,
  EvidenceMemoryInspectorResetResult,
  EvidenceMemoryInspectorSearchInput,
  EvidenceMemoryInspectorSnapshot,
  EvidenceMemoryInspectorSnapshotInput,
  EvidenceMemoryReadinessDashboard,
  EvidenceMemoryReadinessEvaluationResult,
  EvidenceMemoryReadinessInput,
  EvidenceMemoryConflictResolution,
  EvidenceMemoryConflictResolutionInput,
  EvidenceMemoryConflictResolutionUndoInput,
} from '../../evidence-memory-inspector';
import type {
  NetworkEgressAuditExportResult,
  NetworkEgressControlSnapshot,
  NetworkEgressGrantInput,
  NetworkEgressSnapshotInput,
} from '../../network-egress-control';
import type {
  DictationBackendDiagnostics,
  DictationRealtimeNegotiationInput,
  DictationRealtimeNegotiationResult,
  DictationTranscriptionInput,
  DictationTranscriptionResult,
} from '../../dictation';
import type {
  DeleteRemoteConnectionResult,
  OpenRemoteTerminalResult,
  RemoteConnectionInput,
  RemoteConnectionOperationResult,
  RemoteConnectionsListResult,
  RemoteRunnerSelectionResult,
  SaveRemoteConnectionResult,
} from '../../remote-connections';
import type {
  DeleteDockerRunnerProfileResult,
  DockerRunnerProfileInput,
  DockerRunnerProfileOperationResult,
  DockerRunnerProfileSelectionResult,
  DockerRunnerProfilesSnapshot,
  SaveDockerRunnerProfileResult,
} from '../../docker-runner-profiles';
import type {
  GuardianDogfoodAssessment,
  GuardianFeedbackLabel,
} from '../../guardian';
import type {
  McpApplyImportInput,
  McpConnectionTestResult,
  McpCustomCredentialInput,
  McpImportPreviewSettings,
  McpGetPromptInput,
  McpPromptSettings,
  McpReadResourceInput,
  McpResourceSettings,
  McpResourceTemplateSettings,
  McpServerLogSettings,
  McpServerSettingsInput,
  McpSettingsPolicy,
  McpSettingsSnapshot,
  McpToolSettings,
} from '../../mcp-settings';
import type {
  PluginMarketplaceOperationResult,
  PluginMarketplaceState,
  PrivateMarketplaceOperationResult,
  PrivateMarketplaceSourceInput,
  PrivateMarketplaceSourcePublic,
  PrivateMarketplaceSourcesState,
} from '../../plugin-marketplace';
import type {
  CloudTaskArtifactActionResult,
  CloudTaskArtifactIdentity,
} from '../../cloud-task-artifacts';
import type {
  CloudTaskTeleportActionResult,
  CloudTaskTeleportState,
} from '../../cloud-task-teleport';
import type {
  CloudTaskMemoryDivergenceResolution,
  CloudTaskMemorySyncExportResult,
} from '../../cloud-task-memory-sync';
import type {
  AutomationOperationResult,
  AutomationSnapshot,
  CreateAutomationInput,
  UpdateAutomationInput,
} from '../../automations';
import type {
  ArtifactBridgeContext,
  ArtifactBridgeGrant,
  ArtifactBridgeGrantRevokeScope,
  ArtifactBridgePolicy,
  ArtifactBridgeRuntimeInspectorSnapshot,
  ArtifactBridgeSensitiveMcpApproval,
  ArtifactBridgeSessionSnapshot,
  ArtifactBridgeWriteApproval,
} from '../../artifact-bridge';
import type {
  ArtifactBridgeGrantReviewSelection,
  ArtifactBridgeGrantReviewSnapshot,
  ArtifactBridgeGrantReviewSubmission,
} from '../../artifact-bridge-grant-review';
import type {
  CreateSpaceInput,
  SpaceDefinition,
  SpacesSnapshot,
  UpdateSpaceInput,
} from '../../spaces';
import type {
  CreateSessionShareInput,
  SessionContinuityReadiness,
  SessionShareRecord,
  SessionShareSnapshot,
  SessionTeleportInput,
} from '../../session-continuity';
import type { RemoteControlEnvironmentAttestation } from '../../remote-control-protocol';
import type {
  DesktopAutomationApp,
  DesktopAutomationAppPolicy,
  DesktopAutomationAppPolicyMode,
  DesktopAutomationApprovalResponse,
  DesktopAutomationPermissionKind,
  DesktopAutomationPermissions,
} from '../../desktop-automation';
import type {
  AgentState,
  AgentTypes,
  ChatProject,
  AgentHistoryEntry,
  AgentMessage,
  StoredAgentPreview,
  TaskGoalStatus,
} from './agent';
import {
  createDefaultAgentOsState,
  type AgentOsState,
  type BrowserUseApprovalMode,
  type BrowserUseApprovalResponse,
  type BrowserUseCapability,
  type BrowserUseOriginPolicy,
  type ChronicleEvent,
  type ChroniclePrivacyMode,
  type ChronicleRetention,
  type CodexMicroAction,
  type CodexMicroPosition,
  type HookDefinition,
  type HookRunResult,
  type HookTrigger,
  type SkillInstallPreview,
  type SkillInstallRecord,
} from '../../agent-os';
import type {
  MountedWorkspaceGitDiffSummary,
  WorkspaceGitBranchesResult,
  WorkspaceGitWorktreesResult,
  WorkspaceGitMutationResult,
  WorkspaceGitCreateWorktreeResult,
  WorkspaceGitCreateBranchOptions,
  WorkspaceGitCreateWorktreeOptions,
  WorkspaceGitCleanupState,
  WorkspaceGitCleanupResult,
  WorkspaceGitSetupState,
  WorkspaceGitWorktreeDeletionInfo,
  WorkspaceGitWorktreeDeleteOptions,
  WorkspaceGitWorktreeDeleteResult,
  WorktreeSetupRepositoriesResult,
  SaveWorktreeSetupScriptResult,
  DeleteWorktreeSetupWorktreeResult,
} from './workspace-git';
import type { DownloadSummary } from './downloads';
import type {
  ColorScheme,
  ExperienceSurvey,
  FounderCallSurvey,
  StoredExperienceData,
} from './session';
import type {
  TabState,
  OpenFileTabOptions,
  FileStatResult,
  FilePreviewResult,
  FileTreeListDirectoryInput,
  FileTreeListDirectoryResult,
  FileTreeOperationResult,
  FileTreeClipboardOperation,
  FileSearchResult,
  FileDiffContent,
} from './files';
import type {
  HistoryEntry,
  OmniboxSuggestions,
  PlanEntry,
  LogChannelEntry,
} from './browser-history';
import type { SwarmRunState } from './swarm';
import type { PendingUserQuestion, ClodexMcpCapabilityStatus } from './toolbox';

export type AppState = {
  appScreen: {
    mode: 'main' | 'settings' | 'projects';
    settingsRoute: SettingsRoute;
  };
  internalData: {
    posthog?: {
      apiKey?: string;
      host?: string;
    };
  };
  agents: {
    instances: {
      [agentInstanceId: string]: {
        type: AgentTypes;
        canSelectModel: boolean;
        requiredModelCapabilities: ModelSettings['capabilities'];
        allowUserInput: boolean;
        parentAgentInstanceId: string | null;
        state: AgentState;
      };
    };
  };
  cloudTasks: {
    teleportByAgentId: Record<string, CloudTaskTeleportState>;
  };
  agentOs: AgentOsState;
  workspaceGitCleanup: WorkspaceGitCleanupState;
  workspaceGitSetup: WorkspaceGitSetupState;
  /**
   * Monotonic per-repository revision counters, bumped whenever the backend
   * detects an external git worktree add/remove (e.g. `git worktree add` or
   * `git worktree remove` run from a terminal outside the app). Keyed by
   * repositoryId, which equals the repository's common git dir. The sidebar
   * watches these to invalidate its cached worktree lists so the UI stays in
   * sync with the filesystem.
   */
  gitWorktreeRevisions: Record<string, number>;
  toolbox: {
    [agentInstanceId: string]: {
      workspace: {
        mounts: MountEntry[];
      };
      pendingFileDiffs: FileDiff[];
      pendingProposedEdits: PendingEditPreview[];
      editSummary: FileDiff[];
      pendingUserQuestion: PendingUserQuestion | null;
      pendingSandboxOutputs?: Record<string, string[]>;
      pendingSandboxAttachments?: Record<string, AttachmentMetadata[]>;
      pendingShellOutputs?: Record<string, string[]>;
      /** Maps toolCallId → sessionId for in-flight shell commands. */
      pendingShellSessionIds?: Record<string, string>;
      /** Live shell session manifest — pushed eagerly on lifecycle events. */
      shells?: { sessions: ShellSessionSnapshot[] };

      activeApp?: {
        appId: string;
        pluginId?: string;
        src: string;
        height?: number;
      } | null;
      pendingAppMessage?: {
        appId: string;
        pluginId?: string;
        data: unknown;
      } | null;
    };
  };
  swarmRuns: Record<string, SwarmRunState>;
  userAccount: {
    status: AuthStatus;
    machineId?: string;
    user?: {
      id: string;
      email: string;
      name?: string;
      username?: string;
      displayName?: string;
      group?: string;
    };
    balance?: {
      amount?: number;
      currency?: string;
      display?: string;
      rawQuota?: number;
      updatedAt?: string;
    };
    models?: Array<{
      id: string;
      name?: string;
      provider?: string;
      protocols?: string[];
      enabled?: boolean;
      costTier?: 'free' | 'low' | 'medium' | 'high';
      taskRoles?: Array<'analysis' | 'coding' | 'review' | 'general'>;
      contextWindow?: number;
    }>;
    keys?: Array<{
      id: string;
      name: string;
      group?: string;
      status?: string;
      isDefault?: boolean;
      modelLimitsEnabled?: boolean;
      modelLimits?: string[];
      protocols?: string[];
      baseUrls?: {
        openai?: string;
        anthropic?: string;
        google?: string;
      };
      expiresAt?: string;
    }>;
    activeKeyId?: string;
    isSwitchingKey?: boolean;
    ideToken?: {
      keyId?: string;
      keyName?: string;
      group?: string;
      expiresAt?: string;
    };
    tokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
  };
  // Current clodex app runtime information
  appInfo: {
    baseName: string; // Base name (e.g., 'clodex-dev', 'clodex-prerelease', 'clodex').
    name: string; // Display name (e.g., 'clodex (Dev-Build)', 'clodex').
    bundleId: string; // Bundle ID (e.g., 'io.clodex.dev').
    version: string; // The version of the app.
    platform: 'darwin' | 'linux' | 'win32'; // The platform on which the app is running.
    isFullScreen: boolean; // Whether the app window is in fullscreen mode.
    // Build-time constants
    releaseChannel: 'dev' | 'prerelease' | 'nightly' | 'release'; // The release channel of the app.
    author: string; // Author name.
    copyright: string; // Copyright string.
    homepage: string; // Homepage URL.
    arch: string; // Architecture (e.g., 'x64', 'arm64').
    otherVersions: Record<string, string | undefined>; // Other versions of the app.
  };
  closedLidSleep: {
    isSupported: boolean;
    isSleepDisabled: boolean;
    ownedByClodex: boolean;
    isChanging: boolean;
    error: string | null;
    persistenceWarning: string | null;
  };
  /** Auto-update status synced from the backend AutoUpdateService */
  autoUpdate: {
    status:
      | 'idle'
      | 'checking'
      | 'downloading'
      | 'ready'
      | 'not-available'
      | 'error'
      | 'manual-idle'
      | 'manual-checking'
      | 'manual-available'
      | 'manual-current'
      | 'manual-error'
      | 'unsupported';
    updateInfo: {
      releaseName?: string;
      releaseNotes?: string;
      /** Canonical GitHub release page used by manual community updates. */
      releasePageUrl?: string;
    } | null;
    errorMessage: string | null;
  };
  // The global configuration of the CLI.
  globalConfig: GlobalConfig;
  // Discovered notification sound packs (runtime, not persisted).
  notificationSoundPacks: {
    available: string[];
    displayNames: Record<string, string>;
  };
  // State of the current user experience (getting started etc.)
  userExperience: {
    storedExperienceData: StoredExperienceData;
    pendingOnboardingSuggestion: {
      id: string;
      url: string;
      prompt: string;
    } | null;
    devAppPreview: {
      isFullScreen: boolean;
      inShowCodeMode: boolean;
      customScreenSize: {
        width: number;
        height: number;
        presetName: string; // Preset can be a name like "mobile" or "iPhone 13" or whatever
      } | null;
    };
    experienceSurvey: ExperienceSurvey;
    founderCallSurvey: FounderCallSurvey;
  };
  // State of the notification service.
  notifications: {
    id: string;
    title: string | null;
    message: string | null;
    type: 'info' | 'warning' | 'error';
    duration?: number; // Duration in milliseconds. Will never auto-dismiss if not set.
    actions: {
      label: string;
      type: 'primary' | 'secondary' | 'destructive';
    }[]; // Allows up to three actions. Every action except for the first will be rendered as secondary. More than three actions will be ignored. Clicking on an action will also dismiss the notification.
  }[];

  // Terminal output buffers — active, keyed by terminalId.
  terminals: {
    outputBuffers: Record<string, string>;
    outputBufferOffsets: Record<
      string,
      { baseOffset: number; endOffset: number }
    >;
  };

  fileTree: {
    visible: boolean;
    activeWorkspaceKey: string | null;
    viewMode: 'files' | 'diff';
    expandedDirectoriesByWorkspaceKey: Record<string, string[]>;
    workspaceRevisions: Record<string, number>;
    directoryRevisions: Record<string, Record<string, number>>;
  };

  // Unified content tabs (browser + terminal + future tab types)
  contentTabs: {
    tabs: Record<string, TabState>;
    globalOrder: string[];
    agentOrders: Record<string, string[]>;
    activeTabId: string | null;
  };

  // Browsing runtime state (global, not per-tab)
  browsing: {
    sessionId: string;
    history: HistoryEntry[];
    contextSelectionMode: boolean;
    selectedElements: SelectedElement[];
    hoveredElement: SelectedElement | null;
  };

  // Browser state
  browser: {
    tabs: Record<string, TabState>;
    activeTabId: string | null;
    /** Unique identifier for the current browser process lifetime. Changes on restart. */
    sessionId: string;
    history: HistoryEntry[];
    contextSelectionMode: boolean;
    // Selected elements
    selectedElements: SelectedElement[];
    hoveredElement: SelectedElement | null;
    viewportSize: {
      top: number;
      left: number;
      width: number;
      height: number;
      scale: number;
    } | null;
    /** Last active tab ID per agent instance. Key is agentInstanceId, value is tab ID. */
    lastActiveTabPerAgent: Record<string, string>;
    /** Agent instance ID that was open last, persisted across restarts. */
    lastOpenAgentId: string | null;
  };

  // Downloads state for the control button
  // Contains running downloads + recent finished downloads (up to 5 total)
  downloads: {
    /** List of downloads to display (running + recent finished) */
    items: DownloadSummary[];
    /** Number of currently active downloads */
    activeCount: number;
    /** Whether there are finished downloads the user hasn't seen yet */
    hasUnseenDownloads: boolean;
    /** Timestamp when downloads were last marked as seen (null if never) */
    lastSeenAt: Date | null;
  };

  // User preferences (synced from PreferencesService)
  preferences: UserPreferences;

  // Available search engines (synced from WebDataService via PreferencesService)
  searchEngines: SearchEngine[];

  // Current system theme (light or dark) based on OS preference
  systemTheme: 'light' | 'dark';

  /** Deduplicated workspace mounts from all agent instances */
  workspaceMounts: MountEntry[];
  /** Workspace paths where a WORKSPACE.md agent is currently running */
  workspaceMdGenerating: Record<string, boolean>;
  /** Bundled plugin definitions (static, pushed once at startup) */
  plugins: PluginDefinition[];

  /** Skill definitions (builtins, workspace skills, plugin skills) */
  skills: SkillDefinitionUI[];

  /**
   * All global skills discovered from every global skill directory
   * (clodex, agents, codex, claude), regardless of enabled/disabled
   * state. Used by the Settings UI to render per-dir and per-skill
   * toggles. Each entry carries its mount prefix so the UI can group
   * by directory.
   */
  globalSkills: Array<{
    name: string;
    description: string;
    /** Mount prefix (e.g. `globalskills-codex`) identifying the dir. */
    mountPrefix: string;
  }>;

  /** Global plans (workspace-independent, from user-data/plans/) */
  plans: PlanEntry[];

  /** Global debug log channels (from user-data/logs/) */
  logChannels: LogChannelEntry[];
  /** Ingest server info — null when server not yet started */
  logIngest: { port: number; token: string } | null;
};
export type AuthStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'authentication_invalid'
  | 'server_unreachable';

export type ApiKeyValidationResult =
  | null
  | { success: true }
  | { success: false; error: string };

export type KartonContract = {
  state: AppState;
  serverProcedures: {
    agents: {
      create: (
        initialInputState?: string,
        modelId?: ModelId,
        toolApprovalMode?: ToolApprovalMode,
        workspacePaths?: string[],
        preserveWorkspacePaths?: boolean,
        agentType?: AgentTypes,
      ) => Promise<string>;
      resume: (agentId: string) => Promise<void>;
      fork: (agentId: string, throughMessageId?: string) => Promise<string>;
      archive: (agentId: string) => Promise<void>;
      unarchive: (agentId: string) => Promise<void>;
      setGoal: (
        agentId: string,
        objective: string,
        tokenBudget?: number | null,
        timeBudgetSeconds?: number | null,
      ) => Promise<void>;
      setGoalStatus: (agentId: string, status: TaskGoalStatus) => Promise<void>;
      clearGoal: (agentId: string) => Promise<void>;
      delete: (agentId: string) => Promise<void>;
      getAgentsHistoryList: (
        offset: number,
        limit: number,
        searchString?: string,
        archived?: boolean,
      ) => Promise<AgentHistoryEntry[]>;
      getChatProjects: (
        offset: number,
        limit: number,
        searchString?: string,
        archived?: boolean,
      ) => Promise<ChatProject[]>;
      getAgentHistoryEntriesByIds: (
        ids: string[],
      ) => Promise<AgentHistoryEntry[]>;
      updateInputState: (agentId: string, inputState: string) => Promise<void>;
      sendUserMessage: (
        agentId: string,
        message: AgentMessage & { role: 'user' },
      ) => Promise<SendUserMessageResult>;
      /** Queue a user message AND resolve a pending question in one atomic call. */
      interruptQuestionWithMessage: (
        agentId: string,
        questionId: string,
        message: AgentMessage & { role: 'user' },
        draftAnswers: Record<string, QuestionAnswerValue>,
      ) => Promise<SendUserMessageResult>;
      sendToolApprovalResponse: (
        instanceId: string,
        approvalId: string,
        approved: boolean,
        reason?: string,
      ) => Promise<void>;
      setToolApprovalMode: (
        instanceId: string,
        mode: ToolApprovalMode,
        /**
         * Optional UI surface that triggered the change. Forwarded to the
         * `tool-approval-mode-changed` telemetry event so analytics can
         * distinguish deliberate panel-combobox changes from inline
         * "Always allow" clicks made during an approval request.
         */
        source?: 'panel-combobox' | 'inline-approval-button',
      ) => Promise<void>;
      setFileEditApprovalMode: (
        instanceId: string,
        mode: FileEditApprovalMode,
      ) => Promise<void>;
      stop: (agentId: string) => Promise<void>;
      flushQueue: (agentId: string) => Promise<void>;
      clearQueue: (agentId: string) => Promise<void>;
      deleteQueuedMessage: (
        agentId: string,
        messageId: string,
      ) => Promise<void>;
      updateQueuedMessage: (
        agentId: string,
        messageId: string,
        message: AgentMessage & { role: 'user' },
      ) => Promise<'updated' | 'not-found'>;
      revertToUserMessage: (
        agentId: string,
        userMessageId: string,
        undoToolCalls: boolean,
      ) => Promise<void>;
      replaceUserMessage: (
        agentId: string,
        userMessageId: string,
        newMessage: AgentMessage & { role: 'user' },
        undoToolCalls: boolean,
      ) => Promise<string>;
      retryLastUserMessage: (agentId: string) => Promise<void>;
      markAsRead: (agentId: string) => Promise<void>;
      setActiveModelId: (agentId: string, modelId: ModelId) => Promise<void>;
      setTitle: (agentId: string, title: string) => Promise<void>;
      storeAttachment: (
        agentId: string,
        originalFileName: string,
        data: string,
      ) => Promise<string>;
      storeAttachmentByPath: (
        agentId: string,
        originalFileName: string,
        filePath: string,
      ) => Promise<string>;
      /** Fetch the full persisted row for a suspended/history agent (on-demand preview). */
      getStoredInstance: (
        agentId: string,
      ) => Promise<StoredAgentPreview | null>;
      /** Return distinct filepaths edited by an agent (from diff-history). */
      getTouchedFiles: (agentId: string) => Promise<string[]>;
      /**
       * Reveal the agent's per-instance data directory inside user-data
       * (e.g. `<userData>/clodex/agents/<id>/`) in the system file
       * manager. Used by the dev context-menu option — not the user's
       * mounted project workspace.
       */
      revealWorkingDirectory: (
        agentId: string,
      ) => Promise<{ success: boolean; error?: string }>;
    };
    toolbox: {
      acceptHunks: (hunkIds: string[]) => Promise<void>;
      rejectHunks: (hunkIds: string[]) => Promise<void>;
      acceptPendingEdit: (pendingEditId: string) => Promise<void>;
      rejectPendingEdit: (
        pendingEditId: string,
        feedback?: string,
      ) => Promise<void>;
      mountWorkspace: (
        agentInstanceId: string,
        workspacePath?: string,
        permissions?: MountPermission[],
      ) => Promise<void>;
      unmountWorkspace: (
        agentInstanceId: string,
        mountPrefix: string,
      ) => Promise<void>;
      getWorkspaceDiffSummary: (
        workspacePath: string,
      ) => Promise<MountedWorkspaceGitDiffSummary | null>;
      /**
       * Fetch the original and modified content for a file that appears
       * in the git diff, so the file-tree can open a Monaco DiffEditor.
       */
      getFileDiffContent: (
        workspacePath: string,
        filePath: string,
        staged: boolean,
        oldPath?: string,
      ) => Promise<FileDiffContent | null>;
      listGitBranchesByPath: (
        workspacePath: string,
        options?: { refresh?: boolean },
      ) => Promise<WorkspaceGitBranchesResult | null>;
      listGitWorktreesByPath: (
        workspacePath: string,
      ) => Promise<WorkspaceGitWorktreesResult | null>;
      getGitRepositoryRemoteUrlByPath: (
        workspacePath: string,
      ) => Promise<string | null>;
      switchGitBranchByPath: (
        workspacePath: string,
        branchName: string,
      ) => Promise<WorkspaceGitMutationResult>;
      createGitBranchByPath: (
        workspacePath: string,
        options: WorkspaceGitCreateBranchOptions,
      ) => Promise<WorkspaceGitMutationResult>;
      createGitWorktreeByPath: (
        workspacePath: string,
        options: WorkspaceGitCreateWorktreeOptions,
      ) => Promise<WorkspaceGitCreateWorktreeResult>;
      dismissWorkspaceGitCleanupPrompt: () => Promise<void>;
      cleanWorkspaceGitWorktrees: (
        paths: string[],
      ) => Promise<WorkspaceGitCleanupResult>;
      getGitWorktreeDeletionInfo: (
        path: string,
      ) => Promise<WorkspaceGitWorktreeDeletionInfo | null>;
      deleteGitWorktreeByPath: (
        path: string,
        options?: WorkspaceGitWorktreeDeleteOptions,
      ) => Promise<WorkspaceGitWorktreeDeleteResult>;
      listWorktreeSetupRepositories: () => Promise<WorktreeSetupRepositoriesResult>;
      saveWorktreeSetupScript: (
        mainWorktreePath: string,
        variant: WorktreeSetupScriptVariant,
        content: string,
      ) => Promise<SaveWorktreeSetupScriptResult>;
      deleteWorktreeSetupWorktree: (
        worktreePath: string,
      ) => Promise<DeleteWorktreeSetupWorktreeResult>;
      listWorkspaceGitBranches: (
        agentInstanceId: string,
        mountPrefix: string,
        options?: { refresh?: boolean },
      ) => Promise<WorkspaceGitBranchesResult | null>;
      listWorkspaceGitWorktrees: (
        agentInstanceId: string,
        mountPrefix: string,
      ) => Promise<WorkspaceGitWorktreesResult | null>;
      switchWorkspaceGitBranch: (
        agentInstanceId: string,
        mountPrefix: string,
        branchName: string,
      ) => Promise<WorkspaceGitMutationResult>;
      createWorkspaceGitBranch: (
        agentInstanceId: string,
        mountPrefix: string,
        options: WorkspaceGitCreateBranchOptions,
      ) => Promise<WorkspaceGitMutationResult>;
      createWorkspaceGitWorktree: (
        agentInstanceId: string,
        mountPrefix: string,
        options: WorkspaceGitCreateWorktreeOptions,
      ) => Promise<WorkspaceGitCreateWorktreeResult>;
      generateWorkspaceMd: (
        agentInstanceId: string,
        mountPrefix: string,
      ) => Promise<void>;
      /** Get context files for all workspaces */
      getContextFiles: () => Promise<ContextFilesResult>;
      /** Generate WORKSPACE.md for a workspace path (does not require agent instance) */
      generateWorkspaceMdForPath: (workspacePath: string) => Promise<void>;
      submitUserQuestionStep: (
        agentInstanceId: string,
        questionId: string,
        stepAnswers: Record<string, QuestionAnswerValue>,
      ) => Promise<void>;
      cancelUserQuestion: (
        agentInstanceId: string,
        questionId: string,
        reason: 'user_cancelled' | 'user_sent_message',
      ) => Promise<void>;
      goBackUserQuestion: (
        agentInstanceId: string,
        questionId: string,
      ) => Promise<void>;
      killShellSession: (
        agentInstanceId: string,
        sessionId: string,
      ) => Promise<void>;
      searchMentionFiles: (
        agentInstanceId: string,
        query: string,
      ) => Promise<MentionFileCandidate[]>;
      dismissActiveApp: (agentInstanceId: string) => Promise<void>;
      forwardAppMessage: (
        agentInstanceId: string,
        appId: string,
        pluginId: string | undefined,
        data: unknown,
      ) => Promise<void>;
      clearPendingAppMessage: (agentInstanceId: string) => Promise<void>;
      clearLogChannel: (filename: string) => Promise<void>;
      getClodexMcpStatus: (
        refresh?: boolean,
      ) => Promise<ClodexMcpCapabilityStatus>;
    };
    mcp: {
      /** Return a secret-free snapshot of configured MCP servers and health. */
      list: () => Promise<McpSettingsSnapshot>;
      /** Add or edit a user-managed MCP server. */
      upsert: (input: McpServerSettingsInput) => Promise<McpSettingsSnapshot>;
      /** Enable or disable a configured MCP server. */
      setEnabled: (
        serverId: string,
        enabled: boolean,
      ) => Promise<McpSettingsSnapshot>;
      /** Update server/tool approval policy without changing plugin transport. */
      setPolicy: (
        serverId: string,
        policy: McpSettingsPolicy,
      ) => Promise<McpSettingsSnapshot>;
      /** Remove a user/imported MCP server. */
      remove: (serverId: string) => Promise<McpSettingsSnapshot>;
      /** Connect an enabled MCP server. */
      connect: (serverId: string) => Promise<McpSettingsSnapshot>;
      /** Disconnect an MCP server without disabling it. */
      disconnect: (serverId: string) => Promise<McpSettingsSnapshot>;
      /** Restart an enabled MCP server. */
      restart: (serverId: string) => Promise<McpSettingsSnapshot>;
      /** Test a server and fetch its current tool list. */
      testConnection: (serverId: string) => Promise<McpConnectionTestResult>;
      /** Fetch tools with their effective approval decisions. */
      listTools: (serverId: string) => Promise<McpToolSettings[]>;
      /** Fetch all bounded resource descriptors across pagination. */
      listResources: (serverId: string) => Promise<McpResourceSettings[]>;
      /** Fetch all bounded resource templates across pagination. */
      listResourceTemplates: (
        serverId: string,
      ) => Promise<McpResourceTemplateSettings[]>;
      /** Read one resource through the isolated MCP host. */
      readResource: (input: McpReadResourceInput) => Promise<unknown>;
      /** Fetch all bounded prompt descriptors across pagination. */
      listPrompts: (serverId: string) => Promise<McpPromptSettings[]>;
      /** Resolve one server prompt with explicit string arguments. */
      getPrompt: (input: McpGetPromptInput) => Promise<unknown>;
      /** Fetch bounded, sanitized diagnostics for one server. */
      getLogs: (serverId: string) => Promise<McpServerLogSettings[]>;
      /** Store a named custom MCP secret in encrypted OS-backed storage. */
      setCustomCredential: (
        input: McpCustomCredentialInput,
      ) => Promise<McpSettingsSnapshot>;
      /** Delete one user-created MCP credential and all of its fields. */
      deleteCustomCredential: (
        credentialId: string,
      ) => Promise<McpSettingsSnapshot>;
      /** Parse a Claude Desktop config into a non-live preview. */
      previewClaudeDesktopImport: (
        sourcePath: string,
      ) => Promise<McpImportPreviewSettings>;
      /** Materialize only explicitly confirmed preview entries. */
      applyClaudeDesktopImport: (
        input: McpApplyImportInput,
      ) => Promise<McpSettingsSnapshot>;
    };
    swarm: {
      run: (agentInstanceId: string, prompt: string) => Promise<string>;
      preview: (agentInstanceId: string, prompt: string) => Promise<string>;
      clearRun: (runId: string) => Promise<void>;
    };
    userAccount: {
      sendOtp: (
        email: string,
        turnstileToken: string,
      ) => Promise<{ error?: string }>;
      verifyOtp: (email: string, code: string) => Promise<{ error?: string }>;
      signInSocial: (
        provider: SocialAuthProvider,
      ) => Promise<{ error?: string }>;
      signInEmail: () => Promise<{ error?: string }>;
      signInTelegram: () => Promise<{ error?: string }>;
      refreshStatus: () => Promise<void>;
      refreshKeys: () => Promise<void>;
      selectKey: (keyId: string) => Promise<{ error?: string }>;
      logout: () => Promise<void>;
      validateApiKeys: (keys: {
        anthropic?: string;
        openai?: string;
        google?: string;
        moonshotai?: string;
        alibaba?: string;
        deepseek?: string;
        'z-ai'?: string;
        minimax?: string;
        'xiaomi-mimo'?: string;
        mistral?: string;
      }) => Promise<{
        anthropic: ApiKeyValidationResult;
        openai: ApiKeyValidationResult;
        google: ApiKeyValidationResult;
        moonshotai: ApiKeyValidationResult;
        alibaba: ApiKeyValidationResult;
        deepseek: ApiKeyValidationResult;
        'z-ai': ApiKeyValidationResult;
        minimax: ApiKeyValidationResult;
        'xiaomi-mimo': ApiKeyValidationResult;
        mistral: ApiKeyValidationResult;
      }>;
    };
    userExperience: {
      devAppPreview: {
        toggleFullScreen: () => Promise<void>;
        toggleShowCodeMode: () => Promise<void>;
        changeScreenSize: (
          size: {
            width: number;
            height: number;
            presetName: string;
          } | null,
        ) => Promise<void>;
      };
      setHasSeenOnboardingFlow: (
        input:
          | boolean
          | {
              value: boolean;
              auth?: {
                auth_method:
                  | 'clodex'
                  | 'api-keys'
                  | 'coding-plan'
                  | 'local'
                  | 'unknown';
                provider?: ModelProvider;
                plan_id?:
                  | 'glm-coding-plan'
                  | 'kimi-plan'
                  | 'qwen-plan'
                  | 'minimax-plan'
                  | 'mimo-plan';
              };
              suggestion?: { id: string; url: string; prompt: string };
            },
      ) => Promise<void>;
      clearPendingOnboardingSuggestion: () => Promise<void>;
      tutorial: {
        setStep: (input: {
          tutorialId: string;
          stepIndex: number;
        }) => Promise<void>;
      };
      survey: {
        answer: (answer: 'yes' | 'no') => Promise<void>;
        dismiss: () => Promise<void>;
        submitFeedback: (feedback: string) => Promise<void>;
      };
      founderCall: {
        survey: {
          open: () => Promise<void>;
          dismiss: () => Promise<void>;
        };
      };
    };
    filePicker: {
      createRequest: (request: FilePickerRequest) => Promise<string[]>;
    };
    notifications: {
      triggerAction: (id: string, actionIndex: number) => Promise<void>;
      dismiss: (id: string) => Promise<void>;
    };
    closedLidSleep: {
      toggle: () => Promise<{
        isSupported: boolean;
        isSleepDisabled: boolean;
        ownedByClodex: boolean;
        isChanging: boolean;
        error: string | null;
        persistenceWarning: string | null;
      }>;
      refresh: () => Promise<{
        isSupported: boolean;
        isSleepDisabled: boolean;
        ownedByClodex: boolean;
        isChanging: boolean;
        error: string | null;
        persistenceWarning: string | null;
      }>;
    };
    autoUpdate: {
      /** Manually trigger an update check */
      checkForUpdates: () => Promise<void>;
      /** Quit the app and install the downloaded update */
      quitAndInstall: () => Promise<void>;
    };
    config: {
      set: (config: Partial<GlobalConfig>) => Promise<void>;
      previewSoundPack: (
        packId: string,
        loudness: 'off' | 'subtle' | 'default',
      ) => Promise<{ ok: boolean }>;
      importSoundPack: () => Promise<
        | { id: string; name: string; error?: never }
        | { id?: never; name?: never; error: string }
      >;
    };
    telemetry: {
      capture: (
        eventName: string,
        properties?: Record<string, unknown>,
      ) => Promise<void>;
    };
    browser: {
      createTab: (
        url?: string,
        setActive?: boolean,
        agentInstanceId?: string | null,
      ) => Promise<string | undefined>;
      closeTab: (tabId: string) => Promise<void>;
      clearFileNotice: (tabId: string) => Promise<void>;
      switchTab: (tabId: string) => Promise<void>;
      reorderTabs: (tabIds: string[]) => Promise<void>;
      /**
       * Legacy alias for `browser.layout.movePanelToForeground`. Some
       * production client builds reference the flat `browser.` path
       * without the `layout` intermediate namespace.
       */
      movePanelToForeground: (
        panel: 'clodex-ui' | 'tab-content',
      ) => Promise<void>;
      layout: {
        // This is called when the webcontents view is resized or moved or whatever. It's used to notify the main window about the new bounds that the webcontents view should have.
        update: (
          bounds: {
            x: number;
            y: number;
            width: number;
            height: number;
          } | null,
        ) => Promise<void>;
        togglePanelKeyboardFocus: (
          panel: 'clodex-ui' | 'tab-content',
        ) => Promise<void>;
        movePanelToForeground: (
          panel: 'clodex-ui' | 'tab-content',
        ) => Promise<void>;
      };
      stop: (tabId?: string) => Promise<void>;
      reload: (tabId?: string) => Promise<void>;
      /**
       * Trust a certificate for a specific origin in a tab and reload.
       * This adds the origin to a per-tab whitelist that allows certificate errors.
       * The whitelist is cleared when the tab is closed.
       */
      trustCertificateAndReload: (
        tabId: string,
        origin: string,
      ) => Promise<void>;
      goto: (
        url: string,
        tabId?: string,
        transition?: PageTransition,
      ) => Promise<void>;
      goBack: (tabId?: string) => Promise<void>;
      goForward: (tabId?: string) => Promise<void>;
      devTools: {
        toggle: (tabId?: string) => Promise<void>;
        open: (tabId?: string) => Promise<void>;
        close: (tabId?: string) => Promise<void>;
        chrome: {
          toggle: (tabId?: string) => Promise<void>;
          open: (tabId?: string) => Promise<void>;
          close: (tabId?: string) => Promise<void>;
        };
        /**
         * Capture a screenshot of a tab using the Chrome DevTools Protocol.
         * Returns base64-encoded image data (without data URL prefix).
         */
        getScreenshot: (options?: {
          /** The tab ID to capture. If not provided, uses the active tab. */
          tabId?: string;
          /** Image format (default: 'png') */
          format?: 'png' | 'jpeg' | 'webp';
          /** Image quality (0-100) for jpeg/webp formats (default: 80) */
          quality?: number;
          /** Capture the full page (scrollable area) instead of just the viewport */
          fullPage?: boolean;
          /** Clip area to capture (in CSS pixels) */
          clip?: {
            x: number;
            y: number;
            width: number;
            height: number;
          };
        }) => Promise<{
          success: boolean;
          /** Base64-encoded image data (without data URL prefix) */
          data?: string;
          error?: string;
        }>;
      };
      setAudioMuted: (muted: boolean, tabId?: string) => Promise<void>;
      toggleAudioMuted: (tabId?: string) => Promise<void>;
      setColorScheme: (scheme: ColorScheme, tabId?: string) => Promise<void>;
      cycleColorScheme: (tabId?: string) => Promise<void>;
      setZoomPercentage: (percentage: number, tabId?: string) => Promise<void>;
      /** Set the agent instance ID this tab is attached to (null = globally visible) */
      setTabAgentInstance: (
        tabId: string,
        agentInstanceId: string | null,
      ) => Promise<void>;
      /** Persist the last-opened agent instance ID for restoration on restart. */
      setLastOpenAgentId: (agentId: string | null) => Promise<void>;
      contextSelection: {
        setActive: (active: boolean) => Promise<void>;
        setMouseCoordinates: (x: number, y: number) => Promise<void>; // Used by the client to communicate where the mouse is currently located. Will be forwarded to the tab to check which element is at that point.
        clearMouseCoordinates: () => Promise<void>; // Clears the mouse position to stop hit testing when mouse leaves the selector bounds
        passthroughWheelEvent: (event: {
          type: 'wheel';
          x: number;
          y: number;
          deltaX: number;
          deltaY: number;
        }) => Promise<void>; // Used by the client to pass through wheel events to the tab.
        selectHoveredElement: () => Promise<void>; // If the user triggers the element to actually be selected as context, this will trigger a storage operation on the server side.
        removeElement: (elementId: string) => Promise<void>;
        clearElements: () => Promise<void>; // Removes all elements from selection
        clearPendingScreenshots: () => Promise<void>; // Clears pending element screenshots after UI has picked them up
        /** Restore selected elements directly (used when restoring aborted message to input) */
        restoreElements: (elements: SelectedElement[]) => Promise<void>;
        /**
         * Capture an element screenshot, convert to WebP, and store as an agent attachment.
         * Returns the blob key of the stored screenshot file, or null if capture fails.
         */
        captureAndStoreElementScreenshot: (
          agentId: string,
          tabId: string,
          boundingRect: {
            top: number;
            left: number;
            width: number;
            height: number;
          },
          isMainFrame: boolean,
          frameId: string | undefined,
          screenshotFileName: string,
        ) => Promise<string | null>;
      };
      scrollToElement: (
        tabId: string,
        backendNodeId: number,
        frameId: string,
      ) => Promise<void>; // Scrolls to an element in the specified tab
      checkFrameValidity: (
        tabId: string,
        frameId: string,
        expectedFrameLocation: string,
      ) => Promise<boolean>; // Checks if a frame exists and is at the expected location
      checkElementExists: (
        tabId: string,
        backendNodeId: number,
        frameId: string,
      ) => Promise<boolean>; // Checks if an element exists in the DOM
      searchInPage: {
        start: (searchText: string, tabId?: string) => Promise<void>;
        updateText: (searchText: string, tabId?: string) => Promise<void>;
        next: (tabId?: string) => Promise<void>;
        previous: (tabId?: string) => Promise<void>;
        stop: (tabId?: string) => Promise<void>;
      };
      searchBar: {
        activate: () => Promise<void>;
        deactivate: () => Promise<void>;
      };
      permissions: {
        /** Accept a simple permission request (yes/no permissions) - session only */
        accept: (requestId: string) => Promise<void>;
        /** Reject a permission request - session only */
        reject: (requestId: string) => Promise<void>;
        /** Select a device for device-selection permission requests (Bluetooth, HID, Serial, USB) */
        selectDevice: (requestId: string, deviceId: string) => Promise<void>;
        /** Respond to Bluetooth pairing request (with optional PIN for providePin mode) */
        respondToPairing: (
          requestId: string,
          confirmed: boolean,
          pin?: string,
        ) => Promise<void>;
        /** Always allow - grants permission AND saves to preferences for future requests from this origin */
        alwaysAllow: (requestId: string) => Promise<void>;
        /** Always block - denies permission AND saves to preferences for future requests from this origin */
        alwaysBlock: (requestId: string) => Promise<void>;
      };
      auth: {
        /** Submit credentials for an HTTP Basic Auth request */
        submit: (
          requestId: string,
          username: string,
          password: string,
        ) => Promise<void>;
        /** Cancel an HTTP Basic Auth request */
        cancel: (requestId: string) => Promise<void>;
      };
      /** Create a new user-controlled terminal tab. */
      createTerminal: (
        cwd?: string,
        agentInstanceId?: string | null,
      ) => Promise<string | null>;
      /**
       * Copy text to the system clipboard.
       *
       * Routed through the main process because the UI renderer's
       * `navigator.clipboard` rejects when focus lives inside a web-content
       * view (a separate WebContentsView), which silently dropped writes.
       */
      copyText: (text: string) => Promise<void>;
      /** Write keystroke data to a terminal's PTY. */
      terminalInput: (terminalId: string, data: string) => Promise<void>;
      /** Resize a terminal's PTY dimensions. */
      terminalResize: (
        terminalId: string,
        cols: number,
        rows: number,
      ) => Promise<void>;
      /** Snapshot the backend-owned terminal presentation state. */
      getTerminalSnapshot: (terminalId: string) => Promise<{
        state: string | null;
        baseOffset: number;
        endOffset: number;
        cols: number;
        rows: number;
      }>;
      /** Add a custom search engine */
      addSearchEngine: (
        input: AddSearchEngineInput,
      ) => Promise<AddSearchEngineResult>;
      /** Remove a custom search engine */
      removeSearchEngine: (id: number) => Promise<RemoveSearchEngineResult>;
      /** Clear browsing data */
      clearBrowsingData: (
        options: ClearBrowsingDataOptions,
      ) => Promise<ClearBrowsingDataResult>;
      /** Query browsing history with optional text search and pagination */
      getHistory: (filter: HistoryFilter) => Promise<HistoryResult[]>;
      /** Get base64-encoded favicon bitmaps for a list of favicon URLs */
      getFaviconBitmaps: (
        faviconUrls: string[],
      ) => Promise<Record<string, FaviconBitmapResult>>;
    };
    credentials: {
      /** Store credential data for a registered type */
      set: (typeId: string, data: Record<string, string>) => Promise<void>;
      /** Remove stored credential data */
      delete: (typeId: string) => Promise<void>;
      /** Return the list of credential type IDs that have stored data */
      getConfiguredIds: () => Promise<string[]>;
    };
    remoteConnections: {
      /** List saved SSH connection profiles and current runtime status. */
      list: () => Promise<RemoteConnectionsListResult>;
      /** Create or update one encrypted SSH connection profile. */
      save: (
        input: RemoteConnectionInput,
      ) => Promise<SaveRemoteConnectionResult>;
      /** Delete a saved SSH connection profile. */
      delete: (id: string) => Promise<DeleteRemoteConnectionResult>;
      /** Verify authentication and host reachability without keeping a session. */
      test: (id: string) => Promise<RemoteConnectionOperationResult>;
      /** Start a persistent SSH control session. */
      connect: (id: string) => Promise<RemoteConnectionOperationResult>;
      /** Replace the current SSH control session with a fresh connection. */
      reconnect: (id: string) => Promise<RemoteConnectionOperationResult>;
      /** Close a persistent SSH control session. */
      disconnect: (id: string) => Promise<RemoteConnectionOperationResult>;
      /** Open the connected profile in Clodex's integrated terminal. */
      openTerminal: (id: string) => Promise<OpenRemoteTerminalResult>;
      /** Select or clear the saved connection used by the SSH runner. */
      setRunnerConnection: (
        id: string | null,
      ) => Promise<RemoteRunnerSelectionResult>;
      /** Show a native file picker for an SSH private key. */
      selectIdentityFile: () => Promise<string | null>;
    };
    dockerRunnerProfiles: {
      /** List persisted Docker profiles and the effective runtime source. */
      list: () => Promise<DockerRunnerProfilesSnapshot>;
      /** Create or update one digest-pinned Docker runner profile. */
      save: (
        input: DockerRunnerProfileInput,
      ) => Promise<SaveDockerRunnerProfileResult>;
      /** Delete a persisted Docker runner profile. */
      delete: (id: string) => Promise<DeleteDockerRunnerProfileResult>;
      /** Verify that the local Docker daemon is available. */
      test: (id: string) => Promise<DockerRunnerProfileOperationResult>;
      /** Select or clear the profile used by the Docker runner. */
      setSelected: (
        id: string | null,
      ) => Promise<DockerRunnerProfileSelectionResult>;
    };
    pluginMarketplace: {
      /** Return the verified official catalog and local lockfile state. */
      getState: () => Promise<PluginMarketplaceState>;
      /** Re-read and verify the bundled signed official metadata index. */
      refresh: () => Promise<PluginMarketplaceState>;
      /** Install a catalog plugin through staging and atomic activation. */
      install: (pluginId: string) => Promise<PluginMarketplaceOperationResult>;
      /** Update an installed plugin, rolling back on activation failure. */
      update: (pluginId: string) => Promise<PluginMarketplaceOperationResult>;
      /** Uninstall a marketplace-managed plugin with rollback protection. */
      uninstall: (
        pluginId: string,
      ) => Promise<PluginMarketplaceOperationResult>;
      privateSources: {
        /** List private marketplace sources without exposing pinned PEM keys. */
        list: () => Promise<PrivateMarketplaceSourcesState>;
        /** Add or update an encrypted source with an explicitly pinned key. */
        save: (
          input: PrivateMarketplaceSourceInput,
        ) => Promise<PrivateMarketplaceSourcePublic>;
        /** Remove one private marketplace source. */
        remove: (id: string) => Promise<PrivateMarketplaceSourcesState>;
        /** Enable or disable one private marketplace source. */
        setEnabled: (
          id: string,
          enabled: boolean,
        ) => Promise<PrivateMarketplaceSourcePublic>;
        /** Fetch and verify one private marketplace index against its pin. */
        refresh: (id: string) => Promise<PrivateMarketplaceSourcePublic>;
        /** Install one plugin from a specific verified private source. */
        install: (
          sourceId: string,
          pluginId: string,
        ) => Promise<PrivateMarketplaceOperationResult>;
        /** Update one plugin only from its original private source. */
        update: (
          sourceId: string,
          pluginId: string,
        ) => Promise<PrivateMarketplaceOperationResult>;
        /** Uninstall one plugin only when its source provenance matches. */
        uninstall: (
          sourceId: string,
          pluginId: string,
        ) => Promise<PrivateMarketplaceOperationResult>;
      };
    };
    cloudTasks: {
      artifacts: {
        open: (
          identity: CloudTaskArtifactIdentity,
        ) => Promise<CloudTaskArtifactActionResult>;
        reveal: (
          identity: CloudTaskArtifactIdentity,
        ) => Promise<CloudTaskArtifactActionResult>;
        export: (
          identity: CloudTaskArtifactIdentity,
        ) => Promise<CloudTaskArtifactActionResult>;
      };
      continueLocally: (
        agentInstanceId: string,
      ) => Promise<CloudTaskTeleportActionResult>;
      resumeInCloud: (
        agentInstanceId: string,
      ) => Promise<CloudTaskTeleportActionResult>;
      retryMemorySync: (
        agentInstanceId: string,
      ) => Promise<CloudTaskTeleportActionResult>;
      resolveMemoryDivergence: (
        agentInstanceId: string,
        strategy: CloudTaskMemoryDivergenceResolution,
      ) => Promise<CloudTaskTeleportActionResult>;
      exportMemorySyncDiagnostics: (
        agentInstanceId: string,
      ) => Promise<CloudTaskMemorySyncExportResult>;
    };
    automations: {
      getSnapshot: () => Promise<AutomationSnapshot>;
      create: (
        input: CreateAutomationInput,
      ) => Promise<AutomationOperationResult>;
      update: (
        input: UpdateAutomationInput,
      ) => Promise<AutomationOperationResult>;
      delete: (id: string) => Promise<AutomationOperationResult>;
      runNow: (id: string) => Promise<AutomationOperationResult>;
      setEnabled: (
        id: string,
        enabled: boolean,
      ) => Promise<AutomationOperationResult>;
    };
    artifactBridge: {
      getGrant: (
        context: ArtifactBridgeContext,
        sessionId?: string,
      ) => Promise<ArtifactBridgeGrant | null>;
      getActiveSessions: (
        context: ArtifactBridgeContext,
      ) => Promise<ArtifactBridgeSessionSnapshot[]>;
      getRuntimeInspector: (
        context: ArtifactBridgeContext,
      ) => Promise<ArtifactBridgeRuntimeInspectorSnapshot>;
      openGrantReview: (
        context: ArtifactBridgeContext,
        selection: ArtifactBridgeGrantReviewSelection,
      ) => Promise<ArtifactBridgeGrantReviewSnapshot>;
      submitGrantReview: (
        submission: ArtifactBridgeGrantReviewSubmission,
      ) => Promise<ArtifactBridgeGrant>;
      revokeGrant: (
        context: ArtifactBridgeContext,
        scope?: ArtifactBridgeGrantRevokeScope,
      ) => Promise<void>;
      getPolicy: (
        context: ArtifactBridgeContext,
      ) => Promise<ArtifactBridgePolicy>;
      approveWrite: (
        context: ArtifactBridgeContext,
        proposalId: string,
        sessionId?: string,
      ) => Promise<ArtifactBridgeWriteApproval>;
      rejectWrite: (
        context: ArtifactBridgeContext,
        proposalId: string,
        sessionId?: string,
      ) => Promise<void>;
      approveSensitiveMcpCall: (
        context: ArtifactBridgeContext,
        proposalId: string,
        sessionId?: string,
      ) => Promise<ArtifactBridgeSensitiveMcpApproval>;
      rejectSensitiveMcpCall: (
        context: ArtifactBridgeContext,
        proposalId: string,
        sessionId?: string,
      ) => Promise<void>;
    };
    spaces: {
      getSnapshot: () => Promise<SpacesSnapshot>;
      create: (input: CreateSpaceInput) => Promise<SpaceDefinition>;
      update: (input: UpdateSpaceInput) => Promise<SpaceDefinition>;
      delete: (id: string) => Promise<void>;
      importProjects: () => Promise<SpacesSnapshot>;
    };
    sessionContinuity: {
      getReadiness: (sessionId: string) => Promise<SessionContinuityReadiness>;
      teleport: (input: SessionTeleportInput) => Promise<{ agentId: string }>;
      getShares: () => Promise<SessionShareSnapshot>;
      createShare: (
        input: CreateSessionShareInput,
      ) => Promise<SessionShareRecord>;
      revokeShare: (shareId: string) => Promise<SessionShareRecord>;
    };
    fileTree: {
      listDirectory: (
        input: FileTreeListDirectoryInput,
      ) => Promise<FileTreeListDirectoryResult>;
      getFilePreview: (
        workspaceKey: string,
        relativePath: string,
      ) => Promise<FilePreviewResult | null>;
      /**
       * Cheap stat used to revalidate an already-loaded file without reading
       * its contents. Returns null when the file no longer exists.
       */
      getFileStat: (
        workspaceKey: string,
        relativePath: string,
      ) => Promise<FileStatResult | null>;
      /**
       * Persist `text` to disk. When `expectedMtimeMs` is provided and the
       * on-disk modification time no longer matches it, the save is rejected
       * with {@link FILE_SAVE_CONFLICT_CODE} instead of overwriting the
       * external change. Pass `null`/omit to force-write (overwrite).
       */
      saveFile: (
        workspaceKey: string,
        relativePath: string,
        text: string,
        expectedMtimeMs?: number | null,
      ) => Promise<FilePreviewResult | null>;
      openFileTab: (
        workspaceKey: string,
        relativePath: string,
        agentInstanceId?: string | null,
        options?: OpenFileTabOptions,
      ) => Promise<string | null>;
      /**
       * Open an agent attachment blob (stored under `att/`) as a read-only
       * file tab. The backend resolves the per-agent blob directory, so the
       * renderer only needs the agent id and attachment (blob) id.
       */
      openAttachmentTab: (
        agentId: string,
        attachmentId: string,
        displayName?: string,
        agentInstanceId?: string | null,
        options?: OpenFileTabOptions,
      ) => Promise<string | null>;
      promoteFileTab: (tabId: string) => Promise<void>;
      renameEntry: (
        workspaceKey: string,
        relativePath: string,
        newName: string,
      ) => Promise<FileTreeOperationResult>;
      pasteEntry: (
        sourceWorkspaceKey: string,
        sourceRelativePath: string,
        targetWorkspaceKey: string,
        targetDirectoryPath: string,
        operation: FileTreeClipboardOperation,
        preferredName?: string,
      ) => Promise<FileTreeOperationResult>;
      deleteEntry: (
        workspaceKey: string,
        relativePath: string,
      ) => Promise<FileTreeOperationResult>;
      revealInFolder: (
        workspaceKey: string,
        relativePath: string,
      ) => Promise<{ success: boolean; error?: string }>;
      setVisible: (visible: boolean) => Promise<void>;
      setActiveWorkspace: (workspaceKey: string | null) => Promise<void>;
      setViewMode: (mode: 'files' | 'diff') => Promise<void>;
      createFile: (
        workspaceKey: string,
        directoryPath: string,
      ) => Promise<FileTreeOperationResult>;
      recreateDeletedFile: (
        workspaceKey: string,
        relativePath: string,
        content: string,
      ) => Promise<FileTreeOperationResult>;
      setDirectoryExpanded: (
        workspaceKey: string,
        directoryPath: string,
        expanded: boolean,
      ) => Promise<void>;
      searchFiles: (
        query: string,
        workspaceKeys: string[],
        includeGitignored: boolean,
        searchInContent?: boolean,
      ) => Promise<FileSearchResult[]>;
      listRecentFiles: (
        workspaceKeys: string[],
        includeGitignored: boolean,
        limit: number,
      ) => Promise<FileSearchResult[]>;
    };
    downloads: {
      /** Mark all current downloads as seen (updates lastSeenAt timestamp) */
      markSeen: () => Promise<void>;
      /** Pause an active download */
      pause: (
        downloadId: number,
      ) => Promise<{ success: boolean; error?: string }>;
      /** Resume a paused download */
      resume: (
        downloadId: number,
      ) => Promise<{ success: boolean; error?: string }>;
      /** Cancel an active download */
      cancel: (
        downloadId: number,
      ) => Promise<{ success: boolean; error?: string }>;
      /** Open a downloaded file using the system default application */
      openFile: (
        filePath: string,
      ) => Promise<{ success: boolean; error?: string }>;
      /** Show a downloaded file in the system file manager (Finder/Explorer) */
      showInFolder: (
        filePath: string,
      ) => Promise<{ success: boolean; error?: string }>;
      /** Delete a download record and its file */
      delete: (
        downloadId: number,
      ) => Promise<{ success: boolean; error?: string }>;
    };
    preferences: {
      /** Update user preferences by applying Immer patches */
      update: (patches: Patch[]) => Promise<void>;
      /** Create or update a provider-neutral profile and optional secret. */
      saveProviderProfile: (
        input: ProviderProfileSaveInput,
      ) => Promise<ProviderProfile>;
      /** Delete a provider profile and its stored credential. */
      deleteProviderProfile: (profileId: string) => Promise<void>;
      /** Select the enabled provider used for new chats. */
      setDefaultProviderProfile: (profileId: string) => Promise<void>;
      /** Validate the selected profile without mutating provider data. */
      testProviderProfile: (
        profileId: string,
      ) => Promise<ProviderValidationResult>;
      /** Refresh the dynamic model catalog for one profile. */
      listProviderProfileModels: (profileId: string) => Promise<AIModelInfo[]>;
      /** Set an encrypted API key for a provider */
      setProviderApiKey: (
        provider: ModelProvider,
        apiKey: string,
      ) => Promise<void>;
      /** Clear the API key for a provider */
      clearProviderApiKey: (provider: ModelProvider) => Promise<void>;
      /** Set an encrypted API key for a custom endpoint */
      setCustomEndpointApiKey: (
        endpointId: string,
        apiKey: string,
      ) => Promise<void>;
      /** Clear the API key for a custom endpoint */
      clearCustomEndpointApiKey: (endpointId: string) => Promise<void>;
      /** Set an encrypted secret key for a custom endpoint */
      setCustomEndpointSecretKey: (
        endpointId: string,
        secretKey: string,
      ) => Promise<void>;
      /** Set encrypted Google credentials JSON for a custom endpoint */
      setCustomEndpointGoogleCredentials: (
        endpointId: string,
        credentials: string,
      ) => Promise<void>;
      /** Enumerate AWS profiles */
      listAwsProfiles: () => Promise<{
        profiles: Array<{
          name: string;
          region?: string;
          /** IAM Identity Center portal region, not a Bedrock service region. */
          ssoRegion?: string;
        }>;
        envRegion?: string;
        error?: string;
      }>;
      /** Validate a provider API key */
      validateProviderApiKey: (
        provider: ModelProvider,
        apiKey: string,
        baseUrl?: string,
      ) => Promise<ApiKeyValidationResult>;
      /**
       * Atomically disconnect a provider: clear the encrypted API key and
       * flip the provider's endpoint mode back to `'clodex'` in a single
       * patch update.
       */
      disconnectProvider: (provider: ModelProvider) => Promise<void>;
      /**
       * Atomically connect a Tier-A coding plan.
       */
      connectCodingPlan: (
        planId: CodingPlanId,
        apiKey: string,
      ) => Promise<{ success: true } | { success: false; error: string }>;
      /**
       * Atomically connect a provider's own API key.
       */
      connectProvider: (
        provider: ModelProvider,
        apiKey: string,
      ) => Promise<{ success: true } | { success: false; error: string }>;
    };
    memoryNotes: {
      getStats: () => Promise<MemoryNotesStats>;
      setRetention: (
        retention: MemoryNotesRetention,
      ) => Promise<MemoryNotesRetentionResult>;
      exportToFile: (
        scope: MemoryNotesManagementScope,
      ) => Promise<MemoryNotesExportResult>;
      reset: (
        scope: MemoryNotesManagementScope,
      ) => Promise<MemoryNotesResetResult>;
    };
    networkEgressControl: {
      getSnapshot: (
        input?: NetworkEgressSnapshotInput,
      ) => Promise<NetworkEgressControlSnapshot>;
      addGrant: (
        input: NetworkEgressGrantInput,
      ) => Promise<NetworkEgressControlSnapshot>;
      revokeGrant: (grantId: string) => Promise<NetworkEgressControlSnapshot>;
      exportAudit: () => Promise<NetworkEgressAuditExportResult>;
    };
    evidenceMemoryInspector: {
      getSnapshot: (
        input: EvidenceMemoryInspectorSnapshotInput,
      ) => Promise<EvidenceMemoryInspectorSnapshot>;
      search: (
        input: EvidenceMemoryInspectorSearchInput,
      ) => Promise<EvidenceMemoryClaimSearchHit[]>;
      getClaimDetails: (
        input: EvidenceMemoryClaimDetailsInput,
      ) => Promise<EvidenceMemoryClaimDetails>;
      resolveConflict: (
        input: EvidenceMemoryConflictResolutionInput,
      ) => Promise<EvidenceMemoryConflictResolution>;
      undoConflictResolution: (
        input: EvidenceMemoryConflictResolutionUndoInput,
      ) => Promise<EvidenceMemoryConflictResolution>;
      evaluateDogfood: (
        input: EvidenceMemoryDogfoodEvaluationInput,
      ) => Promise<EvidenceMemoryDogfoodReport>;
      getDogfoodDashboard: () => Promise<EvidenceMemoryDogfoodCohortReport>;
      getReadinessDashboard: (
        input: EvidenceMemoryReadinessInput,
      ) => Promise<EvidenceMemoryReadinessDashboard>;
      evaluateReadiness: (
        input: EvidenceMemoryReadinessInput,
      ) => Promise<EvidenceMemoryReadinessEvaluationResult>;
      runDogfoodBackfill: (
        input: EvidenceMemoryDogfoodBackfillInput,
      ) => Promise<EvidenceMemoryDogfoodBackfillResult>;
      exportToFile: (
        taskId: string,
      ) => Promise<EvidenceMemoryInspectorExportResult>;
      resetTask: (
        taskId: string,
      ) => Promise<EvidenceMemoryInspectorResetResult>;
    };
    dictation: {
      getDiagnostics: () => Promise<DictationBackendDiagnostics>;
      negotiateRealtime: (
        input: DictationRealtimeNegotiationInput,
      ) => Promise<DictationRealtimeNegotiationResult>;
      transcribe: (
        input: DictationTranscriptionInput,
      ) => Promise<DictationTranscriptionResult>;
      cancel: (requestId: string) => Promise<void>;
    };
    agentOs: {
      chronicle: {
        setEnabled: (enabled: boolean) => Promise<void>;
        setSettings: (settings: {
          retention?: ChronicleRetention;
          privacyMode?: ChroniclePrivacyMode;
        }) => Promise<void>;
        captureNow: () => Promise<ChronicleEvent>;
        captureManual: (text: string) => Promise<ChronicleEvent>;
        search: (query: string) => Promise<ChronicleEvent[]>;
        getRecent: (limit: number) => Promise<ChronicleEvent[]>;
        summarizeLastWindow: (durationMs: number) => Promise<ChronicleEvent>;
        clear: () => Promise<void>;
      };
      micro: {
        setEnabled: (enabled: boolean) => Promise<void>;
        setActions: (actions: CodexMicroAction[]) => Promise<void>;
        setPosition: (position: CodexMicroPosition | null) => Promise<void>;
        setExpanded: (expanded: boolean) => Promise<void>;
        setPushToTalkActive: (active: boolean) => Promise<void>;
        triggerAction: (actionId: string) => Promise<CodexMicroAction>;
      };
      browserUse: {
        setEnabled: (enabled: boolean) => Promise<void>;
        setOriginPolicy: (
          policy: BrowserUseOriginPolicy,
        ) => Promise<BrowserUseOriginPolicy>;
        removeOriginPolicy: (origin: string) => Promise<void>;
        getDecision: (
          origin: string,
          capability: BrowserUseCapability,
        ) => Promise<BrowserUseApprovalMode>;
        resolveApproval: (
          approvalId: string,
          response: BrowserUseApprovalResponse,
        ) => Promise<void>;
      };
      desktop: {
        setEnabled: (enabled: boolean) => Promise<void>;
        refreshPermissions: () => Promise<DesktopAutomationPermissions>;
        requestPermission: (
          permission: DesktopAutomationPermissionKind,
        ) => Promise<DesktopAutomationPermissions>;
        openPermissionSettings: (
          permission: DesktopAutomationPermissionKind,
        ) => Promise<void>;
        getFrontmostApp: () => Promise<DesktopAutomationApp>;
        setAppPolicy: (
          app: DesktopAutomationApp,
          mode: DesktopAutomationAppPolicyMode,
        ) => Promise<DesktopAutomationAppPolicy>;
        removeAppPolicy: (bundleId: string) => Promise<void>;
        startSession: () => Promise<string>;
        stopSession: () => Promise<void>;
        engageKillSwitch: () => Promise<void>;
        resetKillSwitch: () => Promise<void>;
        resolveApproval: (
          approvalId: string,
          response: DesktopAutomationApprovalResponse,
        ) => Promise<void>;
      };
      debug: {
        setEnabled: (enabled: boolean) => Promise<void>;
        setPaused: (paused: boolean) => Promise<void>;
        clear: () => Promise<void>;
        exportJson: () => Promise<string>;
      };
      guardian: {
        submitFeedback: (
          assessmentId: string,
          feedback: GuardianFeedbackLabel,
        ) => Promise<GuardianDogfoodAssessment | null>;
        clearRecent: () => Promise<void>;
      };
      skills: {
        inspect: (sourcePath: string) => Promise<SkillInstallPreview>;
        pickPackage: () => Promise<SkillInstallPreview | null>;
        installFromPath: (
          sourcePath: string,
          replaceExisting?: boolean,
        ) => Promise<SkillInstallRecord>;
        uninstall: (skillId: string) => Promise<void>;
        listInstalled: () => Promise<SkillInstallRecord[]>;
      };
      hooks: {
        create: (
          hook: Omit<HookDefinition, 'id' | 'createdAt' | 'updatedAt'>,
        ) => Promise<HookDefinition>;
        update: (
          hookId: string,
          patch: Partial<HookDefinition>,
        ) => Promise<HookDefinition>;
        delete: (hookId: string) => Promise<void>;
        run: (
          trigger: HookTrigger,
          context?: {
            values?: Record<string, unknown>;
            manualHookId?: string;
          },
        ) => Promise<HookRunResult>;
      };
      remote: {
        setEnabled: (enabled: boolean) => Promise<void>;
        setAllowRemoteCommands: (allowed: boolean) => Promise<void>;
        startPairing: () => Promise<{
          code: string;
          expiresAt: number;
          pairingUrl: string;
        }>;
        cancelPairing: () => Promise<void>;
        revokeClient: (clientId: string) => Promise<void>;
        resolveCommandApproval: (
          approvalId: string,
          approved: boolean,
        ) => Promise<void>;
        generateAttestation: (
          challenge?: string,
        ) => Promise<RemoteControlEnvironmentAttestation>;
      };
    };
    devToolbar: {
      /** Update the global widget order */
      updateWidgetOrder: (order: WidgetId[]) => Promise<void>;
      /** Update settings for a specific origin */
      updateOriginSettings: (
        origin: string,
        settings: Partial<Omit<DevToolbarOriginSettings, 'lastAccessedAt'>>,
      ) => Promise<void>;
      /** Get or create settings for an origin (creates from last used origin if new) */
      getOrCreateOriginSettings: (
        origin: string,
      ) => Promise<DevToolbarOriginSettings>;
    };
    /** Get omnibox suggestions based on input (history entries and search terms) */
    getOmniboxSuggestions: (input: string) => Promise<OmniboxSuggestions>;
    /**
     * Open an http(s) URL with the OS default handler (shell.openExternal).
     * Used by the onboarding flow's "Get API key" buttons to bypass the UI
     * window's setWindowOpenHandler, which would otherwise route the URL to
     * a new tab behind the onboarding overlay.
     */
    openExternalUrl: (url: string) => Promise<void>;
    appScreen: {
      openSettings: (route?: SettingsRoute) => Promise<void>;
      closeSettings: () => Promise<void>;
      setSettingsRoute: (route: SettingsRoute) => Promise<void>;
      openProjects: () => Promise<void>;
      closeProjects: () => Promise<void>;
    };
  };
};
export const defaultState: KartonContract['state'] = {
  appScreen: {
    mode: 'main',
    settingsRoute: { section: 'models-providers' },
  },
  internalData: {
    posthog: {
      apiKey:
        typeof __APP_RENDERER_TELEMETRY_ENABLED__ !== 'boolean' ||
        __APP_RENDERER_TELEMETRY_ENABLED__
          ? import.meta.env.VITE_POSTHOG_API_KEY
          : undefined,
      host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    },
  },
  agents: { instances: {} },
  cloudTasks: { teleportByAgentId: {} },
  agentOs: createDefaultAgentOsState(),
  workspaceGitCleanup: {
    checkedAt: null,
    dismissed: false,
    cleaning: false,
    candidates: [],
    lastResult: null,
  },
  workspaceGitSetup: {
    runsByPath: {},
  },
  gitWorktreeRevisions: {},
  toolbox: {},
  swarmRuns: {},
  userAccount: {
    status: 'unauthenticated',
  },
  appInfo: {
    baseName: __APP_BASE_NAME__,
    name: __APP_NAME__,
    bundleId: __APP_BUNDLE_ID__,
    version: __APP_VERSION__,
    isFullScreen: false,
    platform: __APP_PLATFORM__ as 'darwin' | 'linux' | 'win32',
    releaseChannel: __APP_RELEASE_CHANNEL__,
    author: __APP_AUTHOR__,
    copyright: __APP_COPYRIGHT__,
    homepage: __APP_HOMEPAGE__,
    arch: __APP_ARCH__,
    otherVersions: {},
  },
  closedLidSleep: {
    isSupported: __APP_PLATFORM__ === 'darwin',
    isSleepDisabled: false,
    ownedByClodex: false,
    isChanging: false,
    error: null,
    persistenceWarning: null,
  },
  autoUpdate: {
    status: 'idle',
    updateInfo: null,
    errorMessage: null,
  },
  globalConfig: {
    notificationSoundLoudness: 'subtle',
    notificationSoundPack: 'bubble-pops',
    dockBounceEnabled: true,
    blockAppSuspensionWhenAgentsActive: true,
    personalizationThemeId: 'default',
    appColorScheme: 'system',
  },
  notificationSoundPacks: {
    available: ['bubble-pops'],
    displayNames: {},
  },
  userExperience: {
    storedExperienceData: {
      recentlyOpenedWorkspaces: [],
      hasSeenOnboardingFlow: null,
      lastViewedChats: {},
      tutorialState: {},
      experienceSurvey: {
        dismissedAt: null,
        dismissedCount: 0,
        answered: false,
        answeredAt: null,
      },
      firstUsedAt: null,
      founderCallSurvey: {
        dismissedAt: null,
        dismissedCount: 0,
        answered: false,
        answeredAt: null,
      },
      totalAgentCount: 0,
    },
    pendingOnboardingSuggestion: null,
    devAppPreview: {
      isFullScreen: false,
      inShowCodeMode: false,
      customScreenSize: null,
    },
    experienceSurvey: {
      dismissedAt: null,
      dismissedCount: 0,
      answered: false,
      answeredAt: null,
    },
    founderCallSurvey: {
      dismissedAt: null,
      dismissedCount: 0,
      answered: false,
      answeredAt: null,
    },
  },
  notifications: [],
  terminals: {
    outputBuffers: {},
    outputBufferOffsets: {},
  },
  fileTree: {
    visible: false,
    activeWorkspaceKey: null,
    viewMode: 'files',
    expandedDirectoriesByWorkspaceKey: {},
    workspaceRevisions: {},
    directoryRevisions: {},
  },
  contentTabs: {
    tabs: {},
    globalOrder: [],
    agentOrders: {},
    activeTabId: null,
  },
  browsing: {
    sessionId: '',
    history: [],
    contextSelectionMode: false,
    selectedElements: [],
    hoveredElement: null,
  },
  browser: {
    tabs: {},
    activeTabId: null,
    sessionId: '',
    history: [],
    contextSelectionMode: false,
    selectedElements: [],
    hoveredElement: null,
    viewportSize: null,
    lastActiveTabPerAgent: {},
    lastOpenAgentId: null,
  },
  downloads: {
    items: [],
    activeCount: 0,
    hasUnseenDownloads: false,
    lastSeenAt: null,
  },
  preferences: defaultUserPreferences,
  searchEngines: [],
  systemTheme: 'light', // Will be set correctly by backend on init
  workspaceMounts: [],
  workspaceMdGenerating: {},
  plugins: [],
  skills: [],
  globalSkills: [],
  plans: [],
  logChannels: [],
  logIngest: null,
};
