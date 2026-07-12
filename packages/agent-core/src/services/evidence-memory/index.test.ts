import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AeadDataProtection } from '../../host/data-protection';
import type { Logger } from '../../host/logger';
import {
  EvidenceMemoryDivergenceError,
  EvidenceMemoryFencedWriteError,
  EvidenceMemoryService,
  hashEvidenceMemoryFencingToken,
} from './index';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const services: EvidenceMemoryService[] = [];

async function createService(
  dataProtection?: AeadDataProtection,
): Promise<EvidenceMemoryService> {
  const service = await EvidenceMemoryService.createWithUrl(
    await freshDbUrl(),
    {
      logger,
      dataProtection,
      now: () => 1_700_000_000_000,
    },
  );
  services.push(service);
  return service;
}

async function createAutomationService(): Promise<EvidenceMemoryService> {
  const service = await EvidenceMemoryService.createWithUrl(
    await freshDbUrl(),
    {
      logger,
      now: () => 1_700_000_000_000,
      enableContradictionAutomation: true,
    },
  );
  services.push(service);
  return service;
}

async function freshDbUrl(): Promise<string> {
  const directory = path.join(os.tmpdir(), 'evidence-memory-tests');
  await fs.mkdir(directory, { recursive: true });
  return `file:${path.join(directory, `${randomUUID()}.sqlite`)}`;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.teardown()));
});

