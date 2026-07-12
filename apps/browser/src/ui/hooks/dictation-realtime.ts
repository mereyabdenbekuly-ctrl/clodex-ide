import type {
  DictationRealtimeNegotiationInput,
  DictationRealtimeNegotiationResult,
} from '@shared/dictation';
import type { DictationFallbackReason } from '@shared/dictation-diagnostics';
import {
  parseRealtimeServerEvent,
  RealtimeTranscriptAssembler,
} from '@shared/dictation-realtime';

const NEGOTIATION_TIMEOUT_MS = 8_000;
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 5_000;
const FINAL_TRANSCRIPT_TIMEOUT_MS = 15_000;

export interface RealtimeDictationSession {
  finish: () => Promise<string>;
  close: () => void;
}

export interface TestRealtimeDictationConnectionOptions {
  requestId: string;
  negotiate: (
    input: DictationRealtimeNegotiationInput,
  ) => Promise<DictationRealtimeNegotiationResult>;
  signal?: AbortSignal;
}

export interface StartRealtimeDictationSessionOptions {
  stream: MediaStream;
  requestId: string;
  negotiate: (
    input: DictationRealtimeNegotiationInput,
  ) => Promise<DictationRealtimeNegotiationResult>;
  onPartialTranscript: (transcript: string) => void;
  onFailure: (reason: DictationFallbackReason) => void;
}

export class RealtimeDictationTransportError extends Error {
  public constructor(
    public readonly reason: DictationFallbackReason,
    message: string,
  ) {
    super(message);
    this.name = 'RealtimeDictationTransportError';
  }
}

export function getRealtimeDictationFailureReason(
  error: unknown,
  fallback: DictationFallbackReason = 'realtime-runtime-failure',
): DictationFallbackReason {
  return error instanceof RealtimeDictationTransportError
    ? error.reason
    : fallback;
}

/**
 * Verifies the renderer-to-provider WebRTC path without requesting microphone
 * access. A send-only audio transceiver creates the expected SDP media section,
 * but no local MediaStreamTrack is attached and no audio is sent.
 */
export async function testRealtimeDictationConnection({
  requestId,
  negotiate,
  signal,
}: TestRealtimeDictationConnectionOptions): Promise<{ latencyMs: number }> {
  const startedAt = performance.now();
  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel('oai-events');
  let closed = false;
  const closeResources = () => {
    if (closed) return;
    closed = true;
    if (dataChannel.readyState !== 'closed') dataChannel.close();
    peerConnection.close();
  };
  const handleAbort = () => closeResources();
  signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    throwIfAborted(signal);
    peerConnection.addTransceiver('audio', { direction: 'sendonly' });
    const offer = await peerConnection.createOffer();
    throwIfAborted(signal);
    await peerConnection.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error('WebRTC did not produce an SDP offer');
    }
    const answer = await withTimeout(
      negotiate({
        requestId,
        offerSdp: offer.sdp,
      }),
      NEGOTIATION_TIMEOUT_MS,
      'negotiation-timeout',
      'Realtime negotiation timed out',
      signal,
    );
    throwIfAborted(signal);
    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answer.answerSdp,
    });
    await waitForDataChannelOpen(
      dataChannel,
      DATA_CHANNEL_OPEN_TIMEOUT_MS,
      signal,
    );
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof RealtimeDictationTransportError) throw error;
    throw new RealtimeDictationTransportError(
      'negotiation-failed',
      error instanceof Error ? error.message : 'Realtime negotiation failed',
    );
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    closeResources();
  }
}

