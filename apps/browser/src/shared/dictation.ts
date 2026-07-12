import { z } from 'zod';

export const MAX_DICTATION_DURATION_MS = 120_000;
export const MAX_DICTATION_AUDIO_BYTES = 20 * 1024 * 1024;
export const MIN_DICTATION_DURATION_MS = 250;
export const MAX_DICTATION_REALTIME_SDP_LENGTH = 256 * 1024;

export const dictationMediaTypes = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/mpeg',
] as const;
export type DictationMediaType = (typeof dictationMediaTypes)[number];

const MAX_BASE64_LENGTH = Math.ceil((MAX_DICTATION_AUDIO_BYTES * 4) / 3) + 8;

export const dictationTranscriptionInputSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  audioBase64: z.string().min(1).max(MAX_BASE64_LENGTH),
  mediaType: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => value.split(';')[0]!.trim())
    .pipe(z.enum(dictationMediaTypes)),
  durationMs: z
    .number()
    .int()
    .min(MIN_DICTATION_DURATION_MS)
    .max(MAX_DICTATION_DURATION_MS),
  preferredModelId: z.string().trim().min(1).max(200).optional(),
});
export type DictationTranscriptionInput = z.infer<
  typeof dictationTranscriptionInputSchema
>;

export interface DictationTranscriptionResult {
  requestId: string;
  text: string;
  modelId: string;
}

export const dictationRealtimeNegotiationInputSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  offerSdp: z
    .string()
    .min(1)
    .max(MAX_DICTATION_REALTIME_SDP_LENGTH)
    .refine((value) => value.trim().length > 0, 'SDP offer is empty'),
});
export type DictationRealtimeNegotiationInput = z.infer<
  typeof dictationRealtimeNegotiationInputSchema
>;

export interface DictationRealtimeNegotiationResult {
  requestId: string;
  answerSdp: string;
  modelId: 'gpt-realtime-whisper';
}

export interface DictationBackendDiagnostics {
  globalDictationEnabled: boolean;
  realtimeDictationEnabled: boolean;
  officialOpenAIConfigured: boolean;
  batchTranscriptionReady: boolean;
  batchTranscriptionRoute:
    | 'official-openai'
    | 'audio-capable-model'
    | 'custom'
    | null;
  batchTranscriptionUnavailableReason?: 'no-transcription-route';
}

export type DictationTransport = 'batch' | 'realtime';

export type DictationState =
  | { status: 'idle' }
  | { status: 'requesting-permission' }
  | {
      status: 'recording';
      startedAt: number;
      transport: DictationTransport;
      partialTranscript?: string;
    }
  | {
      status: 'transcribing';
      durationMs: number;
      transport: DictationTransport;
      partialTranscript?: string;
    }
  | {
      status: 'completed';
      transcript: string;
      durationMs: number;
      transport: DictationTransport;
    }
  | {
      status: 'failed';
      error: string;
      retryable: boolean;
      durationMs?: number;
      transport?: DictationTransport;
    };

export type DictationEvent =
  | { type: 'request-permission' }
  | { type: 'permission-granted'; startedAt: number }
  | { type: 'transport-selected'; transport: DictationTransport }
  | { type: 'partial-transcript'; transcript: string }
  | { type: 'stop'; durationMs: number }
  | { type: 'completed'; transcript: string }
  | {
      type: 'failed';
      error: string;
      retryable: boolean;
      durationMs?: number;
    }
  | { type: 'retry' }
  | { type: 'reset' };

export const INITIAL_DICTATION_STATE: DictationState = { status: 'idle' };

export function reduceDictationState(
  state: DictationState,
  event: DictationEvent,
): DictationState {
  switch (event.type) {
    case 'request-permission':
      if (
        state.status === 'idle' ||
        state.status === 'completed' ||
        state.status === 'failed'
      ) {
        return { status: 'requesting-permission' };
      }
      return state;
    case 'permission-granted':
      return state.status === 'requesting-permission'
        ? {
            status: 'recording',
            startedAt: event.startedAt,
            transport: 'batch',
          }
        : state;
    case 'transport-selected':
      return state.status === 'recording' || state.status === 'transcribing'
        ? {
            ...state,
            transport: event.transport,
            partialTranscript:
              event.transport === 'realtime'
                ? state.partialTranscript
                : undefined,
          }
        : state;
    case 'partial-transcript':
      return (state.status === 'recording' ||
        state.status === 'transcribing') &&
        state.transport === 'realtime'
        ? {
            ...state,
            partialTranscript: event.transcript || undefined,
          }
        : state;
    case 'stop':
      return state.status === 'recording'
        ? {
            status: 'transcribing',
            durationMs: event.durationMs,
            transport: state.transport,
            partialTranscript: state.partialTranscript,
          }
        : state;
    case 'completed':
      return state.status === 'transcribing'
        ? {
            status: 'completed',
            transcript: event.transcript,
            durationMs: state.durationMs,
            transport: state.transport,
          }
        : state;
    case 'failed':
      return {
        status: 'failed',
        error: event.error,
        retryable: event.retryable,
        durationMs:
          event.durationMs ??
          (state.status === 'transcribing' ? state.durationMs : undefined),
        transport:
          state.status === 'recording' || state.status === 'transcribing'
            ? state.transport
            : state.status === 'completed'
              ? state.transport
              : undefined,
      };
    case 'retry':
      return state.status === 'failed' &&
        state.retryable &&
        state.durationMs !== undefined
        ? {
            status: 'transcribing',
            durationMs: state.durationMs,
            transport: 'batch',
          }
        : state;
    case 'reset':
      return INITIAL_DICTATION_STATE;
  }
}
