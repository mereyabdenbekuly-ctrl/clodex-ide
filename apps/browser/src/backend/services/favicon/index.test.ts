import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  fetch: vi.fn(),
  userDataPath: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => electron.userDataPath },
  net: { fetch: electron.fetch },
}));

import type { Logger } from '../logger';
import { FaviconService } from '.';

describe('FaviconService network policy', () => {
  let root: string;
  let service: FaviconService | undefined;

  beforeEach(async () => {
    service = undefined;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-favicon-policy-'));
    electron.userDataPath = root;
    electron.fetch.mockReset();
    await fs.mkdir(path.join(root, 'clodex'), { recursive: true });
  });

  afterEach(async () => {
    service?.teardown();
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 100,
    });
  });

  it('stores a controlled-browser favicon mapping without a default-session fetch', async () => {
    service = await FaviconService.create({
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger);

    await service.storeFavicons(
      'https://page.example/',
      ['https://page.example/favicon.ico'],
      false,
    );

    expect(electron.fetch).not.toHaveBeenCalled();
    await expect(
      service.getFaviconForUrl('https://page.example/'),
    ).resolves.toBe('https://page.example/favicon.ico');
    await expect(
      service.getFaviconBitmap('https://page.example/favicon.ico'),
    ).resolves.toBeNull();
  });
});
