import type { CloudTaskControlPlane } from './cloud-task-control-plane';
import type { CloudTaskExecutionLease } from './cloud-task-execution-lease';
import {
  classifyCloudTaskFailure,
  type CloudTaskControlPlaneAuditEvent,
} from './cloud-task-observability';
import type { CloudTaskStreamResumeStore } from './cloud-task-resume-store';
import type {
  CloudDataResidency,
  CloudTaskSecretBroker,
} from './cloud-task-security';

export type CloudTaskReconciliationReason = 'startup' | 'system-resumed';

export interface CloudTaskReconciliationResult {
  inspected: number;
  cancelled: number;
  cleared: number;
  retained: number;
  failed: number;
}

export interface CloudTaskRecoveryCoordinatorOptions {
  controlPlane: CloudTaskControlPlane;
  secretBroker: CloudTaskSecretBroker;
  resumeStore: CloudTaskStreamResumeStore;
  residency: CloudDataResidency;
  audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
  now?: () => number;
  leaseHolderId?: string;
}

/**
 * Reconciles executions that outlived their owning renderer/main-process run.
 *
 * A persisted checkpoint intentionally contains no credential or remote URL.
 * Reconciliation obtains a fresh task-scoped lease, asks the fixed-origin
 * control-plane endpoint for status, and cancels any still-active execution.
 * Network/auth failures retain the bounded checkpoint for a later resume
 * attempt; corrupt and expired checkpoints are removed by the store.
 */
export class CloudTaskRecoveryCoordinator {
  private reconciliation: Promise<CloudTaskReconciliationResult> | null = null;
  private readonly now: () => number;
  private readonly leaseHolderId: string;

  public constructor(
    private readonly options: CloudTaskRecoveryCoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.leaseHolderId = options.leaseHolderId ?? 'clodex-recovery';
  }

  public reconcile(
    _reason: CloudTaskReconciliationReason,
  ): Promise<CloudTaskReconciliationResult> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileInternal().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async reconcileInternal(): Promise<CloudTaskReconciliationResult> {
    const startedAt = this.now();
    const result: CloudTaskReconciliationResult = {
      inspected: 0,
      cancelled: 0,
      cleared: 0,
      retained: 0,
      failed: 0,
    };
    const checkpoints = await this.options.resumeStore.listPending();
    for (const checkpoint of checkpoints) {
      if (
        checkpoint.handoff ||
        (checkpoint.cloudOwnership && checkpoint.agentInstanceId)
      ) {
        // A confirmed handoff is intentionally suspended with local ownership.
        // A bound cloud-owned execution is recovered by Teleport. Neither may
        // be orphan-cancelled by the generic unbound-task reconciler.
        result.inspected += 1;
        result.retained += 1;
        continue;
      }
      let lease:
        | Awaited<ReturnType<CloudTaskSecretBroker['acquire']>>
        | undefined;
      let executionLease: CloudTaskExecutionLease | undefined;
      try {
        lease = await this.options.secretBroker.acquire({
          taskId: checkpoint.taskId,
          residency: this.options.residency,
          scopes: ['task:lease', 'task:status', 'task:cancel'],
        });
        const acquireExecutionLease =
          this.options.controlPlane.acquireExecutionLease;
        if (!acquireExecutionLease) {
          throw new Error('Cloud task execution lease API is unavailable');
        }
        executionLease = await acquireExecutionLease.call(
          this.options.controlPlane,
          {
            taskId: checkpoint.taskId,
            executionId: checkpoint.executionId,
            holderId: this.leaseHolderId,
            checkpointId: null,
            restoreReceiptId: checkpoint.restoreReceiptId,
          },
          lease.token,
        );
        const status = await this.options.controlPlane.getExecutionStatus(
          checkpoint.taskId,
          checkpoint.executionId,
          lease.token,
          undefined,
          executionLease,
        );
        result.inspected += 1;
        if (
          status.status === 'completed' ||
          status.status === 'failed' ||
          status.status === 'cancelled'
        ) {
          await this.options.resumeStore.clearByExecutionId(
            checkpoint.executionId,
          );
          result.cleared += 1;
          continue;
        }

        await this.options.controlPlane.cancelExecutionById(
          checkpoint.taskId,
          checkpoint.executionId,
          lease.token,
          undefined,
          executionLease,
        );
        result.cancelled += 1;
        await this.options.resumeStore.clearByExecutionId(
          checkpoint.executionId,
        );
        result.cleared += 1;
      } catch (error) {
        result.failed += 1;
        result.retained += 1;
        this.audit({
          operation: 'reconcile',
          success: false,
          residency: this.options.residency,
          reason: classifyCloudTaskFailure(error),
        });
      } finally {
        if (lease && executionLease) {
          await this.options.controlPlane.releaseExecutionLease
            ?.call(this.options.controlPlane, executionLease, lease.token)
            .catch(() => undefined);
        }
        await lease?.dispose();
      }
    }
    this.audit({
      operation: 'reconcile',
      success: result.failed === 0,
      residency: this.options.residency,
      durationMs: this.now() - startedAt,
      inspectedExecutions: result.inspected,
      cancelledExecutions: result.cancelled,
      clearedCheckpoints: result.cleared,
      retainedCheckpoints: result.retained,
    });
    return result;
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change reconciliation outcome.
    }
  }
}
