import { describe, expect, it } from 'vitest';
import {
  CloudTaskExecutionLeaseError,
  CloudTaskExecutionLeaseRegistry,
  type CloudTaskExecutionLease,
} from './cloud-task-execution-lease';

function lease(
  overrides: Partial<CloudTaskExecutionLease> = {},
): CloudTaskExecutionLease {
  return {
    leaseId: 'lease-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    holderId: 'holder-1',
    epoch: 1,
    fencingToken: 'fence-1',
    acquiredAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('CloudTaskExecutionLeaseRegistry', () => {
  it('makes local execution read-only only after lease activation', () => {
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => 1_100 });
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(true);
    registry.activate('agent-1', lease());
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(false);
  });

  it('rejects a competing owner at the same epoch', () => {
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => 1_100 });
    registry.activate('agent-1', lease());
    expect(() =>
      registry.activate(
        'agent-1',
        lease({
          leaseId: 'lease-2',
          holderId: 'holder-2',
          fencingToken: 'fence-2',
        }),
      ),
    ).toThrowError(new CloudTaskExecutionLeaseError('conflict'));
  });

  it('lets a newer epoch fence the previous owner', () => {
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => 1_100 });
    const oldLease = lease();
    const newLease = lease({
      leaseId: 'lease-2',
      holderId: 'holder-2',
      epoch: 2,
      fencingToken: 'fence-2',
    });
    registry.activate('agent-1', oldLease);
    registry.activate('agent-1', newLease);
    expect(() => registry.assertCurrent('agent-1', oldLease)).toThrowError(
      new CloudTaskExecutionLeaseError('stale-fencing-token'),
    );
    expect(() => registry.assertCurrent('agent-1', newLease)).not.toThrow();
  });

  it('requires renewal to keep the same fencing identity and extend expiry', () => {
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => 1_100 });
    registry.activate('agent-1', lease());
    registry.renew('agent-1', lease({ expiresAt: 3_000 }));
    expect(registry.get('agent-1')?.expiresAt).toBe(3_000);
    expect(() =>
      registry.renew(
        'agent-1',
        lease({ fencingToken: 'stale-fence', expiresAt: 4_000 }),
      ),
    ).toThrowError(new CloudTaskExecutionLeaseError('stale-fencing-token'));
  });

  it('automatically restores local ownership after expiry', () => {
    let now = 1_100;
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => now });
    registry.activate('agent-1', lease());
    now = 2_001;
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(true);
  });

  it('only lets the exact current lease release local read-only mode', () => {
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => 1_100 });
    const oldLease = lease();
    const currentLease = lease({
      leaseId: 'lease-2',
      holderId: 'holder-2',
      epoch: 2,
      fencingToken: 'fence-2',
    });
    registry.activate('agent-1', oldLease);
    registry.activate('agent-1', currentLease);

    registry.release('agent-1', oldLease);
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(false);

    registry.release('agent-1', currentLease);
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(true);
  });

  it('restores a durable fence and only accepts a strictly newer epoch', () => {
    const registry = new CloudTaskExecutionLeaseRegistry({ now: () => 1_100 });
    registry.fence('agent-1', 2);
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(false);

    expect(() =>
      registry.activate('agent-1', lease({ epoch: 2 })),
    ).toThrowError(new CloudTaskExecutionLeaseError('conflict'));

    const recoveredLease = lease({
      leaseId: 'lease-3',
      epoch: 3,
      fencingToken: 'fence-3',
    });
    registry.activate('agent-1', recoveredLease);
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(false);

    registry.release('agent-1', recoveredLease);
    registry.clearFence('agent-1', recoveredLease.epoch);
    expect(registry.isLocalExecutionAllowed('agent-1')).toBe(true);
  });
});
