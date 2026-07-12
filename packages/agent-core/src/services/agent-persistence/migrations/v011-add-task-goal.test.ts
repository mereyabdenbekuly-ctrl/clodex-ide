import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, describe, expect, it } from 'vitest';
import { up } from './v011-add-task-goal';

describe('v011 add task goal migration', () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  it('adds the nullable goal column to a v10 agent table', async () => {
    const client = createClient({ url: ':memory:' });
    clients.push(client);
    const db = drizzle(client);
    await client.execute(`
      CREATE TABLE agentInstances(
        id TEXT NOT NULL PRIMARY KEY,
        archived_at INTEGER
      )
    `);

    await up(db as never);

    const columns = await client.execute('PRAGMA table_info(agentInstances)');
    expect(columns.rows.map((row) => row.name)).toContain('goal');
    expect(
      columns.rows.find((row) => row.name === 'goal')?.notnull,
    ).toBeFalsy();
  });
});
