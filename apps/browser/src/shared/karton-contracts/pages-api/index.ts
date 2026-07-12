import type {
  PendingEditsResult,
  ExternalFileContentResult,
  HistoryFilter,
  HistoryResult,
  FaviconBitmapResult,
} from './types';
import type { GlobalConfig } from '../ui/shared-types';
import type { PlanEntry } from '../ui';
import type { FileDiff } from '../ui/shared-types';
import type {
  HostedPullRequestMergeInput,
  HostedPullRequestMergeResult,
  HostedPullRequestQuery,
  HostedPullRequestResult,
  HostedPullRequestSubmitReviewInput,
  HostedPullRequestSubmitReviewResult,
} from '../../hosted-pull-request';
import type {
  GeneratedApp,
  GeneratedAppActionResult,
  GeneratedAppIdentityInput,
  GeneratedAppsListResult,
  GeneratedAppsQuery,
  LaunchGeneratedAppResult,
} from '../../generated-apps';
import type {
  PluginLibraryCredentialInput,
  PluginLibraryOperationResult,
  PluginLibrarySnapshot,
} from '../../plugin-library';

type PendingAppMessage = {
  appId: string;
  pluginId?: string;
  data: unknown;
} | null;

export type WorkspaceMountInfo = {
  prefix: string;
  path: string;
  git: import('../ui').MountedWorkspaceGitSummary | null;
  skills: Array<{ name: string; description: string }>;
  /** Full file content, or `null` when the file does not exist on disk. */
  workspaceMdContent: string | null;
  /** Full file content, or `null` when the file does not exist on disk. */
  agentsMdContent: string | null;
};

export type PagesApiState = {
  /** Pending file edits by chat ID, pushed in real-time */
  pendingEditsByAgentInstanceId: Record<string, FileDiff[]>;
  /** Pending mini-app messages by chat ID, pushed in real-time */
  pendingAppMessagesByAgentInstanceId: Record<string, PendingAppMessage>;
  /** Global config (read-only sync, updated via backend state sync) */
  globalConfig: GlobalConfig;
  /** Currently mounted workspaces, deduplicated across all agents */
  workspaceMounts: WorkspaceMountInfo[];
  /** Global plans (workspace-independent, synced from AppState.plans) */
  plans: PlanEntry[];
};

