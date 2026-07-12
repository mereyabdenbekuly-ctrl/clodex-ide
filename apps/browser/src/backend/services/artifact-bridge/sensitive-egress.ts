import type { ArtifactBridgeSensitiveEgressReason } from '@shared/artifact-bridge';

const SENSITIVE_KEY =
  /(?:^|[-_.])(authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|private[-_]?key|client[-_]?secret)(?:$|[-_.])/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gi,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/gi,
  /\bxox[a-z]-[A-Za-z0-9-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[-_]?key|authorization|client[-_]?secret|password|token)\s*[:=]\s*["']?[^\s,"'}]{8,}/gi,
] as const;

export type SensitiveMcpDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export function classifySensitiveMcpOperation(input: {
  transportType: string | undefined;
  serverId: string;
  descriptor: SensitiveMcpDescriptor;
  arguments: Record<string, unknown>;
}): ArtifactBridgeSensitiveEgressReason[] {
  const reasons = new Set<ArtifactBridgeSensitiveEgressReason>();
  if (
    input.transportType === 'streamable-http' ||
    input.transportType === 'sse'
  ) {
    reasons.add('remote-network');
  }
  if (
    hasSensitiveIdentifier(input.serverId) ||
    hasSensitiveIdentifier(input.descriptor.name) ||
    containsSensitiveSchema(input.descriptor.inputSchema) ||
    containsSensitiveArguments(input.arguments) ||
    (input.descriptor.description
      ? /\b(credentials?|secrets?|access tokens?|api keys?|passwords?|oauth)\b/i.test(
          input.descriptor.description,
        )
      : false)
  ) {
    reasons.add('credential-sensitive');
  }
  return [...reasons];
}

export function assertNoRawSecrets(value: unknown): void {
  if (containsSensitiveArguments(value)) {
    throw new Error(
      'Raw credentials are not allowed in generated app MCP arguments',
    );
  }
}

export function sanitizeSensitiveValue(
  value: unknown,
  key = '',
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (hasSensitiveIdentifier(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (depth > 30) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return value.map((item) =>
      sanitizeSensitiveValue(item, '', depth + 1, seen),
    );
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizeSensitiveValue(nestedValue, nestedKey, depth + 1, seen),
        ],
      ),
    );
  }
  return value;
}

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

function hasSensitiveIdentifier(value: string): boolean {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  if (
    /(?:^|[-_.])token[-_.](?:count|usage|limit|budget|type|name|id)(?:$|[-_.])/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return SENSITIVE_KEY.test(normalized);
}

function containsSensitiveArguments(
  value: unknown,
  key = '',
  depth = 0,
): boolean {
  if (depth > 20) return true;
  if (hasSensitiveIdentifier(key)) return true;
  if (typeof value === 'string') return containsRawSecretText(value);
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsSensitiveArguments(item, '', depth + 1),
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([nestedKey, nestedValue]) =>
        containsSensitiveArguments(nestedValue, nestedKey, depth + 1),
    );
  }
  return false;
}

function containsSensitiveSchema(value: unknown, depth = 0): boolean {
  if (depth > 20 || !value) return false;
  if (typeof value === 'string') return hasSensitiveIdentifier(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveSchema(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nestedValue]) =>
        hasSensitiveIdentifier(key) ||
        containsSensitiveSchema(nestedValue, depth + 1),
    );
  }
  return false;
}

function containsRawSecretText(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
