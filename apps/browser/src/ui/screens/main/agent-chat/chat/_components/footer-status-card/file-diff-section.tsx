import { useMemo } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import type { FileDiff } from '@shared/karton-contracts/ui/shared-types';
import type { PendingEditPreview } from '@shared/karton-contracts/ui/shared-types';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { FileIcon } from '@ui/components/file-icon';
import { cn } from '@ui/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { getBaseName, getParentPath, normalizePath } from '@shared/path-utils';
import { stripMountPrefix } from '@ui/utils';
import type { MountEntry } from '@shared/karton-contracts/ui';
import type { Mount } from '@shared/karton-contracts/ui/agent/metadata';
import { getWorkspaceDisplayLabel } from '@ui/utils/workspace-display';
import { useCmdEnterTarget } from '@ui/hooks/use-cmd-enter-target';
import { CmdEnterPriority } from '@ui/utils/cmd-enter-registry';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { HotkeyActions } from '@shared/hotkeys';
import {
  type StatusCardSection,
  type FormattedFileDiff,
  getLineStats,
  getHunkIds,
  hasRealChanges,
} from './shared';

export interface FileDiffSectionProps {
  pendingDiffs: FormattedFileDiff[];
  diffSummary: FormattedFileDiff[];
  /** All mounts ever seen (resolved from env snapshots). */
  resolvedMounts: Mount[];
  /** Currently connected mounts with live Git metadata for display labels. */
  activeMounts: MountEntry[];
  /** Paths of currently connected mounts. */
  activeMountPaths: Set<string>;
  onRejectAll: (hunkIds: string[]) => void;
  onAcceptAll: (hunkIds: string[]) => void;
  onOpenDiffReview: (fileId: string) => void;
}

export interface PendingProposedEditSectionProps {
  proposedEdits: PendingEditPreview[];
  resolvedMounts: Mount[];
  activeMounts: MountEntry[];
  activeMountPaths: Set<string>;
  onReject: (pendingEditId: string) => void;
  onAccept: (pendingEditId: string) => void;
  onOpenDiffReview: (fileId: string) => void;
}

export function formatFileDiff(fileDiff: FileDiff): FormattedFileDiff {
  return {
    ...fileDiff,
    fileName: getBaseName(fileDiff.path),
  };
}

export function isCreatedDiff(diff: FormattedFileDiff): boolean {
  if (diff.isExternal) return diff.changeType === 'created';
  return diff.baseline === null && diff.current !== null;
}

export function getDiffArtifactSummary(diffs: FormattedFileDiff[]): string {
  const created = diffs.filter(isCreatedDiff).length;
  const changed = Math.max(diffs.length - created, 0);
  const parts: string[] = [];
  if (changed > 0) parts.push(`${changed} changed`);
  if (created > 0) parts.push(`${created} created`);
  if (parts.length === 0) parts.push(`${diffs.length} files`);
  return parts.join(' / ');
}

export function getTotalLineStats(diffs: FormattedFileDiff[]): {
  added: number;
  removed: number;
} {
  return diffs.reduce(
    (acc, diff) => {
      const stats = getLineStats(diff);
      acc.added += stats.added;
      acc.removed += stats.removed;
      return acc;
    },
    { added: 0, removed: 0 },
  );
}

function getDiffBatchFingerprint(diffs: FormattedFileDiff[]): string {
  return diffs
    .map((diff) =>
      [
        diff.fileId,
        diff.path,
        diff.baselineOid,
        diff.currentOid,
        ...getHunkIds(diff),
      ].join('|'),
    )
    .join('::');
}

function stripWorkspaceMountName(path: string): string {
  return path.replace(/^w[0-9a-f]{1,8}(?:\/|$)/, '');
}

/**
 * Derive the parent directory path relative to its workspace mount.
 * Returns the directory portion only (no filename), or empty string
 * when the file sits at the workspace root.
 */
function getRelativeDir(absoluteFilePath: string, mounts: Mount[]): string {
  const normalized = normalizePath(absoluteFilePath);
  for (const mount of mounts) {
    if (normalized === mount.prefix) return '';
    if (normalized.startsWith(`${mount.prefix}/`)) {
      return getParentPath(normalized.slice(mount.prefix.length + 1));
    }
  }
  const parentDir = getParentPath(normalized);
  for (const mount of mounts) {
    const mountRoot = normalizePath(mount.path);
    if (parentDir.startsWith(`${mountRoot}/`)) {
      return parentDir.slice(mountRoot.length + 1);
    }
    if (parentDir === mountRoot) return '';
  }
  return stripWorkspaceMountName(stripMountPrefix(parentDir));
}

