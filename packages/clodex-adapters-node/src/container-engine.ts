import {
  NodeAdapterSecurityError,
  assertPinnedDirectoryLease,
  openPinnedDataFile,
  requireBoundedInteger,
  requireContainerMountSource,
  requireDigest,
  requireSafeAbsolutePath,
  runPinnedExecutable,
  sha256Text,
  type PinnedDataFileDescriptor,
  type PinnedDirectoryLease,
  type PinnedExecutableDescriptor,
  type PinnedProcessResult,
} from './node-security.js';

export const CLODEX_GIT_CONTAINER_ENTRYPOINT = '/usr/bin/git' as const;
export const CLODEX_TEST_CONTAINER_ENTRYPOINT =
  '/opt/clodex/bin/test-runner-v1' as const;

const FORBIDDEN_GIT_CONFIG_PATTERN = [
  '^(alias|include|include[Ii]f|filter|diff|pager|credential)\\.',
  '|^core\\.(fsmonitor|ssh[Cc]ommand|ask[Pp]ass|hooks[Pp]ath)$',
  '|^interactive\\.diff[Ff]ilter$',
].join('');

export interface DockerResourceLimits {
  readonly cpus: string;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly nofile: number;
  readonly scratchBytes: number;
  readonly temporaryBytes: number;
}

export interface DigestPinnedDockerEngineOptions {
  readonly executable: PinnedExecutableDescriptor;
  readonly daemonSocket: string;
  readonly seccompProfile: PinnedDataFileDescriptor;
  readonly appArmorProfile: string;
  readonly limits?: DockerResourceLimits;
  readonly cleanupTimeoutMs?: number;
}

export interface GitContainerInvocation {
  readonly workspace: PinnedDirectoryLease;
  readonly scopeBinding: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly operation: 'status' | 'diff-patch' | 'diff-names';
  readonly scope?: 'worktree' | 'staged';
  readonly invocationId: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

export interface TestContainerInvocation {
  readonly workspace: PinnedDirectoryLease;
  readonly scopeBinding: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly testPlanDigest: string;
  readonly runnerDigest: string;
  readonly invocationId: string;
  readonly timeoutMs: number;
  readonly maxReportBytes: number;
}

const DEFAULT_LIMITS = Object.freeze({
  cpus: '2.0',
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 512,
  nofile: 1024,
  scratchBytes: 2 * 1024 * 1024 * 1024,
  temporaryBytes: 128 * 1024 * 1024,
} satisfies DockerResourceLimits);

/**
 * Closed Docker authority used only by the fixed Git observer and registered
 * test-plan capabilities below. There is intentionally no public argv, mount,
 * environment, image-tag, network, device, or privilege passthrough method.
 */
export class DigestPinnedDockerEngine {
  readonly #executable: PinnedExecutableDescriptor;
  readonly #daemonSocket: string;
  readonly #seccompProfile: PinnedDataFileDescriptor;
  readonly #appArmorProfile: string;
  readonly #limits: DockerResourceLimits;
  readonly #cleanupTimeoutMs: number;

