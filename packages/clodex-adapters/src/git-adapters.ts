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
  requireBoolean,
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

export const HARDENED_GIT_POLICY_KIND = 'clodex.hardened-git-policy' as const;
export const HARDENED_GIT_POLICY_SPEC_VERSION = '1.0.0' as const;
export const HARDENED_GIT_POLICY_HASH_DOMAIN =
  'clodex.hardened-git-policy.v1' as const;

/**
 * Closed policy descriptor for a future hardened Git implementation. This
 * package commits and propagates it but does not invoke Git or enforce OS
 * confinement itself.
 */
export interface HardenedGitPolicy {
  readonly kind: typeof HARDENED_GIT_POLICY_KIND;
  readonly specVersion: typeof HARDENED_GIT_POLICY_SPEC_VERSION;
  readonly fixedOperationsOnly: true;
  readonly arbitraryArguments: false;
  readonly shell: false;
  readonly hooks: false;
  readonly pager: false;
  readonly externalDiff: false;
  readonly textconv: false;
  readonly configOverrides: false;
  readonly credentialHelpers: false;
  readonly network: false;
  readonly repositoryReadOnly: true;
  readonly optionalLocks: false;
}

export interface HardenedGitPolicyCommitment {
  readonly policy: HardenedGitPolicy;
  readonly policyDigest: string;
}

export interface GitStatusInspectInput extends CapabilityScopedPortInput {
  readonly requestId: string;
  readonly hardenedPolicy: HardenedGitPolicy;
  readonly hardenedPolicyDigest: string;
}

export interface GitStatusExecuteInput extends GitStatusInspectInput {
  readonly ticketId: string;
  readonly resolvedObjectId: string;
  readonly expectedStateCommitmentHash: string;
}

/** Fixed status capability: there is deliberately no argv/config/env field. */
export interface GitStatusCapabilityPort {
  inspectStatus(input: GitStatusInspectInput): unknown | Promise<unknown>;
  executeStatus(input: GitStatusExecuteInput): unknown | Promise<unknown>;
}

export interface GitDiffInspectInput extends CapabilityScopedPortInput {
  readonly requestId: string;
  readonly scope: 'worktree' | 'staged';
  readonly hardenedPolicy: HardenedGitPolicy;
  readonly hardenedPolicyDigest: string;
}

export interface GitDiffExecuteInput extends GitDiffInspectInput {
  readonly ticketId: string;
  readonly resolvedObjectId: string;
  readonly expectedStateCommitmentHash: string;
}

/** Fixed diff capability: there is deliberately no argv/config/env field. */
export interface GitDiffCapabilityPort {
  inspectDiff(input: GitDiffInspectInput): unknown | Promise<unknown>;
  executeDiff(input: GitDiffExecuteInput): unknown | Promise<unknown>;
}

export interface ReferenceGitStatusAdapterOptions {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'git.status';
  };
  readonly hash: HashPort;
  readonly hardenedPolicy: HardenedGitPolicyCommitment;
  readonly capability: GitStatusCapabilityPort;
}

export interface ReferenceGitDiffAdapterOptions {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'git.diff';
  };
  readonly hash: HashPort;
  readonly hardenedPolicy: HardenedGitPolicyCommitment;
  readonly capability: GitDiffCapabilityPort;
}

interface PreparedGitInspection {
  readonly resolvedObjectId: string;
  readonly stateCommitmentHash: string;
}

