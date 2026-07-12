import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  createReadStream,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from '../fs';
import type { DataProtection } from './data-protection';

const MAGIC = Buffer.from('CLODEXPF', 'ascii');
const FORMAT_VERSION = 1;
const CIPHER_AES_256_GCM = 1;
const FIXED_HEADER_LENGTH = 76;
const FILE_ID_LENGTH = 16;
const NONCE_PREFIX_LENGTH = 8;
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const RECORD_HEADER_LENGTH = 9;
const FINAL_PAYLOAD_LENGTH = 16;
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MIN_CHUNK_SIZE = 4 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_WRAPPED_KEY_LENGTH = 64 * 1024;
const DATA_RECORD = 1;
const FINAL_RECORD = 2;
const MAX_SEQUENCE = 0xffff_fffe;

const GENERIC_MAGIC_PREFIX = Buffer.from('CLODEXP', 'ascii');

export type ProtectedFileSource =
  | Uint8Array
  | string
  | AsyncIterable<Uint8Array>;

export interface ProtectedFileWriteResult {
  plaintextBytes: number;
  chunks: number;
}

export type ProtectedFileMigrationResult =
  | 'missing'
  | 'already-protected'
  | 'migrated';

export interface ProtectedFileStorageOptions {
  chunkSize?: number;
}

interface ProtectedAppendManifest {
  version: 1;
  segments: number;
  plaintextBytes: number;
}

function contextPart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Canonical contexts shared by writers, readers, and one-way migrations.
 * Context strings are authenticated but never persisted verbatim in the
 * protected-file header (only SHA-256(context) is stored).
 */
export const protectedFileContext = {
  attachment(agentId: string, attachmentId: string): string {
    return `attachments/${contextPart(agentId)}/${contextPart(attachmentId)}`;
  },
  chronicle(relativePath: string): string {
    return `chronicle/${contextPart(relativePath.replaceAll('\\', '/'))}`;
  },
  shellLog(agentId: string, fileName: string): string {
    return `shell-logs/${contextPart(agentId)}/${contextPart(fileName)}`;
  },
  memory(relativePath: string): string {
    return `memory/${contextPart(relativePath.replaceAll('\\', '/'))}`;
  },
  diffHistoryBlobStore(): string {
    // The filename is a SHA-256 content address that is only known after the
    // source stream has been consumed. Readers independently verify that the
    // decrypted bytes hash back to the requested OID.
    return 'diff-history/blobs/content-addressed';
  },
  cache(cacheName: string, key: string): string {
    return `cache/${contextPart(cacheName)}/${contextPart(key)}`;
  },
} as const;

interface ParsedHeader {
  header: Buffer;
  headerHash: Buffer;
  fileId: Buffer;
  noncePrefix: Buffer;
  contextHash: Buffer;
  chunkSize: number;
  dataKey: Buffer;
  offset: number;
}

/**
 * Versioned, chunked, context-bound protected-file storage.
 *
 * Every file receives an independent random 256-bit DEK. The host-owned
 * DataProtection capability wraps that DEK; bulk bytes are encrypted as
 * independently authenticated AES-256-GCM chunks. Nonces are unique by
 * construction: a random per-file 64-bit prefix followed by the uint32 chunk
 * sequence. A final authenticated record commits the total plaintext length
 * and chunk count, so truncation, reordering, duplication, and tail injection
 * fail closed.
 *
 * Writes always use a sibling staging file, fsync it, rename it over the
 * destination, then fsync the parent directory. No plaintext staging file is
 * created.
 */
export class ProtectedFileStorage {
  private readonly dataProtection: DataProtection;
  private readonly chunkSize: number;

  public constructor(
    dataProtection: DataProtection,
    options: ProtectedFileStorageOptions = {},
  ) {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (
      !Number.isInteger(chunkSize) ||
      chunkSize < MIN_CHUNK_SIZE ||
      chunkSize > MAX_CHUNK_SIZE
    ) {
      throw new Error(
        `Protected-file chunk size must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE} bytes`,
      );
    }
    this.dataProtection = dataProtection;
    this.chunkSize = chunkSize;
  }

