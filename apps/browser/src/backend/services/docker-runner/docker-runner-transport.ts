import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  DockerRunnerCommandResult,
  DockerRunnerPreparedWorkspace,
  DockerRunnerTransport,
  RemoteRunnerJobSnapshot,
  WorkspaceArtifactState,
  WorkspaceArtifactStateEntry,
  WorkspaceExecutionMaterialization,
} from '@clodex/agent-shell';
import { createWorkspaceEnvironmentFingerprint } from '@clodex/agent-core/agents';
import {
  buildRemoteJobCancelScript,
  buildRemoteJobCleanupScript,
  buildRemoteJobReadScript,
  buildRemoteJobStartScript,
  createRemoteRunnerJobId,
  parseRemoteJobId,
  parseRemoteJobSnapshot,
} from '../runner-remote-job-protocol';

const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_REPOSITORY_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_MATERIALIZATION_BYTES = 128 * 1024 * 1024;
const PREPARATION_TIMEOUT_MS = 120_000;
const MAX_ARTIFACT_STATE_PATHS = 512;
const MAX_ARTIFACT_PATH_BYTES = 64 * 1024;
const MAX_HASHED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_INSPECTION_COMMAND_LENGTH = 60_000;
const ARTIFACT_PATH_LIST_END = 'CLODEX_ARTIFACT_PATH_LIST_END';

export interface DockerRunnerConfig {
  image: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
}

interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface DockerCommandExecutor {
  execute(input: {
    args: readonly string[];
    timeoutMs: number;
    stdin?: Uint8Array;
  }): Promise<DockerCommandResult>;
}

export class SystemDockerCommandExecutor implements DockerCommandExecutor {
  public async execute(input: {
    args: readonly string[];
    timeoutMs: number;
    stdin?: Uint8Array;
  }): Promise<DockerCommandResult> {
    return await runProcess('docker', input.args, input.timeoutMs, input.stdin);
  }
}

export class DockerCliRunnerTransport implements DockerRunnerTransport {
  private readonly preparedContainers = new Set<string>();
  private readonly quarantinedContainers = new Set<string>();
  private readonly retiredContainers = new Set<string>();
  private readonly containerJobs = new Map<string, Set<string>>();

  public constructor(
    private readonly config: DockerRunnerConfig,
    private readonly docker: DockerCommandExecutor = new SystemDockerCommandExecutor(),
  ) {
    assertDockerRunnerConfig(config);
  }

