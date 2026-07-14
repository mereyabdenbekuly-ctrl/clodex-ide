import { forwardRef } from 'react';
import { IconMagnifierOutline18 } from '@clodex/icons';
import { ShortcutKey } from '@clodex/stage-ui/components/shortcut-key';
import type { CommandCenterMode } from '../command-center-model';
import { CommandCenterModeToggle } from './command-center-mode-toggle';

const placeholderByMode: Record<CommandCenterMode, string> = {
  global: 'Search tasks, tabs, files, projects, and settings…',
  agents: 'Search tasks…',
  browser: 'Search browser tabs…',
  files: 'Search files…',
  settings: 'Search settings…',
};

export const CommandCenterInput = forwardRef<
  HTMLInputElement,
  {
    query: string;
    mode: CommandCenterMode;
    activeDescendantId?: string;
    onQueryChange: (query: string) => void;
    onModeChange: (mode: CommandCenterMode) => void;
    onBlur: (input: HTMLInputElement) => void;
    onSelectionChange: (input: HTMLInputElement) => void;
  }
>(function CommandCenterInput(
  {
    query,
    mode,
    activeDescendantId,
    onBlur,
    onQueryChange,
    onModeChange,
    onSelectionChange,
  },
  ref,
) {
  return (
    <div className="border-token-border-light border-b">
      <div className="flex min-h-14 items-center gap-3 px-4">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-token-bg-tertiary text-token-text-secondary">
          <IconMagnifierOutline18 className="size-[17px]" />
        </span>
        <input
          ref={ref}
          role="combobox"
          aria-autocomplete="list"
          aria-controls="command-center-results"
          aria-expanded="true"
          aria-activedescendant={activeDescendantId}
          aria-label="Search command center"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onBlur={(event) => onBlur(event.currentTarget)}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={(event) => onSelectionChange(event.currentTarget)}
          onKeyUp={(event) => onSelectionChange(event.currentTarget)}
          onPointerUp={(event) => onSelectionChange(event.currentTarget)}
          onSelect={(event) => onSelectionChange(event.currentTarget)}
          placeholder={placeholderByMode[mode]}
          className="min-w-0 flex-1 bg-transparent text-base text-token-text-primary leading-6 outline-none placeholder:text-token-text-tertiary"
        />
        <span className="hidden shrink-0 items-center gap-2 text-token-text-tertiary text-xs sm:flex">
          <span>Close</span>
          <ShortcutKey size="xs">Esc</ShortcutKey>
        </span>
      </div>
      <CommandCenterModeToggle mode={mode} onModeChange={onModeChange} />
    </div>
  );
});
