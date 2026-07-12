import { generateText } from 'ai';
import {
  getAvailableModel,
  getModelAlias,
  type ModelId,
} from '@shared/available-models';
import {
  dictationRealtimeNegotiationInputSchema,
  dictationTranscriptionInputSchema,
  MAX_DICTATION_AUDIO_BYTES,
  MAX_DICTATION_REALTIME_SDP_LENGTH,
  type DictationBackendDiagnostics,
  type DictationMediaType,
  type DictationRealtimeNegotiationInput,
  type DictationRealtimeNegotiationResult,
  type DictationTranscriptionInput,
  type DictationTranscriptionResult,
} from '@shared/dictation';
import type { FeatureGateId } from '@shared/feature-gates';
import {
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
} from '@clodex/agent-core/host';
import type { ModelProviderService } from '../agents/model-provider';
import { DisposableService } from './disposable';
import type { KartonService } from './karton';
import type { Logger } from './logger';

const PROCEDURE_NAMES = [
  'dictation.getDiagnostics',
  'dictation.negotiateRealtime',
  'dictation.transcribe',
  'dictation.cancel',
] as const;
const OFFICIAL_OPENAI_TRANSCRIPTION_MODEL_ID =
  'gpt-4o-mini-transcribe' as const;
const REALTIME_DICTATION_MODEL_ID = 'gpt-realtime-whisper' as const;
const MAX_CONCURRENT_TRANSCRIPTIONS = 2;

interface DecodedDictationInput {
  requestId: string;
  audio: Buffer;
  mediaType: DictationMediaType;
  durationMs: number;
  preferredModelId?: string;
}

type DictationTranscriber = (
  input: DecodedDictationInput,
  signal: AbortSignal,
) => Promise<{ text: string; modelId: string }>;

type DictationRealtimeNegotiator = (
  input: DictationRealtimeNegotiationInput,
  signal: AbortSignal,
) => Promise<DictationRealtimeNegotiationResult>;

export interface DictationServiceOptions {
  logger: Logger;
  karton: KartonService;
  modelProvider: ModelProviderService;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  transcriber?: DictationTranscriber;
  realtimeNegotiator?: DictationRealtimeNegotiator;
}

/**
 * Content-minimizing STT bridge.
 *
 * Audio is accepted as an in-memory buffer, sent to one audio-capable model,
 * and never written to disk by this service. Logs contain only byte/duration
 * metadata and the selected model id, never audio or transcript content.
 */
export class DictationService extends DisposableService {
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly activeRealtimeRequests = new Map<string, AbortController>();
  private readonly transcriber: DictationTranscriber;
  private readonly realtimeNegotiator: DictationRealtimeNegotiator;

  private constructor(private readonly options: DictationServiceOptions) {
    super();
    this.transcriber =
      options.transcriber ??
      createModelDictationTranscriber(options.modelProvider, options.logger);
    this.realtimeNegotiator =
      options.realtimeNegotiator ??
      createOpenAIRealtimeNegotiator(options.modelProvider, options.logger);
  }

  public static create(options: DictationServiceOptions): DictationService {
    const service = new DictationService(options);
    service.registerProcedures();
    return service;
  }

