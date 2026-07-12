import { randomBytes } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AeadDataProtection } from './data-protection';
import {
  ProtectedAppendFileStorage,
  ProtectedFileStorage,
} from './protected-files';

describe('ProtectedFileStorage', () => {
  let root: string;
  let storage: ProtectedFileStorage;
  let filePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'protected-files-'));
    storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );
    filePath = path.join(root, 'payload.bin');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips empty and multi-chunk files without plaintext on disk', async () => {
    await storage.writeFile(filePath, Buffer.alloc(0), 'attachments/a/empty');
    expect(await storage.readFile(filePath, 'attachments/a/empty')).toEqual(
      Buffer.alloc(0),
    );

    const plaintext = Buffer.concat([
      Buffer.from('sensitive-prefix:'),
      randomBytes(12_000),
      Buffer.from(':sensitive-suffix'),
    ]);
    const result = await storage.writeFile(
      filePath,
      plaintext,
      'attachments/a/blob',
    );
    expect(result.chunks).toBeGreaterThan(1);
    expect(await storage.readFile(filePath, 'attachments/a/blob')).toEqual(
      plaintext,
    );
    expect(await storage.isProtectedFile(filePath)).toBe(true);
    const ciphertext = await readFile(filePath);
    expect(ciphertext.includes(Buffer.from('sensitive-prefix'))).toBe(false);
    expect(ciphertext.includes(Buffer.from('sensitive-suffix'))).toBe(false);
  });

  it('streams without returning the whole file as one chunk', async () => {
    const plaintext = randomBytes(20_000);
    await storage.writeFile(filePath, plaintext, 'stream/context');
    const chunks: Buffer[] = [];
    for await (const chunk of storage.readChunks(filePath, 'stream/context')) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    expect(
      Math.max(...chunks.map((chunk) => chunk.length)),
    ).toBeLessThanOrEqual(4096);
  });

  it('rejects wrong context, ciphertext tampering, truncation, and trailing data', async () => {
    await storage.writeFile(filePath, randomBytes(9000), 'correct/context');
    await expect(storage.readFile(filePath, 'wrong/context')).rejects.toThrow(
      'context does not match',
    );

    const original = await readFile(filePath);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)]! ^= 0x01;
    await writeFile(filePath, tampered);
    await expect(
      storage.readFile(filePath, 'correct/context'),
    ).rejects.toThrow();

    await writeFile(filePath, original);
    await truncate(filePath, original.length - 1);
    await expect(storage.readFile(filePath, 'correct/context')).rejects.toThrow(
      /truncated|authentication/i,
    );

    await writeFile(filePath, Buffer.concat([original, Buffer.from([1])]));
    await expect(storage.readFile(filePath, 'correct/context')).rejects.toThrow(
      'trailing data',
    );
  });

  it('migrates plaintext in place through atomic protected output', async () => {
    const plaintext = Buffer.from('legacy plaintext attachment');
    await writeFile(filePath, plaintext);
    await expect(
      storage.migrateFile(filePath, 'attachments/a/legacy'),
    ).resolves.toBe('migrated');
    expect(await readFile(filePath)).not.toEqual(plaintext);
    expect(await storage.readFile(filePath, 'attachments/a/legacy')).toEqual(
      plaintext,
    );
    await expect(
      storage.migrateFile(filePath, 'attachments/a/legacy'),
    ).resolves.toBe('already-protected');
    expect(
      (await readdir(root)).filter((name) => name.includes('staging')),
    ).toEqual([]);
  });

  it('uses distinct file identities and ciphertext for the same plaintext', async () => {
    const secondPath = path.join(root, 'payload-2.bin');
    const plaintext = Buffer.alloc(10_000, 0x41);
    await storage.writeFile(filePath, plaintext, 'same/context');
    await storage.writeFile(secondPath, plaintext, 'same/context');
    expect(await readFile(filePath)).not.toEqual(await readFile(secondPath));
    expect(await storage.readFile(filePath, 'same/context')).toEqual(plaintext);
    expect(await storage.readFile(secondPath, 'same/context')).toEqual(
      plaintext,
    );
  });

  it('appends through immutable protected segments and an atomic manifest', async () => {
    const append = new ProtectedAppendFileStorage(
      storage,
      filePath,
      'shell-logs/agent/session',
    );
    await Promise.all([
      append.append('first\n'),
      append.append('second\n'),
      append.append('third\n'),
    ]);
    await append.drain();
    expect((await append.readFile()).toString('utf-8')).toBe(
      'first\nsecond\nthird\n',
    );
    expect(await storage.isProtectedFile(filePath)).toBe(true);
    expect(await readFile(filePath, 'utf-8')).not.toContain('first');
    expect((await readdir(`${filePath}.segments`)).sort()).toEqual([
      '0.pf',
      '1.pf',
      '2.pf',
    ]);
  });
});
