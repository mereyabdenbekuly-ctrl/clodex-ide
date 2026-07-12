import type { PluginMarketplaceOperationResult } from './plugin-marketplace';
import type { PluginMarketplaceState } from './plugin-marketplace';
import type { PluginDefinition } from './plugins';

export const PLUGIN_LIBRARY_URL = 'clodex://internal/plugins' as const;
export const SKILLS_LIBRARY_URL = 'clodex://internal/skills' as const;

export type PluginLibrarySnapshot = {
  plugins: PluginDefinition[];
  marketplace: PluginMarketplaceState;
  disabledPluginIds: string[];
  configuredCredentialIds: string[];
};

export type PluginLibraryMarketplaceOperation =
  | 'install'
  | 'update'
  | 'uninstall';

export type PluginLibraryOperationResult = {
  result: PluginMarketplaceOperationResult;
  snapshot: PluginLibrarySnapshot;
};

export type PluginLibraryCredentialInput = {
  typeId: string;
  data: Record<string, string>;
};

export function createPluginLibraryDetailUrl(pluginId: string): string {
  return `${PLUGIN_LIBRARY_URL}/${encodeURIComponent(pluginId)}`;
}