/**
 * Group diffs by their workspace mount path.
 * Returns groups in mount order, each with the mount's basename as label.
 */
function groupDiffsByMount(
  diffs: FormattedFileDiff[],
  mounts: Mount[],
  activeMounts: MountEntry[],
  activeMountPaths: Set<string>,
): {
  label: string;
  mountPath: string;
  isDisconnected: boolean;
  diffs: FormattedFileDiff[];
}[] {
  const groups = new Map<
    string,
    { label: string; isDisconnected: boolean; diffs: FormattedFileDiff[] }
  >();
  const activeMountsByPath = new Map(
    activeMounts.map((mount) => [mount.path, mount]),
  );

  // Pre-create groups in mount order
  for (const mount of mounts) {
    const activeMount = activeMountsByPath.get(mount.path);
    groups.set(mount.path, {
      label: activeMount
        ? getWorkspaceDisplayLabel(activeMount)
        : getBaseName(mount.path) || mount.path,
      isDisconnected: !activeMountPaths.has(mount.path),
      diffs: [],
    });
  }

  for (const diff of diffs) {
    const normalized = normalizePath(diff.path);
    let matched = false;
    for (const mount of mounts) {
      const mountRoot = normalizePath(mount.path);
      if (normalized.startsWith(`${mountRoot}/`) || normalized === mountRoot) {
        groups.get(mount.path)!.diffs.push(diff);
        matched = true;
        break;
      }
    }
    // Fallback: assign to first mount if no match
    if (!matched && mounts.length > 0) {
      const firstMount = mounts[0];
      if (firstMount) {
        groups.get(firstMount.path)?.diffs.push(diff);
      }
    }
  }

  return Array.from(groups.entries())
    .filter(([, g]) => g.diffs.length > 0)
    .map(([mountPath, g]) => ({ ...g, mountPath }));
}

