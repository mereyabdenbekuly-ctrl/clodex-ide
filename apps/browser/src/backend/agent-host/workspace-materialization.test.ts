import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceMaterialization } from './workspace-materialization';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('workspace materialization', () => {
  it('builds an extractable archive with tracked patch and executable files', async () => {
    const trackedPatch = Buffer.from('binary patch bytes\n');
    const executable = Buffer.from('#!/bin/sh\necho ready\n');
    const materialization = createWorkspaceMaterialization({
      trackedPatch,
      untrackedFiles: [
        {
          relativePath: 'scripts/check.sh',
          mode: 0o755,
          content: executable,
        },
      ],
      includeArchive: true,
    });
    expect(materialization.archive).toBeDefined();
    expect(materialization.archiveHash).toBe(
      createHash('sha256').update(materialization.archive!).digest('hex'),
    );

    const extractionRoot = await mkdtemp(
      path.join(tmpdir(), `workspace-materialization-${randomUUID()}-`),
    );
    temporaryDirectories.push(extractionRoot);
    const archivePath = path.join(extractionRoot, 'snapshot.tar.gz');
    await writeFile(archivePath, materialization.archive!);
    await run('tar', ['-xzf', archivePath, '-C', extractionRoot]);

    await expect(
      readFile(path.join(extractionRoot, '.clodex/tracked.patch')),
    ).resolves.toEqual(trackedPatch);
    await expect(
      readFile(path.join(extractionRoot, 'workspace/scripts/check.sh')),
    ).resolves.toEqual(executable);
    expect(
      readArchiveEntryMode(
        materialization.archive!,
        'workspace/scripts/check.sh',
      ),
    ).toBe(0o755);
    if (process.platform !== 'win32') {
      expect(
        (await stat(path.join(extractionRoot, 'workspace/scripts/check.sh')))
          .mode & 0o777,
      ).toBe(0o755);
    }
  });

  it('hashes actual bytes and file mode deterministically', () => {
    const create = (content: string, mode = 0o644) =>
      createWorkspaceMaterialization({
        trackedPatch: Buffer.from('patch'),
        untrackedFiles: [
          {
            relativePath: 'config/value.txt',
            mode,
            content: Buffer.from(content),
          },
        ],
      }).dirtyPatchHash;

    expect(create('one')).toBe(create('one'));
    expect(create('two')).not.toBe(create('one'));
    expect(create('one', 0o755)).not.toBe(create('one'));
  });

  it.each([
    '../escape',
    '/absolute',
    'nested/../escape',
    'nested/./file',
    'line\nbreak',
    '.git/config',
    '.clodex/secret',
  ])('rejects unsafe archive path %s', (relativePath) => {
    expect(() =>
      createWorkspaceMaterialization({
        trackedPatch: Buffer.alloc(0),
        untrackedFiles: [
          { relativePath, mode: 0o644, content: Buffer.from('unsafe') },
        ],
        includeArchive: true,
      }),
    ).toThrow(/unsafe workspace materialization path/i);
  });
});

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readArchiveEntryMode(
  archive: Uint8Array,
  expectedPath: string,
): number | undefined {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const mode = Number.parseInt(readTarString(header, 100, 8), 8);
    const size = Number.parseInt(readTarString(header, 124, 12), 8);
    if (entryPath === expectedPath) return mode & 0o777;

    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function readTarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field
    .subarray(0, terminator >= 0 ? terminator : field.byteLength)
    .toString('utf8')
    .trim();
}
