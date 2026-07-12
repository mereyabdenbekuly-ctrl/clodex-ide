const SEPARATOR_RE = /[/\\]/;

/**
 * Replace every backslash with a forward slash.
 * Drive letters (e.g. `C:\`) are preserved as `C:/`.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Return the last path segment (file or folder name).
 * Works with both `/` and `\` separators.
 * Returns the full input when no separator is present.
 */
export function getBaseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  if (!trimmed) return p;
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 1);
}

/**
 * Return everything before the last path separator.
 * Returns an empty string when the path has no parent.
 */
export function getParentPath(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx === -1) return '';
  return p.slice(0, idx);
}

/**
 * Split a path into its non-empty segments.
 * Handles both `/` and `\` separators (and mixtures).
 */
export function splitSegments(p: string): string[] {
  return p.split(SEPARATOR_RE).filter(Boolean);
}
