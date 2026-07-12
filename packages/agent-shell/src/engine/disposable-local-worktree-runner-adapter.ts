import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  hashWorkspaceDependencyFingerprint,
  normalizeWorkspaceDependencyFingerprintContent,
} from '@clodex/agent-core/agents';
import type { ShellService } from './shell-service';
import type { SessionCommandRequest, SessionCommandResult } from './types';
import {
  LocalRunnerAdapter,
  WorkspaceLeaseValidationError,
  type CommandExecutionRequest,
  type CreateExecutionSessionRequest,
  type PrepareWorkspaceRequest,
  type RunnerCapabilities,
  type RunnerDispatchResult,
  type WorkspaceExecutionMountBinding,
  type WorkspaceExecutionProvider,
  type WorkspaceLease,
} from './workspace-execution-provider';
import type {
  RunnerSecurityAuditSink,
  RunnerSigningAuthority,
  SignedRunnerJob,
} from './runner-security';

const execFileAsync = promisify(execFile);
const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_049;
const DEFAULT_MAX_DEPENDENCY_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DEPENDENCY_ENTRIES = 500_000;
const MAX_DEPENDENCY_ROOTS = 256;
const DEPENDENCY_FINGERPRINT_INPUT_NAMES = new Set([
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
const DEPENDENCY_SCAN_IGNORES = new Set([
  '.git',
  '.clodex',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'out',
]);

interface PreparedLocalWorktree {
  sourceRoot: string;
  sourceMountRoot: string;
  worktreeRoot: string;
  temporaryRoot: string;
  snapshotHash: string;
  repositoryRevision: string;
  dirtyPatchHash: string;
  dependencyMaterialization:
    | 'none'
    | 'copy-on-write'
    | 'cargo-cache'
    | 'go-cache';
  dependencyFingerprintHash: string | null;
  snapshotDependencyFingerprintHash: string | null;
  executionEnvironment: Record<string, string>;
}

interface StoredReplayLease {
  delegateLease: WorkspaceLease;
  prepared: PreparedLocalWorktree;
  ownsWorkspace: boolean;
}

interface TarEntry {
  relativePath: string;
  mode: number;
  content: Buffer;
}

/**
 * Replay-only local provider.
 *
 * Every first lease materializes the exact Git revision and dirty archive into
 * a detached temporary worktree. Synthetic session resumes reuse that
 * worktree, and kill/dispose always removes it. This provider is deliberately
 * not suitable for normal routing.
 */
export class DisposableLocalWorktreeRunnerAdapter
  implements WorkspaceExecutionProvider
{
  public readonly kind = 'local' as const;
  public readonly isDisposableReplayProvider = true as const;
  public readonly replayDependencyIsolation = 'copy-on-write' as const;
  public readonly replayIsolationProfiles = [
    'node-copy-on-write',
    'cargo-cache',
    'go-cache',
  ] as const;
  public readonly receiptPublicKey: string;
  private readonly delegate: LocalRunnerAdapter;
  private readonly leases = new Map<string, StoredReplayLease>();
  private readonly sessions = new Map<string, PreparedLocalWorktree>();

  public constructor(
    private readonly shellService: ShellService,
    options: {
      id?: string;
      receiptAuthority: RunnerSigningAuthority;
      trustedGuardianPublicKey: string;
      audit?: RunnerSecurityAuditSink;
      now?: () => number;
      createId?: () => string;
      maxDependencyBytes?: number;
      maxDependencyEntries?: number;
      resolveCargoHome?: () => Promise<string>;
      resolveGoModuleCache?: () => Promise<string>;
    },
  ) {
    this.id = options.id ?? 'local-runner';
    this.delegate = new LocalRunnerAdapter(shellService, {
      id: this.id,
      receiptAuthority: options.receiptAuthority,
      trustedGuardianPublicKey: options.trustedGuardianPublicKey,
      audit: options.audit,
      now: options.now,
      createId: options.createId,
      mapCreateSessionCwd: (lease, cwd) => this.remapLeaseCwd(lease, cwd),
      mapExecutionCommand: (lease, command) =>
        this.mapLeaseCommand(lease, command),
    });
    this.receiptPublicKey = this.delegate.receiptPublicKey;
    this.maxDependencyBytes =
      options.maxDependencyBytes ?? DEFAULT_MAX_DEPENDENCY_BYTES;
    this.maxDependencyEntries =
      options.maxDependencyEntries ?? DEFAULT_MAX_DEPENDENCY_ENTRIES;
    this.resolveCargoHome =
      options.resolveCargoHome ??
      (async () =>
        path.resolve(
          process.env.CARGO_HOME?.trim() || path.join(os.homedir(), '.cargo'),
        ));
    this.resolveGoModuleCache =
      options.resolveGoModuleCache ??
      (async () =>
        (
          await execFileAsync('go', ['env', 'GOMODCACHE'], {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout.trim());
  }

  public readonly id: string;
  private readonly maxDependencyBytes: number;
  private readonly maxDependencyEntries: number;
  private readonly resolveCargoHome: () => Promise<string>;
  private readonly resolveGoModuleCache: () => Promise<string>;

  public async getCapabilities(): Promise<RunnerCapabilities> {
    return {
      persistentSessions: false,
      streamingOutput: false,
      stdin: false,
      cancellation: true,
      workspaceLeases: true,
    };
  }

  public async prepareWorkspace(
    request: PrepareWorkspaceRequest,
  ): Promise<WorkspaceLease> {
    const mount = requireSingleMount(request.mounts);
    let prepared: PreparedLocalWorktree;
    let ownsWorkspace: boolean;
    if (request.resumeSessionId) {
      const existing = this.sessions.get(request.resumeSessionId);
      if (!existing) {
        throw new WorkspaceLeaseValidationError(
          'Disposable local replay session is unknown or expired',
        );
      }
      assertPreparedMatches(existing, request, mount);
      prepared = existing;
      ownsWorkspace = false;
    } else {
      prepared = await materializeDisposableWorktree(
        request.snapshotHash,
        mount,
        request.dependencyMaterialization ?? 'none',
        {
          maxBytes: this.maxDependencyBytes,
          maxEntries: this.maxDependencyEntries,
        },
        {
          resolveCargoHome: this.resolveCargoHome,
          resolveGoModuleCache: this.resolveGoModuleCache,
        },
      );
      ownsWorkspace = true;
    }
    try {
      const delegateLease = await this.delegate.prepareWorkspace({
        ...request,
        resumeSessionId: undefined,
        mounts: [remapMount(mount, prepared.worktreeRoot)],
      });
      this.leases.set(delegateLease.id, {
        delegateLease,
        prepared,
        ownsWorkspace,
      });
      return delegateLease;
    } catch (error) {
      if (ownsWorkspace) await releasePreparedWorktree(prepared);
      throw error;
    }
  }

  public async createSession(
    lease: WorkspaceLease,
    request: CreateExecutionSessionRequest,
  ): Promise<RunnerDispatchResult<string>> {
    const current = this.requireLease(lease);
    const result = await this.delegate.createSession(
      current.delegateLease,
      request,
    );
    this.sessions.set(result.value, current.prepared);
    current.ownsWorkspace = false;
    return result;
  }

  public async execute(
    lease: WorkspaceLease,
    request: CommandExecutionRequest,
  ): Promise<RunnerDispatchResult<SessionCommandResult>> {
    const current = this.requireLease(lease);
    const sessionId = request.command.sessionId;
    if (!sessionId || this.sessions.get(sessionId) !== current.prepared) {
      throw new WorkspaceLeaseValidationError(
        'Disposable local replay command is not bound to its worktree session',
      );
    }
    return await this.delegate.execute(current.delegateLease, request);
  }

  public async killSession(
    lease: WorkspaceLease,
    request: {
      snapshotHash: string;
      sessionId: string;
      signedJob: SignedRunnerJob;
    },
  ): Promise<RunnerDispatchResult<boolean>> {
    const current = this.requireLease(lease);
    try {
      return await this.delegate.killSession(current.delegateLease, request);
    } finally {
      this.sessions.delete(request.sessionId);
      current.ownsWorkspace = true;
      await releasePreparedWorktree(current.prepared);
      current.ownsWorkspace = false;
    }
  }

  public getRecentOutputForClassifier(
    sessionId: string,
    maxLines: number,
  ): string | undefined {
    return this.delegate.getRecentOutputForClassifier(sessionId, maxLines);
  }

  public getSessionCurrentCwd(sessionId: string): string | undefined {
    return this.delegate.getSessionCurrentCwd(sessionId);
  }

  public clearPendingOutputs(
    agentInstanceId: string,
    toolCallId: string,
  ): void {
    this.delegate.clearPendingOutputs(agentInstanceId, toolCallId);
  }

  public async disposeWorkspace(lease: WorkspaceLease): Promise<void> {
    const current = this.leases.get(lease.id);
    this.leases.delete(lease.id);
    await this.delegate.disposeWorkspace(lease);
    if (current?.ownsWorkspace) {
      await releasePreparedWorktree(current.prepared);
    }
  }

  public async dispose(): Promise<void> {
    const prepared = new Set<PreparedLocalWorktree>();
    for (const sessionId of this.sessions.keys()) {
      this.shellService.killSession(sessionId);
    }
    for (const lease of this.leases.values()) prepared.add(lease.prepared);
    for (const value of this.sessions.values()) prepared.add(value);
    this.leases.clear();
    this.sessions.clear();
    await Promise.all(
      Array.from(prepared, (value) =>
        releasePreparedWorktree(value).catch(() => undefined),
      ),
    );
  }

  private requireLease(lease: WorkspaceLease): StoredReplayLease {
    const current = this.leases.get(lease.id);
    if (!current || lease.providerId !== this.id) {
      throw new WorkspaceLeaseValidationError(
        'Disposable local replay lease is unknown or disposed',
      );
    }
    return current;
  }

  private remapLeaseCwd(lease: WorkspaceLease, cwd: string): string {
    const current = this.requireLease(lease);
    return remapCwd(
      current.prepared.sourceMountRoot,
      current.prepared.worktreeRoot,
      cwd,
    );
  }

  private mapLeaseCommand(
    lease: WorkspaceLease,
    command: SessionCommandRequest,
  ): SessionCommandRequest {
    const current = this.requireLease(lease);
    return {
      ...command,
      command: wrapReplayCommand(current.prepared, command.command),
      cwd: command.cwd
        ? remapCwd(
            current.prepared.sourceMountRoot,
            current.prepared.worktreeRoot,
            command.cwd,
          )
        : undefined,
    };
  }
}

async function materializeDisposableWorktree(
  snapshotHash: string,
  mount: WorkspaceExecutionMountBinding,
  dependencyMaterialization:
    | 'none'
    | 'copy-on-write'
    | 'cargo-cache'
    | 'go-cache',
  dependencyLimits: {
    maxBytes: number;
    maxEntries: number;
  },
  dependencyResolvers: {
    resolveCargoHome: () => Promise<string>;
    resolveGoModuleCache: () => Promise<string>;
  },
): Promise<PreparedLocalWorktree> {
  if (!mount.repositoryRevision || !mount.materialization) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local replay requires a Git revision and materialization',
    );
  }
  assertSha256(snapshotHash, 'Workspace snapshot hash');
  assertGitRevision(mount.repositoryRevision);
  assertSha256(mount.dirtyPatchHash, 'Workspace dirty patch hash');
  if (dependencyMaterialization !== 'none') {
    assertSha256(
      mount.dependencyFingerprintHash ?? '',
      'Workspace dependency fingerprint hash',
    );
  }
  const archive = Buffer.from(mount.materialization.archive);
  if (
    mount.materialization.version !== 1 ||
    mount.materialization.archiveFormat !== 'tar-gzip' ||
    archive.byteLength !== mount.materialization.totalBytes ||
    archive.byteLength > MAX_ARCHIVE_BYTES ||
    sha256(archive) !== mount.materialization.archiveHash
  ) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local replay materialization is invalid',
    );
  }
  const sourceRoot = await realpath(mount.workspaceRoot);
  const repositoryRoot = (
    await runGit(sourceRoot, ['rev-parse', '--show-toplevel'])
  ).trim();
  if ((await realpath(repositoryRoot)) !== sourceRoot) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local replay v1 requires a repository-root mount',
    );
  }
  const entries = parseMaterializationArchive(archive);
  assertDirtyPatchHash(entries, mount.dirtyPatchHash);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), `clodex-local-replay-${snapshotHash.slice(0, 12)}-`),
  );
  const worktreeRoot = path.join(temporaryRoot, 'workspace');
  const prepared: PreparedLocalWorktree = {
    sourceRoot,
    sourceMountRoot: path.resolve(mount.workspaceRoot),
    worktreeRoot,
    temporaryRoot,
    snapshotHash,
    repositoryRevision: mount.repositoryRevision,
    dirtyPatchHash: mount.dirtyPatchHash,
    dependencyMaterialization,
    dependencyFingerprintHash: null,
    snapshotDependencyFingerprintHash: mount.dependencyFingerprintHash ?? null,
    executionEnvironment: {},
  };
  try {
    await runGit(sourceRoot, [
      'worktree',
      'add',
      '--detach',
      worktreeRoot,
      mount.repositoryRevision,
    ]);
    await applyMaterialization(prepared, entries);
    if (dependencyMaterialization === 'copy-on-write') {
      prepared.dependencyFingerprintHash =
        await materializeWorkspaceDependencies(prepared, dependencyLimits);
    } else if (dependencyMaterialization === 'cargo-cache') {
      prepared.dependencyFingerprintHash = await materializeCargoCache(
        prepared,
        dependencyLimits,
        dependencyResolvers.resolveCargoHome,
      );
    } else if (dependencyMaterialization === 'go-cache') {
      prepared.dependencyFingerprintHash = await materializeGoCache(
        prepared,
        dependencyLimits,
        dependencyResolvers.resolveGoModuleCache,
      );
    }
    if (dependencyMaterialization !== 'none') {
      const actualDependencyFingerprint =
        await computeWorkspaceDependencyFingerprint(prepared);
      if (actualDependencyFingerprint !== mount.dependencyFingerprintHash) {
        throw new WorkspaceLeaseValidationError(
          'Disposable replay dependency fingerprint does not match the snapshot',
        );
      }
      prepared.dependencyFingerprintHash = actualDependencyFingerprint;
    }
    const actualRevision = (
      await runGit(worktreeRoot, ['rev-parse', 'HEAD'])
    ).trim();
    if (actualRevision !== mount.repositoryRevision) {
      throw new WorkspaceLeaseValidationError(
        'Disposable worktree revision does not match the snapshot',
      );
    }
    return prepared;
  } catch (error) {
    await releasePreparedWorktree(prepared);
    throw error;
  }
}

