import { ModelExecutionReplayGuard } from '../../services/model-fabric';

/** Five reconnects after the initial provider execution (six executions max). */
export const MAX_UPSTREAM_RECONNECT_ATTEMPTS = 5;

const UPSTREAM_RECONNECT_BACKOFF_MS = [
  500, 1_000, 2_000, 4_000, 8_000,
] as const;

export type UpstreamStepRecoveryProgress = {
  readonly firstTokenObserved: boolean;
  readonly outputCommitted: boolean;
  readonly toolDispatched: boolean;
  readonly dispatchedToolCallIds: readonly string[];
  readonly terminalToolCallIds: readonly string[];
  readonly unresolvedToolCallIds: readonly string[];
};

export type UpstreamDisconnectRecoveryDecision =
  | {
      readonly kind: 'retry-step' | 'continue';
      readonly attempt: number;
      readonly delayMs: number;
    }
  | {
      readonly kind: 'fail-closed';
      readonly reason:
        | 'unknown-tool-outcome'
        | 'retry-exhausted'
        | 'route-unverified';
      readonly attempt: number;
    };

/**
 * Monotonic, content-free progress tracker for one provider stream attempt.
 *
 * The tracker deliberately does not classify tools by name. A completed
 * terminal tool result is safe to continue from regardless of whether the
 * tool observed state or committed an effect; a dispatched tool without a
 * terminal result is always ambiguous and must fail closed.
 */
export class UpstreamStepRecoveryTracker {
  private readonly replayGuard = new ModelExecutionReplayGuard(
    'safe-before-first-token',
  );
  private outputCommitted = false;
  private readonly dispatchedToolCallIds = new Set<string>();
  private readonly terminalToolCallIds = new Set<string>();

  public markFirstToken(): void {
    this.replayGuard.mark('first-token');
  }

  public markOutputCommitted(): void {
    this.replayGuard.mark('output-commit');
    this.outputCommitted = true;
  }

  public markToolDispatched(toolCallId: string): void {
    const normalized = normalizeToolCallId(toolCallId);
    this.replayGuard.mark('tool-dispatch');
    this.dispatchedToolCallIds.add(normalized);
  }

  public markToolTerminal(toolCallId: string): void {
    const normalized = normalizeToolCallId(toolCallId);
    this.markOutputCommitted();
    this.terminalToolCallIds.add(normalized);
  }

  public hasToolDispatched(toolCallId: string): boolean {
    return this.dispatchedToolCallIds.has(toolCallId.trim());
  }

  public snapshot(): UpstreamStepRecoveryProgress {
    const replay = this.replayGuard.snapshot();
    const dispatchedToolCallIds = [...this.dispatchedToolCallIds].sort();
    const terminalToolCallIds = [...this.terminalToolCallIds].sort();
    const unresolvedToolCallIds = dispatchedToolCallIds.filter(
      (toolCallId) => !this.terminalToolCallIds.has(toolCallId),
    );
    return {
      firstTokenObserved: replay.firstTokenObserved,
      outputCommitted: this.outputCommitted || replay.outputCommitted,
      toolDispatched: replay.toolDispatched,
      dispatchedToolCallIds,
      terminalToolCallIds,
      unresolvedToolCallIds,
    };
  }
}

export function decideUpstreamDisconnectRecovery(input: {
  readonly attemptsUsed: number;
  readonly maxAttempts?: number;
  readonly progress: UpstreamStepRecoveryProgress;
}): UpstreamDisconnectRecoveryDecision {
  const maxAttempts = normalizeAttemptCount(
    input.maxAttempts ?? MAX_UPSTREAM_RECONNECT_ATTEMPTS,
  );
  const attemptsUsed = normalizeAttemptsUsed(input.attemptsUsed);

  if (input.progress.unresolvedToolCallIds.length > 0) {
    return {
      kind: 'fail-closed',
      reason: 'unknown-tool-outcome',
      attempt: Math.min(attemptsUsed, maxAttempts),
    };
  }

  if (attemptsUsed >= maxAttempts) {
    return {
      kind: 'fail-closed',
      reason: 'retry-exhausted',
      attempt: maxAttempts,
    };
  }

  const attempt = attemptsUsed + 1;
  const delayMs = reconnectBackoffMs(attempt);
  const mustContinue =
    input.progress.firstTokenObserved ||
    input.progress.outputCommitted ||
    input.progress.toolDispatched ||
    input.progress.terminalToolCallIds.length > 0;

  return {
    kind: mustContinue ? 'continue' : 'retry-step',
    attempt,
    delayMs,
  };
}

export type UpstreamDisconnectInfo = {
  readonly message: string;
  readonly endpointId?: string;
};

