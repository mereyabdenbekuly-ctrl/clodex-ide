export const DICTATION_SMOKE_SCHEMA_VERSION = 2;

export const DICTATION_SMOKE_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
]);

const SMOKE_MODES = new Set(['hardware', 'capabilities']);
const SMOKE_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SMOKE_ARCHITECTURES = new Set(['arm', 'arm64', 'ia32', 'x64']);
const FAILURE_REASONS = new Set([
  'api-unavailable',
  'media-recorder-unavailable',
  'microphone-api-unavailable',
  'microphone-failed',
  'microphone-no-signal',
  'microphone-not-found',
  'microphone-unavailable',
  'permission-denied',
  'platform-mismatch',
  'recorder-mime-unsupported',
  'runtime-failure',
  'timeout',
  'web-audio-unavailable',
  'webrtc-unavailable',
  'local-webrtc-failed',
]);

function readOptionValue(args, index, optionName) {
  const argument = args[index];
  const equalsPrefix = `--${optionName}=`;
  if (argument.startsWith(equalsPrefix)) {
    const value = argument.slice(equalsPrefix.length);
    if (!value) throw new Error('Smoke option value is missing');
    return { value, consumed: 0 };
  }
  if (argument === `--${optionName}`) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Smoke option value is missing');
    }
    return { value, consumed: 1 };
  }
  return undefined;
}

export function normalizeSmokePlatform(value) {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'darwin':
    case 'mac':
    case 'macos':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win':
    case 'win32':
    case 'windows':
      return 'win32';
    default:
      return null;
  }
}

export function parseDictationSmokeCli(args) {
  const options = {
    mode: 'hardware',
    expectedPlatform: null,
    outputPath: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;

    const modeOption = readOptionValue(args, index, 'mode');
    if (modeOption) {
      if (!SMOKE_MODES.has(modeOption.value)) {
        throw new Error('Unsupported smoke mode');
      }
      options.mode = modeOption.value;
      index += modeOption.consumed;
      continue;
    }

    const platformOption = readOptionValue(args, index, 'expect-platform');
    if (platformOption) {
      const expectedPlatform = normalizeSmokePlatform(platformOption.value);
      if (!expectedPlatform) {
        throw new Error('Unsupported expected platform');
      }
      options.expectedPlatform = expectedPlatform;
      index += platformOption.consumed;
      continue;
    }

    const outputOption = readOptionValue(args, index, 'output');
    if (outputOption) {
      if (outputOption.value.includes('\0')) {
        throw new Error('Invalid smoke output path');
      }
      options.outputPath = outputOption.value;
      index += outputOption.consumed;
      continue;
    }

    throw new Error('Unknown smoke option');
  }

  return options;
}

export function fixedSmokeFailureReason(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'microphone-not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'microphone-unavailable';
    case 'ApiUnavailableError':
    case 'NotSupportedError':
      return 'api-unavailable';
    case 'TimeoutError':
      return 'timeout';
    default:
      return 'runtime-failure';
  }
}

export function isRecorderMimePolicySatisfied(platform, recorderMimeTypes) {
  const normalizedPlatform = normalizeSmokePlatform(platform);
  if (!normalizedPlatform) return false;

  const webmSupported =
    recorderMimeTypes['audio/webm;codecs=opus'] ||
    recorderMimeTypes['audio/webm'];
  if (normalizedPlatform === 'win32') return Boolean(webmSupported);

  return Boolean(webmSupported || recorderMimeTypes['audio/ogg;codecs=opus']);
}

function finiteIntegerOrNull(value, minimum, maximum) {
  if (!Number.isFinite(value)) return null;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function normalizeRendererPlatform(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(normalized)) return 'unknown';
  return normalized;
}

function normalizeFailureReason(value) {
  return FAILURE_REASONS.has(value) ? value : null;
}

function createRecorderMimeReport(recorderMimeTypes = {}) {
  return {
    'audio/webm;codecs=opus': Boolean(
      recorderMimeTypes['audio/webm;codecs=opus'],
    ),
    'audio/webm': Boolean(recorderMimeTypes['audio/webm']),
    'audio/ogg;codecs=opus': Boolean(
      recorderMimeTypes['audio/ogg;codecs=opus'],
    ),
  };
}

