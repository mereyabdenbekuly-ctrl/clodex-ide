export interface CloudTaskExecutionLease {
  leaseId: string;
  taskId: string;
  executionId: string;
  restoreReceiptId: string;
  holderId: string;
  epoch: number;
  fencingToken: string;
  acquiredAt: number;
  expiresAt: number;
}

export type CloudTaskExecutionLeaseFailureReason =
  | 'conflict'
  | 'stale-fencing-token'
  | 'expired'
  | 'invalid';

export class CloudTaskExecutionLeaseError extends Error {
  public constructor(
    public readonly reason: CloudTaskExecutionLeaseFailureReason,
    message?: string,
  ) {
    super(
      message ??
        (reason === 'conflict'
          ? 'Another execution owner already holds the task lease'
          : reason === 'stale-fencing-token'
            ? 'Cloud task fencing token is stale'
            : reason === 'expired'
              ? 'Cloud task execution lease expired'
              : 'Cloud task execution lease is invalid'),
    );
    this.name = 'CloudTaskExecutionLeaseError';
  }
}

export interface CloudTaskExecutionLeaseRegistryOptions {
  now?: () => number;
}

/**
 * Process-local ownership mirror.
 *
 * The control plane remains authoritative. This mirror prevents the same IDE
 * process from executing local work for an agent after the cloud restore has
 * acquired ownership, and makes a newer epoch immediately fence an older
 * stream in the same process.
 */
export class CloudTaskExecutionLeaseRegistry {
  private readonly now: () => number;
  private readonly leasesByAgent = new Map<string, CloudTaskExecutionLease>();
  private readonly durableFencesByAgent = new Map<string, number>();

  public constructor(options: CloudTaskExecutionLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  public activate(
    agentInstanceId: string,
    lease: CloudTaskExecutionLease,
  ): void {
    validateLease(lease, this.now());
    const durableEpoch = this.durableFencesByAgent.get(agentInstanceId);
    if (durableEpoch !== undefined && lease.epoch <= durableEpoch) {
      throw new CloudTaskExecutionLeaseError('conflict');
    }
    const current = this.get(agentInstanceId);
    if (current && current.leaseId !== lease.leaseId) {
      if (lease.epoch <= current.epoch) {
        throw new CloudTaskExecutionLeaseError('conflict');
      }
    }
    this.leasesByAgent.set(agentInstanceId, structuredClone(lease));
    this.durableFencesByAgent.delete(agentInstanceId);
  }

  /**
   * Restores a content-free local-write fence before remote ownership can be
   * reconciled after an IDE restart. No lease id or fencing token is persisted.
   */
  public fence(agentInstanceId: string, epoch: number): void {
    if (
      !isOpaqueId(agentInstanceId) ||
      !Number.isSafeInteger(epoch) ||
      epoch <= 0
    ) {
      throw new CloudTaskExecutionLeaseError('invalid');
    }
    const current = this.durableFencesByAgent.get(agentInstanceId) ?? 0;
    this.durableFencesByAgent.set(agentInstanceId, Math.max(current, epoch));
  }

  public clearFence(agentInstanceId: string, throughEpoch: number): void {
    const current = this.durableFencesByAgent.get(agentInstanceId);
    if (current !== undefined && current <= throughEpoch) {
      this.durableFencesByAgent.delete(agentInstanceId);
    }
  }

  public renew(agentInstanceId: string, lease: CloudTaskExecutionLease): void {
    validateLease(lease, this.now());
    const current = this.get(agentInstanceId);
    if (
      !current ||
      current.leaseId !== lease.leaseId ||
      current.epoch !== lease.epoch ||
      current.fencingToken !== lease.fencingToken
    ) {
      throw new CloudTaskExecutionLeaseError('stale-fencing-token');
    }
    if (lease.expiresAt <= current.expiresAt) {
      throw new CloudTaskExecutionLeaseError(
        'invalid',
        'Renewed cloud task lease must extend its expiry',
      );
    }
    this.leasesByAgent.set(agentInstanceId, structuredClone(lease));
  }

  public assertCurrent(
    agentInstanceId: string,
    lease: CloudTaskExecutionLease,
  ): void {
    const current = this.get(agentInstanceId);
    if (!current) {
      throw new CloudTaskExecutionLeaseError('expired');
    }
    if (
      current.leaseId !== lease.leaseId ||
      current.epoch !== lease.epoch ||
      current.fencingToken !== lease.fencingToken
    ) {
      throw new CloudTaskExecutionLeaseError('stale-fencing-token');
    }
  }

  public release(
    agentInstanceId: string,
    lease: CloudTaskExecutionLease,
  ): void {
    const current = this.leasesByAgent.get(agentInstanceId);
    if (
      current?.leaseId === lease.leaseId &&
      current.epoch === lease.epoch &&
      current.fencingToken === lease.fencingToken
    ) {
      this.leasesByAgent.delete(agentInstanceId);
    }
  }

  public isLocalExecutionAllowed(agentInstanceId: string): boolean {
    return (
      this.get(agentInstanceId) === null &&
      !this.durableFencesByAgent.has(agentInstanceId)
    );
  }

  public get(agentInstanceId: string): CloudTaskExecutionLease | null {
    const lease = this.leasesByAgent.get(agentInstanceId);
    if (!lease) return null;
    if (lease.expiresAt <= this.now()) {
      this.leasesByAgent.delete(agentInstanceId);
      return null;
    }
    return structuredClone(lease);
  }
}

function validateLease(lease: CloudTaskExecutionLease, now: number): void {
  if (
    !isOpaqueId(lease.leaseId) ||
    !isOpaqueId(lease.taskId) ||
    !isOpaqueId(lease.executionId) ||
    !isOpaqueId(lease.restoreReceiptId) ||
    !isOpaqueId(lease.holderId) ||
    !isOpaqueId(lease.fencingToken) ||
    !Number.isSafeInteger(lease.epoch) ||
    lease.epoch <= 0 ||
    !Number.isSafeInteger(lease.acquiredAt) ||
    lease.acquiredAt < 0 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= now ||
    lease.expiresAt <= lease.acquiredAt
  ) {
    throw new CloudTaskExecutionLeaseError('invalid');
  }
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}
