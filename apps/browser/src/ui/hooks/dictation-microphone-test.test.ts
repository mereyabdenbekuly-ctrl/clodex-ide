import { describe, expect, it, vi } from 'vitest';
import {
  calculateRms,
  classifyMicrophoneTestFailure,
  rmsToMeterLevel,
  startDictationMicrophoneTest,
  type DictationMicrophoneTestDependencies,
} from './dictation-microphone-test';

function createHarness(samples: number[]) {
  let now = 0;
  let timerCallback: (() => void) | undefined;
  let frameCallback: FrameRequestCallback | undefined;
  const stop = vi.fn();
  const close = vi.fn(async () => undefined);
  const disconnectSource = vi.fn();
  const disconnectAnalyser = vi.fn();
  const analyser = {
    fftSize: 4,
    smoothingTimeConstant: 0,
    getFloatTimeDomainData(target: Float32Array) {
      for (let index = 0; index < target.length; index += 1) {
        target[index] = samples[index % samples.length] ?? 0;
      }
    },
    disconnect: disconnectAnalyser,
  } as unknown as AnalyserNode;
  const audioContext = {
    state: 'running',
    createMediaStreamSource: () =>
      ({
        connect: vi.fn(),
        disconnect: disconnectSource,
      }) as unknown as MediaStreamAudioSourceNode,
    createAnalyser: () => analyser,
    resume: vi.fn(async () => undefined),
    close,
  } as unknown as AudioContext;
  const stream = {
    getTracks: () => [{ stop }],
  } as unknown as MediaStream;
  const dependencies: DictationMicrophoneTestDependencies = {
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: () => audioContext,
    now: () => now,
    setTimeout: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimeout: vi.fn(),
    requestAnimationFrame: (callback) => {
      frameCallback = callback;
      return 2;
    },
    cancelAnimationFrame: vi.fn(),
  };
  return {
    dependencies,
    stop,
    close,
    disconnectSource,
    disconnectAnalyser,
    finish() {
      now = 4_000;
      frameCallback?.(now);
      timerCallback?.();
    },
  };
}

describe('local dictation microphone self-test', () => {
  it('measures local signal without recording and tears down every resource', async () => {
    const harness = createHarness([0.02, -0.02, 0.02, -0.02]);
    const levels: number[] = [];
    const operation = startDictationMicrophoneTest({
      dependencies: harness.dependencies,
      onLevel: (level) => levels.push(level),
    });
    await Promise.resolve();
    await Promise.resolve();

    harness.finish();

    await expect(operation.result).resolves.toMatchObject({
      outcome: 'passed',
      durationMs: 4_000,
    });
    expect(levels.some((level) => level > 0)).toBe(true);
    expect(levels.at(-1)).toBe(0);
    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.disconnectSource).toHaveBeenCalledOnce();
    expect(harness.disconnectAnalyser).toHaveBeenCalledOnce();
  });

  it('reports no signal and supports strict cancellation', async () => {
    const noSignal = createHarness([0, 0, 0, 0]);
    const noSignalOperation = startDictationMicrophoneTest({
      dependencies: noSignal.dependencies,
    });
    await Promise.resolve();
    await Promise.resolve();
    noSignal.finish();

    await expect(noSignalOperation.result).resolves.toMatchObject({
      outcome: 'no-signal',
      peakLevel: 0,
    });

    const cancelled = createHarness([0.01, -0.01, 0.01, -0.01]);
    const cancelledOperation = startDictationMicrophoneTest({
      dependencies: cancelled.dependencies,
    });
    await Promise.resolve();
    await Promise.resolve();
    cancelledOperation.cancel();

    await expect(cancelledOperation.result).resolves.toMatchObject({
      outcome: 'cancelled',
    });
    expect(cancelled.stop).toHaveBeenCalledOnce();
    expect(cancelled.close).toHaveBeenCalledOnce();
  });

  it('stops a stream that arrives after cancellation', async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const stop = vi.fn();
    const pendingStream = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const harness = createHarness([0, 0, 0, 0]);
    harness.dependencies.getUserMedia = () => pendingStream;
    const operation = startDictationMicrophoneTest({
      dependencies: harness.dependencies,
    });

    operation.cancel();
    resolveStream?.({
      getTracks: () => [{ stop }],
    } as unknown as MediaStream);

    await expect(operation.result).resolves.toMatchObject({
      outcome: 'cancelled',
    });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('microphone signal helpers', () => {
  it('calculates RMS and clamps the visual meter', () => {
    expect(calculateRms(new Float32Array([1, -1]))).toBe(1);
    expect(rmsToMeterLevel(0)).toBe(0);
    expect(rmsToMeterLevel(1)).toBe(1);
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['NotFoundError', 'microphone-not-found'],
    ['DevicesNotFoundError', 'microphone-not-found'],
    ['NotReadableError', 'microphone-unavailable'],
    ['TrackStartError', 'microphone-unavailable'],
  ] as const)('classifies %s as %s', (name, reason) => {
    expect(classifyMicrophoneTestFailure({ name })).toBe(reason);
  });
});
