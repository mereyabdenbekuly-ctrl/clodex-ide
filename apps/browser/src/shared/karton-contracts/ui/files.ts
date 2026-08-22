import type { ColorScheme } from './session';
import type { PermissionRequest, AuthenticationRequest } from './permissions';

export type FileTreeWorkspaceKey = string;

export type FileTreeNodeKind = 'directory' | 'file' | 'symlink';

export type FileTreeEntry = {
  name: string;
  relativePath: string;
  kind: FileTreeNodeKind;
  size: number | null;
  mtimeMs: number | null;
  mimeType: string | null;
  isIgnored: boolean;
  hasChildren?: boolean;
};

export type FileTreeListDirectoryInput = {
  workspaceKey: FileTreeWorkspaceKey;
  directoryPath: string;
  cursor?: string | null;
  limit?: number;
};

export type FileTreeListDirectoryResult = {
  workspaceKey: FileTreeWorkspaceKey;
  directoryPath: string;
  entries: FileTreeEntry[];
  nextCursor: string | null;
  revision: number;
};

export type FilePreviewKind = 'text' | 'image' | 'svg' | 'binary';

/**
 * Sentinel error message thrown by `fileTree.saveFile` when the on-disk file
 * was modified externally since it was loaded. The UI matches on this to show
 * a conflict warning instead of silently overwriting the external change.
 */
export const FILE_SAVE_CONFLICT_CODE = 'FILE_SAVE_CONFLICT';

/** Lightweight on-disk file identity used to detect external modifications. */
export type FileStatResult = {
  mtimeMs: number;
  size: number;
};

export type FilePreviewResult = {
  workspaceKey: FileTreeWorkspaceKey;
  relativePath: string;
  kind: FilePreviewKind;
  mimeType: string;
  size: number;
  /**
   * Last-modified time (ms) of the file when this preview was produced. Used
   * as a cheap version token to detect external edits (for re-open
   * revalidation, live reload, and save-conflict detection).
   */
  mtimeMs: number;
  text?: string;
  base64?: string;
  truncated?: boolean;
  /**
   * When true, the file lives in a read-only location (e.g. an `att/`
   * attachment blob, `plugins/`, or `apps/`) and must not be edited or
   * saved. The editor opens in read-only mode and hides save controls.
   */
  readOnly?: boolean;
};

export type FileTabNotice =
  | { kind: 'moved'; fromRelativePath: string }
  | { kind: 'deleted' };

export type FileDiffContent = {
  original: string;
  modified: string;
  /**
   * mtime (ms) of the working-tree file the `modified` side was read from.
   * Used as the optimistic-concurrency baseline when saving edits made in
   * the diff view. `null` when the file does not exist on disk.
   */
  mtimeMs: number | null;
};

export type FileTabMetadata = {
  workspaceKey: FileTreeWorkspaceKey;
  relativePath: string;
  absolutePath: string;
  kind: FilePreviewKind;
  mimeType: string;
  size: number;
  /**
   * Optional human-readable title for the tab. Used for attachment tabs
   * where the on-disk filename is an opaque blob key but the original
   * file name should be shown to the user.
   */
  displayName?: string;
  /** When true, the tab content is read-only (e.g. attachment blobs). */
  readOnly?: boolean;
  /**
   * When true, the tab opens a git diff editor (Monaco DiffEditor)
   * showing the changes for this file instead of the regular editor.
   */
  showDiff?: boolean;
  /**
   * Whether the diff is staged (HEAD vs index) or unstaged (index vs
   * working tree). Only meaningful when showDiff is true.
   */
  diffStaged?: boolean;
  /**
   * For renamed files, the pre-rename path where the committed (HEAD) blob
   * lives. Used by the diff view to load the original side. Only meaningful
   * when showDiff is true.
   */
  diffOldPath?: string;
};

export type TabLifecycle =
  | { kind: 'permanent' }
  | { kind: 'temporary'; groupKey: string };

export type OpenFileTabOptions = {
  preview?: boolean;
  temporaryGroupKey?: string;
  /** Open the tab as a git diff editor (Monaco DiffEditor). */
  showDiff?: boolean;
  /** Staged (HEAD vs index) or unstaged (index vs working tree). */
  diffStaged?: boolean;
  /** For renamed files, the pre-rename path of the committed (HEAD) blob. */
  diffOldPath?: string;
};

export type FileTreeClipboardOperation = 'copy' | 'cut';

export type FileSearchContentMatch = {
  lineNumber: number;
  line: string;
};

