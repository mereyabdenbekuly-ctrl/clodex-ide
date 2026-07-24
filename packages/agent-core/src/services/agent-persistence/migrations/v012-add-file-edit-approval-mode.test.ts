import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, describe, expect, it } from 'vitest';
import { up } from './v012-add-file-edit-approval-mode';

describe('v012 add file-edit approval mode migration', () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  it('adds a required fail-closed mode and backfills existing rows', async () => {
    const client = createClient({ url: ':memory:' });
    clients.push(client);
    const db = drizzle(client);
    await client.execute(`
      CREATE TABLE agentInstances(
        id TEXT NOT NULL PRIMARY KEY
      )
    `);
    await client.execute(
      "INSERT INTO agentInstances(id) VALUES ('existing-agent')",
    );

    await up(db as never);

    const columns = await client.execute('PRAGMA table_info(agentInstances)');
    const column = columns.rows.find(
      (row) => row.name === 'file_edit_approval_mode',
    );
    expect(column?.notnull).toBeTruthy();
    expect(column?.dflt_value).toBe("'manual'");

    const rows = await client.execute(
      'SELECT file_edit_approval_mode FROM agentInstances',
    );
    expect(rows.rows[0]?.file_edit_approval_mode).toBe('manual');
  });
});
