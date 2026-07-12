import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAgentTaskSnapshotSelectionFromMessages } from '@clodex/agent-core/agents';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudTaskSnapshotError,
  FileSystemCloudTaskSnapshotPackager,
  type CloudTaskSnapshotCryptoProvider,
} from './cloud-task-snapshot-packager';

const DATA_KEY = Buffer.alloc(32, 7);
const NONCE = Buffer.alloc(12, 9);
const SIGNING_KEY = Buffer.alloc(32, 11);

const cryptoProvider: CloudTaskSnapshotCryptoProvider = {
  async wrapDataKey({ dataKey }) {
    return {
      algorithm: 'test-raw',
      keyId: 'test-wrap-key',
      value: Buffer.from(dataKey).toString('base64url'),
    };
  },
  async signManifest({ canonicalManifest }) {
    return {
      algorithm: 'hmac-sha256',
      keyId: 'test-signing-key',
      value: createHmac('sha256', SIGNING_KEY)
        .update(canonicalManifest)
        .digest('base64url'),
    };
  },
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileSystemCloudTaskSnapshotPackager', () => {
  it('packages a deterministic explicit selection, excludes secrets and encrypts locally', async () => {
    const { root, staging } = await createWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, '.env'), 'TOKEN=secret');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'bad');
    await writeFile(path.join(root, 'src', 'z.ts'), 'export const z = 2;');
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
    await symlink(
      path.join(root, 'src', 'a.ts'),
      path.join(root, 'src', 'link.ts'),
    );

    const packager = createPackager(root, staging);
    const prepared = await packager.prepare({
      taskId: 'task-1',
      agentInstanceId: 'agent-1',
      selection: rootSelection(),
    });

    expect(
      prepared.descriptor.manifest.entries.map((entry) => entry.relativePath),
    ).toEqual(['.gitignore', 'src/a.ts', 'src/z.ts']);
    expect(prepared.descriptor.manifest.totalBytes).toBe(
      Buffer.byteLength('ignored.txt\n') +
        Buffer.byteLength('export const a = 1;') +
        Buffer.byteLength('export const z = 2;'),
    );
    expect(prepared.descriptor.archive.format).toBe('clodex-snapshot-v1');
    expect(prepared.descriptor.archive.sha256).toMatch(/^[a-f0-9]{64}$/);

    const ciphertext = await readFile(prepared.descriptor.archive.path);
    expect(ciphertext.includes(Buffer.from('export const a = 1;'))).toBe(false);
    const plaintext = decryptArchive(
      ciphertext,
      prepared.descriptor.encryption.nonce,
      prepared.descriptor.encryption.authTag,
      'task-1',
    );
    expect(plaintext.subarray(0, 12).toString('binary')).toBe(
      'CLODEXSNAP\0\x01',
    );
    expect(plaintext.includes(Buffer.from('export const a = 1;'))).toBe(true);
    expect(plaintext.includes(Buffer.from('TOKEN=secret'))).toBe(false);
    expect(plaintext.includes(Buffer.from('MANIFEST\0'))).toBe(true);

    const expectedSignature = createHmac('sha256', SIGNING_KEY)
      .update(Buffer.from(JSON.stringify(prepared.descriptor.manifest), 'utf8'))
      .digest('base64url');
    expect(prepared.descriptor.signature.value).toBe(expectedSignature);

    const archivePath = prepared.descriptor.archive.path;
    await prepared.cleanup();
    await prepared.cleanup();
    await expect(access(archivePath)).rejects.toThrow();
  });

  it('captures the complete mounted workspace for session teleport instead of the latest path references', async () => {
    const { root, staging } = await createWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'src', 'button.tsx'),
      'export const b = 1;',
    );
    await writeFile(
      path.join(root, 'src', 'global.css'),
      ':root { --gap: 8px; }',
    );
    await writeFile(
      path.join(root, 'src', 'types.ts'),
      'export interface ButtonProps {}',
    );

    const selection = resolveAgentTaskSnapshotSelectionFromMessages([
      {
        role: 'user',
        metadata: {
          pathReferences: {
            'repo/src/button.tsx': createHash('sha256')
              .update('export const b = 1;')
              .digest('hex'),
          },
          cloudHandoffScope: 'session-workspaces',
        },
      },
    ]);
    const prepared = await createPackager(root, staging).prepare({
      taskId: 'session-teleport',
      agentInstanceId: 'agent-1',
      selection,
    });

    expect(prepared.descriptor.manifest.selection).toBe('mounted-workspaces');
    expect(
      prepared.descriptor.manifest.entries.map((entry) => entry.relativePath),
    ).toEqual(['src/button.tsx', 'src/global.css', 'src/types.ts']);

    await prepared.cleanup();
  });

  it('rejects ignored, secret, protected-mount and symlink selections', async () => {
    const { root, staging } = await createWorkspace();
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored');
    await writeFile(path.join(root, '.env.local'), 'secret');
    await writeFile(path.join(root, 'target.txt'), 'ok');
    const protectedEnvelope = Buffer.from(
      'clodex-protected:v1:\0encrypted-payload',
      'utf8',
    );
    await writeFile(path.join(root, 'protected.bin'), protectedEnvelope);
    await symlink(
      path.join(root, 'target.txt'),
      path.join(root, 'selected-link.txt'),
    );
    const packager = createPackager(root, staging);

    await expect(
      packager.prepare({
        taskId: 'ignored',
        agentInstanceId: 'agent-1',
        selection: fileSelection('ignored.txt', 'a'.repeat(64)),
      }),
    ).rejects.toMatchObject({ reason: 'ignored-path' });
    await expect(
      packager.prepare({
        taskId: 'secret',
        agentInstanceId: 'agent-1',
        selection: fileSelection('.env.local', 'a'.repeat(64)),
      }),
    ).rejects.toMatchObject({ reason: 'secret-path' });
    await expect(
      packager.prepare({
        taskId: 'protected',
        agentInstanceId: 'agent-1',
        selection: {
          version: 1,
          mode: 'explicit',
          entries: [
            {
              mountPrefix: 'att',
              relativePath: 'secret.txt',
              expectedSha256: 'a'.repeat(64),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ reason: 'protected-path' });
    await expect(
      packager.prepare({
        taskId: 'symlink',
        agentInstanceId: 'agent-1',
        selection: fileSelection('selected-link.txt', 'a'.repeat(64)),
      }),
    ).rejects.toMatchObject({ reason: 'symlink' });
    await expect(
      packager.prepare({
        taskId: 'protected-envelope',
        agentInstanceId: 'agent-1',
        selection: fileSelection(
          'protected.bin',
          createHash('sha256').update(protectedEnvelope).digest('hex'),
        ),
      }),
    ).rejects.toMatchObject({ reason: 'protected-path' });
  });

  it('rejects stale direct file hashes and enforces quotas', async () => {
    const { root, staging } = await createWorkspace();
    await writeFile(path.join(root, 'large.txt'), '12345');
    const packager = createPackager(root, staging, {
      maxFileBytes: 4,
    });

    await expect(
      packager.prepare({
        taskId: 'quota',
        agentInstanceId: 'agent-1',
        selection: fileSelection(
          'large.txt',
          createHash('sha256').update('12345').digest('hex'),
        ),
      }),
    ).rejects.toMatchObject({ reason: 'quota-exceeded' });

    const stalePackager = createPackager(root, staging);
    await expect(
      stalePackager.prepare({
        taskId: 'stale',
        agentInstanceId: 'agent-1',
        selection: fileSelection('large.txt', 'a'.repeat(64)),
      }),
    ).rejects.toMatchObject({ reason: 'stale-file' });
  });

  it('cancels before staging and reports an empty selection explicitly', async () => {
    const { root, staging } = await createWorkspace();
    const packager = createPackager(root, staging);
    const controller = new AbortController();
    controller.abort();

    await expect(
      packager.prepare({
        taskId: 'cancelled',
        agentInstanceId: 'agent-1',
        selection: rootSelection(),
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: 'aborted' });
    await expect(access(staging)).rejects.toThrow();

    await expect(
      packager.prepare({
        taskId: 'empty',
        agentInstanceId: 'agent-1',
        selection: { version: 1, mode: 'explicit', entries: [] },
      }),
    ).rejects.toBeInstanceOf(CloudTaskSnapshotError);
  });
});

async function createWorkspace(): Promise<{ root: string; staging: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'clodex-snapshot-test-'));
  temporaryDirectories.push(parent);
  const root = path.join(parent, 'workspace');
  await mkdir(root, { recursive: true });
  return {
    root,
    staging: path.join(parent, 'staging'),
  };
}

function createPackager(
  root: string,
  staging: string,
  limits: { maxFileBytes?: number } = {},
): FileSystemCloudTaskSnapshotPackager {
  return new FileSystemCloudTaskSnapshotPackager({
    resolveMounts: async () => [{ prefix: 'repo', path: root }],
    cryptoProvider,
    stagingRoot: staging,
    now: () => 123,
    randomBytes: (size) => {
      if (size === DATA_KEY.byteLength) return Buffer.from(DATA_KEY);
      if (size === NONCE.byteLength) return Buffer.from(NONCE);
      throw new Error(`Unexpected random byte request: ${size}`);
    },
    ...limits,
  });
}

function rootSelection() {
  return {
    version: 1 as const,
    mode: 'explicit' as const,
    entries: [
      {
        mountPrefix: 'repo',
        relativePath: '',
        expectedSha256: 'a'.repeat(64),
      },
    ],
  };
}

function fileSelection(relativePath: string, expectedSha256: string) {
  return {
    version: 1 as const,
    mode: 'explicit' as const,
    entries: [
      {
        mountPrefix: 'repo',
        relativePath,
        expectedSha256,
      },
    ],
  };
}

function decryptArchive(
  ciphertext: Buffer,
  nonce: string,
  authTag: string,
  taskId: string,
): Buffer {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    DATA_KEY,
    Buffer.from(nonce, 'base64url'),
  );
  decipher.setAAD(Buffer.from(`clodex.cloud-snapshot.v1\0${taskId}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
