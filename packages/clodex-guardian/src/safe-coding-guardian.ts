import {
  canonicalizeJson,
  encodeUtf8,
  hashIntentContract,
  hashSafeCodingAction,
  resourceSelectorCovers,
  validateSafeCodingAction,
  validateSafeCodingExecutionTicket,
  validateSafeCodingIntentContract,
  verifySignedIntentContract,
  type HashPort,
  type RootAuthorizerRole,
  type SafeCodingAction,
  type SafeCodingEffectClass,
  type SafeCodingExecutionTicket,
  type SafeCodingIntentContract,
  type SignatureVerifier,
  type VerifiedIntentContract,
} from '@clodex/contracts';

const ARGUMENT_HASH_DOMAIN = 'clodex.safe-coding.arguments.v1';
const DEFAULT_TICKET_TTL_MS = 30_000;
const MAX_TICKET_TTL_MS = 300_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export type SafeCodingGuardianReason =
  | 'action-not-authorized'
  | 'adapter-binding-mismatch'
  | 'ambient-authority-not-denied'
  | 'contract-expired'
  | 'contract-integrity-mismatch'
  | 'contract-not-active'
  | 'contract-not-yet-valid'
  | 'effect-class-not-authorized'
  | 'invalid-action'
  | 'mandatory-policy-denied'
  | 'principal-mismatch'
  | 'registry-binding-mismatch'
  | 'request-context-mismatch';

export interface SafeCodingCallerContext {
  readonly principalId: string;
  readonly instanceId: string;
  readonly guardianId: string;
  readonly executorId: string;
  readonly runtimeEpoch: number;
  readonly taskId: string;
  readonly workspaceId: string;
}

export interface ActiveIntentContractSnapshot {
  readonly contractId: string;
  readonly contractHash: string;
  readonly revision: number;
  readonly revocationEpoch: number;
  readonly status: 'active' | 'revoked' | 'superseded';
}

export interface TrustedSafeCodingAdapterBinding {
  readonly action: SafeCodingAction['action'];
  readonly policyDigest: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly adapterRegistryDigest: string;
  readonly runnerRegistryDigest: string;
  readonly effectRegistryDigest: string;
  readonly effectClass: SafeCodingEffectClass;
}

export interface PreparedSafeCodingAction {
  readonly resolvedObjectId: string;
  readonly stateCommitmentHash: string;
}

export interface SafeCodingBudgetCharge {
  readonly uniqueModifiedFiles: number;
  readonly mutationBytes: number;
  readonly testRuns: number;
}

export interface SafeCodingTicketRegistration {
  readonly ticket: SafeCodingExecutionTicket;
  readonly expectedActive: ActiveIntentContractSnapshot;
  readonly limits: SafeCodingIntentContract['authority']['limits'];
  readonly charge: SafeCodingBudgetCharge;
}

/**
 * Kernel-owned state port. Registration must atomically recheck the exact
 * active contract/revocation epoch, reject request/ticket replay, reserve all
 * lineage budgets, and persist the one-shot ticket before returning.
 */
export interface SafeCodingGuardianStatePort {
  getActiveContract(
    contractId: string,
  ):
    | ActiveIntentContractSnapshot
    | null
    | Promise<ActiveIntentContractSnapshot | null>;
  registerTicket(input: SafeCodingTicketRegistration): void | Promise<void>;
}

export interface SafeCodingGuardianIdPort {
  nextTicketId(): string;
  nextReservationId(): string;
  nextNonce(): string;
}

export interface SafeCodingGuardianClockPort {
  now(): string;
}

/** Caller identity is derived from a trusted transport/session, never input. */
export interface SafeCodingGuardianIdentityPort {
  authenticate(): SafeCodingCallerContext | Promise<SafeCodingCallerContext>;
}

export interface SafeCodingMandatoryPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** A current mandatory overlay may narrow or revoke older signed authority. */
export interface SafeCodingMandatoryPolicyPort {
  evaluate(input: {
    readonly contractHash: string;
    readonly contractRevision: number;
    readonly action: SafeCodingAction;
    readonly caller: SafeCodingCallerContext;
  }):
    | SafeCodingMandatoryPolicyDecision
    | Promise<SafeCodingMandatoryPolicyDecision>;
}

export interface SafeCodingAdapterRegistryPort {
  resolve(
    action: SafeCodingAction,
  ):
    | TrustedSafeCodingAdapterBinding
    | null
    | Promise<TrustedSafeCodingAdapterBinding | null>;
}

