import type {
  ConsoleLogEntry,
  ConsoleLogLevel,
  GetConsoleLogsOptions,
} from './browsing-tab-types';

/**
 * Ring-buffer storage for console log entries with time-window deduplication.
 *
 * Multiple CDP events (Runtime.consoleAPICalled, Console.messageAdded) can
 * fire for the same console message, so entries are deduplicated within a
 * short window before being stored.
 */
export class ConsoleLogStore {
  private entries: ConsoleLogEntry[] = [];

  constructor(private readonly maxSize: number) {}

  public get size(): number {
    return this.entries.length;
  }

  /**
   * Adds a console log entry to the ring buffer with deduplication.
   *
   * @returns true if the entry was added, false if it was a duplicate or an
   * Electron-internal log.
   */
  public add(entry: ConsoleLogEntry): boolean {
    // Drop Electron-internal logs (e.g., security warnings from sandbox_bundle)
    if (entry.stackTrace?.includes('node:electron/')) return false;

    if (this.isDuplicate(entry)) return false;

    // Add to ring buffer (remove oldest if at capacity)
    if (this.entries.length >= this.maxSize) this.entries.shift();

    this.entries.push(entry);
    return true;
  }

  /** Removes all stored entries. Called on page navigation to start fresh. */
  public clear(): void {
    this.entries = [];
  }

  /** Counts of total and error-level entries. */
  public counts(): { total: number; errors: number } {
    return {
      total: this.entries.length,
      errors: this.entries.filter((log) => log.level === 'error').length,
    };
  }

  /**
   * Gets stored entries with optional filtering and limiting.
   *
   * @returns Array of console log entries (most recent first)
   */
  public getLogs(options?: GetConsoleLogsOptions): ConsoleLogEntry[] {
    let logs = [...this.entries];

    // Filter by level if specified
    if (options?.levels && options.levels.length > 0) {
      const levelSet = new Set(options.levels);
      logs = logs.filter((log) => levelSet.has(log.level));
    }

    // Filter by search string if specified (case-insensitive)
    if (options?.filter) {
      const filterLower = options.filter.toLowerCase();
      logs = logs.filter(
        (log) =>
          log.message.toLowerCase().includes(filterLower) ||
          (log.stackTrace?.toLowerCase().includes(filterLower) ?? false),
      );
    }

    // Reverse to get most recent first
    logs.reverse();

    // Apply limit if specified
    if (options?.limit && options.limit > 0) {
      logs = logs.slice(0, options.limit);
    }

    return logs;
  }

  private isDuplicate(entry: ConsoleLogEntry): boolean {
    return this.entries.slice(-30).some((log) => {
      // Check if levels are equivalent ('log' and 'info' are functionally identical)
      const levelsMatch =
        log.level === entry.level ||
        (log.level === 'log' && entry.level === 'info') ||
        (log.level === 'info' && entry.level === 'log');
      if (!levelsMatch) return false;

      // Must be within 50ms time window
      if (Math.abs(log.timestamp - entry.timestamp) > 50) return false;

      // Check if messages match (first 200 chars)
      const existingMsg = log.message.trim().substring(0, 200);
      const newMsg = entry.message.trim().substring(0, 200);
      return existingMsg === newMsg;
    });
  }
}

