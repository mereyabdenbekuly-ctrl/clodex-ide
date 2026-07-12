import { sql } from 'drizzle-orm';
import type { MigrationScript } from '@clodex/agent-core/migrate-database';

/**
 * v11 — add-task-goal
 *
 * Stores the user-owned task objective and budget independently from message
 * history so it survives resume, archive, and application restarts.
 */
export const up: MigrationScript['up'] = async (db) => {
  await db.run(sql`ALTER TABLE agentInstances ADD COLUMN goal TEXT`);
};
