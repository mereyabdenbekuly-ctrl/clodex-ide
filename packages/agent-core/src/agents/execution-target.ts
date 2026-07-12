export const agentExecutionTargets = ['local', 'cloud'] as const;
export type AgentExecutionTarget = (typeof agentExecutionTargets)[number];

export const agentExecutionTaskStatuses = [
  'queued',
  'preparing',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentExecutionTaskStatus =
  (typeof agentExecutionTaskStatuses)[number];

export interface AgentExecutionTaskRecord {
  id: string;
  target: AgentExecutionTarget;
  status: AgentExecutionTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  failureReason: string | null;
}

export type AgentTaskSnapshotManifestEntry = WorkspaceSnapshotEntry;

export interface AgentTaskSnapshotManifest extends WorkspaceSnapshotV1 {
  taskId: string;
}

export interface AgentTaskSnapshotSelectionEntry {
  mountPrefix: string;
  /**
   * Mount-relative POSIX path. An empty path selects the mount root and is
   * expanded by the host snapshot packager under its ignore/secret policy.
   */
  relativePath: string;
  /**
   * Hash captured when the user message was prepared. Hosts compare this
   * against directly selected files so a stale reference cannot silently
   * upload newer contents.
   */
  expectedSha256: string;
}

export type AgentTaskSnapshotSelection =
  | {
      version: 1;
      mode: 'explicit';
      entries: AgentTaskSnapshotSelectionEntry[];
    }
  | {
      /**
       * Session handoffs capture every mounted workspace root under the host's
       * ignore, secret, protected-file, and quota policies. This intentionally
       * does not depend on the path references of the latest user message.
       */
      version: 1;
      mode: 'mounted-workspaces';
      entries: [];
    };

const TERMINAL_TASK_STATUSES = new Set<AgentExecutionTaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

const ALLOWED_TASK_TRANSITIONS: Record<
  AgentExecutionTaskStatus,
  readonly AgentExecutionTaskStatus[]
> = {
  queued: ['preparing', 'failed', 'cancelled'],
  preparing: ['running', 'failed', 'cancelled'],
  running: ['suspended', 'completed', 'failed', 'cancelled'],
  suspended: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createAgentExecutionTaskRecord(input: {
  id: string;
  target: AgentExecutionTarget;
  now?: number;
}): AgentExecutionTaskRecord {
  const now = input.now ?? Date.now();
  if (!input.id.trim()) throw new Error('Execution task id is required');
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Execution task timestamp is invalid');
  }
  return {
    id: input.id,
    target: input.target,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    failureReason: null,
  };
}

export function resolveAgentExecutionTargetFromMessages(
  messages: readonly {
    role: string;
    metadata?: { executionTarget?: unknown };
  }[],
): AgentExecutionTarget {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    return message.metadata?.executionTarget === 'cloud' ? 'cloud' : 'local';
  }
  return 'local';
}

export function resolveAgentTaskSnapshotSelectionFromMessages(
  messages: readonly {
    role: string;
    metadata?: {
      pathReferences?: unknown;
      cloudHandoffScope?: unknown;
    };
  }[],
): AgentTaskSnapshotSelection {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (message.metadata?.cloudHandoffScope === 'session-workspaces') {
      return {
        version: 1,
        mode: 'mounted-workspaces',
        entries: [],
      };
    }
    const references = message.metadata?.pathReferences;
    if (!references || typeof references !== 'object') {
      return { version: 1, mode: 'explicit', entries: [] };
    }

    const entries: AgentTaskSnapshotSelectionEntry[] = [];
    const seen = new Set<string>();
    for (const [mountedPath, expectedSha256] of Object.entries(references)) {
      if (
        typeof expectedSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedSha256)
      ) {
        continue;
      }
      const normalized = normalizeSnapshotSelectionPath(mountedPath);
      if (!normalized) continue;
      const identity = `${normalized.mountPrefix}/${normalized.relativePath}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push({
        ...normalized,
        expectedSha256,
      });
    }
    entries.sort((left, right) => {
      const mountOrder = compareOrdinal(left.mountPrefix, right.mountPrefix);
      return mountOrder !== 0
        ? mountOrder
        : compareOrdinal(left.relativePath, right.relativePath);
    });
    return { version: 1, mode: 'explicit', entries };
  }
  return { version: 1, mode: 'explicit', entries: [] };
}

export function transitionAgentExecutionTask(
  record: AgentExecutionTaskRecord,
  nextStatus: AgentExecutionTaskStatus,
  options: {
    now?: number;
    failureReason?: string;
  } = {},
): AgentExecutionTaskRecord {
  if (!ALLOWED_TASK_TRANSITIONS[record.status].includes(nextStatus)) {
    throw new Error(
      `Invalid execution task transition: ${record.status} -> ${nextStatus}`,
    );
  }
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < record.updatedAt) {
    throw new Error('Execution task timestamp is invalid');
  }
  const terminal = TERMINAL_TASK_STATUSES.has(nextStatus);
  return {
    ...record,
    status: nextStatus,
    updatedAt: now,
    startedAt:
      record.startedAt ?? (nextStatus === 'running' ? now : record.startedAt),
    finishedAt: terminal ? now : null,
    failureReason:
      nextStatus === 'failed'
        ? normalizeFailureReason(options.failureReason)
        : null,
  };
}

export function createAgentTaskSnapshotManifest(input: {
  taskId: string;
  entries: readonly AgentTaskSnapshotManifestEntry[];
  selection?: AgentTaskSnapshotSelection['mode'];
  mounts?: readonly WorkspaceSnapshotMount[];
  environment?: Omit<WorkspaceEnvironmentFingerprint, 'fingerprintHash'>;
  createdAt?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}): AgentTaskSnapshotManifest {
  if (!input.taskId.trim()) throw new Error('Snapshot task id is required');
  const snapshot = createWorkspaceSnapshot({
    createdAt: input.createdAt,
    selection: input.selection ?? 'explicit',
    entries: input.entries,
    mounts: input.mounts,
    environment: input.environment,
    maxEntries: input.maxEntries,
    maxTotalBytes: input.maxTotalBytes,
  });
  return {
    ...snapshot,
    taskId: input.taskId,
  };
}

function normalizeSnapshotSelectionPath(
  mountedPath: string,
): Pick<
  AgentTaskSnapshotSelectionEntry,
  'mountPrefix' | 'relativePath'
> | null {
  if (
    typeof mountedPath !== 'string' ||
    mountedPath.includes('\\') ||
    Array.from(mountedPath).some((character) => character.charCodeAt(0) < 32)
  ) {
    return null;
  }
  const normalized = mountedPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return null;
  const [mountPrefix = '', ...segments] = normalized.split('/');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(mountPrefix) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return {
    mountPrefix,
    relativePath: segments.join('/'),
  };
}

function normalizeFailureReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  if (!normalized) return 'execution-failed';
  return normalized.slice(0, 120);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
import {
  createWorkspaceSnapshot,
  type WorkspaceEnvironmentFingerprint,
  type WorkspaceSnapshotEntry,
  type WorkspaceSnapshotMount,
  type WorkspaceSnapshotV1,
} from './workspace-snapshot';
