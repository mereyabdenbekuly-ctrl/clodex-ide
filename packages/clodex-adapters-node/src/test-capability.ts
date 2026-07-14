import { createHash } from 'node:crypto';

import {
  TEST_SANDBOX_PROFILE_KIND,
  TEST_SANDBOX_PROFILE_SPEC_VERSION,
  capabilityScopeEquals,
  snapshotCapabilityScope,
  type CapabilityScope,
  type TestRunCapabilityPort,
  type TestRunExecuteInput,
  type TestRunInspectInput,
  type TestSandboxProfile,
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
  sha256Text,
  type PinnedDirectoryDescriptor,
} from './node-security.js';

export interface RegisteredNodeTestPlan {
  readonly profileId: string;
  readonly profileDigest: string;
  readonly testPlanDigest: string;
  readonly runnerId: string;
  readonly runnerDigest: string;
  readonly imageReference: string;
  readonly imageDigest: string;
}

export interface DigestPinnedTestCapabilityOptions {
  readonly capabilityScope: CapabilityScope;
  readonly workspace: PinnedDirectoryDescriptor;
  readonly commitments: HeldWorkspaceTreeCommitmentPort;
  readonly docker: DigestPinnedDockerEngine | DigestPinnedDockerEngineOptions;
  readonly plans: readonly RegisteredNodeTestPlan[];
  readonly timeoutMs?: number;
  readonly maxReportBytes?: number;
}

/**
 * Executes only registry-selected test plans in exact digest-pinned images.
 * The host workspace is mounted from a held descriptor read-only; all writable
 * test state is disposable tmpfs scratch owned by the container lifecycle.
 */
export class DigestPinnedTestCapability implements TestRunCapabilityPort {
  public readonly capabilityScope: CapabilityScope;

  readonly #workspace: PinnedDirectoryDescriptor;
  readonly #commitments: HeldWorkspaceTreeCommitmentPort;
  readonly #docker: DigestPinnedDockerEngine;
  readonly #plans: ReadonlyMap<string, RegisteredNodeTestPlan>;
  readonly #timeoutMs: number;
  readonly #maxReportBytes: number;

