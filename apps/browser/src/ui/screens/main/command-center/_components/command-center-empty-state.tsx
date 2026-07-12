import { LoaderCircleIcon, SearchXIcon } from 'lucide-react';
import type { CommandCenterMode } from '../command-center-model';

const modeLabels: Record<CommandCenterMode, string> = {
  global: 'commands',
  agents: 'tasks',
  browser: 'browser tabs',
  files: 'files',
  settings: 'settings',
};

export function CommandCenterEmptyState({
  isLoading,
  mode,
  query,
}: {
  isLoading?: boolean;
  mode: CommandCenterMode;
  query: string;
}) {
  const trimmedQuery = query.trim();

  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2.5 px-6 py-8 text-center">
      <span className="flex size-9 items-center justify-center rounded-xl border border-token-border-light bg-token-bg-secondary text-token-text-tertiary shadow-codex-sm">
        {isLoading ? (
          <LoaderCircleIcon className="size-4 animate-spin" />
        ) : (
          <SearchXIcon className="size-4" />
        )}
      </span>
      <div className="space-y-0.5">
        <p className="font-medium text-sm text-token-text-primary">
          {isLoading ? 'Searching…' : `No ${modeLabels[mode]} found`}
        </p>
        <p className="text-token-text-tertiary text-xs">
          {isLoading
            ? 'Results will appear as they become available.'
            : trimmedQuery
              ? `Try a different search than “${trimmedQuery}”.`
              : 'Start typing to search across Clodex.'}
        </p>
      </div>
    </div>
  );
}
