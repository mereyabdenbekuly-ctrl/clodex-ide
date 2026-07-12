/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: these placeholders are evaluated by the remote POSIX shell */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createExecutionArtifactManifest,
  type ExecutionArtifactManifest,
  type RemoteRunnerJobSnapshot,
  type SshRunnerCommandResult,
  type SshRunnerPreparedWorkspace,
  type SshRunnerArtifactCapture,
  type SshRunnerArtifactCaptureResult,
  type SshRunnerTransport,
  type WorkspaceExecutionMaterialization,
  type WorkspaceArtifactState,
  type WorkspaceArtifactStateEntry,
  type RunnerWorkspacePreparation,
} from '@clodex/agent-shell';
import { createWorkspaceEnvironmentFingerprint } from '@clodex/agent-core/agents';
import type { RemoteConnectionsService } from '.';
import {
  buildRemoteJobCancelAndReadScript,
  buildRemoteJobCancelScript,
  buildRemoteJobCleanupScript,
  buildRemoteJobReadScript,
  buildRemoteJobStartScript,
  createRemoteRunnerJobId,
  parseRemoteJobId,
  parseRemoteJobSnapshot,
} from '../runner-remote-job-protocol';

const PREPARATION_TIMEOUT_MS = 120_000;
const MAX_ARTIFACT_STATE_PATHS = 512;
const MAX_ARTIFACT_PATH_BYTES = 64 * 1024;
const MAX_HASHED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_INSPECTION_COMMAND_LENGTH = 60_000;
const ARTIFACT_PATH_LIST_END = 'CLODEX_ARTIFACT_PATH_LIST_END';
const ARTIFACT_TRACKED_PATH_LIST_END = 'CLODEX_ARTIFACT_TRACKED_PATH_LIST_END';
const ARTIFACT_UNTRACKED_PATH_LIST_END =
  'CLODEX_ARTIFACT_UNTRACKED_PATH_LIST_END';
const SSH_ARTIFACT_CAPTURE_ID_PATTERN = /^artifact-[a-f0-9]{32}$/;
const SSH_ARTIFACT_CAPTURE_PROTOCOL_VERSION = 1;
const DEFAULT_PERSISTENT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PERSISTENT_CACHE_MAX_ENTRIES = 32;

type SshDependencyMaterialization =
  | 'none'
  | 'copy-on-write'
  | 'cargo-cache'
  | 'go-cache';

export interface SshPersistentWorkspaceCacheOptions {
  enabled: boolean;
  ttlMs?: number;
  diagnosticErrors?: boolean;
  allowDependencyFetch?: boolean;
  maxEntries?: number;
  multiplexedProtocolEnabled?: boolean;
  artifactManifestFastPathEnabled?: boolean;
}

export class RemoteConnectionSshRunnerTransport implements SshRunnerTransport {
  public readonly lifecycleLongPolling: boolean;
  public readonly artifactManifestFastPath: boolean;
  private readonly preparedWorkspaceHandles = new Set<string>();
  private readonly workspaceJobs = new Map<string, Set<string>>();
  private readonly workspaceProfiles = new Map<
    string,
    {
      profile: SshDependencyMaterialization;
      dependencyFingerprintHash: string;
    }
  >();
  private sshRoundTrips = 0;

  public constructor(
    private readonly service: RemoteConnectionsService,
    private readonly connectionId: string,
    private readonly persistentCache: SshPersistentWorkspaceCacheOptions = {
      enabled: false,
    },
  ) {
    this.lifecycleLongPolling =
      this.persistentCache.multiplexedProtocolEnabled === true;
    this.artifactManifestFastPath =
      this.persistentCache.artifactManifestFastPathEnabled === true;
  }

  public async prepareWorkspace(input: {
    snapshotHash: string;
    workspaceRoot: string;
    repositoryRevision: string;
    dirtyPatchHash: string;
    materialization: WorkspaceExecutionMaterialization;
    dependencyFingerprintHash?: string;
    dependencyMaterialization?: SshDependencyMaterialization;
  }): Promise<SshRunnerPreparedWorkspace> {
    const dependencyMaterialization = input.dependencyMaterialization ?? 'none';
    const preparationStartedAt = Date.now();
    const cacheKey = createPersistentWorkspaceCacheKey({
      connectionId: this.connectionId,
      snapshotHash: input.snapshotHash,
      repositoryRevision: input.repositoryRevision,
      dirtyPatchHash: input.dirtyPatchHash,
      archiveHash: input.materialization.archiveHash,
      dependencyFingerprintHash: input.dependencyFingerprintHash,
      dependencyMaterialization,
    });
    if (this.persistentCache.enabled) {
      const warm = await this.run(
        persistentWorkspaceLookupCommand({
          ...input,
          dependencyMaterialization,
          cacheKey,
          ttlMs: normalizeCacheTtl(this.persistentCache.ttlMs),
          allowDependencyFetch:
            this.persistentCache.allowDependencyFetch === true,
        }),
        PREPARATION_TIMEOUT_MS,
      );
      if (warm.exitCode === 0) {
        return this.acceptPreparedWorkspace(
          { ...input, dependencyMaterialization },
          warm.stdout,
          {
            cacheStatus: 'warm',
            profile: toWorkspaceCacheProfile(dependencyMaterialization),
            durationMs: Date.now() - preparationStartedAt,
            workspaceReuseCount: parseReuseCount(warm.stdout),
            transferBytes: 0,
            transferBytesAvoided: input.materialization.totalBytes,
          },
        );
      }
      if (!warm.stdout.includes('CLODEX_CACHE_MISS=1')) {
        throw new Error('SSH runner persistent workspace lookup failed');
      }
    }
    const result = await this.run(
      workspacePreparationCommand({
        ...input,
        dependencyMaterialization,
        persistentCacheEnabled: this.persistentCache.enabled,
        cacheKey,
        ttlMs: normalizeCacheTtl(this.persistentCache.ttlMs),
        allowDependencyFetch:
          this.persistentCache.allowDependencyFetch === true,
        maxEntries: normalizeCacheMaxEntries(this.persistentCache.maxEntries),
      }),
      PREPARATION_TIMEOUT_MS,
      input.materialization.archive,
    );
    if (result.exitCode !== 0) {
      const errorCode = parseMarkers(result.stderr).get('CLODEX_ERROR');
      throw new Error(
        [
          errorCode
            ? `SSH runner could not prepare the remote checkout (${errorCode})`
            : 'SSH runner could not prepare the remote checkout',
          this.persistentCache.diagnosticErrors
            ? sanitizeDiagnosticTail(`${result.stdout}\n${result.stderr}`)
            : '',
        ]
          .filter(Boolean)
          .join(': '),
      );
    }
    return this.acceptPreparedWorkspace(
      { ...input, dependencyMaterialization },
      result.stdout,
      {
        cacheStatus: this.persistentCache.enabled ? 'cold' : 'disabled',
        profile: toWorkspaceCacheProfile(dependencyMaterialization),
        durationMs: Date.now() - preparationStartedAt,
        workspaceReuseCount: 0,
        transferBytes: input.materialization.totalBytes,
        transferBytesAvoided: 0,
      },
    );
  }

