import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  isEncryptionAvailable: vi.fn<() => boolean>(),
  encryptString: vi.fn<(value: string) => Buffer>(),
  decryptString: vi.fn<(value: Buffer) => string>(),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}));

vi.mock('./paths', () => ({
  getJsonPath: (name: string) => `${mocks.root}/${name}.json`,
}));

import {
  readPersistedData,
  readPersistedDataSync,
  writePersistedData,
  writePersistedDataSync,
} from './persisted-data';

const storeSchema = z.record(z.string(), z.record(z.string(), z.string()));
const storedCredentials = {
  'figma-pat': {
    token: 'top-secret-token',
  },
};
const strictEncryption = {
  encrypt: true,
  requireEncryption: true,
} as const;
const migrationEncryption = {
  ...strictEncryption,
  allowPlaintextMigration: true,
} as const;

function encryptForTest(value: string): Buffer {
  return Buffer.from(`cipher:${value}`, 'utf-8');
}

function decryptForTest(value: Buffer): string {
  const encoded = value.toString('utf-8');
  if (!encoded.startsWith('cipher:')) throw new Error('invalid ciphertext');
  return encoded.slice('cipher:'.length);
}

function getStorePath(): string {
  return path.join(mocks.root, 'credentials.json');
}

async function readEnvelope(): Promise<{
  $clodex: string;
  version: number;
  ciphertext: string;
}> {
  return JSON.parse(await fs.readFile(getStorePath(), 'utf-8'));
}

beforeEach(async () => {
  mocks.root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'clodex-persisted-data-'),
  );
  mocks.isEncryptionAvailable.mockReset();
  mocks.encryptString.mockReset();
  mocks.decryptString.mockReset();
  mocks.isEncryptionAvailable.mockReturnValue(true);
  mocks.encryptString.mockImplementation(encryptForTest);
  mocks.decryptString.mockImplementation(decryptForTest);
});

afterEach(async () => {
  await fs.rm(mocks.root, { recursive: true, force: true });
});

describe('encrypted persisted data', () => {
  it('writes a versioned envelope with owner-only permissions', async () => {
    await writePersistedData(
      'credentials',
      storeSchema,
      storedCredentials,
      strictEncryption,
    );

    const raw = await fs.readFile(getStorePath(), 'utf-8');
    const envelope = JSON.parse(raw);
    const stat = await fs.stat(getStorePath());
    const directoryEntries = await fs.readdir(mocks.root);

    expect(raw).not.toContain(storedCredentials['figma-pat'].token);
    expect(envelope).toMatchObject({
      $clodex: 'clodex.safe-storage',
      version: 1,
    });
    expect(envelope.ciphertext).toEqual(expect.any(String));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(directoryEntries).toEqual(['credentials.json']);
  });

  it('round-trips encrypted data', async () => {
    await writePersistedData(
      'credentials',
      storeSchema,
      storedCredentials,
      strictEncryption,
    );

    await expect(
      readPersistedData('credentials', storeSchema, {}, strictEncryption),
    ).resolves.toEqual(storedCredentials);
  });

  it('fails closed without an available OS keychain', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(false);

    await expect(
      writePersistedData(
        'credentials',
        storeSchema,
        storedCredentials,
        strictEncryption,
      ),
    ).rejects.toThrow('OS-backed encryption is unavailable');

    await expect(fs.access(getStorePath())).rejects.toThrow();
  });

  it('does not overwrite existing data when encryption fails', async () => {
    await writePersistedData(
      'credentials',
      storeSchema,
      storedCredentials,
      strictEncryption,
    );
    const original = await fs.readFile(getStorePath());
    mocks.encryptString.mockImplementation(() => {
      throw new Error('keychain failure');
    });

    await expect(
      writePersistedData(
        'credentials',
        storeSchema,
        { 'figma-pat': { token: 'replacement' } },
        strictEncryption,
      ),
    ).rejects.toThrow('keychain failure');

    await expect(fs.readFile(getStorePath())).resolves.toEqual(original);
  });

  it('propagates keychain unavailability while reading encrypted data', async () => {
    await writePersistedData(
      'credentials',
      storeSchema,
      storedCredentials,
      strictEncryption,
    );
    mocks.isEncryptionAvailable.mockReturnValue(false);

    await expect(
      readPersistedData('credentials', storeSchema, {}, strictEncryption),
    ).rejects.toThrow('OS-backed encryption is unavailable');
  });

  it('rejects corrupted ciphertext instead of treating it as plaintext', async () => {
    const corruptedEnvelope = {
      $clodex: 'clodex.safe-storage',
      version: 1,
      ciphertext: Buffer.from('not-safe-storage-data').toString('base64'),
    };
    await fs.writeFile(getStorePath(), JSON.stringify(corruptedEnvelope));

    await expect(
      readPersistedData('credentials', storeSchema, {}, migrationEncryption),
    ).rejects.toThrow('invalid ciphertext');
  });

  it('upgrades legacy raw safeStorage ciphertext', async () => {
    const legacyCiphertext = encryptForTest(JSON.stringify(storedCredentials));
    await fs.writeFile(getStorePath(), legacyCiphertext);

    await expect(
      readPersistedData('credentials', storeSchema, {}, migrationEncryption),
    ).resolves.toEqual(storedCredentials);

    await expect(readEnvelope()).resolves.toMatchObject({
      $clodex: 'clodex.safe-storage',
      version: 1,
    });
  });

  it('migrates schema-valid legacy plaintext when explicitly enabled', async () => {
    await fs.writeFile(getStorePath(), JSON.stringify(storedCredentials));

    await expect(
      readPersistedData('credentials', storeSchema, {}, migrationEncryption),
    ).resolves.toEqual(storedCredentials);

    const raw = await fs.readFile(getStorePath(), 'utf-8');
    expect(raw).not.toContain(storedCredentials['figma-pat'].token);
    await expect(readEnvelope()).resolves.toMatchObject({
      $clodex: 'clodex.safe-storage',
      version: 1,
    });
  });

  it('rejects legacy plaintext when migration is not enabled', async () => {
    await fs.writeFile(getStorePath(), JSON.stringify(storedCredentials));

    await expect(
      readPersistedData('credentials', storeSchema, {}, strictEncryption),
    ).rejects.toThrow('invalid ciphertext');
  });

  it('returns the default for a missing file without requiring a keychain', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(false);

    await expect(
      readPersistedData(
        'credentials',
        storeSchema,
        storedCredentials,
        strictEncryption,
      ),
    ).resolves.toEqual(storedCredentials);
  });

  it('supports the same strict envelope format in sync callers', () => {
    writePersistedDataSync(
      'credentials',
      storeSchema,
      storedCredentials,
      strictEncryption,
    );

    expect(
      readPersistedDataSync('credentials', storeSchema, {}, strictEncryption),
    ).toEqual(storedCredentials);
  });
});

describe('unencrypted persisted data', () => {
  it('keeps schema validation and default-value behavior', async () => {
    await writePersistedData('credentials', storeSchema, storedCredentials);

    await expect(
      readPersistedData('credentials', storeSchema, {}),
    ).resolves.toEqual(storedCredentials);
    expect(mocks.encryptString).not.toHaveBeenCalled();

    await fs.writeFile(getStorePath(), 'invalid-json');
    await expect(
      readPersistedData('credentials', storeSchema, storedCredentials),
    ).resolves.toEqual(storedCredentials);
  });
});
