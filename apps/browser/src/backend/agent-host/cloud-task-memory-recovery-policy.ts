import {
  EvidenceMemoryDivergenceError,
  EvidenceMemoryFencedWriteError,
} from '@clodex/agent-core/evidence-memory';
import type {
  CloudTaskMemoryRecoveryClass,
  CloudTaskMemoryRecoveryDecision,
} from '@shared/cloud-task-memory-sync';
import { CloudTaskMemoryCompareAndSwapError } from './cloud-task-memory-atomic-sync';

export interface CloudTaskMemoryRecoveryClassification {
  recoveryClass: CloudTaskMemoryRecoveryClass;
  decision: CloudTaskMemoryRecoveryDecision;
  retryable: boolean;
}

export interface CloudTaskMemoryRecoveryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4_000;
const DEFAULT_JITTER_RATIO = 0.2;

/**
 * Fail-closed policy for automatic memory recovery. It retries only errors
 * that are demonstrably transient and delegates ledger merge proof to the
 * synchronizer, where both complete event sets are available.
 */
export class CloudTaskMemoryRecoveryPolicy {
  public readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly sleepFn: (
    delayMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  public constructor(options: CloudTaskMemoryRecoveryPolicyOptions = {}) {
    this.maxAttempts = normalizeInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      1,
      8,
      'attempt count',
    );
    this.baseDelayMs = normalizeInteger(
      options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      0,
      60_000,
      'base delay',
    );
    this.maxDelayMs = normalizeInteger(
      options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      this.baseDelayMs,
      120_000,
      'maximum delay',
    );
    this.jitterRatio = normalizeRatio(
      options.jitterRatio ?? DEFAULT_JITTER_RATIO,
    );
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleep ?? abortableSleep;
  }

  public classify(error: unknown): CloudTaskMemoryRecoveryClassification {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        recoveryClass: 'unknown',
        decision: 'manual',
        retryable: false,
      };
    }
    if (error instanceof EvidenceMemoryDivergenceError) {
      return {
        recoveryClass: 'checkpoint-conflict',
        decision: 'manual',
        retryable: false,
      };
    }
    if (error instanceof EvidenceMemoryFencedWriteError) {
      return {
        recoveryClass: 'ownership-conflict',
        decision: 'manual',
        retryable: false,
      };
    }
    if (error instanceof CloudTaskMemoryCompareAndSwapError) {
      return {
        recoveryClass: 'concurrent-update',
        decision: 'retry',
        retryable: true,
      };
    }
    if (isTransientTransportError(error)) {
      return {
        recoveryClass: 'transient',
        decision: 'retry',
        retryable: true,
      };
    }
    return {
      recoveryClass: error instanceof Error ? 'unknown' : 'invalid-data',
      decision: 'manual',
      retryable: false,
    };
  }

  public getBackoffMs(failedAttempt: number): number {
    const attempt = normalizeInteger(failedAttempt, 1, 64, 'failed attempt');
    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** (attempt - 1),
    );
    if (exponential === 0 || this.jitterRatio === 0) return exponential;
    const jitterWindow = exponential * this.jitterRatio;
    const random = Math.min(1, Math.max(0, this.random()));
    return Math.round(exponential - jitterWindow + random * jitterWindow * 2);
  }

  public async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    await this.sleepFn(delayMs, signal);
  }
}

function isTransientTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up')
  ) {
    return true;
  }
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

async function abortableSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Memory sync recovery was aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Memory recovery ${label} is invalid`);
  }
  return value;
}

function normalizeRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Memory recovery jitter ratio is invalid');
  }
  return value;
}