  private async acceptPreparedWorkspace(
    input: {
      snapshotHash: string;
      dirtyPatchHash: string;
      materialization: WorkspaceExecutionMaterialization;
      dependencyMaterialization?: SshDependencyMaterialization;
      dependencyFingerprintHash?: string;
    },
    stdout: string,
    preparation: RunnerWorkspacePreparation,
  ): Promise<SshRunnerPreparedWorkspace> {
    const markers = parseMarkers(stdout);
    const workspaceHandle = markers.get('CLODEX_WORKSPACE')?.trim();
    const repositoryRevision = markers.get('CLODEX_REVISION')?.trim();
    const materializationArchiveHash = markers
      .get('CLODEX_ARCHIVE_SHA256')
      ?.trim();
    const os = markers.get('CLODEX_OS')?.trim() || 'unknown';
    const arch = markers.get('CLODEX_ARCH')?.trim() || 'unknown';
    const shell = markers.get('CLODEX_SHELL')?.trim() || null;
    if (
      !workspaceHandle ||
      !repositoryRevision ||
      !materializationArchiveHash
    ) {
      throw new Error('SSH runner preparation returned incomplete metadata');
    }
    assertSafeWorkspaceHandle(workspaceHandle, input.snapshotHash);
    if (materializationArchiveHash !== input.materialization.archiveHash) {
      this.preparedWorkspaceHandles.add(workspaceHandle);
      await this.releaseWorkspace(workspaceHandle).catch(() => undefined);
      throw new Error('SSH runner materialization archive hash mismatch');
    }
    const environment = createWorkspaceEnvironmentFingerprint({
      os,
      arch,
      shell,
      toolchains: Object.fromEntries(
        [
          ['node', markers.get('CLODEX_NODE')?.trim()],
          ['cargo', markers.get('CLODEX_CARGO')?.trim()],
          ['go', markers.get('CLODEX_GO')?.trim()],
          ['git', markers.get('CLODEX_GIT')?.trim()],
        ].filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
    });
    this.preparedWorkspaceHandles.add(workspaceHandle);
    this.workspaceJobs.set(workspaceHandle, new Set());
    this.workspaceProfiles.set(workspaceHandle, {
      profile: input.dependencyMaterialization ?? 'none',
      dependencyFingerprintHash: input.dependencyFingerprintHash ?? 'none',
    });
    return {
      workspaceHandle,
      repositoryRevision,
      dirtyPatchHash: input.dirtyPatchHash,
      materializationArchiveHash,
      environmentFingerprintHash: environment.fingerprintHash,
      preparation,
    };
  }

  public async execute(input: {
    workspaceHandle: string;
    command: string;
    cwdRelative: string;
    timeoutMs: number;
  }): Promise<SshRunnerCommandResult> {
    assertSafeWorkspaceHandle(input.workspaceHandle);
    if (!this.preparedWorkspaceHandles.has(input.workspaceHandle)) {
      throw new Error('SSH runner workspace handle is unknown or expired');
    }
    assertSafeRelativeCwd(input.cwdRelative);
    const cwd = input.cwdRelative
      ? `${input.workspaceHandle}/${input.cwdRelative}`
      : input.workspaceHandle;
    const result = await this.run(
      `cd -- ${shellQuote(cwd)} && (${withProfileEnvironment(
        input.command,
        input.workspaceHandle,
        this.workspaceProfiles.get(input.workspaceHandle),
      )})`,
      input.timeoutMs,
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  public async startJob(input: {
    workspaceHandle: string;
    command: string;
    cwdRelative: string;
    timeoutMs: number;
    waitMs?: number;
  }): Promise<{ jobId: string; snapshot?: RemoteRunnerJobSnapshot }> {
    this.assertKnownWorkspace(input.workspaceHandle);
    assertSafeRelativeCwd(input.cwdRelative);
    const jobId = createRemoteRunnerJobId();
    const result = await this.run(
      buildRemoteJobStartScript({
        jobId,
        workspacePath: input.workspaceHandle,
        cwdRelative: input.cwdRelative,
        command: withProfileEnvironment(
          input.command,
          input.workspaceHandle,
          this.workspaceProfiles.get(input.workspaceHandle),
        ),
        timeoutMs: input.timeoutMs,
        waitMs: this.lifecycleLongPolling ? input.waitMs : 0,
      }),
      30_000,
    );
    if (result.exitCode !== 0 || parseRemoteJobId(result.stdout) !== jobId) {
      throw new Error('SSH runner could not start the remote job');
    }
    this.workspaceJobs.get(input.workspaceHandle)!.add(jobId);
    return {
      jobId,
      snapshot: result.stdout.includes('CLODEX_JOB_STATE=')
        ? parseRemoteJobSnapshot(result.stdout)
        : undefined,
    };
  }

  public async readJob(input: {
    workspaceHandle: string;
    jobId: string;
    stdoutOffset: number;
    stderrOffset: number;
    waitMs?: number;
    artifactCapture?: SshRunnerArtifactCapture;
  }): Promise<RemoteRunnerJobSnapshot> {
    this.assertKnownJob(input.workspaceHandle, input.jobId);
    if (input.artifactCapture) {
      assertSshArtifactCapture(input.artifactCapture);
    }
    const waitMs = this.lifecycleLongPolling
      ? Math.min(5_000, Math.max(0, input.waitMs ?? 0))
      : 0;
    const readScript = buildRemoteJobReadScript({ ...input, waitMs });
    const result = await this.runJobReadWithOptionalArtifactCapture({
      workspaceHandle: input.workspaceHandle,
      jobId: input.jobId,
      readScript,
      timeoutMs: 30_000 + waitMs,
      artifactCapture: input.artifactCapture,
    });
    if (result.exitCode !== 0) {
      throw new Error('SSH runner could not read the remote job');
    }
    return attachArtifactCapture(
      parseRemoteJobSnapshot(result.stdout),
      result.stdout,
      input.artifactCapture,
    );
  }

  public async cancelJob(input: {
    workspaceHandle: string;
    jobId: string;
    stdoutOffset: number;
    stderrOffset: number;
    artifactCapture?: SshRunnerArtifactCapture;
  }): Promise<RemoteRunnerJobSnapshot> {
    this.assertKnownJob(input.workspaceHandle, input.jobId);
    if (input.artifactCapture) {
      assertSshArtifactCapture(input.artifactCapture);
    }
    if (this.lifecycleLongPolling) {
      const cancelled = await this.runJobReadWithOptionalArtifactCapture({
        workspaceHandle: input.workspaceHandle,
        jobId: input.jobId,
        readScript: buildRemoteJobCancelAndReadScript(input),
        timeoutMs: 30_000,
        artifactCapture: input.artifactCapture,
      });
      if (cancelled.exitCode !== 0) {
        throw new Error('SSH runner could not cancel the remote job');
      }
      return attachArtifactCapture(
        parseRemoteJobSnapshot(cancelled.stdout),
        cancelled.stdout,
        input.artifactCapture,
      );
    }
    const cancelled = await this.run(
      buildRemoteJobCancelScript(input.jobId),
      30_000,
    );
    if (cancelled.exitCode !== 0) {
      throw new Error('SSH runner could not cancel the remote job');
    }
    return await this.readJob({
      ...input,
    });
  }

  private async runJobReadWithOptionalArtifactCapture(input: {
    workspaceHandle: string;
    jobId: string;
    readScript: string;
    timeoutMs: number;
    artifactCapture?: SshRunnerArtifactCapture;
  }): Promise<Awaited<ReturnType<RemoteConnectionSshRunnerTransport['run']>>> {
    if (!input.artifactCapture || !this.artifactManifestFastPath) {
      return await this.run(input.readScript, input.timeoutMs);
    }
    const combined = `${input.readScript}\n${buildTerminalArtifactFinalizationScript(
      {
        workspaceHandle: input.workspaceHandle,
        jobId: input.jobId,
        artifactCapture: input.artifactCapture,
      },
    )}`;
    try {
      return await this.run(combined, 120_000);
    } catch {
      // Reading lifecycle state is safe to retry. The command itself is never
      // replayed; a standalone artifact finalization can still run afterward.
      return await this.run(input.readScript, input.timeoutMs);
    }
  }

  public async beginWorkspaceArtifactCapture(input: {
    workspaceHandle: string;
    snapshotHash: string;
  }): Promise<SshRunnerArtifactCapture> {
    if (!this.artifactManifestFastPath) {
      throw new Error('SSH Artifact Manifest fast path is disabled');
    }
    this.assertKnownWorkspace(input.workspaceHandle);
    assertSha256(input.snapshotHash, 'Artifact capture snapshot hash');
    const artifactCapture: SshRunnerArtifactCapture = {
      captureId: createSshArtifactCaptureId(),
      snapshotHash: input.snapshotHash,
    };
    const result = await this.run(
      buildArtifactCaptureBeginScript({
        workspaceHandle: input.workspaceHandle,
        artifactCapture,
      }),
      120_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('SSH runner could not capture artifact baseline');
    }
    const markers = parseMarkers(result.stdout);
    const returnedCaptureId = markers.get('CLODEX_ARTIFACT_CAPTURE_ID')?.trim();
    if (
      returnedCaptureId !== artifactCapture.captureId ||
      markers.get('CLODEX_ARTIFACT_PROTOCOL_VERSION')?.trim() !==
        String(SSH_ARTIFACT_CAPTURE_PROTOCOL_VERSION)
    ) {
      throw new Error('SSH runner returned an invalid artifact capture id');
    }
    return Object.freeze(artifactCapture);
  }

  public async finalizeWorkspaceArtifactCapture(input: {
    workspaceHandle: string;
    artifactCapture: SshRunnerArtifactCapture;
  }): Promise<SshRunnerArtifactCaptureResult> {
    if (!this.artifactManifestFastPath) {
      throw new Error('SSH Artifact Manifest fast path is disabled');
    }
    this.assertKnownWorkspace(input.workspaceHandle);
    assertSshArtifactCapture(input.artifactCapture);
    const result = await this.run(
      buildArtifactCaptureFinalizeScript(input),
      120_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('SSH runner could not finalize artifact capture');
    }
    const captured = parseSshArtifactCaptureResult(
      result.stdout,
      input.artifactCapture,
    );
    if (!captured) {
      throw new Error('SSH runner returned incomplete artifact capture');
    }
    return captured;
  }

  public async captureWorkspaceArtifactState(input: {
    workspaceHandle: string;
    includeEntries?: readonly WorkspaceArtifactStateEntry[];
  }): Promise<WorkspaceArtifactState> {
    this.assertKnownWorkspace(input.workspaceHandle);
    const listedPaths = this.lifecycleLongPolling
      ? await (async () => {
          const pathResult = await this.run(
            [
              `git -C ${shellQuote(input.workspaceHandle)} diff --name-only --no-renames -z HEAD`,
              `printf '\\0${ARTIFACT_TRACKED_PATH_LIST_END}\\0'`,
              `git -C ${shellQuote(input.workspaceHandle)} ls-files --others --exclude-standard -z`,
              `printf '\\0${ARTIFACT_UNTRACKED_PATH_LIST_END}\\0'`,
            ].join(' && '),
            30_000,
          );
          if (pathResult.exitCode !== 0) {
            throw new Error('SSH runner could not inspect workspace artifacts');
          }
          return parseArtifactPathLists(pathResult.stdout);
        })()
      : await (async () => {
          const [trackedResult, untrackedResult] = await Promise.all([
            this.run(
              `git -C ${shellQuote(input.workspaceHandle)} diff --name-only --no-renames -z HEAD && printf '\\0${ARTIFACT_PATH_LIST_END}\\0'`,
              30_000,
            ),
            this.run(
              `git -C ${shellQuote(input.workspaceHandle)} ls-files --others --exclude-standard -z && printf '\\0${ARTIFACT_PATH_LIST_END}\\0'`,
              30_000,
            ),
          ]);
          if (trackedResult.exitCode !== 0 || untrackedResult.exitCode !== 0) {
            throw new Error('SSH runner could not inspect workspace artifacts');
          }
          return {
            tracked: parseNullSeparatedPaths(trackedResult.stdout),
            untracked: parseNullSeparatedPaths(untrackedResult.stdout),
          };
        })();
    const tracked = new Map<string, boolean>();
    let truncated = false;
    for (const relativePath of listedPaths.tracked) {
      if (!isSafeArtifactPath(relativePath)) {
        truncated = true;
        continue;
      }
      tracked.set(relativePath, true);
    }
    for (const relativePath of listedPaths.untracked) {
      if (!isSafeArtifactPath(relativePath)) {
        truncated = true;
        continue;
      }
      tracked.set(relativePath, false);
    }
    for (const entry of input.includeEntries ?? []) {
      if (
        isSafeArtifactPath(entry.relativePath) &&
        !tracked.has(entry.relativePath)
      ) {
        tracked.set(entry.relativePath, entry.tracked);
      }
    }
    const paths: Array<readonly [string, boolean]> = [];
    let pathBytes = 0;
    for (const entry of [...tracked].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const nextBytes = Buffer.byteLength(entry[0], 'utf8');
      if (
        paths.length >= MAX_ARTIFACT_STATE_PATHS ||
        pathBytes + nextBytes > MAX_ARTIFACT_PATH_BYTES
      ) {
        truncated = true;
        break;
      }
      paths.push(entry);
      pathBytes += nextBytes;
    }
    if (paths.length === 0) {
      return { entries: [], truncated };
    }
    const lines: string[] = [];
    for (const batch of createArtifactInspectionBatches(
      input.workspaceHandle,
      paths,
    )) {
      const inspection = await this.run(batch.command, 120_000);
      if (inspection.exitCode !== 0) {
        throw new Error('SSH runner could not hash workspace artifacts');
      }
      const batchLines = inspection.stdout.split('\n').filter(Boolean);
      if (batchLines.length !== batch.paths.length) {
        throw new Error('SSH runner returned incomplete artifact metadata');
      }
      lines.push(...batchLines);
    }
    if (lines.length !== paths.length) {
      throw new Error('SSH runner returned incomplete artifact metadata');
    }
    return {
      entries: Object.freeze(
        lines.map((line, index) =>
          parseArtifactStateEntry(paths[index]!, line),
        ),
      ),
      truncated,
    };
  }

  public async releaseWorkspace(workspaceHandle: string): Promise<void> {
    if (!workspaceHandle.trim()) return;
    assertSafeWorkspaceHandle(workspaceHandle);
    if (!this.preparedWorkspaceHandles.has(workspaceHandle)) {
      throw new Error('SSH runner workspace handle is unknown or expired');
    }
    const jobs = [...(this.workspaceJobs.get(workspaceHandle) ?? [])];
    const workspaceReleaseCommand = this.persistentCache.enabled
      ? persistentWorkspaceReleaseCommand(workspaceHandle)
      : [
          `git worktree remove --force -- ${shellQuote(workspaceHandle)} >/dev/null 2>&1`,
          `|| rm -rf -- ${shellQuote(workspaceHandle)}`,
        ].join(' ');
    const releaseCommand = `(${workspaceReleaseCommand}); rm -rf -- ${shellQuote(
      artifactCaptureRoot(workspaceHandle),
    )}`;
    if (jobs.length > 0 && !this.lifecycleLongPolling) {
      await this.run(buildRemoteJobCleanupScript(jobs), 30_000).catch(
        () => undefined,
      );
    }
    const result = await this.run(
      jobs.length > 0 && this.lifecycleLongPolling
        ? `${buildRemoteJobCleanupScript(jobs)}; ${releaseCommand}`
        : releaseCommand,
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('SSH runner could not release the remote checkout');
    }
    this.preparedWorkspaceHandles.delete(workspaceHandle);
    this.workspaceJobs.delete(workspaceHandle);
    this.workspaceProfiles.delete(workspaceHandle);
  }

  public getRoundTripCount(): number {
    return this.sshRoundTrips;
  }

  private async run(command: string, timeoutMs: number, stdin?: Uint8Array) {
    this.sshRoundTrips += 1;
    const result = await this.service.executeRunnerCommand({
      connectionId: this.connectionId,
      command,
      timeoutMs: Math.min(120_000, Math.max(1_000, timeoutMs)),
      stdin,
      ...(this.lifecycleLongPolling ? { requirePersistentSession: true } : {}),
    });
    if (!result.ok) {
      throw new Error(
        `SSH runner transport failed (${result.code}): ${result.message}`,
      );
    }
    return result;
  }

  private assertKnownWorkspace(workspaceHandle: string): void {
    assertSafeWorkspaceHandle(workspaceHandle);
    if (!this.preparedWorkspaceHandles.has(workspaceHandle)) {
      throw new Error('SSH runner workspace handle is unknown or expired');
    }
  }

  private assertKnownJob(workspaceHandle: string, jobId: string): void {
    this.assertKnownWorkspace(workspaceHandle);
    if (!this.workspaceJobs.get(workspaceHandle)?.has(jobId)) {
      throw new Error('SSH runner job is unknown or expired');
    }
  }
}

function workspacePreparationCommand(input: {
  snapshotHash: string;
  repositoryRevision: string;
  materialization: WorkspaceExecutionMaterialization;
  dirtyPatchHash: string;
  dependencyFingerprintHash?: string;
  dependencyMaterialization: SshDependencyMaterialization;
  persistentCacheEnabled: boolean;
  cacheKey: string;
  ttlMs: number;
  allowDependencyFetch: boolean;
  maxEntries: number;
}): string {
  const revision = shellQuote(input.repositoryRevision);
  const archiveHash = shellQuote(input.materialization.archiveHash);
  const prefix = `clodex-runner-${input.snapshotHash.slice(0, 16)}`;
  const persistent = input.persistentCacheEnabled;
  const profile = shellQuote(input.dependencyMaterialization);
  const dependencyFingerprint = shellQuote(
    input.dependencyFingerprintHash ?? 'none',
  );
  const persistentWorkspaceName = `clodex-runner-${input.snapshotHash.slice(
    0,
    16,
  )}.${input.cacheKey}`;
  return [
    'set -eu',
    'source_repo="$(pwd -P)"',
    persistent
      ? 'cache_root="${HOME}/.cache/clodex-runner"; mkdir -p "$cache_root/workspaces" "$cache_root/archives" "$cache_root/dependencies" "$cache_root/quarantine"'
      : 'cache_root=""',
    persistent
      ? persistentWorkspaceGcCommand(input.ttlMs, input.maxEntries)
      : 'true',
    persistent
      ? `workspace="$cache_root/workspaces/${persistentWorkspaceName}"; lease="$workspace.lease"; if ! mkdir "$lease" 2>/dev/null; then printf 'CLODEX_ERROR=workspace-lease-conflict\\n' >&2; exit 75; fi`
      : `workspace="$(mktemp -d "\${TMPDIR:-/tmp}/${prefix}.XXXXXX")"`,
    'stage="$(mktemp -d "${TMPDIR:-/tmp}/clodex-runner-stage.XXXXXX")"',
    'archive="$(mktemp "${TMPDIR:-/tmp}/clodex-runner-archive.XXXXXX")"',
    persistent
      ? 'cleanup() { rm -rf -- "$stage"; rm -f -- "$archive"; if [ "${prepared:-0}" != 1 ]; then git worktree remove --force -- "$workspace" >/dev/null 2>&1 || rm -rf -- "$workspace"; rm -rf -- "$lease"; fi; }'
      : 'cleanup() { rm -rf -- "$stage"; rm -f -- "$archive"; if [ "${prepared:-0}" != 1 ]; then git worktree remove --force -- "$workspace" >/dev/null 2>&1 || rm -rf -- "$workspace"; fi; }',
    'trap cleanup EXIT HUP INT TERM',
    'cat > "$archive"',
    'if command -v sha256sum >/dev/null 2>&1; then actual_archive_hash="$(sha256sum "$archive" | awk \'{print $1}\')"; elif command -v shasum >/dev/null 2>&1; then actual_archive_hash="$(shasum -a 256 "$archive" | awk \'{print $1}\')"; else printf \'CLODEX_ERROR=sha256-unavailable\\n\' >&2; exit 72; fi',
    `if [ "$actual_archive_hash" != ${archiveHash} ]; then printf 'CLODEX_ERROR=archive-hash-mismatch\\n' >&2; exit 73; fi`,
    'tar -tzf "$archive" | while IFS= read -r entry; do case "$entry" in ".clodex/tracked.patch"|workspace/*) ;; *) printf \'CLODEX_ERROR=unsafe-archive-entry\\n\' >&2; exit 74 ;; esac; case "/$entry/" in *"/../"*|*"/./"*|*"/workspace/.git/"*|*"/workspace/.clodex/"*|*"/workspace/.stagewise/"*) printf \'CLODEX_ERROR=unsafe-archive-entry\\n\' >&2; exit 74 ;; esac; done',
    persistent
      ? 'if [ -e "$workspace" ]; then quarantine="$cache_root/quarantine/' +
        persistentWorkspaceName +
        '.$(date +%s)"; git worktree remove --force -- "$workspace" >/dev/null 2>&1 || mv "$workspace" "$quarantine" 2>/dev/null || rm -rf -- "$workspace"; fi'
      : 'true',
    `git worktree add --detach "$workspace" ${revision} >/dev/null`,
    'tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"',
    'if [ -s "$stage/.clodex/tracked.patch" ]; then git -C "$workspace" apply --binary --whitespace=nowarn "$stage/.clodex/tracked.patch"; fi',
    'if [ -d "$stage/workspace" ]; then cp -R "$stage/workspace/." "$workspace/"; fi',
    persistent
      ? `cp "$archive" "$cache_root/archives/${input.materialization.archiveHash}.tar.gz.tmp"; mv "$cache_root/archives/${input.materialization.archiveHash}.tar.gz.tmp" "$cache_root/archives/${input.materialization.archiveHash}.tar.gz"`
      : 'true',
    persistent
      ? dependencyPreparationCommand(
          input.dependencyMaterialization,
          input.dependencyFingerprintHash,
          input.allowDependencyFetch,
        )
      : 'true',
    'environment_key="$(printf \'%s\\n\' "$(uname -s 2>/dev/null || true)" "$(uname -m 2>/dev/null || true)" "$(node --version 2>/dev/null || true)" "$(cargo --version 2>/dev/null || true)" "$(go version 2>/dev/null || true)" | if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk \'{print $1}\'; else shasum -a 256 | awk \'{print $1}\'; fi)"',
    persistent
      ? `printf '%s\\n' ${shellQuote(input.repositoryRevision)} ${shellQuote(input.dirtyPatchHash)} ${archiveHash} ${dependencyFingerprint} ${profile} "$environment_key" '0' > "$workspace.meta"`
      : 'true',
    'actual_revision="$(git -C "$workspace" rev-parse HEAD)"',
    'prepared=1',
    'printf \'CLODEX_WORKSPACE=%s\\n\' "$workspace"',
    'printf \'CLODEX_REVISION=%s\\n\' "$actual_revision"',
    'printf \'CLODEX_ARCHIVE_SHA256=%s\\n\' "$actual_archive_hash"',
    'printf \'CLODEX_OS=%s\\n\' "$(uname -s 2>/dev/null || printf unknown)"',
    'printf \'CLODEX_ARCH=%s\\n\' "$(uname -m 2>/dev/null || printf unknown)"',
    'printf \'CLODEX_SHELL=%s\\n\' "${SHELL:-}"',
    'printf \'CLODEX_NODE=%s\\n\' "$(node --version 2>/dev/null || true)"',
    'printf \'CLODEX_CARGO=%s\\n\' "$(cargo --version 2>/dev/null || true)"',
    'printf \'CLODEX_GO=%s\\n\' "$(go version 2>/dev/null || true)"',
    'printf \'CLODEX_GIT=%s\\n\' "$(git --version 2>/dev/null || true)"',
    persistent ? "printf 'CLODEX_REUSE_COUNT=0\\n'" : 'true',
  ].join('; ');
}

function persistentWorkspaceLookupCommand(input: {
  snapshotHash: string;
  repositoryRevision: string;
  dirtyPatchHash: string;
  materialization: WorkspaceExecutionMaterialization;
  dependencyFingerprintHash?: string;
  dependencyMaterialization: SshDependencyMaterialization;
  cacheKey: string;
  ttlMs: number;
  allowDependencyFetch: boolean;
}): string {
  const workspaceName = `clodex-runner-${input.snapshotHash.slice(0, 16)}.${input.cacheKey}`;
  const revision = shellQuote(input.repositoryRevision);
  const dirtyPatchHash = shellQuote(input.dirtyPatchHash);
  const archiveHash = shellQuote(input.materialization.archiveHash);
  const dependencyFingerprint = shellQuote(
    input.dependencyFingerprintHash ?? 'none',
  );
  const profile = shellQuote(input.dependencyMaterialization);
  const ttlSeconds = Math.max(60, Math.floor(input.ttlMs / 1_000));
  return [
    'set -eu',
    'source_repo="$(pwd -P)"',
    'cache_root="${HOME}/.cache/clodex-runner"',
    `workspace="$cache_root/workspaces/${workspaceName}"`,
    'meta="$workspace.meta"',
    `archive="$cache_root/archives/${input.materialization.archiveHash}.tar.gz"`,
    "miss() { printf 'CLODEX_CACHE_MISS=1\\n'; exit 3; }",
    'test -d "$workspace" && test -f "$meta" && test -f "$archive" || miss',
    `now="$(date +%s)"; modified="$(stat -c %Y "$meta" 2>/dev/null || stat -f %m "$meta" 2>/dev/null || printf 0)"; test $((now - modified)) -le ${ttlSeconds} || { git worktree remove --force -- "$workspace" >/dev/null 2>&1 || rm -rf -- "$workspace"; rm -f -- "$meta"; miss; }`,
    'lease="$workspace.lease"; if ! mkdir "$lease" 2>/dev/null; then printf \'CLODEX_ERROR=workspace-lease-conflict\\n\' >&2; exit 75; fi',
    'locked=1',
    'stage="$(mktemp -d "${TMPDIR:-/tmp}/clodex-runner-stage.XXXXXX")"',
    'cleanup() { rm -rf -- "$stage"; if [ "${prepared:-0}" != 1 ] && [ "${locked:-0}" = 1 ]; then rm -rf -- "$lease"; fi; }',
    'trap cleanup EXIT HUP INT TERM',
    'meta_revision="$(sed -n \'1p\' "$meta")"; meta_dirty="$(sed -n \'2p\' "$meta")"; meta_archive="$(sed -n \'3p\' "$meta")"; meta_dependency="$(sed -n \'4p\' "$meta")"; meta_profile="$(sed -n \'5p\' "$meta")"; meta_environment="$(sed -n \'6p\' "$meta")"; reuse_count="$(sed -n \'7p\' "$meta")"',
    `test "$meta_revision" = ${revision} && test "$meta_dirty" = ${dirtyPatchHash} && test "$meta_archive" = ${archiveHash} && test "$meta_dependency" = ${dependencyFingerprint} && test "$meta_profile" = ${profile} || { rm -rf -- "$lease"; locked=0; miss; }`,
    'environment_key="$(printf \'%s\\n\' "$(uname -s 2>/dev/null || true)" "$(uname -m 2>/dev/null || true)" "$(node --version 2>/dev/null || true)" "$(cargo --version 2>/dev/null || true)" "$(go version 2>/dev/null || true)" | if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk \'{print $1}\'; else shasum -a 256 | awk \'{print $1}\'; fi)"',
    'test "$meta_environment" = "$environment_key" || { rm -rf -- "$lease"; locked=0; miss; }',
    `git -C "$workspace" reset --hard ${revision} >/dev/null`,
    persistentGitCleanCommand(input.dependencyMaterialization),
    'tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"',
    'if [ -s "$stage/.clodex/tracked.patch" ]; then git -C "$workspace" apply --binary --whitespace=nowarn "$stage/.clodex/tracked.patch"; fi',
    'if [ -d "$stage/workspace" ]; then cp -R "$stage/workspace/." "$workspace/"; fi',
    dependencyPreparationCommand(
      input.dependencyMaterialization,
      input.dependencyFingerprintHash,
      input.allowDependencyFetch,
    ),
    'case "$reuse_count" in ""|*[!0-9]*) reuse_count=0 ;; esac; reuse_count=$((reuse_count + 1))',
    `printf '%s\\n' ${revision} ${dirtyPatchHash} ${archiveHash} ${dependencyFingerprint} ${profile} "$environment_key" "$reuse_count" > "$meta.tmp"; mv "$meta.tmp" "$meta"`,
    'actual_revision="$(git -C "$workspace" rev-parse HEAD)"',
    'prepared=1',
    'printf \'CLODEX_WORKSPACE=%s\\n\' "$workspace"',
    'printf \'CLODEX_REVISION=%s\\n\' "$actual_revision"',
    'printf \'CLODEX_ARCHIVE_SHA256=%s\\n\' "$meta_archive"',
    'printf \'CLODEX_OS=%s\\n\' "$(uname -s 2>/dev/null || printf unknown)"',
    'printf \'CLODEX_ARCH=%s\\n\' "$(uname -m 2>/dev/null || printf unknown)"',
    'printf \'CLODEX_SHELL=%s\\n\' "${SHELL:-}"',
    'printf \'CLODEX_NODE=%s\\n\' "$(node --version 2>/dev/null || true)"',
    'printf \'CLODEX_CARGO=%s\\n\' "$(cargo --version 2>/dev/null || true)"',
    'printf \'CLODEX_GO=%s\\n\' "$(go version 2>/dev/null || true)"',
    'printf \'CLODEX_GIT=%s\\n\' "$(git --version 2>/dev/null || true)"',
    'printf \'CLODEX_REUSE_COUNT=%s\\n\' "$reuse_count"',
  ].join('; ');
}

function dependencyPreparationCommand(
  profile: SshDependencyMaterialization,
  dependencyFingerprintHash: string | undefined,
  allowDependencyFetch: boolean,
): string {
  const dependencyKey = dependencyFingerprintHash ?? 'none';
  if (profile === 'copy-on-write') {
    return [
      `dependency_cache="$cache_root/dependencies/node/${dependencyKey}"`,
      'mkdir -p "$dependency_cache/npm-cache"',
      `if [ ! -f "$workspace/node_modules/.modules.yaml" ]; then command -v pnpm >/dev/null 2>&1 || { printf 'CLODEX_ERROR=pnpm-unavailable\\n' >&2; exit 76; }; (cd "$workspace" && pnpm install ${allowDependencyFetch ? '--prefer-offline' : '--offline'} --frozen-lockfile --ignore-scripts) || { printf 'CLODEX_ERROR=node-dependency-materialization\\n' >&2; exit 77; }; fi`,
    ].join('; ');
  }
  if (profile === 'cargo-cache') {
    return `dependency_cache="$cache_root/dependencies/cargo/${dependencyKey}"; mkdir -p "$dependency_cache/home" "$workspace.cache/cargo-target"`;
  }
  if (profile === 'go-cache') {
    return `dependency_cache="$cache_root/dependencies/go/${dependencyKey}"; mkdir -p "$dependency_cache/mod" "$workspace.cache/go-build"`;
  }
  return 'true';
}

function persistentGitCleanCommand(
  profile: SshDependencyMaterialization,
): string {
  const exclusions = profile === 'copy-on-write' ? '-e node_modules' : '';
  return `git -C "$workspace" clean -fdx ${exclusions} >/dev/null`;
}

function withProfileEnvironment(
  command: string,
  workspaceHandle: string,
  binding:
    | {
        profile: SshDependencyMaterialization;
        dependencyFingerprintHash: string;
      }
    | undefined,
): string {
  const profile = binding?.profile ?? 'none';
  const dependencyKey = binding?.dependencyFingerprintHash ?? 'none';
  const workspace = shellQuote(workspaceHandle);
  if (profile === 'copy-on-write') {
    return `env NPM_CONFIG_CACHE="\${HOME}/.cache/clodex-runner/dependencies/node/${dependencyKey}/npm-cache" sh -c ${shellQuote(command)}`;
  }
  if (profile === 'cargo-cache') {
    return `env CARGO_HOME="\${HOME}/.cache/clodex-runner/dependencies/cargo/${dependencyKey}/home" CARGO_TARGET_DIR=${workspace}.cache/cargo-target sh -c ${shellQuote(command)}`;
  }
  if (profile === 'go-cache') {
    return `env GOMODCACHE="\${HOME}/.cache/clodex-runner/dependencies/go/${dependencyKey}/mod" GOCACHE=${workspace}.cache/go-build sh -c ${shellQuote(command)}`;
  }
  return command;
}

function persistentWorkspaceReleaseCommand(workspaceHandle: string): string {
  return `workspace=${shellQuote(workspaceHandle)}; rm -rf -- "$workspace.lease"`;
}

function createPersistentWorkspaceCacheKey(input: {
  connectionId: string;
  snapshotHash: string;
  repositoryRevision: string;
  dirtyPatchHash: string;
  archiveHash: string;
  dependencyFingerprintHash?: string;
  dependencyMaterialization: SshDependencyMaterialization;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 2,
        runner: input.connectionId,
        snapshotHash: input.snapshotHash,
        repositoryRevision: input.repositoryRevision,
        dirtyPatchHash: input.dirtyPatchHash,
        archiveHash: input.archiveHash,
        dependencyFingerprintHash: input.dependencyFingerprintHash ?? null,
        dependencyMaterialization: input.dependencyMaterialization,
      }),
    )
    .digest('hex');
}

function normalizeCacheTtl(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 60_000 ||
    value > 30 * 24 * 60 * 60 * 1_000
  ) {
    return DEFAULT_PERSISTENT_CACHE_TTL_MS;
  }
  return value;
}