/** PREPARE must be side-effect free and return only trusted object/state IDs. */
export interface SafeCodingPreparePort {
  prepare(
    action: SafeCodingAction,
    adapter: TrustedSafeCodingAdapterBinding,
  ): PreparedSafeCodingAction | Promise<PreparedSafeCodingAction>;
}

/**
 * Synchronous composite final fence backed by one trusted local snapshot. It
 * must atomically verify current identity/session, mandatory deny state, and
 * the complete policy/adapter/runner/effect registry commitment. It is called
 * after all asynchronous revalidation and immediately before kernel commit.
 */
export interface SafeCodingFinalAuthorityPort {
  assertCurrent(input: {
    readonly ticket: SafeCodingExecutionTicket;
    readonly action: SafeCodingAction;
  }): void;
}

export interface SafeCodingGuardianDependencies {
  readonly hash: HashPort;
  readonly signatures: SignatureVerifier;
  readonly state: SafeCodingGuardianStatePort;
  readonly ids: SafeCodingGuardianIdPort;
  readonly clock: SafeCodingGuardianClockPort;
  readonly identity: SafeCodingGuardianIdentityPort;
  readonly mandatoryPolicy: SafeCodingMandatoryPolicyPort;
  readonly adapters: SafeCodingAdapterRegistryPort;
  readonly prepare: SafeCodingPreparePort;
  readonly finalAuthority: SafeCodingFinalAuthorityPort;
  readonly acceptedRootRoles?: readonly RootAuthorizerRole[];
  readonly ticketTtlMs?: number;
}

export interface SafeCodingGuardianIssueInput {
  readonly signedContract: unknown;
  readonly action: unknown;
}

interface SnapshottedDependencies {
  readonly hash: HashPort;
  readonly signatures: SignatureVerifier;
  readonly state: SafeCodingGuardianStatePort;
  readonly ids: SafeCodingGuardianIdPort;
  readonly clock: SafeCodingGuardianClockPort;
  readonly identity: SafeCodingGuardianIdentityPort;
  readonly mandatoryPolicy: SafeCodingMandatoryPolicyPort;
  readonly adapters: SafeCodingAdapterRegistryPort;
  readonly prepare: SafeCodingPreparePort;
  readonly finalAuthority: SafeCodingFinalAuthorityPort;
  readonly acceptedRootRoles?: readonly RootAuthorizerRole[];
  readonly ticketTtlMs: number;
}

export class SafeCodingGuardianDeniedError extends Error {
  public constructor(
    public readonly reason: SafeCodingGuardianReason,
    message: string,
  ) {
    super(message);
    this.name = 'SafeCodingGuardianDeniedError';
  }
}

/**
 * Stable Guardian trust boundary. Identity, policy, registry, PREPARE, clock,
 * signature trust, and kernel state ports are fixed at construction and cannot
 * be selected or replaced by the model/action request.
 */
export class SafeCodingGuardian {
  private readonly dependencies: SnapshottedDependencies;

  public constructor(dependencies: SafeCodingGuardianDependencies) {
    const ticketTtlMs =
      readOptionalOwnDataProperty(dependencies, 'ticketTtlMs') ??
      DEFAULT_TICKET_TTL_MS;
    assertTicketTtl(ticketTtlMs);
    this.dependencies = snapshotDependencies(dependencies, ticketTtlMs);
  }

