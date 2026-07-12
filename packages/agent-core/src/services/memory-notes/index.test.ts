import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AeadDataProtection } from '../../host/data-protection';
import type { Logger } from '../../host/logger';
import { MemoryNotesService, type MemoryNoteScopeRef } from './index';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const globalScope = {
  scope: 'global',
  scopeKey: null,
} satisfies MemoryNoteScopeRef;
const agentScope = {
  scope: 'agent',
  scopeKey: 'agent-1',
} satisfies MemoryNoteScopeRef;
const workspaceScope = {
  scope: 'workspace',
  scopeKey: '/workspaces/alpha',
} satisfies MemoryNoteScopeRef;

const services: MemoryNotesService[] = [];

async function createService(
  dataProtection?: AeadDataProtection,
): Promise<MemoryNotesService> {
  const service = await MemoryNotesService.createWithUrl(
    ':memory:',
    logger,
    dataProtection,
  );
  services.push(service);
  return service;
}

async function freshDbUrl(): Promise<string> {
  const directory = path.join(os.tmpdir(), 'memory-notes-tests');
  await fs.mkdir(directory, { recursive: true });
  return `file:${path.join(directory, `${randomUUID()}.sqlite`)}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.teardown()));
});

describe('MemoryNotesService', () => {
  it('supports scoped add, list, read, and delete', async () => {
    const service = await createService();
    const global = await service.add({
      scope: globalScope,
      title: 'Global preference',
      content: 'Use concise status summaries.',
      tags: ['style'],
    });
    const workspace = await service.add({
      scope: workspaceScope,
      title: 'Workspace command',
      content: 'Run pnpm test before delivery.',
      tags: ['verification'],
      sensitivity: 'sensitive',
    });
    await service.add({
      scope: agentScope,
      title: 'Current investigation',
      content: 'The failing area is the parser.',
    });

    expect(await service.list({ scopes: [globalScope] })).toEqual([
      expect.objectContaining({
        id: global.id,
        title: 'Global preference',
        scope: 'global',
      }),
    ]);
    expect(await service.read(workspace.id, [globalScope])).toBeNull();
    expect(await service.read(workspace.id, [workspaceScope])).toEqual(
      expect.objectContaining({
        content: 'Run pnpm test before delivery.',
        sensitivity: 'sensitive',
      }),
    );

    expect(await service.delete(workspace.id, [globalScope])).toBe(false);
    expect(await service.delete(workspace.id, [workspaceScope])).toBe(true);
    expect(await service.read(workspace.id, [workspaceScope])).toBeNull();
  });

  it('implements any, all-on-line, and all-within-entry search modes', async () => {
    const service = await createService();
    const split = await service.add({
      scope: workspaceScope,
      title: 'Split terms',
      content: 'alpha is on this line\nbeta is on another line',
    });
    const sameLine = await service.add({
      scope: workspaceScope,
      title: 'Same line',
      content: 'alpha and beta are together',
    });
    await service.add({
      scope: workspaceScope,
      title: 'Unrelated',
      content: 'gamma only',
    });

    const any = await service.search({
      scopes: [workspaceScope],
      query: 'alpha missing',
      mode: 'any',
    });
    expect(any.map((result) => result.id).sort()).toEqual(
      [sameLine.id, split.id].sort(),
    );

    const withinEntry = await service.search({
      scopes: [workspaceScope],
      query: 'alpha beta',
      mode: 'all-within-entry',
    });
    expect(withinEntry.map((result) => result.id).sort()).toEqual(
      [sameLine.id, split.id].sort(),
    );

    const onLine = await service.search({
      scopes: [workspaceScope],
      query: 'alpha beta',
      mode: 'all-on-line',
    });
    expect(onLine).toEqual([
      expect.objectContaining({
        id: sameLine.id,
        excerpt: 'alpha and beta are together',
      }),
    ]);
  });

  it('protects note fields while leaving only a scope hash queryable', async () => {
    const url = await freshDbUrl();
    const protection = new AeadDataProtection(randomBytes(32));
    const service = await MemoryNotesService.createWithUrl(
      url,
      logger,
      protection,
    );
    services.push(service);

    const note = await service.add({
      scope: workspaceScope,
      title: 'Private title',
      content: 'Private content',
      tags: ['private-tag'],
    });

    const client = createClient({ url });
    const result = await client.execute({
      sql: 'SELECT scope_key, scope_key_hash, title, content, tags FROM memory_notes WHERE id = ?',
      args: [note.id],
    });
    client.close();
    const row = result.rows[0]!;

    expect(String(row.scope_key)).toMatch(/^clodex-protected:/);
    expect(String(row.title)).toMatch(/^clodex-protected:/);
    expect(String(row.content)).toMatch(/^clodex-protected:/);
    expect(String(row.tags)).toMatch(/^clodex-protected:/);
    expect(String(row.scope_key_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain('/workspaces/alpha');
    expect(JSON.stringify(row)).not.toContain('Private content');
  });

  it('migrates plaintext fields when data protection becomes available', async () => {
    const url = await freshDbUrl();
    const plaintextService = await MemoryNotesService.createWithUrl(
      url,
      logger,
    );
    const note = await plaintextService.add({
      scope: agentScope,
      title: 'Legacy title',
      content: 'Legacy plaintext',
    });
    await plaintextService.teardown();

    const protectedService = await MemoryNotesService.createWithUrl(
      url,
      logger,
      new AeadDataProtection(randomBytes(32)),
    );
    services.push(protectedService);

    expect(await protectedService.read(note.id, [agentScope])).toEqual(
      expect.objectContaining({
        title: 'Legacy title',
        content: 'Legacy plaintext',
      }),
    );

    const client = createClient({ url });
    const result = await client.execute({
      sql: 'SELECT title, content FROM memory_notes WHERE id = ?',
      args: [note.id],
    });
    client.close();
    expect(String(result.rows[0]!.title)).toMatch(/^clodex-protected:/);
    expect(String(result.rows[0]!.content)).toMatch(/^clodex-protected:/);
  });

  it('fails closed when protected notes are opened without the key', async () => {
    const url = await freshDbUrl();
    const protectedService = await MemoryNotesService.createWithUrl(
      url,
      logger,
      new AeadDataProtection(randomBytes(32)),
    );
    const note = await protectedService.add({
      scope: agentScope,
      title: 'Protected',
      content: 'Secret',
    });
    await protectedService.teardown();

    const unprotectedService = await MemoryNotesService.createWithUrl(
      url,
      logger,
    );
    services.push(unprotectedService);
    await expect(
      unprotectedService.read(note.id, [agentScope]),
    ).rejects.toThrow('requires host data protection');
  });

  it('rejects empty notes and enforces bounded result limits', async () => {
    const service = await createService();
    await expect(
      service.add({
        scope: globalScope,
        title: 'Empty',
        content: '   ',
      }),
    ).rejects.toThrow('must not be empty');
    await expect(
      service.list({ scopes: [globalScope], limit: 51 }),
    ).rejects.toThrow('between 1 and 50');
  });

  it('exports portable decrypted notes without exposing SQLite envelopes', async () => {
    const service = await createService(
      new AeadDataProtection(randomBytes(32)),
    );
    await service.add({
      scope: globalScope,
      title: 'Global note',
      content: 'Portable global content',
      tags: ['export'],
    });
    await service.add({
      scope: workspaceScope,
      title: 'Workspace note',
      content: 'Portable workspace content',
    });

    const exported = await service.exportNotes({ scope: 'workspace' });

    expect(exported).toMatchObject({
      format: 'clodex-memory-notes',
      version: 1,
      scope: 'workspace',
      notes: [
        expect.objectContaining({
          title: 'Workspace note',
          content: 'Portable workspace content',
          scopeKey: '/workspaces/alpha',
        }),
      ],
    });
    expect(JSON.stringify(exported)).not.toContain('clodex-protected:');
    expect(JSON.stringify(exported)).not.toContain('Global note');
  });

  it('reports per-scope stats and clears only the selected scope type', async () => {
    const service = await createService();
    await service.add({
      scope: globalScope,
      title: 'Global',
      content: 'Global content',
    });
    await service.add({
      scope: workspaceScope,
      title: 'Workspace',
      content: 'Workspace content',
    });
    await service.add({
      scope: agentScope,
      title: 'Agent',
      content: 'Agent content',
    });

    expect(await service.getStats()).toMatchObject({
      total: 3,
      byScope: {
        global: 1,
        workspace: 1,
        agent: 1,
      },
      oldestCreatedAt: expect.any(Number),
      newestUpdatedAt: expect.any(Number),
    });

    expect(await service.clear({ scope: 'workspace' })).toBe(1);
    expect(await service.getStats()).toMatchObject({
      total: 2,
      byScope: {
        global: 1,
        workspace: 0,
        agent: 1,
      },
    });
  });

  it('prunes notes by their latest update timestamp', async () => {
    const service = await createService();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000);
    await service.add({
      scope: globalScope,
      title: 'Expired',
      content: 'Remove this note',
    });
    now.mockReturnValueOnce(2_000);
    const retained = await service.add({
      scope: globalScope,
      title: 'Retained',
      content: 'Keep this note',
    });
    now.mockReturnValue(3_000);

    expect(await service.pruneOlderThan(1_500)).toBe(1);
    expect(await service.read(retained.id, [globalScope])).not.toBeNull();
    expect(await service.getStats()).toMatchObject({
      total: 1,
      byScope: {
        global: 1,
        workspace: 0,
        agent: 0,
      },
    });
  });
});
