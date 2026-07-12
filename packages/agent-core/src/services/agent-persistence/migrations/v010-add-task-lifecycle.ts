import { sql } from 'drizzle-orm';
import type { MigrationScript } from '@clodex/agent-core/migrate-database';

/**
 * v10 — add-task-lifecycle
 *
 * Adds user-facing task lifecycle metadata independently from
 * `parent_agent_instance_id`, which remains reserved for runtime subagents.
 */
export const up: MigrationScript['up'] = async (db) => {
  await db.run(
    sql`ALTER TABLE agentInstances ADD COLUMN forked_from_agent_id TEXT`,
  );
  await db.run(
    sql`ALTER TABLE agentInstances ADD COLUMN forked_from_message_id TEXT`,
  );
  await db.run(sql`ALTER TABLE agentInstances ADD COLUMN archived_at INTEGER`);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS agentInstances_archived_at_index ON agentInstances(archived_at)`,
  );
};