  public async issueExecutionTicket(
    input: SafeCodingGuardianIssueInput,
  ): Promise<SafeCodingExecutionTicket> {
    const verifiedContract = await verifySignedIntentContract(
      input.signedContract,
      {
        hash: this.dependencies.hash,
        signatures: this.dependencies.signatures,
        acceptedRootRoles: this.dependencies.acceptedRootRoles,
      },
    );
    const action = parseAction(input.action);
    const contract = await validateVerifiedContract(
      verifiedContract,
      this.dependencies.hash,
    );

    // Static and live authorization checks happen before registry lookup and
    // PREPARE, so denied callers cannot use PREPARE as a resource probe.
    const initialCaller = snapshotCaller(
      await this.dependencies.identity.authenticate(),
    );
    assertContractTime(
      contract,
      parseTimestamp(this.dependencies.clock.now(), 'Guardian time'),
    );
    assertCallerMatches(contract, initialCaller);
    assertAmbientAuthorityDenied(contract);
    assertActionAuthorized(contract, action);
    const initialActive = snapshotActiveContract(
      await this.dependencies.state.getActiveContract(contract.contractId),
    );
    assertActiveContract(verifiedContract, initialActive);
    await this.assertMandatoryPolicy(verifiedContract, action, initialCaller);

    const adapterValue = await this.dependencies.adapters.resolve(action);
    if (!adapterValue) {
      throw new SafeCodingGuardianDeniedError(
        'adapter-binding-mismatch',
        'No trusted adapter is registered for the requested operation',
      );
    }
    const adapter = snapshotAdapterBinding(adapterValue);
    assertAdapterBinding(contract, action, adapter);
    const prepared = snapshotPreparedAction(
      await this.dependencies.prepare.prepare(action, adapter),
    );

    // Hashing and PREPARE may await. Re-authenticate and recheck all mutable
    // authority immediately before the atomic kernel registration.
    const actionHash = await hashSafeCodingAction(
      action,
      this.dependencies.hash,
    );
    const argumentsHash = await hashArguments(action, this.dependencies.hash);
    const finalCaller = snapshotCaller(
      await this.dependencies.identity.authenticate(),
    );
    const nowMs = parseTimestamp(
      this.dependencies.clock.now(),
      'Guardian time',
    );
    assertContractTime(contract, nowMs);
    assertCallerMatches(contract, finalCaller);
    assertSameCaller(initialCaller, finalCaller);
    await this.assertMandatoryPolicy(verifiedContract, action, finalCaller);
    const active = snapshotActiveContract(
      await this.dependencies.state.getActiveContract(contract.contractId),
    );
    assertActiveContract(verifiedContract, active);
    const currentAdapterValue =
      await this.dependencies.adapters.resolve(action);
    if (!currentAdapterValue) {
      throw new SafeCodingGuardianDeniedError(
        'adapter-binding-mismatch',
        'Trusted adapter was removed during authorization',
      );
    }
    const currentAdapter = snapshotAdapterBinding(currentAdapterValue);
    assertSameAdapterBinding(adapter, currentAdapter);
    assertAdapterBinding(contract, action, currentAdapter);

    const contractExpiryMs = parseTimestamp(
      contract.validity.expiresAt,
      'Contract expiry',
    );
    const expiresAtMs = Math.min(
      contractExpiryMs,
      nowMs + this.dependencies.ticketTtlMs,
    );
    if (expiresAtMs <= nowMs) {
      throw new SafeCodingGuardianDeniedError(
        'contract-expired',
        'Intent contract has no remaining execution window',
      );
    }

    const ticket = validateSafeCodingExecutionTicket({
      kind: 'clodex.execution-ticket',
      specVersion: '1.0.0',
      ticketId: this.dependencies.ids.nextTicketId(),
      requestId: action.requestId,
      contractHash: verifiedContract.contractHash,
      contractRevision: contract.revision,
      subject: { ...contract.subject },
      audience: { ...contract.audience },
      actionHash,
      argumentsHash,
      resolvedObjectId: prepared.resolvedObjectId,
      stateCommitmentHash: prepared.stateCommitmentHash,
      adapterId: currentAdapter.adapterId,
      adapterDigest: currentAdapter.adapterDigest,
      policyDigest: currentAdapter.policyDigest,
      registryDigest: currentAdapter.adapterRegistryDigest,
      runnerRegistryDigest: currentAdapter.runnerRegistryDigest,
      effectRegistryDigest: currentAdapter.effectRegistryDigest,
      effectClass: currentAdapter.effectClass,
      revocationEpoch: active.revocationEpoch,
      budgetReservationId: this.dependencies.ids.nextReservationId(),
      nonce: this.dependencies.ids.nextNonce(),
      issuedAt: canonicalTimestamp(nowMs),
      expiresAt: canonicalTimestamp(expiresAtMs),
    });

    await this.dependencies.state.registerTicket({
      ticket,
      expectedActive: active,
      limits: contract.authority.limits,
      charge: budgetChargeFor(action),
    });
    return ticket;
  }

