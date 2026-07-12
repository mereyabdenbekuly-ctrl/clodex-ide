/** Detect if a file is an image based on its extension */
export function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  const imageExts = [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'ico',
    'bmp',
    'avif',
  ];
  return imageExts.includes(ext ?? '');
}

/** Detect if a file is a font based on its extension */
export function isFontFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  const fontExts = ['ttf', 'otf', 'woff', 'woff2', 'eot'];
  return fontExts.includes(ext ?? '');
}

/** Infer image MIME type from file path extension */
export function inferImageMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    avif: 'image/avif',
  };
  return mimeMap[ext ?? ''] ?? 'application/octet-stream';
}

/** Infer font MIME type from file path extension */
export function inferFontMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject',
  };
  return mimeMap[ext ?? ''] ?? 'font/ttf';
}
