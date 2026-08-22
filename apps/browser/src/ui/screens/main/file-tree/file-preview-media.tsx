import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@clodex/stage-ui/components/popover';

import { Select } from '@clodex/stage-ui/components/select';

import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import { useTabUIState } from '@ui/hooks/use-tab-ui-state';
import type { FilePreviewResult } from '@shared/karton-contracts/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconArrowsToCenterOutline18,
  IconColorPaletteOutline18,
  IconDatabaseFillDuo18,
  IconEye2Outline18,
  IconSquareCodeOutline18,
  IconTextBgColorOutline18,
  IconTextColorOutline18,
} from '@clodex/icons';

import { MinusIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';

import MonacoEditor from '@monaco-editor/react';
import { HotkeyActions } from '@shared/hotkeys';
import { useHotKeyListener } from '@ui/hooks/use-hotkey-listener';
import { HotkeyCombo } from '@ui/components/hotkey-combo';

import { nativeFileManagerLabel } from '@shared/ide-url';

import { Streamdown } from '@ui/components/streamdown';
import { FileEditorStatusBar } from './file-preview-editors';
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
  ExternalChangeBanner,
  FileTabToolbar,
  ToolbarTooltip,
  getPreviewAbsolutePath,
} from './file-preview-toolbar';
import {
  type SourceLanguage,
  getPreviewCacheKey,
  languageFromPath,
  scrollStateStore,
  textDraftCache,
  normalizeHexColor,
  resolveCssColor,
  type ImagePreviewBackground,
  type SvgPreviewBackground,
  type SvgCurrentColorMode,
  markdownModeStore,
  type MonacoApi,
  type MonacoEditorInstance,
} from './file-preview-utils';

export function ImagePreview({
  preview,
  blobUrl,
  tabId,
}: {
  preview: FilePreviewResult;
  blobUrl: string;
  tabId: string;
}) {
  const [background, setBackground] =
    useState<ImagePreviewBackground>('default');
  const [customBackground, setCustomBackground] = useState('ffffff');
  const {
    zoom,
    pan,
    isPanned,
    setZoom,
    setPan,
    zoomBy,
    handleWheel,
    handlePointerDown,
    handlePointerMove,
    clearPanCapture,
    markFocused,
  } = useImagePanAndZoom(tabId);
  const normalizedCustomBackground = normalizeHexColor(
    customBackground,
    '#ffffff',
  );
  const [imageError, setImageError] = useState(false);
  return (
    <div className="flex size-full flex-col bg-background">
      <FileTabToolbar
        actions={null}
        openExternalPath={getPreviewAbsolutePath(preview)}
        right={
          <>
            {isPanned ? (
              <div className="flex items-center px-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Center image"
                  onClick={() => setPan({ x: 0, y: 0 })}
                >
                  <IconArrowsToCenterOutline18 className="size-4" />
                </Button>
              </div>
            ) : null}
            <div className="flex items-center gap-0.5 px-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Zoom out"
                disabled={zoom <= 0.01}
                onClick={() => zoomBy(-0.25)}
              >
                <MinusIcon className="size-4" />
              </Button>
              <button
                type="button"
                className="min-w-10 text-center text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-solid focus-visible:ring-inset"
                onClick={() => setZoom(1)}
                aria-label="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Zoom in"
                onClick={() => zoomBy(0.25)}
              >
                <PlusIcon className="size-4" />
              </Button>
            </div>
            <div className="h-5 w-px bg-border-subtle" />
            <div className="flex items-center px-1">
              <Popover>
                <PopoverTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Image background config"
                  >
                    <IconColorPaletteOutline18 className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 gap-3 p-3">
                  <div className="font-medium text-foreground text-xs">
                    Colors
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="flex items-center gap-1 text-muted-foreground text-xs">
                      <IconTextBgColorOutline18 className="size-3" />
                      Background
                    </span>
                    <Select<ImagePreviewBackground>
                      items={[
                        { value: 'default', label: 'Default' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                        { value: 'checkerboard', label: 'Checkerboard' },
                        { value: 'custom', label: 'Custom' },
                      ]}
                      value={background}
                      onValueChange={(value) => setBackground(value)}
                      size="sm"
                    />
                    {background === 'custom' ? (
                      <div className="flex items-center rounded-md border border-surface-2 bg-surface-1 px-2">
                        <span className="font-mono text-muted-foreground text-sm">
                          #
                        </span>
                        <Input
                          className="border-0 bg-transparent px-1 font-mono focus:border-transparent"
                          size="xs"
                          type="text"
                          maxLength={6}
                          value={customBackground}
                          onValueChange={(value) =>
                            setCustomBackground(
                              String(value)
                                .replace(/[^0-9a-f]/gi, '')
                                .slice(0, 6),
                            )
                          }
                          placeholder="ffffff"
                        />
                      </div>
                    ) : null}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </>
        }
      />
      <div
        className={`flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden p-4 focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${getPreviewBackgroundClassName(background)}`}
        role="button"
        tabIndex={0}
        aria-label="Image preview canvas"
        data-image-preview-canvas="true"
        onFocus={markFocused}
        onClick={markFocused}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearPanCapture}
        onPointerCancel={clearPanCapture}
        onLostPointerCapture={clearPanCapture}
        style={
          background === 'custom'
            ? { backgroundColor: normalizedCustomBackground }
            : getCheckerboardStyle(background)
        }
      >
        {imageError ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <TriangleAlertIcon className="size-8" />
            <span className="text-sm">Unable to render this image.</span>
            <span className="text-xs">
              The file may be corrupt or in an unsupported format.
            </span>
          </div>
        ) : (
          <img
            src={blobUrl}
            alt={preview.relativePath}
            className="pointer-events-none max-h-none max-w-none object-contain"
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center',
            }}
            onError={() => setImageError(true)}
          />
        )}
      </div>
    </div>
  );
}

