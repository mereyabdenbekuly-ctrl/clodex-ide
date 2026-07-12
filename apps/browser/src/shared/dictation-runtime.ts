import type { DictationMediaType } from './dictation';

export const DICTATION_RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export interface DictationRuntimeCapabilities {
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
  hasRTCPeerConnection: boolean;
  hasAudioContext?: boolean;
  isRecorderTypeSupported: (mimeType: string) => boolean;
}

export interface DictationRuntimeSupport {
  microphoneCapture: boolean;
  mediaRecorder: boolean;
  webAudio: boolean;
  batchRecording: boolean;
  realtimeWebRtc: boolean;
  recorderMimeType?: string;
}

export type DictationFocusInteraction =
  | 'orb-pointer'
  | 'orb-keyboard'
  | 'micro-pointer'
  | 'micro-keyboard';

export function getDictationRuntimeSupport(
  capabilities: DictationRuntimeCapabilities,
): DictationRuntimeSupport {
  const batchRecording =
    capabilities.hasGetUserMedia && capabilities.hasMediaRecorder;
  return {
    microphoneCapture: capabilities.hasGetUserMedia,
    mediaRecorder: capabilities.hasMediaRecorder,
    webAudio: capabilities.hasAudioContext ?? false,
    batchRecording,
    realtimeWebRtc: batchRecording && capabilities.hasRTCPeerConnection,
    recorderMimeType: batchRecording
      ? selectSupportedRecorderMimeType(capabilities.isRecorderTypeSupported)
      : undefined,
  };
}

export function selectSupportedRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | undefined {
  return DICTATION_RECORDER_MIME_CANDIDATES.find(isTypeSupported);
}

export function normalizeRecorderMimeType(value: string): DictationMediaType {
  const mediaType = value.trim().toLowerCase().split(';')[0];
  switch (mediaType) {
    case 'audio/webm':
    case 'audio/ogg':
    case 'audio/wav':
    case 'audio/mp4':
    case 'audio/mpeg':
      return mediaType;
    default:
      return 'audio/webm';
  }
}

export function getMicrophonePermissionError(error: unknown): string {
  const name =
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
      ? error.name
      : undefined;

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access was denied. Allow it in system or site permissions and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is currently unavailable or used by another application.';
    default:
      return getDictationErrorMessage(error);
  }
}

export function getDictationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Dictation failed. Try recording again.';
}

export function shouldClaimClodexUiFocus(
  _interaction: DictationFocusInteraction,
  disabled: boolean,
): boolean {
  return !disabled;
}
