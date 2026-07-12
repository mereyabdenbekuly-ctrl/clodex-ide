import { GitForkIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function AgentChatTitlebar({
  agentTitle,
  actions,
  lineage,
  teleport,
}: {
  agentTitle?: string;
  actions?: ReactNode;
  teleport?: ReactNode;
  lineage?: {
    sourceTitle: string;
    sourceMessageId?: string | null;
    onOpenSource: () => void;
  } | null;
}) {
  return (
    <div
      data-agent-chat-titlebar=""
      className="codex-thread-header app-drag pointer-events-none absolute inset-x-0 top-0 z-20 flex h-10 items-center border-b px-3 pr-44"
    >
      <span className="min-w-0 truncate font-medium text-sm text-token-text-primary">
        {agentTitle || 'New task'}
      </span>
      {lineage && (
        <>
          <span className="mx-2 shrink-0 text-token-text-tertiary">·</span>
          <button
            type="button"
            className="app-no-drag pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-token-text-tertiary text-xs transition-colors hover:bg-token-list-hover-background hover:text-token-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
            title={
              lineage.sourceMessageId
                ? `Forked from ${lineage.sourceTitle} at message ${lineage.sourceMessageId}`
                : `Forked from ${lineage.sourceTitle}`
            }
            onClick={lineage.onOpenSource}
          >
            <GitForkIcon className="size-3 shrink-0" />
            <span className="shrink-0">Forked from</span>
            <span className="max-w-52 truncate font-medium text-token-text-secondary">
              {lineage.sourceTitle}
            </span>
          </button>
        </>
      )}
      {teleport && (
        <>
          <span className="mx-2 shrink-0 text-token-text-tertiary">·</span>
          {teleport}
        </>
      )}
      {actions && (
        <div
          data-agent-chat-titlebar-actions=""
          data-tutorial="new-tab-buttons"
          className="app-no-drag pointer-events-auto absolute top-1 right-2 z-10 flex h-8 items-center gap-0 rounded-xl"
        >
          {actions}
        </div>
      )}
    </div>
  );
}
