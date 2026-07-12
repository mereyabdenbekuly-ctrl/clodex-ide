import { vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryNotesExport } from '@clodex/agent-core/memory-notes';
import type { MemoryNotesRetention } from '@shared/memory-notes';
import type { KartonService } from './karton';
import type { Logger } from './logger';
import { MemoryNotesSettingsService } from './memory-notes-settings';

type Handler = (clientId: string, ...args: never[]) => Promise<unknown>;

const services: MemoryNotesSettingsService[] = [];

function createHarness({
  enabled = true,
  retention = 'forever' as MemoryNotesRetention,
}: {
  enabled?: boolean;
  retention?: MemoryNotesRetention;
} = {}) {
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const karton = {
    registerServerProcedureHandler(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    removeServerProcedureHandler(name: string) {
      removed.push(name);
      handlers.delete(name);
    },
  } as unknown as KartonService;
  let currentRetention = retention;
  const preferences = {
    get: vi.fn(() => ({
      memoryNotes: {
        retention: currentRetention,
      },
    })),
    update: vi.fn(async (patches: Array<{ value?: unknown }>) => {
      currentRetention = patches[0]?.value as MemoryNotesRetention;
    }),
  };
  const exported: MemoryNotesExport = {
    format: 'clodex-memory-notes',
    version: 1,
    exportedAt: 1_700_000_000_000,
    scope: 'workspace',
    notes: [],
  };
  const memoryNotes = {
    getStats: vi.fn(async () => ({
      total: 3,
      byScope: { global: 1, workspace: 1, agent: 1 },
      oldestCreatedAt: 1_000,
      newestUpdatedAt: 2_000,
    })),
    exportNotes: vi.fn(async () => exported),
    clear: vi.fn(async () => 2),
    pruneOlderThan: vi.fn(async () => 4),
  };
  const saveExport = vi.fn(async () => ({
    canceled: false,
    filePath: '/tmp/memory-notes.json',
  }));
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  return {
    handlers,
    removed,
    karton,
    preferences,
    memoryNotes,
    saveExport,
    logger,
    enabled,
  };
}

async function createService(harness: ReturnType<typeof createHarness>) {
  const service = await MemoryNotesSettingsService.create({
    logger: harness.logger,
    karton: harness.karton,
    preferences: harness.preferences as never,
    memoryNotes: harness.memoryNotes,
    isFeatureEnabled: () => harness.enabled,
    saveExport: harness.saveExport,
    now: () => 10_000_000_000,
  });
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) {
    service.teardown();
  }
  vi.restoreAllMocks();
});

describe('MemoryNotesSettingsService', () => {
  it('updates retention and immediately prunes expired notes', async () => {
    const harness = createHarness();
    await createService(harness);

    const result = await harness.handlers.get('memoryNotes.setRetention')!(
      'client',
      '30-days' as never,
    );

    expect(harness.preferences.update).toHaveBeenCalledWith([
      {
        op: 'replace',
        path: ['memoryNotes', 'retention'],
        value: '30-days',
      },
    ]);
    expect(harness.memoryNotes.pruneOlderThan).toHaveBeenCalledWith(
      10_000_000_000 - 30 * 24 * 60 * 60 * 1_000,
    );
    expect(result).toEqual({
      retention: '30-days',
      deleted: 4,
    });
  });

  it('exports and resets only the selected scope type', async () => {
    const harness = createHarness();
    await createService(harness);

    const exportResult = await harness.handlers.get(
      'memoryNotes.exportToFile',
    )!('client', 'workspace' as never);
    const resetResult = await harness.handlers.get('memoryNotes.reset')!(
      'client',
      'agent' as never,
    );

    expect(harness.memoryNotes.exportNotes).toHaveBeenCalledWith({
      scope: 'workspace',
    });
    expect(harness.saveExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'clodex-memory-notes' }),
      'workspace',
    );
    expect(exportResult).toEqual({
      canceled: false,
      count: 0,
      filePath: '/tmp/memory-notes.json',
    });
    expect(harness.memoryNotes.clear).toHaveBeenCalledWith({
      scope: 'agent',
    });
    expect(resetResult).toEqual({
      scope: 'agent',
      deleted: 2,
    });
  });

  it('rechecks the preview gate for every settings operation', async () => {
    const harness = createHarness({ enabled: false });
    await createService(harness);

    await expect(
      harness.handlers.get('memoryNotes.getStats')!('client'),
    ).rejects.toThrow('preview feature is disabled');
    await expect(
      harness.handlers.get('memoryNotes.reset')!('client', 'all' as never),
    ).rejects.toThrow('preview feature is disabled');
    expect(harness.memoryNotes.clear).not.toHaveBeenCalled();
  });

  it('applies an existing retention policy during startup', async () => {
    const harness = createHarness({ retention: '90-days' });
    await createService(harness);

    expect(harness.memoryNotes.pruneOlderThan).toHaveBeenCalledWith(
      10_000_000_000 - 90 * 24 * 60 * 60 * 1_000,
    );
  });
});