function normalizeCacheMaxEntries(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 256
  ) {
    return DEFAULT_PERSISTENT_CACHE_MAX_ENTRIES;
  }
  return value;
}

function persistentWorkspaceGcCommand(
  ttlMs: number,
  maxEntries: number,
): string {
  const ttlSeconds = Math.max(60, Math.floor(ttlMs / 1_000));
  return [
    'gc_now="$(date +%s)"',
    `for gc_meta in "$cache_root"/workspaces/*.meta; do [ -f "$gc_meta" ] || continue; gc_workspace="\${gc_meta%.meta}"; [ -d "$gc_workspace.lease" ] && continue; gc_modified="$(stat -c %Y "$gc_meta" 2>/dev/null || stat -f %m "$gc_meta" 2>/dev/null || printf 0)"; if [ $((gc_now - gc_modified)) -gt ${ttlSeconds} ]; then git worktree remove --force -- "$gc_workspace" >/dev/null 2>&1 || rm -rf -- "$gc_workspace"; rm -rf -- "$gc_workspace.cache"; rm -f -- "$gc_meta"; fi; done`,
    `gc_count="$(find "$cache_root/workspaces" -maxdepth 1 -type f -name 'clodex-runner-*.meta' | wc -l | tr -d ' ')"`,
    `if [ "$gc_count" -ge ${maxEntries} ]; then for gc_meta in $(ls -1tr "$cache_root"/workspaces/clodex-runner-*.meta 2>/dev/null || true); do [ "$gc_count" -lt ${maxEntries} ] && break; gc_workspace="\${gc_meta%.meta}"; [ -d "$gc_workspace.lease" ] && continue; git worktree remove --force -- "$gc_workspace" >/dev/null 2>&1 || rm -rf -- "$gc_workspace"; rm -rf -- "$gc_workspace.cache"; rm -f -- "$gc_meta"; gc_count=$((gc_count - 1)); done; fi`,
  ].join('; ');
}

