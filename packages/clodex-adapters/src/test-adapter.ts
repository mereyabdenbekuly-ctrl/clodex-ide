import type {
  HashPort,
  SafeCodingAction,
  SafeCodingExecutionTicket,
} from '@clodex/contracts';
import type {
  PreparedSafeCodingAction,
  TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import type {
  PreparedRuntimeEffect,
  SafeCodingRuntimeAdapterPrepareInput,
  SafeCodingRuntimeAdapterResult,
} from '@clodex/runtime';

import {
  ReferenceAdapterError,
  assertEqual,
  assertPreparedMatchesTicket,
  createAdapterResult,
  createOneShotPreparedEffect,
  hashCanonicalCommitment,
  preparedActionFrom,
  requireActionKind,
  requireClosedRecord,
  requireDigest,
  requireIdentifier,
  requireLiteral,
  requireNonNegativeInteger,
  requireExactTicket,
  readOwnDataField,
  snapshotBinding,
  snapshotCapabilityScope,
  snapshotHashPort,
  snapshotMethod,
  type ActionOfKind,
  type CapabilityScope,
  type CapabilityConfinedSafeCodingAdapter,
  type CapabilityScopedPortInput,
} from './common.js';

export const TEST_SANDBOX_PROFILE_KIND = 'clodex.test-sandbox-profile' as const;
export const TEST_SANDBOX_PROFILE_SPEC_VERSION = '1.0.0' as const;
export const TEST_SANDBOX_PROFILE_HASH_DOMAIN =
  'clodex.test-sandbox-profile.v1' as const;

/**
 * No command, argv, environment, host path, secret, or network field exists.
 * A trusted runner registry maps this exact digest-pinned descriptor to its
 * implementation outside this package.
 */
export interface TestSandboxProfile {
  readonly kind: typeof TEST_SANDBOX_PROFILE_KIND;
  readonly specVersion: typeof TEST_SANDBOX_PROFILE_SPEC_VERSION;
  readonly profileId: string;
  readonly testPlanDigest: string;
  readonly runnerId: string;
  readonly runnerDigest: string;
  readonly sandboxImageDigest: string;
  readonly network: false;
  readonly credentials: false;
  readonly hostWorkspaceReadOnly: true;
  readonly disposableScratch: true;
}

export interface RegisteredTestSandboxProfile {
  readonly profile: TestSandboxProfile;
  readonly profileDigest: string;
}

export interface TestSandboxProfileRegistryPort {
  resolveProfile(
    input: TestSandboxProfileResolveInput,
  ): unknown | Promise<unknown>;
}

export interface TestSandboxProfileResolveInput
  extends CapabilityScopedPortInput {
  readonly profileId: string;
}

export interface TestRunInspectInput extends CapabilityScopedPortInput {
  readonly requestId: string;
  readonly profile: TestSandboxProfile;
  readonly profileDigest: string;
}

export interface TestRunExecuteInput extends TestRunInspectInput {
  readonly ticketId: string;
  readonly resolvedObjectId: string;
  readonly expectedStateCommitmentHash: string;
}

/** Fixed registered-profile capability; arbitrary commands/args are impossible. */
export interface TestRunCapabilityPort {
  inspectRun(input: TestRunInspectInput): unknown | Promise<unknown>;
  executeRun(input: TestRunExecuteInput): unknown | Promise<unknown>;
}

export interface ReferenceTestRunAdapterOptions {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'test.run';
  };
  readonly hash: HashPort;
  readonly profiles: TestSandboxProfileRegistryPort;
  readonly capability: TestRunCapabilityPort;
}

interface PreparedTestInspection {
  readonly resolvedObjectId: string;
  readonly stateCommitmentHash: string;
  readonly profile: RegisteredTestSandboxProfile;
}