describe('EvidenceMemoryService', () => {
  it('records and lists task-scoped append-only events', async () => {
    const service = await createService();
    await service.record({
      id: 'event-1',
      taskId: 'task-a',
      workspaceId: '/workspace/a',
      type: 'user_message',
      timestamp: 10,
      messageId: 'message-1',
      repositoryRevision: 'abc123',
      payload: { text: 'Keep the public API stable.' },
    });
    await service.record({
      id: 'event-2',
      taskId: 'task-a',
      workspaceId: '/workspace/a',
      type: 'test_completed',
      timestamp: 20,
      payload: { command: 'pnpm test', exitCode: 0 },
    });
    await service.record({
      id: 'event-3',
      taskId: 'task-b',
      type: 'user_message',
      timestamp: 30,
      payload: { text: 'Unrelated task.' },
    });

    expect(await service.list({ taskId: 'task-a' })).toEqual([
      expect.objectContaining({
        id: 'event-2',
        type: 'test_completed',
        payload: { command: 'pnpm test', exitCode: 0 },
      }),
      expect.objectContaining({
        id: 'event-1',
        taskId: 'task-a',
        workspaceId: '/workspace/a',
        repositoryRevision: 'abc123',
      }),
    ]);
    expect(
      await service.list({
        taskId: 'task-a',
        types: ['user_message'],
      }),
    ).toHaveLength(1);
    expect(await service.getStats('task-a')).toEqual({
      total: 2,
      byType: {
        test_completed: 1,
        user_message: 1,
      },
    });
  });

  it('extracts deterministic claims and builds shadow context without an LLM', async () => {
    const service = await EvidenceMemoryService.createWithUrl(
      await freshDbUrl(),
      {
        logger,
        now: () => 1_700_000_000_000,
        enableDeterministicClaimExtraction: true,
      },
    );
    services.push(service);

    await service.record({
      id: 'constraint-event',
      taskId: 'task-a',
      type: 'user_message',
      messageId: 'message-1',
      payload: {
        text: 'Keep packages/agent-core/src/host/models.ts stable and never remove --safe-mode.',
      },
    });
    await service.record({
      id: 'verification-event',
      taskId: 'task-a',
      type: 'test_completed',
      payload: { command: 'pnpm test', exitCode: 0 },
    });
    await service.record({
      id: 'goal-event',
      taskId: 'task-a',
      type: 'goal_created',
      payload: {
        objective: 'Connect deterministic Evidence Memory ingestion.',
      },
    });

    const claims = await service.listClaims({ taskId: 'task-a' });
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_constraint',
          confidence: 0.9,
          evidenceEventIds: ['constraint-event'],
        }),
        expect.objectContaining({
          kind: 'successful_approach',
          text: expect.stringContaining('pnpm test'),
          evidenceEventIds: ['verification-event'],
        }),
        expect.objectContaining({
          kind: 'next_action',
          text: expect.stringContaining('deterministic Evidence Memory'),
          evidenceEventIds: ['goal-event'],
        }),
      ]),
    );
    expect(
      claims.find((claim) => claim.kind === 'user_constraint')?.entities,
    ).toEqual(
      expect.arrayContaining([
        {
          type: 'file',
          value: 'packages/agent-core/src/host/models.ts',
        },
        { type: 'setting', value: '--safe-mode' },
      ]),
    );

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'Which safe mode constraint must remain stable?',
      tokenBudget: 1_000,
    });
    expect(pack.shadow).toBe(true);
    expect(pack.items[0]?.claim.kind).toBe('user_constraint');
  });

  it('is idempotent when an event id is recorded again', async () => {
    const service = await createService();
    const original = await service.record({
      id: 'stable-event',
      taskId: 'task-a',
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Use SQLite first.' },
    });
    const repeated = await service.record({
      id: 'stable-event',
      taskId: 'task-a',
      type: 'decision_recorded',
      timestamp: 20,
      payload: { decision: 'This must not overwrite the event.' },
    });

    expect(repeated).toEqual(original);
    expect((await service.getStats('task-a')).total).toBe(1);
  });

  it('derives stable event ids and payload hashes from ingestion keys', async () => {
    const service = await createService();
    const original = await service.record({
      taskId: 'task-a',
      type: 'tool_completed',
      source: 'tool_call',
      sourceId: 'call-42',
      ingestionKey: 'tool:call-42:completed',
      payload: { toolName: 'read', ok: true },
    });
    const repeated = await service.record({
      taskId: 'task-a',
      type: 'tool_completed',
      source: 'tool_call',
      sourceId: 'call-42',
      ingestionKey: 'tool:call-42:completed',
      payload: { ok: true, toolName: 'read' },
    });

    expect(repeated).toEqual(original);
    expect(original.id).toMatch(/^event:[a-f0-9]{64}$/);
    expect(original.source).toBe('tool_call');
    expect(original.sourceIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(original.ingestionKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(original.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates deterministic checkpoints and reconciles ledger events idempotently', async () => {
    const local = await createService();
    const cloud = await createService();
    await local.record({
      id: 'event-1',
      taskId: 'teleport-task',
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Preserve the full dirty workspace.' },
    });
    await local.record({
      id: 'event-2',
      taskId: 'teleport-task',
      type: 'test_completed',
      timestamp: 20,
      payload: { command: 'pnpm test', exitCode: 0 },
    });

    const localCheckpoint = await local.createCheckpoint('teleport-task');
    const batch = await local.exportSyncBatch({ taskId: 'teleport-task' });
    expect(batch.targetCheckpoint).toEqual(localCheckpoint);
    expect(batch.events.map(({ event }) => event.id)).toEqual([
      'event-1',
      'event-2',
    ]);

    const first = await cloud.reconcileSyncBatch({
      taskId: 'teleport-task',
      events: batch.events,
      expectedCheckpoint: batch.targetCheckpoint,
    });
    expect(first).toEqual(
      expect.objectContaining({
        importedEvents: 2,
        duplicateEvents: 0,
        checkpoint: localCheckpoint,
      }),
    );
    const replay = await cloud.reconcileSyncBatch({
      taskId: 'teleport-task',
      events: batch.events,
      expectedCheckpoint: batch.targetCheckpoint,
    });
    expect(replay.importedEvents).toBe(0);
    expect(replay.duplicateEvents).toBe(2);
  });

  it('fails closed when the same synchronized event id has different content', async () => {
    const local = await createService();
    const cloud = await createService();
    await local.record({
      id: 'event-conflict',
      taskId: 'teleport-task',
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Use local state.' },
    });
    await cloud.record({
      id: 'event-conflict',
      taskId: 'teleport-task',
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Use cloud state.' },
    });
    const batch = await local.exportSyncBatch({ taskId: 'teleport-task' });

    await expect(
      cloud.reconcileSyncBatch({
        taskId: 'teleport-task',
        events: batch.events,
      }),
    ).rejects.toBeInstanceOf(EvidenceMemoryDivergenceError);
  });

  it('fences stale local writers after cloud ownership is activated', async () => {
    const service = await createService();
    const cloudFence = {
      owner: 'cloud' as const,
      epoch: 2,
      fencingTokenHash: hashEvidenceMemoryFencingToken('lease-token-2'),
    };
    service.activateWriteAuthority('teleport-task', cloudFence);

    await expect(
      service.record({
        taskId: 'teleport-task',
        type: 'decision_recorded',
        payload: { decision: 'Stale local write.' },
      }),
    ).rejects.toMatchObject<EvidenceMemoryFencedWriteError>({
      reason: 'ownership-conflict',
    });
    await expect(
      service.record({
        taskId: 'teleport-task',
        type: 'decision_recorded',
        payload: { decision: 'Older cloud writer.' },
        writeFence: { ...cloudFence, epoch: 1 },
      }),
    ).rejects.toMatchObject<EvidenceMemoryFencedWriteError>({
      reason: 'stale-epoch',
    });
    await service.record({
      id: 'cloud-event',
      taskId: 'teleport-task',
      type: 'decision_recorded',
      payload: { decision: 'Current cloud write.' },
      writeFence: cloudFence,
    });

    const localFence = { owner: 'local' as const, epoch: 3 };
    service.activateWriteAuthority('teleport-task', localFence);
    await service.record({
      id: 'local-event',
      taskId: 'teleport-task',
      type: 'decision_recorded',
      payload: { decision: 'Resumed locally.' },
      writeFence: localFence,
    });
    expect((await service.getStats('teleport-task')).total).toBe(2);
    expect(() =>
      service.activateWriteAuthority('teleport-task', cloudFence),
    ).toThrow(EvidenceMemoryFencedWriteError);
  });

  it('protects identifiers and payloads while leaving only hashes queryable', async () => {
    const url = await freshDbUrl();
    const service = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    services.push(service);

    await service.record({
      id: 'protected-event',
      taskId: 'private-task',
      workspaceId: '/secret/workspace',
      type: 'tool_failed',
      messageId: 'private-message',
      repositoryRevision: 'secret-revision',
      payload: { error: 'Private failure details' },
    });

    const client = createClient({ url });
    const result = await client.execute(
      'SELECT task_id, task_id_hash, workspace_id, workspace_id_hash, message_id, repository_revision, payload FROM evidence_memory_events',
    );
    client.close();
    const row = result.rows[0]!;
    const serialized = JSON.stringify(row);

    expect(String(row.task_id)).toMatch(/^clodex-protected:/);
    expect(String(row.workspace_id)).toMatch(/^clodex-protected:/);
    expect(String(row.message_id)).toMatch(/^clodex-protected:/);
    expect(String(row.repository_revision)).toMatch(/^clodex-protected:/);
    expect(String(row.payload)).toMatch(/^clodex-protected:/);
    expect(String(row.task_id_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(row.workspace_id_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain('private-task');
    expect(serialized).not.toContain('/secret/workspace');
    expect(serialized).not.toContain('Private failure details');
  });

  it('migrates plaintext rows when data protection becomes available', async () => {
    const url = await freshDbUrl();
    const plaintext = await EvidenceMemoryService.createWithUrl(url, {
      logger,
    });
    await plaintext.record({
      id: 'legacy-event',
      taskId: 'legacy-task',
      type: 'user_message',
      payload: { text: 'Legacy plaintext' },
    });
    await plaintext.teardown();

    const protectedService = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    services.push(protectedService);

    expect(await protectedService.list({ taskId: 'legacy-task' })).toEqual([
      expect.objectContaining({
        id: 'legacy-event',
        payload: { text: 'Legacy plaintext' },
      }),
    ]);

    const client = createClient({ url });
    const result = await client.execute(
      'SELECT task_id, payload FROM evidence_memory_events WHERE id = ?',
      ['legacy-event'],
    );
    client.close();
    expect(String(result.rows[0]!.task_id)).toMatch(/^clodex-protected:/);
    expect(String(result.rows[0]!.payload)).toMatch(/^clodex-protected:/);
  });

  it('fails closed when protected events are opened without the key', async () => {
    const url = await freshDbUrl();
    const protectedService = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    await protectedService.record({
      id: 'protected-event',
      taskId: 'task-a',
      type: 'user_message',
    });
    await protectedService.teardown();

    const unprotectedService = await EvidenceMemoryService.createWithUrl(url, {
      logger,
    });
    services.push(unprotectedService);
    await expect(unprotectedService.list({ taskId: 'task-a' })).rejects.toThrow(
      'requires host data protection',
    );
  });

  it('validates types, timestamps, and bounded payloads', async () => {
    const service = await createService();
    await expect(
      service.record({
        taskId: 'task-a',
        type: 'unknown' as 'user_message',
      }),
    ).rejects.toThrow('Unsupported evidence memory event type');
    await expect(
      service.record({
        taskId: 'task-a',
        type: 'user_message',
        timestamp: -1,
      }),
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      service.record({
        taskId: 'task-a',
        type: 'user_message',
        payload: 'x'.repeat(1024 * 1024 + 1),
      }),
    ).rejects.toThrow('at most 1048576 bytes');
  });

  it('records claims with same-task evidence and protected entities', async () => {
    const service = await createService();
    await service.record({
      id: 'decision-event',
      taskId: 'task-a',
      workspaceId: '/workspace/a',
      type: 'decision_recorded',
      payload: { decision: 'Keep approval decisions local.' },
    });

    const claim = await service.recordClaim({
      id: 'claim-a',
      taskId: 'task-a',
      workspaceId: '/workspace/a',
      kind: 'technical_decision',
      subject: 'runner.approval-authority',
      text: 'The local Guardian is the approval authority.',
      confidence: 0.95,
      evidenceEventIds: ['decision-event'],
      entities: [
        { type: 'symbol', value: 'WorkspaceExecutionProvider' },
        { type: 'setting', value: 'approvalMode' },
      ],
      validAtRevision: 'abc123',
    });

    expect(claim).toEqual(
      expect.objectContaining({
        id: 'claim-a',
        status: 'active',
        confidence: 0.95,
        evidenceEventIds: ['decision-event'],
        entities: [
          { type: 'setting', value: 'approvalMode' },
          { type: 'symbol', value: 'WorkspaceExecutionProvider' },
        ],
      }),
    );
    expect(
      await service.listClaims({
        taskId: 'task-a',
        subject: 'runner.approval-authority',
      }),
    ).toEqual([claim]);
  });

  it('rejects unsupported high-confidence and cross-task claims', async () => {
    const service = await createService();
    await expect(
      service.recordClaim({
        taskId: 'task-a',
        kind: 'observed_fact',
        subject: 'tests.status',
        text: 'Tests passed.',
        confidence: 0.9,
      }),
    ).rejects.toThrow('require at least one evidence event');

    await service.record({
      id: 'task-b-event',
      taskId: 'task-b',
      type: 'test_completed',
    });
    await expect(
      service.recordClaim({
        taskId: 'task-a',
        kind: 'observed_fact',
        subject: 'tests.status',
        text: 'Tests passed.',
        confidence: 0.9,
        evidenceEventIds: ['task-b-event'],
      }),
    ).rejects.toThrow('must belong to the same task');
  });

  it('links claim versions and prevents cross-task relations', async () => {
    const service = await createService();
    await service.record({
      id: 'event-a',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await service.record({
      id: 'event-b',
      taskId: 'task-b',
      type: 'decision_recorded',
    });
    await service.recordClaim({
      id: 'claim-v1',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the local runner.',
      evidenceEventIds: ['event-a'],
    });
    await service.recordClaim({
      id: 'claim-v2',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the SSH runner for heavy commands.',
      evidenceEventIds: ['event-a'],
    });
    await service.recordClaim({
      id: 'other-task-claim',
      taskId: 'task-b',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the cloud runner.',
      evidenceEventIds: ['event-b'],
    });

    await service.relateClaims({
      fromClaimId: 'claim-v2',
      toClaimId: 'claim-v1',
      type: 'supersedes',
    });
    const oldClaim = await service.updateClaimStatus(
      'claim-v1',
      'superseded',
      'claim-v2',
    );
    expect(oldClaim).toEqual(
      expect.objectContaining({
        status: 'superseded',
        invalidatedBy: 'claim-v2',
      }),
    );

    await expect(
      service.relateClaims({
        fromClaimId: 'claim-v2',
        toClaimId: 'other-task-claim',
        type: 'contradicts',
      }),
    ).rejects.toThrow('must belong to one task');
  });

  it('protects claim text, provenance scope, revisions, and entity values', async () => {
    const url = await freshDbUrl();
    const service = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    services.push(service);
    await service.record({
      id: 'private-evidence',
      taskId: 'private-task',
      workspaceId: '/private/workspace',
      type: 'decision_recorded',
    });
    await service.recordClaim({
      id: 'private-claim',
      taskId: 'private-task',
      workspaceId: '/private/workspace',
      kind: 'technical_decision',
      subject: 'secret.subject',
      text: 'Never persist this decision in plaintext.',
      evidenceEventIds: ['private-evidence'],
      entities: [{ type: 'symbol', value: 'SecretApprovalAuthority' }],
      validAtRevision: 'private-revision',
    });

    const client = createClient({ url });
    const [claims, entities] = await Promise.all([
      client.execute(
        'SELECT task_id, workspace_id, subject, text, valid_at_revision FROM evidence_memory_claims',
      ),
      client.execute(
        'SELECT value FROM evidence_memory_claim_entities WHERE claim_id = ?',
        ['private-claim'],
      ),
    ]);
    client.close();
    const serialized = JSON.stringify({
      claim: claims.rows[0],
      entity: entities.rows[0],
    });

    expect(String(claims.rows[0]!.task_id)).toMatch(/^clodex-protected:/);
    expect(String(claims.rows[0]!.workspace_id)).toMatch(/^clodex-protected:/);
    expect(String(claims.rows[0]!.subject)).toMatch(/^clodex-protected:/);
    expect(String(claims.rows[0]!.text)).toMatch(/^clodex-protected:/);
    expect(String(claims.rows[0]!.valid_at_revision)).toMatch(
      /^clodex-protected:/,
    );
    expect(String(entities.rows[0]!.value)).toMatch(/^clodex-protected:/);
    expect(serialized).not.toContain('private-task');
    expect(serialized).not.toContain('/private/workspace');
    expect(serialized).not.toContain('secret.subject');
    expect(serialized).not.toContain('Never persist');
    expect(serialized).not.toContain('SecretApprovalAuthority');
    expect(serialized).not.toContain('private-revision');
  });

  it('migrates plaintext claims and entities when protection becomes available', async () => {
    const url = await freshDbUrl();
    const plaintext = await EvidenceMemoryService.createWithUrl(url, {
      logger,
    });
    await plaintext.record({
      id: 'legacy-evidence',
      taskId: 'legacy-task',
      type: 'decision_recorded',
    });
    await plaintext.recordClaim({
      id: 'legacy-claim',
      taskId: 'legacy-task',
      workspaceId: '/legacy/workspace',
      kind: 'technical_decision',
      subject: 'legacy.subject',
      text: 'Legacy claim text.',
      evidenceEventIds: ['legacy-evidence'],
      entities: [{ type: 'setting', value: 'legacySetting' }],
      validAtRevision: 'legacy-revision',
    });
    await plaintext.teardown();

    const protectedService = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    services.push(protectedService);
    expect(await protectedService.getClaim('legacy-claim')).toEqual(
      expect.objectContaining({
        taskId: 'legacy-task',
        workspaceId: '/legacy/workspace',
        subject: 'legacy.subject',
        text: 'Legacy claim text.',
        entities: [{ type: 'setting', value: 'legacySetting' }],
        validAtRevision: 'legacy-revision',
      }),
    );

    const client = createClient({ url });
    const [claims, entities] = await Promise.all([
      client.execute(
        'SELECT task_id, workspace_id, subject, text, valid_at_revision FROM evidence_memory_claims WHERE id = ?',
        ['legacy-claim'],
      ),
      client.execute(
        'SELECT value FROM evidence_memory_claim_entities WHERE claim_id = ?',
        ['legacy-claim'],
      ),
    ]);
    client.close();
    for (const value of Object.values(claims.rows[0]!)) {
      expect(String(value)).toMatch(/^clodex-protected:/);
    }
    expect(String(entities.rows[0]!.value)).toMatch(/^clodex-protected:/);
  });

  it('migrates a version-1 event database to the claims schema', async () => {
    const url = await freshDbUrl();
    const client = createClient({ url });
    await client.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('version', '1');
      CREATE TABLE evidence_memory_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_id_hash TEXT NOT NULL,
        workspace_id TEXT,
        workspace_id_hash TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        message_id TEXT,
        repository_revision TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    client.close();

    const service = await EvidenceMemoryService.createWithUrl(url, { logger });
    services.push(service);
    const migrated = createClient({ url });
    const [
      version,
      tables,
      indexes,
      fingerprintTables,
      eventColumns,
      relationColumns,
      fts,
    ] = await Promise.all([
      migrated.execute("SELECT value FROM meta WHERE key = 'version'"),
      migrated.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'evidence_memory_claim%' AND name NOT LIKE '%fts%'",
      ),
      migrated.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_evidence_memory_claims_subject'",
      ),
      migrated.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evidence_memory_code_fingerprints'",
      ),
      migrated.execute('PRAGMA table_info(evidence_memory_events)'),
      migrated.execute('PRAGMA table_info(evidence_memory_claim_relations)'),
      migrated.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evidence_memory_claim_fts'",
      ),
    ]);
    migrated.close();

    expect(version.rows[0]!.value).toBe('5');
    expect(tables.rows.map((row) => row.name).sort()).toEqual([
      'evidence_memory_claim_entities',
      'evidence_memory_claim_evidence',
      'evidence_memory_claim_relations',
      'evidence_memory_claims',
    ]);
    expect(indexes.rows).toHaveLength(1);
    expect(fingerprintTables.rows).toHaveLength(1);
    expect(eventColumns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'source',
        'source_id_hash',
        'ingestion_key_hash',
        'payload_hash',
        'content_hash',
      ]),
    );
    expect(relationColumns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['origin', 'reason']),
    );
    expect(fts.rows).toHaveLength(1);
  });

  it('keeps claim ids idempotent without attaching later provenance', async () => {
    const service = await createService();
    await service.record({
      id: 'first-evidence',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await service.record({
      id: 'later-evidence',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    const original = await service.recordClaim({
      id: 'stable-claim',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.backend',
      text: 'Use SQLite.',
      evidenceEventIds: ['first-evidence'],
      entities: [{ type: 'dependency', value: 'libsql' }],
    });
    const repeated = await service.recordClaim({
      id: 'stable-claim',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.backend',
      text: 'Overwrite with a vector database.',
      evidenceEventIds: ['later-evidence'],
      entities: [{ type: 'dependency', value: 'lancedb' }],
    });

    expect(repeated).toEqual(original);
    expect(repeated.text).toBe('Use SQLite.');
    expect(repeated.evidenceEventIds).toEqual(['first-evidence']);
    expect(repeated.entities).toEqual([
      { type: 'dependency', value: 'libsql' },
    ]);
  });

  it('validates claim enums, confidence, and bounded collections', async () => {
    const service = await createService();
    await expect(
      service.recordClaim({
        taskId: 'task-a',
        kind: 'unknown' as 'observed_fact',
        subject: 'tests.status',
        text: 'Unknown.',
      }),
    ).rejects.toThrow('Unsupported evidence memory claim kind');
    await expect(
      service.recordClaim({
        taskId: 'task-a',
        kind: 'observed_fact',
        subject: 'tests.status',
        text: 'Invalid confidence.',
        confidence: 1.1,
      }),
    ).rejects.toThrow('Claim confidence must be between 0 and 1');
    await expect(
      service.recordClaim({
        taskId: 'task-a',
        kind: 'observed_fact',
        subject: 'tests.status',
        text: 'Too many entities.',
        entities: Array.from({ length: 129 }, (_, index) => ({
          type: 'test' as const,
          value: `test-${index}`,
        })),
      }),
    ).rejects.toThrow('at most 128');
  });

  it('retrieves task-scoped active claims with in-memory FTS5', async () => {
    const service = await createService();
    await service.recordClaim({
      id: 'exact-claim',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'build.experimental-vm-modules',
      text: 'The build requires --experimental-vm-modules.',
      confidence: 0.4,
      entities: [{ type: 'command', value: 'node --experimental-vm-modules' }],
    });
    await service.recordClaim({
      id: 'semantic-neighbor',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'build.runtime',
      text: 'The JavaScript build runs on Node.js.',
      confidence: 0.4,
    });
    await service.recordClaim({
      id: 'other-task',
      taskId: 'task-b',
      kind: 'observed_fact',
      subject: 'build.experimental-vm-modules',
      text: 'The same exact flag exists in another task.',
      confidence: 0.4,
    });

    const hits = await service.searchClaims({
      taskId: 'task-a',
      query: '--experimental-vm-modules',
    });
    expect(hits.map((hit) => hit.claim.id)).toEqual(['exact-claim']);
    expect(hits[0]!.revisionStatus).toBe('unbound');

    await service.updateClaimStatus('exact-claim', 'invalidated');
    expect(
      await service.searchClaims({
        taskId: 'task-a',
        query: '--experimental-vm-modules',
      }),
    ).toEqual([]);
  });

  it('persists and deterministically rebuilds FTS5/BM25 retrieval', async () => {
    const url = await freshDbUrl();
    const first = await EvidenceMemoryService.createWithUrl(url, { logger });
    await first.recordClaim({
      id: 'uuid-exact',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'failure.02b6c4c8-e962-4923-afa9-676f2062bca1',
      text: 'Failure id 02b6c4c8-e962-4923-afa9-676f2062bca1 uses --safe-mode.',
      confidence: 0.4,
    });
    await first.recordClaim({
      id: 'generic-failure',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'failure.generic',
      text: 'A generic failure happened in safe mode.',
      confidence: 0.4,
    });
    await first.teardown();

    const reopened = await EvidenceMemoryService.createWithUrl(url, { logger });
    services.push(reopened);
    expect(
      (
        await reopened.searchClaims({
          taskId: 'task-a',
          query:
            '02b6c4c8-e962-4923-afa9-676f2062bca1 --safe-mode OR "unterminated',
        })
      ).map((hit) => hit.claim.id),
    ).toEqual(['uuid-exact', 'generic-failure']);

    const client = createClient({ url });
    const rows = await client.execute(
      'SELECT claim_id FROM evidence_memory_claim_fts ORDER BY claim_id',
    );
    client.close();
    expect(rows.rows.map((row) => row.claim_id)).toEqual([
      'generic-failure',
      'uuid-exact',
    ]);
  });

  it('adds local semantic candidates and hybrid ranking without disk vectors', async () => {
    const url = await freshDbUrl();
    const service = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      localEmbeddingProvider: {
        kind: 'local',
        async embed(text) {
          return /cloud|ssh/i.test(text) ? [0, 1] : [1, 0];
        },
      },
    });
    services.push(service);
    await service.recordClaim({
      id: 'local-runner',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.local',
      text: 'Use the workstation process.',
      confidence: 0.4,
    });
    await service.recordClaim({
      id: 'remote-runner',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.remote',
      text: 'Use the SSH runner for large builds.',
      confidence: 0.4,
    });

    const hits = await service.searchClaims({
      taskId: 'task-a',
      query: 'cloud execution',
    });
    expect(hits[0]).toEqual(
      expect.objectContaining({
        claim: expect.objectContaining({ id: 'remote-runner' }),
        lexicalScore: 0,
        semanticScore: 1,
      }),
    );
    expect(hits[0]!.hybridScore).toBeGreaterThan(0);

    const client = createClient({ url });
    const schema = await client.execute(
      "SELECT name FROM sqlite_master WHERE name LIKE '%embedding%' OR name LIKE '%vector%'",
    );
    client.close();
    expect(schema.rows).toEqual([]);
  });

  it('excludes revision-bound stale claims from retrieval and context packs', async () => {
    const service = await createService();
    await service.recordClaim({
      id: 'revision-bound',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.snapshot',
      text: 'The runner snapshot matches revision abc123.',
      confidence: 0.4,
      validAtRevision: 'abc123',
    });

    expect(
      await service.searchClaims({
        taskId: 'task-a',
        query: 'runner snapshot',
        repositoryRevision: 'def456',
      }),
    ).toEqual([]);
    expect(
      await service.searchClaims({
        taskId: 'task-a',
        query: 'runner snapshot',
        repositoryRevision: 'def456',
        includeStale: true,
      }),
    ).toEqual([
      expect.objectContaining({
        revisionStatus: 'stale',
        claim: expect.objectContaining({ id: 'revision-bound' }),
      }),
    ]);

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'runner snapshot',
      repositoryRevision: 'def456',
      recordShadowRun: false,
    });
    expect(pack.items).toEqual([]);
    expect(pack.excludedStaleClaimIds).toEqual(['revision-bound']);
  });

  it('filters sibling claims when an exact query identifies one value', async () => {
    const service = await createService();
    await service.recordClaim({
      id: 'exact-target',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'dogfood.marker.target',
      text: 'Run EMDF-RUN-1 marker FACT-1 maps to value_1_1.',
      confidence: 0.4,
    });
    await service.recordClaim({
      id: 'exact-sibling',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'dogfood.marker.sibling',
      text: 'Run EMDF-RUN-1 marker FACT-2 maps to value_1_2.',
      confidence: 0.4,
    });

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'EMDF-RUN-1 FACT-1 value_1_1',
      recordShadowRun: false,
    });

    expect(pack.items.map((item) => item.claim.id)).toEqual(['exact-target']);
    expect(pack.exclusions).toContainEqual({
      claimId: 'exact-sibling',
      reason: 'query-anchor-mismatch',
    });
  });

  it('refreshes protected code fingerprints and excludes changed code evidence', async () => {
    const url = await freshDbUrl();
    const service = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    services.push(service);
    await service.recordClaim({
      id: 'code-claim',
      taskId: 'task-a',
      workspaceId: '/private/workspace',
      kind: 'observed_fact',
      subject: 'runner.symbol',
      text: 'The approval authority lives in the runner.',
      confidence: 0.4,
      entities: [{ type: 'symbol', value: 'ApprovalAuthority' }],
    });
    const currentProvider = {
      async resolve() {
        return {
          entity: { type: 'symbol' as const, value: 'ApprovalAuthority' },
          filePath: 'src/private-runner.ts',
          symbolName: 'ApprovalAuthority',
          codeGraphNodeId: 'node:approval-authority',
          contentHash: 'a'.repeat(64),
          symbolHash: 'b'.repeat(64),
          repositoryRevision: 'revision-private-1',
          graphContext: [
            {
              direction: 'caller' as const,
              nodeId: 'node:caller',
              name: 'runTask',
              filePath: 'src/task.ts',
              startLine: 10,
              endLine: 20,
            },
          ],
        };
      },
    };
    expect(
      await service.refreshCodeFingerprints({
        claimId: 'code-claim',
        provider: currentProvider,
      }),
    ).toEqual([
      expect.objectContaining({
        expectedContentHash: 'a'.repeat(64),
        observedContentHash: 'a'.repeat(64),
        status: 'current',
      }),
    ]);

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'approval authority runner',
      codeEvidenceProvider: {
        async resolve() {
          return {
            ...(await currentProvider.resolve()),
            contentHash: 'c'.repeat(64),
            repositoryRevision: 'revision-private-2',
          };
        },
      },
      recordShadowRun: false,
    });
    expect(pack.items).toEqual([]);
    expect(pack.excludedStaleClaimIds).toEqual(['code-claim']);
    expect(await service.listCodeFingerprints('code-claim')).toEqual([
      expect.objectContaining({
        expectedContentHash: 'a'.repeat(64),
        observedContentHash: 'c'.repeat(64),
        status: 'stale',
      }),
    ]);
    expect(
      await service.list({
        taskId: 'task-a',
        types: ['fingerprint_refresh_current', 'fingerprint_refresh_stale'],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'fingerprint_refresh_current' }),
        expect.objectContaining({ type: 'fingerprint_refresh_stale' }),
      ]),
    );

    const client = createClient({ url });
    const rows = await client.execute(
      'SELECT file_path, symbol_name, codegraph_node_id, expected_revision, observed_revision, graph_context FROM evidence_memory_code_fingerprints',
    );
    client.close();
    const serialized = JSON.stringify(rows.rows);
    expect(serialized).not.toContain('src/private-runner.ts');
    expect(serialized).not.toContain('ApprovalAuthority');
    expect(serialized).not.toContain('revision-private');
    expect(serialized).not.toContain('node:caller');
  });

  it('fails closed and records a timed-out live fingerprint refresh', async () => {
    const service = await createService();
    await service.record({
      id: 'slow-code-evidence',
      taskId: 'task-a',
      type: 'file_read',
      repositoryRevision: 'revision-1',
      payload: { path: 'src/memory.ts' },
    });
    await service.recordClaim({
      id: 'slow-code-claim',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'memory.live-refresh',
      text: 'Live refresh verifies the memory implementation.',
      confidence: 0.9,
      evidenceEventIds: ['slow-code-evidence'],
      entities: [{ type: 'symbol', value: 'MemoryImplementation' }],
    });

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'live refresh memory implementation',
      repositoryRevision: 'revision-1',
      codeRefreshTimeoutMs: 100,
      codeEvidenceProvider: {
        resolve: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      },
      recordShadowRun: false,
    });

    expect(pack.items).toEqual([]);
    expect(pack.exclusions).toContainEqual({
      claimId: 'slow-code-claim',
      reason: 'stale-code',
    });
    expect(
      await service.list({
        taskId: 'task-a',
        types: ['fingerprint_refresh_failed'],
      }),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          claimId: 'slow-code-claim',
          errorCount: 1,
          timedOut: true,
        }),
      }),
    ]);
  });

  it('builds a bounded shadow context pack and records only query hashes', async () => {
    const url = await freshDbUrl();
    const service = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
      now: () => 1_700_000_000_000,
      idGenerator: () => 'shadow-pack',
    });
    services.push(service);
    await service.recordClaim({
      id: 'memory-claim',
      taskId: 'task-a',
      kind: 'user_constraint',
      subject: 'security.persistence',
      text: 'Never persist plaintext retrieval queries.',
      confidence: 0.4,
    });

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'plaintext retrieval queries',
      tokenBudget: 500,
    });
    expect(pack).toEqual(
      expect.objectContaining({
        id: 'shadow-pack',
        taskId: 'task-a',
        tokenBudget: 500,
        excludedStaleClaimIds: [],
        shadow: true,
      }),
    );
    expect(pack.items.map((item) => item.claim.id)).toEqual(['memory-claim']);
    expect(pack.estimatedTokens).toBeLessThanOrEqual(500);
    expect(
      await service.list({
        taskId: 'task-a',
        types: ['context_pack_built'],
      }),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          queryHash: pack.queryHash,
          claimIds: ['memory-claim'],
          shadow: true,
        }),
      }),
    ]);

    const client = createClient({ url });
    const schema = await client.execute(
      "SELECT name, sql FROM sqlite_master WHERE name LIKE '%fts%'",
    );
    const disk = await client.execute(
      'SELECT payload FROM evidence_memory_events WHERE type = ?',
      ['context_pack_built'],
    );
    client.close();
    expect(
      schema.rows.some((row) => row.name === 'evidence_memory_claim_fts'),
    ).toBe(false);
    expect(JSON.stringify(disk.rows)).not.toContain(
      'plaintext retrieval queries',
    );

    const tinyBudget = Math.max(1, pack.diagnostics.envelopeTokens);
    const tinyPack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'plaintext retrieval queries',
      tokenBudget: tinyBudget,
      recordShadowRun: false,
    });
    expect(tinyPack.items).toEqual([]);
    expect(tinyPack.estimatedTokens).toBe(0);
    expect(tinyPack.exclusions).toContainEqual({
      claimId: 'memory-claim',
      reason: 'token-budget',
    });
    expect(tinyPack.diagnostics.envelopeTokens).toBeGreaterThan(20);
    expect(tinyPack.diagnostics.envelopeTokens).toBeLessThanOrEqual(60);
  });

  it('packs CodeGraph evidence with explanations under the exact rendered token budget', async () => {
    const service = await createService();
    await service.record({
      id: 'graph-evidence-event',
      taskId: 'task-a',
      type: 'decision_recorded',
      repositoryRevision: 'revision-a',
      payload: { decision: 'Use the graph-aware context builder.' },
    });
    await service.recordClaim({
      id: 'graph-claim',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.context-builder',
      text: 'The context builder expands callers and callees.',
      confidence: 0.95,
      evidenceEventIds: ['graph-evidence-event'],
      entities: [{ type: 'symbol', value: 'src/memory.ts#buildContext' }],
      validAtRevision: 'revision-a',
    });
    const provider = {
      async resolve() {
        return {
          entity: {
            type: 'symbol' as const,
            value: 'src/memory.ts#buildContext',
          },
          filePath: 'src/memory.ts',
          symbolName: 'buildContext',
          codeGraphNodeId: 'symbol:buildContext',
          contentHash: 'a'.repeat(64),
          symbolHash: 'b'.repeat(64),
          repositoryRevision: 'revision-a',
          graphContext: [],
        };
      },
      async expandContext() {
        return [
          {
            source: 'entity' as const,
            entity: {
              type: 'symbol' as const,
              value: 'src/memory.ts#buildContext',
            },
            filePath: 'src/memory.ts',
            symbolName: 'buildContext',
            codeGraphNodeId: 'symbol:buildContext',
            startLine: 10,
            endLine: 14,
            content:
              'export function buildContext() {\n  return selectEvidence();\n}',
            contentHash: 'c'.repeat(64),
            repositoryRevision: 'revision-a',
          },
          {
            source: 'caller' as const,
            entity: {
              type: 'symbol' as const,
              value: 'src/memory.ts#buildContext',
            },
            filePath: 'src/agent.ts',
            symbolName: 'runStep',
            codeGraphNodeId: 'symbol:runStep',
            startLine: 40,
            endLine: 43,
            content: 'function runStep() {\n  return buildContext();\n}',
            contentHash: 'd'.repeat(64),
            repositoryRevision: 'revision-a',
          },
        ];
      },
    };

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'graph context builder callers callees',
      repositoryRevision: 'revision-a',
      codeEvidenceProvider: provider,
      tokenBudget: 1_000,
      recordShadowRun: false,
    });

    expect(pack.estimatedTokens).toBeLessThanOrEqual(pack.tokenBudget);
    expect(pack.items).toEqual([
      expect.objectContaining({
        claim: expect.objectContaining({ id: 'graph-claim' }),
        codeEvidence: expect.arrayContaining([
          expect.objectContaining({
            source: 'entity',
            filePath: 'src/memory.ts',
          }),
          expect.objectContaining({
            source: 'caller',
            filePath: 'src/agent.ts',
          }),
        ]),
        explanation: expect.objectContaining({
          originalRank: 1,
          matchedBy: expect.arrayContaining(['lexical', 'codegraph']),
          graphSnippetCount: 2,
        }),
      }),
    ]);
    expect(pack.diagnostics).toEqual(
      expect.objectContaining({
        strategy: 'utility-density-v2',
        candidateCount: 1,
        selectedCount: 1,
        codeSnippetCount: 2,
        graphExpandedClaimCount: 1,
      }),
    );
  });

  it('admits a revision-bound Context Pack only after provenance and truth checks', async () => {
    const service = await EvidenceMemoryService.createWithUrl(
      await freshDbUrl(),
      {
        logger,
        now: () => 1_700_000_000_000,
        enablePromptInjection: true,
      },
    );
    services.push(service);
    await service.record({
      id: 'decision-evidence',
      taskId: 'task-a',
      type: 'decision_recorded',
      repositoryRevision: 'revision-1',
      payload: { decision: 'Keep guarded injection fail closed.' },
    });
    await service.recordClaim({
      id: 'guarded-injection',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.injection',
      text: 'Guarded injection must remain fail closed.',
      confidence: 0.95,
      evidenceEventIds: ['decision-evidence'],
      validAtRevision: 'revision-1',
    });

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'guarded injection fail closed',
      repositoryRevision: 'revision-1',
      recordShadowRun: false,
    });
    const admission = await service.admitContextPack({
      pack,
      repositoryRevision: 'revision-1',
    });

    expect(admission).toEqual(
      expect.objectContaining({
        admitted: true,
        reasonCodes: ['admitted'],
        claimCount: 1,
      }),
    );
  });

  it('applies task-scoped canary admission before guarded prompt injection', async () => {
    const service = await EvidenceMemoryService.createWithUrl(
      await freshDbUrl(),
      {
        logger,
        enablePromptInjection: true,
        promptInjectionAdmission: (taskId) => taskId === 'canary-task',
      },
    );
    services.push(service);

    expect(service.promptInjectionEnabled).toBe(true);
    expect(service.isPromptInjectionEnabledForTask('canary-task')).toBe(true);
    expect(service.isPromptInjectionEnabledForTask('control-task')).toBe(false);
  });

  it('fails task-scoped canary admission closed when the controller throws', async () => {
    const service = await EvidenceMemoryService.createWithUrl(
      await freshDbUrl(),
      {
        logger,
        enablePromptInjection: true,
        promptInjectionAdmission: () => {
          throw new Error('controller unavailable');
        },
      },
    );
    services.push(service);

    expect(service.isPromptInjectionEnabledForTask('task-a')).toBe(false);
  });

  it('detects competing subject versions and resolves them without cycles', async () => {
    const service = await createService();
    for (const [id, text] of [
      ['runner-v1', 'Use the local runner.'],
      ['runner-v2', 'Use the SSH runner.'],
    ] as const) {
      await service.recordClaim({
        id,
        taskId: 'task-a',
        kind: 'technical_decision',
        subject: 'runner.default',
        text,
        confidence: 0.4,
      });
    }

    expect(await service.findClaimConflicts('task-a')).toEqual([
      expect.objectContaining({
        subject: 'runner.default',
        claims: expect.arrayContaining([
          expect.objectContaining({ id: 'runner-v1' }),
          expect.objectContaining({ id: 'runner-v2' }),
        ]),
      }),
    ]);

    await service.relateClaims({
      fromClaimId: 'runner-v2',
      toClaimId: 'runner-v1',
      type: 'supersedes',
    });
    expect(await service.getClaim('runner-v1')).toEqual(
      expect.objectContaining({
        status: 'superseded',
        invalidatedBy: 'runner-v2',
      }),
    );
    expect(await service.findClaimConflicts('task-a')).toEqual([]);
    expect(await service.listClaimRelations('runner-v1')).toEqual([
      expect.objectContaining({
        fromClaimId: 'runner-v2',
        toClaimId: 'runner-v1',
        type: 'supersedes',
      }),
    ]);
    await expect(
      service.relateClaims({
        fromClaimId: 'runner-v1',
        toClaimId: 'runner-v2',
        type: 'supersedes',
      }),
    ).rejects.toThrow('would create a cycle');
  });

  it('resolves confirmed claims deterministically and reports lifecycle exclusions', async () => {
    const service = await createService();
    await service.record({
      id: 'decision-evidence',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await service.recordClaim({
      id: 'runner-primary',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the SSH runner for heavy builds.',
      confidence: 0.9,
      evidenceEventIds: ['decision-evidence'],
    });
    await service.recordClaim({
      id: 'runner-confirmation',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Heavy builds should execute on SSH.',
      confidence: 0.8,
      evidenceEventIds: ['decision-evidence'],
    });
    await service.recordClaim({
      id: 'runner-old',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Run every command locally.',
      confidence: 0.4,
    });
    await service.relateClaims({
      fromClaimId: 'runner-primary',
      toClaimId: 'runner-confirmation',
      type: 'confirms',
    });
    await service.relateClaims({
      fromClaimId: 'runner-primary',
      toClaimId: 'runner-old',
      type: 'supersedes',
    });

    expect(
      await service.resolveTruth({
        taskId: 'task-a',
        subject: 'runner.default',
      }),
    ).toEqual({
      taskId: 'task-a',
      subject: 'runner.default',
      state: 'resolved',
      selectedClaim: expect.objectContaining({ id: 'runner-primary' }),
      supportingClaims: [
        expect.objectContaining({ id: 'runner-primary' }),
        expect.objectContaining({ id: 'runner-confirmation' }),
      ],
      competingClaims: [],
      exclusions: [
        {
          claimId: 'runner-old',
          reason: 'superseded',
          byClaimId: 'runner-primary',
        },
      ],
      conflicts: [],
    });
  });

  it('fails closed on unresolved or explicitly contradictory active claims', async () => {
    const service = await createService();
    for (const [id, text] of [
      ['local-claim', 'Use the local runner.'],
      ['remote-claim', 'Use the remote runner.'],
    ] as const) {
      await service.recordClaim({
        id,
        taskId: 'task-a',
        kind: 'technical_decision',
        subject: 'runner.default',
        text,
        confidence: 0.4,
      });
    }

    const implicit = await service.resolveTruth({
      taskId: 'task-a',
      subject: 'runner.default',
    });
    expect(implicit.state).toBe('conflicted');
    expect(implicit.selectedClaim).toBeNull();
    expect(implicit.competingClaims.map((claim) => claim.id).sort()).toEqual([
      'local-claim',
      'remote-claim',
    ]);
    expect(implicit.conflicts).toEqual([
      {
        leftClaimId: 'local-claim',
        rightClaimId: 'remote-claim',
        explicit: false,
      },
    ]);

    await service.relateClaims({
      fromClaimId: 'remote-claim',
      toClaimId: 'local-claim',
      type: 'contradicts',
    });
    expect(
      (
        await service.resolveTruth({
          taskId: 'task-a',
          subject: 'runner.default',
        })
      ).conflicts,
    ).toEqual([
      {
        leftClaimId: 'local-claim',
        rightClaimId: 'remote-claim',
        explicit: true,
      },
    ]);
  });

  it('automatically confirms equivalent claims without leaving a conflict', async () => {
    const service = await createAutomationService();
    await service.record({
      id: 'confirm-event-a',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await service.record({
      id: 'confirm-event-b',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await service.recordClaim({
      id: 'confirm-a',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.backend',
      text: 'Use SQLite for evidence memory.',
      evidenceEventIds: ['confirm-event-a'],
    });
    await service.recordClaim({
      id: 'confirm-b',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.backend',
      text: 'USE SQLite for evidence memory!',
      evidenceEventIds: ['confirm-event-b'],
    });

    expect(await service.listClaimRelations('confirm-b')).toEqual([
      expect.objectContaining({
        fromClaimId: 'confirm-b',
        toClaimId: 'confirm-a',
        type: 'confirms',
        origin: 'automation',
        reason: 'exact-normalized-proposition',
      }),
    ]);
    expect(await service.findClaimConflicts('task-a')).toEqual([]);
    expect(
      await service.resolveTruth({
        taskId: 'task-a',
        subject: 'memory.backend',
      }),
    ).toEqual(
      expect.objectContaining({
        state: 'resolved',
        selectedClaim: expect.objectContaining({ id: 'confirm-a' }),
      }),
    );
  });

  it('automatically supersedes newer authoritative claims', async () => {
    const service = await createAutomationService();
    for (const id of ['decision-old', 'decision-new']) {
      await service.record({
        id,
        taskId: 'task-a',
        type: 'decision_recorded',
      });
    }
    await service.recordClaim({
      id: 'runner-old',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the local runner.',
      evidenceEventIds: ['decision-old'],
    });
    await service.recordClaim({
      id: 'runner-new',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the SSH runner.',
      evidenceEventIds: ['decision-new'],
    });

    expect(await service.getClaim('runner-old')).toEqual(
      expect.objectContaining({
        status: 'superseded',
        invalidatedBy: 'runner-new',
      }),
    );
    expect(await service.listClaimRelations('runner-new')).toEqual([
      expect.objectContaining({
        type: 'supersedes',
        origin: 'automation',
        reason: 'newer-authoritative-claim',
      }),
    ]);
  });

  it('automatically invalidates obsolete verified outcomes', async () => {
    const service = await createAutomationService();
    for (const id of ['test-failed', 'test-passed']) {
      await service.record({
        id,
        taskId: 'task-a',
        type: 'test_completed',
      });
    }
    await service.recordClaim({
      id: 'failed-run',
      taskId: 'task-a',
      kind: 'failed_approach',
      subject: 'verification:unit-tests',
      text: 'Unit tests failed.',
      evidenceEventIds: ['test-failed'],
    });
    await service.recordClaim({
      id: 'passed-run',
      taskId: 'task-a',
      kind: 'successful_approach',
      subject: 'verification:unit-tests',
      text: 'Unit tests passed.',
      evidenceEventIds: ['test-passed'],
    });

    expect(await service.getClaim('failed-run')).toEqual(
      expect.objectContaining({
        status: 'invalidated',
        invalidatedBy: 'passed-run',
      }),
    );
    expect(await service.listClaimRelations('passed-run')).toEqual([
      expect.objectContaining({
        type: 'invalidates',
        origin: 'automation',
        reason: 'newer-verified-outcome',
      }),
    ]);
  });

  it('materializes unresolved same-subject conflicts as contradictions', async () => {
    const service = await createAutomationService();
    await service.recordClaim({
      id: 'fact-a',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.platform',
      text: 'The runner uses Linux.',
    });
    await service.recordClaim({
      id: 'fact-b',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.platform',
      text: 'The runner uses macOS.',
    });

    expect(await service.listClaimRelations('fact-b')).toEqual([
      expect.objectContaining({
        type: 'contradicts',
        origin: 'automation',
        reason: 'unresolved-same-subject',
      }),
    ]);
    expect(await service.findClaimConflicts('task-a')).toHaveLength(1);
  });

  it('records human conflict resolutions and safely undoes lifecycle changes', async () => {
    const service = await createService();
    for (const [id, text] of [
      ['human-a-old', 'Use the local runner.'],
      ['human-z-new', 'Use the cloud runner.'],
    ] as const) {
      await service.recordClaim({
        id,
        taskId: 'task-a',
        kind: 'technical_decision',
        subject: 'runner.default',
        text,
      });
    }

    const resolution = await service.resolveConflict({
      taskId: 'task-a',
      claimIds: ['human-a-old', 'human-z-new'],
      action: 'accept_newer',
    });
    expect(resolution).toEqual(
      expect.objectContaining({
        action: 'accept_newer',
        selectedClaimId: 'human-z-new',
        revertedAt: null,
      }),
    );
    expect(await service.getClaim('human-a-old')).toEqual(
      expect.objectContaining({
        status: 'superseded',
        invalidatedBy: 'human-z-new',
      }),
    );
    expect(await service.findClaimConflicts('task-a')).toEqual([]);
    expect(await service.listConflictResolutions('task-a')).toEqual([
      expect.objectContaining({
        id: resolution.id,
        action: 'accept_newer',
        revertedAt: null,
      }),
    ]);

    await service.undoConflictResolution('task-a', resolution.id);
    expect(await service.getClaim('human-a-old')).toEqual(
      expect.objectContaining({
        status: 'active',
        invalidatedBy: null,
      }),
    );
    expect(await service.findClaimConflicts('task-a')).toHaveLength(1);
    expect(await service.listConflictResolutions('task-a')).toEqual([
      expect.objectContaining({
        id: resolution.id,
        revertedAt: expect.any(Number),
      }),
    ]);
    await expect(
      service.undoConflictResolution('task-a', resolution.id),
    ).rejects.toThrow('already been undone');
  });

  it('groups claims marked both valid and restores explicit contradictions on undo', async () => {
    const service = await createService();
    await service.recordClaim({
      id: 'both-a',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.platform',
      text: 'The runner uses Linux.',
    });
    await service.recordClaim({
      id: 'both-b',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.platform',
      text: 'The runner uses a Linux-compatible container.',
    });
    await service.relateClaims({
      fromClaimId: 'both-b',
      toClaimId: 'both-a',
      type: 'contradicts',
      origin: 'automation',
      reason: 'unresolved-same-subject',
    });

    const resolution = await service.resolveConflict({
      taskId: 'task-a',
      claimIds: ['both-a', 'both-b'],
      action: 'both_valid',
    });
    expect(
      await service.resolveTruth({
        taskId: 'task-a',
        subject: 'runner.platform',
      }),
    ).toEqual(expect.objectContaining({ state: 'resolved' }));
    expect(await service.listClaimRelations('both-a')).toEqual([
      expect.objectContaining({
        type: 'confirms',
        origin: 'manual',
        reason: 'human-conflict:both-valid',
      }),
    ]);

    await service.undoConflictResolution('task-a', resolution.id);
    expect(
      await service.resolveTruth({
        taskId: 'task-a',
        subject: 'runner.platform',
      }),
    ).toEqual(expect.objectContaining({ state: 'conflicted' }));
    expect(await service.listClaimRelations('both-a')).toEqual([
      expect.objectContaining({
        type: 'contradicts',
        origin: 'automation',
      }),
    ]);
  });

  it('reconciles existing claim history when automation is enabled after restart', async () => {
    const url = await freshDbUrl();
    let now = 100;
    const before = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      now: () => now++,
    });
    await before.record({
      id: 'restart-old-event',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await before.record({
      id: 'restart-new-event',
      taskId: 'task-a',
      type: 'decision_recorded',
    });
    await before.recordClaim({
      id: 'restart-old',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the local runner.',
      evidenceEventIds: ['restart-old-event'],
    });
    await before.recordClaim({
      id: 'restart-new',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'runner.default',
      text: 'Use the cloud runner.',
      evidenceEventIds: ['restart-new-event'],
    });
    await before.teardown();

    const reopened = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      enableContradictionAutomation: true,
    });
    services.push(reopened);
    expect(await reopened.getClaim('restart-old')).toEqual(
      expect.objectContaining({
        status: 'superseded',
        invalidatedBy: 'restart-new',
      }),
    );
    expect(await reopened.listClaimRelations('restart-new')).toEqual([
      expect.objectContaining({
        type: 'supersedes',
        origin: 'automation',
      }),
    ]);
  });

  it('excludes stale truth and rejects cross-subject lifecycle edges', async () => {
    const service = await createService();
    await service.recordClaim({
      id: 'revision-claim',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.snapshot',
      text: 'The runner has snapshot abc123.',
      confidence: 0.4,
      validAtRevision: 'abc123',
    });
    await service.recordClaim({
      id: 'different-subject',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'runner.platform',
      text: 'The runner uses Linux.',
      confidence: 0.4,
    });

    expect(
      await service.resolveTruth({
        taskId: 'task-a',
        subject: 'runner.snapshot',
        repositoryRevision: 'def456',
      }),
    ).toEqual({
      taskId: 'task-a',
      subject: 'runner.snapshot',
      state: 'empty',
      selectedClaim: null,
      supportingClaims: [],
      competingClaims: [],
      exclusions: [
        {
          claimId: 'revision-claim',
          reason: 'stale',
          byClaimId: null,
        },
      ],
      conflicts: [],
    });
    await expect(
      service.relateClaims({
        fromClaimId: 'different-subject',
        toClaimId: 'revision-claim',
        type: 'invalidates',
      }),
    ).rejects.toThrow('require claims with the same subject');
  });

  it('captures code fingerprints, detects drift, and refreshes the baseline explicitly', async () => {
    const service = await createService();
    await service.recordClaim({
      id: 'config-claim',
      taskId: 'task-a',
      kind: 'observed_fact',
      subject: 'config.mode',
      text: 'The config enables local mode.',
      confidence: 0.4,
      entities: [{ type: 'file', value: 'src/config.ts' }],
    });
    let source = 'export const mode = "local";\n';
    let revision = 'revision-a';
    const provider = {
      async resolve() {
        return {
          entity: { type: 'file' as const, value: 'src/config.ts' },
          filePath: 'src/config.ts',
          contentHash: createHash('sha256').update(source).digest('hex'),
          repositoryRevision: revision,
          graphContext: [],
        };
      },
    };

    const captured = await service.refreshCodeFingerprints({
      claimId: 'config-claim',
      provider,
    });
    expect(captured).toEqual([
      expect.objectContaining({
        entity: { type: 'file', value: 'src/config.ts' },
        status: 'current',
        expectedRevision: 'revision-a',
        observedRevision: 'revision-a',
      }),
    ]);

    source = 'export const mode = "remote";\n';
    revision = 'revision-b';
    const stale = await service.refreshCodeFingerprints({
      claimId: 'config-claim',
      provider,
    });
    expect(stale[0]).toEqual(
      expect.objectContaining({
        status: 'stale',
        expectedRevision: 'revision-a',
        observedRevision: 'revision-b',
      }),
    );

    const pack = await service.buildContextPack({
      taskId: 'task-a',
      query: 'config local mode',
      codeEvidenceProvider: provider,
      recordShadowRun: false,
    });
    expect(pack.items).toEqual([]);
    expect(pack.excludedStaleClaimIds).toEqual(['config-claim']);

    const refreshed = await service.refreshCodeFingerprints({
      claimId: 'config-claim',
      provider,
      acceptCurrent: true,
    });
    expect(refreshed[0]).toEqual(
      expect.objectContaining({
        status: 'current',
        expectedRevision: 'revision-b',
        observedRevision: 'revision-b',
      }),
    );
  });

  it('protects symbol identity and CodeGraph expansion at rest', async () => {
    const url = await freshDbUrl();
    const service = await EvidenceMemoryService.createWithUrl(url, {
      logger,
      dataProtection: new AeadDataProtection(randomBytes(32)),
    });
    services.push(service);
    await service.recordClaim({
      id: 'symbol-claim',
      taskId: 'private-task',
      kind: 'observed_fact',
      subject: 'symbol.behavior',
      text: 'The secret symbol calls a private helper.',
      confidence: 0.4,
      entities: [{ type: 'symbol', value: 'src/private.ts#SecretSymbol' }],
    });
    const digest = createHash('sha256').update('source').digest('hex');
    await service.refreshCodeFingerprints({
      claimId: 'symbol-claim',
      provider: {
        async resolve() {
          return {
            entity: {
              type: 'symbol' as const,
              value: 'src/private.ts#SecretSymbol',
            },
            filePath: 'src/private.ts',
            symbolName: 'SecretSymbol',
            codeGraphNodeId: 'symbol:private-node',
            contentHash: digest,
            symbolHash: digest,
            repositoryRevision: 'private-revision',
            graphContext: [
              {
                direction: 'callee' as const,
                nodeId: 'symbol:private-helper',
                name: 'privateHelper',
                filePath: 'src/helper.ts',
                startLine: 10,
                endLine: 12,
              },
            ],
          };
        },
      },
    });

    expect(await service.listCodeFingerprints('symbol-claim')).toEqual([
      expect.objectContaining({
        filePath: 'src/private.ts',
        symbolName: 'SecretSymbol',
        codeGraphNodeId: 'symbol:private-node',
        status: 'current',
        graphContext: [
          expect.objectContaining({
            name: 'privateHelper',
            filePath: 'src/helper.ts',
          }),
        ],
      }),
    ]);

    const client = createClient({ url });
    const rows = await client.execute(
      'SELECT file_path, symbol_name, codegraph_node_id, expected_revision, observed_revision, graph_context FROM evidence_memory_code_fingerprints',
    );
    client.close();
    const serialized = JSON.stringify(rows.rows);
    for (const value of Object.values(rows.rows[0]!)) {
      expect(String(value)).toMatch(/^clodex-protected:/);
    }
    expect(serialized).not.toContain('private.ts');
    expect(serialized).not.toContain('SecretSymbol');
    expect(serialized).not.toContain('privateHelper');
    expect(serialized).not.toContain('private-revision');
  });

  it('builds bounded inspector snapshots with provenance and clears one task', async () => {
    const service = await createService();
    await service.record({
      id: 'inspector-event',
      taskId: 'task-a',
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Use the guarded memory inspector.' },
    });
    await service.recordClaim({
      id: 'inspector-claim',
      taskId: 'task-a',
      kind: 'technical_decision',
      subject: 'memory.inspector',
      text: 'Use the guarded memory inspector.',
      evidenceEventIds: ['inspector-event'],
    });
    await service.record({
      id: 'other-event',
      taskId: 'task-b',
      type: 'user_message',
      payload: { text: 'Keep this task.' },
    });

    const snapshot = await service.getInspectorSnapshot({
      taskId: 'task-a',
      eventLimit: 10,
      claimLimit: 10,
    });
    expect(snapshot).toEqual(
      expect.objectContaining({
        taskId: 'task-a',
        stats: expect.objectContaining({
          events: expect.objectContaining({ total: 1 }),
          claims: expect.objectContaining({
            total: 1,
            byKind: { technical_decision: 1 },
            byStatus: { active: 1 },
          }),
        }),
      }),
    );
    expect(snapshot.recentEvents.map((event) => event.id)).toEqual([
      'inspector-event',
    ]);
    expect(snapshot.claims.map((claim) => claim.id)).toEqual([
      'inspector-claim',
    ]);

    const details = await service.getClaimDetails('inspector-claim');
    expect(details.evidenceEvents.map((event) => event.id)).toEqual([
      'inspector-event',
    ]);
    expect(details.truth.state).toBe('resolved');

    const exported = await service.exportTask('task-a');
    expect(exported).toEqual(
      expect.objectContaining({
        format: 'clodex-evidence-memory',
        version: 1,
        taskId: 'task-a',
        truncated: { events: false, claims: false },
      }),
    );

    expect(await service.clearTask('task-a')).toEqual({
      taskId: 'task-a',
      deletedEvents: 1,
      deletedClaims: 1,
    });
    expect(
      (await service.getInspectorSnapshot({ taskId: 'task-a' })).stats,
    ).toEqual(
      expect.objectContaining({
        events: { total: 0, byType: {} },
        claims: expect.objectContaining({ total: 0 }),
      }),
    );
    expect((await service.getStats('task-b')).total).toBe(1);
  });

  it('reports deterministic ingestion and retrieval quality metrics', async () => {
    const service = await createService();
    await service.record({
      taskId: 'quality-task',
      type: 'decision_recorded',
      source: 'agent_message',
      sourceId: 'message-1',
      ingestionKey: 'message:1',
      payload: { decision: 'Use deterministic evidence ingestion.' },
    });
    await service.recordClaim({
      id: 'quality-claim',
      taskId: 'quality-task',
      kind: 'technical_decision',
      subject: 'memory.ingestion',
      text: 'Use deterministic evidence ingestion.',
      evidenceEventIds: [
        (
          await service.list({
            taskId: 'quality-task',
            types: ['decision_recorded'],
          })
        )[0]!.id,
      ],
    });
    await service.record({
      taskId: 'quality-task',
      type: 'context_pack_built',
      source: 'context_builder',
      sourceId: 'pack-1',
      ingestionKey: 'context-pack:1',
      payload: {
        claimIds: ['quality-claim'],
        excludedStaleClaimIds: ['stale-claim'],
        scores: [2.5],
        estimatedTokens: 250,
        tokenBudget: 1_000,
      },
    });

    const quality = (
      await service.getInspectorSnapshot({ taskId: 'quality-task' })
    ).quality;
    expect(quality).toEqual({
      status: 'healthy',
      ingestion: expect.objectContaining({
        totalEvents: 2,
        deterministicEvents: 2,
        deterministicCoverage: 1,
        sourceAttributedEvents: 2,
        sourceCoverage: 1,
        payloadHashedEvents: 2,
        payloadHashCoverage: 1,
        totalClaims: 1,
        evidenceBackedClaims: 1,
        evidenceBackedClaimRate: 1,
      }),
      retrieval: {
        totalContextPacks: 1,
        sampledContextPacks: 1,
        packsWithClaims: 1,
        hitRate: 1,
        averageClaimsPerPack: 1,
        averageEstimatedTokens: 250,
        tokenBudgetUtilization: 0.25,
        staleExclusions: 1,
        staleExclusionRate: 0.5,
        lexicalEvidenceRate: 1,
        averageCodeSnippets: 0,
        graphExpansionRate: 0,
        tokenBudgetExclusions: 0,
        tokenBudgetExclusionRate: 0,
      },
      contradictionAutomation: {
        totalRelations: 0,
        automatedRelations: 0,
        superseded: 0,
        invalidated: 0,
        contradictions: 0,
        confirmations: 0,
        unresolvedConflicts: 0,
      },
      warnings: [],
    });
  });
});
