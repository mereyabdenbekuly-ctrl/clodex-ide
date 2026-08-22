export type { WorkspaceGitSummary } from '@clodex/agent-core/types/metadata';
export type { MountEntry } from '@clodex/agent-core/types/metadata';
export type {
  WorkspaceGitBranchKind,
  WorkspaceGitBranchInfo,
  WorkspaceGitBranchesResult,
  WorkspaceGitWorktreeInfo,
  WorkspaceGitWorktreesResult,
  WorkspaceGitCleanupCandidate,
  WorkspaceGitCleanupResult,
  WorkspaceGitWorktreeDeletionInfo,
  WorkspaceGitWorktreeDeleteResult,
  WorkspaceGitWorktreeDeleteOptions,
  WorkspaceGitCleanupState,
  WorkspaceGitSetupStatus,
  WorkspaceGitSetupRun,
  WorkspaceGitSetupState,
  WorktreeSetupManagedWorktree,
  WorktreeSetupScriptFile,
  WorktreeSetupRepositorySettings,
  WorktreeSetupRepositoriesResult,
  SaveWorktreeSetupScriptResult,
  DeleteWorktreeSetupWorktreeResult,
  WorkspaceGitFailureReason,
  WorkspaceGitFailure,
  WorkspaceGitMutationResult,
  WorkspaceGitCreateWorktreeResult,
  WorkspaceGitCreateBranchOptions,
  WorkspaceGitCreateWorktreeOptions,
  MountedWorkspaceGitStatusSummary,
  MountedWorkspaceGitSummary,
  MountedWorkspaceGitDiffEntry,
  MountedWorkspaceGitDiffSummary,
} from './workspace-git';

export type { DownloadSpeedDataPoint, DownloadSummary } from './downloads';
export { downloadsStateSchema } from './downloads';
export type { DownloadsState } from './downloads';

export type { UserMessageMetadata } from './agent/metadata';
export type { ReactSelectedElementInfo } from '../../selected-elements/react';
export type { SelectedElement } from '../../selected-elements';
export type {
  TextUIPart,
  FileUIPart,
  ReasoningUIPart,
  DynamicToolUIPart,
  ToolUIPart,
} from 'ai';
export type {
  ConfigurablePermissionType,
  PermissionsPreferences,
  HostPermissionException,
  DefaultPermissionSettings,
  HostPermissionOverrides,
} from './shared-types';
export { PermissionSetting, configurablePermissionTypes } from './shared-types';
export type { WidgetId, DevToolbarOriginSettings } from './shared-types';
export type {
  ModelProvider,
  ProviderEndpointMode,
  ProviderConfig,
  ProviderConfigs,
} from './shared-types';
export { PROVIDER_OFFICIAL_URLS, PROVIDER_DISPLAY_INFO } from './shared-types';
export type {
  ApiSpec,
  CustomEndpoint,
  CustomModel,
  ModelCapabilities,
} from './shared-types';
export { apiSpecSchema } from './shared-types';
export type { UpdateChannel } from './shared-types';

export type { ChatSummary } from './session';
export { recentlyOpenedWorkspaceSchema } from './session';
export { recentlyOpenedWorkspacesArraySchema } from './session';
export { onboardingStateSchema } from './session';
export type { OnboardingState } from './session';
export { tutorialStateSchema } from './session';
export type { TutorialState } from './session';
export { lastViewedChatsSchema } from './session';
export { experienceSurveySchema } from './session';
export type { ExperienceSurvey } from './session';
export { founderCallSurveySchema } from './session';
export type { FounderCallSurvey } from './session';
export { storedExperienceDataSchema } from './session';
export type { StoredExperienceData } from './session';
export type { RecentlyOpenedWorkspace } from './session';
export type { ColorScheme } from './session';
export type { InspirationWebsite } from './session';

export type {
  PermissionRequestType,
  MediaType,
  BasePermissionRequest,
  MediaPermissionRequest,
  SimplePermissionRequest,
  BluetoothDeviceInfo,
  BluetoothSelectionRequest,
  BluetoothPairingRequest,
  HIDDeviceInfo,
  HIDSelectionRequest,
  SerialPortInfo,
  SerialSelectionRequest,
  USBDeviceInfo,
  USBSelectionRequest,
  PermissionRequest,
  AuthenticationRequest,
} from './permissions';

export type {
  FileTreeWorkspaceKey,
  FileTreeNodeKind,
  FileTreeEntry,
  FileTreeListDirectoryInput,
  FileTreeListDirectoryResult,
  FilePreviewKind,
} from './files';
export { FILE_SAVE_CONFLICT_CODE } from './files';
export type {
  FileStatResult,
  FilePreviewResult,
  FileTabNotice,
  FileDiffContent,
  FileTabMetadata,
  TabLifecycle,
  OpenFileTabOptions,
  FileTreeClipboardOperation,
  FileSearchContentMatch,
  FileSearchResult,
  FileTreeOperationResult,
  TabState,
} from './files';
export { getTerminalTabDefaults, getFileTabDefaults } from './files';

export type {
  HistoryEntry,
  OmniboxSuggestions,
  PlanEntry,
  LogChannelEntry,
} from './browser-history';

export { EMPTY_MOUNTS } from './toolbox';
export type { PendingUserQuestion } from './toolbox';
export type {
  ClodexMcpCapabilityTool,
  ClodexMcpCapabilityStatus,
} from './toolbox';

export type {
  SwarmTaskRole,
  SwarmModelTaskRole,
  SwarmRunStatus,
  SwarmPhaseStatus,
  SwarmTaskStatus,
  SwarmTaskLogEntry,
  SwarmTaskState,
  SwarmPhaseState,
  SwarmRunState,
} from './swarm';

export type { AppState } from './app-state';
export type {
  AuthStatus,
  ApiKeyValidationResult,
  KartonContract,
} from './app-state';
export { defaultState } from './app-state';
