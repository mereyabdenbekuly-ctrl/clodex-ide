/**
 * Anonymous URL classification for telemetry. Returns coarse booleans
 * (`isLocal`, `isHttps`) without exposing the host or path, so events can
 * be segmented (e.g. prod-domain vs local-dev devtools usage) without
 * leaking PII. Malformed URLs and non-http(s) schemes (about:, file:,
 * internal://) all resolve to `{ isLocal: false, isHttps: false }`.
 */
export function classifyTabUrl(url: string): {
  isLocal: boolean;
  isHttps: boolean;
} {
  if (!url) return { isLocal: false, isHttps: false };
  try {
    const parsed = new URL(url);
    const isLocal =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    const isHttps = parsed.protocol === 'https:';
    return { isLocal, isHttps };
  } catch {
    return { isLocal: false, isHttps: false };
  }
}
