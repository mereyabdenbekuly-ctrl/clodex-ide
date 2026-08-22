import { Button } from '@clodex/stage-ui/components/button';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';

import { cn } from '@ui/utils';

import type { FilePreviewResult } from '@shared/karton-contracts/ui';
import type { ReactElement } from 'react';
import {
  IconFloppyDiskOutline18,
  IconLockKeyOutline18,
  IconOpenExternalOutline18,
  IconRedoOutline18,
  IconUndoOutline18,
} from '@clodex/icons';

import { Loader2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { HotkeyActions } from '@shared/hotkeys';

import { HotkeyCombo } from '@ui/components/hotkey-combo';

import { IdeLogo } from '@ui/components/ide-logo';
import { getIDEFileUrl, IDE_SELECTION_ITEMS } from '@shared/ide-url';
import type { OpenFilesInIde } from '@shared/karton-contracts/ui/shared-types';

import type { EditorActions } from './use-file-editor-controller';
import { Menu as MenuBase } from '@base-ui/react/menu';

export function ToolbarTooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: HotkeyActions;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger>{children}</TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-1.5">
          <span>{label}</span>
          {shortcut && <HotkeyCombo action={shortcut} size="xs" />}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

// Derive the on-disk absolute path from a preview's workspace key
// (`<prefix>:<absoluteWorkspacePath>`) and its workspace-relative path.
export function getPreviewAbsolutePath(
  preview: FilePreviewResult,
): string | undefined {
  const colonIndex = preview.workspaceKey.indexOf(':');
  if (colonIndex < 0) return undefined;
  const workspacePath = preview.workspaceKey.slice(colonIndex + 1);
  if (!workspacePath) return undefined;
  return `${workspacePath}/${preview.relativePath}`;
}

export function OpenExternalMenu({ absolutePath }: { absolutePath: string }) {
  const ides: OpenFilesInIde[] = [
    'cursor',
    'vscode',
    'zed',
    'kiro',
    'windsurf',
    'trae',
  ];

  const open = (ide: OpenFilesInIde) => {
    window.open(getIDEFileUrl(absolutePath, ide), '_blank');
  };

  return (
    <MenuBase.Root>
      <Tooltip>
        <TooltipTrigger>
          <MenuBase.Trigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open externally"
              >
                <IconOpenExternalOutline18 className="size-4" />
              </Button>
            }
          />
        </TooltipTrigger>
        <TooltipContent>Open externally</TooltipContent>
      </Tooltip>
      <MenuBase.Portal>
        <MenuBase.Positioner className="z-50" sideOffset={4} align="end">
          <MenuBase.Popup
            className={cn(
              'flex min-w-44 origin-(--transform-origin) flex-col items-stretch gap-0.5',
              'rounded-lg border border-border-subtle bg-background p-1',
              'text-xs shadow-lg',
              'transition-[transform,scale,opacity] duration-150 ease-out',
              'data-ending-style:scale-90 data-starting-style:scale-90',
              'data-ending-style:opacity-0 data-starting-style:opacity-0',
            )}
          >
            {ides.map((ide) => (
              <MenuBase.Item
                key={ide}
                className={cn(
                  'flex w-full cursor-default flex-row items-center justify-start gap-2',
                  'rounded-md px-2 py-1 text-foreground text-xs outline-none',
                  'transition-colors duration-150 ease-out',
                  'hover:bg-surface-1 data-highlighted:bg-surface-1',
                )}
                onClick={() => open(ide)}
              >
                <IdeLogo ide={ide} className="size-3.5 shrink-0" />
                <span>Open in {IDE_SELECTION_ITEMS[ide]}</span>
              </MenuBase.Item>
            ))}
            <MenuBase.Separator className="my-0.5 h-px bg-border-subtle" />
            <MenuBase.Item
              className={cn(
                'flex w-full cursor-default flex-row items-center justify-start gap-2',
                'rounded-md px-2 py-1 text-foreground text-xs outline-none',
                'transition-colors duration-150 ease-out',
                'hover:bg-surface-1 data-highlighted:bg-surface-1',
              )}
              onClick={() => open('other')}
            >
              <IdeLogo ide="other" className="size-3.5 shrink-0" />
              <span>Reveal in {IDE_SELECTION_ITEMS.other}</span>
            </MenuBase.Item>
          </MenuBase.Popup>
        </MenuBase.Positioner>
      </MenuBase.Portal>
    </MenuBase.Root>
  );
}

