import { realpath } from '../../fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/libsql/driver';
import {
  and,
  notInArray,
  inArray,
  desc,
  asc,
  isNull,
  isNotNull,
  eq,
  sql,
  gte,
  lt,
} from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import superjson from 'superjson';
import * as schema from './schema';
import { registry, schemaVersion } from './migrations';
import initSql from './schema.sql?raw';
import { migrateDatabase } from '../../migrate-database';
import type { HostPaths } from '../../host/paths';
import type { Logger } from '../../host/logger';
import {
  isDataProtectionEnvelopeString,
  type DataProtection,
} from '../../host/data-protection';
import {
  AgentTypes,
  type AgentHistoryEntry,
  type AgentHistoryWorkspaceEntry,
  type AgentMessage,
} from '../../types/agent';
import type { ToolApprovalMode } from '../../types/tool-approval';

export interface AgentPersistenceDBDeps {
  host: HostPaths;
  logger: Logger;
  dataProtection?: DataProtection;
}

type WorkspaceUsageRow = {
  lastMessageAt: Date;
  mountedWorkspaces?: Array<{ path: string }> | null;
};

type ResolveWorkspaceUsagePath = (workspacePath: string) => Promise<string>;
const CHAT_SESSION_AGENT_TYPES = [AgentTypes.CHAT, AgentTypes.MAGUS] as const;
const DATA_PROTECTION_COMPACTION_META_KEY =
  'data-protection-v1-compaction-complete';

