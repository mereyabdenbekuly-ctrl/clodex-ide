import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { hashWorkspaceDependencyFingerprint } from '@clodex/agent-core/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisposableLocalWorktreeRunnerAdapter } from './disposable-local-worktree-runner-adapter';
import { P256RunnerSigningAuthority } from './runner-security';
import type { ShellService } from './shell-service';
import { executeDisposableRunnerReplay } from './workspace-execution-provider';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('DisposableLocalWorktreeRunnerAdapter', () => {
  it('materializes dirty state, executes in a detached worktree, and removes it', async () => {
    const repository = await createRepository();
    await writeFile(
      path.join(repository, 'src/index.ts'),
      'export const value = 2;\n',
    );
    await writeFile(path.join(repository, 'untracked.txt'), 'untracked\n');
    await chmod(path.join(repository, 'untracked.txt'), 0o640);
    const materialization = await createMaterialization(repository);
    let replayCwd = '';
    const shell = {
      isAvailable: vi.fn(() => true),
      createSession: vi.fn((_agentId, _toolId, cwd: string) => {
        replayCwd = cwd;
        return 'session-1';
      }),
      executeInSession: vi.fn(async () => {
        await writeFile(path.join(replayCwd, 'replay-only.txt'), 'isolated\n');
        return {
          sessionId: 'session-1',
          output: `${await readFile(path.join(replayCwd, 'src/index.ts'), 'utf8')}${await readFile(path.join(replayCwd, 'untracked.txt'), 'utf8')}`,
          exitCode: 0,
          sessionExited: false,
          timedOut: false,
          resolvedBy: 'exit' as const,
        };
      }),
      killSession: vi.fn(() => true),
      getRecentOutputForClassifier: vi.fn(() => undefined),
      getSessionCurrentCwd: vi.fn(() => replayCwd),
      clearPendingOutputs: vi.fn(),
    } as unknown as ShellService;
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const receipt = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell, {
      receiptAuthority: receipt,
      trustedGuardianPublicKey: guardian.publicKey,
    });

    const evidence = await executeDisposableRunnerReplay({
      provider,
      snapshotIdentity: {
        snapshotHash: 'a'.repeat(64),
        environmentFingerprintHash: 'b'.repeat(64),
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: repository,
            repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
            dirtyPatchHash: materialization.dirtyPatchHash,
            hasDirtyChanges: true,
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: materialization.archive,
              archiveHash: sha256(materialization.archive),
              totalBytes: materialization.archive.byteLength,
            },
          },
        ],
      },
      authority: guardian,
      command: { command: 'git status --short', cwd: repository },
      agentInstanceId: 'agent-1',
      decisionId: '00000000-0000-4000-8000-000000000001',
      timeoutMs: 5_000,
    });

    expect(evidence).toMatchObject({
      providerId: 'local-runner',
      providerKind: 'local',
      operation: 'execute-command',
      outcome: 'completed',
    });
    expect(shell.createSession).toHaveBeenCalledOnce();
    expect(replayCwd).not.toBe(repository);
    expect(replayCwd).toContain('clodex-local-replay-');
    await expect(stat(replayCwd)).rejects.toThrow();
    await expect(
      readFile(path.join(repository, 'src/index.ts'), 'utf8'),
    ).resolves.toBe('export const value = 2;\n');
    await expect(
      readFile(path.join(repository, 'replay-only.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('rejects an archive not bound to the dirty snapshot before shell dispatch', async () => {
    const repository = await createRepository();
    const materialization = await createMaterialization(repository);
    const shell = {
      isAvailable: vi.fn(() => true),
      createSession: vi.fn(() => 'session-1'),
      executeInSession: vi.fn(),
      killSession: vi.fn(() => true),
      getRecentOutputForClassifier: vi.fn(),
      getSessionCurrentCwd: vi.fn(),
      clearPendingOutputs: vi.fn(),
    } as unknown as ShellService;
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
    });

    await expect(
      provider.prepareWorkspace({
        snapshotHash: 'a'.repeat(64),
        environmentFingerprintHash: 'b'.repeat(64),
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: repository,
            repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
            dirtyPatchHash: 'f'.repeat(64),
            hasDirtyChanges: false,
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: materialization.archive,
              archiveHash: sha256(materialization.archive),
              totalBytes: materialization.archive.byteLength,
            },
          },
        ],
      }),
    ).rejects.toThrow('dirty state does not match');
    expect(shell.createSession).not.toHaveBeenCalled();
  });

  it('copy-on-write materializes dependencies for local build/test replay', async () => {
    const repository = await createRepository();
    await mkdir(path.join(repository, 'node_modules/example'), {
      recursive: true,
    });
    await writeFile(
      path.join(repository, 'node_modules/example/index.js'),
      'module.exports = 1;\n',
    );
    await symlink(
      'example',
      path.join(repository, 'node_modules/example-link'),
      'dir',
    );
    const materialization = await createMaterialization(repository);
    let replayCwd = '';
    const shell = {
      isAvailable: vi.fn(() => true),
      createSession: vi.fn((_agentId, _toolId, cwd: string) => {
        replayCwd = cwd;
        return 'session-1';
      }),
      executeInSession: vi.fn(async () => {
        const dependencyPath = path.join(
          replayCwd,
          'node_modules/example/index.js',
        );
        const original = await readFile(dependencyPath, 'utf8');
        await writeFile(dependencyPath, 'module.exports = 2;\n');
        return {
          sessionId: 'session-1',
          output: original,
          exitCode: 0,
          sessionExited: false,
          timedOut: false,
          resolvedBy: 'exit' as const,
        };
      }),
      killSession: vi.fn(() => true),
      getRecentOutputForClassifier: vi.fn(() => undefined),
      getSessionCurrentCwd: vi.fn(() => replayCwd),
      clearPendingOutputs: vi.fn(),
    } as unknown as ShellService;
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
    });

    const evidence = await executeDisposableRunnerReplay({
      provider,
      snapshotIdentity: {
        snapshotHash: 'a'.repeat(64),
        environmentFingerprintHash: 'b'.repeat(64),
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: repository,
            repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
            dirtyPatchHash: materialization.dirtyPatchHash,
            dependencyFingerprintHash: hashWorkspaceDependencyFingerprint([]),
            hasDirtyChanges: false,
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: materialization.archive,
              archiveHash: sha256(materialization.archive),
              totalBytes: materialization.archive.byteLength,
            },
          },
        ],
      },
      authority: guardian,
      command: { command: 'pnpm test', cwd: repository },
      agentInstanceId: 'agent-1',
      decisionId: '00000000-0000-4000-8000-000000000001',
      timeoutMs: 5_000,
    });

    expect(evidence.outcome).toBe('completed');
    expect(shell.executeInSession).toHaveBeenCalledOnce();
    await expect(stat(replayCwd)).rejects.toThrow();
    await expect(
      readFile(path.join(repository, 'node_modules/example/index.js'), 'utf8'),
    ).resolves.toBe('module.exports = 1;\n');
  });

  it('rejects a stale dependency fingerprint before shell dispatch', async () => {
    const repository = await createRepository();
    await mkdir(path.join(repository, 'node_modules/example'), {
      recursive: true,
    });
    await writeFile(
      path.join(repository, 'node_modules/example/index.js'),
      'module.exports = 1;\n',
    );
    const materialization = await createMaterialization(repository);
    const shell = createShellDouble();
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell.service, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
    });

    await expect(
      executeDisposableRunnerReplay({
        provider,
        snapshotIdentity: {
          snapshotHash: 'a'.repeat(64),
          environmentFingerprintHash: 'b'.repeat(64),
          mounts: [
            {
              mountPrefix: 'work',
              workspaceRoot: repository,
              repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
              dirtyPatchHash: materialization.dirtyPatchHash,
              dependencyFingerprintHash: 'f'.repeat(64),
              hasDirtyChanges: false,
              materialization: {
                version: 1,
                archiveFormat: 'tar-gzip',
                archive: materialization.archive,
                archiveHash: sha256(materialization.archive),
                totalBytes: materialization.archive.byteLength,
              },
            },
          ],
        },
        authority: guardian,
        command: { command: 'pnpm test', cwd: repository },
        agentInstanceId: 'agent-1',
        decisionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow('dependency fingerprint does not match');
    expect(shell.createSession).not.toHaveBeenCalled();
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('isolates direct Node tool resolution to the disposable worktree', async () => {
    const repository = await createRepository();
    await mkdir(path.join(repository, 'node_modules/.bin'), {
      recursive: true,
    });
    await writeFile(
      path.join(repository, 'node_modules/.bin/vitest'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    );
    const materialization = await createMaterialization(repository);
    let replayCommand = '';
    const shell = createShellDouble(async (request) => {
      replayCommand = request.command;
    });
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell.service, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
    });

    await executeDisposableRunnerReplay({
      provider,
      snapshotIdentity: {
        snapshotHash: 'a'.repeat(64),
        environmentFingerprintHash: 'b'.repeat(64),
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: repository,
            repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
            dirtyPatchHash: materialization.dirtyPatchHash,
            dependencyFingerprintHash: hashWorkspaceDependencyFingerprint([]),
            hasDirtyChanges: false,
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: materialization.archive,
              archiveHash: sha256(materialization.archive),
              totalBytes: materialization.archive.byteLength,
            },
          },
        ],
      },
      authority: guardian,
      command: { command: 'vitest run', cwd: repository },
      agentInstanceId: 'agent-1',
      decisionId: '00000000-0000-4000-8000-000000000001',
    });

    expect(replayCommand).toContain(path.join('node_modules', '.bin'));
    expect(replayCommand).not.toContain(repository);
    expect(replayCommand).toMatch(/vitest run$/);
  });

  it('clones only Cargo caches and executes offline with an isolated target', async () => {
    const repository = await createRepository();
    await writeFile(
      path.join(repository, 'Cargo.toml'),
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    await writeFile(path.join(repository, 'Cargo.lock'), '# lock\n');
    await git(repository, ['add', 'Cargo.toml', 'Cargo.lock']);
    await git(repository, ['commit', '-m', 'cargo fixture']);
    const cargoHome = await createTemporaryDirectory('cargo-cache-');
    await mkdir(path.join(cargoHome, 'registry/src/example'), {
      recursive: true,
    });
    await mkdir(path.join(cargoHome, 'git/db/example'), { recursive: true });
    await writeFile(
      path.join(cargoHome, 'registry/src/example/lib.rs'),
      'pub fn original() {}\n',
    );
    await writeFile(path.join(cargoHome, 'credentials.toml'), 'secret\n');
    const materialization = await createMaterialization(repository);
    let replayCommand = '';
    const shell = createShellDouble(async (request) => {
      replayCommand = request.command;
      const isolatedHome = readQuotedEnv(request.command, 'CARGO_HOME');
      await writeFile(
        path.join(isolatedHome, 'registry/src/example/lib.rs'),
        'pub fn replay() {}\n',
      );
      await expect(
        stat(path.join(isolatedHome, 'credentials.toml')),
      ).rejects.toThrow();
    });
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell.service, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
      resolveCargoHome: async () => cargoHome,
    });

    await executeDisposableRunnerReplay({
      provider,
      snapshotIdentity: {
        snapshotHash: 'a'.repeat(64),
        environmentFingerprintHash: 'b'.repeat(64),
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: repository,
            repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
            dirtyPatchHash: materialization.dirtyPatchHash,
            dependencyFingerprintHash: await dependencyFingerprint(repository, [
              'Cargo.lock',
              'Cargo.toml',
            ]),
            hasDirtyChanges: false,
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: materialization.archive,
              archiveHash: sha256(materialization.archive),
              totalBytes: materialization.archive.byteLength,
            },
          },
        ],
      },
      authority: guardian,
      command: { command: 'cargo test', cwd: repository },
      agentInstanceId: 'agent-1',
      decisionId: '00000000-0000-4000-8000-000000000001',
    });

    expect(replayCommand).toContain("CARGO_NET_OFFLINE='true'");
    expect(replayCommand).toContain("CARGO_TARGET_DIR='");
    await expect(
      readFile(path.join(cargoHome, 'registry/src/example/lib.rs'), 'utf8'),
    ).resolves.toBe('pub fn original() {}\n');
  });

  it('rejects a dependency-cache symlink that would escape the disposable root', async () => {
    const repository = await createRepository();
    await writeFile(
      path.join(repository, 'Cargo.toml'),
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    await git(repository, ['add', 'Cargo.toml']);
    await git(repository, ['commit', '-m', 'cargo fixture']);
    const cargoHome = await createTemporaryDirectory('cargo-cache-');
    await mkdir(path.join(cargoHome, 'registry'), { recursive: true });
    await symlink('../../outside', path.join(cargoHome, 'registry/escape'));
    const materialization = await createMaterialization(repository);
    const shell = createShellDouble();
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell.service, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
      resolveCargoHome: async () => cargoHome,
    });

    await expect(
      executeDisposableRunnerReplay({
        provider,
        snapshotIdentity: {
          snapshotHash: 'a'.repeat(64),
          environmentFingerprintHash: 'b'.repeat(64),
          mounts: [
            {
              mountPrefix: 'work',
              workspaceRoot: repository,
              repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
              dirtyPatchHash: materialization.dirtyPatchHash,
              dependencyFingerprintHash: await dependencyFingerprint(
                repository,
                ['Cargo.toml'],
              ),
              hasDirtyChanges: false,
              materialization: {
                version: 1,
                archiveFormat: 'tar-gzip',
                archive: materialization.archive,
                archiveHash: sha256(materialization.archive),
                totalBytes: materialization.archive.byteLength,
              },
            },
          ],
        },
        authority: guardian,
        command: { command: 'cargo test', cwd: repository },
        agentInstanceId: 'agent-1',
        decisionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow('dependency link escapes');
    expect(shell.createSession).not.toHaveBeenCalled();
  });

  it('clones the Go module cache and disables downloads and toolchain switching', async () => {
    const repository = await createRepository();
    await writeFile(
      path.join(repository, 'go.mod'),
      'module example.test/app\n',
    );
    await writeFile(
      path.join(repository, 'go.sum'),
      'example.test/mod v1 h1:x\n',
    );
    await git(repository, ['add', 'go.mod', 'go.sum']);
    await git(repository, ['commit', '-m', 'go fixture']);
    const goRoot = await createTemporaryDirectory('go-cache-');
    const moduleCache = path.join(goRoot, 'pkg/mod');
    await mkdir(path.join(moduleCache, 'example.test/mod@v1'), {
      recursive: true,
    });
    await writeFile(
      path.join(moduleCache, 'example.test/mod@v1/mod.go'),
      'package mod\n',
    );
    const materialization = await createMaterialization(repository);
    let replayCommand = '';
    const shell = createShellDouble(async (request) => {
      replayCommand = request.command;
      const isolatedCache = readQuotedEnv(request.command, 'GOMODCACHE');
      await writeFile(
        path.join(isolatedCache, 'example.test/mod@v1/mod.go'),
        'package replay\n',
      );
    });
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const provider = new DisposableLocalWorktreeRunnerAdapter(shell.service, {
      receiptAuthority: P256RunnerSigningAuthority.generate().authority,
      trustedGuardianPublicKey: guardian.publicKey,
      resolveGoModuleCache: async () => moduleCache,
    });

    await executeDisposableRunnerReplay({
      provider,
      snapshotIdentity: {
        snapshotHash: 'a'.repeat(64),
        environmentFingerprintHash: 'b'.repeat(64),
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: repository,
            repositoryRevision: await git(repository, ['rev-parse', 'HEAD']),
            dirtyPatchHash: materialization.dirtyPatchHash,
            dependencyFingerprintHash: await dependencyFingerprint(repository, [
              'go.mod',
              'go.sum',
            ]),
            hasDirtyChanges: false,
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: materialization.archive,
              archiveHash: sha256(materialization.archive),
              totalBytes: materialization.archive.byteLength,
            },
          },
        ],
      },
      authority: guardian,
      command: { command: 'go test ./...', cwd: repository },
      agentInstanceId: 'agent-1',
      decisionId: '00000000-0000-4000-8000-000000000001',
    });

    expect(replayCommand).toContain("GOPROXY='off'");
    expect(replayCommand).toContain("GOSUMDB='off'");
    expect(replayCommand).toContain("GOTOOLCHAIN='local'");
    await expect(
      readFile(path.join(moduleCache, 'example.test/mod@v1/mod.go'), 'utf8'),
    ).resolves.toBe('package mod\n');
  });
});