export function FileTabToolbar({
  actions,
  right,
  openExternalPath,
  onInteract,
}: {
  actions: EditorActions | null;
  right?: React.ReactNode;
  openExternalPath?: string;
  onInteract?: () => void;
}) {
  // Read-only files (attachment blobs, bundled plugins, agent app scratch)
  // cannot be edited, so collapse the save/undo/redo controls to a single
  // read-only indicator.
  if (actions?.readOnly) {
    return (
      <div
        className="flex h-9 shrink-0 items-center justify-between border-border-subtle border-b bg-background px-1"
        onClickCapture={onInteract}
        onFocusCapture={onInteract}
      >
        <div className="flex items-center gap-1.5 px-2 text-muted-foreground text-xs">
          <IconLockKeyOutline18 className="size-4" />
          <span>Read-only</span>
        </div>
        <div className="flex items-center">
          {openExternalPath && (
            <div className="flex items-center px-1">
              <OpenExternalMenu absolutePath={openExternalPath} />
            </div>
          )}
          {right ? (
            <div className="flex items-center gap-1">{right}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-9 shrink-0 items-center justify-between border-border-subtle border-b bg-background px-1"
      onClickCapture={onInteract}
      onFocusCapture={onInteract}
    >
      <div className="flex items-center">
        <div className="flex items-center px-1">
          <ToolbarTooltip label="Save file" shortcut={HotkeyActions.SAVE_FILE}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Save file"
              disabled={
                !actions?.isDirty || actions.isSaving || actions.externalChange
              }
              onClick={() => actions?.save()}
            >
              {actions?.isSaving ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <IconFloppyDiskOutline18 className="size-4" />
              )}
            </Button>
          </ToolbarTooltip>
        </div>
        <div className="h-5 w-px bg-border-subtle" />
        <div className="flex items-center px-1">
          <ToolbarTooltip label="Undo" shortcut={HotkeyActions.UNDO_FILE_EDIT}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Undo"
              disabled={!actions?.canUndo}
              onClick={() => actions?.undo()}
            >
              <IconUndoOutline18 className="size-4" />
            </Button>
          </ToolbarTooltip>
          <ToolbarTooltip label="Redo" shortcut={HotkeyActions.REDO_FILE_EDIT}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Redo"
              disabled={!actions?.canRedo}
              onClick={() => actions?.redo()}
            >
              <IconRedoOutline18 className="size-4" />
            </Button>
          </ToolbarTooltip>
        </div>
        {openExternalPath && (
          <>
            <div className="h-5 w-px bg-border-subtle" />
            <div className="flex items-center px-1">
              <OpenExternalMenu absolutePath={openExternalPath} />
            </div>
          </>
        )}
      </div>
      {right ? <div className="flex items-center gap-1">{right}</div> : null}
    </div>
  );
}

/**
 * Warning shown when a file was modified on disk while the user has unsaved
 * local edits. Saving is blocked until the user reloads (discarding local
 * edits) or explicitly overwrites the external changes.
 */
export function ExternalChangeBanner({ actions }: { actions: EditorActions }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-border border-b bg-warning-solid/10 px-3 py-1.5 text-warning-foreground text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          This file changed on disk since you started editing.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => actions.reload()}
          disabled={actions.isSaving}
        >
          Reload
        </Button>
        <Button
          variant="warning"
          size="xs"
          onClick={() => actions.forceSave()}
          disabled={actions.isSaving}
        >
          Overwrite
        </Button>
      </div>
    </div>
  );
}

/**
 * Banner shown when a file was moved (via drag-and-drop or cut-paste) while
 * open in a tab. The tab path was automatically updated; future edits go to
 * the new location. Dismissible.
 */
export function FileMoveBanner({
  fromPath,
  toPath,
  onDismiss,
}: {
  fromPath: string;
  toPath: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-border border-b bg-info-solid/10 px-3 py-1.5 text-info-foreground text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          File moved from {fromPath} to {toPath}. Future edits will apply to the
          new location.
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-2xs"
        className="shrink-0"
        onClick={onDismiss}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}

/**
 * Banner shown when a file open in a tab was deleted. The user can close the
 * tab or re-create the file with the current editor content.
 */
export function FileDeletedBanner({
  onClose,
  onRecreate,
  isRecreating,
}: {
  onClose: () => void;
  onRecreate: () => void;
  isRecreating: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-border border-b bg-error-solid/10 px-3 py-1.5 text-error-foreground text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          This file was deleted outside of clodex.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={onRecreate}
          disabled={isRecreating}
        >
          {isRecreating ? 'Recreating…' : 'Re-create and save'}
        </Button>
        <Button
          variant="destructive"
          size="xs"
          onClick={onClose}
          disabled={isRecreating}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