async function applyMaterialization(
  prepared: PreparedLocalWorktree,
  entries: readonly TarEntry[],
): Promise<void> {
  const patch = entries.find(
    (entry) => entry.relativePath === '.clodex/tracked.patch',
  );
  if (!patch) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay archive has no tracked patch',
    );
  }
  if (patch.content.byteLength > 0) {
    const patchPath = path.join(prepared.temporaryRoot, 'tracked.patch');
    await writeFile(patchPath, patch.content, { mode: 0o600 });
    await runGit(prepared.worktreeRoot, [
      'apply',
      '--binary',
      '--whitespace=nowarn',
      patchPath,
    ]);
  }
  for (const entry of entries) {
    if (!entry.relativePath.startsWith('workspace/')) continue;
    const relativePath = entry.relativePath.slice('workspace/'.length);
    const destination = safeJoin(prepared.worktreeRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content, {
      flag: 'wx',
      mode: entry.mode,
    });
    await chmod(destination, entry.mode);
  }
}

async function materializeWorkspaceDependencies(
  prepared: PreparedLocalWorktree,
  limits: {
    maxBytes: number;
    maxEntries: number;
  },
): Promise<string> {
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes <= 0 ||
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0
  ) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay dependency limits are invalid',
    );
  }
  const dependencyRoots = await findDependencyRoots(
    prepared.sourceRoot,
    limits.maxEntries,
  );
  if (dependencyRoots.length === 0) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local build/test replay requires installed node_modules',
    );
  }
  const sourceFingerprint = await inspectDependencyRoots({
    physicalRoot: prepared.sourceRoot,
    relocationRoot: prepared.worktreeRoot,
    dependencyRoots,
    limits,
  });
  for (const relativeRoot of dependencyRoots) {
    const source = safeJoin(prepared.sourceRoot, relativeRoot);
    const destination = safeJoin(prepared.worktreeRoot, relativeRoot);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      mode: fsConstants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
  }
  const copiedFingerprint = await inspectDependencyRoots({
    physicalRoot: prepared.worktreeRoot,
    relocationRoot: prepared.worktreeRoot,
    dependencyRoots,
    limits,
  });
  if (copiedFingerprint !== sourceFingerprint) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay dependency copy failed integrity verification',
    );
  }
  prepared.executionEnvironment.PATH = buildIsolatedNodePath(
    prepared,
    dependencyRoots,
  );
  return copiedFingerprint;
}