  /**
   * Runtime final fence for use after the adapter's last await and immediately
   * before the kernel COMMIT_PERMIT. The kernel remains authoritative for the
   * active contract/revocation CAS; Guardian rechecks caller, live mandatory
   * policy, ticket expiry, action hash, and the current adapter binding.
   */
  public async revalidateExecutionTicket(
    ticketValue: unknown,
    actionValue: unknown,
  ): Promise<void> {
    const ticket = validateSafeCodingExecutionTicket(ticketValue);
    const action = parseAction(actionValue);
    const actionHash = await hashSafeCodingAction(
      action,
      this.dependencies.hash,
    );
    if (
      ticket.requestId !== action.requestId ||
      ticket.actionHash !== actionHash
    ) {
      throw new SafeCodingGuardianDeniedError(
        'invalid-action',
        'Execution Ticket does not bind the exact final action',
      );
    }
    const nowMs = parseTimestamp(
      this.dependencies.clock.now(),
      'Guardian time',
    );
    if (
      nowMs < parseTimestamp(ticket.issuedAt, 'Ticket issuedAt') ||
      nowMs >= parseTimestamp(ticket.expiresAt, 'Ticket expiresAt')
    ) {
      throw new SafeCodingGuardianDeniedError(
        'contract-expired',
        'Execution Ticket is outside its final dispatch window',
      );
    }
    const callerContext = snapshotCaller(
      await this.dependencies.identity.authenticate(),
    );
    assertTicketCallerMatches(ticket, callerContext);
    await this.assertMandatoryPolicyForTicket(ticket, action, callerContext);
    const adapterValue = await this.dependencies.adapters.resolve(action);
    if (!adapterValue) {
      throw new SafeCodingGuardianDeniedError(
        'adapter-binding-mismatch',
        'Trusted adapter is unavailable at final dispatch',
      );
    }
    const adapter = snapshotAdapterBinding(adapterValue);
    if (
      adapter.action !== action.action ||
      adapter.adapterId !== ticket.adapterId ||
      adapter.adapterDigest !== ticket.adapterDigest ||
      adapter.policyDigest !== ticket.policyDigest ||
      adapter.adapterRegistryDigest !== ticket.registryDigest ||
      adapter.runnerRegistryDigest !== ticket.runnerRegistryDigest ||
      adapter.effectRegistryDigest !== ticket.effectRegistryDigest ||
      adapter.effectClass !== ticket.effectClass
    ) {
      throw new SafeCodingGuardianDeniedError(
        'adapter-binding-mismatch',
        'Trusted adapter binding changed before final dispatch',
      );
    }
  }

  /** Last synchronous check; runtime must call this immediately before commit. */
  public assertFinalAuthority(
    ticketValue: unknown,
    actionValue: unknown,
  ): void {
    const ticket = validateSafeCodingExecutionTicket(ticketValue);
    const action = parseAction(actionValue);
    if (ticket.requestId !== action.requestId) {
      throw new SafeCodingGuardianDeniedError(
        'invalid-action',
        'Execution Ticket request does not match the final action',
      );
    }
    this.dependencies.finalAuthority.assertCurrent({ ticket, action });
  }

  private async assertMandatoryPolicy(
    verifiedContract: VerifiedIntentContract,
    action: SafeCodingAction,
    caller: SafeCodingCallerContext,
  ): Promise<void> {
    let decision: SafeCodingMandatoryPolicyDecision;
    try {
      decision = snapshotMandatoryDecision(
        await this.dependencies.mandatoryPolicy.evaluate({
          contractHash: verifiedContract.contractHash,
          contractRevision: verifiedContract.contract.revision,
          action,
          caller,
        }),
      );
    } catch (error) {
      throw new SafeCodingGuardianDeniedError(
        'mandatory-policy-denied',
        error instanceof Error
          ? `Mandatory policy evaluation failed: ${error.message}`
          : 'Mandatory policy evaluation failed',
      );
    }
    if (!decision.allowed) {
      throw new SafeCodingGuardianDeniedError(
        'mandatory-policy-denied',
        decision.reason ?? 'Current mandatory policy denied the action',
      );
    }
  }

  private async assertMandatoryPolicyForTicket(
    ticket: SafeCodingExecutionTicket,
    action: SafeCodingAction,
    caller: SafeCodingCallerContext,
  ): Promise<void> {
    let decision: SafeCodingMandatoryPolicyDecision;
    try {
      decision = snapshotMandatoryDecision(
        await this.dependencies.mandatoryPolicy.evaluate({
          contractHash: ticket.contractHash,
          contractRevision: ticket.contractRevision,
          action,
          caller,
        }),
      );
    } catch (error) {
      throw new SafeCodingGuardianDeniedError(
        'mandatory-policy-denied',
        error instanceof Error
          ? `Mandatory policy evaluation failed: ${error.message}`
          : 'Mandatory policy evaluation failed',
      );
    }
    if (!decision.allowed) {
      throw new SafeCodingGuardianDeniedError(
        'mandatory-policy-denied',
        decision.reason ?? 'Current mandatory policy denied final dispatch',
      );
    }
  }
}

export function budgetChargeFor(
  action: SafeCodingAction,
): SafeCodingBudgetCharge {
  switch (action.action) {
    case 'filesystem.create':
    case 'filesystem.replace':
      return {
        uniqueModifiedFiles: 1,
        mutationBytes: action.contentBytes,
        testRuns: 0,
      };
    case 'filesystem.mkdir':
      return { uniqueModifiedFiles: 1, mutationBytes: 0, testRuns: 0 };
    case 'test.run':
      return { uniqueModifiedFiles: 0, mutationBytes: 0, testRuns: 1 };
    default:
      return { uniqueModifiedFiles: 0, mutationBytes: 0, testRuns: 0 };
  }
}

