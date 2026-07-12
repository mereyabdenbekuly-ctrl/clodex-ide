/**
 * Build a mime-type lookup function from an array of entries.
 *
 * Resolution order: exact match -> longest prefix match -> wildcard
 * (e.g. "image/") -> fallback.
 */
export function buildMimeLookup<T extends { mimePatterns: string[] }>(
  entries: T[],
  fallback: T,
): (mediaType: string) => T {
  const exactMap = new Map<string, T>();
  const prefixList: Array<{ prefix: string; entry: T }> = [];
  const wildcardMap = new Map<string, T>();
  let resolvedFallback = fallback;

  for (const entry of entries) {
    for (const pattern of entry.mimePatterns) {
      if (pattern === '*/*') {
        resolvedFallback = entry;
      } else if (pattern.endsWith('/*')) {
        wildcardMap.set(pattern.slice(0, -1), entry);
      } else if (pattern.endsWith('*')) {
        prefixList.push({ prefix: pattern.slice(0, -1), entry });
      } else {
        exactMap.set(pattern, entry);
      }
    }
  }

  prefixList.sort((a, b) => b.prefix.length - a.prefix.length);

  return (mediaType: string): T => {
    const mime = mediaType.toLowerCase();

    const exact = exactMap.get(mime);
    if (exact) return exact;

    for (const { prefix, entry } of prefixList) {
      if (mime.startsWith(prefix)) return entry;
    }

    const slashIdx = mime.indexOf('/');
    if (slashIdx > 0) {
      const typePrefix = `${mime.slice(0, slashIdx)}/`;
      const wc = wildcardMap.get(typePrefix);
      if (wc) return wc;
    }

    return resolvedFallback;
  };
}
