import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    ALTER TABLE evidence_memory_claim_relations
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
  `);
  await db.run(sql`
    ALTER TABLE evidence_memory_claim_relations
    ADD COLUMN reason TEXT
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_claim_relations_origin
    ON evidence_memory_claim_relations(origin, type, created_at DESC)
  `);
};
