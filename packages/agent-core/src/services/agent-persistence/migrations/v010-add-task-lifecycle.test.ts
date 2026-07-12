import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, describe, expect, it } from 'vitest';
import { up } from './v010-add-task-lifecycle';

describe('v010 add task lifecycle migration', () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  it('adds fork lineage, archive state, and the archive index to a v9 table', async () => {
    const client = createClient({ url: ':memory:' });
    clients.push(client);
    const db = drizzle(client);
    await client.execute(`
      CREATE TABLE agentInstances(
        id TEXT NOT NULL PRIMARY KEY,
        parent_agent_instance_id TEXT
      )
    `);

    await up(db as never);

    const columns = await client.execute('PRAGMA table_info(agentInstances)');
    expect(columns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'forked_from_agent_id',
        'forked_from_message_id',
        'archived_at',
      ]),
    );

    const indexes = await client.execute('PRAGMA index_list(agentInstances)');
    expect(indexes.rows.map((row) => row.name)).toContain(
      'agentInstances_archived_at_index',
    );
  });
});