  public constructor(options: DigestPinnedDockerEngineOptions) {
    this.#executable = Object.freeze({
      ...readOwnData<PinnedExecutableDescriptor>(options, 'executable'),
    });
    this.#daemonSocket = requireDockerSocket(
      readOwnData<string>(options, 'daemonSocket'),
    );
    this.#seccompProfile = Object.freeze({
      ...readOwnData<PinnedDataFileDescriptor>(options, 'seccompProfile'),
    });
    this.#appArmorProfile = requireAppArmorProfile(
      readOwnData<string>(options, 'appArmorProfile'),
    );
    this.#limits = snapshotLimits(
      readOptionalOwnData(options, 'limits') ?? DEFAULT_LIMITS,
    );
    this.#cleanupTimeoutMs = requireBoundedInteger(
      readOptionalOwnData(options, 'cleanupTimeoutMs') ?? 10_000,
      100,
      60_000,
      'Docker compensation timeout',
    );
    Object.freeze(this);
  }

  public async executeGitObservation(
    input: GitContainerInvocation,
  ): Promise<PinnedProcessResult> {
    const scope = input.scope;
    if (
      input.operation !== 'status' &&
      scope !== 'worktree' &&
      scope !== 'staged'
    ) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'execute',
        'Git diff container invocation requires a fixed worktree or staged scope',
      );
    }
    const audit = await this.#runContainer({
      workspace: input.workspace,
      scopeBinding: input.scopeBinding,
      imageReference: input.imageReference,
      imageDigest: input.imageDigest,
      entrypoint: CLODEX_GIT_CONTAINER_ENTRYPOINT,
      commandArguments: fixedGitConfigAuditArguments(),
      operationKind: 'git-config-audit',
      invocationId: `${input.invocationId}:config-audit`,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      fixedEnvironment: fixedGitEnvironment(),
    });
    assertGitConfigAuditAccepted(audit);
    const gitArguments = fixedGitArguments(input.operation, scope);
    return await this.#runContainer({
      workspace: input.workspace,
      scopeBinding: input.scopeBinding,
      imageReference: input.imageReference,
      imageDigest: input.imageDigest,
      entrypoint: CLODEX_GIT_CONTAINER_ENTRYPOINT,
      commandArguments: gitArguments,
      operationKind: `git-${input.operation}`,
      invocationId: input.invocationId,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxStdoutBytes,
      maxStderrBytes: 256 * 1024,
      fixedEnvironment: fixedGitEnvironment(),
    });
  }

  public async executeRegisteredTestPlan(
    input: TestContainerInvocation,
  ): Promise<PinnedProcessResult> {
    const profileId = requireToken(input.profileId, 'Test profile ID');
    const profileDigest = requireDigest(
      input.profileDigest,
      'Test profile digest',
    );
    const testPlanDigest = requireDigest(
      input.testPlanDigest,
      'Test plan digest',
    );
    const runnerDigest = requireDigest(
      input.runnerDigest,
      'Test runner digest',
    );
    return await this.#runContainer({
      workspace: input.workspace,
      scopeBinding: input.scopeBinding,
      imageReference: input.imageReference,
      imageDigest: input.imageDigest,
      entrypoint: CLODEX_TEST_CONTAINER_ENTRYPOINT,
      commandArguments: Object.freeze([
        '--protocol-v1',
        '--profile',
        profileId,
        '--profile-sha256',
        profileDigest,
        '--plan-sha256',
        testPlanDigest,
        '--runner-sha256',
        runnerDigest,
        '--workspace',
        '/workspace',
        '--scratch',
        '/scratch',
      ]),
      operationKind: 'test-run',
      invocationId: input.invocationId,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxReportBytes,
      maxStderrBytes: input.maxReportBytes,
      fixedEnvironment: Object.freeze({
        CLODEX_NETWORK: 'none',
        CLODEX_WORKSPACE_MODE: 'read-only',
        HOME: '/scratch/home',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TMPDIR: '/scratch/tmp',
        XDG_CACHE_HOME: '/scratch/cache',
        XDG_CONFIG_HOME: '/scratch/config',
      }),
    });
  }

  async #runContainer(input: {
    readonly workspace: PinnedDirectoryLease;
    readonly scopeBinding: string;
    readonly imageReference: string;
    readonly imageDigest: string;
    readonly entrypoint:
      | typeof CLODEX_GIT_CONTAINER_ENTRYPOINT
      | typeof CLODEX_TEST_CONTAINER_ENTRYPOINT;
    readonly commandArguments: readonly string[];
    readonly operationKind: string;
    readonly invocationId: string;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
    readonly fixedEnvironment: Readonly<Record<string, string>>;
  }): Promise<PinnedProcessResult> {
    await assertPinnedDirectoryLease(input.workspace, 'execute');
    const imageReference = requireDigestPinnedImage(
      input.imageReference,
      input.imageDigest,
    );
    const timeoutMs = requireBoundedInteger(
      input.timeoutMs,
      100,
      24 * 60 * 60 * 1_000,
      'Container timeout',
    );
    const maxStdoutBytes = requireBoundedInteger(
      input.maxStdoutBytes,
      1,
      256 * 1024 * 1024,
      'Container stdout limit',
    );
    const maxStderrBytes = requireBoundedInteger(
      input.maxStderrBytes,
      1,
      64 * 1024 * 1024,
      'Container stderr limit',
    );
    const scopeBinding = requireDigest(
      input.scopeBinding,
      'Container capability-scope binding',
      'execute',
    );
    const containerName = containerNameFor(
      input.operationKind,
      scopeBinding,
      input.invocationId,
      input.imageDigest,
    );
    const workspaceMountSource = requireContainerMountSource(
      `/proc/${process.pid}/fd/${input.workspace.handle.fd}`,
      'Held workspace descriptor path',
    );
    const seccompHandle = await openPinnedDataFile(
      this.#seccompProfile,
      'execute',
    );
    try {
      const seccompPath = `/proc/${process.pid}/fd/${seccompHandle.fd}`;
      const arguments_ = this.#containerArguments({
        containerName,
        workspaceMountSource,
        seccompPath,
        imageReference,
        entrypoint: input.entrypoint,
        commandArguments: input.commandArguments,
        fixedEnvironment: input.fixedEnvironment,
      });
      try {
        const result = await runPinnedExecutable({
          executable: this.#executable,
          args: arguments_,
          environment: this.#dockerClientEnvironment(),
          timeoutMs,
          maxStdoutBytes,
          maxStderrBytes,
          stage: 'execute',
          effectMayHaveOccurredOnFailure: true,
        });
        await assertPinnedDirectoryLease(input.workspace, 'execute');
        return result;
      } catch (error) {
        await this.#compensateContainer(containerName);
        if (error instanceof NodeAdapterSecurityError) throw error;
        throw new NodeAdapterSecurityError(
          'effect-uncertain',
          'execute',
          'Digest-pinned container dispatch failed after its final fence',
          true,
          error,
        );
      }
    } finally {
      await seccompHandle.close().catch(() => undefined);
    }
  }

  #containerArguments(input: {
    readonly containerName: string;
    readonly workspaceMountSource: string;
    readonly seccompPath: string;
    readonly imageReference: string;
    readonly entrypoint: string;
    readonly commandArguments: readonly string[];
    readonly fixedEnvironment: Readonly<Record<string, string>>;
  }): readonly string[] {
    const memoryBytes = String(this.#limits.memoryBytes);
    const arguments_: string[] = [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      input.containerName,
      '--hostname',
      'clodex-sandbox',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--security-opt',
      `seccomp=${input.seccompPath}`,
      '--security-opt',
      `apparmor=${this.#appArmorProfile}`,
      '--pids-limit',
      String(this.#limits.pids),
      '--memory',
      memoryBytes,
      '--memory-swap',
      memoryBytes,
      '--cpus',
      this.#limits.cpus,
      '--ulimit',
      `nofile=${this.#limits.nofile}:${this.#limits.nofile}`,
      '--user',
      '65534:65534',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,source=${input.workspaceMountSource},target=/workspace,readonly,bind-recursive=readonly`,
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,nodev,size=${this.#limits.temporaryBytes}`,
      '--tmpfs',
      `/scratch:rw,nosuid,nodev,size=${this.#limits.scratchBytes}`,
      '--stop-timeout',
      '1',
      '--log-driver',
      'none',
    ];
    for (const name of Object.keys(input.fixedEnvironment).sort()) {
      const value = input.fixedEnvironment[name];
      if (value === undefined) {
        throw new NodeAdapterSecurityError(
          'argument-invalid',
          'configuration',
          'Fixed container environment is sparse',
        );
      }
      arguments_.push('--env', `${name}=${value}`);
    }
    arguments_.push(
      '--entrypoint',
      input.entrypoint,
      input.imageReference,
      ...input.commandArguments,
    );
    return Object.freeze(arguments_);
  }

  async #compensateContainer(containerName: string): Promise<void> {
    try {
      await runPinnedExecutable({
        executable: this.#executable,
        args: Object.freeze(['rm', '--force', containerName]),
        environment: this.#dockerClientEnvironment(),
        timeoutMs: this.#cleanupTimeoutMs,
        maxStdoutBytes: 16 * 1024,
        maxStderrBytes: 64 * 1024,
        stage: 'compensation',
        effectMayHaveOccurredOnFailure: false,
      });
    } catch {
      // Cleanup is best-effort compensation only. The original invocation
      // remains UNCERTAIN and MUST NOT be retried or reported as rolled back.
    }
  }

  #dockerClientEnvironment(): Readonly<Record<string, string>> {
    return Object.freeze({
      DOCKER_CONFIG: '/nonexistent/clodex-docker-config',
      DOCKER_HOST: `unix://${this.#daemonSocket}`,
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/nonexistent',
    });
  }
}