  public constructor(options: DigestPinnedTestCapabilityOptions) {
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
    this.#plans = snapshotPlans(
      readOwnData<readonly RegisteredNodeTestPlan[]>(options, 'plans'),
    );
    this.#timeoutMs = requireBoundedInteger(
      readOptionalOwnData(options, 'timeoutMs') ?? 30 * 60_000,
      100,
      24 * 60 * 60_000,
      'Test sandbox timeout',
    );
    this.#maxReportBytes = requireBoundedInteger(
      readOptionalOwnData(options, 'maxReportBytes') ?? 32 * 1024 * 1024,
      1,
      128 * 1024 * 1024,
      'Test report output limit',
    );
    Object.freeze(this);
  }

  public async inspectRun(input: TestRunInspectInput): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'prepare');
    const plan = this.#requireExactPlan(input.profile, input.profileDigest);
    const workspace = await openPinnedDirectory(this.#workspace);
    try {
      const commitment =
        await this.#commitments.inspectHeldTreeCommitment(workspace);
      this.#assertRootObject(commitment.rootObjectId, false);
      return Object.freeze({
        operation: 'test.run',
        profileId: plan.profileId,
        profileDigest: plan.profileDigest,
        resolvedObjectId: this.#resolvedObjectId(plan),
        stateCommitmentHash: requireDigest(
          commitment.stateCommitmentHash,
          'Test workspace commitment',
          'prepare',
        ),
      });
    } finally {
      await workspace.handle.close().catch(() => undefined);
    }
  }

  public async executeRun(input: TestRunExecuteInput): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'execute');
    const plan = this.#requireExactPlan(input.profile, input.profileDigest);
    const resolvedObjectId = this.#resolvedObjectId(plan);
    assertExact(
      input.resolvedObjectId,
      resolvedObjectId,
      'Resolved test workspace object',
    );
    const expectedStateCommitmentHash = requireDigest(
      input.expectedStateCommitmentHash,
      'Expected test workspace commitment',
    );
    const ticketId = requireIdentifier(input.ticketId, 'Ticket ID');
    const workspace = await openPinnedDirectory(this.#workspace);
    try {
      await this.#assertHeldState(
        workspace,
        expectedStateCommitmentHash,
        false,
      );
      const result = await this.#docker.executeRegisteredTestPlan({
        workspace,
        scopeBinding: this.#scopeBinding(),
        imageReference: plan.imageReference,
        imageDigest: plan.imageDigest,
        profileId: plan.profileId,
        profileDigest: plan.profileDigest,
        testPlanDigest: plan.testPlanDigest,
        runnerDigest: plan.runnerDigest,
        invocationId: ticketId,
        timeoutMs: this.#timeoutMs,
        maxReportBytes: this.#maxReportBytes,
      });
      if (
        result.signal !== null ||
        (result.exitCode !== 0 && result.exitCode !== 1)
      ) {
        throw new NodeAdapterSecurityError(
          'container-failure',
          'execute',
          'Registered test runner ended with an infrastructure status',
          true,
        );
      }
      await this.#assertHeldState(workspace, expectedStateCommitmentHash, true);
      return Object.freeze({
        operation: 'test.run',
        ticketId,
        resolvedObjectId,
        profileId: plan.profileId,
        profileDigest: plan.profileDigest,
        runnerDigest: plan.runnerDigest,
        preStateHash: expectedStateCommitmentHash,
        postStateHash: expectedStateCommitmentHash,
        outcome: result.exitCode === 0 ? 'passed' : 'failed',
        exitCode: result.exitCode,
        reportDigest: hashReport(result.stdout, result.stderr),
      });
    } finally {
      await workspace.handle.close().catch(() => undefined);
    }
  }

  #requireExactPlan(
    profile: TestSandboxProfile,
    profileDigestValue: unknown,
  ): RegisteredNodeTestPlan {
    assertClosedTestProfile(profile);
    const profileDigest = requireDigest(
      profileDigestValue,
      'Test profile digest',
    );
    const plan = this.#plans.get(profile.profileId);
    if (
      plan === undefined ||
      plan.profileDigest !== profileDigest ||
      plan.testPlanDigest !== profile.testPlanDigest ||
      plan.runnerId !== profile.runnerId ||
      plan.runnerDigest !== profile.runnerDigest ||
      plan.imageDigest !== profile.sandboxImageDigest
    ) {
      throw new NodeAdapterSecurityError(
        'state-commitment-mismatch',
        'prepare',
        'Test profile is not an exact member of the trusted Node runner registry',
      );
    }
    return plan;
  }

  async #assertHeldState(
    workspace: Awaited<ReturnType<typeof openPinnedDirectory>>,
    expected: string,
    effectMayHaveOccurred: boolean,
  ): Promise<void> {
    const commitment =
      await this.#commitments.inspectHeldTreeCommitment(workspace);
    this.#assertRootObject(commitment.rootObjectId, effectMayHaveOccurred);
    if (commitment.stateCommitmentHash !== expected) {
      throw new NodeAdapterSecurityError(
        'state-commitment-mismatch',
        'execute',
        'Host workspace changed across the isolated test boundary',
        effectMayHaveOccurred,
      );
    }
  }

  #assertRootObject(
    rootObjectId: string,
    effectMayHaveOccurred: boolean,
  ): void {
    if (rootObjectId !== this.capabilityScope.rootObjectId) {
      throw new NodeAdapterSecurityError(
        'root-identity-mismatch',
        effectMayHaveOccurred ? 'execute' : 'prepare',
        'Test commitment port returned a different root object',
        effectMayHaveOccurred,
      );
    }
  }

  #assertScope(
    scopeValue: CapabilityScope,
    stage: 'prepare' | 'execute',
  ): void {
    const scope = snapshotCapabilityScope(scopeValue);
    if (!capabilityScopeEquals(scope, this.capabilityScope)) {
      throw new NodeAdapterSecurityError(
        'capability-scope-mismatch',
        stage,
        'Test capability rejected a workspace/task/root scope mismatch',
      );
    }
  }

  #resolvedObjectId(plan: RegisteredNodeTestPlan): string {
    return `test.${sha256Text(
      [
        'clodex.test-object.v1',
        this.capabilityScope.workspaceId,
        this.capabilityScope.taskId,
        this.capabilityScope.rootObjectId,
        plan.profileId,
        plan.profileDigest,
        plan.runnerDigest,
        plan.imageDigest,
      ].join('\0'),
    )}`;
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
}

