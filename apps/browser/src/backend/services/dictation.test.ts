import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KartonService } from './karton';
import type { Logger } from './logger';
import { DictationService, selectDictationModelId } from './dictation';

type Handler = (clientId: string, ...args: never[]) => Promise<unknown>;
type TestTranscriber = (
  input: { requestId: string; audio: Buffer },
  signal: AbortSignal,
) => Promise<{ text: string; modelId: string }>;
type TestRealtimeNegotiator = (
  input: { requestId: string; offerSdp: string },
  signal: AbortSignal,
) => Promise<{
  requestId: string;
  answerSdp: string;
  modelId: 'gpt-realtime-whisper';
}>;
const services: DictationService[] = [];

function createHarness(
  enabled: boolean | (() => boolean) = true,
  transcriberOverride?: TestTranscriber,
  realtimeNegotiatorOverride?: TestRealtimeNegotiator,
) {
  const handlers = new Map<string, Handler>();
  const karton = {
    registerServerProcedureHandler(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    removeServerProcedureHandler(name: string) {
      handlers.delete(name);
    },
  } as unknown as KartonService;
  const transcriber = vi.fn(
    transcriberOverride ??
      (async () => ({
        text: 'Transcript: Hello from audio.',
        modelId: 'gemini-3.5-flash',
      })),
  );
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const realtimeNegotiator = vi.fn(
    realtimeNegotiatorOverride ??
      (async (input: { requestId: string }) => ({
        requestId: input.requestId,
        answerSdp: 'v=0\\r\\ns=OpenAI Realtime\\r\\n',
        modelId: 'gpt-realtime-whisper' as const,
      })),
  );
  const service = DictationService.create({
    logger,
    karton,
    modelProvider: {} as never,
    isFeatureEnabled: () =>
      typeof enabled === 'function' ? enabled() : enabled,
    transcriber: transcriber as never,
    realtimeNegotiator: realtimeNegotiator as never,
  });
  services.push(service);
  return { handlers, realtimeNegotiator, transcriber };
}

afterEach(() => {
  for (const service of services.splice(0)) {
    service.teardown();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DictationService', () => {
  it('reports content-free backend readiness', async () => {
    const handlers = new Map<string, Handler>();
    const karton = {
      registerServerProcedureHandler(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      removeServerProcedureHandler(name: string) {
        handlers.delete(name);
      },
    } as unknown as KartonService;
    const service = DictationService.create({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
      karton,
      modelProvider: {
        getOfficialOpenAIRealtimeEndpoint: () => ({
          apiKey: 'must-not-escape',
          baseURL: 'https://api.openai.com/v1',
        }),
      } as never,
      isFeatureEnabled: (feature) => feature !== 'chronicle-visual-memory',
      transcriber: vi.fn() as never,
      realtimeNegotiator: vi.fn() as never,
    });
    services.push(service);

    const result = await handlers.get('dictation.getDiagnostics')!('client');

    expect(result).toEqual({
      globalDictationEnabled: true,
      realtimeDictationEnabled: true,
      officialOpenAIConfigured: true,
      batchTranscriptionReady: true,
      batchTranscriptionRoute: 'official-openai',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
  });

  it('validates and transcribes an in-memory audio buffer', async () => {
    const harness = createHarness();

    const result = await harness.handlers.get('dictation.transcribe')!(
      'client',
      {
        requestId: 'request-1',
        audioBase64: Buffer.from('audio-bytes').toString('base64'),
        mediaType: 'audio/webm;codecs=opus',
        durationMs: 1_500,
        preferredModelId: 'gemini-3.5-flash',
      } as never,
    );

    expect(harness.transcriber).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        audio: Buffer.from('audio-bytes'),
        mediaType: 'audio/webm',
        durationMs: 1_500,
      }),
      expect.any(AbortSignal),
    );
    expect(result).toEqual({
      requestId: 'request-1',
      text: 'Hello from audio.',
      modelId: 'gemini-3.5-flash',
    });
  });

  it('reports and rejects an account with no transcription route', async () => {
    const handlers = new Map<string, Handler>();
    const karton = {
      registerServerProcedureHandler(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      removeServerProcedureHandler(name: string) {
        handlers.delete(name);
      },
    } as unknown as KartonService;
    const service = DictationService.create({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
      karton,
      modelProvider: {
        getOfficialOpenAIRealtimeEndpoint: () => null,
        getOfficialOpenAITranscriptionEndpoint: () => null,
        getAudioCapableModelIds: () => [],
      } as never,
      isFeatureEnabled: () => true,
      realtimeNegotiator: vi.fn() as never,
    });
    services.push(service);

    await expect(
      handlers.get('dictation.getDiagnostics')!('client'),
    ).resolves.toEqual({
      globalDictationEnabled: true,
      realtimeDictationEnabled: true,
      officialOpenAIConfigured: false,
      batchTranscriptionReady: false,
      batchTranscriptionRoute: null,
      batchTranscriptionUnavailableReason: 'no-transcription-route',
    });
    await expect(
      handlers.get('dictation.transcribe')!('client', {
        requestId: 'no-route',
        audioBase64: Buffer.from('audio-bytes').toString('base64'),
        mediaType: 'audio/webm',
        durationMs: 1_000,
      } as never),
    ).rejects.toThrow('Speech transcription is not configured');
  });

  it('rechecks the feature gate and rejects invalid base64', async () => {
    const disabled = createHarness(false);
    await expect(
      disabled.handlers.get('dictation.transcribe')!('client', {
        requestId: 'request-1',
        audioBase64: 'YWJj',
        mediaType: 'audio/webm',
        durationMs: 1_000,
      } as never),
    ).rejects.toThrow('preview feature is disabled');

    const enabled = createHarness(true);
    await expect(
      enabled.handlers.get('dictation.transcribe')!('client', {
        requestId: 'request-2',
        audioBase64: '**invalid**',
        mediaType: 'audio/webm',
        durationMs: 1_000,
      } as never),
    ).rejects.toThrow('invalid base64');
    expect(enabled.transcriber).not.toHaveBeenCalled();
  });

  it('allows an in-flight transcription to be cancelled after the gate closes', async () => {
    let featureEnabled = true;
    let transcriptionSignal: AbortSignal | undefined;
    const harness = createHarness(
      () => featureEnabled,
      async (_input, signal) => {
        transcriptionSignal = signal;
        return await new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('transcription cancelled')),
            { once: true },
          );
        });
      },
    );

    const transcription = harness.handlers.get('dictation.transcribe')!(
      'client',
      {
        requestId: 'request-cancel',
        audioBase64: Buffer.from('audio-bytes').toString('base64'),
        mediaType: 'audio/webm',
        durationMs: 1_000,
      } as never,
    );
    await vi.waitFor(() => expect(transcriptionSignal).toBeDefined());

    featureEnabled = false;
    await harness.handlers.get('dictation.cancel')!(
      'client',
      'request-cancel' as never,
    );

    expect(transcriptionSignal?.aborted).toBe(true);
    await expect(transcription).rejects.toThrow('transcription cancelled');
  });

  it('negotiates realtime without exposing SDP in logs', async () => {
    const harness = createHarness();

    const result = await harness.handlers.get('dictation.negotiateRealtime')!(
      'client',
      {
        requestId: 'realtime-1',
        offerSdp: 'v=0\\r\\ns=private-offer\\r\\n',
      } as never,
    );

    expect(harness.realtimeNegotiator).toHaveBeenCalledWith(
      {
        requestId: 'realtime-1',
        offerSdp: 'v=0\\r\\ns=private-offer\\r\\n',
      },
      expect.any(AbortSignal),
    );
    expect(result).toEqual({
      requestId: 'realtime-1',
      answerSdp: 'v=0\\r\\ns=OpenAI Realtime\\r\\n',
      modelId: 'gpt-realtime-whisper',
    });
  });

  it('cancels an in-flight realtime negotiation', async () => {
    let negotiationSignal: AbortSignal | undefined;
    const harness = createHarness(true, undefined, async (_input, signal) => {
      negotiationSignal = signal;
      return await new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('negotiation cancelled')),
          { once: true },
        );
      });
    });

    const negotiation = harness.handlers.get('dictation.negotiateRealtime')!(
      'client',
      {
        requestId: 'realtime-cancel',
        offerSdp: 'v=0\\r\\n',
      } as never,
    );
    await vi.waitFor(() => expect(negotiationSignal).toBeDefined());
    await harness.handlers.get('dictation.cancel')!(
      'client',
      'realtime-cancel' as never,
    );

    expect(negotiationSignal?.aborted).toBe(true);
    await expect(negotiation).rejects.toThrow('negotiation cancelled');
  });

  it('keeps the OpenAI key in backend negotiation and sends a transcription session', async () => {
    const handlers = new Map<string, Handler>();
    const karton = {
      registerServerProcedureHandler(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      removeServerProcedureHandler(name: string) {
        handlers.delete(name);
      },
    } as unknown as KartonService;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('v=0\r\ns=official-answer\r\n', {
          status: 201,
          headers: { 'Content-Type': 'application/sdp' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = DictationService.create({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
      karton,
      modelProvider: {
        getOfficialOpenAIRealtimeEndpoint: () => ({
          apiKey: 'backend-only-key',
          baseURL: 'https://api.openai.com/v1',
        }),
      } as never,
      isFeatureEnabled: () => true,
      transcriber: vi.fn() as never,
    });
    services.push(service);

    await handlers.get('dictation.negotiateRealtime')!('client', {
      requestId: 'official-realtime',
      offerSdp: 'v=0\r\ns=private-offer\r\n',
    } as never);

    const [url, init] = fetchMock.mock.calls[0]!;
    const formData = init?.body as FormData;
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer backend-only-key',
    });
    expect(formData.get('sdp')).toBe('v=0\r\ns=private-offer\r\n');
    expect(JSON.parse(String(formData.get('session')))).toEqual({
      type: 'transcription',
      audio: {
        input: {
          transcription: {
            model: 'gpt-realtime-whisper',
            delay: 'low',
          },
          turn_detection: null,
        },
      },
    });
  });

  it('uses the official OpenAI audio transcription endpoint for batch dictation', async () => {
    const handlers = new Map<string, Handler>();
    const karton = {
      registerServerProcedureHandler(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      removeServerProcedureHandler(name: string) {
        handlers.delete(name);
      },
    } as unknown as KartonService;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ text: 'Hello from official transcription.' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = DictationService.create({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
      karton,
      modelProvider: {
        getOfficialOpenAIRealtimeEndpoint: () => null,
        getOfficialOpenAITranscriptionEndpoint: () => ({
          apiKey: 'official-batch-key',
          baseURL: 'https://api.openai.com/v1',
        }),
        getAudioCapableModelIds: () => [],
      } as never,
      isFeatureEnabled: () => true,
      realtimeNegotiator: vi.fn() as never,
    });
    services.push(service);

    const result = await handlers.get('dictation.transcribe')!('client', {
      requestId: 'official-batch',
      audioBase64: Buffer.from('audio-bytes').toString('base64'),
      mediaType: 'audio/webm',
      durationMs: 1_000,
    } as never);

    const [url, init] = fetchMock.mock.calls[0]!;
    const formData = init?.body as FormData;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer official-batch-key',
    });
    expect(formData.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(formData.get('file')).toBeInstanceOf(Blob);
    expect(result).toEqual({
      requestId: 'official-batch',
      text: 'Hello from official transcription.',
      modelId: 'gpt-4o-mini-transcribe',
    });
  });
});

describe('selectDictationModelId', () => {
  it('prefers an available audio-capable active model', () => {
    expect(selectDictationModelId('mimo-v2.5', ['mimo-v2.5'])).toBe(
      'mimo-v2.5',
    );
  });

  it('falls back from a text-only model and returns null when none exist', () => {
    expect(selectDictationModelId('claude-fable-5', ['gemini-3.5-flash'])).toBe(
      'gemini-3.5-flash',
    );
    expect(selectDictationModelId(undefined, [])).toBeNull();
  });

  it('accepts provider-prefixed audio model ids from account metadata', () => {
    expect(selectDictationModelId(undefined, ['xiaomi-mimo/mimo-v2.5'])).toBe(
      'xiaomi-mimo/mimo-v2.5',
    );
  });
});