export type FileSearchResult = {
  workspaceKey: string;
  mountPrefix: string;
  relativePath: string;
  fileName: string;
  isDirectory?: boolean;
  /** Last-modified time (epoch ms) used for recency sorting. */
  mtimeMs?: number;
  /** Total number of query occurrences found in the file content. */
  contentMatchCount?: number;
  /** Up to three matching content lines for preview/highlighting. */
  contentMatches?: FileSearchContentMatch[];
};

export type FileTreeOperationResult = {
  success: boolean;
  error?: string;
  relativePath?: string;
};

export type TabState = {
  id: string;
  /** Discriminator: 'browser' for web-content tabs, 'terminal' for PTY tabs, 'file' for workspace file previews. */
  type?: 'browser' | 'terminal' | 'file';
  title: string;
  url: string;
  faviconUrls: string[];
  /** Agent instance this tab is attached to, or null if globally visible */
  agentInstanceId: string | null;
  isLoading: boolean;
  isResponsive: boolean;
  isPlayingAudio: boolean;
  isMuted: boolean;
  colorScheme: ColorScheme;
  error: {
    code: number;
    message?: string;
    /** The original URL that failed to load (for reload behavior) */
    originalFailedUrl?: string;
    /** Whether an error page is currently displayed */
    isErrorPageDisplayed?: boolean;
  } | null;
  navigationHistory: {
    canGoBack: boolean;
    canGoForward: boolean;
  };
  devTools: {
    open: boolean;
    chromeOpen: boolean;
  };
  screenshot: string | null; // Data URL of the tab screenshot
  search: {
    text: string;
    resultsCount: number;
    activeMatchIndex: number; // 1-indexed position of current match
  } | null;
  isSearchBarActive: boolean; // Whether the search bar UI is active for this tab
  zoomPercentage: number; // Page zoom level as percentage (100 = default)
  lastFocusedAt: number; // Timestamp (Date.now()) of when this tab was last focused
  lifecycle: TabLifecycle;
  consoleLogCount: number; // Total number of console logs captured since page load
  consoleErrorCount: number; // Number of error-level console logs
  /** Pending permission requests for this tab */
  permissionRequests: PermissionRequest[];
  /** Whether the tab's web content is in HTML5 fullscreen mode */
  isContentFullscreen: boolean;
  /** Pending HTTP Basic Auth request for this tab */
  authenticationRequest: AuthenticationRequest | null;
  /** Terminal-specific fields (present when type === 'terminal') */
  cwd: string;
  terminalRunningProcess?: string | null;
  /** File-preview-specific fields (present when type === 'file') */
  file?: FileTabMetadata;
  /** Transient notice banner for file tabs (move / delete). */
  fileNotice?: FileTabNotice;
  createdAt?: number;
  exited?: boolean;
  exitCode?: number | null;
};

export function getTerminalTabDefaults(): Omit<
  TabState,
  'id' | 'title' | 'createdAt' | 'lastFocusedAt'
> {
  return {
    type: 'terminal' as const,
    url: '',
    cwd: '',
    terminalRunningProcess: null,
    faviconUrls: [],
    agentInstanceId: null as string | null,
    isLoading: false,
    isResponsive: false,
    isPlayingAudio: false,
    isMuted: false,
    colorScheme: 'system' as TabState['colorScheme'],
    error: null,
    navigationHistory: { canGoBack: false, canGoForward: false },
    devTools: { open: false, chromeOpen: false },
    screenshot: null,
    search: null,
    isSearchBarActive: false,
    zoomPercentage: 100,
    consoleLogCount: 0,
    consoleErrorCount: 0,
    permissionRequests: [] as TabState['permissionRequests'],
    isContentFullscreen: false,
    authenticationRequest: null,
    lifecycle: { kind: 'permanent' },
    exited: false,
    exitCode: null,
  };
}

export function getFileTabDefaults(): Omit<
  TabState,
  'id' | 'title' | 'lastFocusedAt' | 'file'
> {
  return {
    type: 'file' as const,
    url: '',
    cwd: '',
    faviconUrls: [],
    agentInstanceId: null as string | null,
    isLoading: false,
    isResponsive: true,
    isPlayingAudio: false,
    isMuted: false,
    colorScheme: 'system' as TabState['colorScheme'],
    error: null,
    navigationHistory: { canGoBack: false, canGoForward: false },
    devTools: { open: false, chromeOpen: false },
    screenshot: null,
    search: null,
    isSearchBarActive: false,
    zoomPercentage: 100,
    consoleLogCount: 0,
    consoleErrorCount: 0,
    permissionRequests: [] as TabState['permissionRequests'],
    isContentFullscreen: false,
    authenticationRequest: null,
    lifecycle: { kind: 'permanent' },
  };
}
