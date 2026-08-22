import type * as Monaco from 'monaco-editor';
import {
  type MonacoApi,
  type MonacoEditorInstance,
  resolveCssColor,
} from './file-preview-utils';

export const MONACO_THEME_NAME = 'clodex-file-preview';
export function configureMonacoTheme(monaco: MonacoApi) {
  configureMonacoTypeScript(monaco);
  const color = (name: string, fallback?: string) =>
    resolveCssColor(name, fallback);
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  const foreground = color('--color-foreground');
  const mutedForeground = color('--color-muted-foreground');
  const background = color('--color-background');
  const surface = color('--color-surface-1');
  const border = color('--color-border');
  const keyword = color('--syntax-keyword', foreground);
  const keywordControl = color('--syntax-keyword-control', foreground);
  const string = color('--syntax-string', foreground);
  const number = color('--syntax-number', foreground);
  const type = color('--syntax-type', foreground);
  const property = color('--syntax-property', foreground);
  const functionColor = color('--syntax-function', foreground);
  const constant = color('--syntax-constant', foreground);
  const tag = color('--syntax-tag', foreground);
  const regexp = color('--syntax-regexp', foreground);
  const cssProperty = color('--syntax-css-property', foreground);
  const cssValue = color('--syntax-css-value', foreground);
  const jsonProperty = color('--syntax-json-property', foreground);

  monaco.editor.defineTheme(MONACO_THEME_NAME, {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: foreground.slice(1) },
      {
        token: 'comment',
        foreground: mutedForeground.slice(1),
        fontStyle: 'italic',
      },
      { token: 'keyword', foreground: keyword.slice(1) },
      { token: 'keyword.control', foreground: keywordControl.slice(1) },
      { token: 'string', foreground: string.slice(1) },
      { token: 'number', foreground: number.slice(1) },
      { token: 'regexp', foreground: regexp.slice(1) },
      { token: 'type', foreground: type.slice(1) },
      { token: 'type.identifier', foreground: type.slice(1) },
      { token: 'identifier', foreground: foreground.slice(1) },
      { token: 'function', foreground: functionColor.slice(1) },
      { token: 'variable', foreground: foreground.slice(1) },
      { token: 'variable.predefined', foreground: constant.slice(1) },
      { token: 'constant', foreground: constant.slice(1) },
      { token: 'delimiter', foreground: foreground.slice(1) },
      { token: 'tag', foreground: tag.slice(1) },
      {
        token: 'attribute.name',
        foreground: property.slice(1),
        fontStyle: 'italic',
      },
      { token: 'attribute.value', foreground: string.slice(1) },
      { token: 'property', foreground: property.slice(1) },
      { token: 'key', foreground: jsonProperty.slice(1) },
      { token: 'string.key.json', foreground: jsonProperty.slice(1) },
      { token: 'attribute.name.css', foreground: cssProperty.slice(1) },
      { token: 'attribute.value.css', foreground: cssValue.slice(1) },
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorLineNumber.foreground': mutedForeground,
      'editorLineNumber.activeForeground': foreground,
      'editor.selectionBackground': `${color('--color-primary-solid')}55`,
      'editor.inactiveSelectionBackground': `${surface}99`,
      'editor.lineHighlightBackground': surface,
      'editorCursor.foreground': foreground,
      'editorWhitespace.foreground': border,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': mutedForeground,
      'scrollbarSlider.background': `${foreground}22`,
      'scrollbarSlider.hoverBackground': `${foreground}33`,
      'scrollbarSlider.activeBackground': `${foreground}44`,
    },
  });
}

// Re-apply the Monaco theme whenever the OS color scheme flips. The theme is
// derived from CSS variables that switch via `prefers-color-scheme`, but Monaco
// caches the resolved theme, so without this it stays stale until the editor
// remounts. Registered once globally; the `change` event only fires on an
// actual scheme change, so this adds no steady-state cost.
export let monacoThemeSyncRegistered = false;
export function registerMonacoThemeSync(monaco: MonacoApi) {
  if (monacoThemeSyncRegistered) return;
  monacoThemeSyncRegistered = true;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => {
    configureMonacoTheme(monaco);
    monaco.editor.setTheme(MONACO_THEME_NAME);
  });
}

// Monaco's built-in TypeScript worker runs an embedded language service that
// has no access to the project's tsconfig.json, node_modules, or path aliases.
// This causes spurious errors (red squigglies) on valid code. The real LSP
// runs on the backend (LspService); the frontend editor is a viewer, not an
// IDE, so we disable Monaco's inline diagnostics entirely.
export let monacoTSDiagnosticsDisabled = false;
export function configureMonacoTypeScript(monaco: MonacoApi) {
  if (monacoTSDiagnosticsDisabled) return;
  monacoTSDiagnosticsDisabled = true;
  const noValidation = { noSemanticValidation: true, noSyntaxValidation: true };
  // monaco.languages.typescript is deprecated at the type level in Monaco
  // 0.55 (the declarations are stubbed), but the runtime API still exists.
  // We use a cast because importing from 'monaco-editor' directly would
  // bundle it eagerly instead of loading it dynamically via the wrapper.
  const ts = monaco.languages.typescript as unknown as {
    typescriptDefaults: {
      setDiagnosticsOptions(opts: Record<string, boolean>): void;
    };
    javascriptDefaults: {
      setDiagnosticsOptions(opts: Record<string, boolean>): void;
    };
  };
  ts.typescriptDefaults.setDiagnosticsOptions(noValidation);
  ts.javascriptDefaults.setDiagnosticsOptions(noValidation);
}

// Shared Monaco editor options used by both TextEditorPreview and SvgPreview
// source mode. fontSize, lineHeight, and readOnly are applied per-instance.
export const MONACO_SOURCE_FONT_FAMILY =
  "'Roboto Mono', Menlo, Monaco, clodex-builtin-roboto-mono, 'Noto Sans Mono', ui-monospace, 'SF Mono', 'Segoe UI Mono', 'Ubuntu Mono', 'Noto Mono', 'Liberation Mono', 'Inter Mono', Consolas, monospace";

export const MONACO_SHARED_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions =
  {
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    automaticLayout: true,
    renderLineHighlight: 'line',
    scrollbar: {
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
    },
    fontFamily: MONACO_SOURCE_FONT_FAMILY,
  };

/** Register Ctrl+/Ctrl-/Ctrl+0 zoom commands on a Monaco editor instance. */
export function registerMonacoZoomCommands(
  editor: MonacoEditorInstance,
  monaco: MonacoApi,
  markFocused: () => void,
  updateZoom: (next: number) => void,
  zoomPercentageRef: React.MutableRefObject<number>,
) {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () => {
    markFocused();
    updateZoom(zoomPercentageRef.current + 10);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () => {
    markFocused();
    updateZoom(zoomPercentageRef.current - 10);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0, () => {
    markFocused();
    updateZoom(100);
  });
}

/** Track the Monaco editor cursor position for the status bar. */
