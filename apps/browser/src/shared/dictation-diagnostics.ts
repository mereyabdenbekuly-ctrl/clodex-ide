import type {
  DictationBackendDiagnostics,
  DictationTransport,
} from './dictation';
import type { DictationRuntimeSupport } from './dictation-runtime';

export const dictationFallbackReasons = [
  'global-dictation-gate-disabled',
  'official-openai-key-unavailable',
  'webrtc-unavailable',
  'realtime-gate-disabled',
  'negotiation-failed',
  'negotiation-timeout',
  'data-channel-open-timeout',
  'realtime-runtime-failure',
  'final-transcript-timeout',
  'empty-final-transcript',
] as const;
export type DictationFallbackReason = (typeof dictationFallbackReasons)[number];

export const dictationMicrophoneTestFailureReasons = [
  'microphone-api-unavailable',
  'web-audio-unavailable',
  'permission-denied',
  'microphone-not-found',
  'microphone-unavailable',
  'microphone-test-runtime-failure',
] as const;
export type DictationMicrophoneTestFailureReason =
  (typeof dictationMicrophoneTestFailureReasons)[number];

export type DictationMicrophoneTestOutcome =
  | 'passed'
  | 'no-signal'
  | 'failed'
  | 'cancelled';

export interface DictationMicrophoneTestResult {
  outcome: DictationMicrophoneTestOutcome;
  durationMs?: number;
  peakLevel?: number;
  failureReason?: DictationMicrophoneTestFailureReason;
}

export type DictationRealtimeConnectionTestOutcome =
  | 'connected'
  | 'not-ready'
  | 'failed'
  | 'cancelled';

export interface DictationRealtimeConnectionTestResult {
  outcome: DictationRealtimeConnectionTestOutcome;
  latencyMs?: number;
  failureReason?: DictationFallbackReason;
}

export type DictationSessionOutcome =
  | 'starting'
  | 'recording'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DictationSessionDiagnostics {
  outcome: DictationSessionOutcome;
  requestedTransport: DictationTransport;
  finalTransport: DictationTransport;
  recorderMimeType?: string;
  negotiationLatencyMs?: number;
  firstDeltaLatencyMs?: number;
  finalizationLatencyMs?: number;
  recordingDurationMs?: number;
  fallbackReason?: DictationFallbackReason;
}

export interface DictationDiagnosticReportInput {
  platform: string;
  runtime: DictationRuntimeSupport;
  backend?: DictationBackendDiagnostics;
  lastSession?: DictationSessionDiagnostics;
  lastMicrophoneTest?: DictationMicrophoneTestResult;
  lastRealtimeConnectionTest?: DictationRealtimeConnectionTestResult;
}

export const DICTATION_TRANSCRIPTION_UNAVAILABLE_MESSAGE =
  'Speech transcription is not configured. Connect an official OpenAI API key in Settings → Models & Providers, or enable an audio-capable Clodex model.';

const FALLBACK_LABELS: Record<DictationFallbackReason, string> = {
  'global-dictation-gate-disabled': 'Global dictation feature gate disabled',
  'official-openai-key-unavailable': 'Official OpenAI key unavailable',
  'webrtc-unavailable': 'WebRTC unavailable',
  'realtime-gate-disabled': 'Realtime feature gate disabled',
  'negotiation-failed': 'Realtime negotiation failed',
  'negotiation-timeout': 'Realtime negotiation timed out',
  'data-channel-open-timeout': 'Realtime data channel did not open',
  'realtime-runtime-failure': 'Realtime connection failed while recording',
  'final-transcript-timeout': 'Realtime final transcript timed out',
  'empty-final-transcript': 'Realtime final transcript was empty',
};

const MICROPHONE_TEST_FAILURE_LABELS: Record<
  DictationMicrophoneTestFailureReason,
  string
> = {
  'microphone-api-unavailable': 'Microphone capture API unavailable',
  'web-audio-unavailable': 'Web Audio API unavailable',
  'permission-denied': 'Microphone permission denied',
  'microphone-not-found': 'No microphone found',
  'microphone-unavailable': 'Microphone unavailable or busy',
  'microphone-test-runtime-failure': 'Local microphone test failed',
};

export function getDictationFallbackReasonLabel(
  reason: DictationFallbackReason,
): string {
  return FALLBACK_LABELS[reason];
}

