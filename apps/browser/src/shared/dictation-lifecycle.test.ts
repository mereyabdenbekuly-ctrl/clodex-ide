import { describe, expect, it } from 'vitest';
import {
  DictationLifecycleGuard,
  shouldCancelDictationForVisibility,
} from './dictation-lifecycle';

describe('dictation lifecycle guard', () => {
  it('invalidates an operation when the global gate closes or the document hides', () => {
    const guard = new DictationLifecycleGuard();
    const gateOperation = guard.begin('agent-a')!;

    guard.invalidate();

    expect(guard.isCurrent(gateOperation, 'agent-a')).toBe(false);

    const hiddenOperation = guard.begin('agent-a')!;
    guard.invalidate();

    expect(guard.isCurrent(hiddenOperation, 'agent-a')).toBe(false);
  });

  it('rejects a stale completion immediately after the active agent changes', () => {
    const guard = new DictationLifecycleGuard();
    const operation = guard.begin('agent-a')!;

    expect(guard.claimTranscriptDelivery(operation, 'agent-b')).toBe(false);
  });

  it('serializes rapid starts and allows a new operation after cancellation', () => {
    const guard = new DictationLifecycleGuard();
    const first = guard.begin('agent-a');

    expect(first).not.toBeNull();
    expect(guard.begin('agent-a')).toBeNull();

    guard.invalidate();
    const second = guard.begin('agent-a');

    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
  });

  it('grants transcript insertion authority exactly once', () => {
    const guard = new DictationLifecycleGuard();
    const operation = guard.begin('agent-a')!;

    expect(guard.claimTranscriptDelivery(operation, 'agent-a')).toBe(true);
    expect(guard.claimTranscriptDelivery(operation, 'agent-a')).toBe(false);
  });

  it('prevents an older session from mutating a newer draft', () => {
    const guard = new DictationLifecycleGuard();
    const older = guard.begin('agent-a')!;
    guard.invalidate();
    const newer = guard.begin('agent-a')!;

    expect(guard.claimTranscriptDelivery(older, 'agent-a')).toBe(false);
    expect(guard.claimTranscriptDelivery(newer, 'agent-a')).toBe(true);
  });
});

describe('dictation visibility policy', () => {
  it.each([
    'requesting-permission',
    'recording',
    'transcribing',
  ] as const)('cancels %s when the document becomes hidden', (status) => {
    expect(shouldCancelDictationForVisibility('hidden', status)).toBe(true);
  });

  it('does not cancel completed or idle sessions', () => {
    expect(shouldCancelDictationForVisibility('hidden', 'idle')).toBe(false);
    expect(shouldCancelDictationForVisibility('hidden', 'completed')).toBe(
      false,
    );
    expect(shouldCancelDictationForVisibility('visible', 'recording')).toBe(
      false,
    );
  });
});
