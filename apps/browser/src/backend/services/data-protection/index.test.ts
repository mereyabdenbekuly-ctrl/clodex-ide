import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPersistedData: vi.fn(),
  writePersistedData: vi.fn(),
}));

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: mocks.readPersistedData,
  writePersistedData: mocks.writePersistedData,
}));

import { createBrowserDataProtection } from '.';
import type { Logger } from '../logger';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writePersistedData.mockResolvedValue(undefined);
});

describe('createBrowserDataProtection', () => {
  it('unlocks an existing safeStorage-wrapped key', async () => {
    mocks.readPersistedData.mockResolvedValue({
      version: 1,
      key: randomBytes(32).toString('base64'),
    });

    const protection = await createBrowserDataProtection(logger, {
      platform: 'linux',
    });
    const protectedValue = protection.protectString('secret', 'test/context');

    expect(protection.unprotectString(protectedValue, 'test/context')).toBe(
      'secret',
    );
    expect(mocks.writePersistedData).not.toHaveBeenCalled();
  });

  it('generates and persists a new key with strict encryption', async () => {
    mocks.readPersistedData.mockResolvedValue(null);

    const protection = await createBrowserDataProtection(logger, {
      platform: 'linux',
    });

    expect(mocks.writePersistedData).toHaveBeenCalledOnce();
    expect(mocks.writePersistedData.mock.calls[0]?.[0]).toBe(
      'data-protection-key',
    );
    expect(mocks.writePersistedData.mock.calls[0]?.[2]).toMatchObject({
      version: 1,
      key: expect.any(String),
    });
    expect(mocks.writePersistedData.mock.calls[0]?.[3]).toEqual({
      encrypt: true,
      requireEncryption: true,
    });

    const value = protection.protectString('secret', 'test/context');
    expect(protection.unprotectString(value, 'test/context')).toBe('secret');
  });

  it('reuses a direct macOS Keychain key when safeStorage has no key file', async () => {
    const keychainKey = randomBytes(32);
    mocks.readPersistedData.mockResolvedValue(null);

    const protection = await createBrowserDataProtection(logger, {
      platform: 'darwin',
      bundleId: 'xyz.clodex.agentic-ide.test',
      readMacOSKeychainKey: vi.fn().mockResolvedValue(keychainKey),
    });

    const protectedValue = protection.protectString('secret', 'test/context');
    expect(protection.unprotectString(protectedValue, 'test/context')).toBe(
      'secret',
    );
    expect(mocks.writePersistedData).not.toHaveBeenCalled();
  });

  it('creates a direct macOS Keychain key without probing safeStorage', async () => {
    const keychainKey = randomBytes(32);
    mocks.readPersistedData.mockResolvedValue(null);
    const createMacOSKeychainKey = vi.fn().mockResolvedValue(keychainKey);

    const protection = await createBrowserDataProtection(logger, {
      platform: 'darwin',
      bundleId: 'xyz.clodex.agentic-ide.test',
      readMacOSKeychainKey: vi.fn().mockResolvedValue(null),
      createMacOSKeychainKey,
    });

    expect(createMacOSKeychainKey).toHaveBeenCalledWith(
      'xyz.clodex.agentic-ide.test',
    );
    expect(mocks.writePersistedData).not.toHaveBeenCalled();
    const protectedValue = protection.protectString('secret', 'test/context');
    expect(protection.unprotectString(protectedValue, 'test/context')).toBe(
      'secret',
    );
  });

  it('fails closed for malformed key material', async () => {
    mocks.readPersistedData.mockResolvedValue({
      version: 1,
      key: Buffer.alloc(31).toString('base64'),
    });

    await expect(createBrowserDataProtection(logger)).rejects.toThrow(
      'exactly 32 bytes',
    );
  });

  it('propagates safeStorage read failures for an existing protected key', async () => {
    const error = new Error('OS-backed encryption is unavailable');
    mocks.readPersistedData.mockRejectedValue(error);

    await expect(
      createBrowserDataProtection(logger, { platform: 'darwin' }),
    ).rejects.toBe(error);
    expect(mocks.writePersistedData).not.toHaveBeenCalled();
  });
});
