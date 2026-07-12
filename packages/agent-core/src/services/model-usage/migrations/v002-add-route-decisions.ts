import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS model_route_decisions (
      id                    TEXT PRIMARY KEY,
      task_id               TEXT NOT NULL,
      task_id_hash          TEXT NOT NULL,
      purpose               TEXT NOT NULL,
      task_role             TEXT,
      active_model_id       TEXT NOT NULL,
      active_endpoint_id    TEXT,
      proposed_model_id     TEXT,
      proposed_endpoint_id  TEXT,
      candidate_count       INTEGER NOT NULL,
      excluded_count        INTEGER NOT NULL,
      replay_safety         TEXT NOT NULL,
      created_at            INTEGER NOT NULL
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_model_route_decisions_task_time
    ON model_route_decisions(task_id_hash, created_at DESC, id DESC)
  `);
};
