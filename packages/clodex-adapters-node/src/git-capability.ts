import {
  HARDENED_GIT_POLICY_KIND,
  HARDENED_GIT_POLICY_SPEC_VERSION,
  capabilityScopeEquals,
  snapshotCapabilityScope,
  type CapabilityScope,
  type GitDiffCapabilityPort,
  type GitDiffExecuteInput,
  type GitDiffInspectInput,
  type GitStatusCapabilityPort,
  type GitStatusExecuteInput,
  type GitStatusInspectInput,
  type HardenedGitPolicy,
} from '@clodex/adapters';

import {
  DigestPinnedDockerEngine,
  type DigestPinnedDockerEngineOptions,
} from './container-engine.js';
import type { HeldWorkspaceTreeCommitmentPort } from './filesystem-capability.js';
import {
  NodeAdapterSecurityError,
  openPinnedDirectory,
  requireBoundedInteger,
  requireDigest,
  sha256Bytes,
  sha256Text,
  type PinnedDirectoryDescriptor,
} from './node-security.js';

export interface DigestPinnedGitCapabilityOptions {
  readonly capabilityScope: CapabilityScope;
  readonly workspace: PinnedDirectoryDescriptor;
  readonly commitments: HeldWorkspaceTreeCommitmentPort;
  readonly docker: DigestPinnedDockerEngine | DigestPinnedDockerEngineOptions;
  readonly hardenedPolicyDigest: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly timeoutMs?: number;
  readonly maxStatusBytes?: number;
  readonly maxDiffBytes?: number;
  readonly maxChangedFiles?: number;
}

/**
 * Fixed status/diff capability. Git runs only inside a digest-pinned,
 * networkless, read-only container, with a held workspace descriptor mounted
 * read-only and exact tree commitments checked before and after observation.
 */
