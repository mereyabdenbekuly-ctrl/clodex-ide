import { useCallback } from 'react';
import { Checkbox } from '@clodex/stage-ui/components/checkbox';
import { cn } from '@ui/utils';
import type {
  FileSearchFilterState,
  FileSearchWorkspaceOption,
} from '../sources/use-file-command-items';

export function CommandCenterFileFilter({
  workspaceOptions,
  filterState,
  onFilterChange,
}: {
  workspaceOptions: FileSearchWorkspaceOption[];
  filterState: FileSearchFilterState;
  onFilterChange: (state: FileSearchFilterState) => void;
}) {
  // An empty selection means "all workspaces". Toggling collapses back to the
  // empty set once every workspace is selected, keeping a single source of
  // truth for the "all" state.
  const { selectedWorkspaceKeys } = filterState;
  const isAllSelected = selectedWorkspaceKeys.size === 0;

  const toggleWorkspace = useCallback(
    (key: string) => {
      // "All" (empty set) means every workspace is active, so start from the
      // full set and toggle only the clicked badge — never the others.
      const next = isAllSelected
        ? new Set(workspaceOptions.map((option) => option.key))
        : new Set(selectedWorkspaceKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      // Collapse back to the canonical "all" representation when every (or no)
      // workspace ends up selected.
      const collapsed =
        next.size === 0 || next.size === workspaceOptions.length
          ? new Set<string>()
          : next;
      onFilterChange({ ...filterState, selectedWorkspaceKeys: collapsed });
    },
    [
      filterState,
      isAllSelected,
      onFilterChange,
      selectedWorkspaceKeys,
      workspaceOptions,
    ],
  );

  const setGitignored = useCallback(
    (checked: boolean) => {
      onFilterChange({ ...filterState, includeGitignored: checked });
    },
    [filterState, onFilterChange],
  );

  const setSearchInContent = useCallback(
    (checked: boolean) => {
      onFilterChange({ ...filterState, searchInContent: checked });
    },
    [filterState, onFilterChange],
  );

  // Nothing to search → no bar.
  if (workspaceOptions.length === 0) return null;

  const singleWorkspace =
    workspaceOptions.length === 1 ? workspaceOptions[0] : null;

  // The gitignored toggle is only meaningful when at least one of the
  // workspaces actually being searched is a git repository / worktree.
  const searchedIsGit = workspaceOptions.some(
    (workspace) =>
      (isAllSelected || selectedWorkspaceKeys.has(workspace.key)) &&
      workspace.isGit,
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-token-border-light border-b bg-token-bg-secondary/35 px-3 py-2">
      {singleWorkspace ? (
        <span className="min-w-0 flex-1 truncate text-token-text-tertiary text-xs">
          Searching{' '}
          <strong className="font-medium text-token-text-secondary">
            {singleWorkspace.label}
          </strong>
        </span>
      ) : (
        <div className="flex min-w-[14rem] flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="shrink-0 whitespace-nowrap pr-1 text-token-text-tertiary text-xs">
            Search in
          </span>
          {workspaceOptions.map((workspace) => {
            const selected =
              isAllSelected || selectedWorkspaceKeys.has(workspace.key);
            return (
              <button
                key={workspace.key}
                type="button"
                title={workspace.label}
                aria-pressed={selected}
                onClick={() => toggleWorkspace(workspace.key)}
                className={cn(
                  'h-6 shrink-0 cursor-default whitespace-nowrap rounded-lg px-2 text-xs transition-[background-color,color,box-shadow] duration-150 ease-out',
                  selected
                    ? 'bg-token-bg-tertiary text-token-text-primary shadow-codex-sm ring-1 ring-token-border-light'
                    : 'text-token-text-tertiary ring-1 ring-token-border-light ring-inset hover:bg-token-list-hover-background hover:text-token-text-primary',
                )}
              >
                {workspace.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex w-full shrink-0 items-center gap-3 sm:w-auto">
        <button
          type="button"
          onClick={() => setSearchInContent(!filterState.searchInContent)}
          className="flex cursor-pointer items-center gap-1.5 text-token-text-tertiary text-xs transition-colors hover:text-token-text-primary"
        >
          <Checkbox
            size="xs"
            checked={filterState.searchInContent}
            className="pointer-events-none"
            tabIndex={-1}
          />
          <span>Search in content</span>
        </button>
        {searchedIsGit && (
          <button
            type="button"
            onClick={() => setGitignored(!filterState.includeGitignored)}
            className="flex cursor-pointer items-center gap-1.5 text-token-text-tertiary text-xs transition-colors hover:text-token-text-primary"
          >
            <Checkbox
              size="xs"
              checked={filterState.includeGitignored}
              className="pointer-events-none"
              tabIndex={-1}
            />
            <span>Include gitignored</span>
          </button>
        )}
      </div>
    </div>
  );
}
