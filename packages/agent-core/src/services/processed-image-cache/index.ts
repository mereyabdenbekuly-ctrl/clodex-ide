import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { createHash } from 'node:crypto';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { processedImageCache, meta } from './schema';
import { migrateDatabase } from '../../migrate-database';
import { registry, schemaVersion } from './migrations';
import initSql from './schema.sql?raw';
import { DisposableService } from '../shared/disposable';
import type { HostPaths } from '../../host/paths';
import type { Logger } from '../../host/logger';
import type { ModalityConstraint } from '../../types/models';
import {
  isDataProtectionEnvelopeBuffer,
  type DataProtection,
} from '../../host/data-protection';
import { protectedFileContext } from '../../host/protected-files';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of cache entries to retain (LRU). */
const MAX_ENTRIES = 200;

/** Minimum interval between background LRU sweep operations (ms). */
const SWEEP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Schema = {
  processedImageCache: typeof processedImageCache;
  meta: typeof meta;
};

/**
 * Builds a deterministic string key from the processing-relevant fields of a
 * `ModalityConstraint`. Undefined dimensions are encoded as `*`.
 *
 * Format: `maxWidthPx|maxHeightPx|maxTotalPixels|maxBytes`
 *
 * `mimeTypes` is intentionally excluded from the key. The output MIME type
 * is stored in the `media_type` column and filtered at lookup time, so a
 * WebP result cached for one constraint can be reused by any other constraint
 * that also allows WebP — avoiding redundant re-processing.
 */
