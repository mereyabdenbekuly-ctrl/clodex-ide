const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  /\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}(?=$|[\s,;'"&])/gi,
  /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|authorization)\b\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9._~+/-]{8,}={0,2}["']?(?=$|[\s,;'"&])/gi,
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|credential|authorization|api[-_]?key|private[-_]?key)/i;

export function redactSensitiveText(
  value: string,
  options?: { redactEmails?: boolean },
): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  if (options?.redactEmails) {
    redacted = redacted.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
  }
  return redacted;
}

export function sanitizeDebugValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDebugValue(entry, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeDebugValue(entry, seen);
  }
  return sanitized;
}

export function sanitizeDebugPayload(
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  return sanitizeDebugValue(payload) as Record<string, unknown>;
}