function parseReuseCount(stdout: string): number {
  const value = Number(parseMarkers(stdout).get('CLODEX_REUSE_COUNT'));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function toWorkspaceCacheProfile(
  profile: SshDependencyMaterialization,
): RunnerWorkspacePreparation['profile'] {
  return profile === 'copy-on-write' ? 'node-copy-on-write' : profile;
}

function assertSafeRelativeCwd(cwdRelative: string): void {
  if (
    cwdRelative.length > 4_096 ||
    path.posix.isAbsolute(cwdRelative) ||
    containsControlCharacter(cwdRelative) ||
    cwdRelative.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('SSH runner cwd escaped the prepared workspace');
  }
}

function createSshArtifactCaptureId(): string {
  return `artifact-${randomUUID().replaceAll('-', '')}`;
}

function artifactCaptureRoot(workspaceHandle: string): string {
  return `${workspaceHandle}.clodex-artifacts-v1`;
}

function artifactCaptureHelperPath(workspaceHandle: string): string {
  return `${artifactCaptureRoot(workspaceHandle)}/protocol-v1.sh`;
}

function buildArtifactCaptureBeginScript(input: {
  workspaceHandle: string;
  artifactCapture: SshRunnerArtifactCapture;
}): string {
  assertSshArtifactCapture(input.artifactCapture);
  const root = artifactCaptureRoot(input.workspaceHandle);
  const helper = artifactCaptureHelperPath(input.workspaceHandle);
  return [
    'set -eu',
    'umask 077',
    `artifact_root=${shellQuote(root)}`,
    'if [ -e "$artifact_root" ]; then test -d "$artifact_root" && test ! -L "$artifact_root"; else mkdir -m 700 "$artifact_root"; fi',
    'chmod 700 "$artifact_root"',
    `artifact_helper=${shellQuote(helper)}`,
    'test ! -L "$artifact_helper"',
    `printf '%s' ${shellQuote(buildArtifactCaptureHelperScript())} > "$artifact_helper.tmp.$$"`,
    'chmod 700 "$artifact_helper.tmp.$$"',
    'mv "$artifact_helper.tmp.$$" "$artifact_helper"',
    `sh "$artifact_helper" begin ${shellQuote(input.workspaceHandle)} ${shellQuote(
      input.artifactCapture.captureId,
    )} ${shellQuote(input.artifactCapture.snapshotHash)}`,
  ].join('\n');
}

function buildArtifactCaptureFinalizeScript(input: {
  workspaceHandle: string;
  artifactCapture: SshRunnerArtifactCapture;
}): string {
  assertSshArtifactCapture(input.artifactCapture);
  return [
    'set -eu',
    `artifact_helper=${shellQuote(
      artifactCaptureHelperPath(input.workspaceHandle),
    )}`,
    'test -f "$artifact_helper" && test ! -L "$artifact_helper"',
    `sh "$artifact_helper" finish ${shellQuote(input.workspaceHandle)} ${shellQuote(
      input.artifactCapture.captureId,
    )} ${shellQuote(input.artifactCapture.snapshotHash)}`,
  ].join('\n');
}

function buildTerminalArtifactFinalizationScript(input: {
  workspaceHandle: string;
  jobId: string;
  artifactCapture: SshRunnerArtifactCapture;
}): string {
  assertSshArtifactCapture(input.artifactCapture);
  const job = `/tmp/clodex-runner-jobs/${input.jobId}`;
  const helper = artifactCaptureHelperPath(input.workspaceHandle);
  return [
    `artifact_job=${shellQuote(job)}`,
    'artifact_job_state="$(cat "$artifact_job/state" 2>/dev/null || printf running)"',
    'if [ "$artifact_job_state" != running ]; then',
    `  artifact_helper=${shellQuote(helper)}`,
    `  if ! sh "$artifact_helper" finish ${shellQuote(
      input.workspaceHandle,
    )} ${shellQuote(input.artifactCapture.captureId)} ${shellQuote(
      input.artifactCapture.snapshotHash,
    )}; then printf 'CLODEX_ARTIFACT_CAPTURE_ERROR=1\\n'; fi`,
    'fi',
    'true',
  ].join('\n');
}

function buildArtifactCaptureHelperScript(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    `max_paths=${MAX_ARTIFACT_STATE_PATHS}`,
    `max_path_bytes=${MAX_ARTIFACT_PATH_BYTES}`,
    `max_hashed_bytes=${MAX_HASHED_ARTIFACT_BYTES}`,
    'mode="${1:-}"',
    'workspace="${2:-}"',
    'capture_id="${3:-}"',
    'snapshot_hash="${4:-}"',
    'case "$capture_id" in artifact-*) ;; *) exit 64 ;; esac',
    'capture_suffix="${capture_id#artifact-}"; [ "${#capture_suffix}" -eq 32 ] || exit 64',
    'case "$capture_suffix" in *[!a-f0-9]*) exit 64 ;; esac',
    'root="${workspace}.clodex-artifacts-v1"',
    'capture_dir="$root/$capture_id"',
    'now_ms() { value="$(date +%s%3N 2>/dev/null || true)"; case "$value" in ""|*[!0-9]*) printf \'%s000\\n\' "$(date +%s)" ;; *) printf \'%s\\n\' "$value" ;; esac; }',
    'decode_base64() { if printf "" | base64 --decode >/dev/null 2>&1; then base64 --decode; elif printf "" | base64 -d >/dev/null 2>&1; then base64 -d; else base64 -D; fi; }',
    'read_meta() { IFS="|" read -r state_count state_path_bytes state_truncated state_omitted < "$1"; case "$state_count:$state_path_bytes:$state_truncated:$state_omitted" in *[!0-9:]*|::*|*:) exit 65 ;; esac; }',
    'write_meta() { printf \'%s|%s|%s|%s\\n\' "$state_count" "$state_path_bytes" "$state_truncated" "$state_omitted" > "$1.tmp"; mv "$1.tmp" "$1"; }',
    'safe_path() { candidate="$1"; [ -n "$candidate" ] || return 1; candidate_bytes="$(printf \'%s\' "$candidate" | wc -c | tr -d \' \t\\n\')"; case "$candidate_bytes" in ""|*[!0-9]*) return 1 ;; esac; [ "$candidate_bytes" -le 4096 ] || return 1; cleaned="$(printf \'%s\' "$candidate" | LC_ALL=C tr -d \'[:cntrl:]\')"; [ "$cleaned" = "$candidate" ] || return 1; case "$candidate" in /*|*/|*//*|..|../*|*/../*|*/..|.git|.git/*|.clodex|.clodex/*|.stagewise|.stagewise/*) return 1 ;; esac; return 0; }',
    'append_paths() {',
    '  prefix="$1"; tracked="$2"; shift 2',
    '  entries="$capture_dir/$prefix.entries"; meta="$capture_dir/$prefix.meta"',
    '  read_meta "$meta"',
    '  for relative_path in "$@"; do',
    '    if ! safe_path "$relative_path"; then state_truncated=1; continue; fi',
    '    encoded="$(printf \'%s\' "$relative_path" | base64 | tr -d \'\\n\')"',
    '    if awk -F "|" -v key="$encoded" \'$1 == key { found=1 } END { exit found ? 0 : 1 }\' "$entries"; then continue; fi',
    '    next_bytes="$(printf \'%s\' "$relative_path" | wc -c | tr -d \' \t\\n\')"',
    '    if [ "$state_count" -ge "$max_paths" ] || [ $((state_path_bytes + next_bytes)) -gt "$max_path_bytes" ]; then state_truncated=1; continue; fi',
    '    target="$workspace/$relative_path"',
    '    if [ -L "$target" ]; then kind=U; size="$(wc -c < "$target" 2>/dev/null || printf 0)"; mode_value="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || printf 0)"; modified="$(stat -c %Y "$target" 2>/dev/null || stat -f %m "$target" 2>/dev/null || printf 0)"; digest=""; state_omitted=1',
    '    elif [ -f "$target" ]; then kind=F; size="$(wc -c < "$target")"; mode_value="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || printf 0)"; modified="$(stat -c %Y "$target" 2>/dev/null || stat -f %m "$target" 2>/dev/null || printf 0)"; if [ "$size" -le "$max_hashed_bytes" ]; then if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$target" | awk \'{print $1}\')"; else digest="$(shasum -a 256 "$target" | awk \'{print $1}\')"; fi; else digest=-; state_omitted=1; fi',
    '    elif [ ! -e "$target" ]; then kind=D; size=""; mode_value=""; modified=""; digest=""',
    '    else kind=U; size="$(wc -c < "$target" 2>/dev/null || printf 0)"; mode_value="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || printf 0)"; modified="$(stat -c %Y "$target" 2>/dev/null || stat -f %m "$target" 2>/dev/null || printf 0)"; digest=""; state_omitted=1',
    '    fi',
    '    printf \'%s|%s|%s|%s|%s|%s|%s\\n\' "$encoded" "$tracked" "$kind" "$size" "$mode_value" "$modified" "$digest" >> "$entries"',
    '    state_count=$((state_count + 1)); state_path_bytes=$((state_path_bytes + next_bytes))',
    '  done',
    '  write_meta "$meta"',
    '}',
    'capture_state() {',
    '  prefix="$1"; include_prefix="${2:-}"',
    '  entries="$capture_dir/$prefix.entries"; meta="$capture_dir/$prefix.meta"',
    '  : > "$entries"; printf \'0|0|0|0\\n\' > "$meta"',
    '  tracked_paths="$capture_dir/$prefix.tracked.paths"; untracked_paths="$capture_dir/$prefix.untracked.paths"',
    '  git -C "$workspace" diff --name-only --no-renames -z HEAD > "$tracked_paths"',
    '  git -C "$workspace" ls-files --others --exclude-standard -z > "$untracked_paths"',
    '  xargs -0 -n 64 sh "$0" append "$workspace" "$capture_id" "$prefix" 1 < "$tracked_paths"',
    '  xargs -0 -n 64 sh "$0" append "$workspace" "$capture_id" "$prefix" 0 < "$untracked_paths"',
    '  rm -f -- "$tracked_paths" "$untracked_paths"',
    '  if [ -n "$include_prefix" ]; then',
    '    include_entries="$capture_dir/$include_prefix.entries"',
    '    for include_tracked in 1 0; do',
    '      encoded_paths="$capture_dir/$prefix.include.$include_tracked.encoded"; decoded_paths="$capture_dir/$prefix.include.$include_tracked.paths"',
    '      awk -F "|" -v tracked="$include_tracked" \'$2 == tracked { print $1 }\' "$include_entries" > "$encoded_paths"',
    '      : > "$decoded_paths"',
    '      while IFS= read -r encoded; do [ -n "$encoded" ] || continue; if decoded="$(printf \'%s\' "$encoded" | decode_base64 2>/dev/null)"; then printf \'%s\\0\' "$decoded" >> "$decoded_paths"; else read_meta "$meta"; state_truncated=1; write_meta "$meta"; fi; done < "$encoded_paths"',
    '      xargs -0 -n 64 sh "$0" append "$workspace" "$capture_id" "$prefix" "$include_tracked" < "$decoded_paths"',
    '      rm -f -- "$encoded_paths" "$decoded_paths"',
    '    done',
    '  fi',
    '}',
    'case "$mode" in',
    '  append)',
    '    prefix="${4:-}"; tracked="${5:-}"; shift 5; [ "$tracked" = 0 ] || [ "$tracked" = 1 ] || exit 64; append_paths "$prefix" "$tracked" "$@"',
    '    ;;',
    '  begin)',
    '    [ -d "$root" ] && [ ! -L "$root" ]; test ! -e "$capture_dir"; mkdir -m 700 "$capture_dir"',
    '    capture_state before',
    `    printf 'CLODEX_ARTIFACT_PROTOCOL_VERSION=${SSH_ARTIFACT_CAPTURE_PROTOCOL_VERSION}\\n'`,
    '    printf \'CLODEX_ARTIFACT_CAPTURE_ID=%s\\n\' "$capture_id"',
    '    ;;',
    '  finish)',
    '    [ -d "$capture_dir" ] && [ ! -L "$capture_dir" ]; result="$capture_dir/result"',
    '    if [ -f "$result" ]; then cat "$result"; exit 0; fi',
    '    case "$snapshot_hash" in *[!a-f0-9]*) exit 64 ;; esac',
    '    [ "${#snapshot_hash}" -eq 64 ] || exit 64',
    '    started_at_ms="$(now_ms)"',
    '    capture_state after before',
    '    delta="$capture_dir/delta"',
    '    awk -F "|" \'FILENAME == ARGV[1] { before[$1]=$0; keys[$1]=1; next } { after[$1]=$0; keys[$1]=1 } END { for (key in keys) if (!(key in before) || !(key in after) || before[key] != after[key]) { if (key in before) print "B|" before[key]; if (key in after) print "A|" after[key] } }\' "$capture_dir/before.entries" "$capture_dir/after.entries" > "$delta"',
    '    read_meta "$capture_dir/before.meta"; before_truncated="$state_truncated"; before_omitted="$state_omitted"',
    '    read_meta "$capture_dir/after.meta"; after_truncated="$state_truncated"; after_omitted="$state_omitted"',
    '    truncated=0; if [ "$before_truncated" = 1 ] || [ "$after_truncated" = 1 ] || [ "$before_omitted" = 1 ] || [ "$after_omitted" = 1 ]; then truncated=1; fi',
    '    delta_base64="$(base64 < "$delta" | tr -d \'\\n\')"',
    '    finished_at_ms="$(now_ms)"; duration_ms=0; if [ "$finished_at_ms" -ge "$started_at_ms" ]; then duration_ms=$((finished_at_ms - started_at_ms)); fi',
    '    {',
    `      printf 'CLODEX_ARTIFACT_PROTOCOL_VERSION=${SSH_ARTIFACT_CAPTURE_PROTOCOL_VERSION}\\n'`,
    '      printf \'CLODEX_ARTIFACT_CAPTURE_ID=%s\\n\' "$capture_id"',
    '      printf \'CLODEX_ARTIFACT_SNAPSHOT_HASH=%s\\n\' "$snapshot_hash"',
    '      printf \'CLODEX_ARTIFACT_TRUNCATED=%s\\n\' "$truncated"',
    '      printf \'CLODEX_ARTIFACT_CAPTURE_DURATION_MS=%s\\n\' "$duration_ms"',
    '      printf \'CLODEX_ARTIFACT_DELTA_BASE64=%s\\n\' "$delta_base64"',
    '    } > "$result.tmp"',
    '    mv "$result.tmp" "$result"',
    '    rm -f -- "$capture_dir/before.entries" "$capture_dir/before.meta" "$capture_dir/after.entries" "$capture_dir/after.meta" "$delta"',
    '    cat "$result"',
    '    ;;',
    '  *) exit 64 ;;',
    'esac',
    '',
  ].join('\n');
}

