import type { AgentToolUIPart } from '@shared/karton-contracts/ui/agent';
import { Button } from '@clodex/stage-ui/components/button';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import {
  CheckIcon,
  DatabaseIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { ToolPartUI } from './shared/tool-part-ui';
import { ToolPartUINotCollapsible } from './shared/tool-part-ui-not-collapsible';

type MemoryToolPart = Extract<
  AgentToolUIPart,
  {
    type:
      | 'tool-addMemory'
      | 'tool-listMemories'
      | 'tool-readMemory'
      | 'tool-searchMemories'
      | 'tool-deleteMemory';
  }
>;

const LABELS: Record<MemoryToolPart['type'], string> = {
  'tool-addMemory': 'Save memory note',
  'tool-listMemories': 'List memory notes',
  'tool-readMemory': 'Read memory note',
  'tool-searchMemories': 'Search memory notes',
  'tool-deleteMemory': 'Delete memory note',
};

function stringifyPreview(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

export function MemoryToolPart({
  part,
  shimmer = false,
}: {
  part: MemoryToolPart;
  shimmer?: boolean;
}) {
  const [openAgentId] = useOpenAgent();
  const sendApproval = useKartonProcedure(
    (procedures) => procedures.agents.sendToolApprovalResponse,
  );
  const label = LABELS[part.type];

  const handleApprove = useCallback(() => {
    if (
      !openAgentId ||
      part.state !== 'approval-requested' ||
      !part.approval?.id
    ) {
      return;
    }
    sendApproval(openAgentId, part.approval.id, true);
  }, [openAgentId, part, sendApproval]);

  const handleDeny = useCallback(() => {
    if (
      !openAgentId ||
      part.state !== 'approval-requested' ||
      !part.approval?.id
    ) {
      return;
    }
    sendApproval(openAgentId, part.approval.id, false, 'User denied');
  }, [openAgentId, part, sendApproval]);

  const state = useMemo(() => {
    if (part.state === 'approval-requested') return 'approval' as const;
    if (part.state === 'approval-responded')
      return 'approval-responded' as const;
    if (part.state === 'output-denied') return 'denied' as const;
    if (part.state === 'output-error') return 'error' as const;
    if (part.state === 'input-streaming' || part.state === 'input-available') {
      return 'streaming' as const;
    }
    return 'success' as const;
  }, [part.state]);

  const trigger = useMemo(() => {
    if (state === 'approval' || state === 'approval-responded') {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-warning">
          <DatabaseIcon className="size-3 shrink-0" />
          <span className="truncate text-xs">Review: {label}</span>
        </div>
      );
    }
    if (state === 'denied') {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <XIcon className="size-3 shrink-0" />
          <span className="truncate text-xs">Skipped: {label}</span>
        </div>
      );
    }
    if (state === 'error') {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <XIcon className="size-3 shrink-0" />
          <span className="truncate text-xs">
            {part.errorText ?? `Failed: ${label}`}
          </span>
        </div>
      );
    }
    if (state === 'streaming') {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <DatabaseIcon className="size-3 shrink-0 animate-icon-pulse text-primary-foreground" />
          <span
            className={
              shimmer
                ? 'shimmer-text-primary truncate text-xs'
                : 'truncate text-xs'
            }
          >
            {label}…
          </span>
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <CheckIcon className="size-3 shrink-0" />
        <span className="truncate text-xs">{label} completed</span>
      </div>
    );
  }, [label, part.errorText, shimmer, state]);

  const inputPreview = useMemo(
    () => stringifyPreview(part.input),
    [part.input],
  );
  const content = useMemo(
    () => (
      <div className="px-2 py-1">
        <div className="pb-1 font-medium text-muted-foreground text-xs">
          Review the exact memory operation
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
          {inputPreview}
        </pre>
      </div>
    ),
    [inputPreview],
  );

  const contentFooter = useMemo(() => {
    if (
      (state !== 'approval' && state !== 'approval-responded') ||
      part.state === 'input-streaming'
    ) {
      return undefined;
    }
    const warning =
      part.type === 'tool-deleteMemory'
        ? 'This permanently deletes the selected long-term memory note.'
        : 'This stores information in persistent long-term memory. Confirm that the scope and sensitivity are correct.';
    return (
      <div className="flex w-full flex-col gap-2.5">
        <div className="mx-2 flex items-start gap-1.5 text-warning-foreground text-xs leading-snug">
          <TriangleAlertIcon className="mt-[2px] size-3 shrink-0" />
          <div className="min-w-0 flex-1">{warning}</div>
        </div>
        <div className="flex w-full items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleDeny}
            disabled={state === 'approval-responded'}
          >
            Skip
          </Button>
          <Button
            variant="primary"
            size="xs"
            onClick={handleApprove}
            disabled={state === 'approval-responded'}
          >
            {state === 'approval-responded' && (
              <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
            )}
            Allow
          </Button>
        </div>
      </div>
    );
  }, [handleApprove, handleDeny, part.state, part.type, state]);

  if (
    state === 'approval' ||
    state === 'approval-responded' ||
    state === 'denied'
  ) {
    return (
      <ToolPartUI
        showBorder
        expanded={true}
        setExpanded={() => {}}
        trigger={trigger}
        content={content}
        contentFooter={contentFooter}
        contentFooterStatic={!!contentFooter}
        contentFooterClassName="px-2 py-1"
        contentClassName="max-h-64 pb-0"
      />
    );
  }

  return (
    <ToolPartUINotCollapsible
      part={part}
      icon={<DatabaseIcon className="size-3 shrink-0" />}
      disableShimmer={!shimmer}
      minimal
      streamingText={`${label}…`}
      finishedText={`${label} completed`}
    />
  );
}
