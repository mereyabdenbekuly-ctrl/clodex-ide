import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS model_provider_quota_windows (
      endpoint_key_hash      TEXT PRIMARY KEY,
      endpoint_key           TEXT NOT NULL,
      rate_limited_until     INTEGER NOT NULL,
      observed_at            INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_model_provider_quota_deadline
    ON model_provider_quota_windows(rate_limited_until DESC)
  `);
};
