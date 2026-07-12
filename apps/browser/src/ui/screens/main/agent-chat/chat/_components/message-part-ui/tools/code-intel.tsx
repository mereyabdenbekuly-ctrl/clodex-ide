import { useMemo } from 'react';
import type { AgentToolUIPart } from '@shared/karton-contracts/ui/agent';
import { ToolPartUINotCollapsible } from './shared/tool-part-ui-not-collapsible';
import {
  IconSquareCodeOutline18,
  IconFileSearchOutline18,
  IconMagnifierOutline18,
} from 'nucleo-ui-outline-18';
import { stripMountPrefix } from '@ui/utils';

export const SearchProjectSymbolsToolPart = ({
  part,
  disableShimmer = false,
  minimal = false,
}: {
  part: Extract<AgentToolUIPart, { type: 'tool-searchProjectSymbols' }>;
  disableShimmer?: boolean;
  minimal?: boolean;
}) => {
  const query = part.input?.query ?? '';

  const streamingText = useMemo(() => {
    if (query) return `Searching code map for ${query}...`;
    return 'Searching code map...';
  }, [query]);

  const finishedText = useMemo(() => {
    if (part.state !== 'output-available') return undefined;
    const totalMatches = part.output?.result?.totalMatches ?? 0;
    return (
      <span className="flex min-w-0 gap-1">
        <span className="shrink-0 font-medium">Searched code map</span>
        <span className="truncate font-normal opacity-75">
          {query ? `${query} (${totalMatches})` : `${totalMatches} matches`}
        </span>
      </span>
    );
  }, [part.state, part.output, query]);

  return (
    <ToolPartUINotCollapsible
      icon={<IconMagnifierOutline18 className="size-3 shrink-0" />}
      part={part}
      minimal={minimal}
      disableShimmer={disableShimmer}
      streamingText={streamingText}
      finishedText={finishedText}
    />
  );
};

export const GetFileSkeletonToolPart = ({
  part,
  disableShimmer = false,
  minimal = false,
}: {
  part: Extract<AgentToolUIPart, { type: 'tool-getFileSkeleton' }>;
  disableShimmer?: boolean;
  minimal?: boolean;
}) => {
  const filePath = part.input?.path ?? '';
  const displayPath = filePath ? stripMountPrefix(filePath) : undefined;

  const streamingText = useMemo(() => {
    if (displayPath) return `Reading code map for ${displayPath}...`;
    return 'Reading code map...';
  }, [displayPath]);

  const finishedText = useMemo(() => {
    if (part.state !== 'output-available') return undefined;
    return (
      <span className="flex min-w-0 gap-1">
        <span className="shrink-0 font-medium">Mapped code</span>
        <span className="truncate font-normal opacity-75">
          {displayPath ?? ''}
        </span>
      </span>
    );
  }, [part.state, displayPath]);

  return (
    <ToolPartUINotCollapsible
      icon={<IconSquareCodeOutline18 className="size-3 shrink-0" />}
      part={part}
      minimal={minimal}
      disableShimmer={disableShimmer}
      streamingText={streamingText}
      finishedText={finishedText}
    />
  );
};

export const GetSymbolBodyToolPart = ({
  part,
  disableShimmer = false,
  minimal = false,
}: {
  part: Extract<AgentToolUIPart, { type: 'tool-getSymbolBody' }>;
  disableShimmer?: boolean;
  minimal?: boolean;
}) => {
  const symbolName = part.input?.symbolName ?? '';
  const filePath = part.input?.path ?? '';
  const displayPath = filePath ? stripMountPrefix(filePath) : undefined;

  const streamingText = useMemo(() => {
    if (symbolName) return `Reading ${symbolName}...`;
    return 'Reading symbol...';
  }, [symbolName]);

  const finishedText = useMemo(() => {
    if (part.state !== 'output-available') return undefined;
    return (
      <span className="flex min-w-0 gap-1">
        <span className="shrink-0 font-medium">Read symbol</span>
        <span className="truncate font-normal opacity-75">
          {symbolName || displayPath || ''}
        </span>
      </span>
    );
  }, [part.state, symbolName, displayPath]);

  return (
    <ToolPartUINotCollapsible
      icon={<IconFileSearchOutline18 className="size-3 shrink-0" />}
      part={part}
      minimal={minimal}
      disableShimmer={disableShimmer}
      streamingText={streamingText}
      finishedText={finishedText}
    />
  );
};
