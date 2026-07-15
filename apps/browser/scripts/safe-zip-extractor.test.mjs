import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractVerifiedZipArchive,
  safePortableArchivePath,
  validateReviewedMaterializedSymlinks,
} from './safe-zip-extractor.mjs';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = (3 << 8) | ZIP_VERSION;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '', 'utf8');
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(ZIP_UNIX_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function archiveEntries(...entries) {
  return [{ name: 'fixture-root/', mode: 0o040755 }, ...entries];
}

async function withExtraction(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-safe-zip-test.'));
  const destination = path.join(root, 'extracted');
  try {
    return await run({ destination, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

async function expectRejected(entries, pattern, overrides = {}) {
  await withExtraction(async ({ destination }) => {
    await assert.rejects(
      extractVerifiedZipArchive({
        allowedSymlinks: [],
        archiveBytes: zipFixture(entries),
        archiveRoot: 'fixture-root',
        destination,
        ...overrides,
      }),
      pattern,
    );
  });
}

test('verified ZIP extraction materializes only the exact reviewed symlink set', async () => {
  await withExtraction(async ({ destination }) => {
    const report = await extractVerifiedZipArchive({
      allowedSymlinks: [
        { path: 'client/src/shared', target: '../../$shared/' },
      ],
      archiveBytes: zipFixture(
        archiveEntries(
          { name: 'fixture-root/$shared/', mode: 0o040755 },
          {
            name: 'fixture-root/$shared/value.txt',
            data: 'verified bytes\n',
          },
          { name: 'fixture-root/client/', mode: 0o040755 },
          { name: 'fixture-root/client/src/', mode: 0o040755 },
          {
            name: 'fixture-root/client/src/shared',
            data: '../../$shared/',
            mode: 0o120777,
          },
        ),
      ),
      archiveRoot: 'fixture-root',
      destination,
    });
    const materializedPath = path.join(
      destination,
      'client/src/shared/value.txt',
    );
    assert.equal(readFileSync(materializedPath, 'utf8'), 'verified bytes\n');
    assert.equal(
      lstatSync(path.dirname(materializedPath)).isSymbolicLink(),
      false,
    );
    assert.deepEqual(report.materializedSymlinks, [
      { path: 'client/src/shared', target: '../../$shared/' },
    ]);
  });
});

test('portable ZIP paths reject traversal and Windows alias forms', async (t) => {
  for (const unsafePath of [
    '../escape',
    'dir\\escape',
    'dir/file:stream',
    'dir/file.',
    'dir/file ',
    'dir/NUL.txt',
    'dir/COM1',
    'dir/LPT¹.log',
    'dir/CON .txt',
    'dir/control\u0001name',
  ]) {
    assert.throws(
      () => safePortableArchivePath(unsafePath),
      /Unsafe|portable/u,
    );
  }
  await t.test(
    'archive traversal cannot write outside extraction root',
    async () => {
      await withExtraction(async ({ destination, root }) => {
        await assert.rejects(
          extractVerifiedZipArchive({
            allowedSymlinks: [],
            archiveBytes: zipFixture(
              archiveEntries({
                name: 'fixture-root/../escape.txt',
                data: 'escape',
              }),
            ),
            archiveRoot: 'fixture-root',
            destination,
          }),
          /Unsafe archive path|invalid relative path/u,
        );
        assert.throws(
          () => lstatSync(path.join(root, 'escape.txt')),
          /ENOENT/u,
        );
      });
    },
  );
});

test('verified ZIP extraction rejects duplicate, case, and parent-child collisions', async (t) => {
  assert.throws(
    () =>
      validateReviewedMaterializedSymlinks([
        { path: 'client/Link', target: '../target/' },
        { path: 'client/link', target: '../target/' },
      ]),
    /duplicate or case-colliding/u,
  );
  assert.throws(
    () =>
      validateReviewedMaterializedSymlinks([
        { path: 'dir/link', target: '../target/' },
        { path: 'dir/link/child', target: '../../target/' },
      ]),
    /parent\/child path collision/u,
  );
  await t.test('duplicate entry', () =>
    expectRejected(
      archiveEntries(
        { name: 'fixture-root/file.txt', data: 'one' },
        { name: 'fixture-root/file.txt', data: 'two' },
      ),
      /duplicate or case-colliding/u,
    ),
  );
  await t.test('case-colliding entry', () =>
    expectRejected(
      archiveEntries(
        { name: 'fixture-root/File.txt', data: 'one' },
        { name: 'fixture-root/file.txt', data: 'two' },
      ),
      /duplicate or case-colliding/u,
    ),
  );
  await t.test('file used as parent directory', () =>
    expectRejected(
      archiveEntries(
        { name: 'fixture-root/parent', data: 'one' },
        { name: 'fixture-root/parent/child.txt', data: 'two' },
      ),
      /parent\/child path collision/u,
    ),
  );
});

test('verified ZIP extraction rejects unreviewed, escaping, and malformed symlinks', async (t) => {
  await t.test('unexpected symlink', () =>
    expectRejected(
      archiveEntries(
        { name: 'fixture-root/$shared/', mode: 0o040755 },
        {
          name: 'fixture-root/link',
          data: '$shared/',
          mode: 0o120777,
        },
      ),
      /symlink set changed/u,
    ),
  );
  await t.test('escaping symlink target', () =>
    expectRejected(
      archiveEntries({
        name: 'fixture-root/link',
        data: '../../outside/',
        mode: 0o120777,
      }),
      /escapes the verified root/u,
    ),
  );
  await t.test('invalid UTF-8 symlink target', () =>
    expectRejected(
      archiveEntries({
        name: 'fixture-root/link',
        data: Buffer.from([0xff]),
        mode: 0o120777,
      }),
      /encoded data|encoding/u,
    ),
  );
});

test('verified ZIP extraction rejects special entries and resource-limit overflow', async (t) => {
  await t.test('special filesystem entry', () =>
    expectRejected(
      archiveEntries({
        name: 'fixture-root/socket',
        mode: 0o140777,
      }),
      /unsupported special entry/u,
    ),
  );
  await t.test('entry-count overflow', () =>
    expectRejected(
      archiveEntries({ name: 'fixture-root/file.txt', data: 'one' }),
      /too many entries/u,
      { maximumArchiveEntries: 1 },
    ),
  );
  await t.test('extracted-byte overflow', () =>
    expectRejected(
      archiveEntries({ name: 'fixture-root/file.txt', data: 'three' }),
      /unsafe extracted size|extracted byte limit/u,
      { maximumExtractedBytes: 2 },
    ),
  );
});