function snapshotPlans(
  values: readonly RegisteredNodeTestPlan[],
): ReadonlyMap<string, RegisteredNodeTestPlan> {
  if (!Array.isArray(values) || values.length === 0 || values.length > 1024) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Node test-plan registry must be a non-empty bounded dense array',
    );
  }
  const result = new Map<string, RegisteredNodeTestPlan>();
  for (let index = 0; index < values.length; ++index) {
    if (!(index in values)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        'Node test-plan registry cannot be sparse',
      );
    }
    const value = values[index];
    if (value === undefined) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        'Node test-plan registry entry is missing',
      );
    }
    const plan = snapshotPlan(value);
    if (result.has(plan.profileId)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        `Duplicate Node test profile ${plan.profileId}`,
      );
    }
    result.set(plan.profileId, plan);
  }
  return result;
}

function snapshotPlan(value: RegisteredNodeTestPlan): RegisteredNodeTestPlan {
  assertExactFields(
    value,
    [
      'imageDigest',
      'imageReference',
      'profileDigest',
      'profileId',
      'runnerDigest',
      'runnerId',
      'testPlanDigest',
    ],
    'Node test plan',
  );
  return Object.freeze({
    profileId: requireProfileId(value.profileId),
    profileDigest: requireDigest(value.profileDigest, 'Test profile digest'),
    testPlanDigest: requireDigest(value.testPlanDigest, 'Test plan digest'),
    runnerId: requireIdentifier(value.runnerId, 'Test runner ID'),
    runnerDigest: requireDigest(value.runnerDigest, 'Test runner digest'),
    imageReference: requireString(value.imageReference, 'Test image reference'),
    imageDigest: requireDigest(value.imageDigest, 'Test image digest'),
  });
}

function assertClosedTestProfile(profile: TestSandboxProfile): void {
  assertExactFields(
    profile,
    [
      'credentials',
      'disposableScratch',
      'hostWorkspaceReadOnly',
      'kind',
      'network',
      'profileId',
      'runnerDigest',
      'runnerId',
      'sandboxImageDigest',
      'specVersion',
      'testPlanDigest',
    ],
    'Test sandbox profile',
  );
  if (
    profile.kind !== TEST_SANDBOX_PROFILE_KIND ||
    profile.specVersion !== TEST_SANDBOX_PROFILE_SPEC_VERSION ||
    profile.network !== false ||
    profile.credentials !== false ||
    profile.hostWorkspaceReadOnly !== true ||
    profile.disposableScratch !== true
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'prepare',
      'Test sandbox profile does not require the closed confined profile',
    );
  }
  requireProfileId(profile.profileId);
  requireDigest(profile.testPlanDigest, 'Test plan digest');
  requireIdentifier(profile.runnerId, 'Test runner ID');
  requireDigest(profile.runnerDigest, 'Test runner digest');
  requireDigest(profile.sandboxImageDigest, 'Test image digest');
}

function hashReport(stdout: Uint8Array, stderr: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update('clodex.test-report.v1\0', 'utf8');
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(stdout.byteLength), 0);
  lengths.writeBigUInt64BE(BigInt(stderr.byteLength), 8);
  hash.update(lengths);
  hash.update(stdout);
  hash.update(stderr);
  return hash.digest('hex');
}

function snapshotCommitmentPort(
  port: HeldWorkspaceTreeCommitmentPort,
): HeldWorkspaceTreeCommitmentPort {
  if (port === null || typeof port !== 'object') {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Test workspace commitment port is required',
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
          `Test dependency ${String(name)} must be a data method`,
        );
      }
      return descriptor.value as T[K];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new NodeAdapterSecurityError(
    'argument-invalid',
    'configuration',
    `Test dependency ${String(name)} is missing`,
  );
}

function assertExactFields(
  value: object,
  expected: readonly string[],
  label: string,
): void {
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
      'configuration',
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
      'configuration',
      `${label} contains unknown or missing fields`,
    );
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        `${label} cannot contain accessors or hidden fields`,
      );
    }
  }
}

function assertExact(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) {
    throw new NodeAdapterSecurityError(
      'state-commitment-mismatch',
      'execute',
      `${label} does not match the registered capability`,
    );
  }
}

function requireProfileId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Test profile ID is invalid',
    );
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
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
      `Test option ${name} must be own enumerable data`,
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
      `Test option ${name} must be own enumerable data`,
    );
  }
  return descriptor.value;
}