function snapshotDependencies(
  dependencies: SafeCodingGuardianDependencies,
  ticketTtlMs: number,
): SnapshottedDependencies {
  const hash = readOwnDataProperty(dependencies, 'hash');
  const signatures = readOwnDataProperty(dependencies, 'signatures');
  const state = readOwnDataProperty(dependencies, 'state');
  const ids = readOwnDataProperty(dependencies, 'ids');
  const clock = readOwnDataProperty(dependencies, 'clock');
  const identity = readOwnDataProperty(dependencies, 'identity');
  const mandatoryPolicy = readOwnDataProperty(dependencies, 'mandatoryPolicy');
  const adapters = readOwnDataProperty(dependencies, 'adapters');
  const prepare = readOwnDataProperty(dependencies, 'prepare');
  const finalAuthority = readOwnDataProperty(dependencies, 'finalAuthority');
  const acceptedRootRoles = readOptionalOwnDataProperty(
    dependencies,
    'acceptedRootRoles',
  );
  return Object.freeze({
    hash: Object.freeze({
      sha256: pinPortMethod(hash, 'sha256', 'Hash port'),
    }),
    signatures: Object.freeze({
      resolveTrustedSigner: pinPortMethod(
        signatures,
        'resolveTrustedSigner',
        'Signature verifier',
      ),
      verify: pinPortMethod(signatures, 'verify', 'Signature verifier'),
      assertTrusted: pinPortMethod(
        signatures,
        'assertTrusted',
        'Signature verifier',
      ),
    }),
    state: Object.freeze({
      getActiveContract: pinPortMethod(
        state,
        'getActiveContract',
        'Guardian state port',
      ),
      registerTicket: pinPortMethod(
        state,
        'registerTicket',
        'Guardian state port',
      ),
    }),
    ids: Object.freeze({
      nextTicketId: pinPortMethod(ids, 'nextTicketId', 'Guardian ID port'),
      nextReservationId: pinPortMethod(
        ids,
        'nextReservationId',
        'Guardian ID port',
      ),
      nextNonce: pinPortMethod(ids, 'nextNonce', 'Guardian ID port'),
    }),
    clock: Object.freeze({
      now: pinPortMethod(clock, 'now', 'Guardian clock port'),
    }),
    identity: Object.freeze({
      authenticate: pinPortMethod(
        identity,
        'authenticate',
        'Guardian identity port',
      ),
    }),
    mandatoryPolicy: Object.freeze({
      evaluate: pinPortMethod(
        mandatoryPolicy,
        'evaluate',
        'Mandatory policy port',
      ),
    }),
    adapters: Object.freeze({
      resolve: pinPortMethod(adapters, 'resolve', 'Adapter registry port'),
    }),
    prepare: Object.freeze({
      prepare: pinPortMethod(prepare, 'prepare', 'Guardian PREPARE port'),
    }),
    finalAuthority: Object.freeze({
      assertCurrent: pinPortMethod(
        finalAuthority,
        'assertCurrent',
        'Final authority port',
      ),
    }),
    acceptedRootRoles: snapshotAcceptedRootRoles(acceptedRootRoles),
    ticketTtlMs,
  });
}

function readOwnDataProperty<Owner extends object, Key extends keyof Owner>(
  owner: Owner,
  key: Key,
): Owner[Key] {
  if (owner === null || typeof owner !== 'object') {
    throw dependencyError('Guardian dependencies must be a data record');
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !('value' in descriptor)) {
    throw dependencyError(
      `Guardian dependency ${String(key)} must be an own data property`,
    );
  }
  return descriptor.value as Owner[Key];
}

function readOptionalOwnDataProperty<
  Owner extends object,
  Key extends keyof Owner,
>(owner: Owner, key: Key): Owner[Key] | undefined {
  if (owner === null || typeof owner !== 'object') {
    throw dependencyError('Guardian dependencies must be a data record');
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw dependencyError(
      `Guardian dependency ${String(key)} must be an own data property`,
    );
  }
  return descriptor.value as Owner[Key];
}

function pinPortMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (
    port === null ||
    (typeof port !== 'object' && typeof port !== 'function')
  ) {
    throw dependencyError(`${label} is missing`);
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw dependencyError(`${label} ${String(name)} must be a data method`);
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw dependencyError(`${label} must provide ${String(name)}()`);
}

