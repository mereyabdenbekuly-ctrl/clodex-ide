import {
  EvidenceMemoryDivergenceError,
  EvidenceMemoryFencedWriteError,
} from '@clodex/agent-core/evidence-memory';
import { describe, expect, it } from 'vitest';
import { CloudTaskMemoryRecoveryPolicy } from './cloud-task-memory-recovery-policy';
import { CloudTaskMemoryCompareAndSwapError } from './cloud-task-memory-atomic-sync';

describe('CloudTaskMemoryRecoveryPolicy', () => {
  it('retries only transient transport failures with bounded backoff', () => {
    const policy = new CloudTaskMemoryRecoveryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 250,
      jitterRatio: 0,
    });

    expect(policy.classify(new TypeError('fetch failed'))).toEqual({
      recoveryClass: 'transient',
      decision: 'retry',
      retryable: true,
    });
    expect(policy.getBackoffMs(1)).toBe(100);
    expect(policy.getBackoffMs(2)).toBe(200);
    expect(policy.getBackoffMs(3)).toBe(250);
  });

  it('fails closed for divergence and fencing failures', () => {
    const policy = new CloudTaskMemoryRecoveryPolicy();

    expect(
      policy.classify(new EvidenceMemoryDivergenceError('event-1')),
    ).toEqual(
      expect.objectContaining({
        recoveryClass: 'checkpoint-conflict',
        retryable: false,
      }),
    );
    expect(
      policy.classify(new EvidenceMemoryFencedWriteError('stale-epoch')),
    ).toEqual(
      expect.objectContaining({
        recoveryClass: 'ownership-conflict',
        retryable: false,
      }),
    );
  });

  it('retries CAS conflicts only by rebuilding the proof', () => {
    const policy = new CloudTaskMemoryRecoveryPolicy();
    expect(
      policy.classify(
        new CloudTaskMemoryCompareAndSwapError(
          { checkpointId: 'before', eventCount: 1 },
          { checkpointId: 'after', eventCount: 2 },
        ),
      ),
    ).toEqual({
      recoveryClass: 'concurrent-update',
      decision: 'retry',
      retryable: true,
    });
  });
});
