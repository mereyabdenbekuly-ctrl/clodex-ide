import type { AgentToolUIPart } from '@shared/karton-contracts/ui/agent';
import { ToolPartUINotCollapsible } from './shared/tool-part-ui-not-collapsible';
import { BotIcon } from 'lucide-react';

export const OpenManusToolPart = ({
  part,
  disableShimmer = false,
  minimal = false,
}: {
  part: Extract<AgentToolUIPart, { type: 'tool-runOpenManus' }>;
  disableShimmer?: boolean;
  minimal?: boolean;
}) => {
  const promptPreview = part.input?.prompt
    ? part.input.prompt.slice(0, 80)
    : undefined;
  const streamingText = promptPreview
    ? `Running OpenManus: ${promptPreview}...`
    : 'Running OpenManus...';
  const output = part.state === 'output-available' ? part.output : undefined;
  const finishedText = output
    ? `OpenManus ${output.exitCode === 0 ? 'completed' : output.timedOut ? 'timed out' : 'finished'}`
    : undefined;
  const content = output ? (
    <div className="flex flex-col gap-2 whitespace-pre-wrap break-words px-2 py-1 text-xs">
      <div className="text-muted-foreground">
        exitCode: {output.exitCode ?? 'null'}
        {output.signal ? `, signal: ${output.signal}` : ''}
      </div>
      {output.stdout && (
        <pre className="max-h-48 overflow-auto rounded bg-surface-2 p-2 text-[11px]">
          {output.stdout}
        </pre>
      )}
      {output.stderr && (
        <pre className="max-h-32 overflow-auto rounded bg-surface-2 p-2 text-[11px] text-destructive">
          {output.stderr}
        </pre>
      )}
    </div>
  ) : undefined;

  return (
    <ToolPartUINotCollapsible
      icon={<BotIcon className="size-3 shrink-0" />}
      part={part}
      minimal={minimal}
      disableShimmer={disableShimmer}
      streamingText={streamingText}
      finishedText={finishedText}
      content={content}
    />
  );
};
