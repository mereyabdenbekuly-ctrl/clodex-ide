import type { FileDiff } from './diff-history';

export type PendingEditStatus =
  | 'pending'
  | 'applying'
  | 'accepted'
  | 'rejected'
  | 'aborted';

export type FileEditBatchState = 'collecting' | 'ready' | 'aborted';

export type FileEditBatchTerminalOutcome =
  | 'auto-policy'
  | 'skipped'
  | 'error'
  | 'approval-required'
  | 'aborted';

/**
 * Host-only capability for one positional member of an exact native file-edit
 * batch. This object never crosses IPC; the utility process sends only the
 * serializable batch metadata used by the main process to create it.
 */
export interface FileEditBatchParticipant {
  readonly batchId: string;
  readonly memberId: string;
  readonly toolCallId: string;
  getState(): FileEditBatchState;
  arriveAsProposal(): Promise<'ready' | 'aborted'>;
  settle(outcome: FileEditBatchTerminalOutcome): void;
}

export type PendingEditPreview = {
  /** Host-generated opaque proposal identifier used for review decisions. */
  id: string;
  /** Provider-supplied identifier retained only for tool-call provenance. */
  toolCallId: string;
  agentInstanceId: string;
  lockOwnerId?: string;
  path: string;
  relativePath: string;
  status: PendingEditStatus;
  /** False while another exact-batch member has not reached proposal/terminal. */
  decisionReady?: boolean;
  createdAt: number;
  fileDiff: FileDiff;
};

export type PendingEditDecision =
  | { status: 'accepted'; message: string }
  | { status: 'rejected'; message: string }
  | { status: 'aborted'; message: string };