async function materializeCargoCache(
  prepared: PreparedLocalWorktree,
  limits: {
    maxBytes: number;
    maxEntries: number;
  },
  resolveCargoHome: () => Promise<string>,
): Promise<string> {
  const sourceHome = path.resolve(await resolveCargoHome());
  const roots = (
    await Promise.all(
      ['registry', 'git'].map(async (name) =>
        (
          await lstat(path.join(sourceHome, name)).catch(() => null)
        )?.isDirectory()
          ? name
          : null,
      ),
    )
  ).filter((value): value is string => value !== null);
  if (roots.length === 0) {
    throw new WorkspaceLeaseValidationError(
      'Disposable Cargo replay requires a populated local Cargo cache',
    );
  }
  const destinationHome = path.join(
    prepared.temporaryRoot,
    'cache',
    'cargo-home',
  );
  await cloneIsolatedRoots(sourceHome, destinationHome, roots, limits);
  const targetDirectory = path.join(
    prepared.temporaryRoot,
    'cache',
    'cargo-target',
  );
  await mkdir(targetDirectory, { recursive: true });
  prepared.executionEnvironment.CARGO_HOME = destinationHome;
  prepared.executionEnvironment.CARGO_TARGET_DIR = targetDirectory;
  prepared.executionEnvironment.CARGO_NET_OFFLINE = 'true';
  return hashCanonicalEnvironment(prepared.executionEnvironment);
}

