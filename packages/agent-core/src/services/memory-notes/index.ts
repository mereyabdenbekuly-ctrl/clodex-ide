import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  and,
  asc,
  count,
  desc,
  eq,
  lt,
  max,
  min,
  or,
  type SQL,
} from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import {
  isDataProtectionEnvelopeString,
  type DataProtection,
} from '../../host/data-protection';
import type { Logger } from '../../host/logger';
import type { HostPaths } from '../../host/paths';
import { migrateDatabase } from '../../migrate-database';
import { mkdir } from '../../fs';
import { DisposableService } from '../shared/disposable';
import { registry, schemaVersion } from './migrations';
import { memoryNotes, meta } from './schema';
import initSql from './schema.sql?raw';

export const MEMORY_NOTE_LIMITS = {
  titleLength: 160,
  contentLength: 20_000,
  tagCount: 16,
  tagLength: 48,
  scopeKeyLength: 4_096,
  queryLength: 500,
  listLimit: 50,
  searchLimit: 50,
  searchCandidates: 1_000,
} as const;

export const memoryNoteScopes = ['global', 'workspace', 'agent'] as const;
export type MemoryNoteScope = (typeof memoryNoteScopes)[number];

export const memoryNoteSensitivities = ['normal', 'sensitive'] as const;
export type MemoryNoteSensitivity = (typeof memoryNoteSensitivities)[number];

export const memorySearchMatchModes = [
  'any',
  'all-on-line',
  'all-within-entry',
] as const;
export type MemorySearchMatchMode = (typeof memorySearchMatchModes)[number];

export type MemoryNoteScopeRef =
  | { scope: 'global'; scopeKey: null }
  | { scope: 'workspace'; scopeKey: string }
  | { scope: 'agent'; scopeKey: string };

export interface MemoryNote {
  id: string;
  scope: MemoryNoteScope;
  scopeKey: string | null;
  title: string;
  content: string;
  tags: string[];
  sensitivity: MemoryNoteSensitivity;
  createdAt: number;
  updatedAt: number;
}

export type MemoryNoteSummary = Omit<MemoryNote, 'content'>;

export interface MemoryNoteSearchResult extends MemoryNoteSummary {
  excerpt: string;
}

export interface AddMemoryNoteInput {
  scope: MemoryNoteScopeRef;
  title: string;
  content: string;
  tags?: readonly string[];
  sensitivity?: MemoryNoteSensitivity;
}

export interface ListMemoryNotesInput {
  scopes: readonly MemoryNoteScopeRef[];
  limit?: number;
  offset?: number;
}

export interface SearchMemoryNotesInput {
  scopes: readonly MemoryNoteScopeRef[];
  query: string;
  mode?: MemorySearchMatchMode;
  limit?: number;
}

export interface ExportMemoryNotesInput {
  scope?: MemoryNoteScope;
}

export interface ClearMemoryNotesInput {
  scope?: MemoryNoteScope;
}

export interface MemoryNotesStats {
  total: number;
  byScope: Record<MemoryNoteScope, number>;
  oldestCreatedAt: number | null;
  newestUpdatedAt: number | null;
}

export interface MemoryNotesExport {
  format: 'clodex-memory-notes';
  version: 1;
  exportedAt: number;
  scope: MemoryNoteScope | 'all';
  notes: MemoryNote[];
}

export interface MemoryNotesServiceOptions {
  host: HostPaths;
  logger: Logger;
  dataProtection?: DataProtection;
}

type Schema = { memoryNotes: typeof memoryNotes; meta: typeof meta };
type MemoryNoteRow = typeof memoryNotes.$inferSelect;

const DATA_PROTECTION_MIGRATION_META_KEY =
  'memory-notes-data-protection-v1-complete';
const UNTRUSTED_EXCERPT_LENGTH = 280;

/**
 * Persistent, explicitly queried memory notes.
 *
 * This service is intentionally separate from the existing read-only
 * `memory/` history archive. Notes live in their own SQLite database under
 * the host data root, are never mounted into the agent filesystem, and are
 * never inserted into a prompt automatically.
 */
