import type { Protocol } from 'devtools-protocol';
import type { ColorScheme } from '@shared/karton-contracts/ui';
import type { SelectedElement } from '@shared/selected-elements';
import type { SerializableKeyboardEvent } from '@shared/karton-contracts/web-contents-preload';
import type {
  PermissionRequest,
  AuthenticationRequest,
} from '@shared/karton-contracts/ui';

export interface TabState {
  title: string;
  url: string;
  /** Agent instance this tab is attached to, or null if globally visible */
  agentInstanceId: string | null;
  faviconUrls: string[];
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
    activeMatchIndex: number;
  } | null;
  isSearchBarActive: boolean; // Whether the search bar UI is active for this tab
  zoomPercentage: number; // Page zoom level as percentage (100 = default)
  lastFocusedAt: number; // Timestamp (Date.now()) of when this tab was last focused
  consoleLogCount: number; // Total number of console logs captured since page load
  consoleErrorCount: number; // Number of error-level console logs
  permissionRequests: PermissionRequest[]; // Pending permission requests for this tab
  isContentFullscreen: boolean; // Whether the tab's web content is in HTML5 fullscreen mode
  authenticationRequest: AuthenticationRequest | null; // Pending HTTP Basic Auth request
}

/**
 * Console log levels from the CDP Runtime.consoleAPICalled event.
 * Extracted from the official devtools-protocol types.
 */
export type ConsoleLogLevel = Protocol.Runtime.ConsoleAPICalledEvent['type'];

/**
 * Represents a single console log entry captured from the page.
 */
export interface ConsoleLogEntry {
  /** Timestamp when the log was captured (Date.now()) */
  timestamp: number;
  /** The log level (log, warn, error, etc.) */
  level: ConsoleLogLevel;
  /** The stringified log message/arguments */
  message: string;
  /** The URL of the page when the log was captured */
  pageUrl: string;
  /** Stack trace if available (for errors) */
  stackTrace?: string;
}

/**
 * Options for filtering console logs.
 */
export interface GetConsoleLogsOptions {
  /** Filter logs containing this string (case-insensitive) */
  filter?: string;
  /** Maximum number of logs to return (most recent first) */
  limit?: number;
  /** Filter by log level(s) */
  levels?: ConsoleLogLevel[];
}

export interface TabControllerEventMap {
  stateUpdated: [state: Partial<TabState>];
  movePanelToForeground: [panel: 'clodex-ui' | 'tab-content'];
  handleKeyDown: [keyDownEvent: SerializableKeyboardEvent];
  elementHovered: [element: SelectedElement | null];
  elementSelected: [element: SelectedElement];
  tabFocused: [tabId: string];
  viewportSizeChanged: [
    size: {
      width: number;
      height: number;
      scale: number;
      top: number;
      left: number;
    },
  ];
  contentFullscreenChanged: [isFullscreen: boolean];
  devtoolsOpened: [tabId: string];
  devtoolsClosed: [tabId: string];
}
