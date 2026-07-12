import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { metaTable } from '../../migrate-database';

export const meta = metaTable;

export const evidenceMemoryEvents = sqliteTable('evidence_memory_events', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  taskIdHash: text('task_id_hash').notNull(),
  workspaceId: text('workspace_id'),
  workspaceIdHash: text('workspace_id_hash').notNull(),
  type: text('type').notNull(),
  timestamp: integer('timestamp').notNull(),
  messageId: text('message_id'),
  repositoryRevision: text('repository_revision'),
  source: text('source'),
  sourceIdHash: text('source_id_hash'),
  ingestionKeyHash: text('ingestion_key_hash'),
  payloadHash: text('payload_hash'),
  contentHash: text('content_hash'),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const evidenceMemoryClaims = sqliteTable('evidence_memory_claims', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  taskIdHash: text('task_id_hash').notNull(),
  workspaceId: text('workspace_id'),
  workspaceIdHash: text('workspace_id_hash').notNull(),
  kind: text('kind').notNull(),
  subject: text('subject').notNull(),
  subjectHash: text('subject_hash').notNull(),
  text: text('text').notNull(),
  status: text('status').notNull(),
  confidence: real('confidence').notNull(),
  validAtRevision: text('valid_at_revision'),
  invalidatedBy: text('invalidated_by'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const evidenceMemoryClaimEvidence = sqliteTable(
  'evidence_memory_claim_evidence',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    eventId: text('event_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
);

export const evidenceMemoryClaimEntities = sqliteTable(
  'evidence_memory_claim_entities',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    type: text('type').notNull(),
    value: text('value').notNull(),
    valueHash: text('value_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
);

export const evidenceMemoryClaimRelations = sqliteTable(
  'evidence_memory_claim_relations',
  {
    id: text('id').primaryKey(),
    fromClaimId: text('from_claim_id').notNull(),
    toClaimId: text('to_claim_id').notNull(),
    type: text('type').notNull(),
    origin: text('origin').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
);

export const evidenceMemoryCodeFingerprints = sqliteTable(
  'evidence_memory_code_fingerprints',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    taskIdHash: text('task_id_hash').notNull(),
    entityType: text('entity_type').notNull(),
    entityValueHash: text('entity_value_hash').notNull(),
    filePath: text('file_path').notNull(),
    symbolName: text('symbol_name'),
    codeGraphNodeId: text('codegraph_node_id'),
    expectedContentHash: text('expected_content_hash').notNull(),
    expectedSymbolHash: text('expected_symbol_hash'),
    observedContentHash: text('observed_content_hash').notNull(),
    observedSymbolHash: text('observed_symbol_hash'),
    expectedRevision: text('expected_revision'),
    observedRevision: text('observed_revision'),
    graphContext: text('graph_context').notNull(),
    status: text('status').notNull(),
    capturedAt: integer('captured_at').notNull(),
    lastValidatedAt: integer('last_validated_at').notNull(),
  },
);