function snapshotAcceptedRootRoles(
  roles: readonly RootAuthorizerRole[] | undefined,
): readonly RootAuthorizerRole[] | undefined {
  if (roles === undefined) return undefined;
  if (
    !Array.isArray(roles) ||
    Object.getPrototypeOf(roles) !== Array.prototype ||
    Object.getOwnPropertySymbols(roles).length !== 0 ||
    roles.length > 2
  ) {
    throw dependencyError('Accepted root roles must be a closed dense array');
  }
  const names = Object.getOwnPropertyNames(roles);
  if (names.length !== roles.length + 1 || !names.includes('length')) {
    throw dependencyError('Accepted root roles must not have extra fields');
  }
  const snapshot: RootAuthorizerRole[] = [];
  for (let index = 0; index < roles.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(roles, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw dependencyError(
        'Accepted root roles must contain only data elements',
      );
    }
    if (
      descriptor.value !== 'human-authorizer' &&
      descriptor.value !== 'policy-authorizer'
    ) {
      throw dependencyError('Accepted root role is unsupported');
    }
    if (snapshot.includes(descriptor.value)) {
      throw dependencyError('Accepted root roles must be unique');
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function dependencyError(message: string): SafeCodingGuardianDeniedError {
  return new SafeCodingGuardianDeniedError('invalid-action', message);
}

async function validateVerifiedContract(
  verified: VerifiedIntentContract,
  hash: HashPort,
): Promise<SafeCodingIntentContract> {
  let contract: SafeCodingIntentContract;
  try {
    contract = validateSafeCodingIntentContract(verified.contract);
  } catch (error) {
    throw new SafeCodingGuardianDeniedError(
      'contract-integrity-mismatch',
      error instanceof Error
        ? error.message
        : 'Verified contract failed runtime validation',
    );
  }
  const canonicalPayload = canonicalizeJson(contract);
  const contractHash = await hashIntentContract(contract, hash);
  if (
    canonicalPayload !== verified.canonicalPayload ||
    contractHash !== verified.contractHash
  ) {
    throw new SafeCodingGuardianDeniedError(
      'contract-integrity-mismatch',
      'Verified contract bytes or hash do not match the supplied authority',
    );
  }
  return contract;
}

function parseAction(value: unknown): SafeCodingAction {
  try {
    return validateSafeCodingAction(value);
  } catch (error) {
    throw new SafeCodingGuardianDeniedError(
      'invalid-action',
      error instanceof Error ? error.message : 'Safe-coding action is invalid',
    );
  }
}

function snapshotCaller(
  value: SafeCodingCallerContext,
): SafeCodingCallerContext {
  if (
    !value ||
    typeof value !== 'object' ||
    !isIdentifier(value.principalId) ||
    !isIdentifier(value.instanceId) ||
    !isIdentifier(value.guardianId) ||
    !isIdentifier(value.executorId) ||
    !Number.isSafeInteger(value.runtimeEpoch) ||
    value.runtimeEpoch < 0 ||
    !isIdentifier(value.taskId) ||
    !isIdentifier(value.workspaceId)
  ) {
    throw new SafeCodingGuardianDeniedError(
      'principal-mismatch',
      'Trusted identity port returned an invalid caller context',
    );
  }
  return Object.freeze({
    principalId: value.principalId,
    instanceId: value.instanceId,
    guardianId: value.guardianId,
    executorId: value.executorId,
    runtimeEpoch: value.runtimeEpoch,
    taskId: value.taskId,
    workspaceId: value.workspaceId,
  });
}

function snapshotActiveContract(
  value: ActiveIntentContractSnapshot | null,
): ActiveIntentContractSnapshot | null {
  if (value === null) return null;
  if (
    typeof value !== 'object' ||
    !isIdentifier(value.contractId) ||
    !SHA256_PATTERN.test(value.contractHash) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision <= 0 ||
    !Number.isSafeInteger(value.revocationEpoch) ||
    value.revocationEpoch < 0 ||
    !['active', 'revoked', 'superseded'].includes(value.status)
  ) {
    throw new SafeCodingGuardianDeniedError(
      'contract-not-active',
      'Kernel returned an invalid active-contract snapshot',
    );
  }
  return Object.freeze({
    contractId: value.contractId,
    contractHash: value.contractHash,
    revision: value.revision,
    revocationEpoch: value.revocationEpoch,
    status: value.status,
  });
}

function snapshotAdapterBinding(
  value: TrustedSafeCodingAdapterBinding,
): TrustedSafeCodingAdapterBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    !isIdentifier(value.action) ||
    !SHA256_PATTERN.test(value.policyDigest) ||
    !isIdentifier(value.adapterId) ||
    !SHA256_PATTERN.test(value.adapterDigest) ||
    !SHA256_PATTERN.test(value.adapterRegistryDigest) ||
    !SHA256_PATTERN.test(value.runnerRegistryDigest) ||
    !SHA256_PATTERN.test(value.effectRegistryDigest) ||
    !['local.observation', 'local.reversible', 'sandbox.ephemeral'].includes(
      value.effectClass,
    )
  ) {
    throw new SafeCodingGuardianDeniedError(
      'adapter-binding-mismatch',
      'Trusted adapter registry returned an invalid binding',
    );
  }
  return Object.freeze({
    action: value.action,
    policyDigest: value.policyDigest,
    adapterId: value.adapterId,
    adapterDigest: value.adapterDigest,
    adapterRegistryDigest: value.adapterRegistryDigest,
    runnerRegistryDigest: value.runnerRegistryDigest,
    effectRegistryDigest: value.effectRegistryDigest,
    effectClass: value.effectClass,
  });
}

function snapshotPreparedAction(
  value: PreparedSafeCodingAction,
): PreparedSafeCodingAction {
  if (
    !value ||
    typeof value !== 'object' ||
    !isIdentifier(value.resolvedObjectId) ||
    !SHA256_PATTERN.test(value.stateCommitmentHash)
  ) {
    throw new SafeCodingGuardianDeniedError(
      'adapter-binding-mismatch',
      'Trusted PREPARE returned an invalid object or state commitment',
    );
  }
  return Object.freeze({
    resolvedObjectId: value.resolvedObjectId,
    stateCommitmentHash: value.stateCommitmentHash,
  });
}

function snapshotMandatoryDecision(
  value: SafeCodingMandatoryPolicyDecision,
): SafeCodingMandatoryPolicyDecision {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.allowed !== 'boolean'
  ) {
    throw new Error('Mandatory policy returned an invalid decision');
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== 'string' || value.reason.length > 1_024)
  ) {
    throw new Error('Mandatory policy returned an invalid reason');
  }
  return Object.freeze(
    value.reason === undefined
      ? { allowed: value.allowed }
      : { allowed: value.allowed, reason: value.reason },
  );
}

