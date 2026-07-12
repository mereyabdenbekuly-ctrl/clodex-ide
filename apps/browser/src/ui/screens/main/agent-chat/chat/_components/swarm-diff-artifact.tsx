import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { FileIcon } from '@ui/components/file-icon';
import { cn, stripMountPrefix } from '@ui/utils';
import { getBaseName } from '@shared/path-utils';
import { CheckIcon, ChevronDownIcon, FilePlus2Icon, XIcon } from 'lucide-react';
import type { Mount } from '@shared/karton-contracts/ui/agent/metadata';
import {
  formatFileDiff,
  getDiffArtifactSummary,
  getTotalLineStats,
  isCreatedDiff,
} from './footer-status-card/file-diff-section';
import {
  getHunkIds,
  getLineStats,
  hasRealChanges,
  type FormattedFileDiff,
} from './footer-status-card/shared';

export function SwarmDiffArtifact({
  agentInstanceId,
  resolvedMounts,
}: {
  agentInstanceId: string | null;
  resolvedMounts: Mount[];
}) {
  const pendingDiffs = useKartonState((s) =>
    agentInstanceId ? (s.toolbox[agentInstanceId]?.pendingFileDiffs ?? []) : [],
  );
  const proposedEdits = useKartonState((s) =>
    agentInstanceId
      ? (s.toolbox[agentInstanceId]?.pendingProposedEdits ?? [])
      : [],
  );
  const diffSummary = useKartonState((s) =>
    agentInstanceId ? (s.toolbox[agentInstanceId]?.editSummary ?? []) : [],
  );
  const tabs = useKartonState((s) => s.contentTabs.tabs);

  const rejectAllPendingEdits = useKartonProcedure(
    (p) => p.toolbox.rejectHunks,
  );
  const acceptAllPendingEdits = useKartonProcedure(
    (p) => p.toolbox.acceptHunks,
  );
  const acceptPendingEdit = useKartonProcedure(
    (p) => p.toolbox.acceptPendingEdit,
  );
  const rejectPendingEdit = useKartonProcedure(
    (p) => p.toolbox.rejectPendingEdit,
  );
  const createTab = useKartonProcedure((p) => p.browser.createTab);
  const switchTab = useKartonProcedure((p) => p.browser.switchTab);
  const goToUrl = useKartonProcedure((p) => p.browser.goto);

  const [expanded, setExpanded] = useState(true);

  const diffs = useMemo(() => {
    if (proposedEdits.length > 0) {
      return proposedEdits.map((edit) => formatFileDiff(edit.fileDiff));
    }
    if (pendingDiffs.length > 0) {
      return pendingDiffs.map(formatFileDiff).filter(hasRealChanges);
    }
    return diffSummary.map(formatFileDiff).filter(hasRealChanges);
  }, [diffSummary, pendingDiffs, proposedEdits]);
  const diffFingerprint = useMemo(
    () =>
      [
        ...proposedEdits.map((edit) => edit.id),
        ...pendingDiffs.map(
          (diff) => `${diff.fileId}:${diff.baselineOid}:${diff.currentOid}`,
        ),
        ...diffSummary.map(
          (diff) => `${diff.fileId}:${diff.baselineOid}:${diff.currentOid}`,
        ),
      ].join('|'),
    [diffSummary, pendingDiffs, proposedEdits],
  );

  const hunkIds = useMemo(() => diffs.flatMap(getHunkIds), [diffs]);
  const stats = useMemo(() => getTotalLineStats(diffs), [diffs]);
  const createdCount = diffs.filter(isCreatedDiff).length;
  const changedCount = Math.max(diffs.length - createdCount, 0);
  const hasPendingActions = proposedEdits.length > 0 || pendingDiffs.length > 0;

  useEffect(() => {
    if (diffFingerprint) setExpanded(true);
  }, [diffFingerprint]);

  const openDiffReviewPage = useCallback(
    (fileId: string) => {
      if (!agentInstanceId) return;
      const baseUrl = `clodex://internal/diff-review/${agentInstanceId}`;
      const fragment = fileId ? `#${encodeURIComponent(fileId)}` : '';
      const fullUrl = `${baseUrl}${fragment}`;
      const existingTab = Object.values(tabs).find((tab) =>
        tab.url.startsWith(baseUrl),
      );

      if (existingTab) {
        void switchTab(existingTab.id);
        void goToUrl(fullUrl, existingTab.id);
      } else {
        void createTab(fullUrl, true);
      }
    },
    [agentInstanceId, createTab, goToUrl, switchTab, tabs],
  );

  const handleReject = useCallback(() => {
    if (proposedEdits.length > 0) {
      for (const edit of proposedEdits) void rejectPendingEdit(edit.id);
      return;
    }
    if (hunkIds.length > 0) void rejectAllPendingEdits(hunkIds);
  }, [hunkIds, proposedEdits, rejectAllPendingEdits, rejectPendingEdit]);

  const handleAccept = useCallback(() => {
    if (proposedEdits.length > 0) {
      for (const edit of proposedEdits) void acceptPendingEdit(edit.id);
      return;
    }
    if (hunkIds.length > 0) void acceptAllPendingEdits(hunkIds);
  }, [acceptAllPendingEdits, acceptPendingEdit, hunkIds, proposedEdits]);

  if (diffs.length === 0) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-background shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex items-center gap-3 border-border/50 border-b p-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-foreground">
          <FilePlus2Icon className="size-5" />
        </div>
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground text-sm">
              {getDiffArtifactSummary(diffs)}
            </span>
            <ChevronDownIcon
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-180',
              )}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            {createdCount > 0 && (
              <span className="text-muted-foreground">
                Создано {createdCount}
              </span>
            )}
            {changedCount > 0 && (
              <span className="text-muted-foreground">
                Изменено {changedCount}
              </span>
            )}
            {stats.added > 0 && (
              <span className="text-success-foreground">+{stats.added}</span>
            )}
            {stats.removed > 0 && (
              <span className="text-error-foreground">-{stats.removed}</span>
            )}
          </div>
        </button>
        {hasPendingActions && (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleReject}>
              <XIcon className="size-3.5" />
              Отменить
            </Button>
            <Button variant="primary" size="sm" onClick={handleAccept}>
              <CheckIcon className="size-3.5" />
              Проверить
            </Button>
          </div>
        )}
      </div>
      {expanded && (
        <div className="divide-y divide-border/30">
          {diffs.map((diff) => (
            <DiffArtifactRow
              key={diff.fileId}
              diff={diff}
              resolvedMounts={resolvedMounts}
              onOpen={() => openDiffReviewPage(diff.fileId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiffArtifactRow({
  diff,
  resolvedMounts,
  onOpen,
}: {
  diff: FormattedFileDiff;
  resolvedMounts: Mount[];
  onOpen: () => void;
}) {
  const stats = getLineStats(diff);
  const displayPath = stripMountPrefix(diff.path) ?? diff.path;
  const relativePath = getRelativeDisplayPath(diff.path, resolvedMounts);

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-1"
      onClick={onOpen}
    >
      <FileIcon filePath={diff.fileName} className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground text-sm">
          {relativePath || displayPath || getBaseName(diff.path)}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 text-xs">
        {stats.added > 0 && (
          <span className="text-success-foreground">+{stats.added}</span>
        )}
        {stats.removed > 0 && (
          <span className="text-error-foreground">-{stats.removed}</span>
        )}
      </div>
    </button>
  );
}

function getRelativeDisplayPath(path: string, mounts: Mount[]): string {
  const normalized = path.replace(/\\/g, '/');
  for (const mount of mounts) {
    if (normalized === mount.prefix) return getBaseName(mount.path);
    if (normalized.startsWith(`${mount.prefix}/`)) {
      return normalized.slice(mount.prefix.length + 1);
    }
    if (normalized === mount.path) return getBaseName(normalized);
    if (normalized.startsWith(`${mount.path}/`)) {
      return normalized.slice(mount.path.length + 1);
    }
  }
  return stripMountPrefix(normalized) ?? normalized;
}