export class ReferenceGitStatusAdapter
  implements CapabilityConfinedSafeCodingAdapter
{
  public readonly capabilityScope: CapabilityScope;
  public readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'git.status';
  };

  readonly #hash: HashPort;
  readonly #policy: HardenedGitPolicyCommitment;
  readonly #inspect: GitStatusCapabilityPort['inspectStatus'];
  readonly #execute: GitStatusCapabilityPort['executeStatus'];

  public constructor(options: ReferenceGitStatusAdapterOptions) {
    const binding = readOwnDataField<
      ReferenceGitStatusAdapterOptions['binding']
    >(options, 'binding', 'Git adapter binding');
    const hash = readOwnDataField<HashPort>(options, 'hash', 'Git hash port');
    const hardenedPolicy = readOwnDataField<HardenedGitPolicyCommitment>(
      options,
      'hardenedPolicy',
      'Hardened Git policy',
    );
    const capability = readOwnDataField<GitStatusCapabilityPort>(
      options,
      'capability',
      'Git status capability',
    );
    this.capabilityScope = snapshotCapabilityScope(
      readOwnDataField(options, 'capabilityScope', 'Git adapter scope'),
    );
    this.binding = snapshotBinding(binding, 'git.status', 'local.observation');
    this.#hash = snapshotHashPort(hash);
    this.#policy = snapshotHardenedGitPolicy(hardenedPolicy);
    this.#inspect = snapshotMethod(
      capability,
      'inspectStatus',
      'git.status inspect',
    );
    this.#execute = snapshotMethod(
      capability,
      'executeStatus',
      'git.status execute',
    );
    Object.freeze(this);
  }

  public async prepareAuthorization(
    actionValue: SafeCodingAction,
  ): Promise<PreparedSafeCodingAction> {
    const action = requireActionKind(actionValue, 'git.status');
    await assertHardenedPolicyDigest(this.#policy, this.#hash);
    const inspection = await this.inspect(action);
    return preparedActionFrom(
      inspection.resolvedObjectId,
      inspection.stateCommitmentHash,
    );
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    const action = requireActionKind(input.action, 'git.status');
    const ticket = await requireExactTicket(
      input.ticket,
      action,
      this.binding,
      this.capabilityScope,
      this.#hash,
    );
    await assertHardenedPolicyDigest(this.#policy, this.#hash);
    const inspection = await this.inspect(action);
    assertPreparedMatchesTicket(inspection, ticket);

    return createOneShotPreparedEffect(
      async (): Promise<SafeCodingRuntimeAdapterResult> => {
        const value = await this.#execute(
          Object.freeze({
            ...statusInput(action, this.#policy, this.capabilityScope),
            ticketId: ticket.ticketId,
            resolvedObjectId: inspection.resolvedObjectId,
            expectedStateCommitmentHash: inspection.stateCommitmentHash,
          }),
        );
        return validateStatusExecution(
          value,
          ticket,
          inspection,
          this.#policy.policyDigest,
        );
      },
    );
  }

  private async inspect(
    action: ActionOfKind<'git.status'>,
  ): Promise<PreparedGitInspection> {
    const value = await this.#inspect(
      Object.freeze(statusInput(action, this.#policy, this.capabilityScope)),
    );
    return validateGitInspection(
      value,
      'git.status',
      this.#policy.policyDigest,
    );
  }
}

export class ReferenceGitDiffAdapter
  implements CapabilityConfinedSafeCodingAdapter
{
  public readonly capabilityScope: CapabilityScope;
  public readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'git.diff';
  };

  readonly #hash: HashPort;
  readonly #policy: HardenedGitPolicyCommitment;
  readonly #inspect: GitDiffCapabilityPort['inspectDiff'];
  readonly #execute: GitDiffCapabilityPort['executeDiff'];

  public constructor(options: ReferenceGitDiffAdapterOptions) {
    const binding = readOwnDataField<ReferenceGitDiffAdapterOptions['binding']>(
      options,
      'binding',
      'Git adapter binding',
    );
    const hash = readOwnDataField<HashPort>(options, 'hash', 'Git hash port');
    const hardenedPolicy = readOwnDataField<HardenedGitPolicyCommitment>(
      options,
      'hardenedPolicy',
      'Hardened Git policy',
    );
    const capability = readOwnDataField<GitDiffCapabilityPort>(
      options,
      'capability',
      'Git diff capability',
    );
    this.capabilityScope = snapshotCapabilityScope(
      readOwnDataField(options, 'capabilityScope', 'Git adapter scope'),
    );
    this.binding = snapshotBinding(binding, 'git.diff', 'local.observation');
    this.#hash = snapshotHashPort(hash);
    this.#policy = snapshotHardenedGitPolicy(hardenedPolicy);
    this.#inspect = snapshotMethod(
      capability,
      'inspectDiff',
      'git.diff inspect',
    );
    this.#execute = snapshotMethod(
      capability,
      'executeDiff',
      'git.diff execute',
    );
    Object.freeze(this);
  }

  public async prepareAuthorization(
    actionValue: SafeCodingAction,
  ): Promise<PreparedSafeCodingAction> {
    const action = requireActionKind(actionValue, 'git.diff');
    await assertHardenedPolicyDigest(this.#policy, this.#hash);
    const inspection = await this.inspect(action);
    return preparedActionFrom(
      inspection.resolvedObjectId,
      inspection.stateCommitmentHash,
    );
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    const action = requireActionKind(input.action, 'git.diff');
    const ticket = await requireExactTicket(
      input.ticket,
      action,
      this.binding,
      this.capabilityScope,
      this.#hash,
    );
    await assertHardenedPolicyDigest(this.#policy, this.#hash);
    const inspection = await this.inspect(action);
    assertPreparedMatchesTicket(inspection, ticket);

    return createOneShotPreparedEffect(
      async (): Promise<SafeCodingRuntimeAdapterResult> => {
        const value = await this.#execute(
          Object.freeze({
            ...diffInput(action, this.#policy, this.capabilityScope),
            ticketId: ticket.ticketId,
            resolvedObjectId: inspection.resolvedObjectId,
            expectedStateCommitmentHash: inspection.stateCommitmentHash,
          }),
        );
        return validateDiffExecution(
          value,
          action,
          ticket,
          inspection,
          this.#policy.policyDigest,
        );
      },
    );
  }

  private async inspect(
    action: ActionOfKind<'git.diff'>,
  ): Promise<PreparedGitInspection> {
    const value = await this.#inspect(
      Object.freeze(diffInput(action, this.#policy, this.capabilityScope)),
    );
    return validateGitInspection(value, 'git.diff', this.#policy.policyDigest);
  }
}

export function validateHardenedGitPolicyCommitment(
  value: unknown,
): HardenedGitPolicyCommitment {
  return snapshotHardenedGitPolicy(value);
}

export async function hashHardenedGitPolicy(
  policyValue: unknown,
  hash: HashPort,
): Promise<string> {
  const commitment = snapshotHardenedGitPolicy({
    policy: policyValue,
    policyDigest: '0'.repeat(64),
  });
  return await hashCanonicalCommitment(
    HARDENED_GIT_POLICY_HASH_DOMAIN,
    commitment.policy,
    snapshotHashPort(hash),
    'prepare',
  );
}

function snapshotHardenedGitPolicy(
  value: unknown,
): HardenedGitPolicyCommitment {
  const commitment = requireClosedRecord(
    value,
    ['policy', 'policyDigest'],
    'Hardened Git policy commitment',
    'configuration',
  );
  const policyValue = requireClosedRecord(
    commitment.policy,
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
    'configuration',
  );
  const policy = Object.freeze({
    kind: requireLiteral(
      policyValue.kind,
      HARDENED_GIT_POLICY_KIND,
      'Git policy kind',
      'configuration',
    ),
    specVersion: requireLiteral(
      policyValue.specVersion,
      HARDENED_GIT_POLICY_SPEC_VERSION,
      'Git policy version',
      'configuration',
    ),
    fixedOperationsOnly: requireLiteral(
      policyValue.fixedOperationsOnly,
      true,
      'fixedOperationsOnly',
      'configuration',
    ),
    arbitraryArguments: requireLiteral(
      policyValue.arbitraryArguments,
      false,
      'arbitraryArguments',
      'configuration',
    ),
    shell: requireLiteral(policyValue.shell, false, 'shell', 'configuration'),
    hooks: requireLiteral(policyValue.hooks, false, 'hooks', 'configuration'),
    pager: requireLiteral(policyValue.pager, false, 'pager', 'configuration'),
    externalDiff: requireLiteral(
      policyValue.externalDiff,
      false,
      'externalDiff',
      'configuration',
    ),
    textconv: requireLiteral(
      policyValue.textconv,
      false,
      'textconv',
      'configuration',
    ),
    configOverrides: requireLiteral(
      policyValue.configOverrides,
      false,
      'configOverrides',
      'configuration',
    ),
    credentialHelpers: requireLiteral(
      policyValue.credentialHelpers,
      false,
      'credentialHelpers',
      'configuration',
    ),
    network: requireLiteral(
      policyValue.network,
      false,
      'network',
      'configuration',
    ),
    repositoryReadOnly: requireLiteral(
      policyValue.repositoryReadOnly,
      true,
      'repositoryReadOnly',
      'configuration',
    ),
    optionalLocks: requireLiteral(
      policyValue.optionalLocks,
      false,
      'optionalLocks',
      'configuration',
    ),
  });
  return Object.freeze({
    policy,
    policyDigest: requireDigest(
      commitment.policyDigest,
      'Hardened Git policy digest',
      'configuration',
    ),
  });
}

async function assertHardenedPolicyDigest(
  commitment: HardenedGitPolicyCommitment,
  hash: HashPort,
): Promise<void> {
  const digest = await hashCanonicalCommitment(
    HARDENED_GIT_POLICY_HASH_DOMAIN,
    commitment.policy,
    hash,
    'prepare',
  );
  if (digest !== commitment.policyDigest) {
    throw new ReferenceAdapterError(
      'hardened-policy-invalid',
      'prepare',
      'Hardened Git policy digest does not match its closed descriptor',
    );
  }
}

function statusInput(
  action: ActionOfKind<'git.status'>,
  policy: HardenedGitPolicyCommitment,
  capabilityScope: CapabilityScope,
): GitStatusInspectInput {
  return {
    capabilityScope,
    requestId: action.requestId,
    hardenedPolicy: policy.policy,
    hardenedPolicyDigest: policy.policyDigest,
  };
}

function diffInput(
  action: ActionOfKind<'git.diff'>,
  policy: HardenedGitPolicyCommitment,
  capabilityScope: CapabilityScope,
): GitDiffInspectInput {
  return {
    capabilityScope,
    requestId: action.requestId,
    scope: action.scope,
    hardenedPolicy: policy.policy,
    hardenedPolicyDigest: policy.policyDigest,
  };
}

function validateGitInspection(
  value: unknown,
  operation: 'git.status' | 'git.diff',
  policyDigest: string,
): PreparedGitInspection {
  const record = requireClosedRecord(
    value,
    [
      'hardenedPolicyDigest',
      'operation',
      'resolvedObjectId',
      'stateCommitmentHash',
    ],
    `${operation} inspection`,
    'prepare',
  );
  requireLiteral(
    record.operation,
    operation,
    'Inspection operation',
    'prepare',
  );
  assertEqual(
    requireDigest(
      record.hardenedPolicyDigest,
      'Hardened policy digest',
      'prepare',
    ),
    policyDigest,
    'Hardened policy digest',
    'prepare',
  );
  return preparedActionFrom(
    requireIdentifier(record.resolvedObjectId, 'Resolved object ID', 'prepare'),
    requireDigest(
      record.stateCommitmentHash,
      'State commitment hash',
      'prepare',
    ),
  );
}

function validateStatusExecution(
  value: unknown,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedGitInspection,
  policyDigest: string,
): SafeCodingRuntimeAdapterResult {
  const record = requireClosedRecord(
    value,
    [
      'clean',
      'hardenedPolicyDigest',
      'operation',
      'postStateHash',
      'preStateHash',
      'resolvedObjectId',
      'summaryDigest',
      'ticketId',
    ],
    'git.status execution result',
    'execute',
  );
  requireLiteral(record.operation, 'git.status', 'Operation', 'execute');
  assertGitExecutionIdentity(record, ticket, inspection, policyDigest);
  const clean = requireBoolean(record.clean, 'Clean status', 'execute');
  const summaryDigest = requireDigest(
    record.summaryDigest,
    'Status summary digest',
    'execute',
  );
  return createAdapterResult(
    Object.freeze({
      operation: 'git.status',
      ticketId: ticket.ticketId,
      resolvedObjectId: inspection.resolvedObjectId,
      hardenedPolicyDigest: policyDigest,
      clean,
      summaryDigest,
    }),
    inspection.stateCommitmentHash,
    inspection.stateCommitmentHash,
  );
}

function validateDiffExecution(
  value: unknown,
  action: ActionOfKind<'git.diff'>,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedGitInspection,
  policyDigest: string,
): SafeCodingRuntimeAdapterResult {
  const record = requireClosedRecord(
    value,
    [
      'changedFiles',
      'diffDigest',
      'hardenedPolicyDigest',
      'operation',
      'postStateHash',
      'preStateHash',
      'resolvedObjectId',
      'scope',
      'ticketId',
    ],
    'git.diff execution result',
    'execute',
  );
  requireLiteral(record.operation, 'git.diff', 'Operation', 'execute');
  assertGitExecutionIdentity(record, ticket, inspection, policyDigest);
  assertEqual(record.scope, action.scope, 'Diff scope', 'execute');
  const changedFiles = requireNonNegativeInteger(
    record.changedFiles,
    'Changed file count',
    'execute',
  );
  const diffDigest = requireDigest(record.diffDigest, 'Diff digest', 'execute');
  return createAdapterResult(
    Object.freeze({
      operation: 'git.diff',
      scope: action.scope,
      ticketId: ticket.ticketId,
      resolvedObjectId: inspection.resolvedObjectId,
      hardenedPolicyDigest: policyDigest,
      changedFiles,
      diffDigest,
    }),
    inspection.stateCommitmentHash,
    inspection.stateCommitmentHash,
  );
}

function assertGitExecutionIdentity(
  record: Record<string, unknown>,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedGitInspection,
  policyDigest: string,
): void {
  assertEqual(
    requireIdentifier(record.ticketId, 'Ticket ID', 'execute'),
    ticket.ticketId,
    'Ticket ID',
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
  assertEqual(
    requireDigest(record.postStateHash, 'Post-state hash', 'execute'),
    inspection.stateCommitmentHash,
    'Post-state hash',
    'execute',
  );
  assertEqual(
    requireDigest(
      record.hardenedPolicyDigest,
      'Hardened policy digest',
      'execute',
    ),
    policyDigest,
    'Hardened policy digest',
    'execute',
  );
}
