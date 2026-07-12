import type { FilePreviewEntry, PreviewComponent } from './types';
import { buildMimeLookup } from './mime-lookup';
import { inferMimeType } from '@shared/mime-utils';
import { imagePreview } from './previews/image';
import { videoPreview } from './previews/video';
import { audioPreview } from './previews/audio';
import { pdfPreview } from './previews/pdf';
import { fontPreview } from './previews/font';
import { fallbackPreview } from './previews/fallback';

export type {
  FilePreviewProps,
  FilePreviewEntry,
  PreviewComponent,
} from './types';
export { buildMimeLookup } from './mime-lookup';

const entries: FilePreviewEntry[] = [
  pdfPreview,
  imagePreview,
  videoPreview,
  audioPreview,
  fontPreview,
  fallbackPreview,
];

export const getFilePreview = buildMimeLookup(entries, fallbackPreview);

/**
 * Resolve a preview entry for a file by name.
 * Tries MIME-based lookup first, then falls back to extension matching.
 */
export function getFilePreviewForFile(fileName: string): FilePreviewEntry {
  const mime = inferMimeType(fileName);
  const byMime = getFilePreview(mime);
  if (byMime !== fallbackPreview) return byMime;

  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  for (const entry of entries)
    if (entry.extensionPatterns?.includes(ext)) return entry;

  return fallbackPreview;
}

/**
 * Resolve a variant component from an entry, falling back to `compact`
 * when the requested variant doesn't exist.
 */
export function getPreviewVariant(
  entry: FilePreviewEntry,
  variant: string,
): PreviewComponent {
  return entry.variants[variant] ?? entry.variants.compact;
}
