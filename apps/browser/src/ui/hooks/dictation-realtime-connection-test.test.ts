import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRealtimeConnectionDiagnosticTest } from './dictation-realtime-connection-test';

class FakeDataChannel extends EventTarget {
  public readyState: RTCDataChannelState = 'connecting';

  public open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  public close(): void {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  public static latest: FakePeerConnection | null = null;
  public readonly dataChannel = new FakeDataChannel();
  public connectionState: RTCPeerConnectionState = 'new';

  public constructor() {
    FakePeerConnection.latest = this;
  }

  public createDataChannel(): RTCDataChannel {
    return this.dataChannel as unknown as RTCDataChannel;
  }

  public addTransceiver(): RTCRtpTransceiver {
    return {} as RTCRtpTransceiver;
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\ns=diagnostic-offer\r\n' };
  }

  public async setLocalDescription(): Promise<void> {}

  public async setRemoteDescription(): Promise<void> {
    this.connectionState = 'connected';
    this.dataChannel.open();
  }

  public close(): void {
    this.connectionState = 'closed';
    this.dataChannel.close();
  }
}

const runtimeSupport = {
  microphoneCapture: true,
  mediaRecorder: true,
  webAudio: true,
  batchRecording: true,
  realtimeWebRtc: true,
  recorderMimeType: 'audio/webm;codecs=opus',
};

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal(
    'RTCPeerConnection',
    FakePeerConnection as unknown as typeof RTCPeerConnection,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakePeerConnection.latest = null;
});

describe('realtime connection diagnostic test', () => {
  it('checks readiness, negotiates, measures latency, and closes immediately', async () => {
    const negotiate = vi.fn(async (input: { requestId: string }) => ({
      requestId: input.requestId,
      answerSdp: 'v=0\r\ns=diagnostic-answer\r\n',
      modelId: 'gpt-realtime-whisper' as const,
    }));
    const operation = startRealtimeConnectionDiagnosticTest({
      runtimeSupport,
      getDiagnostics: async () => ({
        globalDictationEnabled: true,
        realtimeDictationEnabled: true,
        officialOpenAIConfigured: true,
        batchTranscriptionReady: true,
        batchTranscriptionRoute: 'official-openai',
      }),
      negotiate,
      cancelRemote: vi.fn(async () => undefined),
      requestId: 'diagnostic-1',
    });

    await expect(operation.result).resolves.toMatchObject({
      outcome: 'connected',
      latencyMs: expect.any(Number),
    });
    expect(negotiate).toHaveBeenCalledOnce();
    expect(FakePeerConnection.latest?.connectionState).toBe('closed');
  });

  it('returns a typed not-ready result without negotiating', async () => {
    const negotiate = vi.fn();
    const operation = startRealtimeConnectionDiagnosticTest({
      runtimeSupport,
      getDiagnostics: async () => ({
        globalDictationEnabled: true,
        realtimeDictationEnabled: true,
        officialOpenAIConfigured: false,
        batchTranscriptionReady: false,
        batchTranscriptionRoute: null,
      }),
      negotiate,
      cancelRemote: vi.fn(async () => undefined),
    });

    await expect(operation.result).resolves.toEqual({
      outcome: 'not-ready',
      failureReason: 'official-openai-key-unavailable',
    });
    expect(negotiate).not.toHaveBeenCalled();
  });

  it('cancels backend negotiation and reports cancellation', async () => {
    let startNegotiation: (() => void) | undefined;
    const negotiationStarted = new Promise<void>((resolve) => {
      startNegotiation = resolve;
    });
    const cancelRemote = vi.fn(async () => undefined);
    const operation = startRealtimeConnectionDiagnosticTest({
      runtimeSupport,
      getDiagnostics: async () => ({
        globalDictationEnabled: true,
        realtimeDictationEnabled: true,
        officialOpenAIConfigured: true,
        batchTranscriptionReady: true,
        batchTranscriptionRoute: 'official-openai',
      }),
      negotiate: async () => {
        startNegotiation?.();
        return await new Promise(() => undefined);
      },
      cancelRemote,
      requestId: 'diagnostic-cancel',
    });
    await negotiationStarted;

    operation.cancel();

    await expect(operation.result).resolves.toEqual({
      outcome: 'cancelled',
    });
    expect(cancelRemote).toHaveBeenCalledWith('diagnostic-cancel');
    expect(FakePeerConnection.latest?.connectionState).toBe('closed');
  });

  it('settles cancellation while readiness lookup is still pending', async () => {
    const cancelRemote = vi.fn(async () => undefined);
    const operation = startRealtimeConnectionDiagnosticTest({
      runtimeSupport,
      getDiagnostics: async () => await new Promise(() => undefined),
      negotiate: vi.fn(),
      cancelRemote,
      requestId: 'diagnostic-readiness-cancel',
    });

    operation.cancel();

    await expect(operation.result).resolves.toEqual({
      outcome: 'cancelled',
    });
    expect(cancelRemote).toHaveBeenCalledWith('diagnostic-readiness-cancel');
    expect(FakePeerConnection.latest).toBeNull();
  });
});
