import type { AgentToolUIPart } from '@shared/karton-contracts/ui/agent';
import { isPlanPath } from '@clodex/agent-core/plans';
import { isLogPath } from '@clodex/agent-core/logs';
import { CreatePlanToolPart } from './create-plan';
import { CreateLogToolPart } from './create-log';
import { GenericWriteToolPart } from './generic-write';
import { useStableFileEditApprovalVisualState } from '../../../use-file-edit-approval-state';

export type WritePart = Extract<AgentToolUIPart, { type: 'tool-write' }>;

export const WriteToolPart = ({ part }: { part: WritePart }) => {
  const fileEditApprovalState = useStableFileEditApprovalVisualState(
    part.toolCallId,
    part.state,
  );

  if (isPlanPath(part.input?.path ?? ''))
    return (
      <CreatePlanToolPart
        part={part}
        fileEditApprovalState={fileEditApprovalState}
      />
    );

  if (isLogPath(part.input?.path ?? ''))
    return (
      <CreateLogToolPart
        part={part}
        fileEditApprovalState={fileEditApprovalState}
      />
    );

  return (
    <GenericWriteToolPart
      part={part}
      fileEditApprovalState={fileEditApprovalState}
    />
  );
};
