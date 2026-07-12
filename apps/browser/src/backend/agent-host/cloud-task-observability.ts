import type { CloudTaskExecutionPolicy } from './cloud-task-security';

export interface CloudTaskControlPlaneAuditEvent {
  operation:
    | 'upload'
    | 'start'
    | 'restore-handshake'
    | 'lease-acquire'
    | 'lease-renew'
    | 'lease-release'
    | 'handoff-suspend'
    | 'handoff-resume'
    | 'stream'
    | 'cancel'
    | 'artifact'
    | 'resume'
    | 'usage'
    | 'reconcile'
    | 'retention'
    | 'artifact-open'
    | 'artifact-reveal'
    | 'artifact-export';
  success: boolean;
  residency: CloudTaskExecutionPolicy['residency'];
  reason?:
    | 'auth'
    | 'policy'
    | 'network'
    | 'integrity'
    | 'aborted'
    | 'execution'
    | 'restore'
    | 'handoff'
    | 'lease';
  durationMs?: number;
  snapshotBytes?: number;
  snapshotFiles?: number;
  artifactBytes?: number;
  resumedBytes?: number;
  resumeSequence?: number;
  costMicros?: number;
  usageDurationMs?: number;
  limit?: 'duration' | 'cost' | 'artifact-bytes' | 'artifact-files';
  inspectedExecutions?: number;
  cancelledExecutions?: number;
  clearedCheckpoints?: number;
  retainedCheckpoints?: number;
  removedArtifacts?: number;
  removedBytes?: number;
}

export function classifyCloudTaskFailure(
  error: unknown,
): NonNullable<CloudTaskControlPlaneAuditEvent['reason']> {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const message = normalized.message.toLowerCase();
  if (normalized.name === 'AbortError' || message.includes('abort')) {
    return 'aborted';
  }
  if (message.includes('auth') || message.includes('credential')) return 'auth';
  if (
    message.includes('policy') ||
    message.includes('quota') ||
    message.includes('residency') ||
    message.includes('limit')
  ) {
    return 'policy';
  }
  if (
    message.includes('integrity') ||
    message.includes('hash') ||
    message.includes('digest')
  ) {
    return 'integrity';
  }
  if (
    message.includes('lease') ||
    message.includes('fencing') ||
    message.includes('owner')
  ) {
    return 'lease';
  }
  if (message.includes('restore') || message.includes('checkpoint')) {
    return 'restore';
  }
  if (message.includes('handoff') || message.includes('suspend')) {
    return 'handoff';
  }
  if (message.includes('execution')) return 'execution';
  return 'network';
}
