export type CloudTaskTeleportPhase =
  | 'restoring'
  | 'cloud-owned'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'failed';

/**
 * Renderer-safe Teleport diagnostics.
 *
 * Credentials, lease identifiers, fencing tokens, local paths, and snapshot
 * hashes deliberately never cross the Karton boundary.
 */
export interface CloudTaskTeleportState {
  agentInstanceId: string;
  taskId: string;
  executionId: string;
  phase: CloudTaskTeleportPhase;
  epoch: number | null;
  handoffId: string | null;
  lastSequence: number;
  memoryCheckpointId?: string | null;
  memoryEventCount?: number | null;
  memorySyncState?: 'pending' | 'synchronized' | 'diverged' | 'failed' | null;
  memorySyncJournal?: CloudTaskMemorySyncJournalEntry[];
  updatedAt: number;
  error: string | null;
}

export type CloudTaskTeleportActionResult =
  | { ok: true }
  | { ok: false; error: string };
import type { CloudTaskMemorySyncJournalEntry } from './cloud-task-memory-sync';
