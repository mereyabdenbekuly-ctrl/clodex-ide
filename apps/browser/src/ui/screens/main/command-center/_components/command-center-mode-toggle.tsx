import {
  IconEarthSearchOutline18,
  IconFolder5Outline18,
  IconGear3Outline18,
  IconMsgWritingOutline18,
} from 'nucleo-ui-outline-18';
import { CommandIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { ShortcutKey } from '@clodex/stage-ui/components/shortcut-key';
import { cn } from '@ui/utils';
import type { CommandCenterMode } from '../command-center-model';

type ModeDefinition = {
  mode: CommandCenterMode;
  label: string;
  Icon?: ComponentType<{ className?: string }>;
};

const modes: ModeDefinition[] = [
  { mode: 'global', label: 'All', Icon: CommandIcon },
  { mode: 'agents', label: 'Agents', Icon: IconMsgWritingOutline18 },
  { mode: 'browser', label: 'Browser', Icon: IconEarthSearchOutline18 },
  { mode: 'files', label: 'Files', Icon: IconFolder5Outline18 },
  { mode: 'settings', label: 'Settings', Icon: IconGear3Outline18 },
];

export function CommandCenterModeToggle({
  mode,
  onModeChange,
}: {
  mode: CommandCenterMode;
  onModeChange: (mode: CommandCenterMode) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pb-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {modes.map(({ mode: value, label, Icon }) => {
          const isActive = value === mode;

          return (
            <button
              key={value}
              type="button"
              aria-label={`Switch to ${label} mode`}
              aria-pressed={isActive}
              onClick={() => onModeChange(value)}
              className={cn(
                'flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-lg px-2.5 font-medium text-xs outline-none transition-[background-color,color,box-shadow] duration-150 ease-out',
                'focus-visible:ring-1 focus-visible:ring-token-focus-border',
                isActive
                  ? 'bg-token-bg-tertiary text-token-text-primary shadow-codex-sm ring-1 ring-token-border-light'
                  : 'text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary',
              )}
            >
              {Icon && <Icon className="size-3.5 shrink-0" />}
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <span className="hidden shrink-0 items-center gap-1.5 text-token-text-tertiary text-xs md:flex">
        <ShortcutKey
          aria-label="Press Tab to cycle command center modes"
          size="xs"
        >
          Tab
        </ShortcutKey>
        <span>switch</span>
      </span>
    </div>
  );
}
