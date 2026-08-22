import { SearchableSelect } from '@clodex/stage-ui/components/searchable-select';

import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import type { FilePreviewResult, TabState } from '@shared/karton-contracts/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconSplitViewOutline18,
  IconTextAlignLeft2Outline18,
} from '@clodex/icons';
import type { FileDiffContent } from '@shared/karton-contracts/ui';
import { Loader2Icon } from 'lucide-react';

import MonacoEditor, { DiffEditor } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';

import { useFileEditorController } from './use-file-editor-controller';
import {
  useEditorActions,
  useFileCodeZoom,
  useSourceCursorPosition,
} from './file-preview-hooks';
import {
  MONACO_SHARED_OPTIONS,
  MONACO_THEME_NAME,
  configureMonacoTheme,
  registerMonacoThemeSync,
  registerMonacoZoomCommands,
} from './file-preview-monaco';
import {
  type MonacoApi,
  type MonacoEditorInstance,
  scrollStateStore,
  diffModeStore,
  textDraftCache,
  diffDraftCache,
  languageFromPath,
  getPreviewCacheKey,
  type SourceLanguage,
  SOURCE_LANGUAGE_ITEMS,
} from './file-preview-utils';
import {
  ExternalChangeBanner,
  FileTabToolbar,
  getPreviewAbsolutePath,
} from './file-preview-toolbar';

export type DiffMode = 'inline' | 'split';

