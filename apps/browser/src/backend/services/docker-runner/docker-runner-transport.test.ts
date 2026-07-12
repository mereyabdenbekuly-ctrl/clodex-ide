import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DockerCliRunnerTransport,
  readDockerRunnerConfig,
  type DockerCommandExecutor,
} from './docker-runner-transport';

const IMAGE = `registry.example.test/clodex/runner@sha256:${'a'.repeat(64)}`;
const SNAPSHOT_HASH = 'b'.repeat(64);
const DIRTY_PATCH_HASH = 'c'.repeat(64);
const ARCHIVE = Buffer.from('materialization');
const ARCHIVE_HASH = createHash('sha256').update(ARCHIVE).digest('hex');
const CONTAINER_ID = 'd'.repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DockerCliRunnerTransport', () => {
  it('creates a constrained container and streams repository/materialization bytes', async () => {
    const repository = await createRepository();
    const revision = await gitOutput(repository, ['rev-parse', 'HEAD']);
    const execute = vi.fn(
      async (input: { args: readonly string[]; stdin?: Uint8Array }) => {
        if (input.args[0] === 'create') return success(CONTAINER_ID);
        if (
          input.args[0] === 'exec' &&
          input.args.includes('cat > /tmp/clodex-repository.bundle')
        ) {
          expect(input.stdin?.byteLength).toBeGreaterThan(0);
          return success('');
        }
        if (
          input.args[0] === 'exec' &&
          input.args.includes('cat > /tmp/clodex-materialization.tar.gz')
        ) {
          expect(input.stdin).toEqual(ARCHIVE);
          return success('');
        }
        if (
          input.args[0] === 'exec' &&
          input.args.some((value) => value.includes('CLODEX_REVISION'))
        ) {
          return success(
            [
              `CLODEX_REVISION=${revision}`,
              `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
              'CLODEX_OS=Linux',
              'CLODEX_ARCH=x86_64',
              'CLODEX_SHELL=/bin/sh',
              'CLODEX_GIT=git version 2.48.0',
              '',
            ].join('\n'),
          );
        }
        return success('');
      },
    );
    const transport = new DockerCliRunnerTransport(
      {
        image: IMAGE,
        cpus: 2,
        memoryMb: 4_096,
        pidsLimit: 512,
      },
      { execute } as DockerCommandExecutor,
    );

    await expect(
      transport.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        workspaceRoot: repository,
        repositoryRevision: revision,
        dirtyPatchHash: DIRTY_PATCH_HASH,
        materialization: {
          version: 1,
          archiveFormat: 'tar-gzip',
          archive: ARCHIVE,
          archiveHash: ARCHIVE_HASH,
          totalBytes: ARCHIVE.byteLength,
        },
      }),
    ).resolves.toMatchObject({
      workspaceHandle: CONTAINER_ID,
      repositoryRevision: revision,
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materializationArchiveHash: ARCHIVE_HASH,
      environmentFingerprintHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const createArgs = execute.mock.calls.find(
      ([input]) => input.args[0] === 'create',
    )![0].args;
    expect(createArgs).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--read-only',
        '--user',
        '65532:65532',
        '--entrypoint',
        'sh',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,noexec,mode=1777',
        '--tmpfs',
        '/workspace:rw,nosuid,nodev,mode=1777',
        '--pid',
        'private',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '512',
        IMAGE,
      ]),
    );
  });

  it('captures content-addressed artifact state inside the container', async () => {
    const repository = await createRepository();
    const revision = await gitOutput(repository, ['rev-parse', 'HEAD']);
    const execute = vi.fn(
      async (input: { args: readonly string[]; stdin?: Uint8Array }) => {
        const command = input.args.at(-1) ?? '';
        if (input.args[0] === 'create') return success(CONTAINER_ID);
        if (input.args[0] === 'exec' && command.includes('CLODEX_REVISION')) {
          return success(
            `CLODEX_REVISION=${revision}\nCLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}\n`,
          );
        }
        if (command.includes('diff --name-only --no-renames')) {
          return success('src/output.ts\0\0CLODEX_ARTIFACT_PATH_LIST_END\0');
        }
        if (command.includes('ls-files --others')) {
          return success(
            'reports/result.json\0\0CLODEX_ARTIFACT_PATH_LIST_END\0',
          );
        }
        if (command.includes('target=')) {
          return success(
            [
              `F|12|644|10|${'e'.repeat(64)}`,
              `F|24|755|11|${'f'.repeat(64)}`,
              '',
            ].join('\n'),
          );
        }
        return success('');
      },
    );
    const transport = new DockerCliRunnerTransport(
      {
        image: IMAGE,
        cpus: 1,
        memoryMb: 512,
        pidsLimit: 128,
      },
      { execute } as DockerCommandExecutor,
    );
    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: repository,
      repositoryRevision: revision,
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    });

    await expect(
      transport.captureWorkspaceArtifactState({
        workspaceHandle: CONTAINER_ID,
      }),
    ).resolves.toEqual({
      entries: [
        {
          relativePath: 'reports/result.json',
          tracked: false,
          kind: 'file',
          sizeBytes: 12,
          mode: 0o644,
          sha256: 'e'.repeat(64),
          modifiedAtMs: 10_000,
          omissionReason: null,
        },
        {
          relativePath: 'src/output.ts',
          tracked: true,
          kind: 'file',
          sizeBytes: 24,
          mode: 0o755,
          sha256: 'f'.repeat(64),
          modifiedAtMs: 11_000,
          omissionReason: null,
        },
      ],
      truncated: false,
    });
  });

  it('executes only in registered containers and removes them on release', async () => {
    const repository = await createRepository();
    const revision = await gitOutput(repository, ['rev-parse', 'HEAD']);
    const execute = vi.fn(
      async (input: { args: readonly string[]; stdin?: Uint8Array }) => {
        if (input.args[0] === 'create') return success(CONTAINER_ID);
        if (
          input.args[0] === 'exec' &&
          input.args.some((value) => value.includes('CLODEX_REVISION'))
        ) {
          return success(
            `CLODEX_REVISION=${revision}\nCLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}\n`,
          );
        }
        if (input.args[0] === 'exec' && input.args.includes('pnpm test')) {
          return { ...success('passed\n'), stderr: 'warning\n' };
        }
        return success('');
      },
    );
    const transport = new DockerCliRunnerTransport(
      {
        image: IMAGE,
        cpus: 1,
        memoryMb: 512,
        pidsLimit: 128,
      },
      { execute } as DockerCommandExecutor,
    );
    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: repository,
      repositoryRevision: revision,
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    });

    await expect(
      transport.execute({
        workspaceHandle: CONTAINER_ID,
        command: 'pnpm test',
        cwdRelative: 'packages/app',
        timeoutMs: 200_000,
      }),
    ).resolves.toEqual({
      stdout: 'passed\n',
      stderr: 'warning\n',
      exitCode: 0,
    });
    expect(execute).toHaveBeenCalledWith({
      args: [
        'exec',
        '-w',
        '/workspace/packages/app',
        CONTAINER_ID,
        'sh',
        '-c',
        'pnpm test',
      ],
      timeoutMs: 120_000,
      stdin: undefined,
    });

    await transport.releaseWorkspace(CONTAINER_ID);
    expect(execute).toHaveBeenLastCalledWith({
      args: ['rm', '-f', CONTAINER_ID],
      timeoutMs: 30_000,
      stdin: undefined,
    });
    await expect(
      transport.execute({
        workspaceHandle: CONTAINER_ID,
        command: 'true',
        cwdRelative: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('unknown or expired');
  });

  it('quarantines and removes a container when the Docker exec client times out', async () => {
    const repository = await createRepository();
    const revision = await gitOutput(repository, ['rev-parse', 'HEAD']);
    const execute = vi.fn(
      async (input: { args: readonly string[]; stdin?: Uint8Array }) => {
        const command = input.args.at(-1) ?? '';
        if (input.args[0] === 'create') return success(CONTAINER_ID);
        if (input.args[0] === 'exec' && command.includes('CLODEX_REVISION')) {
          return success(
            `CLODEX_REVISION=${revision}\nCLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}\n`,
          );
        }
        if (input.args[0] === 'exec' && command === 'sleep forever') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: '',
            timedOut: true,
          };
        }
        return success('');
      },
    );
    const transport = new DockerCliRunnerTransport(
      {
        image: IMAGE,
        cpus: 1,
        memoryMb: 512,
        pidsLimit: 128,
      },
      { execute } as DockerCommandExecutor,
    );
    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: repository,
      repositoryRevision: revision,
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    });

    await expect(
      transport.execute({
        workspaceHandle: CONTAINER_ID,
        command: 'sleep forever',
        cwdRelative: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('container was terminated');
    expect(execute).toHaveBeenCalledWith({
      args: ['rm', '-f', CONTAINER_ID],
      timeoutMs: 30_000,
      stdin: undefined,
    });
    await expect(transport.releaseWorkspace(CONTAINER_ID)).resolves.toBe(
      undefined,
    );
    await expect(
      transport.execute({
        workspaceHandle: CONTAINER_ID,
        command: 'true',
        cwdRelative: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('unknown or expired');
  });

  it('requires digest-pinned images and bounded resource limits', () => {
    expect(
      readDockerRunnerConfig({
        CLODEX_DOCKER_RUNNER_IMAGE: IMAGE,
        CLODEX_DOCKER_RUNNER_CPUS: '4',
        CLODEX_DOCKER_RUNNER_MEMORY_MB: '8192',
        CLODEX_DOCKER_RUNNER_PIDS_LIMIT: '1024',
      }),
    ).toEqual({
      image: IMAGE,
      cpus: 4,
      memoryMb: 8_192,
      pidsLimit: 1_024,
    });
    expect(() =>
      readDockerRunnerConfig({
        CLODEX_DOCKER_RUNNER_IMAGE: 'node:latest',
      }),
    ).toThrow('configuration is invalid');
    expect(() =>
      readDockerRunnerConfig({
        CLODEX_DOCKER_RUNNER_IMAGE: IMAGE,
        CLODEX_DOCKER_RUNNER_MEMORY_MB: '64',
      }),
    ).toThrow('integer limit is invalid');
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `docker-runner-${randomUUID()}-`),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src/index.ts'),
    'export const ready = true;\n',
  );
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'docker@example.test']);
  await git(root, ['config', 'user.name', 'Docker Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function success(stdout: string) {
  return { exitCode: 0, stdout, stderr: '' };
}
