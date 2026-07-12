import { describe, expect, it } from 'vitest';
import { IsolatedAgentRuntimeCircuitBreaker } from './isolated-agent-runtime-circuit-breaker';

describe('IsolatedAgentRuntimeCircuitBreaker', () => {
  it('opens after consecutive failures and admits one cooldown probe', () => {
    let now = 0;
    const breaker = new IsolatedAgentRuntimeCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
      now: () => now,
    });

    const first = breaker.tryAcquire();
    const second = breaker.tryAcquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(breaker.recordOutcome(first!.admission, 'failed')).toBeNull();
    expect(breaker.recordOutcome(second!.admission, 'failed')).toMatchObject({
      state: 'open',
      trigger: 'failure-threshold',
      consecutiveFailures: 2,
    });
    expect(breaker.tryAcquire()).toBeNull();

    now = 1_000;
    const probe = breaker.tryAcquire();
    expect(probe).toMatchObject({
      admission: {
        mode: 'probe',
      },
      transition: {
        state: 'half-open',
        trigger: 'cooldown-elapsed',
      },
    });
    expect(breaker.tryAcquire()).toBeNull();

    expect(breaker.recordOutcome(probe!.admission, 'completed')).toMatchObject({
      state: 'closed',
      trigger: 'probe-succeeded',
      consecutiveFailures: 0,
    });
    expect(breaker.tryAcquire()).toMatchObject({
      admission: {
        mode: 'normal',
      },
    });
  });

  it('reopens the cooldown when a half-open probe fails or aborts', () => {
    let now = 0;
    const breaker = new IsolatedAgentRuntimeCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      now: () => now,
    });

    const initial = breaker.tryAcquire()!;
    breaker.recordOutcome(initial.admission, 'failed');
    now = 100;
    const failedProbe = breaker.tryAcquire()!;
    expect(
      breaker.recordOutcome(failedProbe.admission, 'failed'),
    ).toMatchObject({
      state: 'open',
      trigger: 'probe-failed',
    });

    now = 199;
    expect(breaker.tryAcquire()).toBeNull();
    now = 200;
    const abortedProbe = breaker.tryAcquire()!;
    expect(
      breaker.recordOutcome(abortedProbe.admission, 'aborted'),
    ).toMatchObject({
      state: 'open',
      trigger: 'probe-aborted',
    });
    now = 299;
    expect(breaker.tryAcquire()).toBeNull();
  });

  it('ignores stale outcomes from executions admitted before opening', () => {
    const breaker = new IsolatedAgentRuntimeCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
    });
    const failing = breaker.tryAcquire()!;
    const staleSuccess = breaker.tryAcquire()!;

    breaker.recordOutcome(failing.admission, 'failed');

    expect(
      breaker.recordOutcome(staleSuccess.admission, 'completed'),
    ).toBeNull();
    expect(breaker.tryAcquire()).toBeNull();
  });

  it('resets sub-threshold failures after a successful execution', () => {
    const breaker = new IsolatedAgentRuntimeCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
    });
    const failure = breaker.tryAcquire()!;
    breaker.recordOutcome(failure.admission, 'failed');
    const success = breaker.tryAcquire()!;

    expect(breaker.recordOutcome(success.admission, 'completed')).toMatchObject(
      {
        state: 'closed',
        trigger: 'success-reset',
        consecutiveFailures: 0,
      },
    );
  });
});
