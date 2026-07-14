import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AeadDataProtection,
  isDataProtectionEnvelopeString,
} from '@clodex/agent-core/host';

const pathMock = vi.hoisted(() => ({ dbPath: '' }));
vi.mock('@/utils/paths', () => ({
  getDbPath: () => pathMock.dbPath,
}));

import { migrateAssetCacheRowsAtStartup } from './index';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('AssetCache protected migration', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-cache-protected-'));
    pathMock.dbPath = path.join(root, 'asset-cache.sqlite');
  });

  afterEach(async () => {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 100,
    });
  });

  it('encrypts legacy presigned URLs and authenticates existing rows', async () => {
    const legacyUrl =
      'https://private-bucket.example/object?X-Amz-Signature=secret-value';
    const client = createClient({ url: `file:${pathMock.dbPath}` });
    await client.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE asset_cache (
        file_hash TEXT PRIMARY KEY,
        read_url TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_asset_cache_expires ON asset_cache(expires_at);
    `);
    await client.execute({
      sql: 'INSERT INTO asset_cache(file_hash, read_url, expires_at) VALUES (?, ?, ?)',
      args: ['a'.repeat(64), legacyUrl, 4_102_444_800],
    });
    client.close();

    const protection = new AeadDataProtection(randomBytes(32));
    await expect(
      migrateAssetCacheRowsAtStartup(protection, logger),
    ).resolves.toBe(1);

    const verify = createClient({ url: `file:${pathMock.dbPath}` });
    const result = await verify.execute(
      'SELECT read_url FROM asset_cache LIMIT 1',
    );
    const stored = String(result.rows[0]?.read_url);
    verify.close();
    expect(stored).not.toContain(legacyUrl);
    expect(isDataProtectionEnvelopeString(stored)).toBe(true);

    await expect(
      migrateAssetCacheRowsAtStartup(protection, logger),
    ).resolves.toBe(0);
    await expect(
      migrateAssetCacheRowsAtStartup(
        new AeadDataProtection(randomBytes(32)),
        logger,
      ),
    ).rejects.toThrow('key does not match');
  });
});