export function getDictationMicrophoneTestFailureLabel(
  reason: DictationMicrophoneTestFailureReason,
): string {
  return MICROPHONE_TEST_FAILURE_LABELS[reason];
}

export function getDictationRealtimePreflightFallback(input: {
  realtimeRequested: boolean;
  realtimeWebRtc: boolean;
  backend?: DictationBackendDiagnostics;
}): DictationFallbackReason | undefined {
  if (!input.realtimeRequested) return undefined;
  if (!input.realtimeWebRtc) return 'webrtc-unavailable';
  if (!input.backend) return 'negotiation-failed';
  if (!input.backend.globalDictationEnabled) {
    return 'global-dictation-gate-disabled';
  }
  if (!input.backend.realtimeDictationEnabled) {
    return 'realtime-gate-disabled';
  }
  if (!input.backend.officialOpenAIConfigured) {
    return 'official-openai-key-unavailable';
  }
  return undefined;
}

export function getDictationTranscriptionPreflightError(input: {
  realtimeRequested: boolean;
  realtimeWebRtc: boolean;
  backend: DictationBackendDiagnostics;
}): string | undefined {
  if (!input.backend.globalDictationEnabled) {
    return 'Global dictation is disabled in Preview Features.';
  }

  const realtimeReady =
    input.realtimeRequested &&
    input.realtimeWebRtc &&
    input.backend.realtimeDictationEnabled &&
    input.backend.officialOpenAIConfigured;
  if (!input.backend.batchTranscriptionReady && !realtimeReady) {
    return DICTATION_TRANSCRIPTION_UNAVAILABLE_MESSAGE;
  }
  return undefined;
}

/**
 * Produces a fixed-shape report that cannot include audio, SDP, transcript,
 * provider error bodies, API keys, request IDs or other arbitrary content.
 */
export function createRedactedDictationDiagnosticReport(
  input: DictationDiagnosticReportInput,
): string {
  return JSON.stringify(
    {
      version: 3,
      platform: input.platform,
      runtime: {
        microphoneCapture: input.runtime.microphoneCapture,
        mediaRecorder: input.runtime.mediaRecorder,
        webAudio: input.runtime.webAudio,
        batchRecording: input.runtime.batchRecording,
        realtimeWebRtc: input.runtime.realtimeWebRtc,
        recorderMimeType: input.runtime.recorderMimeType ?? null,
      },
      backend: input.backend
        ? {
            globalDictationEnabled: input.backend.globalDictationEnabled,
            realtimeDictationEnabled: input.backend.realtimeDictationEnabled,
            officialOpenAIConfigured: input.backend.officialOpenAIConfigured,
            batchTranscriptionReady: input.backend.batchTranscriptionReady,
            batchTranscriptionRoute: input.backend.batchTranscriptionRoute,
            batchTranscriptionUnavailableReason:
              input.backend.batchTranscriptionUnavailableReason ?? null,
          }
        : null,
      lastMicrophoneTest: input.lastMicrophoneTest
        ? {
            outcome: input.lastMicrophoneTest.outcome,
            durationMs: input.lastMicrophoneTest.durationMs ?? null,
            peakLevel: input.lastMicrophoneTest.peakLevel ?? null,
            failureReason: input.lastMicrophoneTest.failureReason ?? null,
          }
        : null,
      lastRealtimeConnectionTest: input.lastRealtimeConnectionTest
        ? {
            outcome: input.lastRealtimeConnectionTest.outcome,
            latencyMs: input.lastRealtimeConnectionTest.latencyMs ?? null,
            failureReason:
              input.lastRealtimeConnectionTest.failureReason ?? null,
          }
        : null,
      lastSession: input.lastSession
        ? {
            outcome: input.lastSession.outcome,
            requestedTransport: input.lastSession.requestedTransport,
            finalTransport: input.lastSession.finalTransport,
            recorderMimeType: input.lastSession.recorderMimeType ?? null,
            negotiationLatencyMs:
              input.lastSession.negotiationLatencyMs ?? null,
            firstDeltaLatencyMs: input.lastSession.firstDeltaLatencyMs ?? null,
            finalizationLatencyMs:
              input.lastSession.finalizationLatencyMs ?? null,
            recordingDurationMs: input.lastSession.recordingDurationMs ?? null,
            fallbackReason: input.lastSession.fallbackReason ?? null,
          }
        : null,
    },
    null,
    2,
  );
}
