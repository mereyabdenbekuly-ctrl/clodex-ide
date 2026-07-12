import { HotkeyActions } from '@shared/hotkeys';
import {
  AppWindowIcon,
  BlocksIcon,
  FolderIcon,
  GitPullRequestArrowIcon,
  MessageSquarePlusIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import type { ActionCommandItem } from '../command-center-model';
import { filterAndRankCommandCenterItems } from '../command-center-search';

export function useActionCommandItems(query: string) {
  const allItems = useMemo<ActionCommandItem[]>(
    () => [
      {
        id: 'action:open-quick-task',
        kind: 'action',
        mode: 'global',
        actionId: 'open-quick-task',
        title: 'New Quick Task',
        subtitle: 'Create and run a task from a focused composer',
        keywords: ['new', 'prompt', 'composer', 'quick', 'task'],
        icon: <MessageSquarePlusIcon className="size-4" />,
        shortcut: { action: HotkeyActions.OPEN_QUICK_TASK },
      },
      {
        id: 'action:review-hosted-pr',
        kind: 'action',
        mode: 'global',
        actionId: 'review-hosted-pr',
        title: 'Review Hosted Pull Request',
        subtitle: 'Detect the GitHub PR for the current workspace',
        keywords: ['github', 'pull request', 'pr', 'review', 'checks', 'diff'],
        icon: <GitPullRequestArrowIcon className="size-4" />,
      },
      {
        id: 'action:open-generated-apps',
        kind: 'action',
        mode: 'global',
        actionId: 'open-generated-apps',
        title: 'Open Generated Apps',
        subtitle: 'Browse and launch apps created by your tasks',
        keywords: [
          'app',
          'apps',
          'generated',
          'mini app',
          'preview',
          'library',
        ],
        icon: <AppWindowIcon className="size-4" />,
      },
      {
        id: 'action:open-plugin-library',
        kind: 'action',
        mode: 'global',
        actionId: 'open-plugin-library',
        title: 'Open Skills & Plugins',
        subtitle: 'Browse capabilities, permissions, and verified extensions',
        keywords: [
          'skills',
          'plugins',
          'extensions',
          'marketplace',
          'capabilities',
          'permissions',
        ],
        icon: <BlocksIcon className="size-4" />,
      },
      {
        id: 'action:open-projects',
        kind: 'action',
        mode: 'global',
        actionId: 'open-projects',
        title: 'Open Projects',
        subtitle: 'Browse tasks grouped by connected workspace',
        keywords: ['workspace', 'repository', 'repo', 'project', 'tasks'],
        icon: <FolderIcon className="size-4" />,
      },
    ],
    [],
  );

  const items = useMemo(
    () => filterAndRankCommandCenterItems(allItems, query),
    [allItems, query],
  );

  return { items };
}
