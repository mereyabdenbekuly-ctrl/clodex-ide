import { useCallback, useEffect, type ReactNode } from 'react';
import { IconPinTackFill18 } from '@clodex/icons';
import { MessageSquareIcon } from 'lucide-react';
import { ShortcutKey } from '@clodex/stage-ui/components/shortcut-key';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { useInlineTitleEdit } from '../../_lib/use-inline-title-edit';
import { cn } from '@ui/utils';
import type {
  AgentCommandItem,
  CommandCenterItem,
  FileContentMatch,
} from '../command-center-model';
import { getCommandCenterItemDomId } from '../command-center-model';
import { AGENT_STATUS_COLOR_CLASSES } from '@ui/lib/agent-status-colors';

function compactTimeAgo(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffDay < 365) return `${diffMonth}mo`;
  return `${Math.floor(diffDay / 365)}y`;
}

export function CommandCenterRow({
  item,
  selected,
  isRenaming,
  onSelect,
  onHover,
  onRef,
  onCancelRename,
  onCommitRename,
}: {
  item: CommandCenterItem;
  selected: boolean;
  isRenaming: boolean;
  onSelect: () => void;
  onHover: () => void;
  onRef: (node: HTMLDivElement | null) => void;
  onCancelRename: () => void;
  onCommitRename: (agentId: string, newTitle: string) => void;
}) {
  const agentStatusColor = (() => {
    if (item.kind !== 'agent') return null;
    if (item.hasError) return AGENT_STATUS_COLOR_CLASSES.error.dot;
    if (item.isWaitingForUser) return AGENT_STATUS_COLOR_CLASSES.warning.dot;
    if (item.isWorking) return AGENT_STATUS_COLOR_CLASSES.info.dot;
    if (item.unread) return AGENT_STATUS_COLOR_CLASSES.success.dot;
    return null;
  })();
  const isPinned =
    (item.kind === 'agent' || item.kind === 'tab') && item.isPinned;
  const lastMessageAgo =
    item.kind === 'agent' && item.lastMessageAt > 0
      ? compactTimeAgo(item.lastMessageAt)
      : null;

  return (
    <div
      id={getCommandCenterItemDomId(item.id)}
      ref={onRef}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-disabled={isRenaming || item.disabled ? true : undefined}
      onClick={() => {
        if (isRenaming || item.disabled) return;
        onSelect();
      }}
      onMouseEnter={onHover}
      className={cn(
        'relative grid min-h-11 w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs outline-none transition-[background-color,box-shadow,opacity] duration-150 ease-out',
        selected
          ? 'bg-token-list-hover-background shadow-codex-sm ring-1 ring-token-border-light'
          : 'hover:bg-token-list-hover-background/70',
        item.disabled && 'opacity-45',
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-0.5 h-5 w-0.5 -translate-y-1/2 rounded-full bg-token-primary"
        />
      )}
      <span
        className={cn(
          'flex size-6 items-center justify-center rounded-md text-token-text-secondary dark:brightness-125',
          selected &&
            'bg-token-main-surface-primary shadow-codex-sm ring-1 ring-token-border-light',
        )}
      >
        {agentStatusColor ? (
          <span className="relative size-2 shrink-0">
            <span
              className={cn('block size-full rounded-full', agentStatusColor)}
            />
            {item.kind === 'agent' && item.isWorking && (
              <span
                className={cn(
                  'absolute inset-0 block size-full animate-ping rounded-full',
                  agentStatusColor,
                )}
              />
            )}
          </span>
        ) : (
          (item.icon ?? (
            <MessageSquareIcon className="size-3.5" aria-hidden="true" />
          ))
        )}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {item.kind === 'agent' ? (
            <CommandCenterAgentTitle
              isRenaming={isRenaming}
              item={item}
              onCancelRename={onCancelRename}
              onCommitRename={onCommitRename}
            />
          ) : (
            <span className="truncate font-medium text-token-text-primary">
              {item.title}
            </span>
          )}
        </span>
        {item.kind === 'file' && item.contentMatches?.length ? (
          <CommandCenterFileContentMatches
            matches={item.contentMatches}
            query={item.contentMatchQuery ?? ''}
          />
        ) : (
          item.subtitle && (
            <span className="block truncate font-normal text-token-text-tertiary text-xs">
              {item.subtitle}
            </span>
          )
        )}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-token-text-tertiary">
        {item.kind === 'tab' && item.isActive && (
          <span className="hidden rounded-md bg-token-bg-tertiary px-1.5 py-0.5 font-medium text-[10px] text-token-text-secondary sm:inline">
            Current
          </span>
        )}
        {lastMessageAgo && (
          <span className="tabular-nums">{lastMessageAgo}</span>
        )}
        {isPinned && (
          <span
            role="img"
            aria-label="Pinned"
            className="flex size-4 items-center justify-center"
          >
            <IconPinTackFill18 className="size-3.5" />
          </span>
        )}
        {item.shortcut?.action && (
          <HotkeyCombo
            action={item.shortcut.action}
            size="xs"
            variant="chrome"
          />
        )}
        {!item.shortcut?.action &&
          (item.shortcut?.display || item.shortcut?.accelerator) && (
            <ShortcutKey className="hidden shrink-0 sm:flex" size="xs">
              {item.shortcut.display ?? item.shortcut.accelerator}
            </ShortcutKey>
          )}
        {selected && !isRenaming && !item.disabled && (
          <ShortcutKey
            aria-label="Press Enter to open"
            className="hidden shrink-0 sm:flex"
            size="xs"
          >
            ↵
          </ShortcutKey>
        )}
      </span>
    </div>
  );
}