function attachArtifactCapture(
  snapshot: RemoteRunnerJobSnapshot,
  stdout: string,
  artifactCapture: SshRunnerArtifactCapture | undefined,
): RemoteRunnerJobSnapshot {
  if (!artifactCapture) return snapshot;
  try {
    const captured = parseSshArtifactCaptureResult(stdout, artifactCapture);
    return captured ? { ...snapshot, artifactCapture: captured } : snapshot;
  } catch {
    // Artifact inspection is observational. Invalid or incomplete artifact
    // metadata is discarded without changing the already-dispatched command.
    return snapshot;
  }
}

function parseSshArtifactCaptureResult(
  stdout: string,
  expected: SshRunnerArtifactCapture,
): SshRunnerArtifactCaptureResult | null {
  assertSshArtifactCapture(expected);
  const markers = parseMarkers(stdout);
  const captureId = markers.get('CLODEX_ARTIFACT_CAPTURE_ID')?.trim();
  if (!captureId) return null;
  if (
    captureId !== expected.captureId ||
    markers.get('CLODEX_ARTIFACT_SNAPSHOT_HASH')?.trim() !==
      expected.snapshotHash ||
    markers.get('CLODEX_ARTIFACT_PROTOCOL_VERSION')?.trim() !==
      String(SSH_ARTIFACT_CAPTURE_PROTOCOL_VERSION)
  ) {
    throw new Error('SSH runner artifact capture binding is invalid');
  }
  const truncatedValue = markers.get('CLODEX_ARTIFACT_TRUNCATED')?.trim();
  if (truncatedValue !== '0' && truncatedValue !== '1') {
    throw new Error('SSH runner artifact capture truncation marker is invalid');
  }
  const captureDurationMs = parseNonNegativeInteger(
    markers.get('CLODEX_ARTIFACT_CAPTURE_DURATION_MS'),
    'artifact capture duration',
  );
  const delta = decodeCanonicalBase64(
    markers.get('CLODEX_ARTIFACT_DELTA_BASE64'),
    'artifact delta',
  ).toString('utf8');
  if (delta.includes('\uFFFD')) {
    throw new Error('SSH runner artifact delta is not valid UTF-8');
  }
  const before = new Map<string, WorkspaceArtifactStateEntry>();
  const after = new Map<string, WorkspaceArtifactStateEntry>();
  for (const line of delta.split('\n').filter(Boolean)) {
    const side = line.slice(0, 1);
    if ((side !== 'B' && side !== 'A') || line[1] !== '|') {
      throw new Error('SSH runner artifact delta record is invalid');
    }
    const entry = parseFastArtifactStateEntry(line.slice(2));
    const target = side === 'B' ? before : after;
    if (target.has(entry.relativePath)) {
      throw new Error('SSH runner artifact delta contains duplicate paths');
    }
    target.set(entry.relativePath, entry);
  }
  const truncated = truncatedValue === '1';
  const manifest: ExecutionArtifactManifest = createExecutionArtifactManifest({
    snapshotHash: expected.snapshotHash,
    before: { entries: [...before.values()], truncated },
    after: { entries: [...after.values()], truncated },
  });
  return Object.freeze({ manifest, captureDurationMs });
}

