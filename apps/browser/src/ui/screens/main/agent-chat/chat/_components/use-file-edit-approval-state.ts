import { useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { useRef } from 'react';
import {
  getFileEditApprovalVisualState,
  retainApplyingVisualState,
  type FileEditApprovalVisualState,
} from './file-edit-approval-state';

export function useFileEditApprovalVisualState(
  toolCallId: string | undefined,
): FileEditApprovalVisualState {
  const [openAgent] = useOpenAgent();

  return useKartonState((state) => {
    if (!openAgent) return null;
    return getFileEditApprovalVisualState(
      state.toolbox[openAgent]?.pendingProposedEdits ?? [],
      toolCallId,
    );
  });
}

export function useStableFileEditApprovalVisualState(
  toolCallId: string | undefined,
  toolPartState: string,
): FileEditApprovalVisualState {
  const liveState = useFileEditApprovalVisualState(toolCallId);
  const previousToolCallId = useRef(toolCallId);
  const retainedState = useRef<FileEditApprovalVisualState>(null);
  if (previousToolCallId.current !== toolCallId) {
    previousToolCallId.current = toolCallId;
    retainedState.current = null;
  }
  retainedState.current = retainApplyingVisualState(
    liveState,
    retainedState.current,
    toolPartState,
  );
  return retainedState.current;
}
