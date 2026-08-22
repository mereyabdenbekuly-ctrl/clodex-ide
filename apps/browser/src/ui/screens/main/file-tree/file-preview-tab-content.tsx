import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import type {
  FilePreviewResult,
  FileStatResult,
} from '@shared/karton-contracts/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import {
  getPreviewCacheKey,
  isMarkdownPath,
  previewCache,
  previewRequests,
  textDraftCache,
  type FilePreviewTabContentProps,
} from './file-preview-utils';
import {
  FileTabToolbar,
  FileMoveBanner,
  FileDeletedBanner,
} from './file-preview-toolbar';
import { DiffEditorPreview, TextEditorPreview } from './file-preview-editors';
import {
  BinaryPreview,
  ImagePreview,
  MarkdownPreview,
  MissingFileNotice,
  SvgPreview,
  isMissingFileError,
} from './file-preview-media';

export function FilePreviewTabContent({ tab }: FilePreviewTabContentProps) {
  const getFilePreview = useKartonProcedure((p) => p.fileTree.getFilePreview);
  const getFileStat = useKartonProcedure((p) => p.fileTree.getFileStat);
  const clearFileNotice = useKartonProcedure((p) => p.browser.clearFileNotice);
  const closeTab = useKartonProcedure((p) => p.browser.closeTab);
  const recreateDeletedFile = useKartonProcedure(
    (p) => p.fileTree.recreateDeletedFile,
  );
  const revealInFolder = useKartonProcedure((p) => p.fileTree.revealInFolder);
  const [isRecreating, setIsRecreating] = useState(false);
  const workspaceKey = tab.file?.workspaceKey;
  const relativePath = tab.file?.relativePath;
  // Git diff tabs render via DiffEditorPreview, which loads its own content.
  // Skip the regular file-preview fetch/revalidate pipeline entirely so a
  // diff tab doesn't trigger redundant getFilePreview calls on every watcher
  // revision bump.
  const isDiffTab = tab.file?.showDiff ?? false;
  const cacheKey =
    workspaceKey && relativePath
      ? getPreviewCacheKey(workspaceKey, relativePath)
      : null;

  // Construct a direct file://-equivalent URL that the registered custom
  // protocols (workspace://, attachment://) can resolve without reading the
  // file into memory or base64-encoding it.
  const blobUrl = useMemo(() => {
    if (!workspaceKey || !relativePath) return '';
    if (workspaceKey.startsWith('att:')) {
      return tab.agentInstanceId
        ? `attachment://${tab.agentInstanceId}/${encodeURIComponent(relativePath)}`
        : '';
    }
    const colonIdx = workspaceKey.indexOf(':');
    if (colonIdx <= 0) return '';
    const mountPrefix = workspaceKey.slice(0, colonIdx);
    const workspaceRoot = workspaceKey.slice(colonIdx + 1);
    const params = new URLSearchParams({ root: workspaceRoot });
    return `workspace://${mountPrefix}/${encodeURIComponent(relativePath)}?${params}`;
  }, [workspaceKey, relativePath, tab.agentInstanceId]);

  // The file-tree watcher bumps the revision of the directory backing each
  // open file tab whenever its contents change on disk. Subscribing to that
  // single number lets us revalidate only the affected file in response to an
  // external edit, instead of polling every open tab.
  const directoryRevision = useKartonState((s) => {
    if (!workspaceKey || !relativePath) return 0;
    const slash = relativePath.lastIndexOf('/');
    const directoryPath = slash === -1 ? '' : relativePath.slice(0, slash);
    return (
      s.fileTree.directoryRevisions?.[workspaceKey]?.[directoryPath] ??
      s.fileTree.workspaceRevisions?.[workspaceKey] ??
      0
    );
  });

  const cached = cacheKey ? previewCache.get(cacheKey) : undefined;
  const [preview, setPreview] = useState<FilePreviewResult | null>(
    cached?.preview ?? null,
  );
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  const [isLoading, setIsLoading] = useState(!cached);

  // Cheap revalidation: stat the file and only re-read its full contents when
  // the mtime/size actually changed. Used for both re-open staleness (run on
  // mount) and live external-edit detection (run on directory-revision bumps).
  // Read-only blobs (attachments) never change, so they are skipped entirely.
  const revalidate = useCallback(async () => {
    if (isDiffTab) return;
    if (!workspaceKey || !relativePath || !cacheKey) return;
    const current = previewCache.get(cacheKey);
    // Nothing loaded yet — the initial-load effect owns the first fetch.
    if (!current?.preview) return;
    if (current.preview.readOnly) return;

    let stat: FileStatResult | null = null;
    try {
      stat = await getFileStat(workspaceKey, relativePath);
    } catch {
      return; // Transient failure — keep showing the current content.
    }
    if (!stat) {
      const missing = 'ENOENT: file no longer exists';
      previewCache.set(cacheKey, { preview: null, error: missing });
      setPreview(null);
      setError(missing);
      return;
    }
    const latest = previewCache.get(cacheKey)?.preview;
    if (
      latest &&
      latest.mtimeMs === stat.mtimeMs &&
      latest.size === stat.size
    ) {
      return; // Unchanged on disk — nothing to do.
    }

    let result: FilePreviewResult | null;
    try {
      result = await getFilePreview(workspaceKey, relativePath);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load file';
      previewCache.set(cacheKey, { preview: null, error: message });
      setPreview(null);
      setError(message);
      return;
    }
    const nextError = result ? null : 'File preview unavailable';
    previewCache.set(cacheKey, { preview: result, error: nextError });
    setPreview(result);
    setError(nextError);
  }, [
    isDiffTab,
    workspaceKey,
    relativePath,
    cacheKey,
    getFileStat,
    getFilePreview,
  ]);

  useEffect(() => {
    if (isDiffTab) return;
    if (!workspaceKey || !relativePath || !cacheKey) return;
    const cachedPreview = previewCache.get(cacheKey);
    if (cachedPreview) {
      setPreview(cachedPreview.preview);
      setError(cachedPreview.error);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const request =
      previewRequests.get(cacheKey) ??
      getFilePreview(workspaceKey, relativePath).finally(() => {
        previewRequests.delete(cacheKey);
      });
    previewRequests.set(cacheKey, request);

    request
      .then((result) => {
        const nextError = result ? null : 'File preview unavailable';
        previewCache.set(cacheKey, {
          preview: result,
          error: nextError,
        });
        if (cancelled) return;
        setPreview(result);
        setError(nextError);
      })
      .catch((err) => {
        const nextError =
          err instanceof Error ? err.message : 'Failed to load file';
        previewCache.set(cacheKey, {
          preview: null,
          error: nextError,
        });
        if (cancelled) return;
        setPreview(null);
        setError(nextError);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isDiffTab, workspaceKey, relativePath, cacheKey, getFilePreview]);

  // Revalidate when the tab (re)mounts and whenever the backing directory
  // changes on disk. On mount this ensures a re-opened tab shows the latest
  // content rather than a stale cached copy; on revision bumps it picks up
  // external edits in real time without polling.
  // Skip when the file has a delete notice — the file no longer exists and
  // we're preserving the cached content for re-create.
  useEffect(() => {
    if (tab.fileNotice?.kind === 'deleted') return;
    void revalidate();
  }, [revalidate, directoryRevision, tab.fileNotice]);

  if (!tab.file) {
    return (
      <div className="flex size-full items-center justify-center bg-background text-muted-foreground text-sm">
        Missing file metadata.
      </div>
    );
  }

  // Handlers for file-notice banners.
  const handleDismissMoveNotice = useCallback(() => {
    void clearFileNotice(tab.id);
  }, [clearFileNotice, tab.id]);

  const handleCloseDeletedTab = useCallback(() => {
    void clearFileNotice(tab.id);
    void closeTab(tab.id);
  }, [clearFileNotice, closeTab, tab.id]);

  const handleRecreateDeleted = useCallback(async () => {
    if (!workspaceKey || !relativePath) return;
    setIsRecreating(true);
    try {
      const content =
        textDraftCache.get(getPreviewCacheKey(workspaceKey, relativePath)) ??
        preview?.text ??
        '';
      await recreateDeletedFile(workspaceKey, relativePath, content);
      // Recreate succeeded — the notice is cleared by the backend.
      // Re-trigger loading to fetch the freshly-created file.
      setIsRecreating(false);
      void revalidate();
    } catch {
      setIsRecreating(false);
    }
  }, [workspaceKey, relativePath, preview, recreateDeletedFile, revalidate]);

  const fileNotice = tab.fileNotice;

  // File was deleted — keep showing cached content with the delete banner.
  // Don't show the MissingFileNotice; the user can still see/edit and
  // choose to re-create.
  if (fileNotice?.kind === 'deleted') {
    const cachedPreview = cacheKey
      ? (previewCache.get(cacheKey)?.preview ?? preview)
      : preview;
    return (
      <div className="absolute inset-0 z-10 flex flex-col bg-background">
        <FileDeletedBanner
          onClose={handleCloseDeletedTab}
          onRecreate={handleRecreateDeleted}
          isRecreating={isRecreating}
        />
        <div className="min-h-0 flex-1">
          {cachedPreview ? (
            cachedPreview.kind === 'image' ? (
              <ImagePreview
                preview={cachedPreview}
                blobUrl={blobUrl}
                tabId={tab.id}
              />
            ) : cachedPreview.kind === 'svg' ? (
              <SvgPreview preview={cachedPreview} tabId={tab.id} />
            ) : isMarkdownPath(cachedPreview.relativePath) ? (
              <MarkdownPreview preview={cachedPreview} tabId={tab.id} />
            ) : (
              <TextEditorPreview preview={cachedPreview} tabId={tab.id} />
            )
          ) : (
            <div className="flex size-full flex-col bg-background">
              <FileTabToolbar actions={null} />
              <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-xs">
                No cached content available.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Git diff view: bypass the regular file preview pipeline entirely.
  // The DiffEditorPreview loads its own content and is read-only.
  if (tab.file?.showDiff) {
    return (
      <div className="absolute inset-0 z-10 flex flex-col bg-background">
        <DiffEditorPreview tab={tab.file} tabId={tab.id} />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      {fileNotice?.kind === 'moved' && tab.file && (
        <FileMoveBanner
          fromPath={fileNotice.fromRelativePath}
          toPath={tab.file.relativePath}
          onDismiss={handleDismissMoveNotice}
        />
      )}
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex size-full flex-col bg-background">
            <FileTabToolbar actions={null} />
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-xs">
              <div className="flex items-center gap-2">
                <Loader2Icon className="size-3.5 animate-spin" />
                <span>Loading file…</span>
              </div>
            </div>
          </div>
        ) : isMissingFileError(error) ? (
          <MissingFileNotice />
        ) : error || !preview ? (
          <div className="flex size-full flex-col bg-background">
            <FileTabToolbar actions={null} />
            <div className="flex min-h-0 flex-1 items-center justify-center text-error-foreground text-sm">
              {error ?? 'Failed to load file'}
            </div>
          </div>
        ) : preview.truncated ? (
          <div className="flex size-full flex-col">
            {preview.kind === 'text' || preview.kind === 'svg' ? (
              <>
                <div className="shrink-0 border-border border-b px-3 py-1 text-warning-foreground text-xs">
                  Preview truncated
                </div>
                <div className="min-h-0 flex-1">
                  <TextEditorPreview preview={preview} tabId={tab.id} />
                </div>
              </>
            ) : (
              <BinaryPreview
                workspaceKey={workspaceKey!}
                relativePath={relativePath!}
                revealInFolder={revealInFolder}
              />
            )}
          </div>
        ) : preview.kind === 'image' ? (
          <ImagePreview preview={preview} blobUrl={blobUrl} tabId={tab.id} />
        ) : preview.kind === 'svg' ? (
          <SvgPreview preview={preview} tabId={tab.id} />
        ) : preview.kind === 'text' && isMarkdownPath(preview.relativePath) ? (
          <MarkdownPreview preview={preview} tabId={tab.id} />
        ) : preview.kind === 'text' ? (
          <TextEditorPreview preview={preview} tabId={tab.id} />
        ) : (
          <BinaryPreview
            workspaceKey={workspaceKey!}
            relativePath={relativePath!}
            revealInFolder={revealInFolder}
          />
        )}
      </div>
    </div>
  );
}