  private registerProcedures(): void {
    this.options.karton.registerServerProcedureHandler(
      'dictation.getDiagnostics',
      async () => {
        return this.getDiagnostics();
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'dictation.negotiateRealtime',
      async (_clientId, input: DictationRealtimeNegotiationInput) => {
        return await this.negotiateRealtime(input);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'dictation.transcribe',
      async (_clientId, input: DictationTranscriptionInput) => {
        return await this.transcribe(input);
      },
    );
    this.options.karton.registerServerProcedureHandler(
      'dictation.cancel',
      async (_clientId, requestId: string) => {
        const normalizedRequestId = normalizeRequestId(requestId);
        this.activeRequests.get(normalizedRequestId)?.abort();
        this.activeRealtimeRequests.get(normalizedRequestId)?.abort();
      },
    );
  }

  private getDiagnostics(): DictationBackendDiagnostics {
    const officialRealtimeEndpoint =
      this.options.modelProvider.getOfficialOpenAIRealtimeEndpoint();
    const officialTranscriptionEndpoint =
      this.options.modelProvider.getOfficialOpenAITranscriptionEndpoint?.() ??
      officialRealtimeEndpoint;
    const audioCapableModelIds =
      this.options.modelProvider.getAudioCapableModelIds?.() ?? [];
    const batchTranscriptionRoute = officialTranscriptionEndpoint
      ? 'official-openai'
      : audioCapableModelIds.length > 0
        ? 'audio-capable-model'
        : this.options.transcriber
          ? 'custom'
          : null;
    return {
      globalDictationEnabled: this.options.isFeatureEnabled('global-dictation'),
      realtimeDictationEnabled:
        this.options.isFeatureEnabled('realtime-dictation'),
      officialOpenAIConfigured: Boolean(officialRealtimeEndpoint),
      batchTranscriptionReady: batchTranscriptionRoute !== null,
      batchTranscriptionRoute,
      ...(batchTranscriptionRoute
        ? {}
        : {
            batchTranscriptionUnavailableReason:
              'no-transcription-route' as const,
          }),
    };
  }

  private async negotiateRealtime(
    rawInput: DictationRealtimeNegotiationInput,
  ): Promise<DictationRealtimeNegotiationResult> {
    this.assertRealtimeEnabled();
    const input = dictationRealtimeNegotiationInputSchema.parse(rawInput);
    if (
      this.activeRequests.has(input.requestId) ||
      this.activeRealtimeRequests.has(input.requestId)
    ) {
      throw new Error('A dictation request with this id is already running');
    }
    if (this.activeRealtimeRequests.size >= MAX_CONCURRENT_TRANSCRIPTIONS) {
      throw new Error(
        'Too many realtime dictation requests are already running',
      );
    }

    const controller = new AbortController();
    this.activeRealtimeRequests.set(input.requestId, controller);
    this.options.logger.debug(
      '[Dictation] Negotiating realtime WebRTC session',
    );
    try {
      const result = await this.realtimeNegotiator(input, controller.signal);
      if (
        !result.answerSdp.trim() ||
        result.answerSdp.length > MAX_DICTATION_REALTIME_SDP_LENGTH
      ) {
        throw new Error(
          'Realtime transcription returned an invalid SDP answer',
        );
      }
      return result;
    } finally {
      this.activeRealtimeRequests.delete(input.requestId);
    }
  }

  private async transcribe(
    rawInput: DictationTranscriptionInput,
  ): Promise<DictationTranscriptionResult> {
    this.assertEnabled();
    const input = dictationTranscriptionInputSchema.parse(rawInput);
    if (this.activeRequests.has(input.requestId)) {
      throw new Error('A dictation request with this id is already running');
    }
    if (this.activeRequests.size >= MAX_CONCURRENT_TRANSCRIPTIONS) {
      throw new Error('Too many dictation requests are already running');
    }
    const audio = decodeAudioBase64(input.audioBase64);
    if (audio.byteLength === 0) {
      throw new Error('Recorded audio is empty');
    }
    if (audio.byteLength > MAX_DICTATION_AUDIO_BYTES) {
      throw new Error('Recorded audio exceeds the 20 MB limit');
    }

    const controller = new AbortController();
    this.activeRequests.set(input.requestId, controller);
    this.options.logger.debug(
      `[Dictation] Transcribing ${audio.byteLength} byte(s), duration=${input.durationMs}ms`,
    );
    try {
      const result = await this.transcriber(
        {
          requestId: input.requestId,
          audio,
          mediaType: input.mediaType,
          durationMs: input.durationMs,
          preferredModelId: input.preferredModelId,
        },
        controller.signal,
      );
      const text = normalizeTranscript(result.text);
      if (!text) {
        throw new Error('No intelligible speech was detected');
      }
      this.options.logger.debug(
        `[Dictation] Transcription complete with ${result.modelId}`,
      );
      return {
        requestId: input.requestId,
        text,
        modelId: result.modelId,
      };
    } finally {
      this.activeRequests.delete(input.requestId);
    }
  }

  private assertEnabled(): void {
    if (!this.options.isFeatureEnabled('global-dictation')) {
      throw new Error('Global dictation preview feature is disabled');
    }
  }

  private assertRealtimeEnabled(): void {
    this.assertEnabled();
    if (!this.options.isFeatureEnabled('realtime-dictation')) {
      throw new Error('Realtime dictation experimental feature is disabled');
    }
  }

  protected onTeardown(): void {
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
    for (const controller of this.activeRealtimeRequests.values()) {
      controller.abort();
    }
    this.activeRealtimeRequests.clear();
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
  }
}

function createOpenAIRealtimeNegotiator(
  modelProvider: ModelProviderService,
  logger: Logger,
): DictationRealtimeNegotiator {
  return async (input, signal) => {
    const endpoint = modelProvider.getOfficialOpenAIRealtimeEndpoint();
    if (!endpoint) {
      throw new Error(
        'Realtime dictation requires a connected official OpenAI API key',
      );
    }

    const formData = new FormData();
    formData.set('sdp', input.offerSdp);
    formData.set(
      'session',
      JSON.stringify({
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: REALTIME_DICTATION_MODEL_ID,
              delay: 'low',
            },
            turn_detection: null,
          },
        },
      }),
    );

    const response = await fetch(`${endpoint.baseURL}/realtime/calls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: formData,
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Realtime transcription negotiation failed with HTTP ${response.status}`,
      );
    }
    const answerSdp = await response.text();
    logger.debug(
      `[Dictation] Realtime negotiation complete with ${REALTIME_DICTATION_MODEL_ID}`,
    );
    return {
      requestId: input.requestId,
      answerSdp,
      modelId: REALTIME_DICTATION_MODEL_ID,
    };
  };
}

