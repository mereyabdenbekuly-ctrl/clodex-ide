import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import { type JsonName, getJsonPath } from './paths';

export type { JsonName };

interface PersistedDataOptions {
  encrypt?: boolean;
  /**
   * Propagate encryption, decryption, and validation failures instead of
   * silently returning the default value.
   */
  requireEncryption?: boolean;
  /**
   * One-way migration for files written as plaintext by older releases when
   * safeStorage was unavailable. The plaintext is accepted only if it passes
   * the supplied schema, then immediately replaced with an encrypted envelope.
   */
  allowPlaintextMigration?: boolean;
}

const ENCRYPTED_ENVELOPE_FORMAT = 'clodex.safe-storage';
const ENCRYPTED_ENVELOPE_VERSION = 1;
const FILE_MODE_OWNER_ONLY = 0o600;

interface EncryptedEnvelope {
  $clodex: typeof ENCRYPTED_ENVELOPE_FORMAT;
  version: typeof ENCRYPTED_ENVELOPE_VERSION;
  ciphertext: string;
}

type DecodedEncryptedData = {
  content: string;
  requiresMigration: boolean;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function assertEncryptionAvailable(name: JsonName): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      `OS-backed encryption is unavailable for persisted data "${name}"`,
    );
  }
}

function serializeEncryptedData(name: JsonName, content: string): Buffer {
  assertEncryptionAvailable(name);

  const encrypted = safeStorage.encryptString(content);
  const envelope: EncryptedEnvelope = {
    $clodex: ENCRYPTED_ENVELOPE_FORMAT,
    version: ENCRYPTED_ENVELOPE_VERSION,
    ciphertext: encrypted.toString('base64'),
  };

  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf-8');
}

function parseEncryptedEnvelope(buffer: Buffer): EncryptedEnvelope | null {
  const encoded = buffer.toString('utf-8');
  if (!encoded.trimStart().startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    if (encoded.includes(`"$clodex":"${ENCRYPTED_ENVELOPE_FORMAT}"`)) {
      throw new Error('Encrypted persisted-data envelope is malformed');
    }
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('$clodex' in parsed) ||
    parsed.$clodex !== ENCRYPTED_ENVELOPE_FORMAT
  ) {
    return null;
  }

  if (!('version' in parsed) || parsed.version !== ENCRYPTED_ENVELOPE_VERSION) {
    throw new Error('Encrypted persisted-data envelope version is unsupported');
  }

  if (
    !('ciphertext' in parsed) ||
    typeof parsed.ciphertext !== 'string' ||
    parsed.ciphertext.length === 0
  ) {
    throw new Error('Encrypted persisted-data envelope has no ciphertext');
  }

  return parsed as EncryptedEnvelope;
}

function decodeBase64Ciphertext(ciphertext: string): Buffer {
  if (
    ciphertext.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(ciphertext)
  ) {
    throw new Error('Encrypted persisted-data ciphertext is not valid base64');
  }

  const decoded = Buffer.from(ciphertext, 'base64');
  if (decoded.toString('base64') !== ciphertext) {
    throw new Error('Encrypted persisted-data ciphertext is not canonical');
  }
  return decoded;
}

function decodeEncryptedData(
  name: JsonName,
  buffer: Buffer,
  allowPlaintextMigration: boolean,
): DecodedEncryptedData {
  assertEncryptionAvailable(name);

  const envelope = parseEncryptedEnvelope(buffer);
  if (envelope) {
    const encrypted = decodeBase64Ciphertext(envelope.ciphertext);
    return {
      content: safeStorage.decryptString(encrypted),
      requiresMigration: false,
    };
  }

  try {
    // Compatibility with files written by previous releases as a raw
    // safeStorage buffer. A successful read is upgraded to the envelope format.
    return {
      content: safeStorage.decryptString(buffer),
      requiresMigration: true,
    };
  } catch (error) {
    if (allowPlaintextMigration) {
      return {
        content: buffer.toString('utf-8'),
        requiresMigration: true,
      };
    }
    throw error;
  }
}

function createTemporaryPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