export function FileDiffFileItem({
  fileDiff,
  resolvedMounts,
  onOpenDiffReview,
}: {
  fileDiff: FormattedFileDiff;
  resolvedMounts: Mount[];
  onOpenDiffReview: (fileId: string) => void;
}) {
  const { added, removed } = getLineStats(fileDiff);
  const displayPath = stripMountPrefix(fileDiff.path) ?? fileDiff.path;
  const relativeDir = useMemo(
    () => getRelativeDir(fileDiff.path, resolvedMounts),
    [fileDiff.path, resolvedMounts],
  );
  return (
    <Tooltip>
      <TooltipTrigger>
        <button
          type="button"
          className="flex min-h-7 w-full cursor-pointer flex-row items-center justify-start gap-1.5 rounded-lg px-2 py-1 text-token-text-primary transition-colors hover:bg-token-list-hover-background"
          onClick={() => onOpenDiffReview(fileDiff.fileId)}
        >
          <FileIcon filePath={fileDiff.fileName} className="size-5 shrink-0" />
          <span className="shrink-0 text-xs leading-none">
            {fileDiff.fileName}
          </span>
          {relativeDir && (
            <span
              className="min-w-0 shrink truncate text-subtle-foreground text-xs leading-none"
              dir="rtl"
            >
              <span dir="ltr">{relativeDir}</span>
            </span>
          )}
          {fileDiff.isExternal ? (
            <>
              {fileDiff.changeType === 'created' && (
                <span className="ml-auto shrink-0 text-[10px] text-success-foreground leading-none">
                  (new)
                </span>
              )}
              {fileDiff.changeType === 'deleted' && (
                <span className="ml-auto shrink-0 text-[10px] text-error-foreground leading-none">
                  (deleted)
                </span>
              )}
              {fileDiff.changeType === 'modified' && (
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground leading-none">
                  (binary)
                </span>
              )}
            </>
          ) : (
            <span className="ml-auto flex shrink-0 flex-row items-center gap-0.5 pl-2">
              {added > 0 && (
                <span className="text-[10px] text-success-foreground leading-none hover:text-hover-derived">
                  +{added}
                </span>
              )}
              {removed > 0 && (
                <span className="text-[10px] text-error-foreground leading-none hover:text-hover-derived">
                  -{removed}
                </span>
              )}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{displayPath}</TooltipContent>
    </Tooltip>
  );
}

function FileDiffList({
  diffs,
  resolvedMounts,
  activeMounts,
  activeMountPaths,
  onOpenDiffReview,
}: {
  diffs: FormattedFileDiff[];
  resolvedMounts: Mount[];
  activeMounts: MountEntry[];
  activeMountPaths: Set<string>;
  onOpenDiffReview: (fileId: string) => void;
}) {
  const groups = useMemo(
    () =>
      groupDiffsByMount(diffs, resolvedMounts, activeMounts, activeMountPaths),
    [diffs, resolvedMounts, activeMounts, activeMountPaths],
  );

  // Show group labels when the agent ever had more than one workspace connected
  const hideLabels = resolvedMounts.length <= 1;

  if (groups.length === 0) return null;

  if (hideLabels) {
    return (
      <div className="pt-1">
        {groups[0]?.diffs.map((edit) => (
          <FileDiffFileItem
            key={edit.path}
            fileDiff={edit}
            resolvedMounts={resolvedMounts}
            onOpenDiffReview={onOpenDiffReview}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="pt-1">
      {groups.map((group) => (
        <div key={group.mountPath}>
          <div className="shrink-0 px-2 pt-1 pb-1 font-normal text-subtle-foreground text-xs">
            {group.label}
            {group.isDisconnected && (
              <span className="ml-1 text-subtle-foreground opacity-60">
                (disconnected)
              </span>
            )}
          </div>
          {group.diffs.map((edit) => (
            <FileDiffFileItem
              key={edit.path}
              fileDiff={edit}
              resolvedMounts={resolvedMounts}
              onOpenDiffReview={onOpenDiffReview}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AcceptAllButton({
  hunkIds,
  onAcceptAll,
}: {
  hunkIds: string[];
  onAcceptAll: (hunkIds: string[]) => void;
}) {
  const { setRef, isWinner } = useCmdEnterTarget({
    id: 'file-diff-accept-all',
    priority: CmdEnterPriority.FILE_DIFF_ACCEPT,
    action: () => onAcceptAll(hunkIds),
    enabled: true,
  });
  return (
    <Button
      ref={setRef}
      variant="primary"
      size="xs"
      className="cursor-pointer"
      onClick={(e) => {
        e.stopPropagation();
        onAcceptAll(hunkIds);
      }}
    >
      <CheckIcon className="size-3" />
      Accept
      {isWinner && (
        <HotkeyCombo
          action={HotkeyActions.CMD_ENTER}
          size="xs"
          variant="solid"
          className="ml-0.5"
        />
      )}
    </Button>
  );
}

export function FileDiffSection(
  props: FileDiffSectionProps,
): StatusCardSection | null {
  const {
    pendingDiffs,
    diffSummary,
    resolvedMounts,
    activeMounts,
    activeMountPaths,
    onRejectAll,
    onAcceptAll,
    onOpenDiffReview,
  } = props;

  // Filter out noops from summary (rejected edits with no actual changes)
  const filteredSummary = diffSummary.filter(hasRealChanges);

  if (pendingDiffs?.length === 0 && filteredSummary.length === 0) return null;

  const hasPendingDiffs = pendingDiffs?.length > 0;
  const displayedDiffs = hasPendingDiffs ? pendingDiffs : filteredSummary;
  const pendingDiffsKey = hasPendingDiffs
    ? getDiffBatchFingerprint(pendingDiffs)
    : undefined;
  const totalStats = getTotalLineStats(displayedDiffs);

  return {
    // Include the pending fingerprint so a fresh batch remounts open even if
    // the user collapsed an older diff artifact.
    key: hasPendingDiffs
      ? `file-diff-pending-${pendingDiffsKey}`
      : 'file-diff-summary',
    // Surface pending edits immediately so the user can review accept/reject actions.
    defaultOpen: hasPendingDiffs,
    autoOpenKey: hasPendingDiffs ? pendingDiffsKey : undefined,
    trigger: (isOpen: boolean) => (
      <div
        className={cn(
          'mx-1 flex min-h-10 w-[calc(100%-0.5rem)] flex-row items-center justify-between gap-2 border px-3 py-2 text-xs shadow-codex-sm transition-colors has-[button:hover]:text-token-text-secondary',
          hasPendingDiffs
            ? 'border-codex-blue-400/20 bg-codex-blue-400/6 text-token-text-secondary hover:border-codex-blue-400/35 hover:bg-codex-blue-400/10'
            : 'border-token-border-light bg-token-bg-secondary/60 text-token-text-secondary hover:bg-token-list-hover-background',
          isOpen ? 'rounded-t-xl border-b-token-border-light' : 'rounded-xl',
        )}
      >
        <div className="flex min-w-0 flex-row items-center gap-2">
          <ChevronDownIcon
            className={cn(
              'size-3 shrink-0 transition-transform duration-50',
              isOpen && 'rotate-180',
            )}
          />
          <span className="truncate font-medium text-foreground">
            {getDiffArtifactSummary(displayedDiffs)}
          </span>
        </div>

        <span className="ml-auto flex shrink-0 flex-row items-center gap-1 text-[10px]">
          {totalStats.added > 0 && (
            <span className="text-success-foreground">+{totalStats.added}</span>
          )}
          {totalStats.removed > 0 && (
            <span className="text-error-foreground">-{totalStats.removed}</span>
          )}
        </span>

        {pendingDiffs?.length > 0 ? (
          <div className="flex shrink-0 flex-row items-center justify-start gap-1">
            <Button
              variant="ghost"
              size="xs"
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onRejectAll(
                  pendingDiffs?.flatMap((diff) => getHunkIds(diff)) ?? [],
                );
              }}
            >
              <XIcon className="size-3" />
              Reject
            </Button>
            <AcceptAllButton
              hunkIds={pendingDiffs?.flatMap((diff) => getHunkIds(diff)) ?? []}
              onAcceptAll={onAcceptAll}
            />
          </div>
        ) : (
          <div className="ml-auto h-6" />
        )}
      </div>
    ),
    scrollable: true,
    contentClassName: hasPendingDiffs
      ? 'mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-b-xl border-x border-b border-codex-blue-400/20 bg-token-bg-secondary/35 px-0 pb-1'
      : 'px-0',
    content:
      pendingDiffs?.length > 0 ? (
        <FileDiffList
          diffs={pendingDiffs}
          resolvedMounts={resolvedMounts}
          activeMounts={activeMounts}
          activeMountPaths={activeMountPaths}
          onOpenDiffReview={onOpenDiffReview}
        />
      ) : filteredSummary.length > 0 ? (
        <FileDiffList
          diffs={filteredSummary}
          resolvedMounts={resolvedMounts}
          activeMounts={activeMounts}
          activeMountPaths={activeMountPaths}
          onOpenDiffReview={onOpenDiffReview}
        />
      ) : null,
  };
}

export function PendingProposedEditSection(
  props: PendingProposedEditSectionProps,
): StatusCardSection | null {
  const {
    proposedEdits,
    resolvedMounts,
    activeMounts,
    activeMountPaths,
    onReject,
    onAccept,
    onOpenDiffReview,
  } = props;

  if (proposedEdits.length === 0) return null;

  const diffs = proposedEdits.map((edit) => formatFileDiff(edit.fileDiff));
  const sectionKey = `pending-proposed-edits-${proposedEdits
    .map((edit) => edit.id)
    .join(':')}`;
  const totalStats = getTotalLineStats(diffs);

  return {
    key: sectionKey,
    defaultOpen: true,
    autoOpenKey: sectionKey,
    trigger: (isOpen: boolean) => (
      <div
        className={cn(
          'mx-1 flex min-h-10 w-[calc(100%-0.5rem)] flex-row items-center justify-between gap-2 border border-codex-blue-400/20 bg-codex-blue-400/6 px-3 py-2 text-token-text-secondary text-xs shadow-codex-sm transition-colors hover:border-codex-blue-400/35 hover:bg-codex-blue-400/10 has-[button:hover]:text-token-text-secondary',
          isOpen ? 'rounded-t-xl border-b-token-border-light' : 'rounded-xl',
        )}
      >
        <div className="flex min-w-0 flex-row items-center gap-2">
          <ChevronDownIcon
            className={cn(
              'size-3 shrink-0 transition-transform duration-50',
              isOpen && 'rotate-180',
            )}
          />
          <span className="truncate font-medium text-foreground">
            {getDiffArtifactSummary(diffs)}
          </span>
        </div>

        <span className="ml-auto flex shrink-0 flex-row items-center gap-1 text-[10px]">
          {totalStats.added > 0 && (
            <span className="text-success-foreground">+{totalStats.added}</span>
          )}
          {totalStats.removed > 0 && (
            <span className="text-error-foreground">-{totalStats.removed}</span>
          )}
        </span>

        <div className="flex shrink-0 flex-row items-center justify-start gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              for (const edit of proposedEdits) onReject(edit.id);
            }}
          >
            <XIcon className="size-3" />
            Reject
          </Button>
          <Button
            variant="primary"
            size="xs"
            className="cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              for (const edit of proposedEdits) onAccept(edit.id);
            }}
          >
            <CheckIcon className="size-3" />
            Accept
          </Button>
        </div>
      </div>
    ),
    scrollable: true,
    contentClassName:
      'mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-b-xl border-x border-b border-codex-blue-400/20 bg-token-bg-secondary/35 px-0 pb-1',
    content: (
      <FileDiffList
        diffs={diffs}
        resolvedMounts={resolvedMounts}
        activeMounts={activeMounts}
        activeMountPaths={activeMountPaths}
        onOpenDiffReview={onOpenDiffReview}
      />
    ),
  };
}
