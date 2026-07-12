import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRealtimeDictationFailureReason,
  testRealtimeDictationConnection,
  startRealtimeDictationSession,
} from './dictation-realtime';

class FakeDataChannel extends EventTarget {
  public readyState: RTCDataChannelState = 'connecting';
  public onopen: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  public onmessage:
    | ((this: RTCDataChannel, ev: MessageEvent) => unknown)
    | null = null;
  public onerror:
    | ((this: RTCDataChannel, ev: RTCErrorEvent) => unknown)
    | null = null;
  public onclose: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  public emitMessage(event: unknown): void {
    this.onmessage?.call(
      this as unknown as RTCDataChannel,
      { data: JSON.stringify(event) } as MessageEvent,
    );
  }

  public emitError(): void {
    this.onerror?.call(
      this as unknown as RTCDataChannel,
      new Event('error') as RTCErrorEvent,
    );
  }

  public close(): void {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  public static latest: FakePeerConnection | null = null;
  public static openDataChannelOnRemote = true;
  public readonly dataChannel = new FakeDataChannel();
  public connectionState: RTCPeerConnectionState = 'new';
  public onconnectionstatechange:
    | ((this: RTCPeerConnection, ev: Event) => unknown)
    | null = null;

  public constructor() {
    FakePeerConnection.latest = this;
  }

  public createDataChannel(): RTCDataChannel {
    return this.dataChannel as unknown as RTCDataChannel;
  }

  public addTrack(): RTCRtpSender {
    return {} as RTCRtpSender;
  }

  public addTransceiver(): RTCRtpTransceiver {
    return {} as RTCRtpTransceiver;
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\ns=fake-offer\r\n' };
  }

  public async setLocalDescription(): Promise<void> {}

  public async setRemoteDescription(): Promise<void> {
    this.connectionState = 'connected';
    if (FakePeerConnection.openDataChannelOnRemote) {
      this.dataChannel.open();
    }
  }

  public close(): void {
    this.connectionState = 'closed';
    this.dataChannel.close();
  }
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal(
    'RTCPeerConnection',
    FakePeerConnection as unknown as typeof RTCPeerConnection,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakePeerConnection.latest = null;
  FakePeerConnection.openDataChannelOnRemote = true;
});

describe('realtime dictation WebRTC transport', () => {
  it('tests negotiation and data-channel readiness without a microphone track', async () => {
    const negotiate = vi.fn(async () => ({
      requestId: 'connection-test',
      answerSdp: 'v=0\r\ns=fake-answer\r\n',
      modelId: 'gpt-realtime-whisper' as const,
    }));

    await expect(
      testRealtimeDictationConnection({
        requestId: 'connection-test',
        negotiate,
      }),
    ).resolves.toMatchObject({
      latencyMs: expect.any(Number),
    });

    expect(negotiate).toHaveBeenCalledOnce();
    expect(FakePeerConnection.latest!.connectionState).toBe('closed');
  });

  it('cancels an in-flight connection test and closes WebRTC resources', async () => {
    const controller = new AbortController();
    const connection = testRealtimeDictationConnection({
      requestId: 'connection-cancel',
      negotiate: async () => await new Promise(() => undefined),
      signal: controller.signal,
    });
    const rejection = expect(connection).rejects.toMatchObject({
      name: 'AbortError',
    });

    controller.abort();

    await rejection;
    expect(FakePeerConnection.latest!.connectionState).toBe('closed');
  });

  it('negotiates SDP, streams partial text, commits, and returns final text', async () => {
    const partials: string[] = [];
    const negotiate = vi.fn(async () => ({
      requestId: 'request-1',
      answerSdp: 'v=0\r\ns=fake-answer\r\n',
      modelId: 'gpt-realtime-whisper' as const,
    }));
    const session = await startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-1',
      negotiate,
      onPartialTranscript: (transcript) => partials.push(transcript),
      onFailure: vi.fn(),
    });
    const channel = FakePeerConnection.latest!.dataChannel;

    channel.emitMessage({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Hello',
    });
    const finalTranscript = session.finish();
    channel.emitMessage({
      type: 'input_audio_buffer.committed',
      item_id: 'item-1',
    });
    channel.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Hello world.',
    });