  public async isProtectedFile(filePath: string): Promise<boolean> {
    const handle = await open(filePath, 'r');
    try {
      const prefix = Buffer.alloc(MAGIC.length);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      if (bytesRead < GENERIC_MAGIC_PREFIX.length) return false;
      if (
        prefix
          .subarray(0, GENERIC_MAGIC_PREFIX.length)
          .equals(GENERIC_MAGIC_PREFIX) &&
        !prefix.equals(MAGIC)
      ) {
        throw new Error('Unsupported protected-file format');
      }
      return bytesRead === MAGIC.length && prefix.equals(MAGIC);
    } finally {
      await handle.close();
    }
  }

  public async writeFile(
    filePath: string,
    source: ProtectedFileSource,
    context: string,
  ): Promise<ProtectedFileWriteResult> {
    assertContext(context);
    const parentDir = path.dirname(filePath);
    await mkdir(parentDir, { recursive: true, mode: 0o700 });
    const stagingPath = path.join(
      parentDir,
      `.${path.basename(filePath)}.${process.pid}.${randomBytes(12).toString('hex')}.staging`,
    );
    const handle = await open(stagingPath, 'wx', 0o600);

    try {
      const fileId = randomBytes(FILE_ID_LENGTH);
      const noncePrefix = randomBytes(NONCE_PREFIX_LENGTH);
      const contextHash = hashContext(context);
      const dataKey = randomBytes(KEY_LENGTH);
      const wrappedKey = this.dataProtection.protectBuffer(
        dataKey,
        keyWrapContext(fileId, contextHash),
      );
      if (wrappedKey.byteLength > MAX_WRAPPED_KEY_LENGTH) {
        throw new Error('Wrapped protected-file key is unexpectedly large');
      }

      const header = createHeader({
        chunkSize: this.chunkSize,
        fileId,
        noncePrefix,
        contextHash,
        wrappedKey,
      });
      const headerHash = createHash('sha256').update(header).digest();
      await handle.write(header);

      let pending = Buffer.alloc(0);
      let sequence = 0;
      let plaintextBytes = 0;

      for await (const sourceChunk of toAsyncIterable(source)) {
        if (sourceChunk.byteLength === 0) continue;
        pending =
          pending.byteLength === 0
            ? Buffer.from(sourceChunk)
            : Buffer.concat([pending, Buffer.from(sourceChunk)]);

        while (pending.byteLength >= this.chunkSize) {
          const chunk = pending.subarray(0, this.chunkSize);
          await writeRecord(handle, {
            type: DATA_RECORD,
            sequence,
            plaintext: chunk,
            dataKey,
            noncePrefix,
            headerHash,
            contextHash,
            fileId,
          });
          sequence = nextSequence(sequence);
          plaintextBytes += chunk.byteLength;
          pending = pending.subarray(this.chunkSize);
        }
      }

      if (pending.byteLength > 0) {
        await writeRecord(handle, {
          type: DATA_RECORD,
          sequence,
          plaintext: pending,
          dataKey,
          noncePrefix,
          headerHash,
          contextHash,
          fileId,
        });
        sequence = nextSequence(sequence);
        plaintextBytes += pending.byteLength;
      }

      const chunkCount = sequence;
      const finalPayload = Buffer.alloc(FINAL_PAYLOAD_LENGTH);
      finalPayload.writeBigUInt64BE(BigInt(plaintextBytes), 0);
      finalPayload.writeUInt32BE(chunkCount, 8);
      finalPayload.writeUInt32BE(0, 12);
      await writeRecord(handle, {
        type: FINAL_RECORD,
        sequence: chunkCount,
        plaintext: finalPayload,
        dataKey,
        noncePrefix,
        headerHash,
        contextHash,
        fileId,
      });

      await handle.sync();
      await handle.close();
      await rename(stagingPath, filePath);
      await fsyncDirectory(parentDir);
      return { plaintextBytes, chunks: chunkCount };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async writeFileFromPath(
    filePath: string,
    sourcePath: string,
    context: string,
  ): Promise<ProtectedFileWriteResult> {
    return this.writeFile(filePath, createReadStream(sourcePath), context);
  }

  public async readFile(filePath: string, context: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.readChunks(filePath, context)) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  public async readText(
    filePath: string,
    context: string,
    encoding: BufferEncoding = 'utf-8',
  ): Promise<string> {
    return (await this.readFile(filePath, context)).toString(encoding);
  }

  public createReadStream(filePath: string, context: string): Readable {
    return Readable.from(this.readChunks(filePath, context));
  }

  public async *readChunks(
    filePath: string,
    context: string,
  ): AsyncGenerator<Buffer> {
    assertContext(context);
    const handle = await open(filePath, 'r');
    try {
      const parsed = await readHeader(handle, context, this.dataProtection);
      let offset = parsed.offset;
      let expectedSequence = 0;
      let plaintextBytes = 0;
      let sawFinal = false;

      while (!sawFinal) {
        const recordHeader = await readExact(
          handle,
          RECORD_HEADER_LENGTH,
          offset,
          'Protected file is truncated before final record',
        );
        offset += RECORD_HEADER_LENGTH;

        const type = recordHeader[0]!;
        const sequence = recordHeader.readUInt32BE(1);
        const plaintextLength = recordHeader.readUInt32BE(5);
        if (sequence !== expectedSequence) {
          throw new Error('Protected-file chunk sequence is invalid');
        }

        if (type === DATA_RECORD) {
          if (plaintextLength === 0 || plaintextLength > parsed.chunkSize) {
            throw new Error('Protected-file data chunk length is invalid');
          }
        } else if (type === FINAL_RECORD) {
          if (plaintextLength !== FINAL_PAYLOAD_LENGTH) {
            throw new Error('Protected-file final record length is invalid');
          }
        } else {
          throw new Error('Protected-file record type is invalid');
        }

        const authTag = await readExact(
          handle,
          AUTH_TAG_LENGTH,
          offset,
          'Protected file authentication tag is truncated',
        );
        offset += AUTH_TAG_LENGTH;
        const ciphertext = await readExact(
          handle,
          plaintextLength,
          offset,
          'Protected file ciphertext is truncated',
        );
        offset += plaintextLength;

        const plaintext = decryptRecord({
          type,
          sequence,
          ciphertext,
          authTag,
          dataKey: parsed.dataKey,
          noncePrefix: parsed.noncePrefix,
          headerHash: parsed.headerHash,
          contextHash: parsed.contextHash,
          fileId: parsed.fileId,
        });

        if (type === DATA_RECORD) {
          plaintextBytes += plaintext.byteLength;
          expectedSequence = nextSequence(expectedSequence);
          yield plaintext;
          continue;
        }

        const committedBytes = plaintext.readBigUInt64BE(0);
        const committedChunks = plaintext.readUInt32BE(8);
        const reserved = plaintext.readUInt32BE(12);
        if (
          committedBytes !== BigInt(plaintextBytes) ||
          committedChunks !== expectedSequence ||
          reserved !== 0
        ) {
          throw new Error('Protected-file final record does not match content');
        }
        sawFinal = true;
      }

      const trailing = Buffer.alloc(1);
      const { bytesRead } = await handle.read(trailing, 0, 1, offset);
      if (bytesRead !== 0) {
        throw new Error('Protected file has unauthenticated trailing data');
      }
    } finally {
      await handle.close();
    }
  }

  public async migrateFile(
    filePath: string,
    context: string,
  ): Promise<ProtectedFileMigrationResult> {
    try {
      await stat(filePath);
    } catch {
      return 'missing';
    }
    if (await this.isProtectedFile(filePath)) {
      // Authenticate the complete file, including the final commit record.
      for await (const _chunk of this.readChunks(filePath, context)) {
        // Deliberately drain without retaining plaintext.
      }
      return 'already-protected';
    }
    await this.writeFileFromPath(filePath, filePath, context);
    return 'migrated';
  }

  public async commitPreparedFile(
    preparedPath: string,
    finalPath: string,
  ): Promise<void> {
    const preparedDir = path.resolve(path.dirname(preparedPath));
    const finalDir = path.resolve(path.dirname(finalPath));
    if (preparedDir !== finalDir) {
      throw new Error(
        'Prepared protected file must be committed within the same directory',
      );
    }
    await rename(preparedPath, finalPath);
    await fsyncDirectory(finalDir);
  }
}

/**
 * Append-oriented protected storage backed by immutable protected segments and
 * an atomically replaced protected manifest. It is intended for shell/log
 * streams where rewriting a growing multi-megabyte file on every flush would
 * be quadratic. Every segment and every manifest update still follows the
 * staging → fsync → rename discipline implemented by ProtectedFileStorage.
 */
export class ProtectedAppendFileStorage {
  private queue = Promise.resolve();

  public constructor(
    private readonly storage: ProtectedFileStorage,
    private readonly filePath: string,
    private readonly context: string,
  ) {
    assertContext(context);
  }

  public append(source: Uint8Array | string): Promise<void> {
    const bytes =
      typeof source === 'string'
        ? Buffer.from(source, 'utf-8')
        : Buffer.from(source);
    if (bytes.byteLength === 0) return this.queue;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        const manifest = await this.readOrMigrateManifest();
        const segmentIndex = manifest.segments;
        const segmentPath = this.segmentPath(segmentIndex);
        await this.storage.writeFile(
          segmentPath,
          bytes,
          this.segmentContext(segmentIndex),
        );
        await this.writeManifest({
          version: 1,
          segments: segmentIndex + 1,
          plaintextBytes: manifest.plaintextBytes + bytes.byteLength,
        });
      });
    return this.queue;
  }

