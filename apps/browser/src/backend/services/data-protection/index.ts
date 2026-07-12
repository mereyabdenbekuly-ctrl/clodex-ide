import {
  AeadDataProtection,
  type DataProtection,
} from '@clodex/agent-core/host';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../logger';
import {
  readPersistedData,
  writePersistedData,
} from '../../utils/persisted-data';
import {
  createMacOSKeychainDataProtectionKey,
  readMacOSKeychainDataProtectionKey,
} from './macos-keychain';

const STORAGE_NAME = 'data-protection-key' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
} as const;
const KEY_LENGTH = 32;

const storedKeySchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1),
  })
  .strict()
  .nullable();

type StoredKey = Exclude<z.infer<typeof storedKeySchema>, null>;

export interface BrowserDataProtectionOptions {
  platform?: NodeJS.Platform;
  bundleId?: string;
  readMacOSKeychainKey?: (bundleId: string) => Promise<Buffer | null>;
  createMacOSKeychainKey?: (bundleId: string) => Promise<Buffer>;
}

/**
 * Loads the agent-persistence data key from Electron safeStorage, generating
 * it on first use. The raw AES key is never written to disk: persisted-data
 * wraps this record with the OS keychain and fails startup closed if that
 * protection is unavailable or corrupt.
 */
export async function createBrowserDataProtection(
  logger: Logger,
  options: BrowserDataProtectionOptions = {},
): Promise<DataProtection> {
  logger.debug('[DataProtection] Loading protected data key...');

  const platform = options.platform ?? process.platform;
  const bundleId =
    options.bundleId ??
    (typeof __APP_BUNDLE_ID__ === 'string'
      ? __APP_BUNDLE_ID__
      : 'xyz.clodex.agentic-ide');
  const readMacOSKeychainKey =
    options.readMacOSKeychainKey ?? readMacOSKeychainDataProtectionKey;
  const createMacOSKeychainKey =
    options.createMacOSKeychainKey ?? createMacOSKeychainDataProtectionKey;

  let stored = await readPersistedData(
    STORAGE_NAME,
    storedKeySchema,
    null,
    STORAGE_OPTIONS,
  );

  if (stored === null) {
    if (platform === 'darwin') {
      const keychainKey = await readMacOSKeychainKey(bundleId);
      if (keychainKey) {
        logger.debug('[DataProtection] Data key unlocked from macOS Keychain');
        return new AeadDataProtection(keychainKey);
      }

      const createdKeychainKey = await createMacOSKeychainKey(bundleId);
      logger.debug('[DataProtection] Data key created in macOS Keychain');
      return new AeadDataProtection(createdKeychainKey);
    }

    stored = {
      version: 1,
      key: randomBytes(KEY_LENGTH).toString('base64'),
    };
    await writePersistedData(
      STORAGE_NAME,
      storedKeySchema,
      stored,
      STORAGE_OPTIONS,
    );
    logger.debug('[DataProtection] Generated a new protected data key');
  }

  const key = decodeStoredKey(stored);
  logger.debug('[DataProtection] Data key unlocked');
  return new AeadDataProtection(key);
}

function decodeStoredKey(stored: StoredKey): Buffer {
  const { key: encoded } = stored;
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Stored data protection key is not valid base64');
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.toString('base64') !== encoded) {
    throw new Error('Stored data protection key is not canonical base64');
  }
  if (key.byteLength !== KEY_LENGTH) {
    throw new Error(
      `Stored data protection key must be exactly ${KEY_LENGTH} bytes`,
    );
  }

  return key;
}