export function SvgPreview({
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
  const [mode, setMode] = useState<'preview' | 'source'>(
    () => markdownModeStore.get(cacheKey) ?? 'preview',
  );
  const [text, setText] = useState(
    () => textDraftCache.get(cacheKey) ?? preview.text ?? '',
  );
  const {
    fontSize: sourceFontSize,
    markFocused: markSourceFocused,
    updateZoom: updateSourceZoom,
    zoomPercentageRef: sourceZoomPercentageRef,
  } = useFileCodeZoom(tabId, mode === 'source');
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>(() =>
    languageFromPath(preview.relativePath),
  );
  const [background, setBackground] = useState<SvgPreviewBackground>('default');
  const storedCustomBg = useKartonState(
    (s) => s.preferences.general.svgCustomBackground,
  );
  const storedCustomFg = useKartonState(
    (s) => s.preferences.general.svgCustomForeground,
  );
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const customBackground = storedCustomBg ?? 'ffffff';
  const customCurrentColor = storedCustomFg ?? '8b5cf6';
  const setCustomBackground = useCallback(
    (value: string) => {
      void updatePreferences([
        {
          op: storedCustomBg === undefined ? 'add' : 'replace',
          path: ['general', 'svgCustomBackground'],
          value,
        },
      ]);
    },
    [storedCustomBg, updatePreferences],
  );
  const setCustomCurrentColor = useCallback(
    (value: string) => {
      void updatePreferences([
        {
          op: storedCustomFg === undefined ? 'add' : 'replace',
          path: ['general', 'svgCustomForeground'],
          value,
        },
      ]);
    },
    [storedCustomFg, updatePreferences],
  );
  const [currentColorMode, setCurrentColorMode] =
    useState<SvgCurrentColorMode>('default');
  const [imageError, setImageError] = useState(false);
  const [editor, setEditor] = useState<MonacoEditorInstance | null>(null);
  const cursorPosition = useSourceCursorPosition(editor);
  const actions = useEditorActions(tabId, editor, preview, text, setText);
  const previewBackgroundClassName = getPreviewBackgroundClassName(background);
  const normalizedCustomBackground = normalizeHexColor(
    customBackground,
    '#ffffff',
  );
  const normalizedCustomCurrentColor = normalizeHexColor(
    customCurrentColor,
    '#8b5cf6',
  );
  // When loaded via <img>, the SVG lives in an isolated document context.
  // currentColor resolves to the color property of the SVG element itself — it
  // does NOT inherit from the parent HTML <img>. We inject a :root { color }
  // rule into the SVG source so currentColor resolves correctly.
  const dataUrl = useMemo(() => {
    // CSS variables (var(--color-…)) do not resolve inside an <img>-loaded
    // SVG's isolated document, so we resolve them to hex via the HTML DOM.
    const color =
      currentColorMode === 'custom'
        ? normalizedCustomCurrentColor
        : resolveCssColor(
            background === 'dark'
              ? '--color-base-50'
              : background === 'light'
                ? '--color-base-900'
                : '--color-foreground',
          );
    const injected = text.replace(
      /<svg([^>]*)>/,
      `<svg$1><style>:root{color:${color}}</style>`,
    );
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(injected)}`;
  }, [text, currentColorMode, normalizedCustomCurrentColor, background]);

  // Reset image error when the SVG data URL changes.
  useEffect(() => {
    setImageError(false);
  }, [dataUrl]);

  // Cmd/Ctrl+Shift+V toggles code/preview mode when the tab is focused.
  const { tabUiState } = useTabUIState();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tabUiStateRef = useRef(tabUiState);
  tabUiStateRef.current = tabUiState;
  const persistMode = useCallback(
    (next: 'preview' | 'source') => {
      markdownModeStore.set(cacheKey, next);
      setMode(next);
    },
    [cacheKey],
  );

  const toggleCodeMode = useCallback(() => {
    if (tabUiStateRef.current[tabId]?.focusedPanel !== 'tab-content')
      return false;
    persistMode(modeRef.current === 'source' ? 'preview' : 'source');
  }, [tabId, persistMode]);
  useHotKeyListener(toggleCodeMode, HotkeyActions.TOGGLE_SVG_CODE_MODE);

  const handleMount = useCallback(
    (editor: MonacoEditorInstance, monaco: MonacoApi) => {
      setEditor(editor);
      registerMonacoThemeSync(monaco);
      editor.onDidFocusEditorWidget(markSourceFocused);
      registerMonacoZoomCommands(
        editor,
        monaco,
        markSourceFocused,
        updateSourceZoom,
        sourceZoomPercentageRef,
      );
    },
    [markSourceFocused, sourceZoomPercentageRef, updateSourceZoom],
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
      fontSize: sourceFontSize,
      lineHeight: sourceFontSize * 1.5,
    });
  }, [editor, sourceFontSize]);

  const {
    zoom,
    pan,
    isPanned,
    setZoom,
    setPan,
    zoomBy,
    handleWheel: handlePreviewWheel,
    handlePointerDown,
    handlePointerMove,
    clearPanCapture,
    markFocused,
  } = useImagePanAndZoom(tabId, mode === 'preview');

  // Hotkeys scoped to this SVG tab when it has focus.
  const bgRef = useRef(background);
  bgRef.current = background;
  const fgRef = useRef(currentColorMode);
  fgRef.current = currentColorMode;

  const handleCenterImage = useCallback(() => {
    if (tabUiStateRef.current[tabId]?.focusedPanel !== 'tab-content')
      return false;
    if (modeRef.current !== 'preview') return false;
    setPan({ x: 0, y: 0 });
  }, [tabId, setPan]);
  useHotKeyListener(handleCenterImage, HotkeyActions.CENTER_IMAGE);

  const handleCycleBg = useCallback(() => {
    if (tabUiStateRef.current[tabId]?.focusedPanel !== 'tab-content')
      return false;
    const options: SvgPreviewBackground[] = [
      'default',
      'light',
      'dark',
      'checkerboard',
      'custom',
    ];
    const idx = options.indexOf(bgRef.current);
    setBackground(options[(idx + 1) % options.length]!);
  }, [tabId]);
  useHotKeyListener(handleCycleBg, HotkeyActions.CYCLE_SVG_BG);

  const handleCycleFg = useCallback(() => {
    if (tabUiStateRef.current[tabId]?.focusedPanel !== 'tab-content')
      return false;
    const options: SvgCurrentColorMode[] = ['default', 'custom'];
    const idx = options.indexOf(fgRef.current);
    setCurrentColorMode(options[(idx + 1) % options.length]!);
  }, [tabId]);
  useHotKeyListener(handleCycleFg, HotkeyActions.CYCLE_SVG_FG);

  return (
    <div className="flex size-full flex-col bg-background">
      <FileTabToolbar
        actions={actions}
        openExternalPath={getPreviewAbsolutePath(preview)}
        onInteract={markSourceFocused}
        right={
          <>
            {mode === 'preview' && isPanned ? (
              <div className="flex items-center pr-2 pl-1">
                <ToolbarTooltip
                  label="Center image"
                  shortcut={HotkeyActions.CENTER_IMAGE}
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Center image"
                    onClick={() => setPan({ x: 0, y: 0 })}
                  >
                    <IconArrowsToCenterOutline18 className="size-4" />
                  </Button>
                </ToolbarTooltip>
              </div>
            ) : null}
            {mode === 'preview' ? (
              <div className="flex items-center gap-0.5 px-1">
                <ToolbarTooltip
                  label="Zoom out"
                  shortcut={HotkeyActions.ZOOM_OUT}
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Zoom out"
                    disabled={zoom <= 0.01}
                    onClick={() => zoomBy(-0.25)}
                  >
                    <MinusIcon className="size-4" />
                  </Button>
                </ToolbarTooltip>
                <ToolbarTooltip
                  label="Reset zoom"
                  shortcut={HotkeyActions.ZOOM_RESET}
                >
                  <button
                    type="button"
                    className="min-w-10 cursor-pointer text-center text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-solid focus-visible:ring-inset"
                    onClick={() => setZoom(1)}
                    aria-label="Reset zoom"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                </ToolbarTooltip>
                <ToolbarTooltip
                  label="Zoom in"
                  shortcut={HotkeyActions.ZOOM_IN}
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Zoom in"
                    onClick={() => zoomBy(0.25)}
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                </ToolbarTooltip>
              </div>
            ) : null}
            {mode === 'preview' ? (
              <>
                <div className="h-5 w-px bg-border-subtle" />
                <div className="flex items-center px-1">
                  <ToolbarTooltip label="Preview config">
                    <Popover>
                      <PopoverTrigger>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Preview config"
                        >
                          <IconColorPaletteOutline18 className="size-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 gap-3 p-3">
                        <div className="font-medium text-foreground text-xs">
                          Colors
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex flex-col gap-1.5">
                            <span className="flex items-center justify-between gap-1 text-muted-foreground text-xs">
                              <span className="flex items-center gap-1">
                                <IconTextBgColorOutline18 className="size-3" />
                                Background
                              </span>
                              <HotkeyCombo
                                action={HotkeyActions.CYCLE_SVG_BG}
                                size="xs"
                              />
                            </span>
                            <Select<SvgPreviewBackground>
                              items={[
                                { value: 'default', label: 'Default' },
                                { value: 'light', label: 'Light' },
                                { value: 'dark', label: 'Dark' },
                                {
                                  value: 'checkerboard',
                                  label: 'Checkerboard',
                                },
                                { value: 'custom', label: 'Custom' },
                              ]}
                              value={background}
                              onValueChange={(value) => setBackground(value)}
                              size="sm"
                            />
                            {background === 'custom' ? (
                              <div className="flex items-center rounded-md border border-surface-2 bg-surface-1 px-2">
                                <span className="font-mono text-muted-foreground text-sm">
                                  #
                                </span>
                                <Input
                                  className="border-0 bg-transparent px-1 font-mono focus:border-transparent"
                                  size="xs"
                                  type="text"
                                  maxLength={6}
                                  value={customBackground}
                                  onValueChange={(value) =>
                                    setCustomBackground(
                                      String(value)
                                        .replace(/[^0-9a-f]/gi, '')
                                        .slice(0, 6),
                                    )
                                  }
                                  placeholder="ffffff"
                                />
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <span className="flex items-center justify-between gap-1 text-muted-foreground text-xs">
                              <span className="flex items-center gap-1">
                                <IconTextColorOutline18 className="size-3" />
                                Foreground
                              </span>
                              <HotkeyCombo
                                action={HotkeyActions.CYCLE_SVG_FG}
                                size="xs"
                              />
                            </span>
                            <Select<SvgCurrentColorMode>
                              items={[
                                { value: 'default', label: 'Default' },
                                { value: 'custom', label: 'Custom' },
                              ]}
                              value={currentColorMode}
                              onValueChange={(value) =>
                                setCurrentColorMode(value)
                              }
                              size="sm"
                            />
                            {currentColorMode === 'custom' ? (
                              <div className="flex items-center rounded-md border border-surface-2 bg-surface-1 px-2">
                                <span className="font-mono text-muted-foreground text-sm">
                                  #
                                </span>
                                <Input
                                  className="border-0 bg-transparent px-1 font-mono focus:border-transparent"
                                  size="xs"
                                  type="text"
                                  maxLength={6}
                                  value={customCurrentColor}
                                  onValueChange={(value) =>
                                    setCustomCurrentColor(
                                      String(value)
                                        .replace(/[^0-9a-f]/gi, '')
                                        .slice(0, 6),
                                    )
                                  }
                                  placeholder="8b5cf6"
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </ToolbarTooltip>
                </div>
              </>
            ) : null}
            <div className="flex h-7 items-center gap-1 rounded-md bg-surface-1 p-0.5">
              <ToolbarTooltip
                label="Show SVG source"
                shortcut={HotkeyActions.TOGGLE_SVG_CODE_MODE}
              >
                <button
                  type="button"
                  className={cn(
                    'flex h-full cursor-pointer items-center gap-1 rounded px-2.5 text-muted-foreground text-xs transition-colors hover:text-foreground',
                    mode === 'source' &&
                      'bg-background text-foreground ring-1 ring-border-subtle',
                  )}
                  aria-label="Show SVG source"
                  aria-pressed={mode === 'source'}
                  onClick={() => persistMode('source')}
                >
                  <IconSquareCodeOutline18 className="size-3.5" />
                  {mode === 'source' ? <span>Code</span> : null}
                </button>
              </ToolbarTooltip>
              <ToolbarTooltip
                label="Show SVG preview"
                shortcut={HotkeyActions.TOGGLE_SVG_CODE_MODE}
              >
                <button
                  type="button"
                  className={cn(
                    'flex h-full cursor-pointer items-center gap-1 rounded px-2.5 text-muted-foreground text-xs transition-colors hover:text-foreground',
                    mode === 'preview' &&
                      'bg-background text-foreground ring-1 ring-border-subtle',
                  )}
                  aria-label="Show SVG preview"
                  aria-pressed={mode === 'preview'}
                  onClick={() => persistMode('preview')}
                >
                  <IconEye2Outline18 className="size-3.5" />
                  {mode === 'preview' ? <span>Preview</span> : null}
                </button>
              </ToolbarTooltip>
            </div>
          </>
        }
      />
      {actions.externalChange ? (
        <ExternalChangeBanner actions={actions} />
      ) : null}
      <div className="min-h-0 flex-1">
        {mode === 'preview' ? (
          <button
            type="button"
            className={`flex size-full touch-none select-none items-center justify-center overflow-hidden p-4 text-left focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${previewBackgroundClassName}`}
            aria-label="SVG preview canvas"
            data-image-preview-canvas="true"
            onFocus={markFocused}
            onClick={markFocused}
            onWheel={handlePreviewWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={clearPanCapture}
            onPointerCancel={clearPanCapture}
            onLostPointerCapture={clearPanCapture}
            style={
              background === 'custom'
                ? { backgroundColor: normalizedCustomBackground }
                : getCheckerboardStyle(background)
            }
          >
            {imageError ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <TriangleAlertIcon className="size-8" />
                <span className="text-sm">Unable to render this SVG.</span>
                <span className="text-xs">
                  The file may be malformed or contain unsupported content.
                </span>
              </div>
            ) : (
              <img
                src={dataUrl}
                alt={preview.relativePath}
                className="pointer-events-none max-h-none max-w-none object-contain"
                draggable={false}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'center',
                }}
                onError={() => setImageError(true)}
              />
            )}
          </button>
        ) : (
          <div
            className="size-full"
            onFocusCapture={markSourceFocused}
            onPointerDownCapture={markSourceFocused}
          >
            <MonacoEditor
              height="100%"
              language={
                sourceLanguage === 'plaintext' ? undefined : sourceLanguage
              }
              path={`${preview.workspaceKey}/${preview.relativePath}`}
              value={text}
              theme={MONACO_THEME_NAME}
              beforeMount={configureMonacoTheme}
              onMount={handleMount}
              onChange={handleChange}
              options={{
                ...MONACO_SHARED_OPTIONS,
                readOnly: preview.readOnly ?? false,
                fontSize: sourceFontSize,
                lineHeight: sourceFontSize * 1.5,
              }}
            />
          </div>
        )}
      </div>
      {mode === 'source' ? (
        <FileEditorStatusBar
          lineNumber={cursorPosition.lineNumber}
          column={cursorPosition.column}
          language={sourceLanguage}
          onLanguageChange={setSourceLanguage}
        />
      ) : null}
    </div>
  );
}

export function MarkdownPreview({
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
  const [mode, setMode] = useState<'preview' | 'source'>(
    () => markdownModeStore.get(cacheKey) ?? 'preview',
  );
  const [text, setText] = useState(
    () => textDraftCache.get(cacheKey) ?? preview.text ?? '',
  );
  const { fontSize, markFocused, updateZoom, zoomPercentageRef } =
    useFileCodeZoom(tabId, mode === 'source');
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>(() =>
    languageFromPath(preview.relativePath),
  );
  const [editor, setEditor] = useState<MonacoEditorInstance | null>(null);
  const cursorPosition = useSourceCursorPosition(editor);
  const actions = useEditorActions(tabId, editor, preview, text, setText);

  // Cmd/Ctrl+Shift+V toggles code/preview mode when the tab is focused.
  const { tabUiState } = useTabUIState();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tabUiStateRef = useRef(tabUiState);
  tabUiStateRef.current = tabUiState;
  const persistMode = useCallback(
    (next: 'preview' | 'source') => {
      markdownModeStore.set(cacheKey, next);
      setMode(next);
    },
    [cacheKey],
  );

  const toggleCodeMode = useCallback(() => {
    if (tabUiStateRef.current[tabId]?.focusedPanel !== 'tab-content')
      return false;
    persistMode(modeRef.current === 'source' ? 'preview' : 'source');
  }, [tabId, persistMode]);
  useHotKeyListener(toggleCodeMode, HotkeyActions.TOGGLE_MARKDOWN_PREVIEW);

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
        right={
          <div className="flex h-7 items-center gap-1 rounded-md bg-surface-1 p-0.5">
            <ToolbarTooltip
              label="Show markdown source"
              shortcut={HotkeyActions.TOGGLE_MARKDOWN_PREVIEW}
            >
              <button
                type="button"
                className={cn(
                  'flex h-full cursor-pointer items-center gap-1 rounded px-2.5 text-muted-foreground text-xs transition-colors hover:text-foreground',
                  mode === 'source' &&
                    'bg-background text-foreground ring-1 ring-border-subtle',
                )}
                aria-label="Show markdown source"
                aria-pressed={mode === 'source'}
                onClick={() => persistMode('source')}
              >
                <IconSquareCodeOutline18 className="size-3.5" />
                {mode === 'source' ? <span>Code</span> : null}
              </button>
            </ToolbarTooltip>
            <ToolbarTooltip
              label="Show markdown preview"
              shortcut={HotkeyActions.TOGGLE_MARKDOWN_PREVIEW}
            >
              <button
                type="button"
                className={cn(
                  'flex h-full cursor-pointer items-center gap-1 rounded px-2.5 text-muted-foreground text-xs transition-colors hover:text-foreground',
                  mode === 'preview' &&
                    'bg-background text-foreground ring-1 ring-border-subtle',
                )}
                aria-label="Show markdown preview"
                aria-pressed={mode === 'preview'}
                onClick={() => persistMode('preview')}
              >
                <IconEye2Outline18 className="size-3.5" />
                {mode === 'preview' ? <span>Preview</span> : null}
              </button>
            </ToolbarTooltip>
          </div>
        }
      />
      {actions.externalChange ? (
        <ExternalChangeBanner actions={actions} />
      ) : null}
      <div className="min-h-0 flex-1">
        {mode === 'preview' ? (
          <div className="[&_[data-streamdown=image-wrapper]]:!items-start scrollbar-subtle size-full overflow-auto p-6 text-foreground [&_[data-streamdown=image-wrapper]>div:first-child]:hidden">
            <Streamdown isAnimating={false}>{text}</Streamdown>
          </div>
        ) : (
          <div
            className="size-full"
            onFocusCapture={markFocused}
            onPointerDownCapture={markFocused}
          >
            <MonacoEditor
              height="100%"
              language={
                sourceLanguage === 'plaintext' ? undefined : sourceLanguage
              }
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
        )}
      </div>
      {mode === 'source' ? (
        <FileEditorStatusBar
          lineNumber={cursorPosition.lineNumber}
          column={cursorPosition.column}
          language={sourceLanguage}
          onLanguageChange={setSourceLanguage}
        />
      ) : null}
    </div>
  );
}

export function BinaryPreview({
  workspaceKey,
  relativePath,
  revealInFolder,
}: {
  workspaceKey: string;
  relativePath: string;
  revealInFolder: (workspaceKey: string, relativePath: string) => void;
}) {
  return (
    <div className="flex size-full flex-col bg-background">
      <FileTabToolbar actions={null} />
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-6 text-muted-foreground">
          <span className="font-normal text-muted-foreground text-sm">
            Can't display this file inside clodex
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => revealInFolder(workspaceKey, relativePath)}
          >
            Reveal in {nativeFileManagerLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// A file backing a tab may no longer exist on disk — e.g. the workspace was
// unmounted and the file was deleted externally, or an agent (and its
// attachment blobs) was removed. Detect that case so the tab can show a
// friendly "file removed" notice instead of a raw filesystem error string.
export function isMissingFileError(error: string | null): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes('enoent') ||
    normalized.includes('no such file') ||
    normalized.includes('not a file') ||
    normalized.includes('escapes workspace root')
  );
}

export function MissingFileNotice() {
  return (
    <div className="flex size-full flex-col bg-background">
      <FileTabToolbar actions={null} />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center text-muted-foreground">
          <IconDatabaseFillDuo18 className="size-12" />
          <span className="font-medium text-foreground text-sm">
            This file is no longer available
          </span>
          <span className="text-xs">
            It may have been deleted, moved, or removed together with the agent
            it belonged to. The contents can no longer be loaded.
          </span>
        </div>
      </div>
    </div>
  );
}

export function getPreviewBackgroundClassName(
  background: SvgPreviewBackground,
) {
  return background === 'light'
    ? 'bg-base-50'
    : background === 'dark'
      ? 'bg-base-900'
      : 'bg-background';
}

export function getCheckerboardStyle(background: SvgPreviewBackground) {
  return background === 'checkerboard'
    ? {
        backgroundColor: 'var(--color-background)',
        backgroundImage:
          'linear-gradient(45deg, var(--color-surface-1) 25%, transparent 25%), linear-gradient(-45deg, var(--color-surface-1) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-surface-1) 75%), linear-gradient(-45deg, transparent 75%, var(--color-surface-1) 75%)',
        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        backgroundSize: '16px 16px',
      }
    : undefined;
}

export function useImagePanAndZoom(tabId: string, enabled = true) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const { tabUiState, setTabUiState } = useTabUIState();
  const isTabContentFocused = tabUiState[tabId]?.focusedPanel === 'tab-content';
  const panStateRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  }>({ pointerId: null, startX: 0, startY: 0, originX: 0, originY: 0 });

  const markFocused = useCallback(() => {
    setTabUiState(tabId, { focusedPanel: 'tab-content' });
  }, [setTabUiState, tabId]);

  const zoomBy = useCallback((delta: number) => {
    setZoom((value) => Math.max(0.01, value + delta));
  }, []);

  const handleZoomIn = useCallback(() => {
    if (!isTabContentFocused) return false;
    zoomBy(0.25);
  }, [isTabContentFocused, zoomBy]);

  const handleZoomOut = useCallback(() => {
    if (!isTabContentFocused) return false;
    zoomBy(-0.25);
  }, [isTabContentFocused, zoomBy]);

  const handleZoomReset = useCallback(() => {
    if (!isTabContentFocused) return false;
    setZoom(1);
  }, [isTabContentFocused]);

  useHotKeyListener(handleZoomIn, HotkeyActions.ZOOM_IN, enabled);
  useHotKeyListener(handleZoomOut, HotkeyActions.ZOOM_OUT, enabled);
  useHotKeyListener(handleZoomReset, HotkeyActions.ZOOM_RESET, enabled);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0035);
    setZoom((value) => Math.max(0.01, value * factor));
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      markFocused();
      (event.currentTarget as HTMLElement).focus({ preventScroll: true });
      panStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [markFocused, pan.x, pan.y],
  );

  const clearPanCapture = useCallback((event: React.PointerEvent) => {
    if (panStateRef.current.pointerId !== event.pointerId) return;
    panStateRef.current.pointerId = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const state = panStateRef.current;
    if (state.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      panStateRef.current.pointerId = null;
      return;
    }
    setPan({
      x: state.originX + event.clientX - state.startX,
      y: state.originY + event.clientY - state.startY,
    });
  }, []);

  return {
    zoom,
    pan,
    isPanned: pan.x !== 0 || pan.y !== 0,
    setZoom,
    setPan,
    zoomBy,
    handleWheel,
    handlePointerDown,
    handlePointerMove,
    clearPanCapture,
    markFocused,
  };
}
