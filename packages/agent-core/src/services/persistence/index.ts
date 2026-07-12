/**
 * Persistence facade for agent-core.
 *
 * Hosts construct one `AgentCorePersistence` at boot, passing in the
 * already-assembled `AgentHost` (paths + logger + optional data protection)
 * and the `AgentStore`.
 * The facade owns:
 *   - construction order of every persistence service in core
 *   - schema migration ordering (each service still owns its own
 *     migration, but the facade decides the await order)
 *   - the "all persistence ready" signal — once `await create()`
 *     resolves, every DB has finished migrating
 *   - teardown sequencing on shutdown
 *
 * Hosts no longer enumerate `DiffHistoryService.create`,
 * `FileReadCacheService.create`, `MemoryNotesService.create`,
 * `ProcessedImageCacheService.create`, `AgentPersistenceDB.create`, and
 * `new AttachmentsService(...)` individually. They receive a typed bag with
 * each service as a `readonly` field.
 */

import type { AgentHost } from '../../host';
import type { AgentStore } from '../../store';
import { DisposableService } from '../shared/disposable';
import { AttachmentsService } from '../attachments';
import { DiffHistoryService } from '../diff-history';
import { FileReadCacheService } from '../file-read-cache';
import { MemoryNotesService } from '../memory-notes';
import { ProcessedImageCacheService } from '../processed-image-cache';
import { AgentPersistenceDB } from '../agent-persistence';
import {
  createHashingLocalEmbeddingProvider,
  EvidenceMemorySummaryScheduler,
  EvidenceMemoryService,
  type EvidenceMemoryDogfoodCohortReport,
  type EvidenceMemorySummarizer,
} from '../evidence-memory';

export interface AgentCorePersistenceOptions {
  host: AgentHost;
  store: AgentStore;
  /**
   * Enables the prompt-inert Evidence Memory event ledger. Hosts should gate
   * this during rollout; omission keeps the current persistence behavior.
   */
  enableEvidenceMemory?: boolean;
  enableEvidenceMemoryPromptInjection?: boolean;
  evidenceMemoryPromptInjectionAdmission?: (taskId: string) => boolean;
  onEvidenceMemoryDogfoodCohortEvaluated?: (
    report: EvidenceMemoryDogfoodCohortReport,
  ) => void;
  enableEvidenceMemoryHybridRetrieval?: boolean;
  enableEvidenceMemorySummaryMaterialization?: boolean;
  evidenceMemorySummarizer?: EvidenceMemorySummarizer;
  onProtectedMigrationStage?: (stage: 'caches' | 'titles/search') => void;
  /**
   * Optional pre-constructed `AttachmentsService`. Useful when host
   * services that boot before the persistence facade (e.g. the
   * browser's `WindowLayoutService` registering the `attachment://`
   * protocol handler) need to share a single instance with the
   * facade. If omitted, the facade constructs its own.
   */
  attachments?: AttachmentsService;
}

interface AgentCorePersistenceParts {
  diffHistory: DiffHistoryService;
  fileReadCache: FileReadCacheService;
  memoryNotes: MemoryNotesService | undefined;
  evidenceMemory: EvidenceMemoryService | undefined;
  evidenceMemorySummaryScheduler: EvidenceMemorySummaryScheduler | undefined;
  processedImageCache: ProcessedImageCacheService | undefined;
  attachments: AttachmentsService;
  agentDb: AgentPersistenceDB;
}

export class AgentCorePersistence extends DisposableService {
  private readonly host: AgentHost;
  public readonly diffHistory: DiffHistoryService;
  public readonly fileReadCache: FileReadCacheService;
  /**
   * Explicitly queried long-term notes. Separate from the read-only memory
   * archive and never injected into prompts automatically.
   */
  public readonly memoryNotes: MemoryNotesService | undefined;
  /**
   * Append-only, provenance-ready task event ledger. It remains prompt-inert
   * until shadow retrieval and guarded context injection are enabled.
   */
  public readonly evidenceMemory: EvidenceMemoryService | undefined;
  public readonly evidenceMemorySummaryScheduler:
    | EvidenceMemorySummaryScheduler
    | undefined;
  /**
   * Optional — initialisation is wrapped in try/catch so image-cache
   * failures (e.g. corrupted DB, disk full) degrade gracefully without
   * blocking agent boot. Consumers must treat it as optional.
   */
  public readonly processedImageCache: ProcessedImageCacheService | undefined;
  public readonly attachments: AttachmentsService;
  public readonly agentDb: AgentPersistenceDB;

