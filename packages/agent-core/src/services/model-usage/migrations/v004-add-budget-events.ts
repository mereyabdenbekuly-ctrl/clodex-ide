import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS model_budget_events (
      id                    TEXT PRIMARY KEY,
      reservation_id        TEXT,
      policy_ids_json       TEXT NOT NULL,
      task_id               TEXT NOT NULL,
      task_id_hash          TEXT NOT NULL,
      workspace_id          TEXT,
      workspace_id_hash     TEXT,
      provider_id           TEXT NOT NULL,
      amount_usd            REAL NOT NULL,
      status                TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      expires_at            INTEGER
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_model_budget_events_time
    ON model_budget_events(created_at DESC, id DESC)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_model_budget_events_reservation
    ON model_budget_events(reservation_id, created_at DESC)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_model_budget_events_provider_time
    ON model_budget_events(provider_id, created_at DESC)
  `);
};
