import { describe, expect, it } from 'vitest';
import { shouldShowRuntimeErrorRetry } from './runtime-error-retry';

describe('shouldShowRuntimeErrorRetry', () => {
  it('suppresses button and hotkey admission for non-retryable post-step errors', () => {
    expect(
      shouldShowRuntimeErrorRetry(
        {
          message: 'Context compression could not be persisted durably',
          retryable: false,
        },
        true,
        false,
      ),
    ).toBe(false);
  });

  it('preserves existing retry visibility for ordinary runtime errors', () => {
    expect(
      shouldShowRuntimeErrorRetry({ message: 'Provider failed' }, false, false),
    ).toBe(true);
    expect(
      shouldShowRuntimeErrorRetry({ message: 'Provider failed' }, false, true),
    ).toBe(false);
  });
});