  public async drain(): Promise<void> {
    await this.queue;
  }

  public async readFile(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.readChunks()) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  public async *readChunks(): AsyncGenerator<Buffer> {
    await this.drain();
    const manifest = await this.readOrMigrateManifest();
    let bytesRead = 0;
    for (let index = 0; index < manifest.segments; index++) {
      for await (const chunk of this.storage.readChunks(
        this.segmentPath(index),
        this.segmentContext(index),
      )) {
        bytesRead += chunk.byteLength;
        yield chunk;
      }
    }
    if (bytesRead !== manifest.plaintextBytes) {
      throw new Error('Protected append-file manifest length does not match');
    }
  }

  public async migrate(): Promise<ProtectedFileMigrationResult> {
    try {
      await stat(this.filePath);
    } catch {
      return 'missing';
    }
    if (await this.storage.isProtectedFile(this.filePath)) {
      await this.readManifest();
      return 'already-protected';
    }
    await this.readOrMigrateManifest();
    return 'migrated';
  }

  private async readOrMigrateManifest(): Promise<ProtectedAppendManifest> {
    try {
      await stat(this.filePath);
    } catch {
      return { version: 1, segments: 0, plaintextBytes: 0 };
    }

    if (await this.storage.isProtectedFile(this.filePath)) {
      return this.readManifest();
    }

    const legacy = await readFile(this.filePath);
    const manifest: ProtectedAppendManifest = {
      version: 1,
      segments: legacy.byteLength > 0 ? 1 : 0,
      plaintextBytes: legacy.byteLength,
    };
    if (legacy.byteLength > 0) {
      await this.storage.writeFile(
        this.segmentPath(0),
        legacy,
        this.segmentContext(0),
      );
    }
    await this.writeManifest(manifest);
    return manifest;
  }