async function materializeGoCache(
  prepared: PreparedLocalWorktree,
  limits: {
    maxBytes: number;
    maxEntries: number;
  },
  resolveGoModuleCache: () => Promise<string>,
): Promise<string> {
  const sourceModuleCache = (
    await resolveGoModuleCache().catch(() => '')
  ).trim();
  const sourceMetadata = sourceModuleCache
    ? await lstat(sourceModuleCache).catch(() => null)
    : null;
  if (!sourceMetadata?.isDirectory()) {
    throw new WorkspaceLeaseValidationError(
      'Disposable Go replay requires a populated local module cache',
    );
  }
  const sourceParent = path.dirname(sourceModuleCache);
  const sourceName = path.basename(sourceModuleCache);
  const destinationParent = path.join(
    prepared.temporaryRoot,
    'cache',
    'go-module-parent',
  );
  await cloneIsolatedRoots(
    sourceParent,
    destinationParent,
    [sourceName],
    limits,
  );
  const moduleCache = path.join(destinationParent, sourceName);
  const buildCache = path.join(prepared.temporaryRoot, 'cache', 'go-build');
  const goPath = path.join(prepared.temporaryRoot, 'cache', 'go-path');
  await Promise.all([
    mkdir(buildCache, { recursive: true }),
    mkdir(goPath, { recursive: true }),
  ]);
  prepared.executionEnvironment.GOCACHE = buildCache;
  prepared.executionEnvironment.GOMODCACHE = moduleCache;
  prepared.executionEnvironment.GOPATH = goPath;
  prepared.executionEnvironment.GOPROXY = 'off';
  prepared.executionEnvironment.GOSUMDB = 'off';
  prepared.executionEnvironment.GOTOOLCHAIN = 'local';
  return hashCanonicalEnvironment(prepared.executionEnvironment);
}

