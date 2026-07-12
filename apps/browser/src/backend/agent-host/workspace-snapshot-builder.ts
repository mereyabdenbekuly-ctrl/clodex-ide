import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  hashWorkspaceIdentity,
  hashWorkspaceDependencyFingerprint,
  hashWorkspaceIgnorePolicy,
  normalizeWorkspaceDependencyFingerprintContent,
  type WorkspaceEnvironmentFingerprint,
  type WorkspaceSnapshotEntry,
  type WorkspaceSnapshotMount,
} from '@clodex/agent-core/agents';
import {
  createWorkspaceMaterialization,
  type WorkspaceMaterializationFile,
} from './workspace-materialization';

const MAX_UNTRACKED_FILES = 2_048;
const MAX_MATERIALIZATION_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_DEPENDENCY_FINGERPRINT_FILES = 10_000;
const MAX_DEPENDENCY_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const DEPENDENCY_INPUT_NAMES = new Set([
  '.npmrc',
  '.yarnrc.yml',
  'Cargo.lock',
  'Cargo.toml',
  'bun.lock',
  'bun.lockb',
  'go.mod',
  'go.sum',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'rust-toolchain',
  'rust-toolchain.toml',
  'yarn.lock',
]);

export interface WorkspaceSnapshotBuilderMount {
  prefix: string;
  path: string;
}

export interface BuiltWorkspaceSnapshotMount extends WorkspaceSnapshotMount {
  hasDirtyChanges: boolean;
  materialization?: {
    version: 1;
    archiveFormat: 'tar-gzip';
    archive: Uint8Array;
    archiveHash: string;
    totalBytes: number;
  };
}

export async function buildLocalWorkspaceSnapshotMetadata(input: {
  mounts: readonly WorkspaceSnapshotBuilderMount[];
  entries: readonly WorkspaceSnapshotEntry[];
  selection: 'explicit' | 'mounted-workspaces';
  includeMaterialization?: boolean;
}): Promise<{
  mounts: BuiltWorkspaceSnapshotMount[];
  environment: Omit<WorkspaceEnvironmentFingerprint, 'fingerprintHash'>;
}> {
  const entriesByMount = new Map<string, WorkspaceSnapshotEntry[]>();
  for (const entry of input.entries) {
    const values = entriesByMount.get(entry.mountPrefix) ?? [];
    values.push(entry);
    entriesByMount.set(entry.mountPrefix, values);
  }
  const mounts = await Promise.all(
    input.mounts
      .filter(
        (mount) =>
          input.selection === 'mounted-workspaces' ||
          entriesByMount.has(mount.prefix),
      )
      .map((mount) =>
        buildMountMetadata(
          mount,
          entriesByMount.get(mount.prefix) ?? [],
          input.selection,
          input.includeMaterialization ?? false,
        ),
      ),
  );
  return {
    mounts,
    environment: {
      os: process.platform,
      arch: process.arch,
      shell: process.env.SHELL?.trim() || null,
      toolchains: Object.fromEntries(
        Object.entries({
          node: process.version,
          electron: process.versions.electron,
          v8: process.versions.v8,
        }).filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
    },
  };
}

async function buildMountMetadata(
  mount: WorkspaceSnapshotBuilderMount,
  entries: readonly WorkspaceSnapshotEntry[],
  selection: 'explicit' | 'mounted-workspaces',
  includeMaterialization: boolean,
): Promise<BuiltWorkspaceSnapshotMount> {
  const workspacePath = await realpath(mount.path).catch(() =>
    path.resolve(mount.path),
  );
  const selectedPaths = entries.map((entry) => entry.relativePath);
  const pathspec =
    selection === 'explicit' && selectedPaths.length > 0
      ? ['--', ...selectedPaths]
      : [];
  const [
    repositoryRevision,
    repositoryRoot,
    gitDirectory,
    trackedPatch,
    trackedPaths,
    trackedFiles,
    untrackedList,
  ] = await Promise.all([
    runGit(workspacePath, ['rev-parse', 'HEAD']),
    runGit(workspacePath, ['rev-parse', '--show-toplevel']),
    runGit(workspacePath, ['rev-parse', '--absolute-git-dir']),
    runGitBuffer(workspacePath, [
      'diff',
      '--binary',
      '--full-index',
      'HEAD',
      ...pathspec,
    ]),
    runGitBuffer(workspacePath, [
      'diff',
      '--name-only',
      '-z',
      'HEAD',
      ...pathspec,
    ]),
    runGitBuffer(workspacePath, ['ls-files', '-z']),
    runGitBuffer(workspacePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      ...pathspec,
    ]),
  ]);
  if (
    repositoryRevision &&
    (!trackedPatch || !trackedPaths || !untrackedList)
  ) {
    throw new Error('Workspace materialization could not inspect Git changes');
  }
  assertMaterializationPaths(trackedPaths, 'tracked');
  const untrackedFiles = await readUntrackedFiles(
    workspacePath,
    untrackedList,
    trackedPatch?.byteLength ?? 0,
  );
  const materializationState = createWorkspaceMaterialization({
    trackedPatch: trackedPatch ?? Buffer.alloc(0),
    untrackedFiles,
    includeArchive: includeMaterialization,
  });
  const ignorePolicyHash = hashWorkspaceIgnorePolicy(
    await readIgnorePolicy(workspacePath),
  );
  const dependencyFingerprintHash = hashWorkspaceDependencyFingerprint(
    await readDependencyFingerprintEntries(
      workspacePath,
      trackedFiles,
      untrackedList,
    ),
  );
  return {
    mountPrefix: mount.prefix,
    workspaceIdHash: hashWorkspaceIdentity(workspacePath),
    repositoryId: repositoryRoot
      ? hashOpaqueIdentity('repository', repositoryRoot)
      : null,
    worktreeId: gitDirectory
      ? hashOpaqueIdentity('worktree', gitDirectory)
      : null,
    repositoryRevision,
    dirtyPatchHash: materializationState.dirtyPatchHash,
    dependencyFingerprintHash,
    ignorePolicyHash,
    hasDirtyChanges: materializationState.hasDirtyChanges,
    ...(materializationState.archive && materializationState.archiveHash
      ? {
          materialization: {
            version: 1 as const,
            archiveFormat: 'tar-gzip' as const,
            archive: materializationState.archive,
            archiveHash: materializationState.archiveHash,
            totalBytes: materializationState.archive.byteLength,
          },
        }
      : {}),
  };
}

