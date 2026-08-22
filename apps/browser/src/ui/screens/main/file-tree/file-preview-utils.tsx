import type { FilePreviewResult, TabState } from '@shared/karton-contracts/ui';
import type * as Monaco from 'monaco-editor';

import { FileIcon } from '@ui/components/file-icon';

export type MonacoApi = typeof Monaco;
export type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor;

export type FilePreviewTabContentProps = {
  tab: TabState;
};

export type CachedPreview = {
  preview: FilePreviewResult | null;
  error: string | null;
};

/** Persists Monaco scroll position across tab switches. */
export const scrollStateStore = new Map<
  string,
  { scrollTop: number; scrollLeft: number }
>();

/** Persists markdown preview/source mode across tab switches. */
export const markdownModeStore = new Map<string, 'preview' | 'source'>();

/** Persists diff editor mode (inline/split) across tab switches. */
export const diffModeStore = new Map<string, 'inline' | 'split'>();

export type ImagePreviewBackground = SvgPreviewBackground;

export type SvgPreviewBackground =
  | 'default'
  | 'light'
  | 'dark'
  | 'checkerboard'
  | 'custom';

export type SvgCurrentColorMode = 'default' | 'custom';

export function normalizeHexColor(value: string, fallback: string) {
  const hex = value.trim();
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('')}`;
  }
  return fallback;
}

export type SourceLanguage =
  | 'plaintext'
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'css'
  | 'scss'
  | 'html'
  | 'markdown'
  | 'xml'
  | 'yaml'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'php'
  | 'ruby'
  | 'sql';

/** File extension representative of each language, for seti-icons lookup. */
export const LANGUAGE_EXT: Record<SourceLanguage, string> = {
  plaintext: '.txt',
  typescript: '.ts',
  javascript: '.js',
  json: '.json',
  css: '.css',
  scss: '.scss',
  html: '.html',
  markdown: '.md',
  xml: '.svg',
  yaml: '.yml',
  python: '.py',
  go: '.go',
  rust: '.rs',
  java: '.java',
  php: '.php',
  ruby: '.rb',
  sql: '.sql',
};

export function iconForLanguage(language: SourceLanguage): React.ReactNode {
  return <FileIcon filePath={`file${LANGUAGE_EXT[language]}`} />;
}

export const SOURCE_LANGUAGE_ITEMS: Array<{
  value: SourceLanguage;
  label: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'plaintext',
    label: 'Plain text',
    icon: iconForLanguage('plaintext'),
  },
  {
    value: 'typescript',
    label: 'TypeScript',
    icon: iconForLanguage('typescript'),
  },
  {
    value: 'javascript',
    label: 'JavaScript',
    icon: iconForLanguage('javascript'),
  },
  { value: 'json', label: 'JSON', icon: iconForLanguage('json') },
  { value: 'css', label: 'CSS', icon: iconForLanguage('css') },
  { value: 'scss', label: 'SCSS', icon: iconForLanguage('scss') },
  { value: 'html', label: 'HTML', icon: iconForLanguage('html') },
  { value: 'markdown', label: 'Markdown', icon: iconForLanguage('markdown') },
  { value: 'xml', label: 'XML / SVG', icon: iconForLanguage('xml') },
  { value: 'yaml', label: 'YAML', icon: iconForLanguage('yaml') },
  { value: 'python', label: 'Python', icon: iconForLanguage('python') },
  { value: 'go', label: 'Go', icon: iconForLanguage('go') },
  { value: 'rust', label: 'Rust', icon: iconForLanguage('rust') },
  { value: 'java', label: 'Java', icon: iconForLanguage('java') },
  { value: 'php', label: 'PHP', icon: iconForLanguage('php') },
  { value: 'ruby', label: 'Ruby', icon: iconForLanguage('ruby') },
  { value: 'sql', label: 'SQL', icon: iconForLanguage('sql') },
];

export const previewCache = new Map<string, CachedPreview>();
export const previewRequests = new Map<
  string,
  Promise<FilePreviewResult | null>
>();
export const textDraftCache = new Map<string, string>();
// Unsaved modified-side edits for diff tabs, keyed by tab id (stable across
// unmount/remount within a session). Lets the editable diff editor restore a
// user's in-progress edits when its tab is hidden and shown again, mirroring
// the plain editor's `textDraftCache`.
export const diffDraftCache = new Map<string, string>();
export function getPreviewCacheKey(workspaceKey: string, relativePath: string) {
  return `${workspaceKey}:${relativePath}`;
}

export function languageFromPath(path: string): SourceLanguage {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'php':
      return 'php';
    case 'rb':
      return 'ruby';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

export function isMarkdownPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'mdx';
}

export function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

export function linearSrgbToSrgb(value: number): number {
  if (value <= 0.0031308) return 12.92 * value;
  return 1.055 * value ** (1 / 2.4) - 0.055;
}

export function oklchToHex(
  lightness: number,
  chroma: number,
  hue: number,
): string {
  const h = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);

  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = linearSrgbToSrgb(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
  );
  const g = linearSrgbToSrgb(
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
  );
  const blue = linearSrgbToSrgb(
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  );

  return `#${toHexChannel(r * 255)}${toHexChannel(g * 255)}${toHexChannel(
    blue * 255,
  )}`;
}

export function cssColorToHex(color: string, fallback = '#ffffff'): string {
  const normalized = color.trim();
  if (!normalized || normalized === 'none') return fallback;
  if (normalized.startsWith('#')) return normalized;

  const rgbMatch = normalized.match(
    /rgba?\(\s*([\d.]+%?)\s*(?:,|\s)\s*([\d.]+%?)\s*(?:,|\s)\s*([\d.]+%?)(?:\s*(?:,|\/)\s*([\d.]+%?))?\s*\)/,
  );
  if (rgbMatch) {
    const [, r = '255', g = '255', b = '255', alpha] = rgbMatch;
    const channel = (value: string) =>
      value.endsWith('%')
        ? (Number.parseFloat(value) / 100) * 255
        : Number(value);
    const alphaHex = alpha
      ? toHexChannel(
          (alpha.endsWith('%')
            ? Number.parseFloat(alpha) / 100
            : Number(alpha)) * 255,
        )
      : '';
    return `#${toHexChannel(channel(r))}${toHexChannel(channel(g))}${toHexChannel(
      channel(b),
    )}${alphaHex}`;
  }

  const oklchMatch = normalized.match(
    /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+%?)?\s*\)/,
  );
  if (oklchMatch) {
    const [, l = '1', c = '0', h = '0'] = oklchMatch;
    const lightness = l.endsWith('%') ? Number.parseFloat(l) / 100 : Number(l);
    return oklchToHex(lightness, Number(c), Number(h));
  }

  return fallback;
}

export function resolveCssColor(
  cssVariable: string,
  fallback = '#ffffff',
): string {
  const rootStyles = getComputedStyle(document.documentElement);
  const rawValue = rootStyles.getPropertyValue(cssVariable).trim();
  if (rawValue === 'none') return fallback;

  const probe = document.createElement('span');
  probe.style.color = `var(${cssVariable})`;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return cssColorToHex(color, fallback);
}