async function resolveWorkspaceUsagePath(
  workspacePath: string,
): Promise<string> {
  try {
    return await realpath(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

async function getWorkspaceUsageLookupKeys(
  workspacePath: string,
  resolveUsagePath: ResolveWorkspaceUsagePath,
): Promise<string[]> {
  const resolvedPath = await resolveUsagePath(workspacePath);
  return resolvedPath === workspacePath
    ? [workspacePath]
    : [workspacePath, resolvedPath];
}

export async function collectWorkspaceLastUsedAtByPath(
  workspacePaths: string[],
  rows: WorkspaceUsageRow[],
  resolveUsagePath: ResolveWorkspaceUsagePath = resolveWorkspaceUsagePath,
): Promise<Map<string, number>> {
  const uniquePaths = Array.from(new Set(workspacePaths));
  if (uniquePaths.length === 0) return new Map();

  const targetPathsByLookupKey = new Map<string, string[]>();
  for (const workspacePath of uniquePaths) {
    const lookupKeys = await getWorkspaceUsageLookupKeys(
      workspacePath,
      resolveUsagePath,
    );
    for (const lookupKey of lookupKeys) {
      targetPathsByLookupKey.set(lookupKey, [
        ...(targetPathsByLookupKey.get(lookupKey) ?? []),
        workspacePath,
      ]);
    }
  }

  const usage = new Map<string, number>();
  const resolvedWorkspacePathCache = new Map<string, string[]>();
  for (const row of rows) {
    for (const workspace of row.mountedWorkspaces ?? []) {
      let lookupKeys = resolvedWorkspacePathCache.get(workspace.path);
      if (!lookupKeys) {
        lookupKeys = await getWorkspaceUsageLookupKeys(
          workspace.path,
          resolveUsagePath,
        );
        resolvedWorkspacePathCache.set(workspace.path, lookupKeys);
      }

      const matchedTargetPaths = new Set<string>();
      for (const lookupKey of lookupKeys) {
        for (const targetPath of targetPathsByLookupKey.get(lookupKey) ?? []) {
          matchedTargetPaths.add(targetPath);
        }
      }
      if (matchedTargetPaths.size === 0) continue;

      const timestamp = row.lastMessageAt.getTime();
      for (const targetPath of matchedTargetPaths) {
        usage.set(targetPath, Math.max(usage.get(targetPath) ?? 0, timestamp));
      }
    }
  }

  return usage;
}

export class AgentPersistenceDB {
  private _dbDriver: Client;
  private _db: LibSQLDatabase<typeof schema>;
  private _logger: Logger;
  private _dataProtection: DataProtection | undefined;
  private _lastPersistedIds = new Map<string, string[]>();

  private constructor(deps: AgentPersistenceDBDeps) {
    const dbPath = deps.host.agentDbPath();
    deps.logger.debug(
      `[AgentPersistenceDB] Creating agent persistence DB at path: ${dbPath}`,
    );
    this._dbDriver = createClient({ url: `file:${dbPath}` });
    this._db = drizzle(this._dbDriver, { schema });
    this._logger = deps.logger;
    this._dataProtection = deps.dataProtection;
  }

  public get db(): LibSQLDatabase<typeof schema> {
    return this._db;
  }

  public static async create(
    deps: AgentPersistenceDBDeps,
  ): Promise<AgentPersistenceDB | null> {
    const instance = new AgentPersistenceDB(deps);

    try {
      deps.logger.debug(`[AgentPersistenceDB] Migrating database...`);
      await migrateDatabase({
        db: instance._db,
        client: instance._dbDriver,
        registry,
        initSql,
        schemaVersion,
      });
      deps.logger.debug(`[AgentPersistenceDB] Database migrated successfully`);
      if (instance._dataProtection) {
        await instance._migratePlaintextSensitiveFields();
      }
    } catch (e) {
      const err: Error = e as Error;
      deps.logger.error(
        `[AgentPersistenceDB] Failed to initialize. Error: ${err.message}, Stack: ${err.stack}`,
      );
      return null;
    }
    return instance;
  }

  // To prevent fetching already active agents as well, you can

  /**
   *
   * @param limit The number of agents to fetch
   * @param offset The offset to fetch the agents from
   * @param excludeIds The ids of the agents to exclude from the fetch
   * @param titleLike The title to filter the agents by (optional, case-insensitive)
   *
   * @note This method will not fetch any agents that have a parent agent instance.
   *
   * @returns The stored agent instances
   */
  public async getAgentHistoryEntries(
    limit: number,
    offset: number,
    excludeIds: string[],
    titleLike?: string,
    archived = false,
  ): Promise<AgentHistoryEntry[]> {
    const query = this._db
      .select({
        id: schema.agentInstances.id,
        type: schema.agentInstances.type,
        title: schema.agentInstances.title,
        createdAt: schema.agentInstances.createdAt,
        lastMessageAt: schema.agentInstances.lastMessageAt,
        messageCount: sql<number>`(SELECT COUNT(*) FROM agentMessages WHERE agent_instance_id = ${schema.agentInstances.id})`,
        parentAgentInstanceId: schema.agentInstances.parentAgentInstanceId,
        forkedFromAgentId: schema.agentInstances.forkedFromAgentId,
        forkedFromMessageId: schema.agentInstances.forkedFromMessageId,
        archivedAt: schema.agentInstances.archivedAt,
        mountedWorkspaces: schema.agentInstances.mountedWorkspaces,
      })
      .from(schema.agentInstances)
      .where(
        and(
          notInArray(schema.agentInstances.id, excludeIds),
          isNull(schema.agentInstances.parentAgentInstanceId),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
          archived
            ? isNotNull(schema.agentInstances.archivedAt)
            : isNull(schema.agentInstances.archivedAt),
        ),
      )
      // Order by lastMessageAt so the sidebar's time-bucket grouping
      // (Today / Yesterday / Last 7 days / ...) — which is keyed on
      // lastMessageAt — sees a contiguous, correctly-ordered page.
      // Ordering by createdAt here let agents whose latest activity was
      // recent but whose creation is older drop out of the initial page,
      // making them silently missing from groups like "Yesterday" until
      // the user clicked "Show more".
      .orderBy(desc(schema.agentInstances.lastMessageAt));

    // Randomized title ciphertext cannot be searched with SQL LIKE. Keep
    // indexed metadata filtering/order in SQLite, then decrypt and filter in
    // the trusted host process. Pagination must happen after title filtering
    // to preserve the previous API semantics.
    const results = titleLike
      ? await query
      : await query.limit(limit).offset(offset);

    this._logger.debug(`[AgentPersistenceDB] Fetched agent history entries`);

    const decoded = results.map((entry) => this._decodeHistoryEntry(entry));
    return titleLike
      ? decoded
          .filter((entry) =>
            matchesCaseInsensitiveSqlLike(entry.title, titleLike),
          )
          .slice(offset, offset + limit)
      : decoded;
  }

  /**
   *
   * @param limit The number of agents to fetch
   * @param offset The offset to fetch the agents from
   * @param excludeIds The ids of the agents to exclude from the fetch
   * @param titleLike The title to filter the agents by (optional, case-insensitive)
   *
   * @note This method will not fetch any agents that have a parent agent instance.
   *
   * @returns The stored agent instances
   */
  public async getAgentHistoryEntriesByIds(
    ids: string[],
    archived = false,
  ): Promise<AgentHistoryEntry[]> {
    if (ids.length === 0) return [];

    const results = await this._db
      .select({
        id: schema.agentInstances.id,
        type: schema.agentInstances.type,
        title: schema.agentInstances.title,
        createdAt: schema.agentInstances.createdAt,
        lastMessageAt: schema.agentInstances.lastMessageAt,
        messageCount: sql<number>`(SELECT COUNT(*) FROM agentMessages WHERE agent_instance_id = ${schema.agentInstances.id})`,
        parentAgentInstanceId: schema.agentInstances.parentAgentInstanceId,
        forkedFromAgentId: schema.agentInstances.forkedFromAgentId,
        forkedFromMessageId: schema.agentInstances.forkedFromMessageId,
        archivedAt: schema.agentInstances.archivedAt,
        mountedWorkspaces: schema.agentInstances.mountedWorkspaces,
      })
      .from(schema.agentInstances)
      .where(
        and(
          inArray(schema.agentInstances.id, ids),
          isNull(schema.agentInstances.parentAgentInstanceId),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
          archived
            ? isNotNull(schema.agentInstances.archivedAt)
            : isNull(schema.agentInstances.archivedAt),
        ),
      );

    this._logger.debug(
      `[AgentPersistenceDB] Fetched agent history entries by ids`,
    );

    const normalizedResults: AgentHistoryEntry[] = results.map((entry) =>
      this._decodeHistoryEntry(entry),
    );

    const resultById = new Map(
      normalizedResults.map((entry) => [entry.id, entry]),
    );
    return ids
      .map((id) => resultById.get(id))
      .filter((entry): entry is AgentHistoryEntry => entry !== undefined);
  }

  public async getStoredAgentInstanceById(
    id: string,
  ): Promise<schema.StoredAgentInstance | null> {
    this._logger.debug(`[AgentPersistenceDB] Fetching agent instance: ${id}`);
    try {
      const results = await this._db
        .selectDistinct()
        .from(schema.agentInstances)
        .where(eq(schema.agentInstances.id, id))
        .limit(1);

      const row = results?.[0] ?? null;
      if (!row) return null;

      // Reconstruct history from normalised message rows
      const messageRows = await this._db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.agentInstanceId, id))
        .orderBy(schema.agentMessages.seq);

      const history: AgentMessage[] = messageRows.map((r) => ({
        id: r.messageId,
        role: r.role as AgentMessage['role'],
        parts: this._unprotectJson(
          r.parts,
          agentMessageFieldContext(id, r.seq, 'parts'),
        ) as AgentMessage['parts'],
        metadata: this._unprotectJson(
          r.metadata,
          agentMessageFieldContext(id, r.seq, 'metadata'),
        ) as AgentMessage['metadata'],
      }));

      // Initialise dirty-tracking baseline
      this._lastPersistedIds.set(
        id,
        messageRows.map((r) => r.messageId),
      );

      return {
        ...row,
        title: this._unprotectString(
          row.title,
          agentInstanceFieldContext(id, 'title'),
        ),
        instanceConfig: this._unprotectJson(
          row.instanceConfig,
          agentInstanceFieldContext(id, 'instanceConfig'),
        ),
        queuedMessages: this._unprotectJson(
          row.queuedMessages,
          agentInstanceFieldContext(id, 'queuedMessages'),
        ) as schema.StoredAgentInstance['queuedMessages'],
        inputState: this._unprotectJson(
          row.inputState,
          agentInstanceFieldContext(id, 'inputState'),
        ) as schema.StoredAgentInstance['inputState'],
        goal: this._unprotectJson(
          row.goal,
          agentInstanceFieldContext(id, 'goal'),
        ) as schema.StoredAgentInstance['goal'],
        mountedWorkspaces: this._unprotectJson(
          row.mountedWorkspaces,
          agentInstanceFieldContext(id, 'mountedWorkspaces'),
        ) as schema.StoredAgentInstance['mountedWorkspaces'],
        history,
      };
    } catch (error) {
      this._logger.error(
        `[AgentPersistenceDB] Failed to fetch agent instance: ${error}`,
      );
      return null;
    }
  }

  /**
   * Stores or updates an agent instance in the persistence layer.
   * History is persisted incrementally into the `agentMessages` table —
   * only changed / new messages are written.
   *
   * @param agentInstance Scalar agent metadata (without history)
   * @param history       Current in-memory message history
   */
  public async storeAgentInstance<
    TMessage extends {
      id: string;
      role: string;
      parts: unknown;
      metadata?: unknown;
    } = AgentMessage,
  >(
    agentInstance: Omit<schema.NewStoredAgentInstance, 'history'>,
    history: TMessage[],
    dirtyMessageIndices?: number[],
  ): Promise<void> {
    const id = agentInstance.id;
    this._logger.debug(`[AgentPersistenceDB] Storing agent instance: ${id}`);

    // Compute divergence point outside the transaction (pure, no I/O)
    const lastIds = this._lastPersistedIds.get(id) ?? [];
    const divergePoint = this._findDivergencePoint(history, lastIds);
    const protectedAgentInstance: schema.NewStoredAgentInstance = {
      ...agentInstance,
      title: this._protectString(
        agentInstance.title,
        agentInstanceFieldContext(id, 'title'),
      ),
      instanceConfig: this._protectJson(
        agentInstance.instanceConfig,
        agentInstanceFieldContext(id, 'instanceConfig'),
      ),
      // The deprecated column remains encrypted for rollback safety even
      // though normalised agentMessages are the read source.
      history: this._protectJson([], agentInstanceFieldContext(id, 'history')),
      queuedMessages: this._protectJson(
        agentInstance.queuedMessages,
        agentInstanceFieldContext(id, 'queuedMessages'),
      ),
      inputState: this._protectJson(
        agentInstance.inputState,
        agentInstanceFieldContext(id, 'inputState'),
      ),
      goal: this._protectJson(
        agentInstance.goal,
        agentInstanceFieldContext(id, 'goal'),
      ),
      mountedWorkspaces: this._protectJson(
        agentInstance.mountedWorkspaces,
        agentInstanceFieldContext(id, 'mountedWorkspaces'),
      ),
    };
    const mutableAgentInstance = { ...protectedAgentInstance };
    delete mutableAgentInstance.forkedFromAgentId;
    delete mutableAgentInstance.forkedFromMessageId;
    delete mutableAgentInstance.archivedAt;

    try {
      await this._db.transaction(async (tx) => {
        // 1. Upsert scalar metadata and protected JSON fields.
        await tx
          .insert(schema.agentInstances)
          .values(protectedAgentInstance)
          .onConflictDoUpdate({
            target: schema.agentInstances.id,
            set: {
              ...mutableAgentInstance,
            },
          });

        // 2. Incremental message persistence via divergence detection

        // Delete divergent / truncated messages
        if (divergePoint < lastIds.length) {
          await tx
            .delete(schema.agentMessages)
            .where(
              and(
                eq(schema.agentMessages.agentInstanceId, id),
                gte(schema.agentMessages.seq, divergePoint),
              ),
            );
        }

        // Insert new / replacement messages from the divergence point
        if (divergePoint < history.length) {
          const newMsgs = history.slice(divergePoint);
          await tx.insert(schema.agentMessages).values(
            newMsgs.map((msg, i) => ({
              agentInstanceId: id,
              seq: divergePoint + i,
              messageId: msg.id,
              role: msg.role,
              parts: this._protectJson(
                msg.parts as unknown[],
                agentMessageFieldContext(id, divergePoint + i, 'parts'),
              ),
              metadata: this._protectJson(
                (msg.metadata ?? null) as unknown,
                agentMessageFieldContext(id, divergePoint + i, 'metadata'),
              ),
            })),
          );
        } else if (history.length > 0) {
          // No structural change — update the last message in case of
          // in-place mutations (streaming content, attachment draining)
          const lastMsg = history[history.length - 1]!;
          await tx
            .update(schema.agentMessages)
            .set({
              messageId: lastMsg.id,
              role: lastMsg.role,
              parts: this._protectJson(
                lastMsg.parts as unknown[],
                agentMessageFieldContext(id, history.length - 1, 'parts'),
              ),
              metadata: this._protectJson(
                (lastMsg.metadata ?? null) as unknown,
                agentMessageFieldContext(id, history.length - 1, 'metadata'),
              ),
            })
            .where(
              and(
                eq(schema.agentMessages.agentInstanceId, id),
                eq(schema.agentMessages.seq, history.length - 1),
              ),
            );
        }

        // 3. Targeted updates for in-place mutations on non-tail messages
        //    (e.g. history compression writing compressedHistory metadata)
        if (dirtyMessageIndices && dirtyMessageIndices.length > 0) {
          for (const idx of dirtyMessageIndices) {
            // Skip out-of-bounds or indices already written by divergence path
            if (idx < 0 || idx >= history.length || idx >= divergePoint)
              continue;
            const msg = history[idx]!;
            await tx
              .update(schema.agentMessages)
              .set({
                messageId: msg.id,
                role: msg.role,
                parts: this._protectJson(
                  msg.parts as unknown[],
                  agentMessageFieldContext(id, idx, 'parts'),
                ),
                metadata: this._protectJson(
                  (msg.metadata ?? null) as unknown,
                  agentMessageFieldContext(id, idx, 'metadata'),
                ),
              })
              .where(
                and(
                  eq(schema.agentMessages.agentInstanceId, id),
                  eq(schema.agentMessages.seq, idx),
                ),
              );
          }
        }
      });

      // Update dirty-tracking state only after successful commit
      this._lastPersistedIds.set(
        id,
        history.map((m) => m.id),
      );
    } catch (error) {
      this._logger.error(
        `[AgentPersistenceDB] Failed to store agent instance: ${(error as Error).message}, ${(error as Error).stack}`,
      );
      throw error;
    }
  }

  /**
   * Finds the first index where the current history diverges from the
   * last-persisted message IDs.  Optimises for the common case (pure
   * append) with a single comparison at the tail of the shared range.
   */
  private _findDivergencePoint<TMessage extends { id: string }>(
    history: TMessage[],
    lastIds: string[],
  ): number {
    const minLen = Math.min(history.length, lastIds.length);
    if (minLen === 0) return 0;
    // Fast path: if the last shared position matches, no undo occurred
    if (history[minLen - 1]!.id === lastIds[minLen - 1]) {
      return minLen;
    }
    // Slow path: linear scan for the divergence point
    for (let i = 0; i < minLen; i++) {
      if (history[i]!.id !== lastIds[i]) return i;
    }
    return minLen;
  }

  /**
   * Returns the activeModelId of the most recently persisted chat agent,
   * or null if no chat agents exist.
   */
  public async getLastChatModelId(): Promise<
    schema.StoredAgentInstance['activeModelId'] | null
  > {
    const results = await this._db
      .select({ activeModelId: schema.agentInstances.activeModelId })
      .from(schema.agentInstances)
      .where(
        and(
          isNull(schema.agentInstances.parentAgentInstanceId),
          isNull(schema.agentInstances.archivedAt),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
        ),
      )
      .orderBy(desc(schema.agentInstances.lastMessageAt))
      .limit(1)
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to fetch last chat model id: ${error}`,
        );
        return null;
      });

    return results?.[0]?.activeModelId ?? null;
  }

  /**
   * Returns the toolApprovalMode of the most recently persisted chat agent,
   * or null if no chat agents exist.
   */
  public async getLastChatToolApprovalMode(): Promise<
    schema.StoredAgentInstance['toolApprovalMode'] | null
  > {
    const results = await this._db
      .select({ toolApprovalMode: schema.agentInstances.toolApprovalMode })
      .from(schema.agentInstances)
      .where(
        and(
          isNull(schema.agentInstances.parentAgentInstanceId),
          isNull(schema.agentInstances.archivedAt),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
        ),
      )
      .orderBy(desc(schema.agentInstances.lastMessageAt))
      .limit(1)
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to fetch last chat tool approval mode: ${error}`,
        );
        return null;
      });

    return results?.[0]?.toolApprovalMode ?? null;
  }

  /**
   * Returns the mountedWorkspaces of the most recently persisted chat agent,
   * or null if no chat agents exist.
   */
  public async getLastChatWorkspacePaths(): Promise<
    schema.StoredAgentInstance['mountedWorkspaces'] | null
  > {
    const results = await this._db
      .select({
        id: schema.agentInstances.id,
        mountedWorkspaces: schema.agentInstances.mountedWorkspaces,
      })
      .from(schema.agentInstances)
      .where(
        and(
          isNull(schema.agentInstances.parentAgentInstanceId),
          isNull(schema.agentInstances.archivedAt),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
        ),
      )
      .orderBy(desc(schema.agentInstances.lastMessageAt))
      .limit(1)
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to fetch last chat workspace paths: ${error}`,
        );
        return null;
      });

    const row = results?.[0];
    if (!row) return null;
    return this._unprotectJson(
      row.mountedWorkspaces,
      agentInstanceFieldContext(row.id, 'mountedWorkspaces'),
    ) as schema.StoredAgentInstance['mountedWorkspaces'];
  }

  /**
   * Returns the most recently used non-empty workspace mount list from a
   * root chat agent. Unlike `getLastChatWorkspacePaths`, this skips fresh
   * empty chats so background flows can recover the user's current project.
   */
  public async getLastNonEmptyChatWorkspacePaths(): Promise<
    schema.StoredAgentInstance['mountedWorkspaces'] | null
  > {
    const results = await this._db
      .select({
        id: schema.agentInstances.id,
        mountedWorkspaces: schema.agentInstances.mountedWorkspaces,
      })
      .from(schema.agentInstances)
      .where(
        and(
          isNull(schema.agentInstances.parentAgentInstanceId),
          isNull(schema.agentInstances.archivedAt),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
        ),
      )
      .orderBy(desc(schema.agentInstances.lastMessageAt))
      .limit(50)
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to fetch non-empty chat workspace paths: ${error}`,
        );
        return null;
      });

    for (const row of results ?? []) {
      const mountedWorkspaces = this._unprotectJson(
        row.mountedWorkspaces,
        agentInstanceFieldContext(row.id, 'mountedWorkspaces'),
      ) as schema.StoredAgentInstance['mountedWorkspaces'];
      if ((mountedWorkspaces?.length ?? 0) > 0) return mountedWorkspaces;
    }
    return null;
  }

  public async getWorkspaceLastUsedAtByPath(
    workspacePaths: string[],
  ): Promise<Map<string, number>> {
    const uniquePaths = Array.from(new Set(workspacePaths));
    if (uniquePaths.length === 0) return new Map();

    const rows = await this._db
      .select({
        id: schema.agentInstances.id,
        lastMessageAt: schema.agentInstances.lastMessageAt,
        mountedWorkspaces: schema.agentInstances.mountedWorkspaces,
      })
      .from(schema.agentInstances)
      .where(
        and(
          isNull(schema.agentInstances.parentAgentInstanceId),
          isNull(schema.agentInstances.archivedAt),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
        ),
      )
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to fetch workspace last-use data: ${error}`,
        );
        return null;
      });

    const decodedRows: WorkspaceUsageRow[] = (rows ?? []).map((row) => ({
      lastMessageAt: row.lastMessageAt,
      mountedWorkspaces: this._unprotectJson(
        row.mountedWorkspaces,
        agentInstanceFieldContext(row.id, 'mountedWorkspaces'),
      ) as WorkspaceUsageRow['mountedWorkspaces'],
    }));

    return collectWorkspaceLastUsedAtByPath(uniquePaths, decodedRows);
  }

  /**
   * Updates just the title (and titleLockedByUser flag) of a persisted agent
   * without rehydrating it into memory. Used for renaming inactive history
   * agents — active ones go through BaseAgent.setTitle so Karton state and
   * DB stay in sync via the normal saveState() path.
   *
   * @returns true if a row was updated, false if no agent with that id exists.
   */
  public async updateAgentTitle(id: string, title: string): Promise<boolean> {
    this._logger.debug(`[AgentPersistenceDB] Updating title for agent: ${id}`);
    try {
      const result = await this._db
        .update(schema.agentInstances)
        .set({
          title: this._protectString(
            title,
            agentInstanceFieldContext(id, 'title'),
          ),
          titleLockedByUser: true,
        })
        .where(eq(schema.agentInstances.id, id));
      return (result as unknown as { rowsAffected: number }).rowsAffected > 0;
    } catch (error) {
      this._logger.error(
        `[AgentPersistenceDB] Failed to update agent title: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Updates just the tool approval mode of a persisted agent without
   * going through the full `storeAgentInstance` path. Avoids touching
   * history/message persistence, so it is safe to call on empty agents.
   *
   * @returns true if a row was updated, false if no agent with that id exists.
   */
  public async updateToolApprovalMode(
    id: string,
    mode: ToolApprovalMode,
  ): Promise<boolean> {
    this._logger.debug(
      `[AgentPersistenceDB] Updating tool approval mode for agent: ${id}`,
    );
    try {
      const result = await this._db
        .update(schema.agentInstances)
        .set({ toolApprovalMode: mode })
        .where(eq(schema.agentInstances.id, id));
      return (result as unknown as { rowsAffected: number }).rowsAffected > 0;
    } catch (error) {
      this._logger.error(
        `[AgentPersistenceDB] Failed to update tool approval mode: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  public async setAgentArchived(
    id: string,
    archived: boolean,
  ): Promise<boolean> {
    this._logger.debug(
      `[AgentPersistenceDB] ${archived ? 'Archiving' : 'Restoring'} task: ${id}`,
    );
    const result = await this._db
      .update(schema.agentInstances)
      .set({ archivedAt: archived ? new Date() : null })
      .where(
        and(
          eq(schema.agentInstances.id, id),
          isNull(schema.agentInstances.parentAgentInstanceId),
        ),
      );
    return (result as unknown as { rowsAffected: number }).rowsAffected > 0;
  }

  public async forkAgentInstance(
    sourceId: string,
    newId: string,
    throughMessageId?: string,
  ): Promise<void> {
    const source = await this.getStoredAgentInstanceById(sourceId);
    if (!source || source.parentAgentInstanceId) {
      throw new Error(`Fork source ${sourceId} is not a top-level task`);
    }

    const sourceHistory = source.history as AgentMessage[];
    let history = sourceHistory;
    if (throughMessageId) {
      const boundary = sourceHistory.findIndex(
        (message) => message.id === throughMessageId,
      );
      if (boundary === -1) {
        throw new Error(`Fork message ${throughMessageId} was not found`);
      }
      history = sourceHistory.slice(0, boundary + 1);
    }

    const now = Date.now();
    await this.storeAgentInstance(
      {
        id: newId,
        parentAgentInstanceId: null,
        type: source.type,
        instanceConfig: source.instanceConfig,
        createdAt: new Date(now),
        lastMessageAt: new Date(now),
        activeModelId: source.activeModelId,
        title: `${source.title} (fork)`,
        titleLockedByUser: true,
        queuedMessages: [],
        inputState: '',
        usedTokens: 0,
        goal: source.goal
          ? {
              objective: source.goal.objective,
              status: 'active',
              tokenBudget: source.goal.tokenBudget,
              timeBudgetSeconds: source.goal.timeBudgetSeconds ?? null,
              startedUsedTokens: 0,
              accumulatedActiveMs: 0,
              activeStartedAt: now,
              createdAt: now,
              updatedAt: now,
            }
          : null,
        mountedWorkspaces: source.mountedWorkspaces,
        toolApprovalMode: source.toolApprovalMode,
        forkedFromAgentId: sourceId,
        forkedFromMessageId: throughMessageId ?? null,
        archivedAt: null,
      },
      history,
    );

    const stored = await this.getStoredAgentInstanceById(newId);
    if (!stored) throw new Error(`Failed to persist forked task ${newId}`);
  }

  /**
   * Deletes an agent instance from the persistence layer.
   *
   * @param id The id of the agent instance to delete
   */
  public async deleteAgentInstance(id: string): Promise<void> {
    this._logger.debug(`[AgentPersistenceDB] Deleting agent instance: ${id}`);
    // Recursively delete all persisted child agents
    const childAgentInstanceIds = await this._db
      .select({ id: schema.agentInstances.id })
      .from(schema.agentInstances)
      .where(eq(schema.agentInstances.parentAgentInstanceId, id));
    for (const childAgentInstanceId of childAgentInstanceIds) {
      await this.deleteAgentInstance(childAgentInstanceId.id);
    }

    // Delete associated messages first
    await this._db
      .delete(schema.agentMessages)
      .where(eq(schema.agentMessages.agentInstanceId, id))
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to delete agent messages: ${error}`,
        );
      });

    await this._db
      .delete(schema.agentInstances)
      .where(eq(schema.agentInstances.id, id))
      .catch((error) => {
        this._logger.error(
          `[AgentPersistenceDB] Failed to delete agent instance: ${error}`,
        );
      });

    // Clean up dirty-tracking state
    this._lastPersistedIds.delete(id);
  }

  /**
   * Returns the earliest `createdAt` among all agent instances, or null if
   * no agents exist. Used to backfill `firstUsedAt` for existing users who
   * already have chat history before the founder-call survey feature was
   * introduced.
   */
  public async getOldestAgentCreatedAt(): Promise<Date | null> {
    // Filter out invalid timestamps (0, negative, or impossibly old).
    // Some legacy/corrupted records have created_at = 0 (Unix epoch),
    // which would poison the firstUsedAt backfill.
    const result = await this._db
      .select({ createdAt: schema.agentInstances.createdAt })
      .from(schema.agentInstances)
      .where(sql`${schema.agentInstances.createdAt} > 0`)
      .orderBy(asc(schema.agentInstances.createdAt))
      .limit(1);
    return result[0]?.createdAt ?? null;
  }

  /**
   * Returns the total number of top-level chat agents (excluding sub-agents).
   * Used by the founder-call survey to determine eligibility.
   */
  public async getAgentCount(): Promise<number> {
    const result = await this._db
      .select({ count: sql<number>`count(*)` })
      .from(schema.agentInstances)
      .where(
        and(
          isNull(schema.agentInstances.parentAgentInstanceId),
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
        ),
      );
    return result[0]?.count ?? 0;
  }

  /**
   * Deletes top-level CHAT agents that are empty (no history, no draft input)
   * AND older than `maxAgeMs`. Used as a one-shot startup cleanup so the
   * sidebar doesn't accumulate date-stamped "New Chat Agent - <date>" stubs
   * that the user closed without ever sending a message.
   *
   * Safety predicates — a row is pruned only when ALL of these hold:
   *   - `type = 'chat'` (does not touch sub-agents, swarm agents, etc.)
   *   - `parent_agent_instance_id IS NULL` (no child row of a parent)
   *   - `title_locked_by_user = 0` (user never renamed — respect intent even
   *     if the body is empty)
   *   - `last_message_at < (now - maxAgeMs)` — quiet for >= maxAgeMs
   *   - the normalised `agentMessages` row count is zero
   *   - decrypted `input_state` is empty
   *   - no user-owned task goal is configured
   *
   * Cascades via the existing `deleteAgentInstance` path so the matching
   * `agentMessages` rows go with it. Returns the number of agents pruned.
   */
  public async pruneStaleEmptyAgents(maxAgeMs: number): Promise<number> {
    if (maxAgeMs <= 0) return 0;

    const cutoff = new Date(Date.now() - maxAgeMs);

    // Keep the indexed/metadata predicates in SQL, then decrypt the draft
    // client-side. Ciphertext is randomized, so encrypted JSON values cannot
    // be compared to well-known empty literals in SQL.
    const candidates = await this._db
      .select({
        id: schema.agentInstances.id,
        inputState: schema.agentInstances.inputState,
        goal: schema.agentInstances.goal,
        messageCount: sql<number>`(SELECT COUNT(*) FROM agentMessages WHERE agent_instance_id = ${schema.agentInstances.id})`,
      })
      .from(schema.agentInstances)
      .where(
        and(
          inArray(schema.agentInstances.type, CHAT_SESSION_AGENT_TYPES),
          isNull(schema.agentInstances.parentAgentInstanceId),
          eq(schema.agentInstances.titleLockedByUser, false),
          lt(schema.agentInstances.lastMessageAt, cutoff),
        ),
      );

    if (candidates.length === 0) return 0;

    let deleted = 0;
    for (const row of candidates) {
      const inputState = this._unprotectJson(
        row.inputState,
        agentInstanceFieldContext(row.id, 'inputState'),
      );
      const goal = this._unprotectJson(
        row.goal,
        agentInstanceFieldContext(row.id, 'goal'),
      );
      if (
        row.messageCount > 0 ||
        !isEmptyInputState(inputState) ||
        goal !== null
      )
        continue;

      try {
        await this.deleteAgentInstance(row.id);
        deleted += 1;
      } catch (error) {
        this._logger.warn(
          `[AgentPersistenceDB] pruneStaleEmptyAgents: failed to delete ${row.id}`,
          { error },
        );
      }
    }
    this._logger.debug(
      `[AgentPersistenceDB] pruneStaleEmptyAgents: pruned ${deleted}/${candidates.length} candidates`,
    );
    return deleted;
  }

  /**
   * One-way startup migration for databases written before data protection
   * was enabled. Existing protected values are authenticated in-place; legacy
   * plaintext values are encrypted in a single transaction.
   */
  private async _migratePlaintextSensitiveFields(): Promise<void> {
    const compactionMarker = await this._db
      .select({ value: schema.meta.value })
      .from(schema.meta)
      .where(eq(schema.meta.key, DATA_PROTECTION_COMPACTION_META_KEY))
      .get();
    const requiresCompaction = compactionMarker?.value !== '1';
    // Ask SQLite to overwrite deleted payloads while any legacy/downgraded
    // plaintext rows are replaced. VACUUM/checkpoint below handles free pages
    // and WAL whenever this run actually encrypts data.
    await this._dbDriver.execute('PRAGMA secure_delete=ON');

    const agentRows = await this._db
      .select({
        id: schema.agentInstances.id,
        title: schema.agentInstances.title,
        instanceConfig: schema.agentInstances.instanceConfig,
        history: schema.agentInstances.history,
        queuedMessages: schema.agentInstances.queuedMessages,
        inputState: schema.agentInstances.inputState,
        goal: schema.agentInstances.goal,
        mountedWorkspaces: schema.agentInstances.mountedWorkspaces,
      })
      .from(schema.agentInstances);
    const messageRows = await this._db
      .select({
        agentInstanceId: schema.agentMessages.agentInstanceId,
        seq: schema.agentMessages.seq,
        parts: schema.agentMessages.parts,
        metadata: schema.agentMessages.metadata,
      })
      .from(schema.agentMessages);

    let migratedFields = 0;
    await this._db.transaction(async (tx) => {
      for (const row of agentRows) {
        const title = this._protectStoredString(
          row.title,
          agentInstanceFieldContext(row.id, 'title'),
        );
        const instanceConfig = this._protectStoredJson(
          row.instanceConfig,
          agentInstanceFieldContext(row.id, 'instanceConfig'),
        );
        const history = this._protectStoredJson(
          row.history,
          agentInstanceFieldContext(row.id, 'history'),
        );
        const queuedMessages = this._protectStoredJson(
          row.queuedMessages,
          agentInstanceFieldContext(row.id, 'queuedMessages'),
        );
        const inputState = this._protectStoredJson(
          row.inputState,
          agentInstanceFieldContext(row.id, 'inputState'),
        );
        const goal = this._protectStoredJson(
          row.goal,
          agentInstanceFieldContext(row.id, 'goal'),
        );
        const mountedWorkspaces = this._protectStoredJson(
          row.mountedWorkspaces,
          agentInstanceFieldContext(row.id, 'mountedWorkspaces'),
        );
        const changes = [
          title,
          instanceConfig,
          history,
          queuedMessages,
          inputState,
          goal,
          mountedWorkspaces,
        ].filter((entry) => entry.changed).length;
        if (changes === 0) continue;

        await tx
          .update(schema.agentInstances)
          .set({
            title: title.value,
            instanceConfig: instanceConfig.value,
            history: history.value,
            queuedMessages: queuedMessages.value,
            inputState: inputState.value,
            goal: goal.value,
            mountedWorkspaces: mountedWorkspaces.value,
          })
          .where(eq(schema.agentInstances.id, row.id));
        migratedFields += changes;
      }

      for (const row of messageRows) {
        const parts = this._protectStoredJson(
          row.parts,
          agentMessageFieldContext(row.agentInstanceId, row.seq, 'parts'),
        );
        const metadata = this._protectStoredJson(
          row.metadata,
          agentMessageFieldContext(row.agentInstanceId, row.seq, 'metadata'),
        );
        const changes = [parts, metadata].filter(
          (entry) => entry.changed,
        ).length;
        if (changes === 0) continue;

        await tx
          .update(schema.agentMessages)
          .set({
            parts: parts.value,
            metadata: metadata.value,
          })
          .where(
            and(
              eq(schema.agentMessages.agentInstanceId, row.agentInstanceId),
              eq(schema.agentMessages.seq, row.seq),
            ),
          );
        migratedFields += changes;
      }
    });

    const shouldCompact = requiresCompaction || migratedFields > 0;
    if (shouldCompact) {
      if (agentRows.length > 0 || messageRows.length > 0) {
        // Application-level column encryption does not by itself erase old
        // plaintext from SQLite free pages or the WAL. Compact once after the
        // one-way migration before recording completion.
        await this._dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
        await this._dbDriver.execute('VACUUM');
      }

      await this._db
        .insert(schema.meta)
        .values({
          key: DATA_PROTECTION_COMPACTION_META_KEY,
          value: '1',
        })
        .onConflictDoUpdate({
          target: schema.meta.key,
          set: { value: '1' },
        });
      await this._dbDriver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    }

    this._logger.debug(
      `[AgentPersistenceDB] Data-protection migration complete (${migratedFields} field(s) encrypted)`,
    );
  }

  /**
   * Returns the same static type expected by Drizzle while substituting a
   * protected envelope at the serialization boundary.
   */
  private _protectJson<T>(value: T, context: string): T {
    if (!this._dataProtection || value === null || value === undefined) {
      return value;
    }
    return this._dataProtection.protectString(
      superjson.stringify(value),
      context,
    ) as unknown as T;
  }

  private _protectString(value: string, context: string): string {
    return this._dataProtection?.protectString(value, context) ?? value;
  }

  private _unprotectString(value: string, context: string): string {
    if (!isDataProtectionEnvelopeString(value)) return value;
    if (!this._dataProtection) {
      throw new Error(
        `Protected agent persistence data requires a host data-protection capability (${context})`,
      );
    }
    return this._dataProtection.unprotectString(value, context);
  }

  private _unprotectJson<T>(value: T, context: string): T {
    if (typeof value !== 'string' || !isDataProtectionEnvelopeString(value)) {
      return value;
    }
    if (!this._dataProtection) {
      throw new Error(
        `Protected agent persistence data requires a host data-protection capability (${context})`,
      );
    }

    return superjson.parse(
      this._dataProtection.unprotectString(value, context),
    ) as T;
  }

  private _protectStoredJson<T>(
    value: T,
    context: string,
  ): { value: T; changed: boolean } {
    if (value === null || value === undefined) {
      return { value, changed: false };
    }
    if (typeof value === 'string' && isDataProtectionEnvelopeString(value)) {
      // Authenticate existing ciphertext before allowing startup to proceed.
      this._unprotectJson(value, context);
      return { value, changed: false };
    }
    return {
      value: this._protectJson(value, context),
      changed: this._dataProtection !== undefined,
    };
  }

  private _protectStoredString(
    value: string,
    context: string,
  ): { value: string; changed: boolean } {
    if (isDataProtectionEnvelopeString(value)) {
      this._unprotectString(value, context);
      return { value, changed: false };
    }
    return {
      value: this._protectString(value, context),
      changed: this._dataProtection !== undefined,
    };
  }

  private _decodeHistoryEntry(entry: {
    id: string;
    type: AgentHistoryEntry['type'];
    title: string;
    createdAt: Date;
    lastMessageAt: Date;
    messageCount: number;
    parentAgentInstanceId: string | null;
    forkedFromAgentId: string | null;
    forkedFromMessageId: string | null;
    archivedAt: Date | null;
    mountedWorkspaces: unknown;
  }): AgentHistoryEntry {
    return {
      ...entry,
      title: this._unprotectString(
        entry.title,
        agentInstanceFieldContext(entry.id, 'title'),
      ),
      mountedWorkspaces: this._unprotectJson(
        entry.mountedWorkspaces,
        agentInstanceFieldContext(entry.id, 'mountedWorkspaces'),
      ) as AgentHistoryWorkspaceEntry[] | null,
    };
  }
}

function agentInstanceFieldContext(id: string, field: string): string {
  return `agentInstances/${encodeURIComponent(id)}/${field}`;
}

function agentMessageFieldContext(
  id: string,
  seq: number,
  field: string,
): string {
  return `agentMessages/${encodeURIComponent(id)}/${seq}/${field}`;
}

function matchesCaseInsensitiveSqlLike(
  value: string,
  pattern: string,
): boolean {
  let expression = '^';
  for (const character of pattern) {
    if (character === '%') {
      expression += '.*';
    } else if (character === '_') {
      expression += '.';
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  expression += '$';
  return new RegExp(expression, 'iu').test(value);
}

function isEmptyInputState(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed === '[]';
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