function parseFastArtifactStateEntry(
  line: string,
): WorkspaceArtifactStateEntry {
  const [
    encodedPath,
    trackedValue,
    kind,
    sizeValue,
    modeValue,
    modifiedValue,
    hashValue,
    ...extra
  ] = line.split('|');
  if (
    extra.length > 0 ||
    !encodedPath ||
    (trackedValue !== '0' && trackedValue !== '1')
  ) {
    throw new Error('SSH runner artifact state record is invalid');
  }
  const relativePathBuffer = decodeCanonicalBase64(
    encodedPath,
    'artifact path',
  );
  const relativePath = relativePathBuffer.toString('utf8');
  if (relativePath.includes('\uFFFD') || !isSafeArtifactPath(relativePath)) {
    throw new Error('SSH runner returned an unsafe artifact path');
  }
  const tracked = trackedValue === '1';
  if (kind === 'D') {
    if (sizeValue || modeValue || modifiedValue || hashValue) {
      throw new Error('SSH runner deleted artifact metadata is invalid');
    }
    return {
      relativePath,
      tracked,
      kind: 'deleted',
      sizeBytes: null,
      mode: null,
      sha256: null,
      modifiedAtMs: null,
      omissionReason: null,
    };
  }
  const sizeBytes = parseNonNegativeInteger(sizeValue, 'artifact size');
  const mode = parseArtifactMode(modeValue);
  const modifiedAtMs =
    parseNonNegativeInteger(modifiedValue, 'artifact mtime') * 1_000;
  if (kind === 'U') {
    if (hashValue) {
      throw new Error('SSH runner unsupported artifact metadata is invalid');
    }
    return {
      relativePath,
      tracked,
      kind: 'unsupported',
      sizeBytes,
      mode,
      sha256: null,
      modifiedAtMs,
      omissionReason: 'unsupported-file',
    };
  }
  if (kind !== 'F') {
    throw new Error('SSH runner artifact state kind is invalid');
  }
  const oversized = hashValue === '-';
  if (!oversized && !/^[a-f0-9]{64}$/.test(hashValue ?? '')) {
    throw new Error('SSH runner returned invalid artifact content hash');
  }
  return {
    relativePath,
    tracked,
    kind: 'file',
    sizeBytes,
    mode,
    sha256: oversized ? null : hashValue!,
    modifiedAtMs,
    omissionReason: oversized ? 'size-limit' : null,
  };
}

