import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const TAR_BLOCK_SIZE = 512;
const TAR_NAME_BYTES = 100;
const TAR_PREFIX_BYTES = 155;

export interface WorkspaceMaterializationFile {
  relativePath: string;
  mode: number;
  content: Uint8Array;
}

export interface WorkspaceMaterialization {
  dirtyPatchHash: string;
  hasDirtyChanges: boolean;
  archive?: Uint8Array;
  archiveHash?: string;
}

export function createWorkspaceMaterialization(input: {
  trackedPatch: Uint8Array;
  untrackedFiles: readonly WorkspaceMaterializationFile[];
  includeArchive?: boolean;
}): WorkspaceMaterialization {
  const files = input.untrackedFiles
    .map((file) => ({
      relativePath: normalizeRelativePath(file.relativePath),
      mode: normalizeMode(file.mode),
      content: Buffer.from(file.content),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const trackedPatch = Buffer.from(input.trackedPatch);
  const dirtyPatchHash = hashCanonical({
    version: 1,
    trackedPatchHash: sha256(trackedPatch),
    untrackedFiles: files.map((file) => ({
      relativePath: file.relativePath,
      mode: file.mode,
      sizeBytes: file.content.byteLength,
      sha256: sha256(file.content),
    })),
  });
  if (!input.includeArchive) {
    return {
      dirtyPatchHash,
      hasDirtyChanges: trackedPatch.byteLength > 0 || files.length > 0,
    };
  }
  const archive = gzipSync(
    Buffer.concat([
      createTarEntry('.clodex/tracked.patch', 0o600, trackedPatch),
      ...files.map((file) =>
        createTarEntry(
          `workspace/${file.relativePath}`,
          file.mode,
          file.content,
        ),
      ),
      Buffer.alloc(TAR_BLOCK_SIZE * 2),
    ]),
    { level: 9 },
  );
  return {
    dirtyPatchHash,
    hasDirtyChanges: trackedPatch.byteLength > 0 || files.length > 0,
    archive,
    archiveHash: sha256(archive),
  };
}

function createTarEntry(
  relativePath: string,
  mode: number,
  content: Buffer,
): Buffer {
  const { name, prefix } = splitTarPath(relativePath);
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeString(header, 0, TAR_NAME_BYTES, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 345, TAR_PREFIX_BYTES, prefix);
  writeString(
    header,
    148,
    8,
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
  );
  const padding = Buffer.alloc(
    (TAR_BLOCK_SIZE - (content.byteLength % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE,
  );
  return Buffer.concat([header, content, padding]);
}

function splitTarPath(relativePath: string): {
  name: string;
  prefix: string;
} {
  if (Buffer.byteLength(relativePath) <= TAR_NAME_BYTES) {
    return { name: relativePath, prefix: '' };
  }
  const segments = relativePath.split('/');
  for (let index = segments.length - 1; index > 0; index--) {
    const prefix = segments.slice(0, index).join('/');
    const name = segments.slice(index).join('/');
    if (
      Buffer.byteLength(name) <= TAR_NAME_BYTES &&
      Buffer.byteLength(prefix) <= TAR_PREFIX_BYTES
    ) {
      return { name, prefix };
    }
  }
  throw new Error(
    `Workspace materialization path is too long: ${relativePath}`,
  );
}

function writeString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength > length) {
    throw new Error('Tar header string exceeds its field');
  }
  encoded.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = `${Math.trunc(value)
    .toString(8)
    .padStart(length - 1, '0')}\0`;
  writeString(target, offset, length, encoded);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    containsControlCharacter(normalized) ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..',
    ) ||
    isProtectedTopLevelPath(segments[0]!)
  ) {
    throw new Error(`Unsafe workspace materialization path: ${value}`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isProtectedTopLevelPath(value: string): boolean {
  return value === '.git' || value === '.clodex';
}

function normalizeMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0) return 0o600;
  return mode & 0o777;
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