export class DigestPinnedGitCapability
  implements GitStatusCapabilityPort, GitDiffCapabilityPort
{
  public readonly capabilityScope: CapabilityScope;

  readonly #workspace: PinnedDirectoryDescriptor;
  readonly #commitments: HeldWorkspaceTreeCommitmentPort;
  readonly #docker: DigestPinnedDockerEngine;
  readonly #hardenedPolicyDigest: string;
  readonly #imageReference: string;
  readonly #imageDigest: string;
  readonly #timeoutMs: number;
  readonly #maxStatusBytes: number;
  readonly #maxDiffBytes: number;
  readonly #maxChangedFiles: number;

  public constructor(options: DigestPinnedGitCapabilityOptions) {
    this.capabilityScope = snapshotCapabilityScope(
      readOwnData<CapabilityScope>(options, 'capabilityScope'),
    );
    this.#workspace = Object.freeze({
      ...readOwnData<PinnedDirectoryDescriptor>(options, 'workspace'),
    });
    this.#commitments = snapshotCommitmentPort(
      readOwnData<HeldWorkspaceTreeCommitmentPort>(options, 'commitments'),
    );
    const docker = readOwnData<
      DigestPinnedDockerEngine | DigestPinnedDockerEngineOptions
    >(options, 'docker');
    this.#docker =
      docker instanceof DigestPinnedDockerEngine
        ? docker
        : new DigestPinnedDockerEngine(docker);
    this.#hardenedPolicyDigest = requireDigest(
      readOwnData(options, 'hardenedPolicyDigest'),
      'Hardened Git policy digest',
    );
    this.#imageReference = requireString(
      readOwnData(options, 'imageReference'),
      'Git image reference',
    );
    this.#imageDigest = requireDigest(
      readOwnData(options, 'imageDigest'),
      'Git image digest',
    );
    this.#timeoutMs = requireBoundedInteger(
      readOptionalOwnData(options, 'timeoutMs') ?? 30_000,
      100,
      10 * 60_000,
      'Git observation timeout',
    );
    this.#maxStatusBytes = requireBoundedInteger(
      readOptionalOwnData(options, 'maxStatusBytes') ?? 8 * 1024 * 1024,
      1,
      64 * 1024 * 1024,
      'Git status output limit',
    );
    this.#maxDiffBytes = requireBoundedInteger(
      readOptionalOwnData(options, 'maxDiffBytes') ?? 32 * 1024 * 1024,
      1,
      256 * 1024 * 1024,
      'Git diff output limit',
    );
    this.#maxChangedFiles = requireBoundedInteger(
      readOptionalOwnData(options, 'maxChangedFiles') ?? 100_000,
      0,
      100_000,
      'Git changed-file limit',
    );
    Object.freeze(this);
  }

  public async inspectStatus(input: GitStatusInspectInput): Promise<unknown> {
    this.#assertCommonInput(input, 'prepare');
    const stateCommitmentHash = await this.#inspectWorkspace();
    return Object.freeze({
      operation: 'git.status',
      resolvedObjectId: this.#resolvedObjectId('status'),
      stateCommitmentHash,
      hardenedPolicyDigest: this.#hardenedPolicyDigest,
    });
  }

  public async executeStatus(input: GitStatusExecuteInput): Promise<unknown> {
    this.#assertCommonInput(input, 'execute');
    const resolvedObjectId = this.#resolvedObjectId('status');
    assertExact(input.resolvedObjectId, resolvedObjectId, 'Git status object');
    const expectedStateCommitmentHash = requireDigest(
      input.expectedStateCommitmentHash,
      'Expected Git status state commitment',
    );
    const workspace = await openPinnedDirectory(this.#workspace);
    try {
      await this.#assertHeldState(
        workspace,
        expectedStateCommitmentHash,
        false,
      );
      const result = await this.#docker.executeGitObservation({
        workspace,
        scopeBinding: this.#scopeBinding(),
        imageReference: this.#imageReference,
        imageDigest: this.#imageDigest,
        operation: 'status',
        invocationId: requireIdentifier(input.ticketId, 'Ticket ID'),
        timeoutMs: this.#timeoutMs,
        maxStdoutBytes: this.#maxStatusBytes,
      });
      assertSuccessfulGit(result, 'status');
      await this.#assertHeldState(workspace, expectedStateCommitmentHash, true);
      return Object.freeze({
        operation: 'git.status',
        ticketId: input.ticketId,
        resolvedObjectId,
        hardenedPolicyDigest: this.#hardenedPolicyDigest,
        preStateHash: expectedStateCommitmentHash,
        postStateHash: expectedStateCommitmentHash,
        clean: result.stdout.byteLength === 0,
        summaryDigest: sha256Bytes(result.stdout),
      });
    } finally {
      await workspace.handle.close().catch(() => undefined);
    }
  }

  public async inspectDiff(input: GitDiffInspectInput): Promise<unknown> {
    this.#assertCommonInput(input, 'prepare');
    const scope = requireDiffScope(input.scope);
    const stateCommitmentHash = await this.#inspectWorkspace();
    return Object.freeze({
      operation: 'git.diff',
      resolvedObjectId: this.#resolvedObjectId(`diff.${scope}`),
      stateCommitmentHash,
      hardenedPolicyDigest: this.#hardenedPolicyDigest,
    });
  }

  public async executeDiff(input: GitDiffExecuteInput): Promise<unknown> {
    this.#assertCommonInput(input, 'execute');
    const scope = requireDiffScope(input.scope);
    const resolvedObjectId = this.#resolvedObjectId(`diff.${scope}`);
    assertExact(input.resolvedObjectId, resolvedObjectId, 'Git diff object');
    const expectedStateCommitmentHash = requireDigest(
      input.expectedStateCommitmentHash,
      'Expected Git diff state commitment',
    );
    const ticketId = requireIdentifier(input.ticketId, 'Ticket ID');
    const workspace = await openPinnedDirectory(this.#workspace);
    try {
      await this.#assertHeldState(
        workspace,
        expectedStateCommitmentHash,
        false,
      );
      const patch = await this.#docker.executeGitObservation({
        workspace,
        scopeBinding: this.#scopeBinding(),
        imageReference: this.#imageReference,
        imageDigest: this.#imageDigest,
        operation: 'diff-patch',
        scope,
        invocationId: `${ticketId}:patch`,
        timeoutMs: this.#timeoutMs,
        maxStdoutBytes: this.#maxDiffBytes,
      });
      assertSuccessfulGit(patch, 'diff patch');
      const names = await this.#docker.executeGitObservation({
        workspace,
        scopeBinding: this.#scopeBinding(),
        imageReference: this.#imageReference,
        imageDigest: this.#imageDigest,
        operation: 'diff-names',
        scope,
        invocationId: `${ticketId}:names`,
        timeoutMs: this.#timeoutMs,
        maxStdoutBytes: Math.min(
          this.#maxDiffBytes,
          this.#maxChangedFiles * 16_384 + 1,
        ),
      });
      assertSuccessfulGit(names, 'diff names');
      const changedFiles = countNulTerminatedPaths(
        names.stdout,
        this.#maxChangedFiles,
      );
      await this.#assertHeldState(workspace, expectedStateCommitmentHash, true);
      return Object.freeze({
        operation: 'git.diff',
        scope,
        ticketId,
        resolvedObjectId,
        hardenedPolicyDigest: this.#hardenedPolicyDigest,
        preStateHash: expectedStateCommitmentHash,
        postStateHash: expectedStateCommitmentHash,
        changedFiles,
        diffDigest: sha256Bytes(patch.stdout),
      });
    } finally {
      await workspace.handle.close().catch(() => undefined);
    }
  }

  async #inspectWorkspace(): Promise<string> {
    const workspace = await openPinnedDirectory(this.#workspace);
    try {
      const commitment =
        await this.#commitments.inspectHeldTreeCommitment(workspace);
      if (commitment.rootObjectId !== this.capabilityScope.rootObjectId) {
        throw new NodeAdapterSecurityError(
          'root-identity-mismatch',
          'prepare',
          'Git tree commitment returned a different root object',
        );
      }
      return requireDigest(
        commitment.stateCommitmentHash,
        'Git workspace tree commitment',
        'prepare',
      );
    } finally {
      await workspace.handle.close().catch(() => undefined);
    }
  }

  async #assertHeldState(
    workspace: Awaited<ReturnType<typeof openPinnedDirectory>>,
    expected: string,
    effectMayHaveOccurred: boolean,
  ): Promise<void> {
    const commitment =
      await this.#commitments.inspectHeldTreeCommitment(workspace);
    if (
      commitment.rootObjectId !== this.capabilityScope.rootObjectId ||
      commitment.stateCommitmentHash !== expected
    ) {
      throw new NodeAdapterSecurityError(
        'state-commitment-mismatch',
        'execute',
        'Git workspace changed across the fixed observation boundary',
        effectMayHaveOccurred,
      );
    }
  }

  #assertCommonInput(
    input: GitStatusInspectInput | GitDiffInspectInput,
    stage: 'prepare' | 'execute',
  ): void {
    const scope = snapshotCapabilityScope(input.capabilityScope);
    if (!capabilityScopeEquals(scope, this.capabilityScope)) {
      throw new NodeAdapterSecurityError(
        'capability-scope-mismatch',
        stage,
        'Git capability rejected a workspace/task/root scope mismatch',
      );
    }
    assertHardenedPolicy(input.hardenedPolicy, stage);
    assertExact(
      input.hardenedPolicyDigest,
      this.#hardenedPolicyDigest,
      'Hardened Git policy digest',
      stage,
    );
  }

  #scopeBinding(): string {
    return sha256Text(
      [
        'clodex.container-scope.v1',
        this.capabilityScope.workspaceId,
        this.capabilityScope.taskId,
        this.capabilityScope.rootObjectId,
      ].join('\0'),
    );
  }

  #resolvedObjectId(operation: string): string {
    return `git.${sha256Text(
      [
        'clodex.git-object.v1',
        this.capabilityScope.workspaceId,
        this.capabilityScope.taskId,
        this.capabilityScope.rootObjectId,
        operation,
        this.#hardenedPolicyDigest,
        this.#imageDigest,
      ].join('\0'),
    )}`;
  }
}

