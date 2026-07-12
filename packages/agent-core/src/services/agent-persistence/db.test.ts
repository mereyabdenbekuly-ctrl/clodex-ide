import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import * as schema from './schema';
import initSchemaSql from './schema.sql?raw';
import { migrateDatabase } from '../../migrate-database';
import { AgentPersistenceDB } from './db';
import type { Logger } from '../../host/logger';
import { AeadDataProtection } from '../../host/data-protection';
import { AgentTypes } from '../../types/agent';
import type { TaskGoal } from '../../types/agent';

/**
 * Test-DB scaffold: file-based libsql in a temp dir, schema migrated.
 * Matches the pattern used by `services/diff-history/utils/db.test.ts`.
 */
function createTestDb(): {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
  dbPath: string;
} {
  const dbPath = path.join(
    os.tmpdir(),
    `test-agent-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client, { schema });
  return { client, db, dbPath };
}

function cleanupTestDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

/**
 * Silent logger — `pruneStaleEmptyAgents` and `deleteAgentInstance` log
 * on warn/debug paths; we don't care about output during tests.
 */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

interface InsertArgs {
  id: string;
  type?: string;
  parentAgentInstanceId?: string | null;
  forkedFromAgentId?: string | null;
  forkedFromMessageId?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  lastMessageAt?: Date;
  title?: string;
  titleLockedByUser?: boolean;
  history?: string;
  queuedMessages?: string;
  inputState?: string;
  usedTokens?: number;
  goal?: TaskGoal | null;
  mountedWorkspaces?: string | null;
  toolApprovalMode?: string;
  instanceConfig?: string;
  activeModelId?: string;
}

async function insertAgentInstance(
  db: LibSQLDatabase<typeof schema>,
  row: InsertArgs,
): Promise<void> {
  await db.insert(schema.agentInstances).values({
    id: row.id,
    type: row.type ?? AgentTypes.CHAT,
    parentAgentInstanceId: row.parentAgentInstanceId ?? null,
    forkedFromAgentId: row.forkedFromAgentId ?? null,
    forkedFromMessageId: row.forkedFromMessageId ?? null,
    archivedAt: row.archivedAt ?? null,
    instanceConfig: row.instanceConfig ?? '{}',
    createdAt: row.createdAt ?? new Date(),
    lastMessageAt: row.lastMessageAt ?? new Date(),
    activeModelId: row.activeModelId ?? 'test-model',
    title: row.title ?? 'New Chat Agent - Jul 8, 2:30 PM',
    titleLockedByUser: row.titleLockedByUser ?? false,
    history: row.history ?? '[]',
    queuedMessages: row.queuedMessages ?? '[]',
    inputState: row.inputState ?? '[]',
    usedTokens: row.usedTokens ?? 0,
    goal: row.goal ?? null,
    mountedWorkspaces: row.mountedWorkspaces ?? null,
    toolApprovalMode: row.toolApprovalMode ?? 'alwaysAsk',
  });
}

describe('AgentPersistenceDB.pruneStaleEmptyAgents', () => {
  let client: Client;
  let db: LibSQLDatabase<typeof schema>;
  let dbPath: string;
  let persistence: AgentPersistenceDB;

  beforeEach(async () => {
    const setup = createTestDb();
    client = setup.client;
    db = setup.db;
    dbPath = setup.dbPath;

    await migrateDatabase({
      db,
      client,
      registry: [
        {
          version: 11,
          up: async () => {
            // No-op: the schema is initialised via `initSchemaSql` by
            // `migrateDatabase` for fresh DBs. Schema-version 11 is current
            // upstream — tests run against the same schema the app does.
          },
        },
      ],
      initSql: initSchemaSql,
      schemaVersion: 11,
    });

    persistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    client.close();
    cleanupTestDb(dbPath);
  });

  it('removes an empty, quiet, top-level CHAT agent older than the threshold', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'stale-empty-1',
      createdAt: oldDate,
      lastMessageAt: oldDate,
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(1);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('stale-empty-1'));
    expect(rows).toHaveLength(0);
  });

  it('keeps an empty agent whose title the user manually locked', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'user-locked-empty',
      createdAt: oldDate,
      lastMessageAt: oldDate,
      title: 'My named draft',
      titleLockedByUser: true,
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('user-locked-empty'));
    expect(rows).toHaveLength(1);
  });

  it('keeps an empty agent with non-empty inputState (active draft)', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'with-draft',
      createdAt: oldDate,
      lastMessageAt: oldDate,
      inputState:
        '[{"type":"paragraph","content":[{"type":"text","text":"WIP"}}]',
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('with-draft'));
    expect(rows).toHaveLength(1);
  });

  it('keeps an empty agent with a user-owned task goal', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'with-goal',
      createdAt: oldDate,
      lastMessageAt: oldDate,
      goal: {
        objective: 'Prepare the release',
        status: 'active',
        tokenBudget: 20_000,
        startedUsedTokens: 0,
        createdAt: oldDate.getTime(),
        updatedAt: oldDate.getTime(),
      },
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('with-goal'));
    expect(rows).toHaveLength(1);
  });

  it('keeps non-CHAT agents', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'workspace-md-agent',
      type: AgentTypes.WORKSPACE_MD,
      createdAt: oldDate,
      lastMessageAt: oldDate,
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('workspace-md-agent'));
    expect(rows).toHaveLength(1);
  });

  it('keeps agents with a parent_agent_instance_id', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'child-agent',
      parentAgentInstanceId: 'parent-agent',
      createdAt: oldDate,
      lastMessageAt: oldDate,
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('child-agent'));
    expect(rows).toHaveLength(1);
  });

  it('keeps recent empty agents (< N days)', async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'recent-empty',
      createdAt: recent,
      lastMessageAt: recent,
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('recent-empty'));
    expect(rows).toHaveLength(1);
  });

  it('returns 0 when maxAgeMs <= 0 (safety guard)', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'should-not-touch',
      createdAt: oldDate,
      lastMessageAt: oldDate,
    });

    expect(await persistence.pruneStaleEmptyAgents(0)).toBe(0);
    expect(await persistence.pruneStaleEmptyAgents(-1)).toBe(0);

    const rows = await db
      .select()
      .from(schema.agentInstances)
      .where(eqId('should-not-touch'));
    expect(rows).toHaveLength(1);
  });

  it('keeps agents that have normalized message rows', async () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await insertAgentInstance(db, {
      id: 'with-messages',
      createdAt: oldDate,
      lastMessageAt: oldDate,
    });
    // Normalized message rows are the source of truth; the deprecated
    // `history` column may remain empty even for non-empty sessions.
    await db.insert(schema.agentMessages).values({
      agentInstanceId: 'with-messages',
      seq: 0,
      messageId: 'msg-0',
      role: 'user',
      parts: '[]',
      metadata: null,
    });

    const pruned = await persistence.pruneStaleEmptyAgents(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(pruned).toBe(0);

    const msgs = await db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.agentInstanceId, 'with-messages'));
    expect(msgs).toHaveLength(1);
  });
});

describe('AgentPersistenceDB task lifecycle', () => {
  let client: Client;
  let db: LibSQLDatabase<typeof schema>;
  let dbPath: string;
  let persistence: AgentPersistenceDB;

  beforeEach(async () => {
    const setup = createTestDb();
    client = setup.client;
    db = setup.db;
    dbPath = setup.dbPath;

    await migrateDatabase({
      db,
      client,
      registry: [{ version: 11, up: async () => {} }],
      initSql: initSchemaSql,
      schemaVersion: 11,
    });

    persistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    client.close();
    cleanupTestDb(dbPath);
  });

  it('moves top-level tasks between active and archived history lists', async () => {
    await insertAgentInstance(db, { id: 'active-task', title: 'Active task' });
    await insertAgentInstance(db, {
      id: 'archived-task',
      title: 'Archived task',
      archivedAt: new Date('2026-07-11T00:00:00.000Z'),
    });

    await expect(
      persistence.getAgentHistoryEntries(20, 0, []),
    ).resolves.toMatchObject([{ id: 'active-task', archivedAt: null }]);
    await expect(
      persistence.getAgentHistoryEntries(20, 0, [], undefined, true),
    ).resolves.toMatchObject([
      { id: 'archived-task', archivedAt: expect.any(Date) },
    ]);

    expect(await persistence.setAgentArchived('active-task', true)).toBe(true);
    expect(await persistence.setAgentArchived('missing-task', true)).toBe(
      false,
    );

    await expect(
      persistence.getAgentHistoryEntries(20, 0, []),
    ).resolves.toEqual([]);
    const archived = await persistence.getAgentHistoryEntries(
      20,
      0,
      [],
      undefined,
      true,
    );
    expect(archived.map((entry) => entry.id).sort()).toEqual([
      'active-task',
      'archived-task',
    ]);

    expect(await persistence.setAgentArchived('active-task', false)).toBe(true);
    await expect(
      persistence.getAgentHistoryEntries(20, 0, []),
    ).resolves.toMatchObject([{ id: 'active-task', archivedAt: null }]);
  });

  it('forks through a message while preserving source and resetting transient state', async () => {
    const createdAt = new Date('2026-07-10T10:00:00.000Z');
    const sourceHistory = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'first' }],
        metadata: { createdAt },
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'reply' }],
        metadata: { createdAt },
      },
      {
        id: 'user-2',
        role: 'user',
        parts: [{ type: 'text', text: 'second' }],
        metadata: { createdAt },
      },
    ];

    await persistence.storeAgentInstance(
      {
        id: 'source-task',
        parentAgentInstanceId: null,
        type: AgentTypes.CHAT,
        instanceConfig: { source: true },
        createdAt,
        lastMessageAt: createdAt,
        activeModelId: 'test-model',
        title: 'Source task',
        titleLockedByUser: false,
        queuedMessages: [{ id: 'queued' }],
        inputState: 'draft',
        usedTokens: 1234,
        goal: {
          objective: 'Ship lifecycle support',
          status: 'blocked',
          tokenBudget: 50_000,
          timeBudgetSeconds: 7_200,
          startedUsedTokens: 1_000,
          accumulatedActiveMs: 45_000,
          activeStartedAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
        mountedWorkspaces: [{ path: '/workspace', permissions: [] }],
        toolApprovalMode: 'alwaysAsk',
      },
      sourceHistory,
    );

    await persistence.forkAgentInstance(
      'source-task',
      'forked-task',
      'assistant-1',
    );

    const source = await persistence.getStoredAgentInstanceById('source-task');
    const fork = await persistence.getStoredAgentInstanceById('forked-task');

    expect(source).toMatchObject({
      title: 'Source task',
      queuedMessages: [{ id: 'queued' }],
      inputState: 'draft',
      usedTokens: 1234,
      goal: {
        objective: 'Ship lifecycle support',
        status: 'blocked',
        tokenBudget: 50_000,
        timeBudgetSeconds: 7_200,
        startedUsedTokens: 1_000,
        accumulatedActiveMs: 45_000,
        activeStartedAt: null,
      },
      forkedFromAgentId: null,
      forkedFromMessageId: null,
      archivedAt: null,
    });
    expect(source?.history.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
    ]);

    expect(fork).toMatchObject({
      parentAgentInstanceId: null,
      title: 'Source task (fork)',
      titleLockedByUser: true,
      queuedMessages: [],
      inputState: '',
      usedTokens: 0,
      goal: {
        objective: 'Ship lifecycle support',
        status: 'active',
        tokenBudget: 50_000,
        timeBudgetSeconds: 7_200,
        startedUsedTokens: 0,
        accumulatedActiveMs: 0,
        activeStartedAt: expect.any(Number),
      },
      mountedWorkspaces: [{ path: '/workspace', permissions: [] }],
      forkedFromAgentId: 'source-task',
      forkedFromMessageId: 'assistant-1',
      archivedAt: null,
    });
    expect(fork?.history.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
  });

  it('does not overwrite immutable lifecycle metadata during normal state saves', async () => {
    await insertAgentInstance(db, {
      id: 'lifecycle-task',
      forkedFromAgentId: 'parent-task',
      forkedFromMessageId: 'message-1',
      archivedAt: new Date('2026-07-11T00:00:00.000Z'),
    });
    const stored =
      await persistence.getStoredAgentInstanceById('lifecycle-task');
    expect(stored).not.toBeNull();

    await persistence.storeAgentInstance(
      {
        ...stored!,
        title: 'Updated title',
        forkedFromAgentId: null,
        forkedFromMessageId: null,
        archivedAt: null,
      },
      stored!.history,
    );

    const updated =
      await persistence.getStoredAgentInstanceById('lifecycle-task');
    expect(updated).toMatchObject({
      title: 'Updated title',
      forkedFromAgentId: 'parent-task',
      forkedFromMessageId: 'message-1',
      archivedAt: expect.any(Date),
    });
  });
});

describe('AgentPersistenceDB data protection', () => {
  let client: Client;
  let db: LibSQLDatabase<typeof schema>;
  let dbPath: string;

  beforeEach(async () => {
    const setup = createTestDb();
    client = setup.client;
    db = setup.db;
    dbPath = setup.dbPath;

    await migrateDatabase({
      db,
      client,
      registry: [{ version: 11, up: async () => {} }],
      initSql: initSchemaSql,
      schemaVersion: 11,
    });
  });

  afterEach(() => {
    client.close();
    cleanupTestDb(dbPath);
  });

  it('encrypts sensitive agent/message fields and restores their values', async () => {
    const protection = new AeadDataProtection(randomBytes(32));
    const persistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
      dataProtection: protection,
    });
    const createdAt = new Date('2026-07-10T01:00:00.000Z');

    await persistence.storeAgentInstance(
      {
        id: 'protected-agent',
        parentAgentInstanceId: null,
        type: AgentTypes.CHAT,
        instanceConfig: { token: 'instance-secret' },
        createdAt,
        lastMessageAt: createdAt,
        activeModelId: 'test-model',
        title: 'Visible query metadata',
        titleLockedByUser: false,
        queuedMessages: [
          {
            id: 'queued-1',
            role: 'user',
            parts: [{ type: 'text', text: 'queued-secret' }],
          },
        ],
        inputState: 'draft-secret',
        usedTokens: 42,
        goal: {
          objective: 'goal-secret',
          status: 'active',
          tokenBudget: 10_000,
          startedUsedTokens: 0,
          createdAt: createdAt.getTime(),
          updatedAt: createdAt.getTime(),
        },
        mountedWorkspaces: [
          { path: '/private/workspace-secret', permissions: [] },
        ],
        toolApprovalMode: 'alwaysAsk',
      },
      [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'message-secret' }],
          metadata: { createdAt, privateNote: 'metadata-secret' },
        },
      ],
    );

    const rawAgent = await client.execute({
      sql: `SELECT title, instance_config, history, queued_messages, input_state, goal, mounted_workspaces
            FROM agentInstances WHERE id = ?`,
      args: ['protected-agent'],
    });
    const rawMessage = await client.execute({
      sql: `SELECT parts, metadata FROM agentMessages
            WHERE agent_instance_id = ? AND seq = 0`,
      args: ['protected-agent'],
    });
    const raw = JSON.stringify([rawAgent.rows[0], rawMessage.rows[0]]);

    expect(raw).toContain('clodex-protected:v1:');
    for (const secret of [
      'instance-secret',
      'queued-secret',
      'draft-secret',
      'goal-secret',
      'workspace-secret',
      'message-secret',
      'metadata-secret',
      'Visible query metadata',
    ]) {
      expect(raw).not.toContain(secret);
    }

    const restored =
      await persistence.getStoredAgentInstanceById('protected-agent');
    expect(restored).toMatchObject({
      title: 'Visible query metadata',
      instanceConfig: { token: 'instance-secret' },
      inputState: 'draft-secret',
      mountedWorkspaces: [
        { path: '/private/workspace-secret', permissions: [] },
      ],
      goal: {
        objective: 'goal-secret',
        status: 'active',
        tokenBudget: 10_000,
      },
    });
    expect(restored?.queuedMessages).toEqual([
      {
        id: 'queued-1',
        role: 'user',
        parts: [{ type: 'text', text: 'queued-secret' }],
      },
    ]);
    expect(restored?.history[0]).toMatchObject({
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'message-secret' }],
      metadata: { privateNote: 'metadata-secret' },
    });

    const wrongKeyPersistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    const migrateWithWrongKey = (
      wrongKeyPersistence as unknown as {
        _migratePlaintextSensitiveFields(): Promise<void>;
      }
    )._migratePlaintextSensitiveFields.bind(wrongKeyPersistence);
    await expect(migrateWithWrongKey()).rejects.toThrow('key does not match');

    const rawAfterWrongKey = JSON.stringify([
      (
        await client.execute({
          sql: `SELECT title, instance_config, history, queued_messages, input_state, goal, mounted_workspaces
                FROM agentInstances WHERE id = ?`,
          args: ['protected-agent'],
        })
      ).rows[0],
      (
        await client.execute({
          sql: `SELECT parts, metadata FROM agentMessages
                WHERE agent_instance_id = ? AND seq = 0`,
          args: ['protected-agent'],
        })
      ).rows[0],
    ]);
    expect(rawAfterWrongKey).toBe(raw);
  });

  it('migrates legacy plaintext once and leaves authenticated ciphertext stable', async () => {
    const createdAt = new Date('2026-07-10T01:00:00.000Z');
    await db.insert(schema.agentInstances).values({
      id: 'legacy-agent',
      parentAgentInstanceId: null,
      type: AgentTypes.CHAT,
      instanceConfig: { token: 'legacy-instance-secret' },
      createdAt,
      lastMessageAt: createdAt,
      activeModelId: 'test-model',
      title: 'Legacy',
      titleLockedByUser: false,
      history: [],
      queuedMessages: [
        {
          id: 'queued-legacy',
          role: 'user',
          parts: [{ type: 'text', text: 'legacy-queue-secret' }],
        },
      ],
      inputState: 'legacy-draft-secret',
      usedTokens: 0,
      mountedWorkspaces: [
        { path: '/legacy/workspace-secret', permissions: [] },
      ],
      toolApprovalMode: 'alwaysAsk',
    });
    await db.insert(schema.agentMessages).values({
      agentInstanceId: 'legacy-agent',
      seq: 0,
      messageId: 'legacy-message',
      role: 'assistant',
      parts: [{ type: 'text', text: 'legacy-message-secret' }],
      metadata: { privateNote: 'legacy-metadata-secret' },
    });

    const persistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    const migrate = (
      persistence as unknown as {
        _migratePlaintextSensitiveFields(): Promise<void>;
      }
    )._migratePlaintextSensitiveFields.bind(persistence);

    await migrate();
    const firstCiphertext = JSON.stringify(
      (
        await client.execute(
          `SELECT title, instance_config, history, queued_messages, input_state, mounted_workspaces
           FROM agentInstances WHERE id = 'legacy-agent'`,
        )
      ).rows[0],
    );
    expect(firstCiphertext).toContain('clodex-protected:v1:');
    expect(firstCiphertext).not.toContain('Legacy');
    expect(firstCiphertext).not.toContain('legacy-draft-secret');
    expect(firstCiphertext).not.toContain('workspace-secret');
    for (const suffix of ['', '-wal']) {
      const sqlitePath = `${dbPath}${suffix}`;
      if (!fs.existsSync(sqlitePath)) continue;
      const bytes = fs.readFileSync(sqlitePath).toString('latin1');
      expect(bytes).not.toContain('legacy-draft-secret');
      expect(bytes).not.toContain('legacy-message-secret');
    }
    const compactionMarker = await db
      .select({ value: schema.meta.value })
      .from(schema.meta)
      .where(eq(schema.meta.key, 'data-protection-v1-compaction-complete'));
    expect(compactionMarker).toEqual([{ value: '1' }]);

    await migrate();
    const secondCiphertext = JSON.stringify(
      (
        await client.execute(
          `SELECT title, instance_config, history, queued_messages, input_state, mounted_workspaces
           FROM agentInstances WHERE id = 'legacy-agent'`,
        )
      ).rows[0],
    );
    expect(secondCiphertext).toBe(firstCiphertext);

    const restored =
      await persistence.getStoredAgentInstanceById('legacy-agent');
    expect(restored?.title).toBe('Legacy');
    expect(restored?.inputState).toBe('legacy-draft-secret');
    expect(restored?.history[0]).toMatchObject({
      parts: [{ type: 'text', text: 'legacy-message-secret' }],
      metadata: { privateNote: 'legacy-metadata-secret' },
    });
  });

  it('prunes encrypted empty drafts without comparing ciphertext in SQL', async () => {
    const persistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    await persistence.storeAgentInstance(
      {
        id: 'encrypted-empty',
        type: AgentTypes.CHAT,
        createdAt: oldDate,
        lastMessageAt: oldDate,
        activeModelId: 'test-model',
        title: 'New Chat Agent',
        titleLockedByUser: false,
        queuedMessages: [],
        inputState: '',
        usedTokens: 0,
        mountedWorkspaces: [],
        toolApprovalMode: 'alwaysAsk',
      },
      [],
    );

    await expect(
      persistence.pruneStaleEmptyAgents(7 * 24 * 60 * 60 * 1000),
    ).resolves.toBe(1);
  });

  it('decrypts and filters protected titles in memory before pagination', async () => {
    const persistence = new AgentPersistenceDB({
      host: { agentDbPath: () => dbPath } as never,
      logger: silentLogger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    const baseDate = new Date('2026-07-10T12:00:00.000Z');
    for (const [index, title] of [
      'Secret Alpha',
      'Public Project',
      'Another SECRET Session',
    ].entries()) {
      const createdAt = new Date(baseDate.getTime() - index * 1000);
      await persistence.storeAgentInstance(
        {
          id: `title-agent-${index}`,
          type: AgentTypes.CHAT,
          createdAt,
          lastMessageAt: createdAt,
          activeModelId: 'test-model',
          title,
          titleLockedByUser: false,
          queuedMessages: [],
          inputState: '',
          usedTokens: 0,
          mountedWorkspaces: [],
          toolApprovalMode: 'alwaysAsk',
        },
        [],
      );
    }

    const firstPage = await persistence.getAgentHistoryEntries(
      1,
      0,
      [],
      '%secret%',
    );
    const secondPage = await persistence.getAgentHistoryEntries(
      1,
      1,
      [],
      '%secret%',
    );
    expect(firstPage.map((entry) => entry.title)).toEqual(['Secret Alpha']);
    expect(secondPage.map((entry) => entry.title)).toEqual([
      'Another SECRET Session',
    ]);

    await expect(
      persistence.updateAgentTitle('title-agent-1', 'Renamed Secret'),
    ).resolves.toBe(true);
    expect(
      (
        await persistence.getAgentHistoryEntries(10, 0, [], '%renamed secret%')
      ).map((entry) => entry.title),
    ).toEqual(['Renamed Secret']);

    const rawTitles = await client.execute(
      'SELECT title FROM agentInstances ORDER BY id',
    );
    const raw = JSON.stringify(rawTitles.rows);
    expect(raw).toContain('clodex-protected:v1:');
    expect(raw).not.toContain('Secret Alpha');
    expect(raw).not.toContain('Renamed Secret');
  });
});

// Local helper: the eq import below is intentionally narrow so this test
// file does not need any other drizzle surface.
import { eq } from 'drizzle-orm';

function eqId(id: string) {
  return eq(schema.agentInstances.id, id);
}
