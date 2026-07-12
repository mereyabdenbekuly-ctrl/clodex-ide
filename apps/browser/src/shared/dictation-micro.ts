import type { DictationState } from './dictation';

export type DictationMicroCommand =
  | 'none'
  | 'start'
  | 'stop'
  | 'cancel'
  | 'reset-micro';

export function getDictationMicroCommand(input: {
  previousMicroActive: boolean;
  microActive: boolean;
  bridgeAvailable: boolean;
  dictationStatus: DictationState['status'];
}): DictationMicroCommand {
  if (!input.bridgeAvailable) {
    return input.microActive ? 'reset-micro' : 'none';
  }
  if (input.previousMicroActive === input.microActive) return 'none';
  if (input.microActive) return 'start';
  if (input.dictationStatus === 'requesting-permission') return 'cancel';
  if (input.dictationStatus === 'recording') return 'stop';
  return 'none';
}

export function shouldMicroIndicateDictationActive(
  status: DictationState['status'],
): boolean {
  return status === 'requesting-permission' || status === 'recording';
}
