import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS evidence_memory_claims (
      id                    TEXT PRIMARY KEY,
      task_id               TEXT NOT NULL,
      task_id_hash          TEXT NOT NULL,
      workspace_id          TEXT,
      workspace_id_hash     TEXT NOT NULL,
      kind                  TEXT NOT NULL,
      subject               TEXT NOT NULL,
      subject_hash          TEXT NOT NULL,
      text                  TEXT NOT NULL,
      status                TEXT NOT NULL,
      confidence            REAL NOT NULL,
      valid_at_revision     TEXT,
      invalidated_by        TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claims_task_status
    ON evidence_memory_claims(task_id_hash, status, updated_at DESC)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claims_subject
    ON evidence_memory_claims(task_id_hash, subject_hash, updated_at DESC)
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS evidence_memory_claim_evidence (
      id          TEXT PRIMARY KEY,
      claim_id    TEXT NOT NULL,
      event_id    TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(claim_id, event_id),
      FOREIGN KEY(claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES evidence_memory_events(id) ON DELETE CASCADE
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_evidence_claim
    ON evidence_memory_claim_evidence(claim_id)
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS evidence_memory_claim_entities (
      id          TEXT PRIMARY KEY,
      claim_id    TEXT NOT NULL,
      type        TEXT NOT NULL,
      value       TEXT NOT NULL,
      value_hash  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(claim_id, type, value_hash),
      FOREIGN KEY(claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_entities_lookup
    ON evidence_memory_claim_entities(type, value_hash, claim_id)
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS evidence_memory_claim_relations (
      id             TEXT PRIMARY KEY,
      from_claim_id  TEXT NOT NULL,
      to_claim_id    TEXT NOT NULL,
      type           TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      UNIQUE(from_claim_id, to_claim_id, type),
      FOREIGN KEY(from_claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE,
      FOREIGN KEY(to_claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_relations_from
    ON evidence_memory_claim_relations(from_claim_id)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_relations_to
    ON evidence_memory_claim_relations(to_claim_id)
  `);
};
