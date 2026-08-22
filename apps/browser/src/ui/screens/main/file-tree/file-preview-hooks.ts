import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';

import { useTabUIState } from '@ui/hooks/use-tab-ui-state';
import type { FilePreviewResult } from '@shared/karton-contracts/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HotkeyActions } from '@shared/hotkeys';
import { useHotKeyListener } from '@ui/hooks/use-hotkey-listener';

import {
  type EditorActions,
  useFileEditorController,
} from './use-file-editor-controller';
import {
  type MonacoEditorInstance,
  previewCache,
  textDraftCache,
  getPreviewCacheKey,
} from './file-preview-utils';

export function useSourceCursorPosition(editor: MonacoEditorInstance | null): {
  lineNumber: number;
  column: number;
} {
  const [cursorPosition, setCursorPosition] = useState({
    lineNumber: 1,
    column: 1,
  });

  useEffect(() => {
    if (!editor) return;
    const position = editor.getPosition();
    if (position) {
      setCursorPosition({
        lineNumber: position.lineNumber,
        column: position.column,
      });
    }
    const disposable = editor.onDidChangeCursorPosition((event) => {
      setCursorPosition({
        lineNumber: event.position.lineNumber,
        column: event.position.column,
      });
    });
    return () => disposable.dispose();
  }, [editor]);

  return cursorPosition;
}

export function useEditorActions(
  tabId: string,
  editor: MonacoEditorInstance | null,
  preview: FilePreviewResult,
  text: string,
  setText: (value: string) => void,
): EditorActions {
  const saveFile = useKartonProcedure((p) => p.fileTree.saveFile);
  const getFilePreview = useKartonProcedure((p) => p.fileTree.getFilePreview);
  const readOnly = preview.readOnly ?? false;
  const cacheKey = getPreviewCacheKey(
    preview.workspaceKey,
    preview.relativePath,
  );

  // Track the editor + current draft text in refs so the controller's stable
  // callbacks always observe live values without being re-created.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const textRef = useRef(text);
  textRef.current = text;

  const controller = useFileEditorController({
    tabId,
    workspaceKey: preview.workspaceKey,
    relativePath: preview.relativePath,
    readOnly,
    saveFile,
    initialText: preview.text ?? '',
    initialMtimeMs: preview.mtimeMs,
    getModel: () => editorRef.current?.getModel(),
    // Fall back to the draft text when the editor is unmounted (e.g. SVG /
    // markdown preview mode) so dirty detection keeps working.
    getValue: () => editorRef.current?.getValue() ?? textRef.current,
    reload: async () => {
      const result = await getFilePreview(
        preview.workspaceKey,
        preview.relativePath,
      );
      if (!result) return null;
      const diskText = result.text ?? '';
      const key = getPreviewCacheKey(result.workspaceKey, result.relativePath);
      previewCache.set(key, { preview: result, error: null });
      textDraftCache.set(key, diskText);
      setText(diskText);
      return { text: diskText, mtimeMs: result.mtimeMs };
    },
    unsavedTitle: preview.relativePath.split('/').pop() || preview.relativePath,
    onDiscard: () => {
      textDraftCache.delete(cacheKey);
    },
    onSaved: (result, nextText) => {
      if (!result) return;
      const key = getPreviewCacheKey(result.workspaceKey, result.relativePath);
      previewCache.set(key, { preview: result, error: null });
      textDraftCache.set(key, nextText);
    },
  });

  const { reconcileDisk, refreshState, notifyContentChanged } = controller;

  // React to fresh on-disk content arriving from the parent's revalidation
  // (driven by the file-tree watcher bumping the backing directory's
  // revision). With no local edits the new content is adopted live; with
  // unsaved edits a conflict is raised so the user is warned.
  useEffect(() => {
    if (readOnly) return;
    const outcome = reconcileDisk(preview.text ?? '', preview.mtimeMs);
    if (outcome === 'adopted') {
      textDraftCache.set(cacheKey, preview.text ?? '');
      setText(preview.text ?? '');
    }
  }, [
    preview.text,
    preview.mtimeMs,
    readOnly,
    cacheKey,
    setText,
    reconcileDisk,
  ]);

  // Keep dirty/undo/redo in sync with the text value regardless of editor
  // mount state. When the editor is unmounted (e.g. SVG preview mode),
  // onDidChangeModelContent doesn't fire, so we rely on this effect.
  useEffect(() => {
    refreshState();
  }, [text, refreshState]);

  useEffect(() => {
    if (!editor) return;
    refreshState();
    const contentDisposable = editor.onDidChangeModelContent(() => {
      notifyContentChanged();
    });
    const cursorDisposable = editor.onDidChangeCursorSelection(() => {
      window.setTimeout(refreshState, 0);
    });
    return () => {
      contentDisposable.dispose();
      cursorDisposable.dispose();
    };
  }, [editor, refreshState, notifyContentChanged]);

  return controller.actions;
}

export function useFileCodeZoom(tabId: string, enabled = true) {
  const storedZoomPercentage = useKartonState(
    (s) => s.preferences.general.fileCodeZoomPercentage,
  );
  const zoomPercentage = storedZoomPercentage ?? 100;
  const zoomPercentageRef = useRef(zoomPercentage);
  zoomPercentageRef.current = zoomPercentage;
  const { tabUiState, setTabUiState } = useTabUIState();
  const isTabContentFocused = tabUiState[tabId]?.focusedPanel === 'tab-content';

  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const updateZoom = useCallback(
    (nextZoomPercentage: number) => {
      const next = Math.max(50, Math.min(200, nextZoomPercentage));
      void updatePreferences([
        {
          op: storedZoomPercentage === undefined ? 'add' : 'replace',
          path: ['general', 'fileCodeZoomPercentage'],
          value: next,
        },
      ]);
    },
    [storedZoomPercentage, updatePreferences],
  );

  const zoomIn = useCallback(() => {
    if (!isTabContentFocused) return false;
    updateZoom(zoomPercentage + 10);
  }, [isTabContentFocused, updateZoom, zoomPercentage]);

  const zoomOut = useCallback(() => {
    if (!isTabContentFocused) return false;
    updateZoom(zoomPercentage - 10);
  }, [isTabContentFocused, updateZoom, zoomPercentage]);

  const zoomReset = useCallback(() => {
    if (!isTabContentFocused) return false;
    updateZoom(100);
  }, [isTabContentFocused, updateZoom]);

  const markFocused = useCallback(() => {
    setTabUiState(tabId, { focusedPanel: 'tab-content' });
  }, [setTabUiState, tabId]);

  useHotKeyListener(zoomIn, HotkeyActions.ZOOM_IN, enabled);
  useHotKeyListener(zoomOut, HotkeyActions.ZOOM_OUT, enabled);
  useHotKeyListener(zoomReset, HotkeyActions.ZOOM_RESET, enabled);

  return {
    fontSize: (12 * zoomPercentage) / 100,
    markFocused,
    updateZoom,
    zoomPercentage,
    zoomPercentageRef,
  };
}