function CommandCenterFileContentMatches({
  matches,
  query,
}: {
  matches: FileContentMatch[];
  query: string;
}) {
  return (
    <span className="block space-y-0.5 font-normal text-token-text-tertiary text-xs">
      {matches.map((match) => (
        <span key={match.lineNumber} className="block truncate">
          <span className="text-token-text-secondary tabular-nums">
            {match.lineNumber}:
          </span>{' '}
          <HighlightedContentLine line={match.line} query={query} />
        </span>
      ))}
    </span>
  );
}

function HighlightedContentLine({
  line,
  query,
}: {
  line: string;
  query: string;
}) {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return <>{line.trim()}</>;

  const normalizedLine = line.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = normalizedLine.indexOf(normalizedQuery);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(line.slice(cursor, matchIndex));
    }
    const end = matchIndex + query.length;
    parts.push(
      <mark
        key={`${matchIndex}-${end}`}
        className="rounded-sm bg-primary-solid/20 px-0.5 text-primary-foreground"
      >
        {line.slice(matchIndex, end)}
      </mark>,
    );
    cursor = end;
    matchIndex = normalizedLine.indexOf(normalizedQuery, cursor);
  }

  if (cursor < line.length) parts.push(line.slice(cursor));

  return <>{parts.length > 0 ? parts : line.trim()}</>;
}

function CommandCenterAgentTitle({
  item,
  isRenaming,
  onCancelRename,
  onCommitRename,
}: {
  item: AgentCommandItem;
  isRenaming: boolean;
  onCancelRename: () => void;
  onCommitRename: (agentId: string, newTitle: string) => void;
}) {
  const handleCommitRename = useCallback(
    (newTitle: string) => onCommitRename(item.agentId, newTitle),
    [item.agentId, onCommitRename],
  );
  const {
    isEditing,
    titleRef,
    displayTitle,
    startEditing,
    commitEdit,
    cancelEdit,
  } = useInlineTitleEdit({ title: item.title, onCommit: handleCommitRename });

  useEffect(() => {
    if (isRenaming && !isEditing) startEditing();
  }, [isEditing, isRenaming, startEditing]);

  useEffect(() => {
    if (!isRenaming && isEditing) cancelEdit();
  }, [cancelEdit, isEditing, isRenaming]);

  if (!isEditing) {
    return (
      <span className="truncate font-medium text-token-text-primary">
        {displayTitle}
      </span>
    );
  }

  return (
    <span
      ref={titleRef}
      role="textbox"
      contentEditable
      suppressContentEditableWarning
      className="truncate rounded bg-token-main-surface-primary p-0 text-left font-medium text-token-text-primary outline-none ring-1 ring-token-focus-border"
      onBlur={() => {
        commitEdit();
        onCancelRename();
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commitEdit();
          onCancelRename();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelEdit();
          onCancelRename();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {displayTitle}
    </span>
  );
}
