import { describe, expect, it } from 'vitest';
import {
  createDictationSmokeReport,
  fixedSmokeFailureReason,
  isRecorderMimePolicySatisfied,
  normalizeSmokePlatform,
  parseDictationSmokeCli,
} from './dictation-hardware-smoke.js';

describe('dictation hardware smoke report', () => {
  it('parses portable CLI options without exposing the output path', () => {
    expect(
      parseDictationSmokeCli([
        '--mode=capabilities',
        '--expect-platform',
        'windows',
        '--output=../../private/report.json',
      ]),
    ).toEqual({
      mode: 'capabilities',
      expectedPlatform: 'win32',
      outputPath: '../../private/report.json',
    });
    expect(() => parseDictationSmokeCli(['--mode=unknown'])).toThrow(
      'Unsupported smoke mode',
    );
  });

  it('normalizes supported platform aliases', () => {
    expect(normalizeSmokePlatform('macOS')).toBe('darwin');
    expect(normalizeSmokePlatform('Windows')).toBe('win32');
    expect(normalizeSmokePlatform('linux')).toBe('linux');
    expect(normalizeSmokePlatform('freebsd')).toBeNull();
  });

  it('allows Linux Ogg fallback but requires WebM on Windows', () => {
    const oggOnly = {
      'audio/webm;codecs=opus': false,
      'audio/webm': false,
      'audio/ogg;codecs=opus': true,
    };
    expect(isRecorderMimePolicySatisfied('linux', oggOnly)).toBe(true);
    expect(isRecorderMimePolicySatisfied('win32', oggOnly)).toBe(false);
  });

  it('passes capability mode without opening a microphone', () => {
    const report = createDictationSmokeReport({
      mode: 'capabilities',
      hostPlatform: 'linux',
      hostArch: 'x64',
      expectedPlatform: 'linux',
      rendererPlatform: 'Linux x86_64',
      support: {
        microphoneCapture: true,
        mediaRecorder: true,
        webAudio: true,
        webRtc: true,
      },
      recorderMimeTypes: {
        'audio/webm;codecs=opus': true,
        'audio/webm': true,
        'audio/ogg;codecs=opus': false,
      },
      microphone: {
        outcome: 'passed',
        peakLevel: 90,
      },
      localWebRtc: {
        outcome: 'connected',
        latencyMs: 112,
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 2,
      mode: 'capabilities',
      microphone: {
        outcome: 'skipped',
        peakLevel: null,
        trackCount: 0,
      },
      verdict: {
        passed: true,
        failureReasons: [],
      },
    });
  });

  it('fails closed for platform mismatch and missing recorder support', () => {
    const report = createDictationSmokeReport({
      mode: 'capabilities',
      hostPlatform: 'linux',
      hostArch: 'x64',
      expectedPlatform: 'win32',
      rendererPlatform: 'Linux x86_64',
      support: {
        microphoneCapture: true,
        mediaRecorder: true,
        webAudio: true,
        webRtc: true,
      },
      recorderMimeTypes: {
        'audio/webm;codecs=opus': false,
        'audio/webm': false,
        'audio/ogg;codecs=opus': false,
      },
      localWebRtc: {
        outcome: 'connected',
        latencyMs: 80,
      },
    });

    expect(report.verdict).toEqual({
      passed: false,
      failureReasons: ['platform-mismatch', 'recorder-mime-unsupported'],
    });
  });

  it('keeps failures fixed-shape and content-free', () => {
    const report = createDictationSmokeReport({
      mode: 'hardware',
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      expectedPlatform: 'darwin',
      rendererPlatform: '/Users/private/device',
      support: {},
      recorderMimeTypes: {},
      microphone: {
        outcome: 'failed',
        failureReason: 'raw-secret-provider-error',
      },
      localWebRtc: {
        outcome: 'failed',
        failureReason: 'raw-sdp-error',
      },
      fatalFailureReason: 'raw-runtime-error',
    });
    const serialized = JSON.stringify(report);

    expect(report.rendererPlatform).toBe('unknown');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('sdp');
    expect(report.verdict.failureReasons).toEqual([
      'microphone-failed',
      'local-webrtc-failed',
    ]);
  });

  it('maps browser exceptions to bounded failure reasons', () => {
    expect(fixedSmokeFailureReason({ name: 'NotAllowedError' })).toBe(
      'permission-denied',
    );
    expect(fixedSmokeFailureReason({ name: 'UnexpectedSecretError' })).toBe(
      'runtime-failure',
    );
  });
});