function fixedGitArguments(
  operation: GitContainerInvocation['operation'],
  scope: GitContainerInvocation['scope'],
): readonly string[] {
  const prefix = [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '--literal-pathspecs',
    '--git-dir=/workspace/.git',
    '--work-tree=/workspace',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.pager=cat',
    '-c',
    'pager.status=false',
    '-c',
    'pager.diff=false',
    '-c',
    'diff.external=',
    '-c',
    'diff.trustExitCode=false',
    '-c',
    'credential.helper=',
    '-c',
    'core.askPass=/bin/false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.excludesFile=/dev/null',
    '-c',
    'core.sshCommand=/bin/false',
    '-c',
    'core.editor=/bin/false',
    '-c',
    'sequence.editor=/bin/false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'fetch.recurseSubmodules=false',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.allow=never',
  ];
  if (operation === 'status') {
    return Object.freeze([
      ...prefix,
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=all',
    ]);
  }
  const diffArguments = [
    ...prefix,
    'diff',
    ...(scope === 'staged' ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    '--no-color',
    '--',
  ];
  if (operation === 'diff-names') {
    diffArguments.splice(diffArguments.length - 1, 0, '--name-only', '-z');
  } else {
    diffArguments.splice(
      diffArguments.length - 1,
      0,
      '--binary',
      '--full-index',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    );
  }
  return Object.freeze(diffArguments);
}

function fixedGitConfigAuditArguments(): readonly string[] {
  return Object.freeze([
    '--no-pager',
    '--no-optional-locks',
    '--git-dir=/workspace/.git',
    '--work-tree=/workspace',
    'config',
    '--includes',
    '--null',
    '--name-only',
    '--get-regexp',
    FORBIDDEN_GIT_CONFIG_PATTERN,
  ]);
}

function fixedGitEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    GIT_ASKPASS: '/bin/false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EXTERNAL_DIFF: '',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    PAGER: '',
    SSH_ASKPASS: '/bin/false',
    XDG_CONFIG_HOME: '/nonexistent',
  });
}