export class ReferenceTestRunAdapter
  implements CapabilityConfinedSafeCodingAdapter
{
  public readonly capabilityScope: CapabilityScope;
  public readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'test.run';
  };

  readonly #hash: HashPort;
  readonly #resolveProfile: TestSandboxProfileRegistryPort['resolveProfile'];
  readonly #inspect: TestRunCapabilityPort['inspectRun'];
  readonly #execute: TestRunCapabilityPort['executeRun'];

  public constructor(options: ReferenceTestRunAdapterOptions) {
    const binding = readOwnDataField<ReferenceTestRunAdapterOptions['binding']>(
      options,
      'binding',
      'Test adapter binding',
    );
    const hash = readOwnDataField<HashPort>(options, 'hash', 'Test hash port');
    const profiles = readOwnDataField<TestSandboxProfileRegistryPort>(
      options,
      'profiles',
      'Test sandbox profile registry',
    );
    const capability = readOwnDataField<TestRunCapabilityPort>(
      options,
      'capability',
      'Test run capability',
    );
    this.capabilityScope = snapshotCapabilityScope(
      readOwnDataField(options, 'capabilityScope', 'Test adapter scope'),
    );
    this.binding = snapshotBinding(binding, 'test.run', 'sandbox.ephemeral');
    this.#hash = snapshotHashPort(hash);
    this.#resolveProfile = snapshotMethod(
      profiles,
      'resolveProfile',
      'Test sandbox profile registry',
    );
    this.#inspect = snapshotMethod(
      capability,
      'inspectRun',
      'test.run inspect',
    );
    this.#execute = snapshotMethod(
      capability,
      'executeRun',
      'test.run execute',
    );
    Object.freeze(this);
  }

  public async prepareAuthorization(
    actionValue: SafeCodingAction,
  ): Promise<PreparedSafeCodingAction> {
    const action = requireActionKind(actionValue, 'test.run');
    const inspection = await this.inspect(action);
    return preparedActionFrom(
      inspection.resolvedObjectId,
      inspection.stateCommitmentHash,
    );
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    const action = requireActionKind(input.action, 'test.run');
    const ticket = await requireExactTicket(
      input.ticket,
      action,
      this.binding,
      this.capabilityScope,
      this.#hash,
    );
    const inspection = await this.inspect(action);
    assertPreparedMatchesTicket(inspection, ticket);

    return createOneShotPreparedEffect(
      async (): Promise<SafeCodingRuntimeAdapterResult> => {
        const value = await this.#execute(
          Object.freeze({
            ...runInput(action, inspection.profile, this.capabilityScope),
            ticketId: ticket.ticketId,
            resolvedObjectId: inspection.resolvedObjectId,
            expectedStateCommitmentHash: inspection.stateCommitmentHash,
          }),
        );
        return validateTestExecution(value, action, ticket, inspection);
      },
    );
  }

  private async inspect(
    action: ActionOfKind<'test.run'>,
  ): Promise<PreparedTestInspection> {
    const profile = await this.resolveProfile(action.profileId);
    const value = await this.#inspect(
      Object.freeze(runInput(action, profile, this.capabilityScope)),
    );
    const record = requireClosedRecord(
      value,
      [
        'operation',
        'profileDigest',
        'profileId',
        'resolvedObjectId',
        'stateCommitmentHash',
      ],
      'test.run inspection',
      'prepare',
    );
    requireLiteral(
      record.operation,
      'test.run',
      'Inspection operation',
      'prepare',
    );
    assertEqual(
      record.profileId,
      action.profileId,
      'Test profile ID',
      'prepare',
    );
    assertEqual(
      requireDigest(record.profileDigest, 'Test profile digest', 'prepare'),
      profile.profileDigest,
      'Test profile digest',
      'prepare',
    );
    return Object.freeze({
      ...preparedActionFrom(
        requireIdentifier(
          record.resolvedObjectId,
          'Resolved object ID',
          'prepare',
        ),
        requireDigest(
          record.stateCommitmentHash,
          'State commitment hash',
          'prepare',
        ),
      ),
      profile,
    });
  }

  private async resolveProfile(
    profileId: string,
  ): Promise<RegisteredTestSandboxProfile> {
    let value: unknown;
    try {
      value = await this.#resolveProfile(
        Object.freeze({ capabilityScope: this.capabilityScope, profileId }),
      );
    } catch (error) {
      throw new ReferenceAdapterError(
        'sandbox-profile-unavailable',
        'prepare',
        'Registered test sandbox profile lookup failed closed',
        error,
      );
    }
    if (value === null || value === undefined) {
      throw new ReferenceAdapterError(
        'sandbox-profile-unavailable',
        'prepare',
        'Requested test sandbox profile is not registered',
      );
    }
    const profile = snapshotRegisteredTestProfile(value, 'prepare');
    if (profile.profile.profileId !== profileId) {
      throw new ReferenceAdapterError(
        'sandbox-profile-invalid',
        'prepare',
        'Profile registry returned a different profile ID',
      );
    }
    const digest = await hashCanonicalCommitment(
      TEST_SANDBOX_PROFILE_HASH_DOMAIN,
      profile.profile,
      this.#hash,
      'prepare',
    );
    if (digest !== profile.profileDigest) {
      throw new ReferenceAdapterError(
        'sandbox-profile-invalid',
        'prepare',
        'Test sandbox profile digest does not match its closed descriptor',
      );
    }
    return profile;
  }
}

export function validateRegisteredTestSandboxProfile(
  value: unknown,
): RegisteredTestSandboxProfile {
  return snapshotRegisteredTestProfile(value, 'configuration');
}

export async function hashTestSandboxProfile(
  profileValue: unknown,
  hash: HashPort,
): Promise<string> {
  const profile = snapshotRegisteredTestProfile(
    { profile: profileValue, profileDigest: '0'.repeat(64) },
    'configuration',
  );
  return await hashCanonicalCommitment(
    TEST_SANDBOX_PROFILE_HASH_DOMAIN,
    profile.profile,
    snapshotHashPort(hash),
    'prepare',
  );
}