export class MemoryNotesService extends DisposableService {
  private readonly db: LibSQLDatabase<Schema>;
  private readonly dbDriver: Client;
  private readonly logger: Logger;
  private readonly dataProtection: DataProtection | undefined;

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

  public static async create(
    opts: MemoryNotesServiceOptions,
  ): Promise<MemoryNotesService> {
    const dbPath = path.join(opts.host.dataDir(), 'memory-notes.sqlite');
    await mkdir(path.dirname(dbPath), { recursive: true });
    return MemoryNotesService.createWithUrl(
      `file:${dbPath}`,
      opts.logger,
      opts.dataProtection,
    );
  }

  /**
   * Opens an explicit libSQL URL. Intended for tests and non-default hosts.
   */
  public static async createWithUrl(
    url: string,
    logger: Logger,
    dataProtection?: DataProtection,
  ): Promise<MemoryNotesService> {
    logger.debug(`[MemoryNotes] Opening DB at ${url}`);
    const dbDriver = createClient({ url });
    const db = drizzle(dbDriver, {
      schema: { memoryNotes, meta },
    }) as LibSQLDatabase<Schema>;

    const service = new MemoryNotesService(
      db,
      dbDriver,
      logger,
      dataProtection,
    );
    try {
      await migrateDatabase({
        db: db as never,
        client: dbDriver,
        registry,
        initSql,
        schemaVersion,
      });
      await service.migratePlaintextFields();
      logger.debug('[MemoryNotes] Migrations complete');
      return service;
    } catch (error) {
      dbDriver.close();
      throw error;
    }
  }

