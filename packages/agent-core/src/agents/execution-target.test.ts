import { describe, expect, it } from 'vitest';
import {
  createAgentExecutionTaskRecord,
  createAgentTaskSnapshotManifest,
  resolveAgentExecutionTargetFromMessages,
  resolveAgentTaskSnapshotSelectionFromMessages,
  transitionAgentExecutionTask,
} from './execution-target';

describe('agent execution target contracts', () => {
  it('supports the declared execution task lifecycle', () => {
    const queued = createAgentExecutionTaskRecord({
      id: 'task-1',
      target: 'cloud',
      now: 1,
    });
    const preparing = transitionAgentExecutionTask(queued, 'preparing', {
      now: 2,
    });
    const running = transitionAgentExecutionTask(preparing, 'running', {
      now: 3,
    });
    const suspended = transitionAgentExecutionTask(running, 'suspended', {
      now: 4,
    });
    const resumed = transitionAgentExecutionTask(suspended, 'running', {
      now: 5,
    });
    const completed = transitionAgentExecutionTask(resumed, 'completed', {
      now: 6,
    });

    expect(completed).toMatchObject({
      status: 'completed',
      startedAt: 3,
      finishedAt: 6,
      failureReason: null,
    });
  });

  it('rejects invalid transitions and records bounded failure reasons', () => {
    const queued = createAgentExecutionTaskRecord({
      id: 'task-1',
      target: 'local',
      now: 1,
    });
    expect(() =>
      transitionAgentExecutionTask(queued, 'completed', { now: 2 }),
    ).toThrow('queued -> completed');

    const failed = transitionAgentExecutionTask(queued, 'failed', {
      now: 2,
      failureReason: 'x'.repeat(200),
    });
    expect(failed.failureReason).toHaveLength(120);
    expect(() =>
      transitionAgentExecutionTask(failed, 'running', { now: 3 }),
    ).toThrow('failed -> running');
  });

  it('selects the target from the latest user turn and defaults to local', () => {
    expect(resolveAgentExecutionTargetFromMessages([])).toBe('local');
    expect(
      resolveAgentExecutionTargetFromMessages([
        { role: 'user', metadata: { executionTarget: 'cloud' } },
        { role: 'assistant' },
      ]),
    ).toBe('cloud');
    expect(
      resolveAgentExecutionTargetFromMessages([
        { role: 'user', metadata: { executionTarget: 'cloud' } },
        { role: 'user', metadata: { executionTarget: 'invalid' } },
      ]),
    ).toBe('local');
  });

  it('builds only explicit deterministic bounded snapshot manifests', () => {
    const manifest = createAgentTaskSnapshotManifest({
      taskId: 'task-1',
      createdAt: 10,
      entries: [
        {
          mountPrefix: 'repo',
          relativePath: 'src/z.ts',
          kind: 'file',
          sizeBytes: 7,
          sha256: 'b'.repeat(64),
        },
        {
          mountPrefix: 'repo',
          relativePath: 'src/a.ts',
          kind: 'file',
          sizeBytes: 5,
          sha256: 'a'.repeat(64),
        },
      ],
    });

    expect(manifest).toMatchObject({
      version: 1,
      selection: 'explicit',
      totalBytes: 12,
    });
    expect(manifest.entries.map((entry) => entry.relativePath)).toEqual([
      'src/a.ts',
      'src/z.ts',
    ]);
  });

  it('derives a deterministic explicit snapshot selection from the latest user turn', () => {
    const selection = resolveAgentTaskSnapshotSelectionFromMessages([
      {
        role: 'user',
        metadata: {
          pathReferences: {
            'repo/src/z.ts': 'b'.repeat(64),
          },
        },
      },
      { role: 'assistant' },
      {
        role: 'user',
        metadata: {
          pathReferences: {
            '/repo/src/z.ts': 'b'.repeat(64),
            repo: 'c'.repeat(64),
            'repo/src/a.ts': 'a'.repeat(64),
            '../secret': 'd'.repeat(64),
            'repo\\windows': 'e'.repeat(64),
            'repo/invalid': 'not-a-hash',
          },
        },
      },
    ]);

    expect(selection).toEqual({
      version: 1,
      mode: 'explicit',
      entries: [
        {
          mountPrefix: 'repo',
          relativePath: '',
          expectedSha256: 'c'.repeat(64),
        },
        {
          mountPrefix: 'repo',
          relativePath: 'src/a.ts',
          expectedSha256: 'a'.repeat(64),
        },
        {
          mountPrefix: 'repo',
          relativePath: 'src/z.ts',
          expectedSha256: 'b'.repeat(64),
        },
      ],
    });
  });

  it('uses every mounted workspace for a session handoff regardless of path references', () => {
    const selection = resolveAgentTaskSnapshotSelectionFromMessages([
      {
        role: 'user',
        metadata: {
          pathReferences: {
            'repo/src/only-latest-reference.ts': 'a'.repeat(64),
          },
          cloudHandoffScope: 'session-workspaces',
        },
      },
    ]);

    expect(selection).toEqual({
      version: 1,
      mode: 'mounted-workspaces',
      entries: [],
    });
  });

  it('rejects traversal, duplicate paths, invalid hashes and byte overflow', () => {
    const valid = {
      mountPrefix: 'repo',
      relativePath: 'src/a.ts',
      kind: 'file' as const,
      sizeBytes: 5,
      sha256: 'a'.repeat(64),
    };
    expect(() =>
      createAgentTaskSnapshotManifest({
        taskId: 'task-1',
        entries: [{ ...valid, relativePath: '../secret' }],
      }),
    ).toThrow('normalized relative path');
    expect(() =>
      createAgentTaskSnapshotManifest({
        taskId: 'task-1',
        entries: [{ ...valid, relativePath: './secret' }],
      }),
    ).toThrow('normalized relative path');
    expect(() =>
      createAgentTaskSnapshotManifest({
        taskId: 'task-1',
        entries: [valid, valid],
      }),
    ).toThrow('Duplicate snapshot entry');
    expect(() =>
      createAgentTaskSnapshotManifest({
        taskId: 'task-1',
        entries: [{ ...valid, sha256: 'not-a-hash' }],
      }),
    ).toThrow('SHA-256');
    expect(() =>
      createAgentTaskSnapshotManifest({
        taskId: 'task-1',
        entries: [valid],
        maxTotalBytes: 4,
      }),
    ).toThrow('byte limit');
  });
});
