import type { FileDiff } from './diff-history';

export type PendingEditStatus = 'pending' | 'accepted' | 'rejected' | 'aborted';

export type PendingEditPreview = {
  id: string;
  toolCallId: string;
  agentInstanceId: string;
  lockOwnerId?: string;
  path: string;
  relativePath: string;
  status: PendingEditStatus;
  createdAt: number;
  fileDiff: FileDiff;
};

export type PendingEditDecision =
  | { status: 'accepted'; message: string }
  | { status: 'rejected'; message: string }
  | { status: 'aborted'; message: string };