function createShellDouble(
  onExecute?: (request: { command: string }) => Promise<void>,
): {
  service: ShellService;
  createSession: ReturnType<typeof vi.fn>;
  executeInSession: ReturnType<typeof vi.fn>;
} {
  let replayCwd = '';
  const createSession = vi.fn((_agentId, _toolId, cwd: string) => {
    replayCwd = cwd;
    return 'session-1';
  });
  const executeInSession = vi.fn(async (_agentId, _toolId, request) => {
    await onExecute?.(request);
    return {
      sessionId: 'session-1',
      output: '',
      exitCode: 0,
      sessionExited: false,
      timedOut: false,
      resolvedBy: 'exit' as const,
    };
  });
  return {
    service: {
      isAvailable: vi.fn(() => true),
      createSession,
      executeInSession,
      killSession: vi.fn(() => true),
      getRecentOutputForClassifier: vi.fn(() => undefined),
      getSessionCurrentCwd: vi.fn(() => replayCwd),
      clearPendingOutputs: vi.fn(),
    } as unknown as ShellService,
    createSession,
    executeInSession,
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function dependencyFingerprint(
  repository: string,
  relativePaths: readonly string[],
): Promise<string> {
  return hashWorkspaceDependencyFingerprint(
    await Promise.all(
      relativePaths.map(async (relativePath) => {
        const content = await readFile(path.join(repository, relativePath));
        return {
          relativePath,
          sizeBytes: content.byteLength,
          sha256: sha256(content),
        };
      }),
    ),
  );
}

function readQuotedEnv(command: string, name: string): string {
  const match = command.match(new RegExp(`${name}='([^']+)'`));
  if (!match?.[1]) throw new Error(`Missing ${name} in replay command`);
  return match[1];
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-replay-test-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(root, 'src/index.ts'), 'export const value = 1;\n');
  await git(root, ['init']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'user.email', 'runner@example.test']);
  await git(root, ['config', 'user.name', 'Runner Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

async function createMaterialization(repository: string): Promise<{
  archive: Buffer;
  dirtyPatchHash: string;
}> {
  const patch = Buffer.from(
    await execFileAsync(
      'git',
      ['-C', repository, 'diff', '--binary', '--full-index', 'HEAD'],
      { encoding: 'buffer' },
    ).then((result) => result.stdout),
  );
  const untrackedPath = 'untracked.txt';
  const untracked = await readFile(path.join(repository, untrackedPath)).catch(
    () => Buffer.alloc(0),
  );
  const files =
    untracked.byteLength === 0
      ? []
      : [
          {
            relativePath: untrackedPath,
            mode: 0o640,
            content: untracked,
          },
        ];
  const archive = gzipSync(
    Buffer.concat([
      tarEntry('.clodex/tracked.patch', 0o600, patch),
      ...files.map((file) =>
        tarEntry(`workspace/${file.relativePath}`, file.mode, file.content),
      ),
      Buffer.alloc(1_024),
    ]),
  );
  return {
    archive,
    dirtyPatchHash: sha256(
      JSON.stringify({
        version: 1,
        trackedPatchHash: sha256(patch),
        untrackedFiles: files.map((file) => ({
          relativePath: file.relativePath,
          mode: file.mode,
          sizeBytes: file.content.byteLength,
          sha256: sha256(file.content),
        })),
      }),
    ),
  };
}

function tarEntry(name: string, mode: number, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(
    header,
    148,
    8,
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
  );
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function writeString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  Buffer.from(value).copy(target, offset, 0, length);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  writeString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`,
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