export async function startRealtimeDictationSession({
  stream,
  requestId,
  negotiate,
  onPartialTranscript,
  onFailure,
}: StartRealtimeDictationSessionOptions): Promise<RealtimeDictationSession> {
  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel('oai-events');
  const assembler = new RealtimeTranscriptAssembler();
  let closed = false;
  let ready = false;
  let finishRequested = false;
  let finalSettled = false;
  let committedItemId: string | undefined;
  let failureReported = false;
  let resolveFinal: ((transcript: string) => void) | undefined;
  let rejectFinal: ((error: Error) => void) | undefined;
  const finalTranscript = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  void finalTranscript.catch(() => undefined);

  const closeResources = () => {
    if (closed) return;
    closed = true;
    dataChannel.onopen = null;
    dataChannel.onmessage = null;
    dataChannel.onerror = null;
    dataChannel.onclose = null;
    peerConnection.onconnectionstatechange = null;
    if (dataChannel.readyState !== 'closed') dataChannel.close();
    peerConnection.close();
  };

  const fail = (
    reason: DictationFallbackReason = 'realtime-runtime-failure',
  ) => {
    if (closed) return;
    if (finalSettled) {
      closeResources();
      return;
    }
    rejectFinal?.(new Error('Realtime transcription failed.'));
    closeResources();
    if (ready && !failureReported) {
      failureReported = true;
      onFailure(reason);
    }
  };

  dataChannel.onmessage = (message) => {
    const snapshot = assembler.consume(parseRealtimeServerEvent(message.data));
    onPartialTranscript(snapshot.partialTranscript);
    if (snapshot.committedItemId) {
      committedItemId = snapshot.committedItemId;
    }
    if (snapshot.error) {
      fail();
      return;
    }
    if (
      finishRequested &&
      snapshot.completedItem &&
      (!committedItemId || snapshot.completedItem.itemId === committedItemId)
    ) {
      finalSettled = true;
      resolveFinal?.(snapshot.completedItem.transcript);
    }
  };
  dataChannel.onerror = () => fail();
  dataChannel.onclose = () => {
    if (!closed) fail();
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'failed') fail();
  };

  try {
    for (const track of stream.getAudioTracks()) {
      peerConnection.addTrack(track, stream);
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error('WebRTC did not produce an SDP offer');
    }
    const answer = await withTimeout(
      negotiate({
        requestId,
        offerSdp: offer.sdp,
      }),
      NEGOTIATION_TIMEOUT_MS,
      'negotiation-timeout',
      'Realtime negotiation timed out',
    );
    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answer.answerSdp,
    });
    await waitForDataChannelOpen(dataChannel, DATA_CHANNEL_OPEN_TIMEOUT_MS);
    ready = true;
  } catch (error) {
    closeResources();
    if (error instanceof RealtimeDictationTransportError) throw error;
    throw new RealtimeDictationTransportError(
      'negotiation-failed',
      error instanceof Error ? error.message : 'Realtime negotiation failed',
    );
  }

  return {
    finish: async () => {
      if (closed || dataChannel.readyState !== 'open') {
        throw new Error('Realtime transcription is not connected');
      }
      finishRequested = true;
      dataChannel.send(
        JSON.stringify({
          event_id: `dictation_commit_${crypto.randomUUID()}`,
          type: 'input_audio_buffer.commit',
        }),
      );
      const transcript = await withTimeout(
        finalTranscript,
        FINAL_TRANSCRIPT_TIMEOUT_MS,
        'final-transcript-timeout',
        'Realtime final transcript timed out',
      );
      if (!transcript.trim()) {
        throw new RealtimeDictationTransportError(
          'empty-final-transcript',
          'Realtime transcription returned empty text',
        );
      }
      return transcript.trim();
    },
    close: () => {
      if (!finalSettled) {
        rejectFinal?.(new Error('Realtime transcription was closed'));
      }
      closeResources();
    },
  };
}

function waitForDataChannelOpen(
  dataChannel: RTCDataChannel,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (dataChannel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new RealtimeDictationTransportError(
          'data-channel-open-timeout',
          'Realtime data channel did not open',
        ),
      );
    }, timeoutMs);
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(
        new RealtimeDictationTransportError(
          'negotiation-failed',
          'Realtime data channel closed before opening',
        ),
      );
    };
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      dataChannel.removeEventListener('open', handleOpen);
      dataChannel.removeEventListener('close', handleClose);
      signal?.removeEventListener('abort', handleAbort);
    };
    dataChannel.addEventListener('open', handleOpen, { once: true });
    dataChannel.addEventListener('close', handleClose, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason: DictationFallbackReason,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new RealtimeDictationTransportError(reason, message));
    }, timeoutMs);
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Realtime connection test cancelled');
  error.name = 'AbortError';
  return error;
}

export function isRealtimeDictationAbortError(error: unknown): boolean {
  return isAbortError(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}