function assertContractTime(
  contract: SafeCodingIntentContract,
  nowMs: number,
): void {
  if (nowMs < parseTimestamp(contract.validity.notBefore, 'notBefore')) {
    throw new SafeCodingGuardianDeniedError(
      'contract-not-yet-valid',
      'Intent contract is not active yet',
    );
  }
  if (nowMs >= parseTimestamp(contract.validity.expiresAt, 'expiresAt')) {
    throw new SafeCodingGuardianDeniedError(
      'contract-expired',
      'Intent contract has expired',
    );
  }
}

function assertCallerMatches(
  contract: SafeCodingIntentContract,
  caller: SafeCodingCallerContext,
): void {
  if (
    contract.subject.principalId !== caller.principalId ||
    contract.subject.instanceId !== caller.instanceId
  ) {
    throw new SafeCodingGuardianDeniedError(
      'principal-mismatch',
      'Caller principal does not match the intent contract subject',
    );
  }
  if (
    contract.audience.guardianId !== caller.guardianId ||
    contract.audience.executorId !== caller.executorId ||
    contract.audience.runtimeEpoch !== caller.runtimeEpoch ||
    contract.audience.taskId !== caller.taskId ||
    contract.audience.workspaceId !== caller.workspaceId
  ) {
    throw new SafeCodingGuardianDeniedError(
      'request-context-mismatch',
      'Caller execution context does not match the intent contract audience',
    );
  }
}

function assertSameCaller(
  expected: SafeCodingCallerContext,
  current: SafeCodingCallerContext,
): void {
  if (canonicalizeJson(expected) !== canonicalizeJson(current)) {
    throw new SafeCodingGuardianDeniedError(
      'request-context-mismatch',
      'Authenticated caller changed during ticket issuance',
    );
  }
}

function assertTicketCallerMatches(
  ticket: SafeCodingExecutionTicket,
  caller: SafeCodingCallerContext,
): void {
  if (
    ticket.subject.principalId !== caller.principalId ||
    ticket.subject.instanceId !== caller.instanceId
  ) {
    throw new SafeCodingGuardianDeniedError(
      'principal-mismatch',
      'Authenticated caller does not match the Execution Ticket subject',
    );
  }
  if (
    ticket.audience.guardianId !== caller.guardianId ||
    ticket.audience.executorId !== caller.executorId ||
    ticket.audience.runtimeEpoch !== caller.runtimeEpoch ||
    ticket.audience.taskId !== caller.taskId ||
    ticket.audience.workspaceId !== caller.workspaceId
  ) {
    throw new SafeCodingGuardianDeniedError(
      'request-context-mismatch',
      'Authenticated execution context does not match the Execution Ticket',
    );
  }
}