function evaluateVerdict(report, fatalFailureReason) {
  const failureReasons = [];
  const addFailure = (reason) => {
    if (!failureReasons.includes(reason)) failureReasons.push(reason);
  };

  if (!report.platformExpectation.matched) addFailure('platform-mismatch');

  if (report.mode === 'capabilities') {
    if (!report.support.microphoneCapture) {
      addFailure('microphone-api-unavailable');
    }
    if (!report.support.mediaRecorder) {
      addFailure('media-recorder-unavailable');
    }
    if (!report.support.webAudio) addFailure('web-audio-unavailable');
    if (!report.support.webRtc) addFailure('webrtc-unavailable');
    if (
      !isRecorderMimePolicySatisfied(
        report.host.platform,
        report.recorderMimeTypes,
      )
    ) {
      addFailure('recorder-mime-unsupported');
    }
  } else if (report.microphone.outcome === 'no-signal') {
    addFailure('microphone-no-signal');
  } else if (report.microphone.outcome !== 'passed') {
    addFailure(report.microphone.failureReason ?? 'microphone-failed');
  }

  if (report.localWebRtc.outcome !== 'connected') {
    addFailure(report.localWebRtc.failureReason ?? 'local-webrtc-failed');
  }
  if (fatalFailureReason) addFailure(fatalFailureReason);

  return {
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

export function createDictationSmokeReport(input) {
  const mode = SMOKE_MODES.has(input.mode) ? input.mode : 'hardware';
  const hostPlatform = normalizeSmokePlatform(input.hostPlatform) ?? 'unknown';
  const hostArch = SMOKE_ARCHITECTURES.has(input.hostArch)
    ? input.hostArch
    : 'unknown';
  const expectedPlatform = normalizeSmokePlatform(input.expectedPlatform);
  const support = {
    microphoneCapture: Boolean(input.support?.microphoneCapture),
    mediaRecorder: Boolean(input.support?.mediaRecorder),
    webAudio: Boolean(input.support?.webAudio),
    webRtc: Boolean(input.support?.webRtc),
  };
  const recorderMimeTypes = createRecorderMimeReport(input.recorderMimeTypes);
  const microphone =
    mode === 'capabilities'
      ? {
          outcome: 'skipped',
          durationMs: null,
          peakLevel: null,
          trackCount: 0,
          failureReason: null,
        }
      : {
          outcome:
            input.microphone?.outcome === 'passed' ||
            input.microphone?.outcome === 'no-signal' ||
            input.microphone?.outcome === 'failed'
              ? input.microphone.outcome
              : 'failed',
          durationMs: finiteIntegerOrNull(
            input.microphone?.durationMs,
            0,
            60_000,
          ),
          peakLevel: finiteIntegerOrNull(input.microphone?.peakLevel, 0, 100),
          trackCount:
            finiteIntegerOrNull(input.microphone?.trackCount, 0, 16) ?? 0,
          failureReason: normalizeFailureReason(
            input.microphone?.failureReason,
          ),
        };
  const localWebRtc = {
    outcome:
      input.localWebRtc?.outcome === 'connected' ||
      input.localWebRtc?.outcome === 'failed'
        ? input.localWebRtc.outcome
        : 'failed',
    latencyMs: finiteIntegerOrNull(input.localWebRtc?.latencyMs, 0, 60_000),
    failureReason: normalizeFailureReason(input.localWebRtc?.failureReason),
  };

  const report = {
    schemaVersion: DICTATION_SMOKE_SCHEMA_VERSION,
    mode,
    host: {
      platform: hostPlatform,
      arch: hostArch,
    },
    rendererPlatform: normalizeRendererPlatform(input.rendererPlatform),
    platformExpectation: {
      expected: expectedPlatform,
      matched: expectedPlatform
        ? expectedPlatform === hostPlatform
        : SMOKE_PLATFORMS.has(hostPlatform),
    },
    support,
    recorderMimeTypes,
    microphone,
    localWebRtc,
    verdict: {
      passed: false,
      failureReasons: [],
    },
  };
  report.verdict = evaluateVerdict(
    report,
    normalizeFailureReason(input.fatalFailureReason),
  );
  return report;
}
