import type {
  GeneratedApp,
  GeneratedAppsSort,
  GeneratedAppsStatusFilter,
  GeneratedAppsSummary,
} from '@shared/generated-apps';

export type GeneratedAppsFilterState = {
  query: string;
  status: GeneratedAppsStatusFilter;
  workspacePath: string | null;
  sort: GeneratedAppsSort;
};

export function getGeneratedAppsSummary(
  apps: GeneratedApp[],
): GeneratedAppsSummary {
  return {
    total: apps.length,
    ready: apps.filter((app) => app.status === 'ready').length,
    needsAttention: apps.filter(
      (app) => app.status === 'broken' || app.status === 'missing',
    ).length,
    regenerating: apps.filter((app) => app.status === 'regenerating').length,
  };
}

export function getGeneratedAppWorkspaceOptions(
  apps: GeneratedApp[],
): string[] {
  return Array.from(
    new Set(
      apps
        .map((app) => app.owner.workspacePath)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' }),
  );
}

function statusMatches(
  app: GeneratedApp,
  status: GeneratedAppsStatusFilter,
): boolean {
  if (status === 'all') return true;
  if (status === 'attention')
    return app.status === 'broken' || app.status === 'missing';
  return app.status === status;
}

export function filterGeneratedApps(
  apps: GeneratedApp[],
  filters: GeneratedAppsFilterState,
): GeneratedApp[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const filtered = apps.filter((app) => {
    if (!statusMatches(app, filters.status)) return false;
    if (
      filters.workspacePath &&
      app.owner.workspacePath !== filters.workspacePath
    ) {
      return false;
    }
    if (!query) return true;

    return [
      app.title,
      app.description ?? '',
      app.appId,
      app.owner.taskTitle ?? '',
      app.owner.workspacePath ?? '',
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });

  return filtered.sort((left, right) => {
    if (filters.sort === 'title-asc') {
      return left.title.localeCompare(right.title, undefined, {
        sensitivity: 'base',
      });
    }
    if (filters.sort === 'opened-desc') {
      const rightOpened = right.lastOpenedAt
        ? Date.parse(right.lastOpenedAt)
        : 0;
      const leftOpened = left.lastOpenedAt ? Date.parse(left.lastOpenedAt) : 0;
      const openedDiff = rightOpened - leftOpened;
      if (openedDiff !== 0) return openedDiff;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}