  public async prepareWorkspace(input: {
    snapshotHash: string;
    workspaceRoot: string;
    repositoryRevision: string;
    dirtyPatchHash: string;
    materialization: WorkspaceExecutionMaterialization;
  }): Promise<DockerRunnerPreparedWorkspace> {
    assertSha256(input.snapshotHash, 'Docker snapshot hash');
    assertSha256(input.dirtyPatchHash, 'Docker dirty patch hash');
    assertSha256(
      input.materialization.archiveHash,
      'Docker materialization hash',
    );
    if (
      input.materialization.totalBytes !==
        input.materialization.archive.byteLength ||
      input.materialization.totalBytes > MAX_MATERIALIZATION_BYTES
    ) {
      throw new Error('Docker materialization size is invalid');
    }

    const bundle = await createRepositoryBundle(
      input.workspaceRoot,
      input.repositoryRevision,
    );
    const containerName = `clodex-runner-${input.snapshotHash.slice(0, 16)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let containerId: string | null = null;
    try {
      const created = await this.run(
        [
          'create',
          '--name',
          containerName,
          '--network',
          'none',
          '--read-only',
          '--user',
          '65532:65532',
          '--env',
          'HOME=/tmp/clodex-home',
          '--workdir',
          '/workspace',
          '--entrypoint',
          'sh',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,noexec,mode=1777',
          '--tmpfs',
          '/workspace:rw,nosuid,nodev,mode=1777',
          '--pid',
          'private',
          '--ipc',
          'private',
          '--uts',
          'private',
          '--cpus',
          String(this.config.cpus),
          '--memory',
          `${this.config.memoryMb}m`,
          '--pids-limit',
          String(this.config.pidsLimit),
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--ulimit',
          'nofile=1024:1024',
          '--stop-timeout',
          '1',
          '--label',
          'clodex.runner=true',
          this.config.image,
          '-c',
          'while :; do sleep 3600; done',
        ],
        30_000,
      );
      containerId = created.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
        throw new Error('Docker create returned an invalid container id');
      }
      await this.requireSuccess(['start', containerId], 30_000);
      await this.requireSuccess(
        [
          'exec',
          '-i',
          containerId,
          'sh',
          '-c',
          'cat > /tmp/clodex-repository.bundle',
        ],
        PREPARATION_TIMEOUT_MS,
        bundle,
      );
      await this.requireSuccess(
        [
          'exec',
          '-i',
          containerId,
          'sh',
          '-c',
          'cat > /tmp/clodex-materialization.tar.gz',
        ],
        PREPARATION_TIMEOUT_MS,
        input.materialization.archive,
      );
      const prepared = await this.requireSuccess(
        [
          'exec',
          containerId,
          'sh',
          '-c',
          workspacePreparationScript({
            repositoryRevision: input.repositoryRevision,
            archiveHash: input.materialization.archiveHash,
          }),
        ],
        PREPARATION_TIMEOUT_MS,
      );
      const markers = parseMarkers(prepared.stdout);
      const repositoryRevision = markers.get('CLODEX_REVISION')?.trim();
      const materializationArchiveHash = markers
        .get('CLODEX_ARCHIVE_SHA256')
        ?.trim();
      if (
        repositoryRevision !== input.repositoryRevision ||
        materializationArchiveHash !== input.materialization.archiveHash
      ) {
        throw new Error('Docker workspace preparation attestation mismatch');
      }
      const environment = createWorkspaceEnvironmentFingerprint({
        os: markers.get('CLODEX_OS')?.trim() || 'linux',
        arch: markers.get('CLODEX_ARCH')?.trim() || 'unknown',
        shell: markers.get('CLODEX_SHELL')?.trim() || '/bin/sh',
        toolchains: Object.fromEntries(
          [
            ['node', markers.get('CLODEX_NODE')?.trim()],
            ['git', markers.get('CLODEX_GIT')?.trim()],
            ['image', this.config.image],
          ].filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
      });
      this.preparedContainers.add(containerId);
      this.containerJobs.set(containerId, new Set());
      return {
        workspaceHandle: containerId,
        repositoryRevision,
        dirtyPatchHash: input.dirtyPatchHash,
        materializationArchiveHash,
        environmentFingerprintHash: environment.fingerprintHash,
      };
    } catch (error) {
      if (containerId) {
        await this.run(['rm', '-f', containerId], 30_000).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  public async execute(input: {
    workspaceHandle: string;
    command: string;
    cwdRelative: string;
    timeoutMs: number;
  }): Promise<DockerRunnerCommandResult> {
    this.assertKnownContainer(input.workspaceHandle);
    assertSafeRelativePath(input.cwdRelative);
    const cwd = input.cwdRelative
      ? `/workspace/${input.cwdRelative}`
      : '/workspace';
    const result = await this.run(
      ['exec', '-w', cwd, input.workspaceHandle, 'sh', '-c', input.command],
      Math.min(120_000, Math.max(1_000, input.timeoutMs)),
    );
    if (result.timedOut) {
      this.quarantinedContainers.add(input.workspaceHandle);
      const removed = await this.run(
        ['rm', '-f', input.workspaceHandle],
        30_000,
      ).catch(() => null);
      if (removed?.exitCode === 0) {
        this.preparedContainers.delete(input.workspaceHandle);
        this.quarantinedContainers.delete(input.workspaceHandle);
        this.retiredContainers.add(input.workspaceHandle);
      }
      throw new Error(
        removed?.exitCode === 0
          ? 'Docker runner command timed out; container was terminated'
          : 'Docker runner command timed out; container cleanup failed',
      );
    }
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
  }): Promise<{ jobId: string }> {
    this.assertKnownContainer(input.workspaceHandle);
    assertSafeRelativePath(input.cwdRelative);
    const jobId = createRemoteRunnerJobId();
    const result = await this.runInContainer(
      input.workspaceHandle,
      buildRemoteJobStartScript({
        jobId,
        workspacePath: '/workspace',
        cwdRelative: input.cwdRelative,
        command: input.command,
        timeoutMs: input.timeoutMs,
      }),
      30_000,
    );
    if (result.exitCode !== 0 || parseRemoteJobId(result.stdout) !== jobId) {
      throw new Error('Docker runner could not start the remote job');
    }
    this.containerJobs.get(input.workspaceHandle)!.add(jobId);
    return { jobId };
  }

  public async readJob(input: {
    workspaceHandle: string;
    jobId: string;
    stdoutOffset: number;
    stderrOffset: number;
  }): Promise<RemoteRunnerJobSnapshot> {
    this.assertKnownJob(input.workspaceHandle, input.jobId);
    const result = await this.runInContainer(
      input.workspaceHandle,
      buildRemoteJobReadScript(input),
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('Docker runner could not read the remote job');
    }
    return parseRemoteJobSnapshot(result.stdout);
  }

  public async cancelJob(input: {
    workspaceHandle: string;
    jobId: string;
    stdoutOffset: number;
    stderrOffset: number;
  }): Promise<RemoteRunnerJobSnapshot> {
    this.assertKnownJob(input.workspaceHandle, input.jobId);
    const result = await this.runInContainer(
      input.workspaceHandle,
      buildRemoteJobCancelScript(input.jobId),
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error('Docker runner could not cancel the remote job');
    }
    return await this.readJob(input);
  }

  public async captureWorkspaceArtifactState(input: {
    workspaceHandle: string;
    includeEntries?: readonly WorkspaceArtifactStateEntry[];
  }): Promise<WorkspaceArtifactState> {
    this.assertKnownContainer(input.workspaceHandle);
    const [trackedResult, untrackedResult] = await Promise.all([
      this.runInContainer(
        input.workspaceHandle,
        `git -C /workspace diff --name-only --no-renames -z HEAD && printf '\\0${ARTIFACT_PATH_LIST_END}\\0'`,
        30_000,
      ),
      this.runInContainer(
        input.workspaceHandle,
        `git -C /workspace ls-files --others --exclude-standard -z && printf '\\0${ARTIFACT_PATH_LIST_END}\\0'`,
        30_000,
      ),
    ]);
    if (trackedResult.exitCode !== 0 || untrackedResult.exitCode !== 0) {
      throw new Error('Docker runner could not inspect workspace artifacts');
    }
    const candidates = new Map<string, boolean>();
    let truncated = false;
    for (const relativePath of parseNullSeparatedPaths(trackedResult.stdout)) {
      if (!isSafeArtifactPath(relativePath)) {
        truncated = true;
        continue;
      }
      candidates.set(relativePath, true);
    }
    for (const relativePath of parseNullSeparatedPaths(
      untrackedResult.stdout,
    )) {
      if (!isSafeArtifactPath(relativePath)) {
        truncated = true;
        continue;
      }
      candidates.set(relativePath, false);
    }
    for (const entry of input.includeEntries ?? []) {
      if (
        isSafeArtifactPath(entry.relativePath) &&
        !candidates.has(entry.relativePath)
      ) {
        candidates.set(entry.relativePath, entry.tracked);
      }
    }
    const paths: Array<readonly [string, boolean]> = [];
    let pathBytes = 0;
    for (const entry of [...candidates].sort(([left], [right]) =>
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
    const lines: string[] = [];
    for (const batch of createArtifactInspectionBatches(paths)) {
      const inspection = await this.runInContainer(
        input.workspaceHandle,
        batch.command,
        120_000,
      );
      if (inspection.exitCode !== 0) {
        throw new Error('Docker runner could not hash workspace artifacts');
      }
      const batchLines = inspection.stdout.split('\n').filter(Boolean);
      if (batchLines.length !== batch.paths.length) {
        throw new Error('Docker runner returned incomplete artifact metadata');
      }
      lines.push(...batchLines);
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
    if (this.retiredContainers.delete(workspaceHandle)) {
      this.containerJobs.delete(workspaceHandle);
      return;
    }
    assertContainerId(workspaceHandle);
    if (
      !this.preparedContainers.has(workspaceHandle) &&
      !this.quarantinedContainers.has(workspaceHandle)
    ) {
      throw new Error('Docker runner container is unknown or expired');
    }
    const jobs = [...(this.containerJobs.get(workspaceHandle) ?? [])];
    if (jobs.length > 0 && this.preparedContainers.has(workspaceHandle)) {
      await this.runInContainer(
        workspaceHandle,
        buildRemoteJobCleanupScript(jobs),
        30_000,
      ).catch(() => undefined);
    }
    const result = await this.run(['rm', '-f', workspaceHandle], 30_000);
    if (result.exitCode !== 0) {
      throw new Error('Docker runner could not remove its container');
    }
    this.preparedContainers.delete(workspaceHandle);
    this.quarantinedContainers.delete(workspaceHandle);
    this.containerJobs.delete(workspaceHandle);
  }

  private assertKnownContainer(containerId: string): void {
    if (
      !/^[a-f0-9]{12,64}$/i.test(containerId) ||
      !this.preparedContainers.has(containerId) ||
      this.quarantinedContainers.has(containerId)
    ) {
      throw new Error('Docker runner container is unknown or expired');
    }
  }

  private assertKnownJob(containerId: string, jobId: string): void {
    this.assertKnownContainer(containerId);
    if (!this.containerJobs.get(containerId)?.has(jobId)) {
      throw new Error('Docker runner job is unknown or expired');
    }
  }

  private async requireSuccess(
    args: readonly string[],
    timeoutMs: number,
    stdin?: Uint8Array,
  ): Promise<DockerCommandResult> {
    const result = await this.run(args, timeoutMs, stdin);
    if (result.exitCode !== 0) {
      throw new Error(
        `Docker runner command failed: ${sanitizeError(result.stderr)}`,
      );
    }
    return result;
  }

  private run(
    args: readonly string[],
    timeoutMs: number,
    stdin?: Uint8Array,
  ): Promise<DockerCommandResult> {
    return this.docker.execute({ args, timeoutMs, stdin });
  }

  private runInContainer(
    containerId: string,
    command: string,
    timeoutMs: number,
  ): Promise<DockerCommandResult> {
    return this.run(['exec', containerId, 'sh', '-c', command], timeoutMs);
  }
}

export function readDockerRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
): DockerRunnerConfig | null {
  const image = env.CLODEX_DOCKER_RUNNER_IMAGE?.trim();
  if (!image) return null;
  const config = {
    image,
    cpus: readBoundedNumber(env.CLODEX_DOCKER_RUNNER_CPUS, 2, 0.25, 64),
    memoryMb: readBoundedInteger(
      env.CLODEX_DOCKER_RUNNER_MEMORY_MB,
      4_096,
      128,
      262_144,
    ),
    pidsLimit: readBoundedInteger(
      env.CLODEX_DOCKER_RUNNER_PIDS_LIMIT,
      512,
      16,
      65_536,
    ),
  };
  assertDockerRunnerConfig(config);
  return config;
}

function workspacePreparationScript(input: {
  repositoryRevision: string;
  archiveHash: string;
}): string {
  const revision = shellQuote(input.repositoryRevision);
  const archiveHash = shellQuote(input.archiveHash);
  return [
    'set -eu',
    'archive=/tmp/clodex-materialization.tar.gz',
    'stage=/tmp/clodex-materialization-stage',
    'rm -rf /workspace/* /workspace/.[!.]* /workspace/..?* "$stage" 2>/dev/null || true',
    'mkdir -p "$stage" "$HOME"',
    'if command -v sha256sum >/dev/null 2>&1; then actual_archive_hash="$(sha256sum "$archive" | awk \'{print $1}\')"; elif command -v shasum >/dev/null 2>&1; then actual_archive_hash="$(shasum -a 256 "$archive" | awk \'{print $1}\')"; else exit 72; fi',
    `test "$actual_archive_hash" = ${archiveHash}`,
    'tar -tzf "$archive" | while IFS= read -r entry; do case "$entry" in ".clodex/tracked.patch"|workspace/*) ;; *) exit 74 ;; esac; case "/$entry/" in *"/../"*|*"/./"*|*"/workspace/.git/"*|*"/workspace/.clodex/"*) exit 74 ;; esac; done',
    'git clone --no-checkout /tmp/clodex-repository.bundle /workspace >/dev/null 2>&1',
    `git -C /workspace checkout --detach ${revision} >/dev/null 2>&1`,
    'tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"',
    'if [ -s "$stage/.clodex/tracked.patch" ]; then git -C /workspace apply --binary --whitespace=nowarn "$stage/.clodex/tracked.patch"; fi',
    'if [ -d "$stage/workspace" ]; then cp -R "$stage/workspace/." /workspace/; fi',
    'actual_revision="$(git -C /workspace rev-parse HEAD)"',
    'rm -rf "$stage" /tmp/clodex-repository.bundle "$archive"',
    'printf \'CLODEX_REVISION=%s\\n\' "$actual_revision"',
    'printf \'CLODEX_ARCHIVE_SHA256=%s\\n\' "$actual_archive_hash"',
    'printf \'CLODEX_OS=%s\\n\' "$(uname -s 2>/dev/null || printf Linux)"',
    'printf \'CLODEX_ARCH=%s\\n\' "$(uname -m 2>/dev/null || printf unknown)"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: evaluated inside the container shell
    'printf \'CLODEX_SHELL=%s\\n\' "${SHELL:-/bin/sh}"',
    'printf \'CLODEX_NODE=%s\\n\' "$(node --version 2>/dev/null || true)"',
    'printf \'CLODEX_GIT=%s\\n\' "$(git --version 2>/dev/null || true)"',
  ].join('; ');
}

function artifactInspectionCommand(
  paths: readonly (readonly [string, boolean])[],
): string {
  return paths
    .map(([relativePath]) => {
      const target = shellQuote(`/workspace/${relativePath}`);
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
    const command = artifactInspectionCommand(candidate);
    if (
      current.length > 0 &&
      command.length > MAX_ARTIFACT_INSPECTION_COMMAND_LENGTH
    ) {
      batches.push({
        paths: current,
        command: artifactInspectionCommand(current),
      });
      current = [entry];
    } else {
      current = candidate;
    }
    if (
      artifactInspectionCommand(current).length >
      MAX_ARTIFACT_INSPECTION_COMMAND_LENGTH
    ) {
      throw new Error('Docker runner artifact path exceeds command limit');
    }
  }
  if (current.length > 0) {
    batches.push({
      paths: current,
      command: artifactInspectionCommand(current),
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
    throw new Error('Docker runner returned invalid artifact metadata');
  }
  const oversized = hashValue === '-';
  if (!oversized && !/^[a-f0-9]{64}$/.test(hashValue ?? '')) {
    throw new Error('Docker runner returned invalid artifact content hash');
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

function parseNullSeparatedPaths(value: string): string[] {
  const values = value.split('\0').filter(Boolean);
  if (values.pop() !== ARTIFACT_PATH_LIST_END) {
    throw new Error('Docker runner artifact path list was truncated');
  }
  return values;
}

function parseNonNegativeInteger(
  value: string | undefined,
  label: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Docker runner returned invalid ${label}`);
  }
  return parsed;
}