export function DiffEditorPreview({
  tab,
  tabId,
}: {
  tab: NonNullable<TabState['file']>;
  tabId: string;
}) {
  const getFileDiffContent = useKartonProcedure(
    (p) => p.toolbox.getFileDiffContent,
  );
  // Karton procedure identities are not guaranteed stable across renders;
  // keep this one in a ref so the load effect/reload don't re-run every render.
  const getFileDiffContentRef = useRef(getFileDiffContent);
  getFileDiffContentRef.current = getFileDiffContent;
  const saveFile = useKartonProcedure((p) => p.fileTree.saveFile);
  const getFileStat = useKartonProcedure((p) => p.fileTree.getFileStat);
  const [diffMode, setDiffMode] = useState<DiffMode>(() => {
    const stored = diffModeStore.get(tabId);
    return stored === 'inline' || stored === 'split' ? stored : 'inline';
  });
  const [diffContent, setDiffContent] = useState<FileDiffContent | null>(null);
  // The value rendered into the editable (modified/right) pane. Held separately
  // from `diffContent.modified` (the on-disk baseline) so it can be seeded from
  // `diffDraftCache` on mount and only reset on an explicit reload/adopt — never
  // mid-edit — which would otherwise clobber the model's content + undo stack.
  const [modifiedValue, setModifiedValue] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const language = languageFromPath(tab.relativePath);
  const { fontSize, markFocused } = useFileCodeZoom(tabId);
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(
    null,
  );

  // The diff always renders the committed (HEAD) version against the current
  // working-tree file, so the modified/right side is the live file on disk
  // and is editable unless the tab is explicitly read-only. Staged diffs are
  // the exception: they render the index snapshot (mtimeMs: null) with no
  // editable on-disk backing, so saving could overwrite unrelated unstaged
  // edits in the working tree — keep them read-only.
  const editable = !(tab.readOnly ?? false) && !(tab.diffStaged ?? false);

  // Last on-disk mtime we have reconciled to. Lets the live-detection effect
  // skip a git-diff fetch when an unrelated change bumps the directory
  // revision, and avoids treating our own writes as external edits.
  const diskMtimeRef = useRef<number | null>(null);

  // In-progress modified-side edits are cached by file identity — workspace +
  // path + staged flag — not by tab id. A tab id can be reused for a different
  // file or diff mode, and keying drafts by it would restore the wrong content
  // into the editable pane. A ref keeps the key current for the mount-time
  // content listener without forcing it to re-register on every render.
  const diffDraftKey = `${tab.workspaceKey}:${tab.relativePath}:${
    tab.diffStaged ? 'staged' : 'working'
  }`;
  const diffDraftKeyRef = useRef(diffDraftKey);
  diffDraftKeyRef.current = diffDraftKey;

  const persistMode = useCallback(
    (next: DiffMode) => {
      diffModeStore.set(tabId, next);
      setDiffMode(next);
    },
    [tabId],
  );

  // Extract the workspace path from the workspace key for the git diff
  // procedure (it expects a filesystem path, not a composite key).
  const workspacePath = useMemo(() => {
    const colonIdx = tab.workspaceKey.indexOf(':');
    return colonIdx < 0
      ? tab.workspaceKey
      : tab.workspaceKey.slice(colonIdx + 1);
  }, [tab.workspaceKey]);

  // All save / dirty / undo-redo / conflict / unsaved-prompt / hotkey behavior
  // is shared with the plain source editor via this controller. The diff
  // editor only supplies the editable (modified) model + a diff-aware reload.
  const controller = useFileEditorController({
    tabId,
    workspaceKey: tab.workspaceKey,
    relativePath: tab.relativePath,
    readOnly: !editable,
    saveFile,
    getModel: () => diffEditorRef.current?.getModifiedEditor().getModel(),
    getValue: () => diffEditorRef.current?.getModifiedEditor().getValue(),
    reload: async () => {
      setIsLoading(true);
      setDiffError(null);
      try {
        const content = await getFileDiffContentRef.current(
          workspacePath,
          tab.relativePath,
          tab.diffStaged ?? false,
          tab.diffOldPath,
        );
        setDiffContent(content);
        diskMtimeRef.current = content?.mtimeMs ?? null;
        if (!content) {
          setDiffError('Unable to load diff content.');
          return null;
        }
        // Explicit reload discards any in-progress draft and loads the fresh
        // on-disk content into the modified pane.
        diffDraftCache.delete(diffDraftKeyRef.current);
        setModifiedValue(content.modified);
        return { text: content.modified, mtimeMs: content.mtimeMs };
      } catch (err) {
        setDiffError(
          err instanceof Error ? err.message : 'Failed to load diff',
        );
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    unsavedTitle: tab.relativePath.split('/').pop() || tab.relativePath,
    onSaved: (result) => {
      diskMtimeRef.current = result?.mtimeMs ?? null;
      // Saved content now matches disk; drop the draft so a later remount
      // reloads the clean on-disk version.
      diffDraftCache.delete(diffDraftKeyRef.current);
    },
    onDiscard: () => {
      diffDraftCache.delete(diffDraftKeyRef.current);
    },
    onSaveError: (err) => {
      setDiffError(err instanceof Error ? err.message : 'Failed to save');
    },
  });

  const { actions, reconcileDisk, refreshState, notifyContentChanged } =
    controller;

  // The @monaco-editor/react DiffEditor frequently mounts before its flex
  // container has a measured width, collapsing both panes to zero width
  // (only the right-edge overview ruler + scrollbar stay visible). Its
  // built-in automaticLayout does not reliably recover, so we force a
  // layout on mount and observe the container for size changes.
  const handleDiffMount = useCallback(
    (editor: Monaco.editor.IStandaloneDiffEditor, monaco: MonacoApi) => {
      diffEditorRef.current = editor;
      // Keep diff tabs on the live OS color scheme, matching the plain editor
      // mount; otherwise a theme flip leaves the diff on a stale Monaco theme.
      registerMonacoThemeSync(monaco);
      const container = editor.getContainerDomNode();
      const relayout = () => editor.layout();
      // Force an initial layout once the browser has painted the container.
      requestAnimationFrame(relayout);
      setTimeout(relayout, 0);
      setTimeout(relayout, 100);
      const target = container?.parentElement ?? container;
      if (target && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => editor.layout());
        observer.observe(target);
        editor.onDidDispose(() => observer.disconnect());
      }

      // Wire dirty tracking on the modified (right) editor. Save/undo/redo
      // hotkeys are handled globally by the controller.
      const modified = editor.getModifiedEditor();
      modified.onDidFocusEditorWidget(markFocused);
      modified.onDidChangeModelContent(() => {
        // Persist the in-progress edit so it survives an unmount/remount of
        // this tab (mirrors the plain editor's `textDraftCache`).
        diffDraftCache.set(diffDraftKeyRef.current, modified.getValue());
        notifyContentChanged();
      });
      refreshState();
    },
    [markFocused, notifyContentChanged, refreshState],
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setDiffError(null);

    // Safety timeout — surface an error if the backend doesn't respond
    // within a reasonable window instead of spinning forever.
    const safetyTimer = setTimeout(() => {
      if (!cancelled) {
        setDiffError('Diff load timed out.');
        setIsLoading(false);
      }
    }, 15_000);

    getFileDiffContentRef
      .current(
        workspacePath,
        tab.relativePath,
        tab.diffStaged ?? false,
        tab.diffOldPath,
      )
      .then((content) => {
        if (cancelled) return;
        // A success that lands after the safety timeout already fired must
        // clear the stale timeout error, otherwise the error pane stays up
        // despite valid content now being available.
        setDiffError(null);
        setDiffContent(content);
        diskMtimeRef.current = content?.mtimeMs ?? null;
        controller.setBaseline(
          content?.modified ?? '',
          content?.mtimeMs ?? null,
        );
        // Seed the modified pane from any cached draft (in-progress edits from
        // a prior mount of this tab) falling back to the on-disk content. The
        // baseline stays the on-disk content above, so a restored draft is
        // correctly reported as dirty.
        setModifiedValue(
          diffDraftCache.get(diffDraftKeyRef.current) ??
            content?.modified ??
            '',
        );
        if (!content) setDiffError('Unable to load diff content.');
      })
      .catch((err) => {
        if (cancelled) return;
        setDiffError(
          err instanceof Error ? err.message : 'Failed to load diff',
        );
      })
      .finally(() => {
        clearTimeout(safetyTimer);
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, tab.relativePath, tab.diffStaged, tab.diffOldPath]);

  // Live external-change detection. The file-tree watcher bumps the backing
  // directory's revision whenever its contents change on disk; on each bump we
  // cheaply stat the file and, if it actually changed, re-fetch the diff and
  // reconcile (adopt the new content when clean, raise a conflict otherwise).
  const directoryRevision = useKartonState((s) => {
    const slash = tab.relativePath.lastIndexOf('/');
    const directoryPath = slash === -1 ? '' : tab.relativePath.slice(0, slash);
    return (
      s.fileTree.directoryRevisions?.[tab.workspaceKey]?.[directoryPath] ??
      s.fileTree.workspaceRevisions?.[tab.workspaceKey] ??
      0
    );
  });
  const prevRevisionRef = useRef(directoryRevision);

  useEffect(() => {
    // Skip the initial run — the load effect owns the first fetch/baseline.
    if (prevRevisionRef.current === directoryRevision) return;
    prevRevisionRef.current = directoryRevision;
    if (!editable) return;

    let cancelled = false;
    void (async () => {
      let stat: Awaited<ReturnType<typeof getFileStat>> = null;
      try {
        stat = await getFileStat(tab.workspaceKey, tab.relativePath);
      } catch {
        return; // Transient failure — keep showing the current diff.
      }
      if (cancelled || !stat) return;
      if (stat.mtimeMs === diskMtimeRef.current) return; // Unchanged on disk.

      let content: FileDiffContent | null;
      try {
        content = await getFileDiffContentRef.current(
          workspacePath,
          tab.relativePath,
          tab.diffStaged ?? false,
          tab.diffOldPath,
        );
      } catch {
        return;
      }
      if (cancelled || !content) return;
      diskMtimeRef.current = content.mtimeMs ?? stat.mtimeMs;
      const outcome = reconcileDisk(content.modified, content.mtimeMs);
      // 'adopted' means the user had no local edits, so the fresh on-disk
      // content can replace both the baseline and the visible modified pane.
      if (outcome === 'adopted') {
        setDiffContent(content);
        diffDraftCache.delete(diffDraftKeyRef.current);
        setModifiedValue(content.modified);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    directoryRevision,
    editable,
    getFileStat,
    workspacePath,
    tab.workspaceKey,
    tab.relativePath,
    tab.diffStaged,
    tab.diffOldPath,
    reconcileDisk,
  ]);

  return (
    <div className="flex size-full flex-col bg-background">
      <FileTabToolbar
        actions={actions}
        openExternalPath={getPreviewAbsolutePath({
          workspaceKey: tab.workspaceKey,
          relativePath: tab.relativePath,
        } as FilePreviewResult)}
        onInteract={markFocused}
        right={
          <div className="flex h-7 items-center gap-1 rounded-md bg-surface-1 p-0.5">
            <button
              type="button"
              className={cn(
                'flex h-full cursor-pointer items-center gap-1 rounded px-2.5 text-muted-foreground text-xs transition-colors hover:text-foreground',
                diffMode === 'inline' &&
                  'bg-background text-foreground ring-1 ring-border-subtle',
              )}
              aria-label="Inline diff"
              aria-pressed={diffMode === 'inline'}
              onClick={() => persistMode('inline')}
            >
              <IconTextAlignLeft2Outline18 className="size-3.5" />
              {diffMode === 'inline' ? <span>Inline</span> : null}
            </button>
            <button
              type="button"
              className={cn(
                'flex h-full cursor-pointer items-center gap-1 rounded px-2.5 text-muted-foreground text-xs transition-colors hover:text-foreground',
                diffMode === 'split' &&
                  'bg-background text-foreground ring-1 ring-border-subtle',
              )}
              aria-label="Split diff"
              aria-pressed={diffMode === 'split'}
              onClick={() => persistMode('split')}
            >
              <IconSplitViewOutline18 className="size-3.5" />
              {diffMode === 'split' ? <span>Split</span> : null}
            </button>
          </div>
        }
      />
      {actions.externalChange ? (
        <ExternalChangeBanner actions={actions} />
      ) : null}
      <div
        className="min-h-0 flex-1"
        onFocusCapture={markFocused}
        onPointerDownCapture={markFocused}
      >
        {isLoading ? (
          <div className="flex size-full items-center justify-center text-muted-foreground text-xs">
            <div className="flex items-center gap-2">
              <Loader2Icon className="size-3.5 animate-spin" />
              <span>Loading diff…</span>
            </div>
          </div>
        ) : diffError || !diffContent ? (
          <div className="flex size-full items-center justify-center text-error-foreground text-sm">
            {diffError ?? 'Unable to load diff'}
          </div>
        ) : (
          <DiffEditor
            height="100%"
            width="100%"
            language={language === 'plaintext' ? undefined : language}
            original={diffContent.original}
            modified={modifiedValue ?? diffContent.modified}
            theme={MONACO_THEME_NAME}
            beforeMount={configureMonacoTheme}
            onMount={handleDiffMount}
            options={{
              ...MONACO_SHARED_OPTIONS,
              renderSideBySide: diffMode === 'split',
              // Monaco otherwise auto-collapses side-by-side to inline
              // whenever the editor is narrower than
              // renderSideBySideInlineBreakpoint (900px). The file panel is
              // usually narrower than that, so force the chosen mode.
              useInlineViewWhenSpaceIsLimited: false,
              readOnly: !editable,
              originalEditable: false,
              renderIndicators: true,
              // Disable word wrap in both panes; lines scroll horizontally
              // instead. The diff editor's own wrap control defaults to
              // 'inherit', which Monaco applies inconsistently across panes,
              // so set it explicitly to keep both sides identical.
              diffWordWrap: 'off',
              // Monaco reserves a left margin in the modified editor for the
              // revert-change arrow icons. In split mode that margin shows up
              // as empty space between the two panes; in inline mode it pads
              // the left of the gutter. Disable it to reclaim that space.
              renderMarginRevertIcon: false,
              // Trim the remaining gutter chrome: drop the glyph margin and
              // code folding controls. lineNumbersMinChars keeps the (right-
              // aligned) number column from reserving extra blank space to
              // the left of the digits, while lineDecorationsWidth restores a
              // readable gap between the numbers and the code.
              glyphMargin: false,
              lineNumbersMinChars: 2,
              lineDecorationsWidth: 10,
              folding: false,
              enableSplitViewResizing: diffMode === 'split',
              // The diff editor renders both its own vertical scrollbar and a
              // wider diff overview ruler (the colored add/remove map). That
              // looks like two stacked scrollbars. Hide the plain scrollbar
              // and keep the highlighted overview ruler as the sole scroll
              // affordance (it supports click/drag-to-scroll).
              scrollbar: {
                ...MONACO_SHARED_OPTIONS.scrollbar,
                vertical: 'hidden',
                verticalScrollbarSize: 0,
              },
              // Apply the shared file-code zoom level. IDiffEditorOptions
              // extends the base editor options, so this propagates to both
              // the original and modified panes. The @monaco-editor/react
              // DiffEditor re-applies options on change, so updating the zoom
              // store re-renders this component and rescales the diff.
              fontSize,
              lineHeight: fontSize * 1.5,
            }}
          />
        )}
      </div>
    </div>
  );
}

export function TextEditorPreview({
  preview,
  tabId,
}: {
  preview: FilePreviewResult;
  tabId: string;
}) {
  const cacheKey = getPreviewCacheKey(
    preview.workspaceKey,
    preview.relativePath,
  );
  const [text, setText] = useState(
    () => textDraftCache.get(cacheKey) ?? preview.text ?? '',
  );
  const { fontSize, markFocused, updateZoom, zoomPercentageRef } =
    useFileCodeZoom(tabId);
  const [language, setLanguage] = useState<SourceLanguage>(() =>
    languageFromPath(preview.relativePath),
  );
  const [editor, setEditor] = useState<MonacoEditorInstance | null>(null);
  const cursorPosition = useSourceCursorPosition(editor);
  const actions = useEditorActions(tabId, editor, preview, text, setText);

  const handleMount = useCallback(
    (editor: MonacoEditorInstance, monaco: MonacoApi) => {
      setEditor(editor);
      registerMonacoThemeSync(monaco);
      editor.onDidFocusEditorWidget(markFocused);
      registerMonacoZoomCommands(
        editor,
        monaco,
        markFocused,
        updateZoom,
        zoomPercentageRef,
      );
      // Save scroll position on every scroll so it survives tab switches
      // even if the editor is disposed before the unmount cleanup runs.
      editor.onDidScrollChange((e) => {
        scrollStateStore.set(cacheKey, {
          scrollTop: e.scrollTop,
          scrollLeft: e.scrollLeft,
        });
      });
      // Restore the last-known scroll position for this file.
      // Set immediately so the position is correct even if no layout
      // event fires after mount.  Monaco produces multiple layout
      // events during initialisation (content layout, then font-size /
      // option sync from the React wrapper) — each one resets the
      // scroll, so keep re-restoring on every layout event for a
      // settling window.
      const saved = scrollStateStore.get(cacheKey);
      if (saved) {
        editor.setScrollPosition(saved);
        const layoutDisposable = editor.onDidLayoutChange(() => {
          editor.setScrollPosition(saved);
        });
        setTimeout(() => layoutDisposable.dispose(), 300);
      }
    },
    [cacheKey, markFocused, updateZoom, zoomPercentageRef],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      const nextText = value ?? '';
      textDraftCache.set(cacheKey, nextText);
      setText(nextText);
    },
    [cacheKey],
  );

  useEffect(() => {
    editor?.updateOptions({
      fontSize,
      lineHeight: fontSize * 1.5,
    });
  }, [editor, fontSize]);

  return (
    <div className="flex size-full flex-col bg-background">
      <FileTabToolbar
        actions={actions}
        openExternalPath={getPreviewAbsolutePath(preview)}
        onInteract={markFocused}
      />
      {actions.externalChange ? (
        <ExternalChangeBanner actions={actions} />
      ) : null}
      <div
        className="min-h-0 flex-1"
        onFocusCapture={markFocused}
        onPointerDownCapture={markFocused}
      >
        <MonacoEditor
          height="100%"
          language={language === 'plaintext' ? undefined : language}
          path={`${preview.workspaceKey}/${preview.relativePath}`}
          value={text}
          theme={MONACO_THEME_NAME}
          beforeMount={configureMonacoTheme}
          onMount={handleMount}
          onChange={handleChange}
          options={{
            ...MONACO_SHARED_OPTIONS,
            readOnly: preview.readOnly ?? false,
            fontSize,
            lineHeight: fontSize * 1.5,
          }}
        />
      </div>
      <FileEditorStatusBar
        lineNumber={cursorPosition.lineNumber}
        column={cursorPosition.column}
        language={language}
        onLanguageChange={setLanguage}
      />
    </div>
  );
}

export function FileEditorStatusBar({
  lineNumber,
  column,
  language,
  onLanguageChange,
}: {
  lineNumber: number;
  column: number;
  language: SourceLanguage;
  onLanguageChange: (language: SourceLanguage) => void;
}) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-border-subtle border-t bg-background pr-0.5 pl-2 text-muted-foreground text-xs">
      <span className="font-mono tabular-nums">
        Ln {lineNumber}, Col {column}
      </span>
      <SearchableSelect
        items={SOURCE_LANGUAGE_ITEMS}
        value={language}
        onValueChange={(value) => onLanguageChange(value as SourceLanguage)}
        size="xs"
        triggerVariant="ghost"
        triggerClassName="h-5 rounded-none px-1.5"
        side="top"
      />
    </div>
  );
}