async function cloneIsolatedRoots(
  sourceRoot: string,
  destinationRoot: string,
  roots: readonly string[],
  limits: {
    maxBytes: number;
    maxEntries: number;
  },
): Promise<void> {
  const sourceFingerprint = await inspectDependencyRoots({
    physicalRoot: sourceRoot,
    relocationRoot: destinationRoot,
    dependencyRoots: roots,
    limits,
  });
  await mkdir(destinationRoot, { recursive: true });
  for (const relativeRoot of roots) {
    await cp(
      safeJoin(sourceRoot, relativeRoot),
      safeJoin(destinationRoot, relativeRoot),
      {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        mode: fsConstants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
      },
    );
  }
  const destinationFingerprint = await inspectDependencyRoots({
    physicalRoot: destinationRoot,
    relocationRoot: destinationRoot,
    dependencyRoots: roots,
    limits,
  });
  if (destinationFingerprint !== sourceFingerprint) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay cache copy failed integrity verification',
    );
  }
}

function buildIsolatedNodePath(
  prepared: PreparedLocalWorktree,
  dependencyRoots: readonly string[],
): string {
  const dependencyBins = dependencyRoots.map((relativeRoot) =>
    path.join(prepared.worktreeRoot, relativeRoot, '.bin'),
  );
  const systemEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const resolved = path.resolve(entry);
      return (
        !resolved.includes(`${path.sep}node_modules${path.sep}.bin`) &&
        resolved !== prepared.sourceRoot &&
        !resolved.startsWith(`${prepared.sourceRoot}${path.sep}`)
      );
    });
  return [...dependencyBins, ...systemEntries].join(path.delimiter);
}