function formatCallFrames(
  callFrames: Array<{
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }>,
): string | undefined {
  if (!callFrames.length) return undefined;
  return callFrames
    .map(
      (frame) =>
        `  at ${frame.functionName || '(anonymous)'} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
    )
    .join('\n');
}

/** Maps a CDP `Console.messageAdded` event to a log entry. */
export function consoleMessageToEntry(
  params: {
    message?: {
      source: string;
      level: 'log' | 'warning' | 'error' | 'debug' | 'info';
      text: string;
      url?: string;
      line?: number;
      column?: number;
    };
  },
  fallbackUrl: string,
): ConsoleLogEntry | null {
  const msg = params.message;
  if (!msg) return null;

  // Map Console.message level to ConsoleLogLevel
  let level: ConsoleLogLevel;
  switch (msg.level) {
    case 'error':
      level = 'error';
      break;
    case 'warning':
      level = 'warning';
      break;
    case 'info':
      level = 'info';
      break;
    case 'debug':
      level = 'debug';
      break;
    default:
      level = 'log';
  }

  return {
    timestamp: Date.now(),
    level,
    message: msg.text,
    pageUrl: msg.url || fallbackUrl,
    stackTrace: msg.line
      ? `  at ${msg.url}:${msg.line}:${msg.column || 0}`
      : undefined,
  };
}

/** Maps a CDP `Log.entryAdded` event to a log entry. */
export function logEntryAddedToEntry(
  params: {
    entry?: {
      source: string;
      level: 'verbose' | 'info' | 'warning' | 'error';
      text: string;
      timestamp: number;
      url?: string;
      lineNumber?: number;
      stackTrace?: {
        callFrames: Array<{
          functionName: string;
          scriptId: string;
          url: string;
          lineNumber: number;
          columnNumber: number;
        }>;
      };
    };
  },
  fallbackUrl: string,
): ConsoleLogEntry | null {
  const entry = params.entry;
  if (!entry) return null;

  // Map Log.entry level to ConsoleLogLevel
  let level: ConsoleLogLevel;
  switch (entry.level) {
    case 'error':
      level = 'error';
      break;
    case 'warning':
      level = 'warning';
      break;
    case 'info':
      level = 'info';
      break;
    case 'verbose':
      level = 'debug';
      break;
    default:
      level = 'log';
  }

  return {
    timestamp: entry.timestamp || Date.now(),
    level,
    message: entry.text,
    pageUrl: entry.url || fallbackUrl,
    stackTrace: formatCallFrames(entry.stackTrace?.callFrames ?? []),
  };
}

/** Maps a CDP `Runtime.exceptionThrown` event to an error log entry. */
export function exceptionThrownToEntry(
  params: {
    timestamp: number;
    exceptionDetails?: {
      exceptionId: number;
      text: string;
      lineNumber: number;
      columnNumber: number;
      scriptId?: string;
      url?: string;
      stackTrace?: {
        callFrames: Array<{
          functionName: string;
          scriptId: string;
          url: string;
          lineNumber: number;
          columnNumber: number;
        }>;
      };
      exception?: {
        type: string;
        subtype?: string;
        className?: string;
        description?: string;
        value?: unknown;
      };
      executionContextId: number;
    };
  },
  fallbackUrl: string,
): ConsoleLogEntry | null {
  const details = params.exceptionDetails;
  if (!details) return null;

  // Build message from exception details
  let message = details.text || 'Uncaught exception';
  if (details.exception?.description) {
    message = details.exception.description;
  } else if (details.exception?.value !== undefined) {
    message = `${details.text}: ${JSON.stringify(details.exception.value)}`;
  }

  return {
    timestamp: params.timestamp || Date.now(),
    level: 'error',
    message,
    pageUrl: fallbackUrl,
    stackTrace: formatCallFrames(details.stackTrace?.callFrames ?? []),
  };
}

/** Maps a CDP `Runtime.consoleAPICalled` event to a log entry. */
export function consoleAPICalledToEntry(
  params: {
    type: ConsoleLogLevel;
    args: Array<{
      type: string;
      value?: unknown;
      description?: string;
      preview?: {
        description?: string;
        properties?: Array<{ name: string; value?: string }>;
      };
    }>;
    executionContextId: number;
    timestamp: number;
    stackTrace?: {
      callFrames: Array<{
        functionName: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
      }>;
    };
  },
  fallbackUrl: string,
): ConsoleLogEntry {
  // Convert args to a readable string
  const messageParts: string[] = [];
  for (const arg of params.args) {
    if (arg.value !== undefined) {
      // Primitive values
      if (typeof arg.value === 'string') messageParts.push(arg.value);
      else messageParts.push(JSON.stringify(arg.value));
    } else if (arg.description) {
      // Objects, functions, etc.
      messageParts.push(arg.description);
    } else if (arg.preview?.description) {
      // Preview for complex objects
      messageParts.push(arg.preview.description);
    } else if (arg.type) {
      // Fallback to type
      messageParts.push(`[${arg.type}]`);
    }
  }

  return {
    timestamp: params.timestamp || Date.now(),
    level: params.type,
    message: messageParts.join(' '),
    pageUrl: fallbackUrl,
    stackTrace: formatCallFrames(params.stackTrace?.callFrames ?? []),
  };
}
