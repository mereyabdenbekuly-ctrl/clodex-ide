import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExecutionArtifactManifest,
  createExecutionArtifactManifest,
  hashExecutionArtifactManifest,
  type ExecutionArtifactManifest,
} from './execution-artifact-manifest';
import { captureLocalWorkspaceArtifactState } from './workspace-artifact-state';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ExecutionArtifactManifest', () => {
  it('records created, modified, and deleted files relative to command start', async () => {
    const root = await createRepository();
    const before = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
    });

    await writeFile(
      path.join(root, 'src/config.ts'),
      'export const mode = 2;\n',
    );
    await writeFile(path.join(root, 'result.json'), '{"ok":true}\n');
    const afterCreate = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
      includeEntries: before.entries,
    });
    const created = createExecutionArtifactManifest({
      snapshotHash: 'a'.repeat(64),
      before,
      after: afterCreate,
    });

    expect(created.entries).toEqual([
      expect.objectContaining({
        relativePath: 'result.json',
        change: 'created',
        sha256: createHash('sha256').update('{"ok":true}\n').digest('hex'),
      }),
      expect.objectContaining({
        relativePath: 'src/config.ts',
        change: 'modified',
      }),
    ]);
    expect(hashExecutionArtifactManifest(created)).toMatch(/^[a-f0-9]{64}$/);

    const beforeDelete = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
    });
    await rm(path.join(root, 'result.json'));
    const afterDelete = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
      includeEntries: beforeDelete.entries,
    });
    const deleted = createExecutionArtifactManifest({
      snapshotHash: 'a'.repeat(64),
      before: beforeDelete,
      after: afterDelete,
    });
    expect(deleted.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'result.json',
          change: 'deleted',
          sha256: null,
        }),
      ]),
    );
  });

  it('does not report an unchanged dirty file as a command artifact', async () => {
    const root = await createRepository();
    await writeFile(path.join(root, 'src/config.ts'), 'dirty before command\n');
    const before = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
    });
    const after = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
      includeEntries: before.entries,
    });

    expect(
      createExecutionArtifactManifest({
        snapshotHash: 'b'.repeat(64),
        before,
        after,
      }).entries,
    ).toEqual([]);
  });

  it('records both sides of a tracked rename without relying on Git rename heuristics', async () => {
    const root = await createRepository();
    const before = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
    });
    await git(root, ['mv', 'src/config.ts', 'src/renamed.ts']);
    const after = await captureLocalWorkspaceArtifactState({
      workspaceRoot: root,
      includeEntries: before.entries,
    });

    expect(
      createExecutionArtifactManifest({
        snapshotHash: 'c'.repeat(64),
        before,
        after,
      }).entries,
    ).toEqual([
      expect.objectContaining({
        relativePath: 'src/config.ts',
        change: 'deleted',
      }),
      expect.objectContaining({
        relativePath: 'src/renamed.ts',
        change: 'modified',
      }),
    ]);
  });

  it('marks omitted evidence as truncated and rejects non-canonical manifests', () => {
    const manifest = createExecutionArtifactManifest({
      snapshotHash: 'd'.repeat(64),
      before: { entries: [], truncated: false },
      after: {
        entries: [
          {
            relativePath: 'large.bin',
            tracked: false,
            kind: 'file',
            sizeBytes: 128 * 1024 * 1024,
            mode: 0o644,
            sha256: null,
            modifiedAtMs: 1,
            omissionReason: 'size-limit',
          },
        ],
        truncated: false,
      },
    });

    expect(manifest.truncated).toBe(true);
    expect(() =>
      assertExecutionArtifactManifest({
        ...manifest,
        entries: [
          ...manifest.entries,
          {
            ...manifest.entries[0]!,
            relativePath: 'a.bin',
          },
        ],
      }),
    ).toThrow('unique and sorted');
    expect(() =>
      hashExecutionArtifactManifest({
        ...manifest,
        unexpected: true,
      } as ExecutionArtifactManifest),
    ).toThrow('invalid');
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `artifact-manifest-${randomUUID()}-`),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/config.ts'), 'export const mode = 1;\n');
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'artifact@example.test']);
  await git(root, ['config', 'user.name', 'Artifact Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