function assertGitConfigAuditAccepted(result: PinnedProcessResult): void {
  if (
    result.signal !== null ||
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    result.stderr.byteLength !== 0
  ) {
    throw new NodeAdapterSecurityError(
      'container-failure',
      'execute',
      'Hardened Git configuration audit failed closed',
      true,
    );
  }
  if (result.exitCode === 0 || result.stdout.byteLength !== 0) {
    throw new NodeAdapterSecurityError(
      'container-output-invalid',
      'execute',
      'Repository command-bearing alias/include/filter/diff/pager configuration is forbidden for hardened Git observations',
      true,
    );
  }
}

function requireDigestPinnedImage(
  referenceValue: unknown,
  expectedDigestValue: unknown,
): string {
  const expectedDigest = requireDigest(
    expectedDigestValue,
    'Container image digest',
  );
  if (
    typeof referenceValue !== 'string' ||
    !/^[a-z0-9][a-z0-9._/-]{0,254}@sha256:[a-f0-9]{64}$/.test(referenceValue) ||
    !referenceValue.endsWith(`@sha256:${expectedDigest}`)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Container image must be an exact repository@sha256 digest reference',
    );
  }
  return referenceValue;
}

function containerNameFor(
  operation: string,
  scopeBinding: string,
  invocationId: string,
  imageDigest: string,
): string {
  const digest = sha256Text(
    [
      'clodex.container-name.v2',
      operation,
      scopeBinding,
      invocationId,
      imageDigest,
    ].join('\0'),
  );
  return `clodex-${operation.replace(/[^a-z0-9-]/g, '-')}-${digest.slice(0, 32)}`;
}

function snapshotLimits(value: unknown): DockerResourceLimits {
  if (value === null || typeof value !== 'object') {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Docker resource limits are required',
    );
  }
  const cpus = readOwnData<string>(value, 'cpus');
  if (
    typeof cpus !== 'string' ||
    !/^(0\.[1-9]|[1-9][0-9]?)(\.[0-9])?$/.test(cpus)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Docker CPU limit must be a canonical decimal between 0.1 and 99.9',
    );
  }
  return Object.freeze({
    cpus,
    memoryBytes: requireBoundedInteger(
      readOwnData(value, 'memoryBytes'),
      64 * 1024 * 1024,
      64 * 1024 * 1024 * 1024,
      'Docker memory limit',
    ),
    pids: requireBoundedInteger(
      readOwnData(value, 'pids'),
      16,
      4096,
      'Docker PID limit',
    ),
    nofile: requireBoundedInteger(
      readOwnData(value, 'nofile'),
      64,
      65_536,
      'Docker file descriptor limit',
    ),
    scratchBytes: requireBoundedInteger(
      readOwnData(value, 'scratchBytes'),
      16 * 1024 * 1024,
      64 * 1024 * 1024 * 1024,
      'Docker scratch limit',
    ),
    temporaryBytes: requireBoundedInteger(
      readOwnData(value, 'temporaryBytes'),
      1024 * 1024,
      4 * 1024 * 1024 * 1024,
      'Docker temporary storage limit',
    ),
  });
}

function requireDockerSocket(value: unknown): string {
  const path = requireSafeAbsolutePath(value, 'Docker daemon socket');
  if (path.includes(',')) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Docker daemon socket path is invalid',
    );
  }
  return path;
}

function requireAppArmorProfile(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'A fixed installed AppArmor profile name is required',
    );
  }
  const normalized = value.toLowerCase();
  if (
    normalized === 'unconfined' ||
    normalized === 'complain' ||
    normalized === 'disable' ||
    normalized === 'disabled' ||
    normalized === 'none'
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'AppArmor must name an enforcing installed profile, not an unconfined, complain, or disabled mode',
    );
  }
  return value;
}

function requireToken(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `${label} is invalid`,
    );
  }
  return value;
}

function readOwnData<T>(owner: object, name: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `Docker option ${name} must be own enumerable data`,
    );
  }
  return descriptor.value as T;
}

function readOptionalOwnData(owner: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `Docker option ${name} must be own enumerable data`,
    );
  }
  return descriptor.value;
}