function parseArtifactMode(value: string | undefined): number {
  if (!value || !/^[0-7]{1,6}$/.test(value)) {
    throw new Error('Docker runner returned invalid artifact mode');
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
      segments[0] !== '.clodex',
  );
}

async function createRepositoryBundle(
  workspaceRoot: string,
  repositoryRevision: string,
): Promise<Buffer> {
  const actualRevision = (
    await runProcess('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], 15_000)
  ).stdout.trim();
  if (actualRevision !== repositoryRevision) {
    throw new Error('Docker runner local repository revision changed');
  }
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'clodex-docker-bundle-'),
  );
  const bundlePath = path.join(temporaryRoot, 'repository.bundle');
  try {
    const result = await runProcess(
      'git',
      ['-C', workspaceRoot, 'bundle', 'create', bundlePath, 'HEAD'],
      PREPARATION_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Git bundle failed: ${sanitizeError(result.stderr)}`);
    }
    const bundleStat = await stat(bundlePath);
    if (bundleStat.size <= 0 || bundleStat.size > MAX_REPOSITORY_BUNDLE_BYTES) {
      throw new Error('Docker repository bundle size is invalid');
    }
    return await readFile(bundlePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: Uint8Array,
): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'));
    });
    if (stdin) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(Buffer.from(stdin));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function assertContainerId(containerId: string): void {
  if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
    throw new Error('Docker runner container is unknown or expired');
  }
}

function appendBounded(current: string, chunk: string): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  return `${current}${chunk}`.slice(0, MAX_CAPTURED_OUTPUT_BYTES);
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

function assertDockerRunnerConfig(config: DockerRunnerConfig): void {
  if (
    !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(config.image) ||
    !Number.isFinite(config.cpus) ||
    config.cpus < 0.25 ||
    config.cpus > 64 ||
    !Number.isSafeInteger(config.memoryMb) ||
    config.memoryMb < 128 ||
    config.memoryMb > 262_144 ||
    !Number.isSafeInteger(config.pidsLimit) ||
    config.pidsLimit < 16 ||
    config.pidsLimit > 65_536
  ) {
    throw new Error('Docker runner configuration is invalid');
  }
}

function assertSafeRelativePath(value: string): void {
  const segments = value.replaceAll('\\', '/').split('/');
  if (
    value.length > 4_096 ||
    value.startsWith('/') ||
    containsControlCharacter(value) ||
    segments.some((segment) => segment === '..')
  ) {
    throw new Error('Docker runner cwd escaped its workspace');
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeError(value: string): string {
  return (
    value
      .replaceAll(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 512) || 'unknown'
  );
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Docker runner integer limit is invalid');
  }
  return parsed;
}

function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Docker runner numeric limit is invalid');
  }
  return parsed;
}
