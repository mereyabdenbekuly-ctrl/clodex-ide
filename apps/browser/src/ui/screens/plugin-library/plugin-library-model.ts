import type { PluginMarketplacePermission } from '@shared/plugin-marketplace';
import type { PluginLibrarySnapshot } from '@shared/plugin-library';

export type PluginLibraryStatusFilter =
  | 'all'
  | 'enabled'
  | 'disabled'
  | 'updates'
  | 'incompatible';

export type PluginLibrarySourceFilter = 'all' | 'bundled' | 'marketplace';

export type PluginLibraryFilters = {
  query: string;
  status: PluginLibraryStatusFilter;
  source: PluginLibrarySourceFilter;
};

export type PluginLibraryItem = {
  id: string;
  displayName: string;
  description: string;
  publisher: string | null;
  source: 'bundled' | 'marketplace';
  logoSvg: string | null;
  skills: Array<{ name: string; description: string }>;
  permissions: PluginMarketplacePermission[];
  requiredCredentials: string[];
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  enabled: boolean;
  compatible: boolean;
  compatibilityError: string | null;
  updateAvailable: boolean;
};

export type PluginLibrarySkillItem = {
  key: string;
  name: string;
  description: string;
  pluginId: string;
  pluginName: string;
  pluginSource: PluginLibraryItem['source'];
  pluginEnabled: boolean;
};

export type PluginLibrarySummary = {
  total: number;
  installed: number;
  enabled: number;
  updates: number;
  skills: number;
};

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function createPluginLibraryItems(
  snapshot: PluginLibrarySnapshot,
): PluginLibraryItem[] {
  const definitions = new Map(
    snapshot.plugins.map((plugin) => [plugin.id, plugin]),
  );
  const catalog = new Map(
    snapshot.marketplace.catalog.map((item) => [item.manifest.id, item]),
  );
  const installedEntries = new Map(
    snapshot.marketplace.installed.map((entry) => [entry.id, entry]),
  );
  const disabled = new Set(snapshot.disabledPluginIds);
  const ids = unique([
    ...Array.from(definitions.keys()),
    ...Array.from(catalog.keys()),
  ]);

  return ids
    .map((id): PluginLibraryItem => {
      const definition = definitions.get(id);
      const catalogItem = catalog.get(id);
      const installedEntry = installedEntries.get(id);
      const manifest = catalogItem?.manifest ?? installedEntry?.manifest;
      const installed =
        definition?.source === 'bundled' ||
        Boolean(installedEntry) ||
        Boolean(catalogItem?.installedVersion);
      const source = definition?.source ?? 'marketplace';

      return {
        id,
        displayName: definition?.displayName ?? manifest?.displayName ?? id,
        description:
          definition?.description ??
          manifest?.description ??
          'No plugin description is available.',
        publisher: manifest?.publisher ?? null,
        source,
        logoSvg: definition?.logoSvg ?? null,
        skills: definition?.skills ?? [],
        permissions: unique([
          ...(definition?.permissions ?? []),
          ...(manifest?.permissions ?? []),
        ]),
        requiredCredentials: unique([
          ...(definition?.requiredCredentials ?? []),
          ...(manifest?.requiredCredentials ?? []),
        ]),
        installed,
        installedVersion:
          catalogItem?.installedVersion ??
          installedEntry?.version ??
          definition?.version ??
          null,
        latestVersion: manifest?.version ?? definition?.version ?? null,
        enabled: installed && !disabled.has(id),
        compatible: catalogItem?.compatible ?? true,
        compatibilityError: catalogItem?.compatibilityError ?? null,
        updateAvailable: catalogItem?.updateAvailable ?? false,
      };
    })
    .sort((left, right) => {
      const installedDelta = Number(right.installed) - Number(left.installed);
      return (
        installedDelta ||
        left.displayName.localeCompare(right.displayName, undefined, {
          sensitivity: 'base',
        })
      );
    });
}

export function filterPluginLibraryItems(
  items: PluginLibraryItem[],
  filters: PluginLibraryFilters,
): PluginLibraryItem[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.source !== 'all' && item.source !== filters.source)
      return false;
    if (filters.status === 'enabled' && !item.enabled) return false;
    if (filters.status === 'disabled' && (!item.installed || item.enabled)) {
      return false;
    }
    if (filters.status === 'updates' && !item.updateAvailable) return false;
    if (filters.status === 'incompatible' && item.compatible) return false;
    if (!query) return true;

    return [
      item.id,
      item.displayName,
      item.description,
      item.publisher ?? '',
      ...item.permissions,
      ...item.skills.flatMap((skill) => [skill.name, skill.description]),
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function createPluginLibrarySkills(
  items: PluginLibraryItem[],
): PluginLibrarySkillItem[] {
  return items
    .flatMap((plugin) =>
      plugin.skills.map((skill) => ({
        key: `${plugin.id}:${skill.name}`,
        name: skill.name,
        description: skill.description,
        pluginId: plugin.id,
        pluginName: plugin.displayName,
        pluginSource: plugin.source,
        pluginEnabled: plugin.enabled,
      })),
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
    );
}

export function filterPluginLibrarySkills(
  skills: PluginLibrarySkillItem[],
  query: string,
): PluginLibrarySkillItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return skills;
  return skills.filter((skill) =>
    [skill.name, skill.description, skill.pluginName, skill.pluginId].some(
      (value) => value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

export function getPluginLibrarySummary(
  items: PluginLibraryItem[],
): PluginLibrarySummary {
  return {
    total: items.length,
    installed: items.filter((item) => item.installed).length,
    enabled: items.filter((item) => item.enabled).length,
    updates: items.filter((item) => item.updateAvailable).length,
    skills: items.reduce((total, item) => total + item.skills.length, 0),
  };
}