  private async readManifest(): Promise<ProtectedAppendManifest> {
    const raw = await this.storage.readText(
      this.filePath,
      this.manifestContext(),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error('Protected append-file manifest is invalid JSON', {
        cause: error,
      });
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ProtectedAppendManifest).version !== 1 ||
      !Number.isSafeInteger((parsed as ProtectedAppendManifest).segments) ||
      (parsed as ProtectedAppendManifest).segments < 0 ||
      !Number.isSafeInteger(
        (parsed as ProtectedAppendManifest).plaintextBytes,
      ) ||
      (parsed as ProtectedAppendManifest).plaintextBytes < 0
    ) {
      throw new Error('Protected append-file manifest is malformed');
    }
    return parsed as ProtectedAppendManifest;
  }

  private async writeManifest(
    manifest: ProtectedAppendManifest,
  ): Promise<void> {
    await this.storage.writeFile(
      this.filePath,
      `${JSON.stringify(manifest)}\n`,
      this.manifestContext(),
    );
  }

  private segmentPath(index: number): string {
    return path.join(`${this.filePath}.segments`, `${index}.pf`);
  }

  private manifestContext(): string {
    return `${this.context}/manifest`;
  }

  private segmentContext(index: number): string {
    return `${this.context}/segment/${index}`;
  }
}

