import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  INITIAL_DICTATION_STATE,
  MAX_DICTATION_AUDIO_BYTES,
  MAX_DICTATION_DURATION_MS,
  MIN_DICTATION_DURATION_MS,
  reduceDictationState,
  type DictationBackendDiagnostics,
  type DictationState,
  type DictationTransport,
} from '@shared/dictation';
import {
  DICTATION_TRANSCRIPTION_UNAVAILABLE_MESSAGE,
  getDictationRealtimePreflightFallback,
  getDictationTranscriptionPreflightError,
  type DictationFallbackReason,
  type DictationSessionDiagnostics,
} from '@shared/dictation-diagnostics';
import {
  DictationLifecycleGuard,
  shouldCancelDictationForVisibility,
  type DictationLifecycleOperation,
} from '@shared/dictation-lifecycle';
import {
  getDictationErrorMessage,
  getDictationRuntimeSupport,
  getMicrophonePermissionError,
  normalizeRecorderMimeType,
  type DictationRuntimeSupport,
} from '@shared/dictation-runtime';
import {
  getRealtimeDictationFailureReason,
  startRealtimeDictationSession,
  type RealtimeDictationSession,
} from './dictation-realtime';
import { useKartonProcedure } from './use-karton';

const COMPLETED_VISIBLE_MS = 1_200;

export interface UseDictationOptions {
  enabled: boolean;
  realtimeEnabled: boolean;
  preferredModelId?: string;
  sessionKey?: string;
  onTranscript: (transcript: string) => void;
}

export interface UseDictationResult {
  state: DictationState;
  runtimeSupport: DictationRuntimeSupport;
  lastSessionDiagnostics: DictationSessionDiagnostics | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  retry: () => Promise<void>;
  toggle: () => void;
}

/**
 * Renderer-owned recording lifecycle.
 *
 * Audio remains in memory only. It is discarded after success/cancel and is
 * retained after a failed transcription solely to support an explicit retry.
 */
