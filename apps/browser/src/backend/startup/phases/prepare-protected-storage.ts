import type { HostPaths } from '@clodex/agent-core';
import { AttachmentsService } from '@clodex/agent-core/attachments';
import {
  type DataProtection,
  ProtectedFileStorage,
} from '@clodex/agent-core/host';
import { migrateChronicleArtifacts } from '@/services/agent-os/chronicle';
import { migrateAssetCacheRowsAtStartup } from '@/services/asset-cache';
import { createBrowserHostPaths } from '@/services/agent-core-bridge/host-paths';
import { createBrowserDataProtection } from '@/services/data-protection';
import type { Logger } from '@/services/logger';
import {
  migrateDiffHistoryBlobs,
  migrateMemoryFiles,
  migrateShellLogFiles,
} from '@/services/protected-files/migrations';
import { P1ProtectedMigrationOrder } from '@/services/protected-files/order';

export interface ProtectedStoragePreparationResult {
  dataProtection: DataProtection;
  protectedFiles: ProtectedFileStorage;
  protectedMigrationOrder: P1ProtectedMigrationOrder;
  hostPaths: HostPaths;
  attachments: AttachmentsService;
}

export async function prepareProtectedStorage(
  logger: Logger,
): Promise<ProtectedStoragePreparationResult> {
  // Unlock the app-wide data key before any agent persistence opens. The key
  // file itself is wrapped by Electron safeStorage (OS keychain); startup
  // fails closed if the keychain is unavailable or the envelope is corrupt.
  const dataProtection = await createBrowserDataProtection(logger);
  const protectedFiles = new ProtectedFileStorage(dataProtection);
  const protectedMigrationOrder = new P1ProtectedMigrationOrder();

  // Build the browser-backed `HostPaths` early (zero dependencies) so
  // every subsequent service that wants path resolution receives it as
  // an injected capability rather than importing `@/utils/paths`
  // directly. The full `AgentHost` is assembled later — once
  // `ModelProviderService`, `TelemetryService`, and the logger are all
  // available — right before `attachAgentCoreBridge`.
  const hostPaths = createBrowserHostPaths();

  // The `AttachmentsService` is stateless (it just wraps `HostPaths`),
  // so it can be constructed before the full `AgentHost` exists.
  // Construct one early so `WindowLayoutService` can register the
  // `attachment://` protocol handler against it; the same instance is
  // handed to `AgentCorePersistence.create` below.
  const attachments = new AttachmentsService(hostPaths, protectedFiles);
  const migratedAttachmentCount = await protectedMigrationOrder.run(
    'attachments',
    () => attachments.migrateAllBlobs(),
  );
  if (migratedAttachmentCount > 0) {
    logger.info(
      `[ProtectedFiles] Migrated ${migratedAttachmentCount} attachment blob(s)`,
    );
  }

  // Immutable P1 startup migration order. These migrations are complete
  // before AgentCorePersistence opens cache/title databases.
  const migratedChronicleArtifactCount = await protectedMigrationOrder.run(
    'chronicle',
    () => migrateChronicleArtifacts(protectedFiles),
  );
  if (migratedChronicleArtifactCount > 0) {
    logger.info(
      `[ProtectedFiles] Migrated ${migratedChronicleArtifactCount} Chronicle artifact(s)`,
    );
  }
  const migratedShellLogCount = await protectedMigrationOrder.run(
    'shell-logs',
    () => migrateShellLogFiles(protectedFiles, hostPaths),
  );
  if (migratedShellLogCount > 0) {
    logger.info(
      `[ProtectedFiles] Migrated ${migratedShellLogCount} shell log(s)`,
    );
  }
  const migratedMemoryFileCount = await protectedMigrationOrder.run(
    'memory',
    () => migrateMemoryFiles(protectedFiles, hostPaths),
  );
  if (migratedMemoryFileCount > 0) {
    logger.info(
      `[ProtectedFiles] Migrated ${migratedMemoryFileCount} memory file(s)`,
    );
  }
  const migratedDiffHistoryBlobCount = await protectedMigrationOrder.run(
    'diff-history-blobs',
    () => migrateDiffHistoryBlobs(protectedFiles, hostPaths),
  );
  if (migratedDiffHistoryBlobCount > 0) {
    logger.info(
      `[ProtectedFiles] Migrated ${migratedDiffHistoryBlobCount} diff-history blob(s)`,
    );
  }
  await migrateAssetCacheRowsAtStartup(dataProtection, logger);

  return {
    dataProtection,
    protectedFiles,
    protectedMigrationOrder,
    hostPaths,
    attachments,
  };
}