async function writeFileAtomically(
  filePath: string,
  content: string | Buffer,
): Promise<void> {
  const temporaryPath = createTemporaryPath(filePath);
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(temporaryPath, 'wx', FILE_MODE_OWNER_ONLY);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function writeFileAtomicallySync(
  filePath: string,
  content: string | Buffer,
): void {
  const temporaryPath = createTemporaryPath(filePath);
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = fsSync.openSync(temporaryPath, 'wx', FILE_MODE_OWNER_ONLY);
    fsSync.writeFileSync(fileDescriptor, content);
    fsSync.fsyncSync(fileDescriptor);
    fsSync.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fsSync.renameSync(temporaryPath, filePath);
    syncDirectorySync(path.dirname(filePath));
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fsSync.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      fsSync.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function syncDirectorySync(directory: string): void {
  if (process.platform === 'win32') return;
  const directoryDescriptor = fsSync.openSync(directory, 'r');
  try {
    fsSync.fsyncSync(directoryDescriptor);
  } finally {
    fsSync.closeSync(directoryDescriptor);
  }
}

function assertValidOptions(options?: PersistedDataOptions): void {
  if (options?.requireEncryption && !options.encrypt) {
    throw new Error('requireEncryption requires encrypt: true');
  }
  if (options?.allowPlaintextMigration && !options.encrypt) {
    throw new Error('allowPlaintextMigration requires encrypt: true');
  }
}

async function migrateEncryptedData<T extends z.ZodTypeAny>(
  name: JsonName,
  schema: T,
  data: z.infer<T>,
): Promise<void> {
  const json = JSON.stringify(schema.parse(data), null, 2);
  await writeFileAtomically(
    getJsonPath(name),
    serializeEncryptedData(name, json),
  );
}

function migrateEncryptedDataSync<T extends z.ZodTypeAny>(
  name: JsonName,
  schema: T,
  data: z.infer<T>,
): void {
  const json = JSON.stringify(schema.parse(data), null, 2);
  writeFileAtomicallySync(
    getJsonPath(name),
    serializeEncryptedData(name, json),
  );
}

// ---------------------------------------------------------------------------
// Async variants
// ---------------------------------------------------------------------------

export async function readPersistedData<T extends z.ZodTypeAny>(
  name: JsonName,
  schema: T,
  defaultValue: z.infer<T>,
  options?: PersistedDataOptions,
): Promise<z.infer<T>> {
  assertValidOptions(options);
  const filePath = getJsonPath(name);

  if (!options?.encrypt) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return schema.parse(JSON.parse(content));
    } catch {
      return defaultValue;
    }
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return defaultValue;
    if (options.requireEncryption) throw error;
    return defaultValue;
  }

  try {
    const decoded = decodeEncryptedData(
      name,
      buffer,
      options.allowPlaintextMigration ?? false,
    );
    const data = schema.parse(JSON.parse(decoded.content));

    if (decoded.requiresMigration) {
      await migrateEncryptedData(name, schema, data);
    }

    return data;
  } catch (error) {
    if (options.requireEncryption) throw error;
    return defaultValue;
  }
}

export async function writePersistedData<T extends z.ZodTypeAny>(
  name: JsonName,
  schema: T,
  data: z.infer<T>,
  options?: PersistedDataOptions,
): Promise<void> {
  assertValidOptions(options);
  const filePath = getJsonPath(name);
  const json = JSON.stringify(schema.parse(data), null, 2);

  const content = options?.encrypt ? serializeEncryptedData(name, json) : json;
  await writeFileAtomically(filePath, content);
}

// ---------------------------------------------------------------------------
// Sync variants (used by WindowLayoutService for startup window-state)
// ---------------------------------------------------------------------------

export function readPersistedDataSync<T extends z.ZodTypeAny>(
  name: JsonName,
  schema: T,
  defaultValue: z.infer<T>,
  options?: PersistedDataOptions,
): z.infer<T> {
  assertValidOptions(options);
  const filePath = getJsonPath(name);

  if (!options?.encrypt) {
    try {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      return schema.parse(JSON.parse(content));
    } catch {
      return defaultValue;
    }
  }

  let buffer: Buffer;
  try {
    buffer = fsSync.readFileSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return defaultValue;
    if (options.requireEncryption) throw error;
    return defaultValue;
  }

  try {
    const decoded = decodeEncryptedData(
      name,
      buffer,
      options.allowPlaintextMigration ?? false,
    );
    const data = schema.parse(JSON.parse(decoded.content));

    if (decoded.requiresMigration) {
      migrateEncryptedDataSync(name, schema, data);
    }

    return data;
  } catch (error) {
    if (options.requireEncryption) throw error;
    return defaultValue;
  }
}

export function writePersistedDataSync<T extends z.ZodTypeAny>(
  name: JsonName,
  schema: T,
  data: z.infer<T>,
  options?: PersistedDataOptions,
): void {
  assertValidOptions(options);
  const filePath = getJsonPath(name);
  const json = JSON.stringify(schema.parse(data), null, 2);

  const content = options?.encrypt ? serializeEncryptedData(name, json) : json;
  writeFileAtomicallySync(filePath, content);
}
