import type {
  DictationMicrophoneTestFailureReason,
  DictationMicrophoneTestResult,
} from '@shared/dictation-diagnostics';

export const DICTATION_MICROPHONE_TEST_DURATION_MS = 4_000;
const SIGNAL_RMS_THRESHOLD = 0.003;

type AudioContextConstructor = new () => AudioContext;

export interface DictationMicrophoneTestOperation {
  result: Promise<DictationMicrophoneTestResult>;
  cancel: () => void;
}

export interface StartDictationMicrophoneTestOptions {
  durationMs?: number;
  onLevel?: (level: number) => void;
  dependencies?: Partial<DictationMicrophoneTestDependencies>;
}

export interface DictationMicrophoneTestDependencies {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext: () => AudioContext;
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timer: number) => void;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (frame: number) => void;
}

export function startDictationMicrophoneTest({
  durationMs = DICTATION_MICROPHONE_TEST_DURATION_MS,
  onLevel,
  dependencies,
}: StartDictationMicrophoneTestOptions = {}): DictationMicrophoneTestOperation {
  const deps = {
    ...readMicrophoneTestDependencies(),
    ...dependencies,
  };
  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let timer: number | undefined;
  let animationFrame: number | undefined;
  let startedAt = 0;
  let peakRms = 0;
  let settled = false;
  let resolveResult: (result: DictationMicrophoneTestResult) => void;
  const result = new Promise<DictationMicrophoneTestResult>((resolve) => {
    resolveResult = resolve;
  });

  const cleanup = async (): Promise<void> => {
    if (timer !== undefined) {
      deps.clearTimeout(timer);
      timer = undefined;
    }
    if (animationFrame !== undefined) {
      deps.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    source?.disconnect();
    analyser?.disconnect();
    source = undefined;
    analyser = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    const context = audioContext;
    audioContext = undefined;
    if (context && context.state !== 'closed') {
      await context.close().catch(() => undefined);
    }
    onLevel?.(0);
  };

  const finish = (next: DictationMicrophoneTestResult): void => {
    if (settled) return;
    settled = true;
    void cleanup().finally(() => resolveResult(next));
  };

  const run = async (): Promise<void> => {
    try {
      stream = await deps.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      });
      if (settled) {
        for (const track of stream.getTracks()) track.stop();
        stream = undefined;
        return;
      }
      audioContext = deps.createAudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      if (settled) return;
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2_048;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      startedAt = deps.now();

      const sample = (): void => {
        if (settled || !analyser) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = calculateRms(samples);
        peakRms = Math.max(peakRms, rms);
        onLevel?.(rmsToMeterLevel(rms));
        animationFrame = deps.requestAnimationFrame(sample);
      };
      sample();
      timer = deps.setTimeout(() => {
        const measuredDurationMs = Math.max(0, deps.now() - startedAt);
        finish({
          outcome: peakRms >= SIGNAL_RMS_THRESHOLD ? 'passed' : 'no-signal',
          durationMs: Math.round(measuredDurationMs),
          peakLevel: Math.round(rmsToMeterLevel(peakRms) * 100),
        });
      }, durationMs);
    } catch (error) {
      if (settled) return;
      finish({
        outcome: 'failed',
        failureReason: classifyMicrophoneTestFailure(error),
      });
    }
  };

  void run();
  return {
    result,
    cancel: () => {
      finish({
        outcome: 'cancelled',
        durationMs: startedAt ? Math.round(deps.now() - startedAt) : undefined,
        peakLevel: Math.round(rmsToMeterLevel(peakRms) * 100),
      });
    },
  };
}

export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function rmsToMeterLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 60) / 60));
}

export function classifyMicrophoneTestFailure(
  error: unknown,
): DictationMicrophoneTestFailureReason {
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
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'microphone-not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'microphone-unavailable';
    case 'AudioContextUnavailableError':
      return 'web-audio-unavailable';
    case 'MicrophoneApiUnavailableError':
      return 'microphone-api-unavailable';
    default:
      return 'microphone-test-runtime-failure';
  }
}

function readMicrophoneTestDependencies(): DictationMicrophoneTestDependencies {
  const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(
    navigator.mediaDevices,
  );
  if (!getUserMedia) {
    return {
      ...readBrowserTimingDependencies(),
      getUserMedia: async () => {
        throw createNamedError(
          'MicrophoneApiUnavailableError',
          'Microphone capture API unavailable',
        );
      },
      createAudioContext: readAudioContextFactory(),
    };
  }
  return {
    ...readBrowserTimingDependencies(),
    getUserMedia,
    createAudioContext: readAudioContextFactory(),
  };
}

function readAudioContextFactory(): () => AudioContext {
  const AudioContextClass =
    globalThis.AudioContext ??
    (
      globalThis as typeof globalThis & {
        webkitAudioContext?: AudioContextConstructor;
      }
    ).webkitAudioContext;
  return () => {
    if (!AudioContextClass) {
      throw createNamedError(
        'AudioContextUnavailableError',
        'Web Audio API unavailable',
      );
    }
    return new AudioContextClass();
  };
}

function readBrowserTimingDependencies(): Pick<
  DictationMicrophoneTestDependencies,
  | 'now'
  | 'setTimeout'
  | 'clearTimeout'
  | 'requestAnimationFrame'
  | 'cancelAnimationFrame'
> {
  return {
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (frame) => window.cancelAnimationFrame(frame),
  };
}

function createNamedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
