import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkspaceSnapshotEntry } from '@clodex/agent-core/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalWorkspaceSnapshotMetadata } from './workspace-snapshot-builder';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local WorkspaceSnapshot builder', () => {
  it('captures opaque git/worktree identities and changes dirty state deterministically', async () => {
    const root = await createRepository();
    const beforeEntry = await entryFor(root, 'src/config.ts');
    const before = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [beforeEntry],
      selection: 'explicit',
    });

    await writeFile(
      path.join(root, 'src/config.ts'),
      'export const mode = "remote";\n',
    );
    const afterEntry = await entryFor(root, 'src/config.ts');
    const after = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [afterEntry],
      selection: 'explicit',
    });

    expect(before.mounts[0]).toEqual(
      expect.objectContaining({
        mountPrefix: 'repo',
        repositoryRevision: expect.stringMatching(/^[a-f0-9]{40,64}$/),
        workspaceIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        repositoryId: expect.stringMatching(/^[a-f0-9]{64}$/),
        worktreeId: expect.stringMatching(/^[a-f0-9]{64}$/),
        dirtyPatchHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyFingerprintHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        ignorePolicyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(after.mounts[0]!.dirtyPatchHash).not.toBe(
      before.mounts[0]!.dirtyPatchHash,
    );
    expect(JSON.stringify(after.mounts)).not.toContain(root);
  });

  it('ignores unrelated dirty files for explicit snapshots but includes them for mounted snapshots', async () => {
    const root = await createRepository();
    const selectedEntry = await entryFor(root, 'src/config.ts');
    const baseline = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [selectedEntry],
      selection: 'explicit',
    });
    await writeFile(path.join(root, 'unrelated.txt'), 'untracked\n');

    const explicit = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [selectedEntry],
      selection: 'explicit',
    });
    const mounted = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [selectedEntry],
      selection: 'mounted-workspaces',
    });

    expect(explicit.mounts[0]!.dirtyPatchHash).toBe(
      baseline.mounts[0]!.dirtyPatchHash,
    );
    expect(mounted.mounts[0]!.dirtyPatchHash).not.toBe(
      baseline.mounts[0]!.dirtyPatchHash,
    );
  });

  it('materializes tracked and untracked bytes and changes identity when either changes', async () => {
    const root = await createRepository();
    await writeFile(path.join(root, 'src/config.ts'), 'tracked change one\n');
    const untrackedPath = path.join(root, 'scripts/check.sh');
    await mkdir(path.dirname(untrackedPath), { recursive: true });
    await writeFile(untrackedPath, '#!/bin/sh\necho one\n');
    await chmod(untrackedPath, 0o755);

    const first = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [],
      selection: 'mounted-workspaces',
      includeMaterialization: true,
    });
    expect(first.mounts[0]).toMatchObject({
      hasDirtyChanges: true,
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archiveHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        totalBytes: expect.any(Number),
      },
    });

    await writeFile(untrackedPath, '#!/bin/sh\necho two\n');
    const untrackedChanged = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [],
      selection: 'mounted-workspaces',
    });
    expect(untrackedChanged.mounts[0]!.dirtyPatchHash).not.toBe(
      first.mounts[0]!.dirtyPatchHash,
    );

    await writeFile(path.join(root, 'src/config.ts'), 'tracked change two\n');
    const trackedChanged = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'repo', path: root }],
      entries: [],
      selection: 'mounted-workspaces',
    });
    expect(trackedChanged.mounts[0]!.dirtyPatchHash).not.toBe(
      untrackedChanged.mounts[0]!.dirtyPatchHash,
    );
  });

  it('fingerprints manifests, lockfiles, and installed dependency metadata only', async () => {
    const root = await createRepository();
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"fixture","scripts":{"test":"vitest"}}\n',
    );
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await git(root, ['add', 'package.json', 'pnpm-lock.yaml']);
    await git(root, ['commit', '-m', 'dependency fixture']);

    const capture = async () =>
      (
        await buildLocalWorkspaceSnapshotMetadata({
          mounts: [{ prefix: 'repo', path: root }],
          entries: [],
          selection: 'mounted-workspaces',
        })
      ).mounts[0]!.dependencyFingerprintHash;

    const baseline = await capture();
    await writeFile(
      path.join(root, 'src/config.ts'),
      'export const mode = "unrelated";\n',
    );
    expect(await capture()).toBe(baseline);

    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"fixture","scripts":{"test":"vitest run"}}\n',
    );
    const manifestChanged = await capture();
    expect(manifestChanged).not.toBe(baseline);

    await writeFile(
      path.join(root, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.1\n',
    );
    const lockChanged = await capture();
    expect(lockChanged).not.toBe(manifestChanged);

    await mkdir(path.join(root, 'node_modules/.pnpm'), { recursive: true });
    await writeFile(
      path.join(root, 'node_modules/.modules.yaml'),
      'layoutVersion: 5\n',
    );
    await writeFile(
      path.join(root, 'node_modules/.pnpm/lock.yaml'),
      'lockfileVersion: 9.1\n',
    );
    const metadataAdded = await capture();
    expect(metadataAdded).not.toBe(lockChanged);

    await writeFile(
      path.join(root, 'node_modules/.modules.yaml'),
      'layoutVersion: 6\n',
    );
    expect(await capture()).not.toBe(metadataAdded);
  });

  it('fails closed for untracked symbolic links', async () => {
    const root = await createRepository();
    await symlink(
      path.join(root, 'src/config.ts'),
      path.join(root, 'config-link.ts'),
    );

    await expect(
      buildLocalWorkspaceSnapshotMetadata({
        mounts: [{ prefix: 'repo', path: root }],
        entries: [],
        selection: 'mounted-workspaces',
        includeMaterialization: true,
      }),
    ).rejects.toThrow(/only regular files/i);
  });

  it.each([
    '.clodex',
  ])('rejects untracked protected paths under %s', async (protectedDirectory) => {
    const root = await createRepository();
    await mkdir(path.join(root, protectedDirectory), { recursive: true });
    await writeFile(
      path.join(root, protectedDirectory, 'secret.json'),
      'sensitive\n',
    );

    await expect(
      buildLocalWorkspaceSnapshotMetadata({
        mounts: [{ prefix: 'repo', path: root }],
        entries: [],
        selection: 'mounted-workspaces',
        includeMaterialization: true,
      }),
    ).rejects.toThrow('rejected protected untracked path');
  });

  it('rejects tracked changes under protected paths', async () => {
    const root = await createRepository();
    await mkdir(path.join(root, '.clodex'), { recursive: true });
    await writeFile(path.join(root, '.clodex', 'state.json'), 'before\n');
    await git(root, ['add', '-f', '.clodex/state.json']);
    await git(root, ['commit', '-m', 'tracked protected fixture']);
    await writeFile(path.join(root, '.clodex', 'state.json'), 'after\n');

    await expect(
      buildLocalWorkspaceSnapshotMetadata({
        mounts: [{ prefix: 'repo', path: root }],
        entries: [],
        selection: 'mounted-workspaces',
        includeMaterialization: true,
      }),
    ).rejects.toThrow('rejected protected tracked path');
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `workspace-snapshot-${randomUUID()}-`),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
  await writeFile(
    path.join(root, 'src/config.ts'),
    'export const mode = "local";\n',
  );
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'snapshot@example.test']);
  await git(root, ['config', 'user.name', 'Snapshot Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

async function entryFor(
  root: string,
  relativePath: string,
): Promise<WorkspaceSnapshotEntry> {
  const content = await readFile(path.join(root, relativePath));
  return {
    mountPrefix: 'repo',
    relativePath,
    kind: 'file',
    sizeBytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