function snapshotRegisteredTestProfile(
  value: unknown,
  stage: 'configuration' | 'prepare',
): RegisteredTestSandboxProfile {
  const registered = requireClosedRecord(
    value,
    ['profile', 'profileDigest'],
    'Registered test sandbox profile',
    stage,
  );
  const record = requireClosedRecord(
    registered.profile,
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
    stage,
  );
  const profile = Object.freeze({
    kind: requireLiteral(
      record.kind,
      TEST_SANDBOX_PROFILE_KIND,
      'Test profile kind',
      stage,
    ),
    specVersion: requireLiteral(
      record.specVersion,
      TEST_SANDBOX_PROFILE_SPEC_VERSION,
      'Test profile version',
      stage,
    ),
    profileId: requireProfileId(record.profileId, stage),
    testPlanDigest: requireDigest(
      record.testPlanDigest,
      'Test plan digest',
      stage,
    ),
    runnerId: requireIdentifier(record.runnerId, 'Runner ID', stage),
    runnerDigest: requireDigest(record.runnerDigest, 'Runner digest', stage),
    sandboxImageDigest: requireDigest(
      record.sandboxImageDigest,
      'Sandbox image digest',
      stage,
    ),
    network: requireLiteral(record.network, false, 'network', stage),
    credentials: requireLiteral(
      record.credentials,
      false,
      'credentials',
      stage,
    ),
    hostWorkspaceReadOnly: requireLiteral(
      record.hostWorkspaceReadOnly,
      true,
      'hostWorkspaceReadOnly',
      stage,
    ),
    disposableScratch: requireLiteral(
      record.disposableScratch,
      true,
      'disposableScratch',
      stage,
    ),
  });
  return Object.freeze({
    profile,
    profileDigest: requireDigest(
      registered.profileDigest,
      'Test profile digest',
      stage,
    ),
  });
}

function runInput(
  action: ActionOfKind<'test.run'>,
  profile: RegisteredTestSandboxProfile,
  capabilityScope: CapabilityScope,
): TestRunInspectInput {
  return {
    capabilityScope,
    requestId: action.requestId,
    profile: profile.profile,
    profileDigest: profile.profileDigest,
  };
}

function validateTestExecution(
  value: unknown,
  action: ActionOfKind<'test.run'>,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedTestInspection,
): SafeCodingRuntimeAdapterResult {
  const record = requireClosedRecord(
    value,
    [
      'exitCode',
      'operation',
      'outcome',
      'postStateHash',
      'preStateHash',
      'profileDigest',
      'profileId',
      'reportDigest',
      'resolvedObjectId',
      'runnerDigest',
      'ticketId',
    ],
    'test.run execution result',
    'execute',
  );
  requireLiteral(record.operation, 'test.run', 'Operation', 'execute');
  assertEqual(
    requireIdentifier(record.ticketId, 'Ticket ID', 'execute'),
    ticket.ticketId,
    'Ticket ID',
    'execute',
  );
  assertEqual(record.profileId, action.profileId, 'Test profile ID', 'execute');
  assertEqual(
    requireDigest(record.profileDigest, 'Test profile digest', 'execute'),
    inspection.profile.profileDigest,
    'Test profile digest',
    'execute',
  );
  assertEqual(
    requireDigest(record.runnerDigest, 'Runner digest', 'execute'),
    inspection.profile.profile.runnerDigest,
    'Runner digest',
    'execute',
  );
  assertEqual(
    requireIdentifier(record.resolvedObjectId, 'Resolved object ID', 'execute'),
    inspection.resolvedObjectId,
    'Resolved object ID',
    'execute',
  );
  assertEqual(
    requireDigest(record.preStateHash, 'Pre-state hash', 'execute'),
    inspection.stateCommitmentHash,
    'Pre-state hash',
    'execute',
  );
  const outcome = requireOutcome(record.outcome);
  const exitCode = requireNonNegativeInteger(
    record.exitCode,
    'Test exit code',
    'execute',
  );
  if (
    (outcome === 'passed' && exitCode !== 0) ||
    (outcome === 'failed' && exitCode === 0)
  ) {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      'execute',
      'Test outcome and exit code are inconsistent',
    );
  }
  const reportDigest = requireDigest(
    record.reportDigest,
    'Test report digest',
    'execute',
  );
  const postStateHash = requireDigest(
    record.postStateHash,
    'Post-state hash',
    'execute',
  );
  return createAdapterResult(
    Object.freeze({
      operation: 'test.run',
      ticketId: ticket.ticketId,
      resolvedObjectId: inspection.resolvedObjectId,
      profileId: action.profileId,
      profileDigest: inspection.profile.profileDigest,
      runnerId: inspection.profile.profile.runnerId,
      runnerDigest: inspection.profile.profile.runnerDigest,
      testPlanDigest: inspection.profile.profile.testPlanDigest,
      sandboxImageDigest: inspection.profile.profile.sandboxImageDigest,
      outcome,
      exitCode,
      reportDigest,
    }),
    inspection.stateCommitmentHash,
    postStateHash,
  );
}

function requireProfileId(
  value: unknown,
  stage: 'configuration' | 'prepare',
): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new ReferenceAdapterError(
      'sandbox-profile-invalid',
      stage,
      'Test profile ID is invalid',
    );
  }
  return value;
}

function requireOutcome(value: unknown): 'passed' | 'failed' {
  if (value !== 'passed' && value !== 'failed') {
    throw new ReferenceAdapterError(
      'port-result-invalid',
      'execute',
      'Test outcome must be passed or failed',
    );
  }
  return value;
}
