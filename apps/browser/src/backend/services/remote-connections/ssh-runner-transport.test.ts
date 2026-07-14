import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteConnectionsService } from '.';
import { RemoteConnectionSshRunnerTransport } from './ssh-runner-transport';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVE = Buffer.from('archive-bytes');
const ARCHIVE_HASH = createHash('sha256').update(ARCHIVE).digest('hex');
const SNAPSHOT_HASH = 'a'.repeat(64);
const WORKSPACE_HANDLE = `/tmp/clodex-runner-${SNAPSHOT_HASH.slice(0, 16)}.1234`;

describe('RemoteConnectionSshRunnerTransport', () => {
  it('reuses an exact persistent snapshot without retransferring its archive', async () => {
    let lookupCount = 0;
    let workspaceHandle = '';
    const executeRunnerCommand = vi.fn(
      async (input: { command: string; stdin?: Uint8Array }) => {
        if (input.command.includes("miss() { printf 'CLODEX_CACHE_MISS=1")) {
          lookupCount += 1;
          if (lookupCount === 1) return success('CLODEX_CACHE_MISS=1\n', 3);
          return success(
            [
              `CLODEX_WORKSPACE=${workspaceHandle}`,
              'CLODEX_REVISION=abc123',
              `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
              'CLODEX_OS=Linux',
              'CLODEX_ARCH=x86_64',
              'CLODEX_NODE=v24.1.0',
              'CLODEX_GIT=git version 2.48.0',
              'CLODEX_REUSE_COUNT=1',
              '',
            ].join('\n'),
          );
        }
        if (input.command.includes('git worktree add --detach')) {
          const match = input.command.match(
            /workspace="\$cache_root\/workspaces\/([^"]+)"/,
          );
          if (!match) throw new Error('persistent workspace was not bound');
          workspaceHandle = `/root/.cache/clodex-runner/workspaces/${match[1]}`;
          return success(
            [
              `CLODEX_WORKSPACE=${workspaceHandle}`,
              'CLODEX_REVISION=abc123',
              `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
              'CLODEX_OS=Linux',
              'CLODEX_ARCH=x86_64',
              'CLODEX_NODE=v24.1.0',
              'CLODEX_GIT=git version 2.48.0',
              'CLODEX_REUSE_COUNT=0',
              '',
            ].join('\n'),
          );
        }
        return success('');
      },
    );
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
      { enabled: true },
    );
    const request = {
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: '/local/workspace',
      repositoryRevision: 'abc123',
      dirtyPatchHash: 'b'.repeat(64),
      dependencyFingerprintHash: 'd'.repeat(64),
      dependencyMaterialization: 'copy-on-write' as const,
      materialization: {
        version: 1 as const,
        archiveFormat: 'tar-gzip' as const,
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    };

    const cold = await transport.prepareWorkspace(request);
    await transport.releaseWorkspace(cold.workspaceHandle);
    const warm = await transport.prepareWorkspace(request);

    expect(cold.preparation).toMatchObject({
      cacheStatus: 'cold',
      profile: 'node-copy-on-write',
      transferBytes: ARCHIVE.byteLength,
      transferBytesAvoided: 0,
    });
    expect(warm.preparation).toMatchObject({
      cacheStatus: 'warm',
      profile: 'node-copy-on-write',
      workspaceReuseCount: 1,
      transferBytes: 0,
      transferBytesAvoided: ARCHIVE.byteLength,
    });
    expect(
      executeRunnerCommand.mock.calls.filter(
        ([input]) => input.stdin === ARCHIVE,
      ),
    ).toHaveLength(1);
    expect(
      executeRunnerCommand.mock.calls.some(([input]) =>
        input.command.includes('rm -rf -- "$workspace.lease"'),
      ),
    ).toBe(true);
    expect(
      executeRunnerCommand.mock.calls.some(([input]) =>
        input.command.includes('gc_count='),
      ),
    ).toBe(true);
  });

  it('streams a materialization archive into an isolated remote worktree', async () => {
    const executeRunnerCommand = vi.fn(async (_input: { command: string }) =>
      success(
        [
          `CLODEX_WORKSPACE=${WORKSPACE_HANDLE}`,
          'CLODEX_REVISION=abc123',
          `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
          'CLODEX_OS=Linux',
          'CLODEX_ARCH=x86_64',
          'CLODEX_SHELL=/bin/bash',
          'CLODEX_NODE=v24.1.0',
          'CLODEX_GIT=git version 2.48.0',
          '',
        ].join('\n'),
      ),
    );
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
    );

    await expect(
      transport.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        workspaceRoot: '/local/workspace',
        repositoryRevision: 'abc123',
        dirtyPatchHash: 'b'.repeat(64),
        materialization: {
          version: 1,
          archiveFormat: 'tar-gzip',
          archive: ARCHIVE,
          archiveHash: ARCHIVE_HASH,
          totalBytes: ARCHIVE.byteLength,
        },
      }),
    ).resolves.toMatchObject({
      workspaceHandle: WORKSPACE_HANDLE,
      repositoryRevision: 'abc123',
      dirtyPatchHash: 'b'.repeat(64),
      materializationArchiveHash: ARCHIVE_HASH,
      environmentFingerprintHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(executeRunnerCommand).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      command: expect.stringContaining('git worktree add --detach'),
      timeoutMs: 120_000,
      stdin: ARCHIVE,
    });
    expect(executeRunnerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('git -C "$workspace" apply --binary'),
      }),
    );
    expect(executeRunnerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('archive-hash-mismatch'),
      }),
    );
    const preparationCommand = executeRunnerCommand.mock.calls[0]![0].command;
    expect(preparationCommand.indexOf('archive-hash-mismatch')).toBeLessThan(
      preparationCommand.indexOf('tar --no-same-owner'),
    );
  });

  it('executes inside and releases the prepared workspace handle', async () => {
    const executeRunnerCommand = vi.fn(async (input: { command: string }) =>
      input.command.includes('git worktree add --detach')
        ? success(
            [
              `CLODEX_WORKSPACE=${WORKSPACE_HANDLE}`,
              'CLODEX_REVISION=abc123',
              `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
              '',
            ].join('\n'),
          )
        : success('ok\n'),
    );
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
    );

    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: '/local/workspace',
      repositoryRevision: 'abc123',
      dirtyPatchHash: 'b'.repeat(64),
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    });
    await transport.execute({
      workspaceHandle: WORKSPACE_HANDLE,
      command: 'pnpm test',
      cwdRelative: 'packages/app',
      timeoutMs: 125_000,
    });
    await transport.releaseWorkspace(WORKSPACE_HANDLE);

    expect(executeRunnerCommand).toHaveBeenNthCalledWith(2, {
      connectionId: CONNECTION_ID,
      command: `cd -- '${WORKSPACE_HANDLE}/packages/app' && (pnpm test)`,
      timeoutMs: 120_000,
      stdin: undefined,
    });
    expect(executeRunnerCommand).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        command: expect.stringContaining('git worktree remove --force'),
        timeoutMs: 30_000,
      }),
    );
  });

  it('rejects a mismatched remote archive hash', async () => {
    const executeRunnerCommand = vi.fn(async () =>
      success(
        [
          `CLODEX_WORKSPACE=${WORKSPACE_HANDLE}`,
          'CLODEX_REVISION=abc123',
          `CLODEX_ARCHIVE_SHA256=${'f'.repeat(64)}`,
          '',
        ].join('\n'),
      ),
    );
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
    );

    await expect(
      transport.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        workspaceRoot: '/local/workspace',
        repositoryRevision: 'abc123',
        dirtyPatchHash: 'b'.repeat(64),
        materialization: {
          version: 1,
          archiveFormat: 'tar-gzip',
          archive: ARCHIVE,
          archiveHash: ARCHIVE_HASH,
          totalBytes: ARCHIVE.byteLength,
        },
      }),
    ).rejects.toThrow('archive hash mismatch');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a tampered SSH stream before archive extraction',
    async () => {
      const remoteTmp = await mkdtemp(
        path.join(tmpdir(), 'clodex-ssh-runner-tamper-'),
      );
      let observedStderr = '';
      const executeRunnerCommand = vi.fn(
        async (input: {
          command: string;
          stdin?: Uint8Array;
          connectionId: string;
        }) => {
          const result = await runLocalShell(
            input.command,
            Buffer.concat([
              Buffer.from(input.stdin ?? []),
              Buffer.from('tamper'),
            ]),
            remoteTmp,
          );
          observedStderr = result.stderr;
          return {
            ok: true as const,
            connectionId: input.connectionId,
            connectionName: 'Local test runner',
            ...result,
            durationMs: 1,
          };
        },
      );
      const transport = new RemoteConnectionSshRunnerTransport(
        { executeRunnerCommand } as unknown as RemoteConnectionsService,
        CONNECTION_ID,
      );

      try {
        await expect(
          transport.prepareWorkspace({
            snapshotHash: SNAPSHOT_HASH,
            workspaceRoot: '/local/workspace',
            repositoryRevision: 'abc123',
            dirtyPatchHash: 'b'.repeat(64),
            materialization: {
              version: 1,
              archiveFormat: 'tar-gzip',
              archive: ARCHIVE,
              archiveHash: ARCHIVE_HASH,
              totalBytes: ARCHIVE.byteLength,
            },
          }),
        ).rejects.toThrow('could not prepare');
        expect(observedStderr).toContain('CLODEX_ERROR=archive-hash-mismatch');
        expect(await readdir(remoteTmp)).toEqual([]);
      } finally {
        await rm(remoteTmp, { recursive: true, force: true });
      }
    },
  );

  it('never executes or deletes an unsafe remote workspace handle', async () => {
    const executeRunnerCommand = vi.fn(async () => success('ok\n'));
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
    );

    await expect(
      transport.execute({
        workspaceHandle: '/tmp/../../etc',
        command: 'true',
        cwdRelative: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('unsafe workspace handle');
    await expect(
      transport.releaseWorkspace('/tmp/not-a-clodex-workspace'),
    ).rejects.toThrow('unsafe workspace handle');
    expect(executeRunnerCommand).not.toHaveBeenCalled();
  });

  it('rejects an unregistered but well-formed workspace handle', async () => {
    const executeRunnerCommand = vi.fn(async () => success('ok\n'));
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
    );

    await expect(transport.releaseWorkspace(WORKSPACE_HANDLE)).rejects.toThrow(
      'unknown or expired',
    );
    expect(executeRunnerCommand).not.toHaveBeenCalled();
  });

  it('captures bounded content-addressed artifact state remotely', async () => {
    const executeRunnerCommand = vi.fn(async (input: { command: string }) => {
      if (input.command.includes('git worktree add --detach')) {
        return success(
          [
            `CLODEX_WORKSPACE=${WORKSPACE_HANDLE}`,
            'CLODEX_REVISION=abc123',
            `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
            '',
          ].join('\n'),
        );
      }
      if (input.command.includes('diff --name-only --no-renames -z')) {
        return success('src/output.ts\0\0CLODEX_ARTIFACT_PATH_LIST_END\0');
      }
      if (input.command.includes('ls-files --others')) {
        return success(
          'reports/result.json\0\0CLODEX_ARTIFACT_PATH_LIST_END\0',
        );
      }
      if (input.command.includes('target=')) {
        return success(
          [
            `F|12|644|10|${'e'.repeat(64)}`,
            `F|24|755|11|${'f'.repeat(64)}`,
            '',
          ].join('\n'),
        );
      }
      return success('');
    });
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
    );
    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: '/local/workspace',
      repositoryRevision: 'abc123',
      dirtyPatchHash: 'b'.repeat(64),
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
        workspaceHandle: WORKSPACE_HANDLE,
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

  it('batches artifact listing and cleanup when the multiplexed protocol is enabled', async () => {
    const executeRunnerCommand = vi.fn(async (input: { command: string }) => {
      if (input.command.includes('git worktree add --detach')) {
        return success(
          [
            `CLODEX_WORKSPACE=${WORKSPACE_HANDLE}`,
            'CLODEX_REVISION=abc123',
            `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
            '',
          ].join('\n'),
        );
      }
      if (
        input.command.includes('diff --name-only --no-renames -z') &&
        input.command.includes('ls-files --others --exclude-standard -z')
      ) {
        return success(
          [
            'src/output.ts',
            '',
            'CLODEX_ARTIFACT_TRACKED_PATH_LIST_END',
            'reports/result.json',
            '',
            'CLODEX_ARTIFACT_UNTRACKED_PATH_LIST_END',
            '',
          ].join('\0'),
        );
      }
      if (input.command.includes('target=')) {
        return success(
          [
            `F|12|644|10|${'e'.repeat(64)}`,
            `F|24|755|11|${'f'.repeat(64)}`,
            '',
          ].join('\n'),
        );
      }
      if (input.command.includes('setsid sh "$job/wrapper.sh"')) {
        const jobId = input.command.match(/job-[a-f0-9]{32}/)?.[0];
        if (!jobId) throw new Error('job id missing from start script');
        return success(
          [
            `CLODEX_JOB_ID=${jobId}`,
            'CLODEX_JOB_STATE=completed',
            'CLODEX_STDOUT_OFFSET=0',
            'CLODEX_STDERR_OFFSET=0',
            'CLODEX_STDOUT_BASE64=',
            'CLODEX_STDERR_BASE64=',
            'CLODEX_STDOUT_COMPLETE=1',
            'CLODEX_STDERR_COMPLETE=1',
            'CLODEX_COMMAND_DURATION_MS=5',
            'CLODEX_EXIT_CODE=0',
            '',
          ].join('\n'),
        );
      }
      return success('');
    });
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
      { enabled: false, multiplexedProtocolEnabled: true },
    );
    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: '/local/workspace',
      repositoryRevision: 'abc123',
      dirtyPatchHash: 'b'.repeat(64),
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    });
    await transport.captureWorkspaceArtifactState({
      workspaceHandle: WORKSPACE_HANDLE,
    });
    await transport.startJob({
      workspaceHandle: WORKSPACE_HANDLE,
      command: 'true',
      cwdRelative: '',
      timeoutMs: 5_000,
      waitMs: 1_000,
    });
    await transport.releaseWorkspace(WORKSPACE_HANDLE);

    expect(
      executeRunnerCommand.mock.calls.filter(([input]) =>
        input.command.includes('diff --name-only --no-renames -z'),
      ),
    ).toHaveLength(1);
    expect(
      executeRunnerCommand.mock.calls.filter(([input]) =>
        input.command.includes('ls-files --others --exclude-standard -z'),
      ),
    ).toHaveLength(1);
    expect(executeRunnerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ requirePersistentSession: true }),
    );
    expect(executeRunnerCommand.mock.calls.at(-1)?.[0].command).toContain(
      '/tmp/clodex-runner-jobs',
    );
    expect(executeRunnerCommand.mock.calls.at(-1)?.[0].command).toContain(
      'git worktree remove --force',
    );
    expect(transport.getRoundTripCount()).toBe(5);
  });

  it('captures a server-side artifact delta and merges terminal polling into one round trip', async () => {
    let captureId = '';
    let jobId = '';
    let tamperArtifactBinding = false;
    const artifactHash = 'f'.repeat(64);
    const delta = [
      `A|${Buffer.from('reports/result.json').toString('base64')}|0|F|2|644|10|${artifactHash}`,
      '',
    ].join('\n');
    const executeRunnerCommand = vi.fn(async (input: { command: string }) => {
      if (input.command.includes('git worktree add --detach')) {
        return success(
          [
            `CLODEX_WORKSPACE=${WORKSPACE_HANDLE}`,
            'CLODEX_REVISION=abc123',
            `CLODEX_ARCHIVE_SHA256=${ARCHIVE_HASH}`,
            '',
          ].join('\n'),
        );
      }
      if (
        input.command.includes('protocol-v1.sh') &&
        input.command.includes(' begin ')
      ) {
        captureId = input.command.match(/artifact-[a-f0-9]{32}/)?.[0] ?? '';
        return success(
          [
            'CLODEX_ARTIFACT_PROTOCOL_VERSION=1',
            `CLODEX_ARTIFACT_CAPTURE_ID=${captureId}`,
            '',
          ].join('\n'),
        );
      }
      if (input.command.includes('setsid sh "$job/wrapper.sh"')) {
        jobId = input.command.match(/job-[a-f0-9]{32}/)?.[0] ?? '';
        return success(
          [
            `CLODEX_JOB_ID=${jobId}`,
            'CLODEX_JOB_STATE=running',
            'CLODEX_STDOUT_OFFSET=0',
            'CLODEX_STDERR_OFFSET=0',
            'CLODEX_STDOUT_BASE64=',
            'CLODEX_STDERR_BASE64=',
            'CLODEX_STDOUT_COMPLETE=1',
            'CLODEX_STDERR_COMPLETE=1',
            'CLODEX_COMMAND_DURATION_MS=',
            'CLODEX_EXIT_CODE=',
            '',
          ].join('\n'),
        );
      }
      if (
        input.command.includes('CLODEX_STDOUT_OFFSET') &&
        input.command.includes('artifact_job_state')
      ) {
        return success(
          [
            `CLODEX_JOB_ID=${jobId}`,
            'CLODEX_JOB_STATE=completed',
            'CLODEX_STDOUT_OFFSET=0',
            'CLODEX_STDERR_OFFSET=0',
            'CLODEX_STDOUT_BASE64=',
            'CLODEX_STDERR_BASE64=',
            'CLODEX_STDOUT_COMPLETE=1',
            'CLODEX_STDERR_COMPLETE=1',
            'CLODEX_COMMAND_DURATION_MS=5',
            'CLODEX_EXIT_CODE=0',
            'CLODEX_ARTIFACT_PROTOCOL_VERSION=1',
            `CLODEX_ARTIFACT_CAPTURE_ID=${captureId}`,
            `CLODEX_ARTIFACT_SNAPSHOT_HASH=${
              tamperArtifactBinding ? '0'.repeat(64) : SNAPSHOT_HASH
            }`,
            'CLODEX_ARTIFACT_TRUNCATED=0',
            'CLODEX_ARTIFACT_CAPTURE_DURATION_MS=7',
            `CLODEX_ARTIFACT_DELTA_BASE64=${Buffer.from(delta).toString('base64')}`,
            '',
          ].join('\n'),
        );
      }
      return success('');
    });
    const transport = new RemoteConnectionSshRunnerTransport(
      { executeRunnerCommand } as unknown as RemoteConnectionsService,
      CONNECTION_ID,
      {
        enabled: false,
        multiplexedProtocolEnabled: true,
        artifactManifestFastPathEnabled: true,
      },
    );
    await transport.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      workspaceRoot: '/local/workspace',
      repositoryRevision: 'abc123',
      dirtyPatchHash: 'b'.repeat(64),
      materialization: {
        version: 1,
        archiveFormat: 'tar-gzip',
        archive: ARCHIVE,
        archiveHash: ARCHIVE_HASH,
        totalBytes: ARCHIVE.byteLength,
      },
    });
    const artifactCapture = await transport.beginWorkspaceArtifactCapture({
      workspaceHandle: WORKSPACE_HANDLE,
      snapshotHash: SNAPSHOT_HASH,
    });
    const started = await transport.startJob({
      workspaceHandle: WORKSPACE_HANDLE,
      command: 'true',
      cwdRelative: '',
      timeoutMs: 5_000,
      waitMs: 1_000,
    });
    const completed = await transport.readJob({
      workspaceHandle: WORKSPACE_HANDLE,
      jobId: started.jobId,
      stdoutOffset: 0,
      stderrOffset: 0,
      waitMs: 1_000,
      artifactCapture,
    });

    expect(completed.artifactCapture).toEqual({
      captureDurationMs: 7,
      manifest: {
        version: 1,
        snapshotHash: SNAPSHOT_HASH,
        entries: [
          {
            relativePath: 'reports/result.json',
            change: 'created',
            sizeBytes: 2,
            mode: 0o644,
            sha256: artifactHash,
            omissionReason: null,
          },
        ],
        truncated: false,
      },
    });
    expect(transport.getRoundTripCount()).toBe(4);
    expect(
      executeRunnerCommand.mock.calls.filter(([input]) =>
        input.command.includes('artifact_job_state'),
      ),
    ).toHaveLength(1);

    tamperArtifactBinding = true;
    const tamperedCapture = await transport.beginWorkspaceArtifactCapture({
      workspaceHandle: WORKSPACE_HANDLE,
      snapshotHash: SNAPSHOT_HASH,
    });
    await expect(
      transport.readJob({
        workspaceHandle: WORKSPACE_HANDLE,
        jobId: started.jobId,
        stdoutOffset: 0,
        stderrOffset: 0,
        artifactCapture: tamperedCapture,
      }),
    ).resolves.not.toHaveProperty('artifactCapture');
  });

  it.runIf(process.platform !== 'win32')(
    'executes the server-side artifact snapshot helper against a real Git worktree',
    async () => {
      const remoteTmp = await mkdtemp(
        path.join(tmpdir(), 'clodex-artifact-fast-path-'),
      );
      const workspaceHandle = path.join(
        remoteTmp,
        `clodex-runner-${SNAPSHOT_HASH.slice(0, 16)}.smoke`,
      );
      await mkdir(path.join(workspaceHandle, 'src'), { recursive: true });
      await writeFile(
        path.join(workspaceHandle, 'src/tracked.txt'),
        'before\n',
      );
      const initialized = await runLocalShell(
        'git init -q && git config user.email smoke@example.invalid && git config user.name Smoke && git add . && git commit -qm base',
        Buffer.alloc(0),
        workspaceHandle,
      );
      expect(initialized.exitCode).toBe(0);
      const executeRunnerCommand = vi.fn(
        async (input: {
          command: string;
          stdin?: Uint8Array;
          connectionId: string;
        }) => {
          const result = await runLocalShell(
            input.command,
            Buffer.from(input.stdin ?? []),
            workspaceHandle,
          );
          return {
            ok: true as const,
            connectionId: input.connectionId,
            connectionName: 'Local artifact runner',
            ...result,
            durationMs: 1,
          };
        },
      );
      const transport = new RemoteConnectionSshRunnerTransport(
        { executeRunnerCommand } as unknown as RemoteConnectionsService,
        CONNECTION_ID,
        { enabled: false, artifactManifestFastPathEnabled: true },
      );
      const internals = transport as unknown as {
        preparedWorkspaceHandles: Set<string>;
        workspaceJobs: Map<string, Set<string>>;
      };
      internals.preparedWorkspaceHandles.add(workspaceHandle);
      internals.workspaceJobs.set(workspaceHandle, new Set());

      try {
        await mkdir(path.join(workspaceHandle, 'reports'));
        await writeFile(
          path.join(workspaceHandle, 'reports/preexisting.txt'),
          'before\n',
        );
        await writeFile(
          path.join(workspaceHandle, 'src/tracked.txt'),
          'dirty-before\n',
        );
        const artifactCapture = await transport.beginWorkspaceArtifactCapture({
          workspaceHandle,
          snapshotHash: SNAPSHOT_HASH,
        });
        await writeFile(
          path.join(workspaceHandle, 'src/tracked.txt'),
          'after\n',
        );
        await unlink(path.join(workspaceHandle, 'reports/preexisting.txt'));
        await writeFile(
          path.join(workspaceHandle, 'reports/result.json'),
          '{}\n',
        );
        const captured = await transport.finalizeWorkspaceArtifactCapture({
          workspaceHandle,
          artifactCapture,
        });

        expect(captured.manifest).toMatchObject({
          version: 1,
          snapshotHash: SNAPSHOT_HASH,
          truncated: false,
          entries: [
            {
              relativePath: 'reports/preexisting.txt',
              change: 'deleted',
            },
            {
              relativePath: 'reports/result.json',
              change: 'created',
            },
            {
              relativePath: 'src/tracked.txt',
              change: 'modified',
            },
          ],
        });
        expect(transport.getRoundTripCount()).toBe(2);
      } finally {
        await rm(remoteTmp, { recursive: true, force: true });
      }
    },
  );
});

function success(stdout: string, exitCode = 0) {
  return {
    ok: true as const,
    connectionId: CONNECTION_ID,
    connectionName: 'Builder',
    exitCode,
    stdout,
    stderr: '',
    durationMs: 1,
  };
}

function runLocalShell(
  command: string,
  stdin: Buffer,
  remoteTmp: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: remoteTmp,
      env: { ...process.env, TMPDIR: remoteTmp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) =>
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.stdin.end(stdin);
  });
}
