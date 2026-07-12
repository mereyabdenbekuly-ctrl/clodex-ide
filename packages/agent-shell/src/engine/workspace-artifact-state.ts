import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkspaceArtifactState,
  WorkspaceArtifactStateEntry,
} from './execution-artifact-manifest';

const MAX_STATE_PATHS = 512;
const MAX_STATE_PATH_BYTES = 64 * 1024;
const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function captureLocalWorkspaceArtifactState(input: {
  workspaceRoot: string;
  includeEntries?: readonly WorkspaceArtifactStateEntry[];
}): Promise<WorkspaceArtifactState> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const [trackedPaths, untrackedPaths] = await Promise.all([
    listGitPaths(workspaceRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      'HEAD',
    ]),
    listGitPaths(workspaceRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ]);
  const tracked = new Map<string, boolean>();
  let truncated = trackedPaths.truncated || untrackedPaths.truncated;
  for (const relativePath of trackedPaths.paths)
    tracked.set(relativePath, true);
  for (const relativePath of untrackedPaths.paths) {
    tracked.set(relativePath, false);
  }
  for (const entry of input.includeEntries ?? []) {
    if (!tracked.has(entry.relativePath)) {
      tracked.set(entry.relativePath, entry.tracked);
    }
  }
  const paths = [...tracked].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (paths.length > MAX_STATE_PATHS) truncated = true;
  const entries: WorkspaceArtifactStateEntry[] = [];
  let pathBytes = 0;
  for (const [relativePath, isTracked] of paths.slice(0, MAX_STATE_PATHS)) {
    const nextPathBytes = Buffer.byteLength(relativePath, 'utf8');
    if (pathBytes + nextPathBytes > MAX_STATE_PATH_BYTES) {
      truncated = true;
      break;
    }
    if (!isSafeArtifactPath(relativePath)) {
      truncated = true;
      continue;
    }
    entries.push(
      await inspectLocalArtifactPath(workspaceRoot, relativePath, isTracked),
    );
    pathBytes += nextPathBytes;
  }
  return {
    entries: Object.freeze(entries),
    truncated,
  };
}

async function inspectLocalArtifactPath(
  workspaceRoot: string,
  relativePath: string,
  tracked: boolean,
): Promise<WorkspaceArtifactStateEntry> {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (
    absolutePath !== workspaceRoot &&
    !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error('Artifact state path escaped its workspace');
  }
  const stat = await lstat(absolutePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!stat) {
    return stateEntry(relativePath, tracked, {
      kind: 'deleted',
      sizeBytes: null,
      mode: null,
      sha256: null,
      modifiedAtMs: null,
      omissionReason: null,
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return stateEntry(relativePath, tracked, {
      kind: 'unsupported',
      sizeBytes: stat.size,
      mode: stat.mode & 0o777,
      sha256: null,
      modifiedAtMs: Math.trunc(stat.mtimeMs),
      omissionReason: 'unsupported-file',
    });
  }
  const oversized = stat.size > MAX_HASHED_FILE_BYTES;
  return stateEntry(relativePath, tracked, {
    kind: 'file',
    sizeBytes: stat.size,
    mode: stat.mode & 0o777,
    sha256: oversized ? null : await hashFile(absolutePath),
    modifiedAtMs: Math.trunc(stat.mtimeMs),
    omissionReason: oversized ? 'size-limit' : null,
  });
}

function stateEntry(
  relativePath: string,
  tracked: boolean,
  state: Omit<WorkspaceArtifactStateEntry, 'relativePath' | 'tracked'>,
): WorkspaceArtifactStateEntry {
  return Object.freeze({ relativePath, tracked, ...state });
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}

async function listGitPaths(
  workspaceRoot: string,
  args: readonly string[],
): Promise<{ paths: string[]; truncated: boolean }> {
  const output = await runGitBuffer(workspaceRoot, args);
  const values = output.toString('utf8').split('\0').filter(Boolean);
  let truncated = values.some((value) => value.includes('\uFFFD'));
  const paths: string[] = [];
  for (const value of values) {
    if (!isSafeArtifactPath(value)) {
      truncated = true;
      continue;
    }
    paths.push(value.replaceAll('\\', '/'));
  }
  return { paths: [...new Set(paths)].sort(), truncated };
}

function runGitBuffer(
  workspaceRoot: string,
  args: readonly string[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workspaceRoot, ...args],
      {
        encoding: null,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.from(stdout));
      },
    );
  });
}

function isSafeArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  return Boolean(
    normalized &&
      normalized.length <= 4_096 &&
      !normalized.startsWith('/') &&
      !containsControlCharacter(normalized) &&
      !segments.some((segment) => !segment || segment === '..') &&
      segments[0] !== '.git' &&
      segments[0] !== '.clodex' &&
      segments[0] !== '.stagewise',
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
