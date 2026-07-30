import { describe, expect, it } from 'vitest';
import {
  formatUpstreamDisconnectedErrorReport,
  getUpstreamDisconnectedPresentation,
  shouldShowRuntimeErrorRetry,
} from './runtime-error-retry';

const disconnectedError = {
  kind: 'upstream-disconnected' as const,
  message: 'Public reconnect summary',
  originalMessage:
    'Codex upstream request failed via proxy endpoint secret-route: ServerDisconnectedError',
  endpointId: '62b8b1d2-f4bc-43bc-93c3-ce086afc5cd0',
  stack: 'Error: ServerDisconnectedError\n    at upstream.ts:42:1',
  modelId: 'gpt-5.6-sol',
  attempts: 5,
  phase: 'partial-output' as const,
  resumeMode: 'continue' as const,
};

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

  it('shows Reconnect only for an idle, resumable upstream disconnect', () => {
    expect(shouldShowRuntimeErrorRetry(disconnectedError, false, false)).toBe(
      true,
    );
    expect(shouldShowRuntimeErrorRetry(disconnectedError, true, true)).toBe(
      false,
    );
    expect(
      shouldShowRuntimeErrorRetry(
        {
          ...disconnectedError,
          phase: 'unknown-tool-outcome' as const,
          resumeMode: 'blocked' as const,
        },
        true,
        false,
      ),
    ).toBe(false);
  });

  it('keeps endpoint and raw provider details out of the visible presentation', () => {
    const presentation = getUpstreamDisconnectedPresentation(disconnectedError);
    const visibleText = `${presentation.heading}\n${presentation.description}`;

    expect(visibleText).toContain('Model connection interrupted');
    expect(visibleText).not.toContain(disconnectedError.endpointId);
    expect(visibleText).not.toContain(disconnectedError.originalMessage);
    expect(visibleText).not.toContain('ServerDisconnectedError');
  });

  it('explains why reconnect is blocked for an unknown tool outcome', () => {
    const presentation = getUpstreamDisconnectedPresentation({
      ...disconnectedError,
      phase: 'unknown-tool-outcome' as const,
      resumeMode: 'blocked' as const,
    });

    expect(presentation.heading).toBe('Reconnect stopped for safety');
    expect(presentation.description).toContain(
      'could not confirm its final result',
    );
    expect(presentation.description).toContain('avoid repeating');
  });

  it('includes private upstream diagnostics only in explicit clipboard copy', () => {
    const report = formatUpstreamDisconnectedErrorReport(disconnectedError);

    expect(report).toContain(disconnectedError.originalMessage);
    expect(report).toContain(disconnectedError.endpointId);
    expect(report).toContain(disconnectedError.stack);
    expect(report).toContain('Resume mode: continue');
    expect(report).toContain('Phase: partial-output');
  });
});
