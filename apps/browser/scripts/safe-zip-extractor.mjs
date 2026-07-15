import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import yauzl from 'yauzl';

const DEFAULT_MAXIMUM_ARCHIVE_ENTRIES = 2_000;
const DEFAULT_MAXIMUM_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAXIMUM_ARCHIVE_PATH_BYTES = 4_096;
const MAXIMUM_ARCHIVE_SEGMENT_BYTES = 255;
const MAXIMUM_SYMLINK_TARGET_BYTES = 4 * 1024;
const WINDOWS_DEVICE_BASENAME =
  /^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function portableCaseFold(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function isWindowsDeviceName(segment) {
  const basename = segment.split('.', 1)[0].replace(/[. ]+$/u, '');
  return WINDOWS_DEVICE_BASENAME.test(basename);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function safePortableArchivePath(fileName) {
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    Buffer.byteLength(fileName, 'utf8') > MAXIMUM_ARCHIVE_PATH_BYTES ||
    fileName.normalize('NFC') !== fileName ||
    hasControlCharacter(fileName) ||
    fileName.includes('\\') ||
    fileName.startsWith('/') ||
    /^[A-Za-z]:/u.test(fileName)
  ) {
    throw new Error(`Unsafe archive path: ${String(fileName)}`);
  }
  const normalized = path.posix.normalize(fileName);
  if (
    normalized !== fileName ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Unsafe archive path: ${fileName}`);
  }
  const segments = fileName.endsWith('/')
    ? fileName.slice(0, -1).split('/')
    : fileName.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        Buffer.byteLength(segment, 'utf8') > MAXIMUM_ARCHIVE_SEGMENT_BYTES ||
        segment.includes(':') ||
        /[. ]$/u.test(segment) ||
        isWindowsDeviceName(segment),
    )
  ) {
    throw new Error(
      `Archive path is not portable across release filesystems: ${fileName}`,
    );
  }
  return normalized;
}

export function resolveSafeMaterializedSymlinkTarget(linkPath, target) {
  const normalizedLinkPath = safePortableArchivePath(linkPath);
  if (normalizedLinkPath.endsWith('/')) {
    throw new Error(`Unsafe archive symlink path: ${linkPath}`);
  }
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    Buffer.byteLength(target, 'utf8') > MAXIMUM_SYMLINK_TARGET_BYTES ||
    target.normalize('NFC') !== target ||
    hasControlCharacter(target) ||
    target.includes('\\') ||
    target.startsWith('/') ||
    /^[A-Za-z]:/u.test(target)
  ) {
    throw new Error(
      `Unsafe archive symlink target: ${linkPath} -> ${String(target)}`,
    );
  }
  const normalizedResolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizedLinkPath), target),
  );
  const resolved = normalizedResolved.endsWith('/')
    ? normalizedResolved.slice(0, -1)
    : normalizedResolved;
  if (
    resolved === '..' ||
    resolved.startsWith('../') ||
    resolved.includes('/../')
  ) {
    throw new Error(
      `Archive symlink escapes the verified root: ${linkPath} -> ${target}`,
    );
  }
  safePortableArchivePath(resolved);
  if (
    resolved === normalizedLinkPath ||
    resolved.startsWith(`${normalizedLinkPath}/`) ||
    normalizedLinkPath.startsWith(`${resolved}/`)
  ) {
    throw new Error(
      `Archive symlink source and materialized target overlap: ${linkPath} -> ${target}`,
    );
  }
  return resolved;
}

function openZipBuffer(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      {
        autoClose: true,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(error ?? new Error('Unable to open verified ZIP bytes'));
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          error ?? new Error(`Unable to read ZIP entry ${entry.fileName}`),
        );
        return;
      }
      resolve(stream);
    });
  });
}

async function readZipEntryBytes(zipFile, entry, maximumBytes) {
  const chunks = [];
  let byteCount = 0;
  const stream = await openZipEntryStream(zipFile, entry);
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    byteCount += buffer.length;
    if (byteCount > maximumBytes) {
      throw new Error(`ZIP entry exceeds its byte limit: ${entry.fileName}`);
    }
    chunks.push(buffer);
  }
  if (byteCount !== entry.uncompressedSize) {
    throw new Error(`ZIP entry size changed while reading: ${entry.fileName}`);
  }
  return Buffer.concat(chunks);
}

function classifyEntry(entry, archivePath) {
  const unixMode = entry.externalFileAttributes >>> 16;
  const fileType = unixMode & 0o170000;
  const hasDirectorySuffix = archivePath.endsWith('/');
  if (hasDirectorySuffix) {
    if (fileType !== 0 && fileType !== 0o040000) {
      throw new Error(`ZIP directory has an invalid file type: ${archivePath}`);
    }
    if (entry.uncompressedSize !== 0) {
      throw new Error(`ZIP directory has non-empty data: ${archivePath}`);
    }
    return 'directory';
  }
  if (fileType === 0o120000) return 'symlink';
  if (fileType === 0 || fileType === 0o100000) return 'file';
  throw new Error(`ZIP contains an unsupported special entry: ${archivePath}`);
}

function assertNoPortablePathCollision(observedEntries, candidate) {
  for (const observed of observedEntries) {
    if (observed.caseFoldedPath === candidate.caseFoldedPath) {
      throw new Error(
        `ZIP has a duplicate or case-colliding entry: ${candidate.path}`,
      );
    }
    if (candidate.caseFoldedPath.startsWith(`${observed.caseFoldedPath}/`)) {
      if (
        observed.kind !== 'directory' ||
        !candidate.path.startsWith(`${observed.path}/`)
      ) {
        throw new Error(
          `ZIP has a non-portable parent/child path collision: ${observed.path} <> ${candidate.path}`,
        );
      }
    }
    if (observed.caseFoldedPath.startsWith(`${candidate.caseFoldedPath}/`)) {
      if (
        candidate.kind !== 'directory' ||
        !observed.path.startsWith(`${candidate.path}/`)
      ) {
        throw new Error(
          `ZIP has a non-portable parent/child path collision: ${candidate.path} <> ${observed.path}`,
        );
      }
    }
  }
}

export function validateReviewedMaterializedSymlinks(allowedSymlinks) {
  if (!Array.isArray(allowedSymlinks)) {
    throw new Error('Reviewed ZIP symlink policy must be an array.');
  }
  const observedEntries = [];
  const reviewed = allowedSymlinks.map((entry) => {
    const linkPath = safePortableArchivePath(String(entry?.path ?? ''));
    if (linkPath.endsWith('/')) {
      throw new Error(`Reviewed ZIP symlink path is a directory: ${linkPath}`);
    }
    const target = String(entry?.target ?? '');
    resolveSafeMaterializedSymlinkTarget(linkPath, target);
    const observedEntry = {
      caseFoldedPath: portableCaseFold(linkPath),
      kind: 'symlink',
      path: linkPath,
    };
    assertNoPortablePathCollision(observedEntries, observedEntry);
    observedEntries.push(observedEntry);
    return { path: linkPath, target };
  });
  reviewed.sort((left, right) =>
    compareText(
      `${left.path}\0${left.target}`,
      `${right.path}\0${right.target}`,
    ),
  );
  return reviewed;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
    );
    if (bytesWritten <= 0) {
      throw new Error(
        'Unable to make progress while writing a verified ZIP entry.',
      );
    }
    offset += bytesWritten;
  }
}

export async function extractVerifiedZipArchive({
  allowedSymlinks,
  archiveBytes,
  archiveRoot,
  destination,
  maximumArchiveEntries = DEFAULT_MAXIMUM_ARCHIVE_ENTRIES,
  maximumExtractedBytes = DEFAULT_MAXIMUM_EXTRACTED_BYTES,
}) {
  const normalizedArchiveRoot = safePortableArchivePath(archiveRoot);
  if (
    normalizedArchiveRoot.includes('/') ||
    normalizedArchiveRoot.endsWith('/')
  ) {
    throw new Error(`Unsafe ZIP archive root: ${archiveRoot}`);
  }
  if (
    !Number.isSafeInteger(maximumArchiveEntries) ||
    maximumArchiveEntries <= 0
  ) {
    throw new Error('Maximum ZIP entry count must be a positive safe integer.');
  }
  if (
    !Number.isSafeInteger(maximumExtractedBytes) ||
    maximumExtractedBytes <= 0
  ) {
    throw new Error(
      'Maximum ZIP extracted bytes must be a positive safe integer.',
    );
  }
  const reviewedSymlinks =
    validateReviewedMaterializedSymlinks(allowedSymlinks);
  const extractionRoot = path.resolve(destination);
  await fs.mkdir(extractionRoot, { mode: 0o700 });

  const zipFile = await openZipBuffer(archiveBytes);
  const observedEntries = [];
  const symlinks = [];
  let entryCount = 0;
  let extractedBytes = 0;
  let observedRoot = false;

  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      zipFile.close();
      reject(error);
    };
    zipFile.on('error', fail);
    zipFile.on('end', () => {
      if (!failed) resolve();
    });
    zipFile.on('entry', (entry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > maximumArchiveEntries) {
          throw new Error('ZIP contains too many entries.');
        }
        const archivePath = safePortableArchivePath(entry.fileName);
        if (
          archivePath !== `${normalizedArchiveRoot}/` &&
          !archivePath.startsWith(`${normalizedArchiveRoot}/`)
        ) {
          throw new Error(
            `ZIP entry is outside its immutable root: ${archivePath}`,
          );
        }
        const kind = classifyEntry(entry, archivePath);
        const relativePath = archivePath.slice(
          normalizedArchiveRoot.length + 1,
        );
        if (relativePath.length === 0) {
          if (observedRoot) {
            throw new Error(`ZIP immutable root is duplicated: ${archivePath}`);
          }
          observedRoot = true;
          zipFile.readEntry();
          return;
        }
        const collisionPath = relativePath.endsWith('/')
          ? relativePath.slice(0, -1)
          : relativePath;
        const observedEntry = {
          caseFoldedPath: portableCaseFold(collisionPath),
          kind,
          path: collisionPath,
        };
        assertNoPortablePathCollision(observedEntries, observedEntry);
        observedEntries.push(observedEntry);

        const destinationPath = path.resolve(
          extractionRoot,
          ...collisionPath.split('/'),
        );
        if (!destinationPath.startsWith(`${extractionRoot}${path.sep}`)) {
          throw new Error(`ZIP entry escapes extraction: ${relativePath}`);
        }
        if (kind === 'directory') {
          await fs.mkdir(destinationPath, { mode: 0o700, recursive: true });
          zipFile.readEntry();
          return;
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > maximumExtractedBytes - extractedBytes
        ) {
          throw new Error(
            `ZIP declares an unsafe extracted size for ${relativePath}`,
          );
        }
        if (kind === 'symlink') {
          if (entry.uncompressedSize > MAXIMUM_SYMLINK_TARGET_BYTES) {
            throw new Error(
              `ZIP symlink target exceeds its limit: ${relativePath}`,
            );
          }
          const targetBytes = await readZipEntryBytes(
            zipFile,
            entry,
            MAXIMUM_SYMLINK_TARGET_BYTES,
          );
          extractedBytes += targetBytes.length;
          const target = UTF8_DECODER.decode(targetBytes);
          resolveSafeMaterializedSymlinkTarget(relativePath, target);
          symlinks.push({ path: relativePath, target });
          zipFile.readEntry();
          return;
        }
        await fs.mkdir(path.dirname(destinationPath), {
          mode: 0o700,
          recursive: true,
        });
        const stream = await openZipEntryStream(zipFile, entry);
        const handle = await fs.open(destinationPath, 'wx', 0o600);
        let entryBytes = 0;
        try {
          for await (const chunk of stream) {
            const buffer = Buffer.from(chunk);
            entryBytes += buffer.length;
            extractedBytes += buffer.length;
            if (extractedBytes > maximumExtractedBytes) {
              throw new Error('ZIP exceeds the extracted byte limit.');
            }
            await writeAll(handle, buffer);
          }
        } finally {
          await handle.close();
        }
        if (entryBytes !== entry.uncompressedSize) {
          throw new Error(
            `ZIP entry size changed while extracting: ${relativePath}`,
          );
        }
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });

  if (!observedRoot) {
    throw new Error(
      `ZIP immutable root directory is missing: ${normalizedArchiveRoot}/`,
    );
  }
  symlinks.sort((left, right) =>
    compareText(
      `${left.path}\0${left.target}`,
      `${right.path}\0${right.target}`,
    ),
  );
  if (JSON.stringify(symlinks) !== JSON.stringify(reviewedSymlinks)) {
    throw new Error(
      `ZIP symlink set changed: expected ${JSON.stringify(reviewedSymlinks)}; got ${JSON.stringify(symlinks)}`,
    );
  }
  for (const symlink of symlinks) {
    const targetRelativePath = resolveSafeMaterializedSymlinkTarget(
      symlink.path,
      symlink.target,
    );
    const targetPath = path.resolve(
      extractionRoot,
      ...targetRelativePath.split('/'),
    );
    const materializedPath = path.resolve(
      extractionRoot,
      ...symlink.path.split('/'),
    );
    const targetStat = await fs.lstat(targetPath);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(
        `Reviewed ZIP symlink target is not a regular directory: ${symlink.path} -> ${symlink.target}`,
      );
    }
    await fs.cp(targetPath, materializedPath, {
      dereference: true,
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }

  return {
    entryCount,
    extractedBytes,
    materializedSymlinks: symlinks,
  };
}