  public async add(input: AddMemoryNoteInput): Promise<MemoryNote> {
    this.assertNotDisposed();
    const scope = normalizeScopeRef(input.scope);
    const title = normalizeTitle(input.title);
    const content = normalizeContent(input.content);
    const tags = normalizeTags(input.tags ?? []);
    const sensitivity = normalizeSensitivity(input.sensitivity ?? 'normal');
    const id = randomUUID();
    const now = Date.now();

    await this.db.insert(memoryNotes).values({
      id,
      scope: scope.scope,
      scopeKey:
        scope.scopeKey === null
          ? null
          : this.protectString(
              scope.scopeKey,
              memoryNoteFieldContext(id, 'scopeKey'),
            ),
      scopeKeyHash: hashScopeRef(scope),
      title: this.protectString(title, memoryNoteFieldContext(id, 'title')),
      content: this.protectString(
        content,
        memoryNoteFieldContext(id, 'content'),
      ),
      tags: this.protectString(
        JSON.stringify(tags),
        memoryNoteFieldContext(id, 'tags'),
      ),
      sensitivity,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.debug(`[MemoryNotes] Added ${id} (${scope.scope})`);
    return {
      id,
      scope: scope.scope,
      scopeKey: scope.scopeKey,
      title,
      content,
      tags,
      sensitivity,
      createdAt: now,
      updatedAt: now,
    };
  }

  public async list(input: ListMemoryNotesInput): Promise<MemoryNoteSummary[]> {
    this.assertNotDisposed();
    const scopes = normalizeScopeRefs(input.scopes);
    if (scopes.length === 0) return [];
    const limit = normalizeLimit(input.limit, 20, MEMORY_NOTE_LIMITS.listLimit);
    const offset = normalizeOffset(input.offset);

    const rows = await this.db
      .select()
      .from(memoryNotes)
      .where(buildScopePredicate(scopes))
      .orderBy(desc(memoryNotes.updatedAt))
      .limit(limit)
      .offset(offset);

    return rows.map((row) => this.decodeSummary(row));
  }

  public async read(
    id: string,
    scopes: readonly MemoryNoteScopeRef[],
  ): Promise<MemoryNote | null> {
    this.assertNotDisposed();
    const normalizedId = normalizeId(id);
    const normalizedScopes = normalizeScopeRefs(scopes);
    if (normalizedScopes.length === 0) return null;

    const row = await this.db
      .select()
      .from(memoryNotes)
      .where(
        and(
          eq(memoryNotes.id, normalizedId),
          buildScopePredicate(normalizedScopes),
        ),
      )
      .get();

    return row ? this.decodeNote(row) : null;
  }

  public async search(
    input: SearchMemoryNotesInput,
  ): Promise<MemoryNoteSearchResult[]> {
    this.assertNotDisposed();
    const scopes = normalizeScopeRefs(input.scopes);
    if (scopes.length === 0) return [];
    const query = normalizeQuery(input.query);
    const terms = getSearchTerms(query);
    const mode = normalizeSearchMode(input.mode ?? 'any');
    const limit = normalizeLimit(
      input.limit,
      20,
      MEMORY_NOTE_LIMITS.searchLimit,
    );

    // Text fields are protected, so SQL performs only the cheap scoped and
    // recency filter. Search happens after decryption over a bounded set.
    const rows = await this.db
      .select()
      .from(memoryNotes)
      .where(buildScopePredicate(scopes))
      .orderBy(desc(memoryNotes.updatedAt))
      .limit(MEMORY_NOTE_LIMITS.searchCandidates);

    const results: MemoryNoteSearchResult[] = [];
    for (const row of rows) {
      const note = this.decodeNote(row);
      if (!matchesSearch(note, terms, mode)) continue;
      results.push({
        ...toSummary(note),
        excerpt: createSearchExcerpt(note, terms, mode),
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  public async delete(
    id: string,
    scopes: readonly MemoryNoteScopeRef[],
  ): Promise<boolean> {
    this.assertNotDisposed();
    const normalizedId = normalizeId(id);
    const normalizedScopes = normalizeScopeRefs(scopes);
    if (normalizedScopes.length === 0) return false;

    const result = await this.db
      .delete(memoryNotes)
      .where(
        and(
          eq(memoryNotes.id, normalizedId),
          buildScopePredicate(normalizedScopes),
        ),
      );
    const deleted = result.rowsAffected > 0;
    if (deleted) this.logger.debug(`[MemoryNotes] Deleted ${normalizedId}`);
    return deleted;
  }

  public async getStats(): Promise<MemoryNotesStats> {
    this.assertNotDisposed();
    const totals = await this.db
      .select({
        total: count(),
        oldestCreatedAt: min(memoryNotes.createdAt),
        newestUpdatedAt: max(memoryNotes.updatedAt),
      })
      .from(memoryNotes)
      .get();
    const scopeCounts = await this.db
      .select({
        scope: memoryNotes.scope,
        total: count(),
      })
      .from(memoryNotes)
      .groupBy(memoryNotes.scope);
    const byScope: Record<MemoryNoteScope, number> = {
      global: 0,
      workspace: 0,
      agent: 0,
    };
    for (const row of scopeCounts) {
      byScope[normalizeStoredScope(row.scope)] = row.total;
    }

    return {
      total: totals?.total ?? 0,
      byScope,
      oldestCreatedAt: totals?.oldestCreatedAt ?? null,
      newestUpdatedAt: totals?.newestUpdatedAt ?? null,
    };
  }

  /**
   * Creates a portable, decrypted JSON-ready export. The SQLite database and
   * its protected envelopes are deliberately never exposed.
   */
  public async exportNotes(
    input: ExportMemoryNotesInput = {},
  ): Promise<MemoryNotesExport> {
    this.assertNotDisposed();
    const scope =
      input.scope === undefined ? undefined : normalizeStoredScope(input.scope);
    const query = this.db.select().from(memoryNotes);
    const rows =
      scope === undefined
        ? await query.orderBy(asc(memoryNotes.createdAt), asc(memoryNotes.id))
        : await query
            .where(eq(memoryNotes.scope, scope))
            .orderBy(asc(memoryNotes.createdAt), asc(memoryNotes.id));

    return {
      format: 'clodex-memory-notes',
      version: 1,
      exportedAt: Date.now(),
      scope: scope ?? 'all',
      notes: rows.map((row) => this.decodeNote(row)),
    };
  }

  /**
   * Permanently removes all notes or all notes of one scope type.
   */
  public async clear(input: ClearMemoryNotesInput = {}): Promise<number> {
    this.assertNotDisposed();
    const scope =
      input.scope === undefined ? undefined : normalizeStoredScope(input.scope);
    const result =
      scope === undefined
        ? await this.db.delete(memoryNotes)
        : await this.db.delete(memoryNotes).where(eq(memoryNotes.scope, scope));
    if (result.rowsAffected > 0) {
      await this.compactAfterBulkDelete();
      this.logger.debug(
        `[MemoryNotes] Cleared ${result.rowsAffected} note(s) (${scope ?? 'all'})`,
      );
    }
    return result.rowsAffected;
  }

  /**
   * Removes notes whose latest update is older than the supplied timestamp.
   */
  public async pruneOlderThan(cutoffTimestamp: number): Promise<number> {
    this.assertNotDisposed();
    if (
      !Number.isSafeInteger(cutoffTimestamp) ||
      cutoffTimestamp < 0 ||
      cutoffTimestamp > Date.now() + 1
    ) {
      throw new Error('Invalid memory retention cutoff timestamp');
    }
    const result = await this.db
      .delete(memoryNotes)
      .where(lt(memoryNotes.updatedAt, cutoffTimestamp));
    if (result.rowsAffected > 0) {
      await this.compactAfterBulkDelete();
      this.logger.debug(
        `[MemoryNotes] Retention removed ${result.rowsAffected} note(s)`,
      );
    }
    return result.rowsAffected;
  }

  private decodeNote(row: MemoryNoteRow): MemoryNote {
    const summary = this.decodeSummary(row);
    return {
      ...summary,
      content: this.unprotectString(
        row.content,
        memoryNoteFieldContext(row.id, 'content'),
      ),
    };
  }

  private decodeSummary(row: MemoryNoteRow): MemoryNoteSummary {
    const scope = normalizeStoredScope(row.scope);
    const scopeKey =
      row.scopeKey === null
        ? null
        : this.unprotectString(
            row.scopeKey,
            memoryNoteFieldContext(row.id, 'scopeKey'),
          );
    const sensitivity = normalizeSensitivity(row.sensitivity);
    const tagsValue = this.unprotectString(
      row.tags,
      memoryNoteFieldContext(row.id, 'tags'),
    );
    const parsedTags: unknown = JSON.parse(tagsValue);
    if (
      !Array.isArray(parsedTags) ||
      !parsedTags.every((tag) => typeof tag === 'string')
    ) {
      throw new Error(`Memory note ${row.id} has invalid stored tags`);
    }

    return {
      id: row.id,
      scope,
      scopeKey,
      title: this.unprotectString(
        row.title,
        memoryNoteFieldContext(row.id, 'title'),
      ),
      tags: parsedTags,
      sensitivity,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private protectString(value: string, context: string): string {
    return this.dataProtection?.protectString(value, context) ?? value;
  }

  private unprotectString(value: string, context: string): string {
    if (!isDataProtectionEnvelopeString(value)) return value;
    if (!this.dataProtection) {
      throw new Error(
        `Protected memory note data requires host data protection (${context})`,
      );
    }
    return this.dataProtection.unprotectString(value, context);
  }

  private async migratePlaintextFields(): Promise<void> {
    if (!this.dataProtection) return;

    const rows = await this.db.select().from(memoryNotes);
    let migratedFields = 0;
    for (const row of rows) {
      const updates: Partial<typeof memoryNotes.$inferInsert> = {};
      migratedFields += this.stageProtectedField(
        updates,
        'title',
        row.title,
        memoryNoteFieldContext(row.id, 'title'),
      );
      migratedFields += this.stageProtectedField(
        updates,
        'content',
        row.content,
        memoryNoteFieldContext(row.id, 'content'),
      );
      migratedFields += this.stageProtectedField(
        updates,
        'tags',
        row.tags,
        memoryNoteFieldContext(row.id, 'tags'),
      );
      if (row.scopeKey !== null) {
        migratedFields += this.stageProtectedField(
          updates,
          'scopeKey',
          row.scopeKey,
          memoryNoteFieldContext(row.id, 'scopeKey'),
        );
      }
      if (Object.keys(updates).length > 0) {
        await this.db
          .update(memoryNotes)
          .set(updates)
          .where(eq(memoryNotes.id, row.id));
      }
    }

    if (migratedFields > 0) {
      // Column encryption does not erase old plaintext from SQLite free pages
      // or the WAL. Compact after the one-way migration.
      await this.dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      await this.dbDriver.execute('VACUUM');
    }

    await this.db
      .insert(meta)
      .values({
        key: DATA_PROTECTION_MIGRATION_META_KEY,
        value: '1',
      })
      .onConflictDoUpdate({
        target: meta.key,
        set: { value: '1' },
      });
    if (migratedFields > 0) {
      await this.dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    this.logger.debug(
      `[MemoryNotes] Data-protection migration complete (${migratedFields} field(s))`,
    );
  }

  private stageProtectedField(
    updates: Partial<typeof memoryNotes.$inferInsert>,
    field: 'scopeKey' | 'title' | 'content' | 'tags',
    value: string,
    context: string,
  ): number {
    if (isDataProtectionEnvelopeString(value)) {
      // Authenticate existing ciphertext so startup fails closed on corrupt
      // data or the wrong key.
      this.unprotectString(value, context);
      return 0;
    }
    updates[field] = this.protectString(value, context);
    return 1;
  }

  private async compactAfterBulkDelete(): Promise<void> {
    await this.dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    await this.dbDriver.execute('VACUUM');
    await this.dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  protected onTeardown(): void {
    this.dbDriver.close();
  }
}

function normalizeScopeRef(scope: MemoryNoteScopeRef): MemoryNoteScopeRef {
  if (scope.scope === 'global') {
    if (scope.scopeKey !== null) {
      throw new Error('Global memory scope must not have a scope key');
    }
    return scope;
  }
  const scopeKey = scope.scopeKey.trim();
  if (scopeKey.length === 0) {
    throw new Error(`${scope.scope} memory scope requires a scope key`);
  }
  if (scopeKey.length > MEMORY_NOTE_LIMITS.scopeKeyLength) {
    throw new Error('Memory scope key is too long');
  }
  return { scope: scope.scope, scopeKey };
}

function normalizeScopeRefs(
  scopes: readonly MemoryNoteScopeRef[],
): MemoryNoteScopeRef[] {
  const unique = new Map<string, MemoryNoteScopeRef>();
  for (const scope of scopes) {
    const normalized = normalizeScopeRef(scope);
    unique.set(hashScopeRef(normalized), normalized);
  }
  return [...unique.values()];
}

function hashScopeRef(scope: MemoryNoteScopeRef): string {
  return createHash('sha256')
    .update(scope.scope)
    .update('\0')
    .update(scope.scopeKey ?? '')
    .digest('hex');
}

function buildScopePredicate(scopes: readonly MemoryNoteScopeRef[]): SQL {
  const predicates = scopes.map((scope) =>
    and(
      eq(memoryNotes.scope, scope.scope),
      eq(memoryNotes.scopeKeyHash, hashScopeRef(scope)),
    ),
  );
  const predicate = or(...predicates);
  if (!predicate) throw new Error('At least one memory scope is required');
  return predicate;
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0)
    throw new Error('Memory note title must not be empty');
  if (title.length > MEMORY_NOTE_LIMITS.titleLength) {
    throw new Error(
      `Memory note title exceeds ${MEMORY_NOTE_LIMITS.titleLength} characters`,
    );
  }
  return title;
}

function normalizeContent(value: string): string {
  if (value.trim().length === 0) {
    throw new Error('Memory note content must not be empty');
  }
  if (value.length > MEMORY_NOTE_LIMITS.contentLength) {
    throw new Error(
      `Memory note content exceeds ${MEMORY_NOTE_LIMITS.contentLength} characters`,
    );
  }
  return value;
}

function normalizeTags(tags: readonly string[]): string[] {
  if (tags.length > MEMORY_NOTE_LIMITS.tagCount) {
    throw new Error(
      `Memory note supports at most ${MEMORY_NOTE_LIMITS.tagCount} tags`,
    );
  }
  const unique = new Set<string>();
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (tag.length === 0) throw new Error('Memory note tags must not be empty');
    if (tag.length > MEMORY_NOTE_LIMITS.tagLength) {
      throw new Error(
        `Memory note tag exceeds ${MEMORY_NOTE_LIMITS.tagLength} characters`,
      );
    }
    unique.add(tag);
  }
  return [...unique];
}

function normalizeSensitivity(value: string): MemoryNoteSensitivity {
  if (value !== 'normal' && value !== 'sensitive') {
    throw new Error(`Unsupported memory note sensitivity: ${value}`);
  }
  return value;
}

function normalizeStoredScope(value: string): MemoryNoteScope {
  if (value !== 'global' && value !== 'workspace' && value !== 'agent') {
    throw new Error(`Unsupported stored memory note scope: ${value}`);
  }
  return value;
}

function normalizeSearchMode(value: string): MemorySearchMatchMode {
  if (
    value !== 'any' &&
    value !== 'all-on-line' &&
    value !== 'all-within-entry'
  ) {
    throw new Error(`Unsupported memory search mode: ${value}`);
  }
  return value;
}

function normalizeId(value: string): string {
  const id = value.trim();
  if (id.length === 0 || id.length > 128) {
    throw new Error('Invalid memory note id');
  }
  return id;
}

function normalizeQuery(value: string): string {
  const query = value.trim();
  if (query.length === 0) throw new Error('Memory search query is empty');
  if (query.length > MEMORY_NOTE_LIMITS.queryLength) {
    throw new Error(
      `Memory search query exceeds ${MEMORY_NOTE_LIMITS.queryLength} characters`,
    );
  }
  return query;
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Memory result limit must be between 1 and ${maximum}`);
  }
  return limit;
}

function normalizeOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    throw new Error('Memory result offset must be between 0 and 100000');
  }
  return offset;
}

function getSearchTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(query)
        .split(/\s+/)
        .filter((term) => term.length > 0),
    ),
  ];
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function getSearchLines(note: MemoryNote): string[] {
  return [note.title, ...note.content.split(/\r?\n/), note.tags.join(' ')];
}

function matchesSearch(
  note: MemoryNote,
  terms: readonly string[],
  mode: MemorySearchMatchMode,
): boolean {
  const lines = getSearchLines(note).map(normalizeSearchText);
  if (mode === 'all-on-line') {
    return lines.some((line) => terms.every((term) => line.includes(term)));
  }
  const entry = lines.join('\n');
  if (mode === 'all-within-entry') {
    return terms.every((term) => entry.includes(term));
  }
  return terms.some((term) => entry.includes(term));
}

function createSearchExcerpt(
  note: MemoryNote,
  terms: readonly string[],
  mode: MemorySearchMatchMode,
): string {
  const lines = getSearchLines(note)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const ranked = lines
    .map((line, index) => {
      const normalized = normalizeSearchText(line);
      const matches = terms.filter((term) => normalized.includes(term)).length;
      const allOnLine =
        mode === 'all-on-line' && matches === terms.length ? 1 : 0;
      return { line, index, matches, allOnLine };
    })
    .sort(
      (a, b) =>
        b.allOnLine - a.allOnLine || b.matches - a.matches || a.index - b.index,
    );
  const excerpt = ranked[0]?.line ?? note.title;
  return excerpt.length <= UNTRUSTED_EXCERPT_LENGTH
    ? excerpt
    : `${excerpt.slice(0, UNTRUSTED_EXCERPT_LENGTH - 1)}…`;
}

function toSummary(note: MemoryNote): MemoryNoteSummary {
  const { content: _content, ...summary } = note;
  return summary;
}

function memoryNoteFieldContext(id: string, field: string): string {
  return `memoryNotes/${encodeURIComponent(id)}/${field}`;
}
