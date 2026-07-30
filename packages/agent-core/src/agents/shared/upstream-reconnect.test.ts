import { describe, expect, it } from 'vitest';
import {
  UpstreamStepRecoveryTracker,
  decideUpstreamDisconnectRecovery,
  isValidUpstreamDisconnectRecoveryState,
  parseUpstreamDisconnectError,
} from './upstream-reconnect';

const MAX_RECONNECT_ATTEMPTS = 5;

function decide(tracker: UpstreamStepRecoveryTracker, attemptsUsed = 0) {
  return decideUpstreamDisconnectRecovery({
    attemptsUsed,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    progress: tracker.snapshot(),
  });
}

describe('phase-aware upstream disconnect recovery', () => {
  it('retries an untouched step at most five times with bounded exponential backoff', () => {
    const tracker = new UpstreamStepRecoveryTracker();

    expect(
      Array.from({ length: MAX_RECONNECT_ATTEMPTS }, (_, attemptsUsed) =>
        decide(tracker, attemptsUsed),
      ),
    ).toEqual([
      { kind: 'retry-step', attempt: 1, delayMs: 500 },
      { kind: 'retry-step', attempt: 2, delayMs: 1_000 },
      { kind: 'retry-step', attempt: 3, delayMs: 2_000 },
      { kind: 'retry-step', attempt: 4, delayMs: 4_000 },
      { kind: 'retry-step', attempt: 5, delayMs: 8_000 },
    ]);

    expect(decide(tracker, MAX_RECONNECT_ATTEMPTS)).toEqual({
      kind: 'fail-closed',
      reason: 'retry-exhausted',
      attempt: MAX_RECONNECT_ATTEMPTS,
    });
  });

  it('continues instead of replaying after the first streamed token', () => {
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markFirstToken();

    expect(decide(tracker)).toMatchObject({ kind: 'continue' });
  });

  it('continues instead of replaying after output has been committed', () => {
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markOutputCommitted();

    expect(decide(tracker)).toMatchObject({ kind: 'continue' });
  });

  it('continues from a terminal read-only result without replaying the read step', () => {
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('read-call');
    tracker.markToolTerminal('read-call');

    expect(decide(tracker)).toMatchObject({ kind: 'continue' });
  });

  it('continues from a committed effect result without replaying the write or shell step', () => {
    for (const toolCallId of ['write-call', 'shell-call']) {
      const tracker = new UpstreamStepRecoveryTracker();
      tracker.markToolDispatched(toolCallId);
      tracker.markToolTerminal(toolCallId);

      expect(decide(tracker, 2)).toEqual({
        kind: 'continue',
        attempt: 3,
        delayMs: 2_000,
      });
    }
  });

  it('fails closed when a dispatched tool has no terminal result', () => {
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('unknown-outcome');

    expect(decide(tracker)).toEqual({
      kind: 'fail-closed',
      reason: 'unknown-tool-outcome',
      attempt: 0,
    });
  });

  it('fails closed if any dispatched tool remains unresolved', () => {
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('completed-read');
    tracker.markToolTerminal('completed-read');
    tracker.markToolDispatched('unresolved-write');

    expect(decide(tracker, 2)).toEqual({
      kind: 'fail-closed',
      reason: 'unknown-tool-outcome',
      attempt: 2,
    });
  });

  it('gives an unresolved tool precedence over otherwise continuable partial output', () => {
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markFirstToken();
    tracker.markOutputCommitted();
    tracker.markToolDispatched('unresolved-shell');

    expect(decide(tracker, MAX_RECONNECT_ATTEMPTS)).toMatchObject({
      kind: 'fail-closed',
      reason: 'unknown-tool-outcome',
    });
  });

  it('recognizes the managed proxy disconnect and extracts its diagnostic endpoint id', () => {
    expect(
      parseUpstreamDisconnectError(
        new Error(
          'Codex upstream request failed via proxy endpoint 62b8b1d2-f4bc-43bc-93c3-ce086afc5cd0: ServerDisconnectedError',
        ),
      ),
    ).toEqual({
      message:
        'Codex upstream request failed via proxy endpoint 62b8b1d2-f4bc-43bc-93c3-ce086afc5cd0: ServerDisconnectedError',
      endpointId: '62b8b1d2-f4bc-43bc-93c3-ce086afc5cd0',
    });
  });

  it.each([
    'stream disconnected before completion: Responses stream ended before a terminal event: timeout',
    'stream disconnected before completion: Transport error: network error: error decoding response body',
    'Responses stream ended before a terminal event: timeout',
    'stream disconnected before completion: idle timeout waiting for SSE',
    'stream disconnected before completion: stream closed before response.completed',
    'error sending request for url (https://clodex.xyz/v1/responses)',
  ])('recognizes observed truncated Responses streams: %s', (message) => {
    expect(parseUpstreamDisconnectError(new Error(message))).toEqual({
      message,
    });
  });

  it.each([
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('recognizes a plain-object transport code: %s', (code) => {
    expect(
      parseUpstreamDisconnectError({
        name: 'TypeError',
        message: 'fetch failed',
        cause: { code, message: 'connect timeout' },
      }),
    ).toEqual({ message: 'connect timeout' });
  });

  it('never converts an explicit abort into reconnect through a nested cause', () => {
    const disconnect = new Error('ServerDisconnectedError');
    const aborted = new Error('This operation was aborted', {
      cause: disconnect,
    });
    aborted.name = 'AbortError';

    expect(parseUpstreamDisconnectError(aborted)).toBeNull();
  });

  it('gives a nested abort precedence over a disconnect wrapper', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    const disconnect = new Error('stream disconnected before completion', {
      cause: aborted,
    });

    expect(parseUpstreamDisconnectError(disconnect)).toBeNull();
  });

  it('does not classify quota and authentication errors as disconnects', () => {
    expect(
      parseUpstreamDisconnectError(
        new Error('Clodex request failed with status 429'),
      ),
    ).toBeNull();
    expect(
      parseUpstreamDisconnectError(new Error('401 invalid api key')),
    ).toBeNull();
    expect(
      parseUpstreamDisconnectError(
        new Error('connection closed', {
          cause: Object.assign(new Error('429 Too Many Requests'), {
            statusCode: 429,
          }),
        }),
      ),
    ).toBeNull();
  });

  it('accepts only phase/resume combinations that the runtime can execute safely', () => {
    expect(
      isValidUpstreamDisconnectRecoveryState({
        phase: 'before-output',
        resumeMode: 'retry-step',
      }),
    ).toBe(true);
    expect(
      isValidUpstreamDisconnectRecoveryState({
        phase: 'partial-output',
        resumeMode: 'continue',
      }),
    ).toBe(true);
    expect(
      isValidUpstreamDisconnectRecoveryState({
        phase: 'unknown-tool-outcome',
        resumeMode: 'blocked',
      }),
    ).toBe(true);
    expect(
      isValidUpstreamDisconnectRecoveryState({
        phase: 'unknown-tool-outcome',
        resumeMode: 'continue',
      }),
    ).toBe(false);
    expect(
      isValidUpstreamDisconnectRecoveryState({
        phase: 'route-unverified',
        resumeMode: 'retry-step',
      }),
    ).toBe(false);
  });
});
