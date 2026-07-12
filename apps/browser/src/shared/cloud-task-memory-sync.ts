export const cloudTaskMemorySyncOperations = [
  'prepare-cloud-restore',
  'activate-cloud-ownership',
  'cloud-to-local',
  'local-to-cloud',
  'recover-cloud-ownership',
  'retry',
  'auto-retry',
  'auto-resolve-divergence',
  'resolve-divergence',
] as const;
export type CloudTaskMemorySyncOperation =
  (typeof cloudTaskMemorySyncOperations)[number];

export type CloudTaskMemorySyncDirection =
  | 'local-to-cloud'
  | 'cloud-to-local'
  | 'ownership-only';

export type CloudTaskMemorySyncStatus = 'synchronized' | 'diverged' | 'failed';

export type CloudTaskMemorySyncErrorCode =
  | 'checkpoint-mismatch'
  | 'cas-conflict'
  | 'event-divergence'
  | 'ownership-conflict'
  | 'transport-failure'
  | 'invalid-response'
  | 'unknown';

export type CloudTaskMemoryDivergenceResolution = 'keep-local' | 'accept-cloud';

export type CloudTaskMemoryRecoveryClass =
  | 'transient'
  | 'append-only'
  | 'content-conflict'
  | 'ownership-conflict'
  | 'checkpoint-conflict'
  | 'concurrent-update'
  | 'invalid-data'
  | 'unknown';

export type CloudTaskMemoryRecoveryDecision =
  | 'retry'
  | 'merge-non-conflicting'
  | 'manual';

/** Renderer-safe and content-free synchronization audit entry. */
export interface CloudTaskMemorySyncJournalEntry {
  id: string;
  taskId: string;
  agentInstanceId: string;
  executionId: string;
  operation: CloudTaskMemorySyncOperation;
  direction: CloudTaskMemorySyncDirection;
  status: CloudTaskMemorySyncStatus;
  epoch: number | null;
  checkpointId: string | null;
  eventCount: number | null;
  importedEvents: number | null;
  duplicateEvents: number | null;
  divergenceEventIdHash: string | null;
  errorCode: CloudTaskMemorySyncErrorCode | null;
  resolution: CloudTaskMemoryDivergenceResolution | null;
  recoveryClass: CloudTaskMemoryRecoveryClass | null;
  recoveryDecision: CloudTaskMemoryRecoveryDecision | null;
  automatic: boolean;
  backoffMs: number | null;
  protocol: 'legacy' | 'atomic-v1' | null;
  idempotentReplay: boolean;
  attempt: number;
  startedAt: number;
  finishedAt: number;
}

export interface CloudTaskMemorySyncDiagnosticsExport {
  format: 'clodex-memory-sync-diagnostics';
  version: 1;
  exportedAt: number;
  agentInstanceId: string;
  entries: CloudTaskMemorySyncJournalEntry[];
}

export type CloudTaskMemorySyncExportResult =
  | { ok: true; canceled: boolean; entryCount: number }
  | { ok: false; error: string };
