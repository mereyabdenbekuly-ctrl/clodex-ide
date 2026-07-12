import { describe, expect, it } from 'vitest';
import {
  getDictationMicroCommand,
  shouldMicroIndicateDictationActive,
} from './dictation-micro';

describe('dictation Micro bridge', () => {
  it('starts and stops dictation only on Micro state transitions', () => {
    expect(
      getDictationMicroCommand({
        previousMicroActive: false,
        microActive: true,
        bridgeAvailable: true,
        dictationStatus: 'idle',
      }),
    ).toBe('start');
    expect(
      getDictationMicroCommand({
        previousMicroActive: true,
        microActive: false,
        bridgeAvailable: true,
        dictationStatus: 'recording',
      }),
    ).toBe('stop');
    expect(
      getDictationMicroCommand({
        previousMicroActive: false,
        microActive: false,
        bridgeAvailable: true,
        dictationStatus: 'recording',
      }),
    ).toBe('none');
  });

  it('cancels permission requests and resets unavailable Micro input', () => {
    expect(
      getDictationMicroCommand({
        previousMicroActive: true,
        microActive: false,
        bridgeAvailable: true,
        dictationStatus: 'requesting-permission',
      }),
    ).toBe('cancel');
    expect(
      getDictationMicroCommand({
        previousMicroActive: false,
        microActive: true,
        bridgeAvailable: false,
        dictationStatus: 'idle',
      }),
    ).toBe('reset-micro');
  });

  it('mirrors only permission and recording states as active', () => {
    expect(shouldMicroIndicateDictationActive('requesting-permission')).toBe(
      true,
    );
    expect(shouldMicroIndicateDictationActive('recording')).toBe(true);
    expect(shouldMicroIndicateDictationActive('transcribing')).toBe(false);
    expect(shouldMicroIndicateDictationActive('failed')).toBe(false);
  });
});