function decodeCanonicalBase64(
  value: string | undefined,
  label: string,
): Buffer {
  if (value === undefined || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`SSH runner returned invalid ${label} base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`SSH runner returned non-canonical ${label} base64`);
  }
  return decoded;
}

function assertSshArtifactCapture(
  artifactCapture: SshRunnerArtifactCapture,
): void {
  if (!SSH_ARTIFACT_CAPTURE_ID_PATTERN.test(artifactCapture.captureId)) {
    throw new Error('SSH runner artifact capture id is invalid');
  }
  assertSha256(artifactCapture.snapshotHash, 'Artifact capture snapshot hash');
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function artifactInspectionCommand(
  workspaceHandle: string,
  paths: readonly (readonly [string, boolean])[],
): string {
  return paths
    .map(([relativePath]) => {
      const target = shellQuote(`${workspaceHandle}/${relativePath}`);
      return [
        `target=${target}`,
        'if [ -L "$target" ]; then size="$(wc -c < "$target" 2>/dev/null || printf 0)"; mode="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || printf 0)"; modified="$(stat -c %Y "$target" 2>/dev/null || stat -f %m "$target" 2>/dev/null || printf 0)"; printf \'U|%s|%s|%s|\\n\' "$size" "$mode" "$modified"',
        'elif [ -f "$target" ]; then size="$(wc -c < "$target")"; mode="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || printf 0)"; modified="$(stat -c %Y "$target" 2>/dev/null || stat -f %m "$target" 2>/dev/null || printf 0)"; if [ "$size" -le ' +
          MAX_HASHED_ARTIFACT_BYTES +
          ' ]; then if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$target" | awk \'{print $1}\')"; else digest="$(shasum -a 256 "$target" | awk \'{print $1}\')"; fi; else digest="-"; fi; printf \'F|%s|%s|%s|%s\\n\' "$size" "$mode" "$modified" "$digest"',
        'elif [ ! -e "$target" ]; then printf \'D||||\\n\'',
        'else size="$(wc -c < "$target" 2>/dev/null || printf 0)"; mode="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || printf 0)"; modified="$(stat -c %Y "$target" 2>/dev/null || stat -f %m "$target" 2>/dev/null || printf 0)"; printf \'U|%s|%s|%s|\\n\' "$size" "$mode" "$modified"',
        'fi',
      ].join('; ');
    })
    .join('; ');
}

function createArtifactInspectionBatches(
  workspaceHandle: string,
  paths: readonly (readonly [string, boolean])[],
): Array<{
  paths: Array<readonly [string, boolean]>;
  command: string;
}> {
  const batches: Array<{
    paths: Array<readonly [string, boolean]>;
    command: string;
  }> = [];
  let current: Array<readonly [string, boolean]> = [];
  for (const entry of paths) {
    const candidate = [...current, entry];
    const command = artifactInspectionCommand(workspaceHandle, candidate);
    if (
      current.length > 0 &&
      command.length > MAX_ARTIFACT_INSPECTION_COMMAND_LENGTH
    ) {
      batches.push({
        paths: current,
        command: artifactInspectionCommand(workspaceHandle, current),
      });
      current = [entry];
    } else {
      current = candidate;
    }
    if (
      artifactInspectionCommand(workspaceHandle, current).length >
      MAX_ARTIFACT_INSPECTION_COMMAND_LENGTH
    ) {
      throw new Error('SSH runner artifact path exceeds command limit');
    }
  }
  if (current.length > 0) {
    batches.push({
      paths: current,
      command: artifactInspectionCommand(workspaceHandle, current),
    });
  }
  return batches;
}

function parseArtifactStateEntry(
  [relativePath, tracked]: readonly [string, boolean],
  line: string,
): WorkspaceArtifactStateEntry {
  const [kind, sizeValue, modeValue, modifiedValue, hashValue] =
    line.split('|');
  if (kind === 'D') {
    return {
      relativePath,
      tracked,
      kind: 'deleted',
      sizeBytes: null,
      mode: null,
      sha256: null,
      modifiedAtMs: null,
      omissionReason: null,
    };
  }
  const sizeBytes = parseNonNegativeInteger(sizeValue, 'artifact size');
  const mode = parseArtifactMode(modeValue);
  const modifiedAtMs =
    parseNonNegativeInteger(modifiedValue, 'artifact mtime') * 1_000;
  if (kind === 'U') {
    return {
      relativePath,
      tracked,
      kind: 'unsupported',
      sizeBytes,
      mode,
      sha256: null,
      modifiedAtMs,
      omissionReason: 'unsupported-file',
    };
  }
  if (kind !== 'F') {
    throw new Error('SSH runner returned invalid artifact metadata');
  }
  const oversized = hashValue === '-';
  if (!oversized && !/^[a-f0-9]{64}$/.test(hashValue ?? '')) {
    throw new Error('SSH runner returned invalid artifact content hash');
  }
  return {
    relativePath,
    tracked,
    kind: 'file',
    sizeBytes,
    mode,
    sha256: oversized ? null : hashValue!,
    modifiedAtMs,
    omissionReason: oversized ? 'size-limit' : null,
  };
}

function parseArtifactPathLists(value: string): {
  tracked: string[];
  untracked: string[];
} {
  const values = value.split('\0').filter(Boolean);
  const trackedEnd = values.indexOf(ARTIFACT_TRACKED_PATH_LIST_END);
  const untrackedEnd = values.indexOf(ARTIFACT_UNTRACKED_PATH_LIST_END);
  if (
    trackedEnd < 0 ||
    untrackedEnd !== values.length - 1 ||
    untrackedEnd <= trackedEnd
  ) {
    throw new Error('SSH runner artifact path list was truncated');
  }
  return {
    tracked: values.slice(0, trackedEnd),
    untracked: values.slice(trackedEnd + 1, untrackedEnd),
  };
}

function parseNullSeparatedPaths(value: string): string[] {
  const values = value.split('\0').filter(Boolean);
  if (values.pop() !== ARTIFACT_PATH_LIST_END) {
    throw new Error('SSH runner artifact path list was truncated');
  }
  return values;
}

function parseNonNegativeInteger(
  value: string | undefined,
  label: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`SSH runner returned invalid ${label}`);
  }
  return parsed;
}

function parseArtifactMode(value: string | undefined): number {
  if (!value || !/^[0-7]{1,6}$/.test(value)) {
    throw new Error('SSH runner returned invalid artifact mode');
  }
  return Number.parseInt(value, 8) & 0o777;
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

function assertSafeWorkspaceHandle(
  workspaceHandle: string,
  expectedSnapshotHash?: string,
): void {
  if (
    workspaceHandle.length > 4_096 ||
    !path.posix.isAbsolute(workspaceHandle) ||
    containsControlCharacter(workspaceHandle) ||
    workspaceHandle.split('/').includes('..')
  ) {
    throw new Error('SSH runner returned an unsafe workspace handle');
  }
  const basename = path.posix.basename(workspaceHandle);
  const expectedPrefix = expectedSnapshotHash
    ? `clodex-runner-${expectedSnapshotHash.slice(0, 16)}.`
    : 'clodex-runner-';
  if (
    !basename.startsWith(expectedPrefix) ||
    !/^clodex-runner-[a-f0-9]{16}\.[A-Za-z0-9]+$/.test(basename)
  ) {
    throw new Error('SSH runner returned an unsafe workspace handle');
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseMarkers(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return separator < 0
          ? null
          : ([line.slice(0, separator), line.slice(separator + 1)] as const);
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeDiagnosticTail(value: string): string {
  return Array.from(value.slice(-8_192), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  })
    .join('')
    .trim();
}