function hashCanonicalEnvironment(environment: Record<string, string>): string {
  return sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(environment).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  );
}

async function computeWorkspaceDependencyFingerprint(
  prepared: PreparedLocalWorktree,
): Promise<string> {
  const [tracked, untracked, dependencyRoots] = await Promise.all([
    runGitBuffer(prepared.worktreeRoot, ['ls-files', '-z']),
    runGitBuffer(prepared.worktreeRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
    findDependencyRoots(prepared.sourceRoot, DEFAULT_MAX_DEPENDENCY_ENTRIES),
  ]);
  const sources = new Map<string, string>();
  for (const encoded of [tracked, untracked]) {
    for (const relativePath of encoded.toString('utf8').split('\0')) {
      if (
        relativePath &&
        DEPENDENCY_FINGERPRINT_INPUT_NAMES.has(
          path.posix.basename(relativePath),
        )
      ) {
        sources.set(relativePath, prepared.worktreeRoot);
      }
    }
  }
  for (const dependencyRoot of dependencyRoots) {
    for (const relativePath of [
      path.join(dependencyRoot, '.modules.yaml'),
      path.join(dependencyRoot, '.pnpm', 'lock.yaml'),
    ]) {
      if (
        await lstat(safeJoin(prepared.sourceRoot, relativePath)).catch(
          () => null,
        )
      ) {
        sources.set(relativePath, prepared.sourceRoot);
      }
    }
  }
  const entries: {
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }[] = [];
  let totalBytes = 0;
  for (const [relativePath, sourceRoot] of [...sources.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const content = normalizeWorkspaceDependencyFingerprintContent(
      relativePath,
      await readFile(safeJoin(sourceRoot, relativePath)),
    );
    totalBytes += content.byteLength;
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new WorkspaceLeaseValidationError(
        'Disposable replay dependency fingerprint exceeds byte limits',
      );
    }
    entries.push({
      relativePath: relativePath.replaceAll(path.sep, '/'),
      sizeBytes: content.byteLength,
      sha256: sha256(content),
    });
  }
  return hashWorkspaceDependencyFingerprint(entries);
}

function wrapReplayCommand(
  prepared: PreparedLocalWorktree,
  command: string,
): string {
  const assignments = Object.entries(prepared.executionEnvironment).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (assignments.length === 0) return command;
  return `env ${assignments
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(' ')} ${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function findDependencyRoots(
  workspaceRoot: string,
  maxScannedEntries: number,
): Promise<string[]> {
  const roots: string[] = [];
  const pending = [''];
  let scannedEntries = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directory = relativeDirectory
      ? safeJoin(workspaceRoot, relativeDirectory)
      : workspaceRoot;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > maxScannedEntries) {
        throw new WorkspaceLeaseValidationError(
          'Disposable replay dependency discovery exceeds entry limits',
        );
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.name === 'node_modules') {
        roots.push(relativePath);
        if (roots.length > MAX_DEPENDENCY_ROOTS) {
          throw new WorkspaceLeaseValidationError(
            'Disposable replay has too many dependency roots',
          );
        }
        continue;
      }
      if (!DEPENDENCY_SCAN_IGNORES.has(entry.name)) {
        pending.push(relativePath);
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

async function inspectDependencyRoots(input: {
  physicalRoot: string;
  relocationRoot: string;
  dependencyRoots: readonly string[];
  limits: {
    maxBytes: number;
    maxEntries: number;
  };
}): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ version: 1, roots: input.dependencyRoots }));
  let totalBytes = 0;
  let totalEntries = 0;
  for (const relativeRoot of input.dependencyRoots) {
    const pending = [relativeRoot];
    while (pending.length > 0) {
      const relativePath = pending.pop()!;
      const physicalPath = safeJoin(input.physicalRoot, relativePath);
      const metadata = await lstat(physicalPath);
      totalEntries += 1;
      if (totalEntries > input.limits.maxEntries) {
        throw new WorkspaceLeaseValidationError(
          'Disposable replay dependencies exceed entry limits',
        );
      }
      if (metadata.isDirectory()) {
        hash.update(
          JSON.stringify([
            relativePath.replaceAll(path.sep, '/'),
            'directory',
            metadata.mode & 0o777,
          ]),
        );
        const children = await readdir(physicalPath);
        children.sort((left, right) => right.localeCompare(left));
        for (const child of children) {
          pending.push(path.join(relativePath, child));
        }
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(physicalPath);
        assertRelocatedDependencyLinkIsSafe(
          input.relocationRoot,
          relativePath,
          target,
        );
        hash.update(
          JSON.stringify([
            relativePath.replaceAll(path.sep, '/'),
            'symlink',
            target,
          ]),
        );
        continue;
      }
      if (!metadata.isFile()) {
        throw new WorkspaceLeaseValidationError(
          'Disposable replay dependencies contain a special file',
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > input.limits.maxBytes) {
        throw new WorkspaceLeaseValidationError(
          'Disposable replay dependencies exceed byte limits',
        );
      }
      hash.update(
        JSON.stringify([
          relativePath.replaceAll(path.sep, '/'),
          'file',
          metadata.mode & 0o777,
          metadata.size,
        ]),
      );
    }
  }
  hash.update(JSON.stringify({ totalBytes, totalEntries }));
  return hash.digest('hex');
}

function assertRelocatedDependencyLinkIsSafe(
  worktreeRoot: string,
  relativePath: string,
  target: string,
): void {
  if (path.isAbsolute(target)) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay dependencies contain an absolute symbolic link',
    );
  }
  const relocatedLink = safeJoin(worktreeRoot, relativePath);
  const resolvedTarget = path.resolve(path.dirname(relocatedLink), target);
  const resolvedRoot = path.resolve(worktreeRoot);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay dependency link escapes the worktree',
    );
  }
}

function parseMaterializationArchive(archive: Buffer): TarEntry[] {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES });
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let totalBytes = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    assertTarChecksum(header);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const type = header[156];
    const size = readTarOctal(header, 124, 12);
    const mode = readTarOctal(header, 100, 8) & 0o777;
    if (
      (type !== 0 && type !== '0'.charCodeAt(0)) ||
      !isAllowedArchivePath(relativePath) ||
      seen.has(relativePath)
    ) {
      throw new WorkspaceLeaseValidationError(
        'Disposable replay archive contains an unsafe entry',
      );
    }
    const contentStart = offset + TAR_BLOCK_SIZE;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.byteLength) {
      throw new WorkspaceLeaseValidationError(
        'Disposable replay archive is truncated',
      );
    }
    totalBytes += size;
    if (
      totalBytes > MAX_EXTRACTED_BYTES ||
      entries.length >= MAX_ARCHIVE_ENTRIES
    ) {
      throw new WorkspaceLeaseValidationError(
        'Disposable replay archive exceeds extraction limits',
      );
    }
    seen.add(relativePath);
    entries.push({
      relativePath,
      mode: mode || 0o600,
      content: Buffer.from(tar.subarray(contentStart, contentEnd)),
    });
    offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return entries;
}

function assertDirtyPatchHash(
  entries: readonly TarEntry[],
  expectedHash: string,
): void {
  const patch = entries.find(
    (entry) => entry.relativePath === '.clodex/tracked.patch',
  );
  if (!patch) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay archive has no tracked patch',
    );
  }
  const files = entries
    .filter((entry) => entry.relativePath.startsWith('workspace/'))
    .map((entry) => ({
      relativePath: entry.relativePath.slice('workspace/'.length),
      mode: entry.mode,
      sizeBytes: entry.content.byteLength,
      sha256: sha256(entry.content),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const actualHash = sha256(
    JSON.stringify({
      version: 1,
      trackedPatchHash: sha256(patch.content),
      untrackedFiles: files,
    }),
  );
  if (actualHash !== expectedHash) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay dirty state does not match the snapshot',
    );
  }
}

async function releasePreparedWorktree(
  prepared: PreparedLocalWorktree,
): Promise<void> {
  await execFileAsync(
    'git',
    [
      '-C',
      prepared.sourceRoot,
      'worktree',
      'remove',
      '--force',
      prepared.worktreeRoot,
    ],
    { timeout: 30_000 },
  ).catch(() => undefined);
  await rm(prepared.temporaryRoot, { recursive: true, force: true });
  await execFileAsync('git', ['-C', prepared.sourceRoot, 'worktree', 'prune'], {
    timeout: 30_000,
  }).catch(() => undefined);
}

function requireSingleMount(
  mounts: readonly WorkspaceExecutionMountBinding[] | undefined,
): WorkspaceExecutionMountBinding {
  if (mounts?.length !== 1 || !mounts[0]) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local replay requires exactly one workspace mount',
    );
  }
  return mounts[0];
}

function remapMount(
  mount: WorkspaceExecutionMountBinding,
  worktreeRoot: string,
): WorkspaceExecutionMountBinding {
  return {
    ...mount,
    workspaceRoot: worktreeRoot,
    materialization: undefined,
  };
}

function remapCwd(
  sourceRoot: string,
  worktreeRoot: string,
  cwd: string,
): string {
  const resolved = path.resolve(cwd || sourceRoot);
  const relative = path.relative(sourceRoot, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local replay cwd escaped the source workspace',
    );
  }
  return path.join(worktreeRoot, relative);
}

function assertPreparedMatches(
  prepared: PreparedLocalWorktree,
  request: PrepareWorkspaceRequest,
  mount: WorkspaceExecutionMountBinding,
): void {
  if (
    prepared.snapshotHash !== request.snapshotHash ||
    prepared.sourceMountRoot !== path.resolve(mount.workspaceRoot) ||
    prepared.repositoryRevision !== mount.repositoryRevision ||
    prepared.dirtyPatchHash !== mount.dirtyPatchHash ||
    prepared.snapshotDependencyFingerprintHash !==
      (mount.dependencyFingerprintHash ?? null) ||
    prepared.dependencyMaterialization !==
      (request.dependencyMaterialization ?? 'none')
  ) {
    throw new WorkspaceLeaseValidationError(
      'Disposable local replay session snapshot mismatch',
    );
  }
}

function isAllowedArchivePath(value: string): boolean {
  if (value === '.clodex/tracked.patch') return true;
  if (!value.startsWith('workspace/')) return false;
  const relativePath = value.slice('workspace/'.length);
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split('/');
  return !segments.some(
    (segment) =>
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment === '.git' ||
      segment === '.clodex',
  );
}

function safeJoin(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay archive escaped the worktree',
    );
  }
  return target;
}

function assertTarChecksum(header: Buffer): void {
  const expected = readTarOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay archive checksum is invalid',
    );
  }
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  return buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/s, '')
    .trim();
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const value = readTarString(buffer, offset, length).trim();
  if (!/^[0-7]*$/.test(value)) {
    throw new WorkspaceLeaseValidationError(
      'Disposable replay archive numeric field is invalid',
    );
  }
  return value ? Number.parseInt(value, 8) : 0;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    return result.stdout;
  } catch (error) {
    const failure = new WorkspaceLeaseValidationError(
      `Disposable local replay Git operation failed: ${args[0] ?? 'unknown'}`,
    );
    failure.cause = error;
    throw failure;
  }
}

async function runGitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    return Buffer.from(result.stdout);
  } catch (error) {
    const failure = new WorkspaceLeaseValidationError(
      `Disposable local replay Git operation failed: ${args[0] ?? 'unknown'}`,
    );
    failure.cause = error;
    throw failure;
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new WorkspaceLeaseValidationError(`${label} is invalid`);
  }
}

function assertGitRevision(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new WorkspaceLeaseValidationError('Repository revision is invalid');
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