export function isValidUpstreamDisconnectRecoveryState(input: {
  readonly phase?: unknown;
  readonly resumeMode?: unknown;
}): boolean {
  return (
    (input.phase === 'before-output' && input.resumeMode === 'retry-step') ||
    (input.phase === 'partial-output' && input.resumeMode === 'continue') ||
    (input.phase === 'unknown-tool-outcome' &&
      input.resumeMode === 'blocked') ||
    (input.phase === 'route-unverified' && input.resumeMode === 'blocked')
  );
}

/**
 * Recognizes transport disconnects without treating user cancellation,
 * authentication, quota, or ordinary provider errors as reconnectable.
 */
export function parseUpstreamDisconnectError(
  error: unknown,
): UpstreamDisconnectInfo | null {
  const frames = [...walkErrorFrames(error)];

  // Cancellation, authentication, and quota signals take precedence over a
  // transport-looking wrapper. Providers commonly wrap the terminal cause in
  // a generic "connection closed" error; replaying through that wrapper would
  // turn an explicit stop or a 401/403/429 into an unsafe reconnect loop.
  if (frames.some(isNonReconnectableFrame)) return null;

  for (const frame of frames) {
    const name = typeof frame.name === 'string' ? frame.name : '';
    const message = typeof frame.message === 'string' ? frame.message : '';
    const code = typeof frame.code === 'string' ? frame.code : '';
    const combined = `${name}: ${message} ${code}`.trim();
    const normalized = combined.toLowerCase();
    if (!normalized) continue;

    const explicitDisconnect =
      normalized.includes('serverdisconnectederror') ||
      normalized.includes('stream disconnected before completion') ||
      normalized.includes('stream ended before a terminal event') ||
      normalized.includes('stream ended before terminal event') ||
      normalized.includes('stream closed before response.completed') ||
      normalized.includes('idle timeout waiting for sse') ||
      normalized.includes('und_err_socket') ||
      normalized.includes('und_err_connect_timeout') ||
      normalized.includes('econnreset') ||
      normalized.includes('etimedout') ||
      normalized.includes('socket hang up') ||
      normalized.includes('premature close') ||
      normalized.includes('unexpected eof') ||
      normalized.includes('error sending request for url');
    const contextualDisconnect =
      /(upstream|proxy|provider|response|socket|connection|transport)/.test(
        normalized,
      ) &&
      /(disconnect|reset|closed|terminated|eof|decoding response body)/.test(
        normalized,
      );
    if (!explicitDisconnect && !contextualDisconnect) continue;

    const endpointMatch = combined.match(
      /proxy endpoint\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    return {
      message: message || combined,
      ...(endpointMatch?.[1] ? { endpointId: endpointMatch[1] } : {}),
    };
  }
  return null;
}

function reconnectBackoffMs(attempt: number): number {
  return (
    UPSTREAM_RECONNECT_BACKOFF_MS[
      Math.min(
        Math.max(1, Math.floor(attempt)),
        UPSTREAM_RECONNECT_BACKOFF_MS.length,
      ) - 1
    ] ?? UPSTREAM_RECONNECT_BACKOFF_MS.at(-1)!
  );
}

function normalizeAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('maxAttempts must be a positive safe integer');
  }
  return value;
}

function normalizeAttemptsUsed(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeToolCallId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('toolCallId must not be empty');
  return normalized;
}

function isNonReconnectableFrame(frame: Record<string, unknown>): boolean {
  const name = typeof frame.name === 'string' ? frame.name : '';
  const message = typeof frame.message === 'string' ? frame.message : '';
  const code = typeof frame.code === 'string' ? frame.code : '';
  const normalized = `${name}: ${message} ${code}`.toLowerCase();
  if (
    normalized.includes('aborterror') ||
    normalized.includes('operation was aborted') ||
    normalized.includes('user aborted') ||
    normalized.includes('user stopped')
  ) {
    return true;
  }

  const status = [frame.statusCode, frame.status].find(
    (value): value is number => typeof value === 'number',
  );
  if (status === 401 || status === 403 || status === 429) return true;

  return (
    /\b(?:401|403|429)\b/.test(normalized) ||
    normalized.includes('too many requests') ||
    normalized.includes('rate limit') ||
    normalized.includes('quota') ||
    normalized.includes('usage limit') ||
    normalized.includes('invalid api key') ||
    normalized.includes('authentication failed') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  );
}

function* walkErrorFrames(error: unknown): Iterable<Record<string, unknown>> {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let visited = 0; pending.length > 0 && visited < 12; visited += 1) {
    const frame = pending.shift();
    if (typeof frame !== 'object' || frame === null || seen.has(frame)) {
      continue;
    }
    seen.add(frame);
    const record = frame as Record<string, unknown>;
    yield record;
    if (isErrorFrame(record.lastError)) pending.push(record.lastError);
    if (isErrorFrame(record.cause)) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
}

function isErrorFrame(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
