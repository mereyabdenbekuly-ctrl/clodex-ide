import { HotkeyActions } from '@shared/hotkeys';
import {
  ShortcutCombo,
  ShortcutKey,
} from '@clodex/stage-ui/components/shortcut-key';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import type { ReactNode } from 'react';
import type {
  AgentCommandItem,
  CommandCenterMode,
  TabCommandItem,
} from '../command-center-model';

export type CommandCenterDeleteConfirmation = {
  agentId: string;
  title: string;
};

export function CommandCenterFooter({
  mode,
  deleteConfirmation,
  isRenamingAgent,
  selectedAgent,
  canCopySelectedTabUrl,
  canToggleSelectedTabPin,
  selectedTab,
  canToggleGitignored,
  includeGitignored,
  searchInContent,
}: {
  mode: CommandCenterMode;
  deleteConfirmation: CommandCenterDeleteConfirmation | null;
  isRenamingAgent: boolean;
  selectedAgent: AgentCommandItem | null;
  canCopySelectedTabUrl: boolean;
  canToggleSelectedTabPin: boolean;
  selectedTab: TabCommandItem | null;
  canToggleGitignored: boolean;
  includeGitignored: boolean;
  searchInContent: boolean;
}) {
  let status: ReactNode = <CommandCenterNavigationHints />;
  let actions: ReactNode = null;

  if (isRenamingAgent) {
    status = (
      <span className="truncate text-token-text-secondary">
        Editing task title
      </span>
    );
    actions = (
      <>
        <CommandCenterFooterAction label="Cancel">
          <ShortcutCombo value="Esc" size="xs" />
        </CommandCenterFooterAction>
        <CommandCenterFooterAction label="Save">
          <ShortcutCombo value="Enter" size="xs" />
        </CommandCenterFooterAction>
      </>
    );
  } else if (deleteConfirmation) {
    status = (
      <span className="min-w-0 truncate text-token-text-primary">
        Delete <span className="font-medium">“{deleteConfirmation.title}”</span>
        ?
      </span>
    );
    actions = (
      <>
        <CommandCenterFooterAction label="Cancel">
          <ShortcutCombo value="Esc" size="xs" />
        </CommandCenterFooterAction>
        <CommandCenterFooterAction label="Delete">
          <ShortcutCombo value="Enter" size="xs" />
        </CommandCenterFooterAction>
      </>
    );
  } else if (selectedAgent) {
    actions = (
      <>
        <CommandCenterFooterAction label="Rename">
          <HotkeyCombo
            action={HotkeyActions.COMMAND_CENTER_RENAME_AGENT}
            size="xs"
          />
        </CommandCenterFooterAction>
        <CommandCenterFooterAction
          label={selectedAgent.isPinned ? 'Unpin' : 'Pin'}
        >
          <HotkeyCombo
            action={HotkeyActions.COMMAND_CENTER_TOGGLE_AGENT_PIN}
            size="xs"
          />
        </CommandCenterFooterAction>
        {!selectedAgent.isWorking && (
          <CommandCenterFooterAction label="Delete">
            <HotkeyCombo
              action={HotkeyActions.COMMAND_CENTER_DELETE_AGENT}
              size="xs"
            />
          </CommandCenterFooterAction>
        )}
      </>
    );
  } else if (mode === 'files') {
    actions = (
      <>
        <CommandCenterFooterAction
          label={
            searchInContent ? 'Search filenames only' : 'Search in content'
          }
        >
          <HotkeyCombo
            action={HotkeyActions.COMMAND_CENTER_TOGGLE_SEARCH_IN_CONTENT}
            size="xs"
          />
        </CommandCenterFooterAction>
        {canToggleGitignored && (
          <CommandCenterFooterAction
            label={
              includeGitignored ? 'Exclude gitignored' : 'Include gitignored'
            }
          >
            <HotkeyCombo
              action={HotkeyActions.COMMAND_CENTER_TOGGLE_GITIGNORED}
              size="xs"
            />
          </CommandCenterFooterAction>
        )}
      </>
    );
  } else if (selectedTab) {
    actions = (
      <>
        {canToggleSelectedTabPin && (
          <CommandCenterFooterAction
            label={selectedTab.isPinned ? 'Unpin' : 'Pin'}
          >
            <HotkeyCombo
              action={HotkeyActions.COMMAND_CENTER_TOGGLE_AGENT_PIN}
              size="xs"
            />
          </CommandCenterFooterAction>
        )}
        {canCopySelectedTabUrl && (
          <CommandCenterFooterAction label="Copy URL">
            <HotkeyCombo
              action={HotkeyActions.COMMAND_CENTER_COPY_TAB_URL}
              size="xs"
            />
          </CommandCenterFooterAction>
        )}
        <CommandCenterFooterAction label="Close">
          <HotkeyCombo action={HotkeyActions.CLOSE_TAB} size="xs" />
        </CommandCenterFooterAction>
      </>
    );
  }

  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-token-border-light border-t bg-token-bg-secondary/55 px-3 text-token-text-tertiary text-xs">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        {status}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-3">{actions}</div>
      )}
    </div>
  );
}

function CommandCenterNavigationHints() {
  return (
    <>
      <CommandCenterFooterAction label="Navigate">
        <ShortcutKey size="xs">↑↓</ShortcutKey>
      </CommandCenterFooterAction>
      <CommandCenterFooterAction label="Open">
        <ShortcutKey size="xs">↵</ShortcutKey>
      </CommandCenterFooterAction>
      <CommandCenterFooterAction label="Close">
        <ShortcutKey size="xs">Esc</ShortcutKey>
      </CommandCenterFooterAction>
    </>
  );
}

function CommandCenterFooterAction({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {children}
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
    </span>
  );
}
