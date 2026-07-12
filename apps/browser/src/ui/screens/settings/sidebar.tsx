import { useCallback } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { cn } from '@ui/utils';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useUiZoomCounterScale } from '@ui/hooks/use-ui-zoom-counter-scale';
import {
  TITLEBAR_HEIGHT,
  TITLEBAR_ICON_OPTICAL_OFFSET,
} from '@shared/titlebar';
import { SidebarTitlebarRow } from '../main/_components/sidebar-titlebar-row';
import { SidebarAuthFooter } from '../main/_components/sidebar-auth-footer';
import { useCommandCenter } from '../main/command-center';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { HotkeyActions } from '@shared/hotkeys';
import { SearchIcon } from 'lucide-react';
import { resolveFeatureGate } from '@shared/feature-gates';
import {
  SETTINGS_NAV_GROUPS,
  getSettingsSectionLabel,
  isSectionActive,
} from './settings-route';
import type { SettingsRootSection } from './settings-route';

export function SettingsSidebar() {
  const counterScale = useUiZoomCounterScale();
  const isMacOs = useKartonState((s) => s.appInfo.platform === 'darwin');
  const activeRoute = useKartonState((s) => s.appScreen.settingsRoute);
  const featureGateOverrides = useKartonState(
    (s) => s.preferences.featureGates.overrides,
  );
  const releaseChannel = useKartonState((s) => s.appInfo.releaseChannel);
  const setSettingsRoute = useKartonProcedure(
    (p) => p.appScreen.setSettingsRoute,
  );
  const closeSettings = useKartonProcedure((p) => p.appScreen.closeSettings);
  const { open: openCommandCenter } = useCommandCenter();

  const handleSelectSection = useCallback(
    (section: SettingsRootSection) => {
      setSettingsRoute({ section });
    },
    [setSettingsRoute],
  );

  return (
    <div className="flex h-full flex-col items-stretch">
      <SidebarTitlebarRow absolute showSidebarToggle={false}>
        <div className="pl-2">
          <Button
            variant="ghost"
            size="sm"
            className="app-no-drag shrink-0 px-1.5"
            style={
              isMacOs ? { marginTop: TITLEBAR_ICON_OPTICAL_OFFSET } : undefined
            }
            onClick={() => closeSettings()}
          >
            ← Back
          </Button>
        </div>
      </SidebarTitlebarRow>
      <div
        className="flex h-full min-h-0 flex-col items-stretch p-2"
        style={{ paddingTop: (TITLEBAR_HEIGHT + 8) * counterScale }}
      >
        <div className="shrink-0 px-1.5 pt-1 pb-3">
          <h1 className="font-semibold text-lg text-token-text-primary tracking-[-0.015em]">
            Settings
          </h1>
          <button
            type="button"
            className="app-no-drag mt-3 flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-token-border-light bg-token-main-surface-primary/45 px-2.5 text-left text-sm text-token-text-tertiary shadow-codex-sm transition-colors hover:bg-token-list-hover-background hover:text-token-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
            onClick={() =>
              openCommandCenter({
                initialMode: 'settings',
                selectFirst: false,
              })
            }
          >
            <SearchIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search settings…</span>
            <HotkeyCombo
              action={HotkeyActions.OPEN_COMMAND_CENTER}
              size="xs"
              variant="chrome"
            />
          </button>
        </div>

        {/* Navigation groups */}
        <nav className="scrollbar-subtle flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pr-1.5 pb-3.5 pl-0.5">
          {SETTINGS_NAV_GROUPS.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-px pt-4 first:pt-0">
              {group.label && (
                <div className="shrink-0 px-2 pb-1.5 font-medium text-[11px] text-token-text-tertiary uppercase tracking-[0.08em]">
                  {group.label}
                </div>
              )}
              {group.items
                .filter(
                  (item) =>
                    !item.featureGate ||
                    resolveFeatureGate(
                      item.featureGate,
                      featureGateOverrides,
                      releaseChannel,
                    ).enabled,
                )
                .map((item) => {
                  const active = isSectionActive(item.section, activeRoute);
                  return (
                    <button
                      key={item.section}
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'app-no-drag relative flex h-8 w-full cursor-pointer flex-row items-center gap-2 rounded-lg px-2 text-left text-sm transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border',
                        active
                          ? 'bg-token-list-hover-background text-token-text-primary shadow-codex-hairline'
                          : 'text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary',
                      )}
                      onClick={() => handleSelectSection(item.section)}
                    >
                      {active && (
                        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-clodex-green-400" />
                      )}
                      {item.icon}
                      <span className="truncate">
                        {getSettingsSectionLabel(item.section)}
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </nav>

        <SidebarAuthFooter />
      </div>
    </div>
  );
}
