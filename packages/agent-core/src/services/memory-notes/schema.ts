import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { metaTable } from '../../migrate-database';

export const meta = metaTable;

export const memoryNotes = sqliteTable('memory_notes', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  /**
   * Protected canonical scope identifier.
   *
   * - global: null
   * - workspace: absolute mounted workspace path
   * - agent: agent instance id
   */
  scopeKey: text('scope_key'),
  /**
   * SHA-256 of the scope type and canonical key. This deliberately contains
   * no plaintext path/agent id and lets SQLite filter before decryption.
   */
  scopeKeyHash: text('scope_key_hash').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  /** Protected JSON array of strings. */
  tags: text('tags').notNull(),
  sensitivity: text('sensitivity').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
