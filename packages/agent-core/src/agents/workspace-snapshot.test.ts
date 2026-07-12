import { describe, expect, it } from 'vitest';
import { createAgentTaskSnapshotManifest } from './execution-target';
import {
  createWorkspaceEnvironmentFingerprint,
  createWorkspaceSnapshot,
  hashWorkspaceDependencyFingerprint,
  hashWorkspaceDirtyPatch,
  hashWorkspaceIdentity,
  hashWorkspaceIgnorePolicy,
  normalizeWorkspaceDependencyFingerprintContent,
  type WorkspaceSnapshotEntry,
  type WorkspaceSnapshotMount,
} from './workspace-snapshot';

const entries: WorkspaceSnapshotEntry[] = [
  {
    mountPrefix: 'repo',
    relativePath: 'src/a.ts',
    kind: 'file',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
  },
  {
    mountPrefix: 'repo',
    relativePath: 'src/z.ts',
    kind: 'file',
    sizeBytes: 7,
    sha256: 'b'.repeat(64),
  },
];

const mounts: WorkspaceSnapshotMount[] = [
  {
    mountPrefix: 'repo',
    workspaceIdHash: hashWorkspaceIdentity('/private/repository/path'),
    repositoryId: 'repository-1',
    worktreeId: 'worktree-main',
    repositoryRevision: 'abc123',
    dirtyPatchHash: hashWorkspaceDirtyPatch('diff --git a/a b/a\n'),
    dependencyFingerprintHash: hashWorkspaceDependencyFingerprint([]),
    ignorePolicyHash: hashWorkspaceIgnorePolicy('node_modules\n.env\n'),
  },
];

const environment = {
  os: 'darwin',
  arch: 'arm64',
  shell: '/bin/zsh',
  toolchains: {
    node: '26.0.0',
    pnpm: '10.0.0',
  },
};

describe('WorkspaceSnapshot contract', () => {
  it('produces the same identity regardless of input order or capture time', () => {
    const first = createWorkspaceSnapshot({
      createdAt: 10,
      selection: 'mounted-workspaces',
      entries,
      mounts,
      environment,
    });
    const second = createWorkspaceSnapshot({
      createdAt: 20,
      selection: 'mounted-workspaces',
      entries: [...entries].reverse(),
      mounts: [...mounts].reverse(),
      environment: {
        ...environment,
        toolchains: {
          pnpm: '10.0.0',
          node: '26.0.0',
        },
      },
    });

    expect(second.snapshotHash).toBe(first.snapshotHash);
    expect(second.environment.fingerprintHash).toBe(
      first.environment.fingerprintHash,
    );
    expect(second.entries).toEqual(first.entries);
  });

  it('changes identity for file, dirty patch, dependency, ignore policy, or environment changes', () => {
    const baseline = createWorkspaceSnapshot({
      selection: 'explicit',
      entries,
      mounts,
      environment,
    });
    const variants = [
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries: [{ ...entries[0]!, sha256: 'c'.repeat(64) }, entries[1]!],
        mounts,
        environment,
      }),
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries,
        mounts: [
          {
            ...mounts[0]!,
            dirtyPatchHash: hashWorkspaceDirtyPatch('different patch'),
          },
        ],
        environment,
      }),
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries,
        mounts: [
          {
            ...mounts[0]!,
            dependencyFingerprintHash: hashWorkspaceDependencyFingerprint([
              {
                relativePath: 'package.json',
                sizeBytes: 2,
                sha256: 'd'.repeat(64),
              },
            ]),
          },
        ],
        environment,
      }),
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries,
        mounts: [
          {
            ...mounts[0]!,
            ignorePolicyHash: hashWorkspaceIgnorePolicy('different policy'),
          },
        ],
        environment,
      }),
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries,
        mounts,
        environment: { ...environment, arch: 'x64' },
      }),
    ];

    for (const variant of variants) {
      expect(variant.snapshotHash).not.toBe(baseline.snapshotHash);
    }
  });

  it('gives Teleporter manifests and execution consumers one canonical hash', () => {
    const canonical = createWorkspaceSnapshot({
      createdAt: 10,
      selection: 'mounted-workspaces',
      entries,
      mounts,
      environment,
    });
    const teleporterManifest = createAgentTaskSnapshotManifest({
      taskId: 'teleporter-task',
      createdAt: 10,
      selection: 'mounted-workspaces',
      entries,
      mounts,
      environment,
    });
    const executionManifest = createAgentTaskSnapshotManifest({
      taskId: 'runner-job',
      createdAt: 99,
      selection: 'mounted-workspaces',
      entries: [...entries].reverse(),
      mounts,
      environment,
    });

    expect(teleporterManifest.snapshotHash).toBe(canonical.snapshotHash);
    expect(executionManifest.snapshotHash).toBe(canonical.snapshotHash);
    expect(executionManifest.taskId).not.toBe(teleporterManifest.taskId);
  });

  it('rejects traversal, unknown mounts, duplicate files, and malformed hashes', () => {
    expect(() =>
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries: [{ ...entries[0]!, relativePath: '../secret' }],
        mounts,
        environment,
      }),
    ).toThrow('normalized relative path');
    expect(() =>
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries: [{ ...entries[0]!, mountPrefix: 'other' }],
        mounts,
        environment,
      }),
    ).toThrow('unknown mount');
    expect(() =>
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries: [entries[0]!, entries[0]!],
        mounts,
        environment,
      }),
    ).toThrow('Duplicate snapshot entry');
    expect(() =>
      createWorkspaceSnapshot({
        selection: 'explicit',
        entries: [{ ...entries[0]!, sha256: 'invalid' }],
        mounts,
        environment,
      }),
    ).toThrow('SHA-256');
  });

  it('does not expose raw workspace paths in the canonical contract', () => {
    const snapshot = createWorkspaceSnapshot({
      selection: 'explicit',
      entries,
      mounts,
      environment,
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private/repository/path');
    expect(snapshot.mounts[0]!.workspaceIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createWorkspaceEnvironmentFingerprint(environment).fingerprintHash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('removes volatile pnpm metadata from dependency fingerprints', () => {
    const first = normalizeWorkspaceDependencyFingerprintContent(
      'node_modules/.modules.yaml',
      Buffer.from(
        JSON.stringify({
          layoutVersion: 5,
          prunedAt: 'Sat, 11 Jul 2026 22:37:57 GMT',
          storeDir: '/private/tmp/store-a',
          virtualStoreDir: '.pnpm',
        }),
      ),
    );
    const second = normalizeWorkspaceDependencyFingerprintContent(
      'node_modules/.modules.yaml',
      Buffer.from(
        JSON.stringify({
          layoutVersion: 5,
          prunedAt: 'Sat, 11 Jul 2026 22:38:30 GMT',
          storeDir: '/different/machine/store-b',
          virtualStoreDir: '.pnpm',
        }),
      ),
    );

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).toString('utf8')).not.toContain('prunedAt');
    expect(Buffer.from(first).toString('utf8')).not.toContain('storeDir');
  });
});
