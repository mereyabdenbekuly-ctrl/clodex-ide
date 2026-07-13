import type { Logger } from '@/services/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  failAt: null as string | null,
  failure: new Error('migration failed'),
  dataProtection: { kind: 'data-protection' },
  protectedFiles: undefined as unknown,
  protectedMigrationOrder: undefined as unknown,
  hostPaths: { kind: 'host-paths' },
  attachments: undefined as unknown,
}));

async function recordMigration(stage: string, count: number): Promise<number> {
  state.calls.push(stage);
  if (state.failAt === stage) throw state.failure;
  return count;
}

vi.mock('@clodex/agent-core/host', () => ({
  ProtectedFileStorage: class MockProtectedFileStorage {
    public constructor(public readonly dataProtection: unknown) {
      state.calls.push('protected-files');
      state.protectedFiles = this;
    }
  },
}));

vi.mock('@clodex/agent-core/attachments', () => ({
  AttachmentsService: class MockAttachmentsService {
    public constructor(
      public readonly hostPaths: unknown,
      public readonly protectedFiles: unknown,
    ) {
      state.calls.push('attachments-service');
      state.attachments = this;
    }

    public migrateAllBlobs(): Promise<number> {
      return recordMigration('attachments', 1);
    }
  },
}));

vi.mock('@/services/data-protection', () => ({
  createBrowserDataProtection: async () => {
    state.calls.push('data-protection');
    return state.dataProtection;
  },
}));

vi.mock('@/services/agent-core-bridge/host-paths', () => ({
  createBrowserHostPaths: () => {
    state.calls.push('host-paths');
    return state.hostPaths;
  },
}));

vi.mock('@/services/protected-files/order', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/protected-files/order')>();

  return {
    ...actual,
    P1ProtectedMigrationOrder: class extends actual.P1ProtectedMigrationOrder {
      public constructor() {
        super();
        state.calls.push('migration-order');
        state.protectedMigrationOrder = this;
      }
    },
  };
});

vi.mock('@/services/agent-os/chronicle', () => ({
  migrateChronicleArtifacts: () => recordMigration('chronicle', 2),
}));

vi.mock('@/services/protected-files/migrations', () => ({
  migrateShellLogFiles: () => recordMigration('shell-logs', 3),
  migrateMemoryFiles: () => recordMigration('memory', 4),
  migrateDiffHistoryBlobs: () => recordMigration('diff-history-blobs', 5),
}));

vi.mock('@/services/asset-cache', () => ({
  migrateAssetCacheRowsAtStartup: () => recordMigration('asset-cache', 0),
}));

import { prepareProtectedStorage } from './prepare-protected-storage';

function createLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  return {
    logger: {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    info,
  };
}

describe('prepareProtectedStorage', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.failAt = null;
    state.protectedFiles = undefined;
    state.protectedMigrationOrder = undefined;
    state.attachments = undefined;
  });

  it('preserves startup order, result identities, and migration logging', async () => {
    const { logger, info } = createLogger();

    const result = await prepareProtectedStorage(logger);

    expect(state.calls).toEqual([
      'data-protection',
      'protected-files',
      'migration-order',
      'host-paths',
      'attachments-service',
      'attachments',
      'chronicle',
      'shell-logs',
      'memory',
      'diff-history-blobs',
      'asset-cache',
    ]);
    expect(result.dataProtection).toBe(state.dataProtection);
    expect(result.protectedFiles).toBe(state.protectedFiles);
    expect(result.protectedMigrationOrder).toBe(state.protectedMigrationOrder);
    expect(result.hostPaths).toBe(state.hostPaths);
    expect(result.attachments).toBe(state.attachments);
    expect(info.mock.calls).toEqual([
      ['[ProtectedFiles] Migrated 1 attachment blob(s)'],
      ['[ProtectedFiles] Migrated 2 Chronicle artifact(s)'],
      ['[ProtectedFiles] Migrated 3 shell log(s)'],
      ['[ProtectedFiles] Migrated 4 memory file(s)'],
      ['[ProtectedFiles] Migrated 5 diff-history blob(s)'],
    ]);

    result.protectedMigrationOrder.mark('caches');
    result.protectedMigrationOrder.mark('titles/search');
    expect(() => result.protectedMigrationOrder.assertComplete()).not.toThrow();
  });

  it('propagates migration failures without running later stages', async () => {
    const { logger } = createLogger();
    state.failAt = 'shell-logs';

    await expect(prepareProtectedStorage(logger)).rejects.toBe(state.failure);
    expect(state.calls).toEqual([
      'data-protection',
      'protected-files',
      'migration-order',
      'host-paths',
      'attachments-service',
      'attachments',
      'chronicle',
      'shell-logs',
    ]);
  });
});
