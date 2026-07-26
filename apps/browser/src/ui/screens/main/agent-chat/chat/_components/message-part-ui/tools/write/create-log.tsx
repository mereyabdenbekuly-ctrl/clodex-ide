import { useMemo } from 'react';
import type { WritePart } from '.';
import { ToolPartUINotCollapsible } from '../shared/tool-part-ui-not-collapsible';
import { IconBugOutline18 } from '@clodex/icons';
import { stripMountPrefix } from '@ui/utils';
import { LOGS_PREFIX } from '@clodex/agent-core/logs';
import { FileEditApprovalStatus } from '../shared/file-edit-approval-waiting';
import type { FileEditApprovalVisualState } from '../../../file-edit-approval-state';

export const CreateLogToolPart = ({
  part,
  fileEditApprovalState = null,
}: {
  part: WritePart;
  fileEditApprovalState?: FileEditApprovalVisualState;
}) => {
  const channelName = useMemo(() => {
    const raw = stripMountPrefix(part.input?.path ?? '');
    return raw
      .replace(new RegExp(`^${LOGS_PREFIX}/`), '')
      .replace(/\.jsonl$/, '');
  }, [part.input?.path]);

  const streamingText = `Creating ${channelName} log…`;

  const finishedText =
    part.state === 'output-available' ? (
      <span className="flex min-w-0 gap-1">
        <span className="shrink-0 font-medium">Enabled</span>
        <span className="truncate font-normal opacity-75">
          {channelName} log
        </span>
      </span>
    ) : undefined;

  if (fileEditApprovalState) {
    return (
      <FileEditApprovalStatus
        relativePath={part.input?.path}
        state={fileEditApprovalState}
      />
    );
  }

  return (
    <ToolPartUINotCollapsible
      icon={<IconBugOutline18 className="size-3 shrink-0" />}
      part={part}
      streamingText={streamingText}
      finishedText={finishedText}
    />
  );
};
