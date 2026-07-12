import { useMemo } from 'react';
import type {
  CommandCenterItem,
  CommandCenterMode,
} from '../command-center-model';
import { useAgentCommandItems } from './use-agent-command-items';
import { useSettingsCommandItems } from './use-settings-command-items';
import { useTabCommandItems } from './use-tab-command-items';
import { useFileSearchCommandItems } from './use-file-command-items';
import type { FileSearchFilterState as FileFilterState } from './use-file-command-items';
import { useActionCommandItems } from './use-action-command-items';

const GLOBAL_RECENT_SECTION_LIMITS = {
  agents: 4,
  tabs: 2,
  files: 0,
  settings: 5,
} as const;

const GLOBAL_SEARCH_SECTION_LIMITS = {
  agents: 8,
  tabs: 6,
  files: 8,
  settings: 8,
} as const;

const EMPTY_FILE_FILTER: FileFilterState = {
  selectedWorkspaceKeys: new Set<string>(),
  includeGitignored: false,
  searchInContent: false,
};

export function useCommandCenterItems({
  query,
  mode,
  optimisticAgentTitles,
  optimisticPinnedAgentIds,
  pendingRemovalAgentIds,
  fileSearchFilter,
}: {
  query: string;
  mode: CommandCenterMode;
  optimisticAgentTitles?: Readonly<Record<string, string>>;
  optimisticPinnedAgentIds?: string[] | null;
  pendingRemovalAgentIds?: ReadonlySet<string>;
  fileSearchFilter?: FileFilterState;
}) {
  const agents = useAgentCommandItems(query, {
    optimisticAgentTitles,
    optimisticPinnedAgentIds,
    pendingRemovalAgentIds,
    enabled: mode === 'global' || mode === 'agents',
  });
  const tabs = useTabCommandItems(query);
  const settings = useSettingsCommandItems(query);
  const actions = useActionCommandItems(query);
  // File search runs in both "files" mode and the "all" (global) mode. In
  // global mode we always search across every connected workspace (empty
  // filter), ignoring the per-workspace selection that only applies to the
  // dedicated files mode.
  const fileSearchActive = mode === 'files' || mode === 'global';
  const {
    items: fileItems,
    isLoading: fileIsLoading,
    isRecent: fileIsRecent,
    workspaceOptions,
  } = useFileSearchCommandItems(
    fileSearchActive ? query : '',
    mode === 'files'
      ? (fileSearchFilter ?? EMPTY_FILE_FILTER)
      : EMPTY_FILE_FILTER,
    // Only the dedicated files mode shows recently-changed files on an empty
    // query; the global view stays empty until the user types.
    mode === 'files',
  );

  const items = useMemo<CommandCenterItem[]>(() => {
    if (mode === 'agents') return agents.items;
    if (mode === 'browser') return tabs.items;
    if (mode === 'files') return fileItems;
    if (mode === 'settings') return settings.items;

    const limits = query.trim()
      ? GLOBAL_SEARCH_SECTION_LIMITS
      : GLOBAL_RECENT_SECTION_LIMITS;

    // Keep the global view useful even with a long task history. A single
    // high-recency source must not crowd tabs, files, and settings out of the
    // palette; each section gets a bounded slice of its own ranked results.
    return [
      ...agents.items.slice(0, limits.agents),
      ...tabs.items.slice(0, limits.tabs),
      ...fileItems.slice(0, limits.files),
      ...settings.items.slice(0, limits.settings),
      ...actions.items,
    ];
  }, [
    actions.items,
    agents.items,
    fileItems,
    mode,
    query,
    settings.items,
    tabs.items,
  ]);

  return {
    items,
    isLoading: fileSearchActive
      ? fileIsLoading || (mode === 'global' && agents.isLoading)
      : agents.isLoading,
    fileIsRecent,
    workspaceOptions,
    rawAgentTitles: agents.rawAgentTitles,
    refreshAgentHistory: agents.refreshHistoryList,
  };
}
