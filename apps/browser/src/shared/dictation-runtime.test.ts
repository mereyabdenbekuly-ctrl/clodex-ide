import { describe, expect, it } from 'vitest';
import {
  getDictationRuntimeSupport,
  getMicrophonePermissionError,
  normalizeRecorderMimeType,
  shouldClaimClodexUiFocus,
} from './dictation-runtime';

const chromiumProfiles = [
  {
    platform: 'macOS',
    supportedMimeTypes: ['audio/webm;codecs=opus', 'audio/webm'],
  },
  {
    platform: 'Windows',
    supportedMimeTypes: ['audio/webm;codecs=opus', 'audio/webm'],
  },
  {
    platform: 'Linux',
    supportedMimeTypes: ['audio/ogg;codecs=opus'],
  },
] as const;

describe('dictation cross-platform smoke matrix', () => {
  it.each(
    chromiumProfiles,
  )('enables batch and WebRTC paths on a capable $platform Chromium profile', ({
    supportedMimeTypes,
  }) => {
    const support = getDictationRuntimeSupport({
      hasGetUserMedia: true,
      hasMediaRecorder: true,
      hasRTCPeerConnection: true,
      hasAudioContext: true,
      isRecorderTypeSupported: (mimeType) =>
        (supportedMimeTypes as readonly string[]).includes(mimeType),
    });

    expect(support).toEqual({
      microphoneCapture: true,
      mediaRecorder: true,
      webAudio: true,
      batchRecording: true,
      realtimeWebRtc: true,
      recorderMimeType: supportedMimeTypes[0],
    });
  });

  it('keeps batch fallback available when WebRTC is absent', () => {
    expect(
      getDictationRuntimeSupport({
        hasGetUserMedia: true,
        hasMediaRecorder: true,
        hasRTCPeerConnection: false,
        hasAudioContext: false,
        isRecorderTypeSupported: () => false,
      }),
    ).toEqual({
      microphoneCapture: true,
      mediaRecorder: true,
      webAudio: false,
      batchRecording: true,
      realtimeWebRtc: false,
      recorderMimeType: undefined,
    });
  });

  it('normalizes recorder output consistently across codec variants', () => {
    expect(normalizeRecorderMimeType('audio/webm;codecs=opus')).toBe(
      'audio/webm',
    );
    expect(normalizeRecorderMimeType('audio/ogg; codecs=opus')).toBe(
      'audio/ogg',
    );
    expect(normalizeRecorderMimeType('unknown/container')).toBe('audio/webm');
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['NotFoundError', 'No microphone'],
    ['DevicesNotFoundError', 'No microphone'],
    ['NotReadableError', 'unavailable'],
    ['TrackStartError', 'unavailable'],
  ])('classifies %s without relying on a DOMException realm', (name, text) => {
    expect(getMicrophonePermissionError({ name })).toContain(text);
  });

  it('claims Clodex UI focus for enabled orb and Micro interactions only', () => {
    for (const interaction of [
      'orb-pointer',
      'orb-keyboard',
      'micro-pointer',
      'micro-keyboard',
    ] as const) {
      expect(shouldClaimClodexUiFocus(interaction, false)).toBe(true);
      expect(shouldClaimClodexUiFocus(interaction, true)).toBe(false);
    }
  });
});