export type PagesApiContract = {
  state: PagesApiState;
  serverProcedures: {
    openTab: (url: string, setActive?: boolean) => Promise<void>;
    /**
     * Open a URL in the user's system default browser. Only `http:` and
     * `https:` schemes are accepted — other schemes are silently rejected
     * to prevent arbitrary protocol handling via a renderer procedure.
     */
    openExternalUrl: (url: string) => Promise<void>;
    /** Get browser history entries for standalone internal pages. */
    getHistory: (filter: HistoryFilter) => Promise<HistoryResult[]>;
    /** Get favicon bitmap data for standalone internal pages. */
    getFaviconBitmaps: (
      faviconUrls: string[],
    ) => Promise<Record<string, FaviconBitmapResult>>;
    /** Get pending file edits for a specific chat */
    getPendingEdits: (agentInstanceId: string) => Promise<PendingEditsResult>;
    /** Detect or load a hosted GitHub pull request for review. */
    getHostedPullRequest: (
      query: HostedPullRequestQuery,
    ) => Promise<HostedPullRequestResult>;
    /** Atomically submit a GitHub comment, approval, or changes-requested review. */
    submitHostedPullRequestReview: (
      input: HostedPullRequestSubmitReviewInput,
    ) => Promise<HostedPullRequestSubmitReviewResult>;
    /** Merge a GitHub pull request only after the protected backend policy passes. */
    mergeHostedPullRequest: (
      input: HostedPullRequestMergeInput,
    ) => Promise<HostedPullRequestMergeResult>;
    /** List agent-owned generated apps discovered from the local data root. */
    listGeneratedApps: (
      query?: GeneratedAppsQuery,
    ) => Promise<GeneratedAppsListResult>;
    /** Load one generated app by its opaque, URL-safe library key. */
    getGeneratedApp: (
      input: GeneratedAppIdentityInput,
    ) => Promise<GeneratedApp | null>;
    /** Open a runnable generated app in an owner-scoped preview tab. */
    launchGeneratedApp: (
      input: GeneratedAppIdentityInput,
    ) => Promise<LaunchGeneratedAppResult>;
    /** Delete only the agent-owned app directory and its library metadata. */
    deleteGeneratedApp: (
      input: GeneratedAppIdentityInput,
    ) => Promise<GeneratedAppActionResult>;
    /**
     * Resume the owner task and request non-destructive regeneration.
     * Existing files remain in place until the agent writes replacements.
     */
    regenerateGeneratedApp: (
      input: GeneratedAppIdentityInput,
    ) => Promise<GeneratedAppActionResult>;
    /** Load the unified bundled + signed marketplace plugin and skill catalog. */
    getPluginLibrary: () => Promise<PluginLibrarySnapshot>;
    /** Re-verify the signed marketplace and return a fresh unified snapshot. */
    refreshPluginLibrary: () => Promise<PluginLibrarySnapshot>;
    /** Install one verified marketplace plugin through atomic activation. */
    installPluginLibraryItem: (
      pluginId: string,
    ) => Promise<PluginLibraryOperationResult>;
    /** Update one installed marketplace plugin with rollback protection. */
    updatePluginLibraryItem: (
      pluginId: string,
    ) => Promise<PluginLibraryOperationResult>;
    /** Uninstall one marketplace-managed plugin with rollback protection. */
    uninstallPluginLibraryItem: (
      pluginId: string,
    ) => Promise<PluginLibraryOperationResult>;
    /** Enable or disable an installed plugin's agent-facing capabilities. */
    setPluginLibraryItemEnabled: (
      pluginId: string,
      enabled: boolean,
    ) => Promise<PluginLibrarySnapshot>;
    /** Store one registered credential required by a plugin. */
    setPluginLibraryCredential: (
      input: PluginLibraryCredentialInput,
    ) => Promise<PluginLibrarySnapshot>;
    /** Delete one stored registered credential. */
    deletePluginLibraryCredential: (
      typeId: string,
    ) => Promise<PluginLibrarySnapshot>;
    /** Forward a mini-app iframe message to the sandbox worker. */
    forwardAppMessage: (
      agentInstanceId: string,
      appId: string,
      pluginId: string | undefined,
      data: unknown,
    ) => Promise<void>;
    /** Clear the pending mini-app message for a specific chat. */
    clearPendingAppMessage: (agentInstanceId: string) => Promise<void>;
    /** Accept all pending edits for a specific chat */
    acceptAllPendingEdits: (agentInstanceId: string) => Promise<void>;
    /** Reject all pending edits for a specific chat */
    rejectAllPendingEdits: (agentInstanceId: string) => Promise<void>;
    /** Accept a single pending edit by file path */
    acceptPendingEdit: (agentInstanceId: string, path: string) => Promise<void>;
    /** Reject a single pending edit by file path */
    rejectPendingEdit: (agentInstanceId: string, path: string) => Promise<void>;
    /**
     * Get content of an external (binary/large) file by its blob OID.
     * Returns base64-encoded content and inferred MIME type.
     * Returns null if the blob is not found.
     */
    getExternalFileContent: (
      oid: string,
    ) => Promise<ExternalFileContentResult | null>;
    /**
     * Trust a certificate for a specific origin in a tab and reload.
     * This adds the origin to a per-tab whitelist that allows certificate errors.
     * The whitelist is cleared when the tab is closed.
     */
    trustCertificateAndReload: (tabId: string, origin: string) => Promise<void>;
    /**
     * Forward a UI telemetry event to the backend TelemetryService. The
     * backend validates the event name against `UI_TELEMETRY_EVENT_NAMES`
     * and the payload against a per-event Zod schema — unknown names or
     * invalid shapes are silently dropped.
     */
    captureTelemetry: (
      eventName: string,
      properties?: Record<string, unknown>,
    ) => Promise<void>;
  };
};

export const defaultState: PagesApiState = {
  pendingEditsByAgentInstanceId: {},
  pendingAppMessagesByAgentInstanceId: {},
  globalConfig: {
    notificationSoundLoudness: 'subtle',
    notificationSoundPack: 'bubble-pops',
    dockBounceEnabled: true,
    blockAppSuspensionWhenAgentsActive: true,
    personalizationThemeId: 'default',
    appColorScheme: 'system',
  },
  workspaceMounts: [],
  plans: [],
};
