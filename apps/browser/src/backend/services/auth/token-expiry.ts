export function parseIdeTokenExpiresAt(
  value: string,
  nowMs = Date.now(),
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    // Clodex may return either an absolute Unix timestamp or a relative TTL.
    // Values below 2001-09-09 cannot be realistic token expiry timestamps for
    // this app, so treat them as seconds-from-now (e.g. 3600).
    if (numeric < 1_000_000_000) return nowMs + numeric * 1000;
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeIdeTokenExpiresAt(
  value: string | undefined,
  nowMs = Date.now(),
): string | undefined {
  if (!value) return undefined;
  const parsed = parseIdeTokenExpiresAt(value, nowMs);
  return parsed == null ? value : new Date(parsed).toISOString();
}
