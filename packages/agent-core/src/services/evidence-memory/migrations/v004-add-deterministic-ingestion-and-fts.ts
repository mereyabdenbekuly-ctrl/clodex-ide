import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`ALTER TABLE evidence_memory_events ADD COLUMN source TEXT`);
  await db.run(
    sql`ALTER TABLE evidence_memory_events ADD COLUMN source_id_hash TEXT`,
  );
  await db.run(
    sql`ALTER TABLE evidence_memory_events ADD COLUMN ingestion_key_hash TEXT`,
  );
  await db.run(
    sql`ALTER TABLE evidence_memory_events ADD COLUMN payload_hash TEXT`,
  );
  await db.run(
    sql`ALTER TABLE evidence_memory_events ADD COLUMN content_hash TEXT`,
  );
  await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_memory_event_ingestion
    ON evidence_memory_events(task_id_hash, ingestion_key_hash)
    WHERE ingestion_key_hash IS NOT NULL
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_evidence_memory_event_source
    ON evidence_memory_events(task_id_hash, source, source_id_hash, timestamp DESC)
  `);
};
