import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSystemCloudTaskArtifactStore } from '../agent-host';
import { CloudTaskArtifactService } from './cloud-task-artifacts';
import type { KartonService } from './karton';

const electron = vi.hoisted(() => ({
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
  showSaveDialog: vi.fn(async () => ({ canceled: true })),
}));

vi.mock('electron', () => ({
  shell: {
    openPath: electron.openPath,
    showItemInFolder: electron.showItemInFolder,
  },
  dialog: {
    showSaveDialog: electron.showSaveDialog,
  },
}));

describe('CloudTaskArtifactService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves renderer ids through the store before opening a file', async () => {
    const { service, store } = createService();

    await expect(
      service.open({
        executionId: 'execution-1',
        artifactId: 'artifact-1',
      }),
    ).resolves.toEqual({ ok: true });

    expect(store.resolve).toHaveBeenCalledWith('execution-1', 'artifact-1');
    expect(electron.openPath).toHaveBeenCalledWith('/safe/result.txt');
  });

  it('does not expose a raw renderer path and treats export cancellation as non-error', async () => {
    const audit = vi.fn();
    const { service } = createService(audit);

    await expect(
      service.export({
        executionId: 'execution-1',
        artifactId: 'artifact-1',
      }),
    ).resolves.toEqual({
      ok: false,
      cancelled: true,
      error: 'Export cancelled',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'artifact-export',
        success: true,
      }),
    );
  });
});

function createService(audit = vi.fn()) {
  const handlers = new Map<string, unknown>();
  const karton = {
    registerServerProcedureHandler: vi.fn((name: string, handler: unknown) => {
      handlers.set(name, handler);
    }),
    removeServerProcedureHandler: vi.fn(),
  } as unknown as KartonService;
  const store = {
    residency: 'us',
    resolve: vi.fn(async () => ({
      version: 1,
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      fileName: 'result.txt',
      mediaType: 'text/plain',
      sizeBytes: 4,
      sha256: 'a'.repeat(64),
      downloadedAt: 1_000_000,
      localPath: '/safe/result.txt',
    })),
  } as unknown as FileSystemCloudTaskArtifactStore;
  return {
    service: CloudTaskArtifactService.create({
      karton,
      store,
      audit,
      now: () => 1_000_000,
    }),
    store,
    handlers,
  };
}