function assertContext(context: string): void {
  if (context.length === 0) {
    throw new Error('Protected-file context must not be empty');
  }
}

function hashContext(context: string): Buffer {
  return createHash('sha256').update(context, 'utf-8').digest();
}

function keyWrapContext(fileId: Buffer, contextHash: Buffer): string {
  return `protected-file/v${FORMAT_VERSION}/key/${fileId.toString('base64url')}/${contextHash.toString('base64url')}`;
}

function createHeader(input: {
  chunkSize: number;
  fileId: Buffer;
  noncePrefix: Buffer;
  contextHash: Buffer;
  wrappedKey: Buffer;
}): Buffer {
  const header = Buffer.alloc(FIXED_HEADER_LENGTH + input.wrappedKey.length);
  MAGIC.copy(header, 0);
  header[8] = FORMAT_VERSION;
  header[9] = CIPHER_AES_256_GCM;
  header.writeUInt16BE(0, 10);
  header.writeUInt32BE(input.chunkSize, 12);
  input.fileId.copy(header, 16);
  input.noncePrefix.copy(header, 32);
  input.contextHash.copy(header, 40);
  header.writeUInt32BE(input.wrappedKey.length, 72);
  input.wrappedKey.copy(header, FIXED_HEADER_LENGTH);
  return header;
}

async function readHeader(
  handle: Awaited<ReturnType<typeof open>>,
  context: string,
  dataProtection: DataProtection,
): Promise<ParsedHeader> {
  const fixed = await readExact(
    handle,
    FIXED_HEADER_LENGTH,
    0,
    'Protected-file header is truncated',
  );
  if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (
      fixed
        .subarray(0, GENERIC_MAGIC_PREFIX.length)
        .equals(GENERIC_MAGIC_PREFIX)
    ) {
      throw new Error('Unsupported protected-file format');
    }
    throw new Error('File is not a protected file');
  }
  if (fixed[8] !== FORMAT_VERSION) {
    throw new Error('Unsupported protected-file version');
  }
  if (fixed[9] !== CIPHER_AES_256_GCM || fixed.readUInt16BE(10) !== 0) {
    throw new Error('Unsupported protected-file cipher suite');
  }

  const chunkSize = fixed.readUInt32BE(12);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error('Protected-file chunk size is invalid');
  }
  const fileId = Buffer.from(fixed.subarray(16, 32));
  const noncePrefix = Buffer.from(fixed.subarray(32, 40));
  const contextHash = Buffer.from(fixed.subarray(40, 72));
  const expectedContextHash = hashContext(context);
  if (!timingSafeEqual(contextHash, expectedContextHash)) {
    throw new Error('Protected-file context does not match');
  }

  const wrappedKeyLength = fixed.readUInt32BE(72);
  if (wrappedKeyLength === 0 || wrappedKeyLength > MAX_WRAPPED_KEY_LENGTH) {
    throw new Error('Protected-file wrapped key length is invalid');
  }
  const wrappedKey = await readExact(
    handle,
    wrappedKeyLength,
    FIXED_HEADER_LENGTH,
    'Protected-file wrapped key is truncated',
  );
  const header = Buffer.concat([fixed, wrappedKey]);
  const dataKey = dataProtection.unprotectBuffer(
    wrappedKey,
    keyWrapContext(fileId, contextHash),
  );
  if (dataKey.byteLength !== KEY_LENGTH) {
    throw new Error('Protected-file data key length is invalid');
  }
  return {
    header,
    headerHash: createHash('sha256').update(header).digest(),
    fileId,
    noncePrefix,
    contextHash,
    chunkSize,
    dataKey,
    offset: header.byteLength,
  };
}

