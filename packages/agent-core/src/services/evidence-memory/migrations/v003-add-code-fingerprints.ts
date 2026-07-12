import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS evidence_memory_code_fingerprints (
      id                       TEXT PRIMARY KEY,
      claim_id                 TEXT NOT NULL,
      task_id_hash             TEXT NOT NULL,
      entity_type              TEXT NOT NULL,
      entity_value_hash        TEXT NOT NULL,
      file_path                TEXT NOT NULL,
      symbol_name              TEXT,
      codegraph_node_id        TEXT,
      expected_content_hash    TEXT NOT NULL,
      expected_symbol_hash     TEXT,
      observed_content_hash    TEXT NOT NULL,
      observed_symbol_hash     TEXT,
      expected_revision        TEXT,
      observed_revision        TEXT,
      graph_context            TEXT NOT NULL,
      status                   TEXT NOT NULL,
      captured_at              INTEGER NOT NULL,
      last_validated_at        INTEGER NOT NULL,
      UNIQUE(claim_id, entity_type, entity_value_hash),
      FOREIGN KEY(claim_id) REFERENCES evidence_memory_claims(id) ON DELETE CASCADE
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_code_fingerprints_claim
    ON evidence_memory_code_fingerprints(claim_id, status)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_code_fingerprints_entity
    ON evidence_memory_code_fingerprints(task_id_hash, entity_type, entity_value_hash)
  `);
};
