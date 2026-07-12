export type IsolatedAgentRuntimeOutcome = 'completed' | 'aborted' | 'failed';

export interface IsolatedAgentRuntimeCircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export interface IsolatedAgentRuntimeAdmission {
  readonly mode: 'normal' | 'probe';
  readonly generation: number;
}

export interface IsolatedAgentRuntimeCircuitBreakerTransition {
  state: 'open' | 'half-open' | 'closed';
  trigger:
    | 'failure-threshold'
    | 'cooldown-elapsed'
    | 'probe-succeeded'
    | 'probe-failed'
    | 'probe-aborted'
    | 'success-reset';
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
}

export interface IsolatedAgentRuntimeAcquisition {
  admission: IsolatedAgentRuntimeAdmission;
  transition?: IsolatedAgentRuntimeCircuitBreakerTransition;
}

/**
 * In-memory circuit breaker for the isolated agent-step lane.
 *
 * It never replays a dispatched step. Instead, repeated post-dispatch
 * failures quarantine future compatible steps before dispatch and route them
 * through the existing local fallback. After a cooldown, exactly one
 * half-open probe is admitted.
 */
export class IsolatedAgentRuntimeCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private generation = 0;

  public constructor({
    failureThreshold,
    cooldownMs,
    now = Date.now,
  }: IsolatedAgentRuntimeCircuitBreakerOptions) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new Error('Circuit breaker failureThreshold must be at least 1');
    }
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error('Circuit breaker cooldownMs must be non-negative');
    }

    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  public canAttempt(): boolean {
    if (this.openedAt === null) return true;
    return !this.probeInFlight && this.now() - this.openedAt >= this.cooldownMs;
  }

  public tryAcquire(): IsolatedAgentRuntimeAcquisition | null {
    if (this.openedAt === null) {
      return {
        admission: {
          mode: 'normal',
          generation: this.generation,
        },
      };
    }
    if (!this.canAttempt()) return null;

    this.probeInFlight = true;
    return {
      admission: {
        mode: 'probe',
        generation: this.generation,
      },
      transition: this.transition('half-open', 'cooldown-elapsed'),
    };
  }

  public recordOutcome(
    admission: IsolatedAgentRuntimeAdmission,
    outcome: IsolatedAgentRuntimeOutcome,
  ): IsolatedAgentRuntimeCircuitBreakerTransition | null {
    if (admission.generation !== this.generation) return null;

    if (admission.mode === 'probe') {
      return this.recordProbeOutcome(outcome);
    }

    switch (outcome) {
      case 'completed': {
        if (this.consecutiveFailures === 0) return null;
        this.consecutiveFailures = 0;
        return this.transition('closed', 'success-reset');
      }
      case 'aborted':
        return null;
      case 'failed':
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures < this.failureThreshold) return null;
        this.openedAt = this.now();
        this.probeInFlight = false;
        this.generation += 1;
        return this.transition('open', 'failure-threshold');
    }
  }

  private recordProbeOutcome(
    outcome: IsolatedAgentRuntimeOutcome,
  ): IsolatedAgentRuntimeCircuitBreakerTransition {
    this.probeInFlight = false;
    this.generation += 1;

    switch (outcome) {
      case 'completed':
        this.consecutiveFailures = 0;
        this.openedAt = null;
        return this.transition('closed', 'probe-succeeded');
      case 'aborted':
        this.openedAt = this.now();
        return this.transition('open', 'probe-aborted');
      case 'failed':
        this.consecutiveFailures = Math.max(
          this.failureThreshold,
          this.consecutiveFailures + 1,
        );
        this.openedAt = this.now();
        return this.transition('open', 'probe-failed');
    }
  }

  private transition(
    state: IsolatedAgentRuntimeCircuitBreakerTransition['state'],
    trigger: IsolatedAgentRuntimeCircuitBreakerTransition['trigger'],
  ): IsolatedAgentRuntimeCircuitBreakerTransition {
    return {
      state,
      trigger,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
    };
  }
}
