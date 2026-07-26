import { sql } from 'drizzle-orm';
import type { MigrationScript } from '@clodex/agent-core/migrate-database';

/**
 * v12 — add-file-edit-approval-mode
 *
 * Automatic file-edit approval is opt-in per agent. Existing rows therefore
 * migrate to the fail-closed `manual` mode.
 *
 * Keep the SQL literal inlined: migrations must remain replay-stable if the
 * runtime default ever changes.
 */
export const up: MigrationScript['up'] = async (db) => {
  await db.run(
    sql`ALTER TABLE agentInstances ADD COLUMN file_edit_approval_mode TEXT NOT NULL DEFAULT 'manual'`,
  );
};