async function writeRecord(
  handle: Awaited<ReturnType<typeof open>>,
  input: {
    type: number;
    sequence: number;
    plaintext: Buffer;
    dataKey: Buffer;
    noncePrefix: Buffer;
    headerHash: Buffer;
    contextHash: Buffer;
    fileId: Buffer;
  },
): Promise<void> {
  const nonce = createNonce(input.noncePrefix, input.sequence);
  const aad = createRecordAad(
    input.type,
    input.sequence,
    input.plaintext.byteLength,
    input.headerHash,
    input.contextHash,
    input.fileId,
  );
  const cipher = createCipheriv('aes-256-gcm', input.dataKey, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const recordHeader = Buffer.alloc(RECORD_HEADER_LENGTH);
  recordHeader[0] = input.type;
  recordHeader.writeUInt32BE(input.sequence, 1);
  recordHeader.writeUInt32BE(input.plaintext.byteLength, 5);
  await handle.write(Buffer.concat([recordHeader, authTag, ciphertext]));
}

function decryptRecord(input: {
  type: number;
  sequence: number;
  ciphertext: Buffer;
  authTag: Buffer;
  dataKey: Buffer;
  noncePrefix: Buffer;
  headerHash: Buffer;
  contextHash: Buffer;
  fileId: Buffer;
}): Buffer {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      input.dataKey,
      createNonce(input.noncePrefix, input.sequence),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    decipher.setAAD(
      createRecordAad(
        input.type,
        input.sequence,
        input.ciphertext.byteLength,
        input.headerHash,
        input.contextHash,
        input.fileId,
      ),
    );
    decipher.setAuthTag(input.authTag);
    return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error('Protected-file authentication failed', { cause: error });
  }
}

function createNonce(prefix: Buffer, sequence: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(sequence, 8);
  return nonce;
}

function createRecordAad(
  type: number,
  sequence: number,
  plaintextLength: number,
  headerHash: Buffer,
  contextHash: Buffer,
  fileId: Buffer,
): Buffer {
  const fields = Buffer.alloc(10);
  fields[0] = FORMAT_VERSION;
  fields[1] = type;
  fields.writeUInt32BE(sequence, 2);
  fields.writeUInt32BE(plaintextLength, 6);
  return Buffer.concat([
    Buffer.from('clodex-protected-file-record\0', 'utf-8'),
    fields,
    headerHash,
    contextHash,
    fileId,
  ]);
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
  errorMessage: string,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error(errorMessage);
    offset += bytesRead;
  }
  return buffer;
}

async function* toAsyncIterable(
  source: ProtectedFileSource,
): AsyncGenerator<Uint8Array> {
  if (typeof source === 'string') {
    yield Buffer.from(source, 'utf-8');
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  yield* source;
}

function nextSequence(sequence: number): number {
  if (sequence >= MAX_SEQUENCE) {
    throw new Error('Protected file exceeds maximum chunk count');
  }
  return sequence + 1;
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === 'win32' &&
      (code === 'EINVAL' || code === 'EPERM' || code === 'EISDIR')
    ) {
      return;
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function readPossiblyProtectedFile(
  storage: ProtectedFileStorage | undefined,
  filePath: string,
  context: string,
): Promise<Buffer> {
  if (!storage) {
    const raw = await readFile(filePath);
    if (
      raw.byteLength >= GENERIC_MAGIC_PREFIX.length &&
      raw.subarray(0, GENERIC_MAGIC_PREFIX.length).equals(GENERIC_MAGIC_PREFIX)
    ) {
      throw new Error(
        `Protected file requires a host protected-file capability (${context})`,
      );
    }
    return raw;
  }
  if (!(await storage.isProtectedFile(filePath))) {
    throw new Error(
      `Plaintext file found while protected-file storage is enabled (${context})`,
    );
  }
  return storage.readFile(filePath, context);
}