function assertHardenedPolicy(
  policy: HardenedGitPolicy,
  stage: 'prepare' | 'execute',
): void {
  assertExactDataFields(
    policy,
    [
      'arbitraryArguments',
      'configOverrides',
      'credentialHelpers',
      'externalDiff',
      'fixedOperationsOnly',
      'hooks',
      'kind',
      'network',
      'optionalLocks',
      'pager',
      'repositoryReadOnly',
      'shell',
      'specVersion',
      'textconv',
    ],
    'Hardened Git policy',
    stage,
  );
  if (
    policy.kind !== HARDENED_GIT_POLICY_KIND ||
    policy.specVersion !== HARDENED_GIT_POLICY_SPEC_VERSION ||
    policy.fixedOperationsOnly !== true ||
    policy.arbitraryArguments !== false ||
    policy.shell !== false ||
    policy.hooks !== false ||
    policy.pager !== false ||
    policy.externalDiff !== false ||
    policy.textconv !== false ||
    policy.configOverrides !== false ||
    policy.credentialHelpers !== false ||
    policy.network !== false ||
    policy.repositoryReadOnly !== true ||
    policy.optionalLocks !== false
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      stage,
      'Git capability requires the exact closed hardened Git policy',
    );
  }
}

function assertSuccessfulGit(
  result: {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: Uint8Array;
  },
  label: string,
): void {
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.stderr.byteLength !== 0
  ) {
    throw new NodeAdapterSecurityError(
      'container-failure',
      'execute',
      `Hardened Git ${label} container failed closed`,
      true,
    );
  }
}

