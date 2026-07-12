import { describe, expect, it } from 'vitest';
import {
  createRedactedDictationDiagnosticReport,
  getDictationFallbackReasonLabel,
  getDictationRealtimePreflightFallback,
  getDictationTranscriptionPreflightError,
} from './dictation-diagnostics';

describe('dictation diagnostics', () => {
  it('creates a fixed-shape redacted report', () => {
    const report = createRedactedDictationDiagnosticReport({
      platform: 'win32',
      runtime: {
        microphoneCapture: true,
        mediaRecorder: true,
        webAudio: true,
        batchRecording: true,
        realtimeWebRtc: true,
        recorderMimeType: 'audio/webm;codecs=opus',
      },
      backend: {
        globalDictationEnabled: true,
        realtimeDictationEnabled: true,
        officialOpenAIConfigured: true,
        batchTranscriptionReady: true,
        batchTranscriptionRoute: 'official-openai',
      },
      lastSession: {
        outcome: 'completed',
        requestedTransport: 'realtime',
        finalTransport: 'batch',
        fallbackReason: 'final-transcript-timeout',
        negotiationLatencyMs: 420,
        firstDeltaLatencyMs: 640,
        finalizationLatencyMs: 15_000,
        recordingDurationMs: 4_500,
      },
      lastMicrophoneTest: {
        outcome: 'passed',
        durationMs: 4_000,
        peakLevel: 78,
      },
      lastRealtimeConnectionTest: {
        outcome: 'connected',
        latencyMs: 520,
      },
    });

    expect(JSON.parse(report)).toMatchObject({
      version: 3,
      platform: 'win32',
      backend: {
        batchTranscriptionReady: true,
        batchTranscriptionRoute: 'official-openai',
      },
      lastMicrophoneTest: {
        outcome: 'passed',
        peakLevel: 78,
      },
      lastRealtimeConnectionTest: {
        outcome: 'connected',
        latencyMs: 520,
      },
      lastSession: {
        fallbackReason: 'final-transcript-timeout',
      },
    });
    for (const forbidden of [
      'transcript',
      'offerSdp',
      'answerSdp',
      'audioBase64',
      'apiKey',
      'requestId',
    ]) {
      expect(report).not.toContain(`"${forbidden}"`);
    }
  });

  it('provides user-facing labels for typed fallback reasons', () => {
    expect(getDictationFallbackReasonLabel('webrtc-unavailable')).toBe(
      'WebRTC unavailable',
    );
  });

  it('classifies WebRTC, gate and official-key preflight fallbacks', () => {
    expect(
      getDictationRealtimePreflightFallback({
        realtimeRequested: true,
        realtimeWebRtc: false,
      }),
    ).toBe('webrtc-unavailable');
    expect(
      getDictationRealtimePreflightFallback({
        realtimeRequested: true,
        realtimeWebRtc: true,
        backend: {
          globalDictationEnabled: false,
          realtimeDictationEnabled: true,
          officialOpenAIConfigured: true,
          batchTranscriptionReady: false,
          batchTranscriptionRoute: null,
          batchTranscriptionUnavailableReason: 'no-transcription-route',
        },
      }),
    ).toBe('global-dictation-gate-disabled');
    expect(
      getDictationRealtimePreflightFallback({
        realtimeRequested: true,
        realtimeWebRtc: true,
        backend: {
          globalDictationEnabled: true,
          realtimeDictationEnabled: false,
          officialOpenAIConfigured: true,
          batchTranscriptionReady: true,
          batchTranscriptionRoute: 'official-openai',
        },
      }),
    ).toBe('realtime-gate-disabled');
    expect(
      getDictationRealtimePreflightFallback({
        realtimeRequested: true,
        realtimeWebRtc: true,
        backend: {
          globalDictationEnabled: true,
          realtimeDictationEnabled: true,
          officialOpenAIConfigured: false,
          batchTranscriptionReady: true,
          batchTranscriptionRoute: 'audio-capable-model',
        },
      }),
    ).toBe('official-openai-key-unavailable');
  });

  it('blocks recording when neither realtime nor batch transcription is ready', () => {
    const backend = {
      globalDictationEnabled: true,
      realtimeDictationEnabled: true,
      officialOpenAIConfigured: false,
      batchTranscriptionReady: false,
      batchTranscriptionRoute: null,
      batchTranscriptionUnavailableReason: 'no-transcription-route' as const,
    };

    expect(
      getDictationTranscriptionPreflightError({
        realtimeRequested: false,
        realtimeWebRtc: true,
        backend,
      }),
    ).toContain('Speech transcription is not configured');
    expect(
      getDictationTranscriptionPreflightError({
        realtimeRequested: true,
        realtimeWebRtc: true,
        backend: {
          ...backend,
          officialOpenAIConfigured: true,
        },
      }),
    ).toBeUndefined();
  });
});