export function buildConstraintKey(constraint: ModalityConstraint): string {
  const w = constraint.maxWidthPx ?? '*';
  const h = constraint.maxHeightPx ?? '*';
  const p = constraint.maxTotalPixels ?? '*';
  const b = constraint.maxBytes;
  return `${w}|${h}|${p}|${b}`;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProcessedImageCacheServiceOptions {
  host: HostPaths;
  logger: Logger;
  dataProtection?: DataProtection;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * SQLite-backed LRU cache for processed (resized/compressed/converted) images.
 *
 * Cache key: SHA-256(rawBuffer) + encoded constraint parameters.
 * Value: processed WebP bytes + media type.
 *
 * On cache hit the `last_used_at` timestamp is updated so the eviction policy
 * targets genuinely least-recently-used entries, not oldest-inserted entries.
 *
 * The LRU sweep runs asynchronously (fire-and-forget) after every `get` and
 * `set` call, throttled to at most once per 60 s.
 */
export class ProcessedImageCacheService extends DisposableService {
  private readonly db: LibSQLDatabase<Schema>;
  private readonly dbDriver: Client;
  private readonly logger: Logger;
  private readonly dataProtection: DataProtection | undefined;

  private _lastSweepMs = 0;

  private constructor(
    db: LibSQLDatabase<Schema>,
    dbDriver: Client,
    logger: Logger,
    dataProtection?: DataProtection,
  ) {
    super();
    this.db = db;
    this.dbDriver = dbDriver;
    this.logger = logger;
    this.dataProtection = dataProtection;
  }

  /**
   * Opens (or creates) the SQLite cache DB, runs migrations, and performs a
   * one-time startup sweep to enforce the MAX_ENTRIES limit carried over from
   * a previous session. DB path comes from `host.paths.processedImageCacheDbPath()`.
   */
  public static async create(
    opts: ProcessedImageCacheServiceOptions,
  ): Promise<ProcessedImageCacheService> {
    const { host, logger, dataProtection } = opts;
    if (!dataProtection) {
      throw new Error(
        '[ProcessedImageCache] Data protection is required for persistent cache storage',
      );
    }
    const url = `file:${host.processedImageCacheDbPath()}`;
    return ProcessedImageCacheService.createWithUrl(
      url,
      logger,
      dataProtection,
    );
  }

  /**
   * Opens the DB at an explicit libsql URL. Intended for testing
   * (e.g. pass `':memory:'` for an in-process SQLite DB).
   */
  public static async createWithUrl(
    url: string,
    logger: Logger,
    dataProtection?: DataProtection,
  ): Promise<ProcessedImageCacheService> {
    logger.debug(`[ProcessedImageCache] Opening DB at ${url}`);

    const dbDriver = createClient({ url });
    const db = drizzle(dbDriver, {
      schema: { processedImageCache, meta },
    }) as LibSQLDatabase<Schema>;

    await migrateDatabase({
      db: db as any,
      client: dbDriver,
      registry,
      initSql,
      schemaVersion,
    });

    const instance = new ProcessedImageCacheService(
      db,
      dbDriver,
      logger,
      dataProtection,
    );
    await instance.migrateProtectedRows();
    logger.debug(
      '[ProcessedImageCache] Migrations complete, running startup sweep',
    );
    await instance.runSweep();

    return instance;
  }

  /**
   * Look up a cached processed image.
   *
   * Returns `{ buf, mediaType }` on hit (and updates `last_used_at`), or
   * `null` on miss. The LRU sweep is fired asynchronously after a hit.
   */
  public async get(
    rawBuf: Buffer,
    constraint: ModalityConstraint,
  ): Promise<{ buf: Buffer; mediaType: string } | null> {
    this.assertNotDisposed();

    const sourceHash = sha256Hex(rawBuf);
    const constraintKey = buildConstraintKey(constraint);

    // Also filter by media_type: only return a cached result whose output
    // format is actually allowed by this constraint. This lets a WebP result
    // cached under one constraint serve any other constraint that also permits
    // WebP, without re-processing the image.
    const row = await this.db
      .select()
      .from(processedImageCache)
      .where(
        and(
          eq(processedImageCache.sourceHash, sourceHash),
          eq(processedImageCache.constraintKey, constraintKey),
          inArray(processedImageCache.mediaType, constraint.mimeTypes),
        ),
      )
      .get();

    if (!row) {
      this.logger.debug(
        `[ProcessedImageCache] Miss — hash=${sourceHash.slice(0, 12)}… key=${constraintKey}`,
      );
      return null;
    }

    // Update last_used_at so this entry isn't evicted by the LRU sweep.
    const nowMs = Date.now();
    await this.db
      .update(processedImageCache)
      .set({ lastUsedAt: nowMs })
      .where(
        and(
          eq(processedImageCache.sourceHash, sourceHash),
          eq(processedImageCache.constraintKey, constraintKey),
        ),
      );

    const resultData = this.decodeResultData(
      row.resultData as Buffer,
      sourceHash,
      constraintKey,
    );
    this.logger.debug(
      `[ProcessedImageCache] Hit — hash=${sourceHash.slice(0, 12)}… key=${constraintKey}, ` +
        `${resultData.length} bytes`,
    );

    this.scheduleSweep();

    return { buf: resultData, mediaType: row.mediaType };
  }

  /**
   * Store a processed image in the cache.
   *
   * Uses an UPSERT so concurrent writes for the same key are safe.
   * The LRU sweep is fired asynchronously after the write.
   */
  public async set(
    rawBuf: Buffer,
    constraint: ModalityConstraint,
    result: { buf: Buffer; mediaType: string },
  ): Promise<void> {
    this.assertNotDisposed();

    const sourceHash = sha256Hex(rawBuf);
    const constraintKey = buildConstraintKey(constraint);
    const nowMs = Date.now();
    const storedResultData = this.encodeResultData(
      result.buf,
      sourceHash,
      constraintKey,
    );

    await this.db
      .insert(processedImageCache)
      .values({
        sourceHash,
        constraintKey,
        resultData: storedResultData,
        mediaType: result.mediaType,
        lastUsedAt: nowMs,
      })
      .onConflictDoUpdate({
        target: [
          processedImageCache.sourceHash,
          processedImageCache.constraintKey,
        ],
        set: {
          resultData: storedResultData,
          mediaType: result.mediaType,
          lastUsedAt: nowMs,
        },
      });

    this.logger.debug(
      `[ProcessedImageCache] Stored — hash=${sourceHash.slice(0, 12)}… key=${constraintKey}, ` +
        `${result.buf.length} bytes`,
    );

    this.scheduleSweep();
  }

  /**
   * Fires the LRU sweep asynchronously (fire-and-forget), throttled to at
   * most once per SWEEP_INTERVAL_MS. Never blocks the caller.
   */
  private scheduleSweep(): void {
    if (Date.now() - this._lastSweepMs < SWEEP_INTERVAL_MS) return;
    this._lastSweepMs = Date.now();
    this.runSweep().catch((e: unknown) => {
      this.logger.warn('[ProcessedImageCache] Background sweep failed', e);
    });
  }

  /**
   * Deletes all entries beyond the MAX_ENTRIES LRU limit.
   * Selects the top MAX_ENTRIES rows ordered by last_used_at DESC and deletes
   * everything else.
   */
  private async runSweep(): Promise<void> {
    // Fetch the PKs of the rows we want to keep.
    const keep = await this.db
      .select({
        sourceHash: processedImageCache.sourceHash,
        constraintKey: processedImageCache.constraintKey,
      })
      .from(processedImageCache)
      .orderBy(desc(processedImageCache.lastUsedAt))
      .limit(MAX_ENTRIES);

    if (keep.length < MAX_ENTRIES) {
      // Fewer than MAX_ENTRIES rows — nothing to evict.
      return;
    }

    // Delete rows whose composite PK is not in the keep set.
    // SQLite doesn't support tuple IN expressions via Drizzle, so we build a
    // compound string key and delete rows that don't match.
    const keepKeys = new Set(
      keep.map((r) => `${r.sourceHash}||${r.constraintKey}`),
    );

    // Fetch all PKs to find eviction candidates.
    const all = await this.db
      .select({
        sourceHash: processedImageCache.sourceHash,
        constraintKey: processedImageCache.constraintKey,
      })
      .from(processedImageCache);

    const toDelete = all.filter(
      (r) => !keepKeys.has(`${r.sourceHash}||${r.constraintKey}`),
    );

    if (toDelete.length === 0) return;

    // Delete in batches using the sourceHash column (rows with the same hash
    // but different constraint keys are handled by the constraint_key filter).
    // Since we can't do a composite DELETE in one shot via Drizzle's type-safe
    // API, we delete each eviction candidate individually (count is small —
    // only the overflow above MAX_ENTRIES).
    for (const row of toDelete) {
      await this.db
        .delete(processedImageCache)
        .where(
          and(
            eq(processedImageCache.sourceHash, row.sourceHash),
            eq(processedImageCache.constraintKey, row.constraintKey),
          ),
        );
    }

    this.logger.debug(
      `[ProcessedImageCache] LRU sweep evicted ${toDelete.length} entr${toDelete.length === 1 ? 'y' : 'ies'}`,
    );
  }

  private cacheContext(sourceHash: string, constraintKey: string): string {
    return protectedFileContext.cache(
      'processed-image',
      `${sourceHash}/${constraintKey}`,
    );
  }

  private encodeResultData(
    resultData: Buffer,
    sourceHash: string,
    constraintKey: string,
  ): Buffer {
    return (
      this.dataProtection?.protectBuffer(
        resultData,
        this.cacheContext(sourceHash, constraintKey),
      ) ?? resultData
    );
  }

  private decodeResultData(
    resultData: Buffer,
    sourceHash: string,
    constraintKey: string,
  ): Buffer {
    const value = Buffer.from(resultData);
    if (!isDataProtectionEnvelopeBuffer(value)) {
      if (this.dataProtection) {
        throw new Error(
          '[ProcessedImageCache] Plaintext cache row found after protected migration',
        );
      }
      return value;
    }
    if (!this.dataProtection) {
      throw new Error(
        '[ProcessedImageCache] Protected cache row cannot be read without data protection',
      );
    }
    return this.dataProtection.unprotectBuffer(
      value,
      this.cacheContext(sourceHash, constraintKey),
    );
  }

  private async migrateProtectedRows(): Promise<void> {
    const rows = await this.db.select().from(processedImageCache);
    let migrated = 0;
    for (const row of rows) {
      const value = Buffer.from(row.resultData);
      const context = this.cacheContext(row.sourceHash, row.constraintKey);
      if (isDataProtectionEnvelopeBuffer(value)) {
        if (!this.dataProtection) {
          throw new Error(
            '[ProcessedImageCache] Protected cache data exists but data protection is unavailable',
          );
        }
        this.dataProtection.unprotectBuffer(value, context);
        continue;
      }
      if (!this.dataProtection) continue;
      await this.db
        .update(processedImageCache)
        .set({
          resultData: this.dataProtection.protectBuffer(value, context),
        })
        .where(
          and(
            eq(processedImageCache.sourceHash, row.sourceHash),
            eq(processedImageCache.constraintKey, row.constraintKey),
          ),
        );
      migrated++;
    }
    if (migrated > 0) {
      await this.compactAfterMigration();
      this.logger.info(
        `[ProcessedImageCache] Migrated ${migrated} plaintext cache row(s)`,
      );
    }
  }

  private async compactAfterMigration(): Promise<void> {
    await this.dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    await this.dbDriver.execute('VACUUM');
    await this.dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  protected onTeardown(): void {
    this.dbDriver.close();
  }
}

export { processImageForModel } from './image-processor';
export type { ImageProcessResult } from './image-processor';