function countNulTerminatedPaths(bytes: Uint8Array, maximum: number): number {
  if (bytes.byteLength === 0) return 0;
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new NodeAdapterSecurityError(
      'container-output-invalid',
      'execute',
      'Git changed-file output is not NUL terminated',
      true,
    );
  }
  let count = 0;
  let componentBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      if (componentBytes === 0) {
        throw new NodeAdapterSecurityError(
          'container-output-invalid',
          'execute',
          'Git changed-file output contains an empty path',
          true,
        );
      }
      ++count;
      componentBytes = 0;
      if (count > maximum) {
        throw new NodeAdapterSecurityError(
          'output-limit-exceeded',
          'execute',
          'Git changed-file count exceeded its fixed limit',
          true,
        );
      }
    } else {
      ++componentBytes;
      if (componentBytes > 16 * 1024) {
        throw new NodeAdapterSecurityError(
          'container-output-invalid',
          'execute',
          'Git changed-file path exceeded the selector byte limit',
          true,
        );
      }
    }
  }
  return count;
}

function snapshotCommitmentPort(
  port: HeldWorkspaceTreeCommitmentPort,
): HeldWorkspaceTreeCommitmentPort {
  if (port === null || typeof port !== 'object') {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Git workspace commitment port is required',
    );
  }
  const method = findDataMethod(port, 'inspectHeldTreeCommitment');
  return Object.freeze({ inspectHeldTreeCommitment: method.bind(port) });
}

function findDataMethod<T extends object, K extends keyof T>(
  owner: T,
  name: K,
): T[K] {
  let target: object | null = owner;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new NodeAdapterSecurityError(
          'argument-invalid',
          'configuration',
          `Git dependency ${String(name)} must be a data method`,
        );
      }
      return descriptor.value as T[K];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new NodeAdapterSecurityError(
    'argument-invalid',
    'configuration',
    `Git dependency ${String(name)} is missing`,
  );
}

function requireDiffScope(value: unknown): 'worktree' | 'staged' {
  if (value !== 'worktree' && value !== 'staged') {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'prepare',
      'Git diff scope must be worktree or staged',
    );
  }
  return value;
}

function assertExact(
  actual: unknown,
  expected: string,
  label: string,
  stage: 'prepare' | 'execute' = 'execute',
): void {
  if (actual !== expected) {
    throw new NodeAdapterSecurityError(
      'state-commitment-mismatch',
      stage,
      `${label} does not match the provisioned capability`,
    );
  }
}

function assertExactDataFields(
  value: unknown,
  expected: readonly string[],
  label: string,
  stage: 'prepare' | 'execute',
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      stage,
      `${label} must be a closed data-only object`,
    );
  }
  const names = Object.getOwnPropertyNames(value).sort();
  const expectedNames = [...expected].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      stage,
      `${label} contains unknown or missing fields`,
    );
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        stage,
        `${label} cannot contain accessors or hidden fields`,
      );
    }
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'execute',
      `${label} is invalid`,
    );
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
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
      `Git option ${name} must be own enumerable data`,
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
      `Git option ${name} must be own enumerable data`,
    );
  }
  return descriptor.value;
}
