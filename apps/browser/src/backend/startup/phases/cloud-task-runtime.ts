import type { EvidenceMemoryService } from '@clodex/agent-core/evidence-memory';
import { FileSystemCloudTaskArtifactStore } from '../../agent-host/cloud-task-artifact-store';
import { FileSystemCloudTaskArtifactDownloader } from '../../agent-host/cloud-task-artifacts';
import { HttpCloudTaskControlPlane } from '../../agent-host/cloud-task-control-plane';
import { LocalCloudTaskEvidenceMemorySynchronizer } from '../../agent-host/cloud-task-evidence-memory-sync';
import { CloudTaskExecutionHandoffCoordinator } from '../../agent-host/cloud-task-execution-handoff';
import type { CloudTaskExecutionLeaseRegistry } from '../../agent-host/cloud-task-execution-lease';
import { FileSystemCloudTaskMemorySyncJournal } from '../../agent-host/cloud-task-memory-sync-journal';
import {
  CloudTaskUploadSnapshotPackager,
  ProductionCloudExecutionTargetAdapter,
  type CloudTaskControlPlaneAuditEvent,
} from '../../agent-host/cloud-task-production-adapter';
import { CloudTaskRecoveryCoordinator } from '../../agent-host/cloud-task-recovery';
import { FileSystemCloudTaskStreamResumeStore } from '../../agent-host/cloud-task-resume-store';
import {
  CloudTaskSecretBroker,
  type CloudTaskExecutionPolicy,
} from '../../agent-host/cloud-task-security';
import { FileSystemCloudTaskSnapshotPackager } from '../../agent-host/cloud-task-snapshot-packager';
import { CloudTaskTeleportRecovery } from '../../agent-host/cloud-task-teleport-recovery';
import type { Logger } from '../../services/logger';

export type CloudTaskRuntimeInput = {
  logger: Pick<Logger, 'debug' | 'warn'>;
  baseUrl: string | undefined;
  residency: string | undefined;
  killSwitchActive: boolean;
  artifactRootDirectory: string;
  resumeRootDirectory: string;
  memorySyncJournalFilePath: string;
  getAccountAccessToken: () => string | undefined;
  isFeatureEnabled: () => boolean;
  leaseRegistry: CloudTaskExecutionLeaseRegistry;
  leaseHolderId: string;
  resolveMounts: (
    agentInstanceId: string,
  ) => readonly { prefix: string; path: string }[];
  isProtectedFile: (absolutePath: string) => Promise<boolean>;
  audit: (event: CloudTaskControlPlaneAuditEvent) => void;
  evidenceMemory: EvidenceMemoryService | undefined;
};

export type CloudTaskRuntime = {
  adapter: ProductionCloudExecutionTargetAdapter;
  snapshotPackager: CloudTaskUploadSnapshotPackager;
  residency: CloudTaskExecutionPolicy['residency'];
  artifactStore: FileSystemCloudTaskArtifactStore;
  recovery: CloudTaskRecoveryCoordinator;
  teleportRecovery: CloudTaskTeleportRecovery;
  handoff: CloudTaskExecutionHandoffCoordinator;
  memorySyncJournal: FileSystemCloudTaskMemorySyncJournal;
  audit: (event: CloudTaskControlPlaneAuditEvent) => void;
};

export type CloudTaskRuntimeResult = CloudTaskRuntime | null;

