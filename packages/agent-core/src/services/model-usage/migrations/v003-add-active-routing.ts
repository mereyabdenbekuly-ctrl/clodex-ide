import { sql } from 'drizzle-orm';
import type { MigrationScript } from '../../../migrate-database';

export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`
    ALTER TABLE model_route_decisions
    ADD COLUMN selected_model_id TEXT NOT NULL DEFAULT ''
  `);
  await db.run(sql`
    ALTER TABLE model_route_decisions
    ADD COLUMN selected_endpoint_id TEXT
  `);
  await db.run(sql`
    ALTER TABLE model_route_decisions
    ADD COLUMN active_routing_admitted INTEGER NOT NULL DEFAULT 0
  `);
  await db.run(sql`
    UPDATE model_route_decisions
    SET selected_model_id = active_model_id
    WHERE selected_model_id = ''
  `);
};