    expect(negotiate).toHaveBeenCalledWith({
      requestId: 'request-1',
      offerSdp: 'v=0\r\ns=fake-offer\r\n',
    });
    expect(partials).toContain('Hello');
    expect(JSON.parse(channel.sent[0]!)).toMatchObject({
      type: 'input_audio_buffer.commit',
    });
    await expect(finalTranscript).resolves.toBe('Hello world.');
    session.close();
  });

  it('reports a runtime channel failure so the caller can use batch fallback', async () => {
    const onFailure = vi.fn();
    await startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-2',
      negotiate: async () => ({
        requestId: 'request-2',
        answerSdp: 'v=0\r\ns=fake-answer\r\n',
        modelId: 'gpt-realtime-whisper',
      }),
      onPartialTranscript: vi.fn(),
      onFailure,
    });

    FakePeerConnection.latest!.dataChannel.emitError();

    expect(onFailure).toHaveBeenCalledWith('realtime-runtime-failure');
    expect(FakePeerConnection.latest!.connectionState).toBe('closed');
  });

  it('classifies negotiation timeout for batch fallback', async () => {
    vi.useFakeTimers();
    const sessionPromise = startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-timeout',
      negotiate: async () => await new Promise(() => undefined),
      onPartialTranscript: vi.fn(),
      onFailure: vi.fn(),
    });
    const rejection = expect(sessionPromise).rejects.toMatchObject({
      reason: 'negotiation-timeout',
    });

    await vi.advanceTimersByTimeAsync(8_000);

    await rejection;
  });

  it('classifies data-channel open timeout', async () => {
    vi.useFakeTimers();
    FakePeerConnection.openDataChannelOnRemote = false;
    const sessionPromise = startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-channel-timeout',
      negotiate: async () => ({
        requestId: 'request-channel-timeout',
        answerSdp: 'v=0\r\ns=fake-answer\r\n',
        modelId: 'gpt-realtime-whisper',
      }),
      onPartialTranscript: vi.fn(),
      onFailure: vi.fn(),
    });
    const rejection = expect(sessionPromise).rejects.toMatchObject({
      reason: 'data-channel-open-timeout',
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
  });

  it('classifies final timeout and empty final text', async () => {
    vi.useFakeTimers();
    const timeoutSession = await startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-final-timeout',
      negotiate: async () => ({
        requestId: 'request-final-timeout',
        answerSdp: 'v=0\r\ns=fake-answer\r\n',
        modelId: 'gpt-realtime-whisper',
      }),
      onPartialTranscript: vi.fn(),
      onFailure: vi.fn(),
    });
    const timedOutFinal = timeoutSession.finish();
    const timeoutRejection = expect(timedOutFinal).rejects.toMatchObject({
      reason: 'final-transcript-timeout',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await timeoutRejection;
    timeoutSession.close();

    vi.useRealTimers();
    const emptySession = await startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-empty-final',
      negotiate: async () => ({
        requestId: 'request-empty-final',
        answerSdp: 'v=0\r\ns=fake-answer\r\n',
        modelId: 'gpt-realtime-whisper',
      }),
      onPartialTranscript: vi.fn(),
      onFailure: vi.fn(),
    });
    const emptyFinal = emptySession.finish();
    const emptyRejection = expect(emptyFinal).rejects.toMatchObject({
      reason: 'empty-final-transcript',
    });
    FakePeerConnection.latest!.dataChannel.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-empty',
      transcript: '   ',
    });

    await emptyRejection;
    expect(
      getRealtimeDictationFailureReason(await emptyFinal.catch((e) => e)),
    ).toBe('empty-final-transcript');
    emptySession.close();
  });

  it('closes an in-flight finalization without leaving WebRTC resources open', async () => {
    const session = await startRealtimeDictationSession({
      stream: {
        getAudioTracks: () => [{} as MediaStreamTrack],
      } as MediaStream,
      requestId: 'request-cancel-final',
      negotiate: async () => ({
        requestId: 'request-cancel-final',
        answerSdp: 'v=0\r\ns=fake-answer\r\n',
        modelId: 'gpt-realtime-whisper',
      }),
      onPartialTranscript: vi.fn(),
      onFailure: vi.fn(),
    });
    const finalization = session.finish();
    const rejection = expect(finalization).rejects.toThrow(
      'Realtime transcription was closed',
    );

    session.close();

    await rejection;
    expect(FakePeerConnection.latest!.connectionState).toBe('closed');
  });
});