function assertAmbientAuthorityDenied(
  contract: SafeCodingIntentContract,
): void {
  if (Object.values(contract.authority.ambientAuthority).some(Boolean)) {
    throw new SafeCodingGuardianDeniedError(
      'ambient-authority-not-denied',
      'The first safe-coding slice requires every ambient authority to be denied',
    );
  }
}

function assertActionAuthorized(
  contract: SafeCodingIntentContract,
  action: SafeCodingAction,
): void {
  let authorized = false;
  if (isFilesystemAction(action)) {
    authorized = contract.authority.filesystem.some(
      (permission) =>
        permission.action === action.action &&
        resourceSelectorCovers(permission.selector, action.selector),
    );
  } else if (action.action === 'git.status' || action.action === 'git.diff') {
    authorized = contract.authority.git.some(
      (permission) => permission.action === action.action,
    );
  } else if (action.action === 'test.run') {
    authorized = contract.authority.testProfiles.includes(action.profileId);
  }
  if (!authorized) {
    throw new SafeCodingGuardianDeniedError(
      'action-not-authorized',
      'Action is outside the approved intent contract authority',
    );
  }
}

function assertAdapterBinding(
  contract: SafeCodingIntentContract,
  action: SafeCodingAction,
  adapter: TrustedSafeCodingAdapterBinding,
): void {
  if (
    adapter.policyDigest !== contract.bindings.policyDigest ||
    adapter.adapterRegistryDigest !== contract.bindings.adapterRegistryDigest ||
    adapter.runnerRegistryDigest !== contract.bindings.runnerRegistryDigest ||
    adapter.effectRegistryDigest !== contract.bindings.effectRegistryDigest
  ) {
    throw new SafeCodingGuardianDeniedError(
      'registry-binding-mismatch',
      'Trusted registry binding does not match the reviewed contract',
    );
  }
  if (adapter.action !== action.action) {
    throw new SafeCodingGuardianDeniedError(
      'adapter-binding-mismatch',
      'Trusted adapter is not registered for the requested operation',
    );
  }
  if (!contract.authority.allowedEffectClasses.includes(adapter.effectClass)) {
    throw new SafeCodingGuardianDeniedError(
      'effect-class-not-authorized',
      'Trusted effect class is outside the reviewed contract authority',
    );
  }
}

function assertSameAdapterBinding(
  expected: TrustedSafeCodingAdapterBinding,
  current: TrustedSafeCodingAdapterBinding,
): void {
  if (canonicalizeJson(expected) !== canonicalizeJson(current)) {
    throw new SafeCodingGuardianDeniedError(
      'adapter-binding-mismatch',
      'Trusted adapter binding changed during ticket issuance',
    );
  }
}

function assertActiveContract(
  verified: VerifiedIntentContract,
  active: ActiveIntentContractSnapshot | null,
): asserts active is ActiveIntentContractSnapshot {
  if (
    !active ||
    active.status !== 'active' ||
    active.contractId !== verified.contract.contractId ||
    active.contractHash !== verified.contractHash ||
    active.revision !== verified.contract.revision
  ) {
    throw new SafeCodingGuardianDeniedError(
      'contract-not-active',
      'Intent contract is revoked, superseded, missing, or not the exact active revision',
    );
  }
}

function assertTicketTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TICKET_TTL_MS) {
    throw new SafeCodingGuardianDeniedError(
      'invalid-action',
      'Execution ticket TTL must be between 1 ms and 5 minutes',
    );
  }
}

async function hashArguments(
  action: SafeCodingAction,
  hash: HashPort,
): Promise<string> {
  const { requestId: _requestId, ...arguments_ } = action;
  const payload = `${ARGUMENT_HASH_DOMAIN}\0${canonicalizeJson(arguments_)}`;
  return await hash.sha256(encodeUtf8(payload));
}

function isFilesystemAction(
  action: SafeCodingAction,
): action is Extract<SafeCodingAction, { action: `filesystem.${string}` }> {
  return action.action.startsWith('filesystem.');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new SafeCodingGuardianDeniedError(
      'invalid-action',
      `${label} is not a valid timestamp`,
    );
  }
  return parsed;
}

function canonicalTimestamp(value: number): string {
  const timestamp = new Date(value).toISOString();
  return timestamp.endsWith('.000Z')
    ? timestamp.replace('.000Z', 'Z')
    : timestamp;
}