export function createCloudTaskRuntime(
  input: CloudTaskRuntimeInput,
): CloudTaskRuntimeResult {
  if (input.killSwitchActive) {
    input.logger.warn(
      '[CloudTasks] Emergency kill switch is active; production adapter remains fail closed',
    );
    return null;
  }
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    input.logger.debug(
      '[CloudTasks] Production control plane is not configured; adapter remains fail closed',
    );
    return null;
  }
  try {
    const controlPlane = new HttpCloudTaskControlPlane({ baseUrl });
    const policy: CloudTaskExecutionPolicy = {
      residency: parseCloudTaskResidency(input.residency),
      maxSnapshotBytes: 256 * 1024 * 1024,
      maxSnapshotFiles: 5_000,
      maxArtifactBytes: 512 * 1024 * 1024,
      maxArtifactFiles: 100,
      maxDurationMs: 30 * 60 * 1000,
      maxCostMicros: 5_000_000,
    };
    const secretBroker = new CloudTaskSecretBroker({
      transport: controlPlane,
      getAccountAccessToken: input.getAccountAccessToken,
      audience: 'clodex-cloud-task-runtime',
    });
    const snapshotPackager = new CloudTaskUploadSnapshotPackager({
      controlPlane,
      getAccountAccessToken: input.getAccountAccessToken,
      resolvePolicy: () => policy,
      createLocalPackager: ({ cryptoProvider, maxEntries, maxTotalBytes }) =>
        new FileSystemCloudTaskSnapshotPackager({
          resolveMounts: input.resolveMounts,
          cryptoProvider,
          maxEntries,
          maxTotalBytes,
          isProtectedFile: input.isProtectedFile,
        }),
      audit: input.audit,
    });
    const artifactStore = new FileSystemCloudTaskArtifactStore({
      rootDirectory: input.artifactRootDirectory,
      residency: policy.residency,
      maxDiskBytes: 2 * 1024 * 1024 * 1024,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      audit: input.audit,
    });
    const artifactDownloader = new FileSystemCloudTaskArtifactDownloader({
      rootDirectory: input.artifactRootDirectory,
      controlPlane,
      secretBroker,
      artifactStore,
      audit: input.audit,
    });
    const resumeStore = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory: input.resumeRootDirectory,
    });
    const memorySyncJournal = new FileSystemCloudTaskMemorySyncJournal({
      filePath: input.memorySyncJournalFilePath,
    });
    const evidenceMemorySynchronizer = input.evidenceMemory
      ? new LocalCloudTaskEvidenceMemorySynchronizer({
          evidenceMemory: input.evidenceMemory,
          transport: {
            push: async ({
              taskId,
              execution,
              batch,
              taskCredential,
              signal,
            }) => {
              if (!controlPlane.pushEvidenceMemory) {
                throw new Error(
                  'Cloud evidence memory push API is unavailable',
                );
              }
              return await controlPlane.pushEvidenceMemory(
                { taskId, execution, batch },
                taskCredential,
                signal,
              );
            },
            pull: async ({
              taskId,
              execution,
              cursor,
              taskCredential,
              signal,
            }) => {
              if (!controlPlane.pullEvidenceMemory) {
                throw new Error(
                  'Cloud evidence memory pull API is unavailable',
                );
              }
              return await controlPlane.pullEvidenceMemory(
                { taskId, execution, cursor },
                taskCredential,
                signal,
              );
            },
            commitAtomicMerge: controlPlane.commitEvidenceMemoryAtomicMerge
              ? async ({
                  taskId,
                  execution,
                  request,
                  taskCredential,
                  signal,
                }) =>
                  await controlPlane.commitEvidenceMemoryAtomicMerge!(
                    { taskId, execution, request },
                    taskCredential,
                    signal,
                  )
              : undefined,
            resolveDivergence: async ({
              taskId,
              execution,
              strategy,
              taskCredential,
              signal,
            }) => {
              if (!controlPlane.resolveEvidenceMemoryDivergence) {
                throw new Error(
                  'Cloud evidence memory resolution API is unavailable',
                );
              }
              await controlPlane.resolveEvidenceMemoryDivergence(
                { taskId, execution, strategy },
                taskCredential,
                signal,
              );
            },
          },
          journal: memorySyncJournal,
        })
      : undefined;
    const handoff = new CloudTaskExecutionHandoffCoordinator({
      controlPlane,
      leaseRegistry: input.leaseRegistry,
      resumeStore,
      evidenceMemorySynchronizer,
    });
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker,
      getAccountAccessToken: input.getAccountAccessToken,
      resolvePolicy: () => policy,
      artifactDownloader,
      resumeStore,
      leaseRegistry: input.leaseRegistry,
      leaseHolderId: input.leaseHolderId,
      handoffCoordinator: handoff,
      evidenceMemorySynchronizer,
      audit: input.audit,
    });
    const recovery = new CloudTaskRecoveryCoordinator({
      controlPlane,
      secretBroker,
      resumeStore,
      residency: policy.residency,
      leaseHolderId: `${input.leaseHolderId}:recovery`,
      audit: input.audit,
    });
    const teleportRecovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker,
      resumeStore,
      handoffCoordinator: handoff,
      leaseRegistry: input.leaseRegistry,
      artifactDownloader,
      evidenceMemorySynchronizer,
      policy,
      residency: policy.residency,
      leaseHolderId: input.leaseHolderId,
      isFeatureEnabled: input.isFeatureEnabled,
    });
    input.logger.debug(
      `[CloudTasks] Production control plane configured for ${policy.residency} residency`,
    );
    return {
      adapter,
      snapshotPackager,
      residency: policy.residency,
      artifactStore,
      recovery,
      teleportRecovery,
      handoff,
      memorySyncJournal,
      audit: input.audit,
    };
  } catch (error) {
    input.logger.warn(
      `[CloudTasks] Invalid production control-plane configuration; adapter remains fail closed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function parseCloudTaskResidency(
  value: string | undefined,
): CloudTaskExecutionPolicy['residency'] {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'eu' || normalized === 'apac' ? normalized : 'us';
}