export function buildWorkspaceDirtyIdentity(
  status: string | null,
  entries: readonly WorkspaceSnapshotEntry[],
  selection: 'explicit' | 'mounted-workspaces',
): string {
  const entryHashes = new Map(
    entries.map((entry) => [entry.relativePath, entry.sha256]),
  );
  const records = (status ?? '')
    .split('\0')
    .filter(Boolean)
    .filter((record) => {
      if (selection === 'mounted-workspaces') return true;
      const pathValue = record.length > 3 ? record.slice(3) : '';
      return entryHashes.has(pathValue);
    })
    .sort();
  return JSON.stringify({
    records,
    entries: [...entryHashes.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

async function readDependencyFingerprintEntries(
  workspacePath: string,
  trackedFiles: Buffer | null,
  untrackedFiles: Buffer | null,
): Promise<
  {
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }[]
> {
  const candidates = new Set<string>();
  for (const encoded of [trackedFiles, untrackedFiles]) {
    if (!encoded) continue;
    for (const relativePath of encoded.toString('utf8').split('\0')) {
      if (!relativePath) continue;
      if (DEPENDENCY_INPUT_NAMES.has(path.posix.basename(relativePath))) {
        assertMaterializationPath(relativePath, 'tracked');
        candidates.add(relativePath);
      }
    }
  }
  for (const relativePath of await discoverInstalledDependencyMetadata(
    workspacePath,
  )) {
    candidates.add(relativePath);
  }
  const sorted = [...candidates].sort((left, right) =>
    left.localeCompare(right),
  );
  if (sorted.length > MAX_DEPENDENCY_FINGERPRINT_FILES) {
    throw new Error('Workspace dependency fingerprint file limit exceeded');
  }
  let totalBytes = 0;
  const entries: {
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }[] = [];
  for (const relativePath of sorted) {
    const absolutePath = path.resolve(workspacePath, relativePath);
    if (!absolutePath.startsWith(`${workspacePath}${path.sep}`)) {
      throw new Error('Workspace dependency fingerprint path escaped its root');
    }
    const metadata = await lstat(absolutePath).catch(() => null);
    if (!metadata) continue;
    if (!metadata.isFile()) {
      throw new Error(
        `Workspace dependency fingerprint supports only regular files: ${relativePath}`,
      );
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_DEPENDENCY_FINGERPRINT_BYTES) {
      throw new Error('Workspace dependency fingerprint byte limit exceeded');
    }
    const content = normalizeWorkspaceDependencyFingerprintContent(
      relativePath,
      await readFile(absolutePath),
    );
    entries.push({
      relativePath: relativePath.replaceAll(path.sep, '/'),
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return entries;
}

async function discoverInstalledDependencyMetadata(
  workspacePath: string,
): Promise<string[]> {
  const results: string[] = [];
  const pending = [''];
  let scanned = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directory = relativeDirectory
      ? path.join(workspacePath, relativeDirectory)
      : workspacePath;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_DEPENDENCY_FINGERPRINT_FILES * 20) {
        throw new Error('Workspace dependency metadata scan limit exceeded');
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.name === 'node_modules') {
        results.push(
          path.join(relativePath, '.modules.yaml'),
          path.join(relativePath, '.pnpm', 'lock.yaml'),
        );
        continue;
      }
      if (
        ![
          '.git',
          '.clodex',
          '.next',
          '.turbo',
          'build',
          'coverage',
          'dist',
          'out',
        ].includes(entry.name)
      ) {
        pending.push(relativePath);
      }
    }
  }
  return results;
}

async function readIgnorePolicy(workspacePath: string): Promise<string> {
  const names = ['.gitignore', '.ignore'];
  const files = await Promise.all(
    names.map(async (name) => {
      const content = await readFile(
        path.join(workspacePath, name),
        'utf-8',
      ).catch(() => '');
      return `${name}\0${content}`;
    }),
  );
  return [
    'clodex-workspace-ignore-v1',
    '.git',
    '.clodex',
    'node_modules',
    ...files,
  ].join('\0');
}

function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
      },
      (error, stdout) => {
        resolve(error ? null : stdout.trim());
      },
    );
  });
}

function runGitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: null,
        maxBuffer: MAX_MATERIALIZATION_INPUT_BYTES,
        timeout: 30_000,
      },
      (error, stdout) => {
        resolve(error ? null : Buffer.from(stdout));
      },
    );
  });
}

async function readUntrackedFiles(
  workspacePath: string,
  encodedPaths: Buffer | null,
  initialBytes: number,
): Promise<WorkspaceMaterializationFile[]> {
  if (!encodedPaths || encodedPaths.byteLength === 0) return [];
  const paths = encodedPaths
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  if (paths.some((relativePath) => relativePath.includes('\uFFFD'))) {
    throw new Error('Workspace materialization path is not valid UTF-8');
  }
  for (const relativePath of paths) {
    assertMaterializationPath(relativePath, 'untracked');
  }
  if (paths.length > MAX_UNTRACKED_FILES) {
    throw new Error('Workspace materialization untracked file limit exceeded');
  }
  let totalBytes = initialBytes;
  const files: WorkspaceMaterializationFile[] = [];
  for (const relativePath of paths) {
    const absolutePath = path.resolve(workspacePath, relativePath);
    if (
      absolutePath !== workspacePath &&
      !absolutePath.startsWith(`${workspacePath}${path.sep}`)
    ) {
      throw new Error('Workspace materialization path escaped its root');
    }
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) {
      throw new Error(
        `Workspace materialization supports only regular files: ${relativePath}`,
      );
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_MATERIALIZATION_INPUT_BYTES) {
      throw new Error('Workspace materialization byte limit exceeded');
    }
    files.push({
      relativePath,
      mode: stat.mode & 0o777,
      content: await readFile(absolutePath),
    });
  }
  return files;
}

function assertMaterializationPaths(
  encodedPaths: Buffer | null,
  kind: 'tracked' | 'untracked',
): void {
  if (!encodedPaths || encodedPaths.byteLength === 0) return;
  const paths = encodedPaths.toString('utf8').split('\0').filter(Boolean);
  if (paths.some((relativePath) => relativePath.includes('\uFFFD'))) {
    throw new Error('Workspace materialization path is not valid UTF-8');
  }
  for (const relativePath of paths) {
    assertMaterializationPath(relativePath, kind);
  }
}

function assertMaterializationPath(
  relativePath: string,
  kind: 'tracked' | 'untracked',
): void {
  const normalized = relativePath.replaceAll('\\', '/');
  const topLevel = normalized.split('/')[0];
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    containsControlCharacter(normalized) ||
    normalized
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..') ||
    topLevel === '.git' ||
    topLevel === '.clodex'
  ) {
    throw new Error(
      `Workspace materialization rejected protected ${kind} path: ${relativePath}`,
    );
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hashOpaqueIdentity(kind: string, value: string): string {
  return createHash('sha256')
    .update(`clodex:${kind}\0${value.trim()}`)
    .digest('hex');
}