  private constructor(parts: AgentCorePersistenceParts, host: AgentHost) {
    super();
    this.host = host;
    this.diffHistory = parts.diffHistory;
    this.fileReadCache = parts.fileReadCache;
    this.memoryNotes = parts.memoryNotes;
    this.evidenceMemory = parts.evidenceMemory;
    this.evidenceMemorySummaryScheduler = parts.evidenceMemorySummaryScheduler;
    this.processedImageCache = parts.processedImageCache;
    this.attachments = parts.attachments;
    this.agentDb = parts.agentDb;
  }

  /**
   * Build every persistence service in core. Resolves only after every
   * required DB has finished migrating. Throws if `AgentPersistenceDB`
   * fails to initialise — without agent persistence, nothing meaningful
   * can happen.
   */
  public static async create(
    opts: AgentCorePersistenceOptions,
  ): Promise<AgentCorePersistence> {
    const { host, store } = opts;
    const { paths, logger } = host;

    const diffHistory = await DiffHistoryService.create({ host, store });
    const fileReadCache = await FileReadCacheService.create({
      host: paths,
      logger,
      dataProtection: host.dataProtection,
    });
    let memoryNotes: MemoryNotesService | undefined;
    try {
      memoryNotes = await MemoryNotesService.create({
        host: paths,
        logger,
        dataProtection: host.dataProtection,
      });
    } catch (err) {
      logger.warn(
        `[AgentCorePersistence] MemoryNotesService failed to initialise — memory-note tools disabled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    let evidenceMemory: EvidenceMemoryService | undefined;
    let evidenceMemorySummaryScheduler:
      | EvidenceMemorySummaryScheduler
      | undefined;
    if (opts.enableEvidenceMemory) {
      try {
        evidenceMemory = await EvidenceMemoryService.create({
          host: paths,
          logger,
          dataProtection: host.dataProtection,
          enableDeterministicClaimExtraction: true,
          enableContradictionAutomation: true,
          enablePromptInjection: opts.enableEvidenceMemoryPromptInjection,
          promptInjectionAdmission: opts.evidenceMemoryPromptInjectionAdmission,
          onDogfoodCohortEvaluated: opts.onEvidenceMemoryDogfoodCohortEvaluated,
          localEmbeddingProvider: opts.enableEvidenceMemoryHybridRetrieval
            ? createHashingLocalEmbeddingProvider()
            : undefined,
        });
        host.bindEvidenceMemory(evidenceMemory);
        if (opts.enableEvidenceMemorySummaryMaterialization !== false) {
          try {
            evidenceMemorySummaryScheduler =
              await EvidenceMemorySummaryScheduler.create({
                evidenceMemory,
                logger,
                summarize: opts.evidenceMemorySummarizer,
              });
          } catch (err) {
            logger.warn(
              `[AgentCorePersistence] Evidence Memory summary scheduler failed to initialise — ledger remains available: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        logger.warn(
          `[AgentCorePersistence] EvidenceMemoryService failed to initialise — evidence ledger disabled: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        host.bindEvidenceMemory(undefined);
      }
    }
    const processedImageCache = await ProcessedImageCacheService.create({
      host: paths,
      logger,
      dataProtection: host.dataProtection,
    });
    opts.onProtectedMigrationStage?.('caches');
    const attachments =
      opts.attachments ?? new AttachmentsService(paths, host.protectedFiles);
    const agentDb = await AgentPersistenceDB.create({
      host: paths,
      logger,
      dataProtection: host.dataProtection,
    });
    if (!agentDb) {
      throw new Error(
        '[AgentCorePersistence] AgentPersistenceDB.create returned null — schema migration failed',
      );
    }
    opts.onProtectedMigrationStage?.('titles/search');

    return new AgentCorePersistence(
      {
        diffHistory,
        fileReadCache,
        memoryNotes,
        evidenceMemory,
        evidenceMemorySummaryScheduler,
        processedImageCache,
        attachments,
        agentDb,
      },
      host,
    );
  }

  /**
   * Late-bound resolver for `DiffHistoryService`'s gitignore check.
   * Called by the host once `ToolboxService` / `MountManagerService`
   * has finished its async init.
   */
  public setMountPathsResolver(resolver: () => Set<string>): void {
    this.diffHistory.setMountPathsResolver(resolver);
  }

  protected async onTeardown(): Promise<void> {
    await this.diffHistory.teardown();
    this.fileReadCache.teardown();
    this.memoryNotes?.teardown();
    await this.evidenceMemorySummaryScheduler?.teardown();
    await this.evidenceMemory?.teardown();
    this.hostEvidenceMemoryUnbind();
    this.processedImageCache?.teardown();
  }

  private hostEvidenceMemoryUnbind(): void {
    // The service is disposed at this point. Existing agent instances must
    // stop attempting writes during the remainder of host teardown.
    // `diffHistory` retains the same host instance, so access it through the
    // service-owned capability seam rather than storing a duplicate host.
    this.host.bindEvidenceMemory(undefined);
  }
}
