type PendingFileEditIdentity = {
  status: string;
  toolCallId: string;
};

export type FileEditApprovalVisualState = 'waiting' | 'applying' | null;

export function retainApplyingVisualState(
  liveState: FileEditApprovalVisualState,
  previousState: FileEditApprovalVisualState,
  toolPartState: string,
): FileEditApprovalVisualState {
  if (
    toolPartState === 'output-available' ||
    toolPartState === 'output-error'
  ) {
    return null;
  }
  if (liveState) return liveState;
  return previousState === 'applying' ? 'applying' : null;
}

export function getFileEditApprovalVisualState(
  proposedEdits: readonly PendingFileEditIdentity[],
  toolCallId: string | undefined,
): FileEditApprovalVisualState {
  if (!toolCallId) return null;
  const proposal = proposedEdits.find((edit) => edit.toolCallId === toolCallId);
  if (proposal?.status === 'pending') return 'waiting';
  if (proposal?.status === 'applying') return 'applying';
  return null;
}

export function hasPendingFileEditApproval(
  proposedEdits: readonly PendingFileEditIdentity[],
  toolCallId: string | undefined,
): boolean {
  return (
    getFileEditApprovalVisualState(proposedEdits, toolCallId) === 'waiting'
  );
}