function createModelDictationTranscriber(
  modelProvider: ModelProviderService,
  logger: Logger,
): DictationTranscriber {
  return async (input, signal) => {
    const officialEndpoint =
      modelProvider.getOfficialOpenAITranscriptionEndpoint();
    if (officialEndpoint) {
      return await transcribeWithOfficialOpenAI(
        input,
        signal,
        officialEndpoint,
        logger,
      );
    }

    const modelId = selectDictationModelId(
      input.preferredModelId,
      modelProvider.getAudioCapableModelIds(),
    );
    if (!modelId) {
      throw new Error(
        'Speech transcription is not configured. Connect an official OpenAI API key or enable an audio-capable Clodex model.',
      );
    }
    const traceId = `dictation:${input.requestId}`;
    const modelWithOptions = await modelProvider.getModelWithOptionsAsync(
      modelId as ModelId,
      traceId,
      {
        $ai_span_name: 'dictation-transcription',
        [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'dictation-transcription',
        [MODEL_TASK_ROLE_METADATA_KEY]: 'analysis',
        dictation_duration_ms: input.durationMs,
        dictation_audio_bytes: input.audio.byteLength,
      },
    );
    logger.debug(`[Dictation] Selected model ${modelId}`);

    const result = await generateText({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers: modelWithOptions.headers,
      abortSignal: signal,
      system: [
        'Transcribe the supplied audio into plain text.',
        'Preserve the spoken language; do not translate.',
        'Add natural punctuation and paragraph breaks.',
        'Do not add commentary, labels, Markdown fences, or a summary.',
        'Return only the transcript.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe this recording exactly as spoken.',
            },
            {
              type: 'file',
              data: input.audio,
              mediaType: input.mediaType,
              filename: `dictation.${extensionForMediaType(input.mediaType)}`,
            },
          ],
        },
      ],
      temperature: 0,
      maxOutputTokens: 4_096,
      maxRetries: 1,
    });

    return {
      text: result.text,
      modelId,
    };
  };
}

async function transcribeWithOfficialOpenAI(
  input: DecodedDictationInput,
  signal: AbortSignal,
  endpoint: {
    apiKey: string;
    baseURL: 'https://api.openai.com/v1';
  },
  logger: Logger,
): Promise<{ text: string; modelId: string }> {
  const formData = new FormData();
  formData.set('model', OFFICIAL_OPENAI_TRANSCRIPTION_MODEL_ID);
  formData.set('response_format', 'json');
  formData.set(
    'file',
    new Blob([new Uint8Array(input.audio)], { type: input.mediaType }),
    `dictation.${extensionForMediaType(input.mediaType)}`,
  );

  const response = await fetch(`${endpoint.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: formData,
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Official OpenAI transcription failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as unknown;
  const text =
    typeof body === 'object' &&
    body !== null &&
    'text' in body &&
    typeof body.text === 'string'
      ? body.text
      : '';
  if (!text.trim()) {
    throw new Error('Official OpenAI transcription returned no text');
  }
  logger.debug(
    `[Dictation] Transcription complete with ${OFFICIAL_OPENAI_TRANSCRIPTION_MODEL_ID}`,
  );
  return {
    text,
    modelId: OFFICIAL_OPENAI_TRANSCRIPTION_MODEL_ID,
  };
}

export function selectDictationModelId(
  preferredModelId: string | undefined,
  availableAudioModelIds: readonly string[],
): string | null {
  const availableByBareId = new Map(
    availableAudioModelIds.map((modelId) => [getBareModelId(modelId), modelId]),
  );
  if (preferredModelId && isAudioCapableModel(preferredModelId)) {
    const availablePreferred =
      availableAudioModelIds.find(
        (modelId) =>
          modelId === preferredModelId ||
          getBareModelId(modelId) === getBareModelId(preferredModelId),
      ) ?? null;
    if (availablePreferred) return availablePreferred;
  }
  for (const candidate of availableAudioModelIds) {
    if (isAudioCapableModel(candidate)) {
      return availableByBareId.get(getBareModelId(candidate)) ?? candidate;
    }
  }
  return null;
}

function isAudioCapableModel(modelId: string): boolean {
  const alias = getModelAlias(modelId);
  const resolvedModelId = alias?.targetModelId ?? modelId;
  const model =
    getAvailableModel(resolvedModelId) ??
    getAvailableModel(getBareModelId(resolvedModelId));
  return model?.capabilities.inputModalities.audio === true;
}

function getBareModelId(modelId: string): string {
  return modelId.split('/').pop() ?? modelId;
}

function decodeAudioBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Recorded audio has invalid base64 encoding');
  }
  return Buffer.from(value, 'base64');
}

function normalizeRequestId(value: string): string {
  const requestId = value.trim();
  if (!requestId || requestId.length > 128) {
    throw new Error('Invalid dictation request id');
  }
  return requestId;
}

function normalizeTranscript(value: string): string {
  let text = value.trim();
  text = text.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '');
  text = text.replace(/^transcript:\s*/i, '');
  return text.trim();
}

function extensionForMediaType(mediaType: DictationMediaType): string {
  switch (mediaType) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
      return 'wav';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
  }
}