export function useDictation({
  enabled,
  realtimeEnabled,
  preferredModelId,
  sessionKey,
  onTranscript,
}: UseDictationOptions): UseDictationResult {
  const [state, dispatch] = useReducer(
    reduceDictationState,
    INITIAL_DICTATION_STATE,
  );
  const [lastSessionDiagnostics, setLastSessionDiagnostics] =
    useState<DictationSessionDiagnostics | null>(null);
  const transcribeProcedure = useKartonProcedure(
    (procedures) => procedures.dictation.transcribe,
  );
  const cancelTranscriptionProcedure = useKartonProcedure(
    (procedures) => procedures.dictation.cancel,
  );
  const negotiateRealtimeProcedure = useKartonProcedure(
    (procedures) => procedures.dictation.negotiateRealtime,
  );
  const getDiagnosticsProcedure = useKartonProcedure(
    (procedures) => procedures.dictation.getDiagnostics,
  );
  const transcribeRef = useRef(transcribeProcedure);
  transcribeRef.current = transcribeProcedure;
  const cancelTranscriptionRef = useRef(cancelTranscriptionProcedure);
  cancelTranscriptionRef.current = cancelTranscriptionProcedure;
  const negotiateRealtimeRef = useRef(negotiateRealtimeProcedure);
  negotiateRealtimeRef.current = negotiateRealtimeProcedure;
  const getDiagnosticsRef = useRef(getDiagnosticsProcedure);
  getDiagnosticsRef.current = getDiagnosticsProcedure;
  const stateRef = useRef(state);
  stateRef.current = state;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const preferredModelIdRef = useRef(preferredModelId);
  preferredModelIdRef.current = preferredModelId;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const realtimeEnabledRef = useRef(realtimeEnabled);
  realtimeEnabledRef.current = realtimeEnabled;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const realtimeSessionRef = useRef<RealtimeDictationSession | null>(null);
  const latestRealtimePartialRef = useRef('');
  const chunksRef = useRef<Blob[]>([]);
  const lastAudioRef = useRef<{
    blob: Blob;
    durationMs: number;
  } | null>(null);
  const recordingStartedAtRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const lifecycleGuardRef = useRef<DictationLifecycleGuard | null>(null);
  lifecycleGuardRef.current ??= new DictationLifecycleGuard();
  const canceledRecordingRef = useRef(false);
  const autoStopTimerRef = useRef<number | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const sessionDiagnosticsRef = useRef<DictationSessionDiagnostics | null>(
    null,
  );
  const backendDiagnosticsRef = useRef<DictationBackendDiagnostics | null>(
    null,
  );
  const runtimeSupport = useMemo(readDictationRuntimeSupport, []);

  const updateSessionDiagnostics = useCallback(
    (patch: Partial<DictationSessionDiagnostics>): void => {
      const current = sessionDiagnosticsRef.current;
      if (!current) return;
      const next = { ...current, ...patch };
      sessionDiagnosticsRef.current = next;
      setLastSessionDiagnostics(next);
    },
    [],
  );

  const clearTimers = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
  }, []);

  const completeTranscription = useCallback(
    (
      transcript: string,
      operation: DictationLifecycleOperation,
      transport: DictationTransport,
    ): void => {
      if (
        !lifecycleGuardRef.current?.claimTranscriptDelivery(
          operation,
          sessionKeyRef.current,
        )
      ) {
        return;
      }
      lifecycleGuardRef.current?.finish(operation);
      lastAudioRef.current = null;
      activeRequestIdRef.current = null;
      dispatch({ type: 'completed', transcript });
      updateSessionDiagnostics({
        outcome: 'completed',
        finalTransport: transport,
      });
      onTranscriptRef.current(transcript);
      completionTimerRef.current = window.setTimeout(() => {
        dispatch({ type: 'reset' });
        completionTimerRef.current = null;
      }, COMPLETED_VISIBLE_MS);
    },
    [updateSessionDiagnostics],
  );

  const runTranscription = useCallback(
    async (
      blob: Blob,
      durationMs: number,
      operation: DictationLifecycleOperation,
    ): Promise<void> => {
      lastAudioRef.current = { blob, durationMs };
      const requestId = crypto.randomUUID();
      activeRequestIdRef.current = requestId;
      try {
        const audioBase64 = await blobToBase64(blob);
        if (
          !lifecycleGuardRef.current?.isCurrent(
            operation,
            sessionKeyRef.current,
          )
        ) {
          return;
        }
        const result = await transcribeRef.current({
          requestId,
          audioBase64,
          mediaType: normalizeRecorderMimeType(blob.type),
          durationMs,
          preferredModelId: preferredModelIdRef.current,
        });
        if (
          !lifecycleGuardRef.current?.isCurrent(
            operation,
            sessionKeyRef.current,
          )
        ) {
          return;
        }
        completeTranscription(result.text, operation, 'batch');
      } catch (error) {
        if (
          !lifecycleGuardRef.current?.isCurrent(
            operation,
            sessionKeyRef.current,
          )
        ) {
          return;
        }
        lifecycleGuardRef.current?.finish(operation);
        activeRequestIdRef.current = null;
        dispatch({
          type: 'failed',
          error: getDictationErrorMessage(error),
          retryable: true,
          durationMs,
        });
        updateSessionDiagnostics({
          outcome: 'failed',
          finalTransport: 'batch',
          recordingDurationMs: durationMs,
        });
      }
    },
    [completeTranscription, updateSessionDiagnostics],
  );

  const finishRecording = useCallback(
    async (
      operation: DictationLifecycleOperation,
      mimeType: string,
    ): Promise<void> => {
      clearTimers();
      recorderRef.current = null;
      const realtimeSession = realtimeSessionRef.current;
      if (
        canceledRecordingRef.current ||
        !lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
      ) {
        realtimeSession?.close();
        if (realtimeSessionRef.current === realtimeSession) {
          realtimeSessionRef.current = null;
        }
        stopStream();
        chunksRef.current = [];
        return;
      }
      const durationMs = Math.min(
        MAX_DICTATION_DURATION_MS,
        Math.max(0, Date.now() - recordingStartedAtRef.current),
      );
      const blob = new Blob(chunksRef.current, {
        type: normalizeRecorderMimeType(mimeType),
      });
      chunksRef.current = [];
      updateSessionDiagnostics({ recordingDurationMs: durationMs });
      if (durationMs < MIN_DICTATION_DURATION_MS) {
        realtimeSession?.close();
        if (realtimeSessionRef.current === realtimeSession) {
          realtimeSessionRef.current = null;
        }
        stopStream();
        lastAudioRef.current = null;
        lifecycleGuardRef.current?.finish(operation);
        dispatch({
          type: 'failed',
          error: 'Hold the microphone a little longer before stopping.',
          retryable: false,
        });
        updateSessionDiagnostics({ outcome: 'failed' });
        return;
      }
      if (blob.size === 0) {
        realtimeSession?.close();
        if (realtimeSessionRef.current === realtimeSession) {
          realtimeSessionRef.current = null;
        }
        stopStream();
        lastAudioRef.current = null;
        lifecycleGuardRef.current?.finish(operation);
        dispatch({
          type: 'failed',
          error: 'The microphone returned an empty recording.',
          retryable: false,
        });
        updateSessionDiagnostics({ outcome: 'failed' });
        return;
      }
      if (blob.size > MAX_DICTATION_AUDIO_BYTES) {
        realtimeSession?.close();
        if (realtimeSessionRef.current === realtimeSession) {
          realtimeSessionRef.current = null;
        }
        stopStream();
        lastAudioRef.current = null;
        lifecycleGuardRef.current?.finish(operation);
        dispatch({
          type: 'failed',
          error: 'The recording exceeded the 20 MB limit.',
          retryable: false,
        });
        updateSessionDiagnostics({ outcome: 'failed' });
        return;
      }
      dispatch({ type: 'stop', durationMs });
      if (realtimeSession) {
        const finalizationStartedAt = performance.now();
        try {
          const finalTranscriptPromise = realtimeSession.finish();
          stopStream();
          const transcript = await finalTranscriptPromise;
          realtimeSession.close();
          if (realtimeSessionRef.current === realtimeSession) {
            realtimeSessionRef.current = null;
          }
          updateSessionDiagnostics({
            finalizationLatencyMs: Math.round(
              performance.now() - finalizationStartedAt,
            ),
          });
          completeTranscription(transcript, operation, 'realtime');
          return;
        } catch (error) {
          realtimeSession.close();
          if (realtimeSessionRef.current === realtimeSession) {
            realtimeSessionRef.current = null;
          }
          if (
            !lifecycleGuardRef.current?.isCurrent(
              operation,
              sessionKeyRef.current,
            )
          ) {
            return;
          }
          updateSessionDiagnostics({
            finalTransport: 'batch',
            fallbackReason: getRealtimeDictationFailureReason(error),
            finalizationLatencyMs: Math.round(
              performance.now() - finalizationStartedAt,
            ),
          });
          dispatch({ type: 'transport-selected', transport: 'batch' });
          if (!backendDiagnosticsRef.current?.batchTranscriptionReady) {
            lastAudioRef.current = null;
            lifecycleGuardRef.current?.finish(operation);
            dispatch({
              type: 'failed',
              error: DICTATION_TRANSCRIPTION_UNAVAILABLE_MESSAGE,
              retryable: false,
              durationMs,
            });
            updateSessionDiagnostics({
              outcome: 'failed',
              finalTransport: 'realtime',
              recordingDurationMs: durationMs,
            });
            return;
          }
        }
      } else {
        stopStream();
      }
      await runTranscription(blob, durationMs, operation);
    },
    [
      clearTimers,
      completeTranscription,
      runTranscription,
      stopStream,
      updateSessionDiagnostics,
    ],
  );

  const start = useCallback(async () => {
    if (
      !enabled ||
      stateRef.current.status === 'requesting-permission' ||
      stateRef.current.status === 'recording' ||
      stateRef.current.status === 'transcribing' ||
      lifecycleGuardRef.current?.isActive()
    ) {
      return;
    }
    const currentRuntimeSupport = readDictationRuntimeSupport();
    const requestedTransport: DictationTransport = realtimeEnabledRef.current
      ? 'realtime'
      : 'batch';
    const operation = lifecycleGuardRef.current?.begin(sessionKeyRef.current);
    if (!operation) return;
    const initialDiagnostics: DictationSessionDiagnostics = {
      outcome: 'starting',
      requestedTransport,
      finalTransport: 'batch',
      recorderMimeType: currentRuntimeSupport.recorderMimeType,
    };
    sessionDiagnosticsRef.current = initialDiagnostics;
    setLastSessionDiagnostics(initialDiagnostics);
    backendDiagnosticsRef.current = null;

    if (!currentRuntimeSupport.batchRecording) {
      dispatch({
        type: 'failed',
        error: 'Microphone recording is not available in this environment.',
        retryable: false,
      });
      lifecycleGuardRef.current?.finish(operation);
      updateSessionDiagnostics({ outcome: 'failed' });
      return;
    }

    clearTimers();
    lastAudioRef.current = null;
    latestRealtimePartialRef.current = '';
    canceledRecordingRef.current = false;
    chunksRef.current = [];
    dispatch({ type: 'request-permission' });

    let backendDiagnostics: DictationBackendDiagnostics;
    try {
      backendDiagnostics = await getDiagnosticsRef.current();
    } catch {
      if (
        !lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
      ) {
        return;
      }
      lifecycleGuardRef.current?.finish(operation);
      dispatch({
        type: 'failed',
        error:
          'Could not verify the speech transcription service. Check your connection and try again.',
        retryable: false,
      });
      updateSessionDiagnostics({ outcome: 'failed' });
      return;
    }
    if (
      !lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
    ) {
      return;
    }
    backendDiagnosticsRef.current = backendDiagnostics;
    const preflightError = getDictationTranscriptionPreflightError({
      realtimeRequested: realtimeEnabledRef.current,
      realtimeWebRtc: currentRuntimeSupport.realtimeWebRtc,
      backend: backendDiagnostics,
    });
    if (preflightError) {
      lifecycleGuardRef.current?.finish(operation);
      dispatch({
        type: 'failed',
        error: preflightError,
        retryable: false,
      });
      updateSessionDiagnostics({ outcome: 'failed' });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (
        !lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
      ) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const mimeType = currentRuntimeSupport.recorderMimeType;
      let realtimeSession: RealtimeDictationSession | null = null;
      let fallbackReason: DictationFallbackReason | undefined;
      if (realtimeEnabledRef.current && !currentRuntimeSupport.realtimeWebRtc) {
        fallbackReason = getDictationRealtimePreflightFallback({
          realtimeRequested: true,
          realtimeWebRtc: false,
        });
      } else if (
        realtimeEnabledRef.current &&
        currentRuntimeSupport.realtimeWebRtc &&
        lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
      ) {
        try {
          const backendDiagnostics = await getDiagnosticsRef.current();
          if (
            !lifecycleGuardRef.current?.isCurrent(
              operation,
              sessionKeyRef.current,
            )
          ) {
            stopStream();
            return;
          }
          fallbackReason = getDictationRealtimePreflightFallback({
            realtimeRequested: true,
            realtimeWebRtc: true,
            backend: backendDiagnostics,
          });
          if (!fallbackReason) {
            const realtimeRequestId = crypto.randomUUID();
            const negotiationStartedAt = performance.now();
            const realtimeAttemptStartedAt = performance.now();
            let firstDeltaRecorded = false;
            activeRequestIdRef.current = realtimeRequestId;
            try {
              realtimeSession = await startRealtimeDictationSession({
                stream,
                requestId: realtimeRequestId,
                negotiate: (input) => negotiateRealtimeRef.current(input),
                onPartialTranscript: (transcript) => {
                  if (
                    !lifecycleGuardRef.current?.isCurrent(
                      operation,
                      sessionKeyRef.current,
                    )
                  ) {
                    return;
                  }
                  if (transcript && !firstDeltaRecorded) {
                    firstDeltaRecorded = true;
                    updateSessionDiagnostics({
                      firstDeltaLatencyMs: Math.round(
                        performance.now() - realtimeAttemptStartedAt,
                      ),
                    });
                  }
                  latestRealtimePartialRef.current = transcript;
                  dispatch({ type: 'partial-transcript', transcript });
                },
                onFailure: (reason) => {
                  if (
                    !lifecycleGuardRef.current?.isCurrent(
                      operation,
                      sessionKeyRef.current,
                    )
                  ) {
                    return;
                  }
                  realtimeSessionRef.current = null;
                  latestRealtimePartialRef.current = '';
                  updateSessionDiagnostics({
                    finalTransport: 'batch',
                    fallbackReason: reason,
                  });
                  dispatch({
                    type: 'transport-selected',
                    transport: 'batch',
                  });
                },
              });
              if (
                !lifecycleGuardRef.current?.isCurrent(
                  operation,
                  sessionKeyRef.current,
                )
              ) {
                realtimeSession.close();
                stopStream();
                return;
              }
              if (activeRequestIdRef.current === realtimeRequestId) {
                activeRequestIdRef.current = null;
              }
              updateSessionDiagnostics({
                finalTransport: 'realtime',
                negotiationLatencyMs: Math.round(
                  performance.now() - negotiationStartedAt,
                ),
              });
              if (
                !lifecycleGuardRef.current?.isCurrent(
                  operation,
                  sessionKeyRef.current,
                ) ||
                !realtimeEnabledRef.current
              ) {
                realtimeSession.close();
                realtimeSession = null;
                if (
                  lifecycleGuardRef.current?.isCurrent(
                    operation,
                    sessionKeyRef.current,
                  ) &&
                  !realtimeEnabledRef.current
                ) {
                  fallbackReason = 'realtime-gate-disabled';
                }
              }
            } catch (error) {
              void cancelTranscriptionRef
                .current(realtimeRequestId)
                .catch(() => undefined);
              if (activeRequestIdRef.current === realtimeRequestId) {
                activeRequestIdRef.current = null;
              }
              if (
                !lifecycleGuardRef.current?.isCurrent(
                  operation,
                  sessionKeyRef.current,
                )
              ) {
                return;
              }
              fallbackReason = getRealtimeDictationFailureReason(
                error,
                'negotiation-failed',
              );
              updateSessionDiagnostics({
                negotiationLatencyMs: Math.round(
                  performance.now() - negotiationStartedAt,
                ),
              });
              realtimeSession = null;
            }
          }
        } catch {
          if (
            !lifecycleGuardRef.current?.isCurrent(
              operation,
              sessionKeyRef.current,
            )
          ) {
            stopStream();
            return;
          }
          fallbackReason = 'negotiation-failed';
        }
      }
      if (fallbackReason) {
        updateSessionDiagnostics({
          finalTransport: 'batch',
          fallbackReason,
        });
      }
      if (
        !lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
      ) {
        realtimeSession?.close();
        stopStream();
        return;
      }
      realtimeSessionRef.current = realtimeSession;
      const recorder = new MediaRecorder(
        stream,
        mimeType
          ? {
              mimeType,
              audioBitsPerSecond: 64_000,
            }
          : { audioBitsPerSecond: 64_000 },
      );
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        canceledRecordingRef.current = true;
        lifecycleGuardRef.current?.finish(operation);
        realtimeSessionRef.current?.close();
        realtimeSessionRef.current = null;
        stopStream();
        lastAudioRef.current = null;
        dispatch({
          type: 'failed',
          error: 'The microphone recorder stopped unexpectedly.',
          retryable: false,
        });
        updateSessionDiagnostics({ outcome: 'failed' });
      };
      recorder.onstop = () => {
        void finishRecording(
          operation,
          recorder.mimeType || mimeType || 'audio/webm',
        );
      };
      recordingStartedAtRef.current = Date.now();
      recorder.start(250);
      updateSessionDiagnostics({
        outcome: 'recording',
        finalTransport: realtimeSession ? 'realtime' : 'batch',
      });
      dispatch({
        type: 'permission-granted',
        startedAt: recordingStartedAtRef.current,
      });
      if (realtimeSession) {
        dispatch({ type: 'transport-selected', transport: 'realtime' });
        if (latestRealtimePartialRef.current) {
          dispatch({
            type: 'partial-transcript',
            transcript: latestRealtimePartialRef.current,
          });
        }
      }
      autoStopTimerRef.current = window.setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, MAX_DICTATION_DURATION_MS);
    } catch (error) {
      realtimeSessionRef.current?.close();
      realtimeSessionRef.current = null;
      stopStream();
      if (
        !lifecycleGuardRef.current?.isCurrent(operation, sessionKeyRef.current)
      ) {
        return;
      }
      lifecycleGuardRef.current?.finish(operation);
      dispatch({
        type: 'failed',
        error: getMicrophonePermissionError(error),
        retryable: false,
      });
      updateSessionDiagnostics({ outcome: 'failed' });
    }
  }, [
    clearTimers,
    enabled,
    finishRecording,
    stopStream,
    updateSessionDiagnostics,
  ]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    const wasActive =
      stateRef.current.status === 'requesting-permission' ||
      stateRef.current.status === 'recording' ||
      stateRef.current.status === 'transcribing' ||
      sessionDiagnosticsRef.current?.outcome === 'starting' ||
      sessionDiagnosticsRef.current?.outcome === 'recording';
    lifecycleGuardRef.current?.invalidate();
    canceledRecordingRef.current = true;
    clearTimers();
    const requestId = activeRequestIdRef.current;
    activeRequestIdRef.current = null;
    if (requestId) {
      void cancelTranscriptionRef.current(requestId).catch(() => {
        // The request may have completed between the local cancel and RPC.
      });
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorderRef.current = null;
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = null;
    latestRealtimePartialRef.current = '';
    backendDiagnosticsRef.current = null;
    stopStream();
    chunksRef.current = [];
    lastAudioRef.current = null;
    if (wasActive) updateSessionDiagnostics({ outcome: 'cancelled' });
    dispatch({ type: 'reset' });
  }, [clearTimers, stopStream, updateSessionDiagnostics]);

  const retry = useCallback(async () => {
    const retained = lastAudioRef.current;
    if (
      stateRef.current.status !== 'failed' ||
      !stateRef.current.retryable ||
      !retained
    ) {
      return;
    }
    clearTimers();
    const retryDiagnostics: DictationSessionDiagnostics = {
      outcome: 'starting',
      requestedTransport: 'batch',
      finalTransport: 'batch',
      recorderMimeType: retained.blob.type || undefined,
      recordingDurationMs: retained.durationMs,
    };
    sessionDiagnosticsRef.current = retryDiagnostics;
    setLastSessionDiagnostics(retryDiagnostics);
    const operation = lifecycleGuardRef.current?.begin(sessionKeyRef.current);
    if (!operation) return;
    dispatch({ type: 'retry' });
    await runTranscription(retained.blob, retained.durationMs, operation);
  }, [clearTimers, runTranscription]);

  const toggle = useCallback(() => {
    if (
      stateRef.current.status === 'idle' &&
      lifecycleGuardRef.current?.isActive()
    ) {
      cancel();
      return;
    }
    switch (stateRef.current.status) {
      case 'idle':
      case 'completed':
        void start();
        break;
      case 'requesting-permission':
      case 'transcribing':
        cancel();
        break;
      case 'recording':
        stop();
        break;
      case 'failed':
        if (stateRef.current.retryable) void retry();
        else void start();
        break;
    }
  }, [cancel, retry, start, stop]);

  useEffect(() => {
    if (enabled) return;
    cancel();
  }, [cancel, enabled]);

  useEffect(() => {
    if (realtimeEnabled) return;
    const realtimeWasActive =
      (stateRef.current.status === 'recording' ||
        stateRef.current.status === 'transcribing') &&
      stateRef.current.transport === 'realtime';
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = null;
    latestRealtimePartialRef.current = '';
    if (
      stateRef.current.status === 'recording' ||
      stateRef.current.status === 'transcribing'
    ) {
      if (realtimeWasActive) {
        updateSessionDiagnostics({
          finalTransport: 'batch',
          fallbackReason: 'realtime-gate-disabled',
        });
      }
      dispatch({ type: 'transport-selected', transport: 'batch' });
    } else if (stateRef.current.status === 'requesting-permission') {
      const requestId = activeRequestIdRef.current;
      if (requestId) {
        void cancelTranscriptionRef.current(requestId).catch(() => undefined);
      }
    }
  }, [realtimeEnabled, updateSessionDiagnostics]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        shouldCancelDictationForVisibility(
          document.visibilityState,
          stateRef.current.status,
        )
      ) {
        cancel();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return {
    state,
    runtimeSupport,
    lastSessionDiagnostics,
    start,
    stop,
    cancel,
    retry,
    toggle,
  };
}

function readDictationRuntimeSupport(): DictationRuntimeSupport {
  const webkitAudioContext = (
    globalThis as typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    }
  ).webkitAudioContext;
  return getDictationRuntimeSupport({
    hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    hasMediaRecorder: Boolean(globalThis.MediaRecorder),
    hasRTCPeerConnection: Boolean(globalThis.RTCPeerConnection),
    hasAudioContext: Boolean(globalThis.AudioContext ?? webkitAudioContext),
    isRecorderTypeSupported: (mimeType) =>
      globalThis.MediaRecorder?.isTypeSupported(mimeType) ?? false,
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const separator = dataUrl.indexOf(',');
      if (separator < 0) {
        reject(new Error('Unable to encode recorded audio'));
        return;
      }
      resolve(dataUrl.slice(separator + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('Unable to read recorded audio'));
    reader.readAsDataURL(blob);
  });
}
