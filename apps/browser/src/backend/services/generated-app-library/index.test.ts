import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/services/logger';
import { createGeneratedAppKey } from '@shared/generated-apps';
import { GeneratedAppLibraryService } from './index';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

describe('GeneratedAppLibraryService', () => {
  let root: string;
  let agentsDir: string;
  let now: number;
  let persisted: unknown;
  let openPreview: ReturnType<typeof vi.fn>;
  let regenerateOwnerApp: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-app-library-'));
    agentsDir = path.join(root, 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    now = Date.parse('2026-07-10T12:00:00.000Z');
    persisted = { version: 1, apps: {} };
    openPreview = vi.fn(async () => undefined);
    regenerateOwnerApp = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeApp(
    agentId: string,
    appId: string,
    html?: string,
  ): Promise<string> {
    const appDir = path.join(agentsDir, agentId, 'apps', appId);
    await fs.mkdir(appDir, { recursive: true });
    if (html !== undefined) {
      await fs.writeFile(path.join(appDir, 'index.html'), html);
    }
    await fs.writeFile(path.join(appDir, 'styles.css'), 'body { margin: 0 }');
    return appDir;
  }

  function createService() {
    return GeneratedAppLibraryService.create({
      logger,
      agentsDir,
      now: () => now,
      loadStore: async () => structuredClone(persisted),
      saveStore: async (store) => {
        persisted = structuredClone(store);
      },
      getOwnerSnapshots: async (agentIds) =>
        new Map(
          agentIds.map((agentId) => [
            agentId,
            {
              taskTitle: `Task ${agentId}`,
              workspacePath: `/workspace/${agentId}`,
            },
          ]),
        ),
      openPreview,
      regenerateOwnerApp,
    });
  }

  it('discovers agent-owned apps and derives HTML metadata and file stats', async () => {
    await writeApp(
      'agent-a',
      'revenue-dashboard',
      [
        '<!doctype html>',
        '<html><head>',
        '<title>Revenue &amp; Forecast</title>',
        '<meta content="Track ARR and runway" name="description">',
        '</head><body></body></html>',
      ].join(''),
    );

    const result = await createService().listGeneratedApps();

    expect(result.summary).toEqual({
      total: 1,
      ready: 1,
      needsAttention: 0,
      regenerating: 0,
    });
    expect(result.apps[0]).toMatchObject({
      key: createGeneratedAppKey('agent-a', 'revenue-dashboard'),
      appId: 'revenue-dashboard',
      title: 'Revenue & Forecast',
      description: 'Track ARR and runway',
      status: 'ready',
      fileCount: 2,
      owner: {
        kind: 'agent',
        agentId: 'agent-a',
        taskTitle: 'Task agent-a',
        workspacePath: '/workspace/agent-a',
      },
    });
    expect(result.apps[0]?.previewUrl).toContain(
      'clodex://internal/preview/revenue-dashboard?agentId=agent-a',
    );
  });

  it('classifies invalid and externally removed apps without losing metadata', async () => {
    const appDir = await writeApp('agent-a', 'broken-app');
    const service = createService();

    const broken = await service.listGeneratedApps();
    expect(broken.apps[0]).toMatchObject({
      title: 'Broken app',
      status: 'broken',
      error: 'index.html is missing.',
    });

    await fs.rm(appDir, { recursive: true, force: true });
    const missing = await service.listGeneratedApps();
    expect(missing.apps[0]).toMatchObject({
      title: 'Broken app',
      status: 'missing',
      error: 'The generated app directory is missing.',
    });
  });

  it('launches only runnable apps and persists last-opened metadata', async () => {
    await writeApp(
      'agent-a',
      'ready-app',
      '<html><head><title>Ready app</title></head></html>',
    );
    const service = createService();
    const key = createGeneratedAppKey('agent-a', 'ready-app');

    const result = await service.launchGeneratedApp(key);

    expect(result.ok).toBe(true);
    expect(openPreview).toHaveBeenCalledTimes(1);
    if (!result.ok) return;
    expect(result.app.lastOpenedAt).toBe('2026-07-10T12:00:00.000Z');
    expect(
      (
        persisted as {
          apps: Record<string, { lastOpenedAt: string | null }>;
        }
      ).apps[key]?.lastOpenedAt,
    ).toBe('2026-07-10T12:00:00.000Z');
  });

  it('requests non-destructive regeneration through the owner task', async () => {
    await writeApp(
      'agent-a',
      'ready-app',
      '<html><head><title>Ready app</title></head></html>',
    );
    const service = createService();
    const key = createGeneratedAppKey('agent-a', 'ready-app');

    const result = await service.regenerateGeneratedApp(key);

    expect(result).toMatchObject({
      ok: true,
      app: {
        key,
        status: 'regenerating',
      },
    });
    expect(regenerateOwnerApp).toHaveBeenCalledWith({
      agentId: 'agent-a',
      appId: 'ready-app',
      title: 'Ready app',
    });
    expect(
      await fs.readFile(
        path.join(agentsDir, 'agent-a', 'apps', 'ready-app', 'index.html'),
        'utf8',
      ),
    ).toContain('<title>Ready app</title>');
  });

  it('deletes only the selected app directory and removes its metadata', async () => {
    const appDir = await writeApp(
      'agent-a',
      'delete-me',
      '<html><head><title>Delete me</title></head></html>',
    );
    const siblingDir = await writeApp(
      'agent-a',
      'keep-me',
      '<html><head><title>Keep me</title></head></html>',
    );
    const service = createService();
    await service.listGeneratedApps();
    const key = createGeneratedAppKey('agent-a', 'delete-me');

    const result = await service.deleteGeneratedApp(key);

    expect(result.ok).toBe(true);
    await expect(fs.stat(appDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(siblingDir)).resolves.toBeDefined();
    expect(
      (persisted as { apps: Record<string, unknown> }).apps[key],
    ).toBeUndefined();
  });

  it('ignores symlinked agent directories outside the data root', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(outside, 'apps', 'escape'), { recursive: true });
    await fs.writeFile(
      path.join(outside, 'apps', 'escape', 'index.html'),
      '<title>Escape</title>',
    );
    await fs.symlink(outside, path.join(agentsDir, 'linked-agent'));

    const result = await createService().listGeneratedApps();

    expect(result.apps).toEqual([]);
  });
});
