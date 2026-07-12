import { describe, expect, it } from 'vitest';
import {
  dictationTranscriptionInputSchema,
  INITIAL_DICTATION_STATE,
  reduceDictationState,
} from './dictation';

describe('dictation state machine', () => {
  it('follows the permission, recording, transcription, and completion path', () => {
    const requesting = reduceDictationState(INITIAL_DICTATION_STATE, {
      type: 'request-permission',
    });
    const recording = reduceDictationState(requesting, {
      type: 'permission-granted',
      startedAt: 1_000,
    });
    const transcribing = reduceDictationState(recording, {
      type: 'stop',
      durationMs: 2_500,
    });
    const completed = reduceDictationState(transcribing, {
      type: 'completed',
      transcript: 'Hello world.',
    });

    expect(requesting).toEqual({ status: 'requesting-permission' });
    expect(recording).toEqual({
      status: 'recording',
      startedAt: 1_000,
      transport: 'batch',
    });
    expect(transcribing).toEqual({
      status: 'transcribing',
      durationMs: 2_500,
      transport: 'batch',
    });
    expect(completed).toEqual({
      status: 'completed',
      transcript: 'Hello world.',
      durationMs: 2_500,
      transport: 'batch',
    });
  });

  it('only retries failures that retain an audio recording', () => {
    const retryable = reduceDictationState(
      {
        status: 'failed',
        error: 'Network unavailable',
        retryable: true,
        durationMs: 1_500,
      },
      { type: 'retry' },
    );
    const permissionFailure = reduceDictationState(
      {
        status: 'failed',
        error: 'Microphone permission denied',
        retryable: false,
      },
      { type: 'retry' },
    );

    expect(retryable).toEqual({
      status: 'transcribing',
      durationMs: 1_500,
      transport: 'batch',
    });
    expect(permissionFailure.status).toBe('failed');
  });

  it('ignores invalid transitions and supports reset from every state', () => {
    expect(
      reduceDictationState(INITIAL_DICTATION_STATE, {
        type: 'permission-granted',
        startedAt: 1,
      }),
    ).toBe(INITIAL_DICTATION_STATE);
    expect(
      reduceDictationState(
        {
          status: 'recording',
          startedAt: 1,
          transport: 'batch',
        },
        { type: 'reset' },
      ),
    ).toEqual({ status: 'idle' });
  });

  it('tracks realtime partial text without mutating completed draft content', () => {
    const recording = reduceDictationState(
      {
        status: 'recording',
        startedAt: 1_000,
        transport: 'batch',
      },
      { type: 'transport-selected', transport: 'realtime' },
    );
    const partial = reduceDictationState(recording, {
      type: 'partial-transcript',
      transcript: 'Streaming words',
    });
    const stopped = reduceDictationState(partial, {
      type: 'stop',
      durationMs: 2_000,
    });

    expect(partial).toMatchObject({
      status: 'recording',
      transport: 'realtime',
      partialTranscript: 'Streaming words',
    });
    expect(stopped).toMatchObject({
      status: 'transcribing',
      transport: 'realtime',
      partialTranscript: 'Streaming words',
    });
  });
});

describe('dictation transcription input', () => {
  it('normalizes MediaRecorder codec parameters', () => {
    const parsed = dictationTranscriptionInputSchema.parse({
      requestId: 'request-1',
      audioBase64: 'YWJj',
      mediaType: 'audio/webm;codecs=opus',
      durationMs: 1_000,
    });

    expect(parsed.mediaType).toBe('audio/webm');
  });

  it('rejects unsupported media and overlong recordings', () => {
    expect(() =>
      dictationTranscriptionInputSchema.parse({
        requestId: 'request-1',
        audioBase64: 'YWJj',
        mediaType: 'video/webm',
        durationMs: 1_000,
      }),
    ).toThrow();
    expect(() =>
      dictationTranscriptionInputSchema.parse({
        requestId: 'request-1',
        audioBase64: 'YWJj',
        mediaType: 'audio/webm',
        durationMs: 120_001,
      }),
    ).toThrow();
  });
});
