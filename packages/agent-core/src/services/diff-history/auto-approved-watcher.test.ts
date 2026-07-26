import { describe, expect, it, vi } from 'vitest';
import { DiffHistoryService } from './index';

type WatcherState =
  | { kind: 'text'; content: string }
  | { kind: 'external' }
  | { kind: 'missing' };

interface WatcherExpectationHarness {
  token: string;
  agentContent: string;
  suppressedContent: string;
  phase: 'preparing' | 'committed';
  userSaveRecorded: boolean;
  temporaryWatch: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
}

interface WatcherServiceHarness {
  autoApprovedWatcherExpectations: Map<string, WatcherExpectationHarness>;
  autoApprovedWatcherToken: number;
  currentlyWatchedFiles: Set<string>;
  ensureWatched: ReturnType<typeof vi.fn>;
  captureCurrentWatcherState: ReturnType<typeof vi.fn>;
  persistUserSaveState: ReturnType<typeof vi.fn>;
  updateAgentsAffectedByFilepath: ReturnType<typeof vi.fn>;
  unwatchResolvedFiles: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
  beginAutoApprovedWriteWatcher(
    filepath: string,
    expectedContent: string,
  ): string;
  reconcileAutoApprovedWriteWatcher(
    filepath: string,
    token: string,
    expectedContent: string,
  ): Promise<'exact' | 'reconciled' | 'failed'>;
  cancelAutoApprovedWriteWatcher(
    filepath: string,
    token: string,
  ): Promise<void>;
  handleExpectedAutoApprovedWatcherChange(filepath: string): Promise<boolean>;
}

function createHarness(states: WatcherState[]): WatcherServiceHarness {
  const service = Object.create(
    DiffHistoryService.prototype,
  ) as WatcherServiceHarness;
  service.autoApprovedWatcherExpectations = new Map();
  service.autoApprovedWatcherToken = 0;
  service.currentlyWatchedFiles = new Set();
  service.ensureWatched = vi.fn();
  service.captureCurrentWatcherState = vi.fn(async () => {
    const state = states.shift();
    if (!state) throw new Error('Missing watcher state fixture');
    return state;
  });
  service.persistUserSaveState = vi.fn(async () => {});
  service.updateAgentsAffectedByFilepath = vi.fn(async () => {});
  service.unwatchResolvedFiles = vi.fn(async () => {});
  service.logError = vi.fn();
  return service;
}

describe('content-aware automatic edit watcher', () => {
  it('suppresses exact agent bytes after durable reconciliation', async () => {
    const filepath = '/workspace/file.ts';
    const service = createHarness([
      { kind: 'text', content: 'agent' },
      { kind: 'text', content: 'agent' },
    ]);
    const token = service.beginAutoApprovedWriteWatcher(filepath, 'agent');

    await expect(
      service.reconcileAutoApprovedWriteWatcher(filepath, token, 'agent'),
    ).resolves.toBe('exact');
    await expect(
      service.handleExpectedAutoApprovedWatcherChange(filepath),
    ).resolves.toBe(true);

    expect(service.persistUserSaveState).not.toHaveBeenCalled();
    await service.cancelAutoApprovedWriteWatcher(filepath, token);
  });

  it('records a pre-commit user save exactly once after evidence commits', async () => {
    const filepath = '/workspace/file.ts';
    const userState = { kind: 'text', content: 'user' } as const;
    const service = createHarness([userState, userState, userState]);
    const token = service.beginAutoApprovedWriteWatcher(filepath, 'agent');

    await service.handleExpectedAutoApprovedWatcherChange(filepath);
    expect(service.persistUserSaveState).not.toHaveBeenCalled();

    await expect(
      service.reconcileAutoApprovedWriteWatcher(filepath, token, 'agent'),
    ).resolves.toBe('reconciled');
    await service.handleExpectedAutoApprovedWatcherChange(filepath);

    expect(service.persistUserSaveState).toHaveBeenCalledTimes(1);
    expect(service.persistUserSaveState).toHaveBeenCalledWith(
      filepath,
      userState,
    );
    await service.cancelAutoApprovedWriteWatcher(filepath, token);
  });

  it('records a concurrent unlink and rejects content drift for the token', async () => {
    const filepath = '/workspace/file.ts';
    const service = createHarness([{ kind: 'missing' }]);
    const token = service.beginAutoApprovedWriteWatcher(filepath, 'agent');

    await expect(
      service.reconcileAutoApprovedWriteWatcher(filepath, token, 'different'),
    ).resolves.toBe('failed');
    expect(service.persistUserSaveState).not.toHaveBeenCalled();

    await expect(
      service.reconcileAutoApprovedWriteWatcher(filepath, token, 'agent'),
    ).resolves.toBe('reconciled');
    expect(service.persistUserSaveState).toHaveBeenCalledWith(filepath, {
      kind: 'missing',
    });
    await service.cancelAutoApprovedWriteWatcher(filepath, token);
  });
});
