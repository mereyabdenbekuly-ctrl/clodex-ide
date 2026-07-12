import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KEY_LENGTH = 32;
const KEYCHAIN_ACCOUNT = 'clodex-data-protection';

function decodeKey(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error('macOS Keychain returned an invalid data protection key');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.byteLength !== KEY_LENGTH || key.toString('base64') !== normalized) {
    throw new Error('macOS Keychain returned an invalid data protection key');
  }
  return key;
}

function isMissingKeychainItem(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return (
    candidate.code === 44 ||
    (typeof candidate.stderr === 'string' &&
      candidate.stderr.includes('could not be found'))
  );
}

function serviceName(bundleId: string): string {
  return `${bundleId}.data-protection`;
}

export async function readMacOSKeychainDataProtectionKey(
  bundleId: string,
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        serviceName(bundleId),
        '-w',
      ],
      { encoding: 'utf8' },
    );
    return decodeKey(stdout);
  } catch (error) {
    if (isMissingKeychainItem(error)) return null;
    throw new Error('Unable to read the Clodex data key from macOS Keychain', {
      cause: error,
    });
  }
}

export async function createMacOSKeychainDataProtectionKey(
  bundleId: string,
): Promise<Buffer> {
  const existing = await readMacOSKeychainDataProtectionKey(bundleId);
  if (existing) return existing;

  const key = randomBytes(KEY_LENGTH);
  const encoded = key.toString('base64');
  try {
    await execFileAsync(
      '/usr/bin/security',
      [
        'add-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        serviceName(bundleId),
        '-w',
        encoded,
        '-U',
      ],
      { encoding: 'utf8' },
    );
    return (await readMacOSKeychainDataProtectionKey(bundleId)) ?? key;
  } catch (error) {
    throw new Error('Unable to create the Clodex data key in macOS Keychain', {
      cause: error,
    });
  }
}
