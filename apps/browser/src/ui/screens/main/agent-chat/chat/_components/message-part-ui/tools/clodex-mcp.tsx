import type { DynamicToolUIPart } from 'ai';
import { useCallback, useMemo } from 'react';
import {
  CheckIcon,
  CloudIcon,
  LoaderCircleIcon,
  ServerIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@clodex/stage-ui/components/button';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { cn } from '@ui/utils';
import { ToolPartUI } from './shared/tool-part-ui';
import { ToolPartUINotCollapsible } from './shared/tool-part-ui-not-collapsible';

function displayToolName(type: string): string {
  return type
    .replace(/^tool-mcp_clodex_/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function stringifyPreview(value: unknown): string {
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const ClodexMcpToolPart = ({
  part,
  shimmer = false,
}: {
  part: DynamicToolUIPart;
  shimmer?: boolean;
}) => {
  const [openAgentId] = useOpenAgent();
  const sendApproval = useKartonProcedure(
    (p) => p.agents.sendToolApprovalResponse,
  );
  const toolName = displayToolName(part.type);
  const isLocalRemoteTool = toolName.startsWith('remote ');
  const displayName = toolName || 'cloud tool';
  const surfaceName = isLocalRemoteTool
    ? 'saved remote connection'
    : 'Clodex Cloud Tool';
  const streamingText = toolName
    ? `Calling ${surfaceName} ${toolName}...`
    : `Calling ${surfaceName}...`;
  const finishedText = toolName
    ? `${surfaceName} finished: ${toolName}`
    : `${surfaceName} finished`;

  const classifierExplanation = useKartonState((s) =>
    openAgentId
      ? s.agents.instances[openAgentId]?.state.pendingApprovals?.[
          part.toolCallId
        ]?.explanation
      : undefined,
  );

  const handleApprove = useCallback(() => {
    if (
      !openAgentId ||
      part.state !== 'approval-requested' ||
      !part.approval?.id
    )
      return;
    sendApproval(openAgentId, part.approval.id, true);
  }, [openAgentId, part, sendApproval]);

  const handleDeny = useCallback(() => {
    if (
      !openAgentId ||
      part.state !== 'approval-requested' ||
      !part.approval?.id
    )
      return;
    sendApproval(openAgentId, part.approval.id, false, 'User denied');
  }, [openAgentId, part, sendApproval]);

  const state = useMemo(() => {
    if (part.state === 'approval-requested') return 'approval' as const;
    if (part.state === 'approval-responded')
      return 'approval-responded' as const;
    if (part.state === 'output-denied') return 'denied' as const;
    if (part.state === 'output-error') return 'error' as const;
    if (part.state === 'input-streaming' || part.state === 'input-available')
      return 'streaming' as const;
    return 'success' as const;
  }, [part.state]);

  const trigger = useMemo(() => {
    const iconClassName = cn(
      'size-3 shrink-0',
      (state === 'approval' || state === 'approval-responded') &&
        'text-warning',
      state === 'streaming' && 'animate-icon-pulse text-primary-foreground',
    );

    if (state === 'approval' || state === 'approval-responded') {
      return (
        <div className="flex min-w-0 flex-1 flex-row items-center gap-1">
          {isLocalRemoteTool ? (
            <ServerIcon className={iconClassName} />
          ) : (
            <CloudIcon className={iconClassName} />
          )}
          <span className="truncate text-xs">
            Review {surfaceName}: {displayName}
          </span>
        </div>
      );
    }

    if (state === 'denied') {
      return (
        <div className="flex min-w-0 flex-1 flex-row items-center gap-1">
          <XIcon className="size-3 shrink-0" />
          <span className="truncate text-xs">
            Skipped {surfaceName}: {displayName}
          </span>
        </div>
      );
    }

    if (state === 'error') {
      return (
        <div className="flex min-w-0 flex-1 flex-row items-center gap-1">
          <XIcon className="size-3 shrink-0" />
          <span className="truncate text-xs">
            {part.errorText ?? `${surfaceName} failed: ${displayName}`}
          </span>
        </div>
      );
    }

    if (state === 'streaming') {
      return (
        <div className="flex min-w-0 flex-1 flex-row items-center gap-1">
          {isLocalRemoteTool ? (
            <ServerIcon className={iconClassName} />
          ) : (
            <CloudIcon className={iconClassName} />
          )}
          <span
            className={cn(
              'truncate text-xs',
              shimmer && 'shimmer-text-primary',
            )}
          >
            Calling {surfaceName}: {displayName}
          </span>
        </div>
      );
    }

    return (
      <div className="flex min-w-0 flex-1 flex-row items-center gap-1">
        <CheckIcon className="size-3 shrink-0" />
        <span className="truncate text-xs">
          {surfaceName} finished: {displayName}
        </span>
      </div>
    );
  }, [
    displayName,
    isLocalRemoteTool,
    part.errorText,
    shimmer,
    state,
    surfaceName,
  ]);

  const inputPreview = useMemo(
    () => stringifyPreview(part.input),
    [part.input],
  );
  const outputPreview = useMemo(() => {
    if (part.state !== 'output-available') return null;
    return stringifyPreview(part.output);
  }, [part]);

  const content = useMemo(
    () => (
      <div className="px-2 py-1">
        <div className="pb-1 font-medium text-muted-foreground text-xs">
          {isLocalRemoteTool
            ? 'Runs through an encrypted local SSH profile'
            : 'Runs remotely through Clodex Tools Gateway'}
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
          {inputPreview}
        </pre>
        {outputPreview && (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border-border/40 border-t pt-2 font-mono text-subtle-foreground text-xs">
            {outputPreview}
          </pre>
        )}
      </div>
    ),
    [inputPreview, isLocalRemoteTool, outputPreview],
  );

  const contentFooter = useMemo(() => {
    if (
      (state === 'approval' || state === 'approval-responded') &&
      part.state !== 'input-streaming'
    ) {
      return (
        <div className="flex w-full flex-col gap-2.5">
          <div className="mx-2 flex flex-row items-start gap-1.5 rounded-md px-1 py-0 text-warning-foreground text-xs leading-snug">
            <TriangleAlertIcon className="mt-[2px] size-3 shrink-0" />
            <div className="min-w-0 flex-1">
              {classifierExplanation ??
                `Review the exact ${surfaceName} arguments before allowing.`}
            </div>
          </div>
          <div className="flex w-full flex-row items-center justify-end gap-1.5">
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
    }
    return undefined;
  }, [
    classifierExplanation,
    handleApprove,
    handleDeny,
    part.state,
    state,
    surfaceName,
  ]);

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
      icon={
        isLocalRemoteTool ? (
          <ServerIcon className="size-3 shrink-0" />
        ) : (
          <CloudIcon className="size-3 shrink-0" />
        )
      }
      disableShimmer={!shimmer}
      minimal={true}
      streamingText={streamingText}
      finishedText={finishedText}
    />
  );
};
