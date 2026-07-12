export const PROVIDER_ERROR_CODES = [
  'AUTHENTICATION_FAILED',
  'PAYMENT_REQUIRED',
  'RATE_LIMITED',
  'MODEL_NOT_FOUND',
  'CONTEXT_LIMIT',
  'UNSUPPORTED_FEATURE',
  'PROVIDER_UNAVAILABLE',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
}

type ErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  response?: {
    status?: unknown;
    headers?: unknown;
  };
};

const SECRET_PATTERN =
  /(api[-_ ]?key|authorization|bearer|token|secret)\s*[:=]\s*\S+/gi;

function safeMessage(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'The AI provider returned an unknown error.';
  }
  return value.replace(SECRET_PATTERN, '$1: [REDACTED]').slice(0, 1_000);
}

function readStatus(error: ErrorLike): number | undefined {
  const status = error.status ?? error.statusCode ?? error.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function readRetryAfterMs(error: ErrorLike): number | undefined {
  const headers = error.response?.headers;
  if (!headers || typeof headers !== 'object') return undefined;

  const headerRecord = headers as Record<string, unknown>;
  const raw = headerRecord['retry-after'] ?? headerRecord['Retry-After'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw * 1_000;
  if (typeof raw !== 'string') return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function normalizeProviderError(error: unknown): ProviderError {
  const value =
    error && typeof error === 'object'
      ? (error as ErrorLike)
      : ({} as ErrorLike);
  const status = readStatus(value);
  const message = safeMessage(
    value.message ?? (typeof error === 'string' ? error : undefined),
  );
  const lower = message.toLowerCase();

  if (status === 401 || status === 403) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message,
      status,
      retryable: false,
    };
  }
  if (status === 402) {
    return { code: 'PAYMENT_REQUIRED', message, status, retryable: false };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message,
      status,
      retryable: true,
      retryAfterMs: readRetryAfterMs(value),
    };
  }
  if (status === 404 || lower.includes('model not found')) {
    return { code: 'MODEL_NOT_FOUND', message, status, retryable: false };
  }
  if (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('too many tokens')
  ) {
    return { code: 'CONTEXT_LIMIT', message, status, retryable: false };
  }
  if (
    status === 400 &&
    (lower.includes('unsupported') || lower.includes('unknown parameter'))
  ) {
    return { code: 'UNSUPPORTED_FEATURE', message, status, retryable: false };
  }
  if (status != null && status >= 500) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      message,
      status,
      retryable: true,
    };
  }
  if (
    value.code === 'ECONNREFUSED' ||
    value.code === 'ECONNRESET' ||
    value.code === 'ETIMEDOUT' ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return { code: 'NETWORK_ERROR', message, status, retryable: true };
  }

  return { code: 'UNKNOWN', message, status, retryable: false };
}
