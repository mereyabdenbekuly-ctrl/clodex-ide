import type {
  DictationBackendDiagnostics,
  DictationRealtimeNegotiationInput,
  DictationRealtimeNegotiationResult,
} from '@shared/dictation';
import {
  getDictationRealtimePreflightFallback,
  type DictationRealtimeConnectionTestResult,
} from '@shared/dictation-diagnostics';
import type { DictationRuntimeSupport } from '@shared/dictation-runtime';
import {
  getRealtimeDictationFailureReason,
  isRealtimeDictationAbortError,
  testRealtimeDictationConnection,
} from './dictation-realtime';

export interface RealtimeConnectionDiagnosticOperation {
  result: Promise<DictationRealtimeConnectionTestResult>;
  cancel: () => void;
}

export interface StartRealtimeConnectionDiagnosticTestOptions {
  runtimeSupport: DictationRuntimeSupport;
  getDiagnostics: () => Promise<DictationBackendDiagnostics>;
  negotiate: (
    input: DictationRealtimeNegotiationInput,
  ) => Promise<DictationRealtimeNegotiationResult>;
  cancelRemote: (requestId: string) => Promise<void>;
  requestId?: string;
}

export function startRealtimeConnectionDiagnosticTest({
  runtimeSupport,
  getDiagnostics,
  negotiate,
  cancelRemote,
  requestId = crypto.randomUUID(),
}: StartRealtimeConnectionDiagnosticTestOptions): RealtimeConnectionDiagnosticOperation {
  const controller = new AbortController();
  let settled = false;

  const result = (async (): Promise<DictationRealtimeConnectionTestResult> => {
    try {
      const backend = await withAbort(getDiagnostics(), controller.signal);
      if (controller.signal.aborted) return { outcome: 'cancelled' };
      const preflightFailure = getDictationRealtimePreflightFallback({
        realtimeRequested: true,
        realtimeWebRtc: runtimeSupport.realtimeWebRtc,
        backend,
      });
      if (preflightFailure) {
        return {
          outcome: 'not-ready',
          failureReason: preflightFailure,
        };
      }
      const connection = await testRealtimeDictationConnection({
        requestId,
        negotiate,
        signal: controller.signal,
      });
      return {
        outcome: 'connected',
        latencyMs: connection.latencyMs,
      };
    } catch (error) {
      if (controller.signal.aborted || isRealtimeDictationAbortError(error)) {
        return { outcome: 'cancelled' };
      }
      return {
        outcome: 'failed',
        failureReason: getRealtimeDictationFailureReason(
          error,
          'negotiation-failed',
        ),
      };
    } finally {
      settled = true;
    }
  })();

  return {
    result,
    cancel: () => {
      if (settled || controller.signal.aborted) return;
      controller.abort();
      void cancelRemote(requestId).catch(() => undefined);
    },
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', handleAbort);
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createAbortError(): Error {
  const error = new Error('Realtime connection diagnostic cancelled');
  error.name = 'AbortError';
  return error;
}
