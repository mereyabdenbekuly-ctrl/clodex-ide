import { useMemo } from 'react';
import {
  IconBrainNodesFillDuo18,
  IconBranchOutOutline18,
  IconGear3FillDuo18,
  IconHistoryFillDuo18,
  IconKey2Outline18,
  IconNoteFillDuo18,
  IconServerOutline18,
  IconSpace3dFillDuo18,
} from '@clodex/icons';
import {
  CloudCogIcon,
  CalendarClockIcon,
  DatabaseIcon,
  PaletteIcon,
  ServerCogIcon,
} from 'lucide-react';
import type { SettingCommandItem } from '../command-center-model';
import {
  commandCenterSettings,
  type CommandCenterSettingDefinition,
} from '../command-center-settings';
import { filterAndRankCommandCenterItems } from '../command-center-search';

function iconForSetting(setting: CommandCenterSettingDefinition) {
  const className = 'size-4';
  switch (setting.iconName) {
    case 'models':
      return <IconBrainNodesFillDuo18 className={className} />;
    case 'key':
      return <IconKey2Outline18 className={className} />;
    case 'provider':
      return <IconServerOutline18 className={className} />;
    case 'context':
      return <IconNoteFillDuo18 className={className} />;
    case 'worktrees':
      return <IconBranchOutOutline18 className={className} />;
    case 'remote':
      return <ServerCogIcon className={className} />;
    case 'plugins':
      return <IconSpace3dFillDuo18 className={`${className} rotate-180`} />;
    case 'mcp':
      return <CloudCogIcon className={className} />;
    case 'memory':
      return <DatabaseIcon className={className} />;
    case 'automations':
      return <CalendarClockIcon className={className} />;
    case 'history':
      return <IconHistoryFillDuo18 className={className} />;
    case 'personalization':
      return <PaletteIcon className={className} />;
    case 'settings':
    case 'browser':
      return <IconGear3FillDuo18 className={className} />;
  }
}

export function useSettingsCommandItems(query: string) {
  const allItems = useMemo<SettingCommandItem[]>(
    () =>
      commandCenterSettings.map((setting) => ({
        ...setting,
        kind: 'setting',
        mode: 'settings',
        icon: iconForSetting(setting),
      })),
    [],
  );

  const items = useMemo(
    () => filterAndRankCommandCenterItems(allItems, query),
    [allItems, query],
  );

  return { items };
}
