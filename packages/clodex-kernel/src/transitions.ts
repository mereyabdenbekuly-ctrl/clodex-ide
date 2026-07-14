import {
  canonicalizeJson,
  validateSafeCodingExecutionTicket,
  validateSafeCodingIntentContract,
  type SafeCodingExecutionTicket,
  type SafeCodingIntentContract,
} from '@clodex/contracts';

import {
  SafeCodingKernelError,
  type ActivateKernelContractInput,
  type CommitPermitInput,
  type FailBeforeCommitInput,
  type KernelActiveContractSnapshot,
  type KernelBudgetCharge,
  type KernelCommitPermit,
  type KernelContractCasExpectation,
  type KernelContractLineage,
  type KernelContractRevisionRecord,
  type KernelTicketRecord,
  type RegisterKernelTicketInput,
  type RevokeKernelContractInput,
  type SafeCodingKernelErrorCode,
  type SafeCodingKernelState,
  type SettleKernelTicketInput,
} from './state.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

export interface CommitPermitTransitionSuccess {
  readonly ok: true;
  readonly state: SafeCodingKernelState;
  readonly permit: KernelCommitPermit;
}

export interface CommitPermitTransitionFailure {
  readonly ok: false;
  /**
   * This can differ from the input state. In particular, an expired or stale
   * registered ticket is consumed as `failed-no-effect` before denial is
   * returned, so a caller can persist both outcomes under one CAS boundary.
   */
  readonly state: SafeCodingKernelState;
  readonly error: SafeCodingKernelError;
}

export type CommitPermitTransitionResult =
  | CommitPermitTransitionSuccess
  | CommitPermitTransitionFailure;

export function activateContractTransition(
  state: SafeCodingKernelState,
  input: ActivateKernelContractInput,
): SafeCodingKernelState {
  const nowMs = timestampMilliseconds(
    input.now,
    'Contract activation time',
    'contract-invalid',
  );
  const { contract, contractHash } = validateVerifiedContract(input);
  const existing = ownValue(state.lineages, contract.contractId);

  if (contract.revision === 1) {
    if (input.expectedPrevious !== null) {
      throw kernelError(
        'contract-cas-mismatch',
        'Revision 1 activation must not provide a previous-state expectation',
      );
    }
    if (existing) {
      throw kernelError(
        'contract-already-exists',
        `Contract lineage ${contract.contractId} already exists`,
      );
    }
    if (contract.previousRevisionHash !== null) {
      throw kernelError(
        'contract-invalid',
        'Revision 1 must not bind a previous revision hash',
      );
    }

    const revision: KernelContractRevisionRecord = {
      contract,
      contractHash,
      revision: contract.revision,
      previousRevisionHash: null,
      status: 'active',
      revocationEpoch: 0,
      activatedAt: input.now,
      endedAt: null,
      endReason: null,
    };
    const lineage: KernelContractLineage = {
      contractId: contract.contractId,
      currentContractHash: contractHash,
      revocationEpoch: 0,
      revisions: [revision],
      budget: {
        modifiedObjectIds: [],
        mutationBytes: 0,
        testRuns: 0,
      },
    };

    return {
      ...state,
      lineages: {
        ...state.lineages,
        [contract.contractId]: lineage,
      },
    };
  }

  if (!existing) {
    throw kernelError(
      'contract-not-found',
      `Contract lineage ${contract.contractId} does not exist`,
    );
  }
  const current = currentRevision(existing);
  if (current.status === 'revoked') {
    throw kernelError(
      'contract-revoked',
      `Contract lineage ${contract.contractId} has been revoked and cannot be reactivated`,
    );
  }
  if (current.status !== 'active') {
    throw kernelError(
      'contract-not-active',
      `Contract lineage ${contract.contractId} has no active current revision`,
    );
  }
  if (input.expectedPrevious === null) {
    throw kernelError(
      'contract-cas-mismatch',
      'A later contract revision requires an exact previous-state expectation',
    );
  }
  assertCasMatches(existing, current, input.expectedPrevious);
  if (
    contract.revision !== current.revision + 1 ||
    contract.previousRevisionHash !== current.contractHash
  ) {
    throw kernelError(
      'contract-cas-mismatch',
      'Contract revision does not extend the exact active revision',
    );
  }
  if (contractHash === current.contractHash) {
    throw kernelError(
      'contract-invalid',
      'A new revision cannot reuse the current contract hash',
    );
  }
  assertNotBefore(
    nowMs,
    timestampMilliseconds(
      current.activatedAt,
      'Current revision activation time',
      'contract-invalid',
    ),
    'contract-cas-mismatch',
    'A contract revision cannot be activated before its predecessor',
  );

  const nextEpoch = safeIncrement(
    existing.revocationEpoch,
    'contract-cas-mismatch',
    'Contract revocation epoch cannot be incremented safely',
  );
  const supersedeReason = `Superseded by contract revision ${contract.revision}`;
  const revisions = existing.revisions.map((revision) =>
    revision.contractHash === current.contractHash
      ? {
          ...revision,
          status: 'superseded' as const,
          endedAt: input.now,
          endReason: supersedeReason,
        }
      : revision,
  );
  const nextRevision: KernelContractRevisionRecord = {
    contract,
    contractHash,
    revision: contract.revision,
    previousRevisionHash: contract.previousRevisionHash,
    status: 'active',
    revocationEpoch: nextEpoch,
    activatedAt: input.now,
    endedAt: null,
    endReason: null,
  };
  const lineage: KernelContractLineage = {
    ...existing,
    currentContractHash: contractHash,
    revocationEpoch: nextEpoch,
    revisions: [...revisions, nextRevision],
  };

  return {
    ...state,
    lineages: {
      ...state.lineages,
      [contract.contractId]: lineage,
    },
    tickets: failRegisteredTickets(
      state.tickets,
      contract.contractId,
      input.now,
      supersedeReason,
    ),
  };
}

export function revokeContractTransition(
  state: SafeCodingKernelState,
  input: RevokeKernelContractInput,
): SafeCodingKernelState {
  const nowMs = timestampMilliseconds(
    input.now,
    'Contract revocation time',
    'contract-invalid',
  );
  const lineage = ownValue(state.lineages, input.contractId);
  if (!lineage) {
    throw kernelError(
      'contract-not-found',
      `Contract lineage ${input.contractId} does not exist`,
    );
  }
  const current = currentRevision(lineage);
  if (current.status === 'revoked') {
    throw kernelError(
      'contract-revoked',
      `Contract lineage ${input.contractId} is already revoked`,
    );
  }
  if (current.status !== 'active') {
    throw kernelError(
      'contract-not-active',
      `Contract lineage ${input.contractId} has no active current revision`,
    );
  }
  assertCasMatches(lineage, current, input.expectedActive);
  assertNotBefore(
    nowMs,
    timestampMilliseconds(
      current.activatedAt,
      'Current revision activation time',
      'contract-invalid',
    ),
    'contract-cas-mismatch',
    'A contract cannot be revoked before it was activated',
  );
  const reason =
    optionalReason(input.reason, 'Contract revoked', 'contract-invalid') ??
    'Contract revoked';
  const nextEpoch = safeIncrement(
    lineage.revocationEpoch,
    'contract-cas-mismatch',
    'Contract revocation epoch cannot be incremented safely',
  );
  const revisions = lineage.revisions.map((revision) =>
    revision.contractHash === current.contractHash
      ? {
          ...revision,
          status: 'revoked' as const,
          revocationEpoch: nextEpoch,
          endedAt: input.now,
          endReason: reason,
        }
      : revision,
  );

  return {
    ...state,
    lineages: {
      ...state.lineages,
      [input.contractId]: {
        ...lineage,
        revocationEpoch: nextEpoch,
        revisions,
      },
    },
    tickets: failRegisteredTickets(
      state.tickets,
      input.contractId,
      input.now,
      reason,
    ),
  };
}

export function registerTicketTransition(
  state: SafeCodingKernelState,
  input: RegisterKernelTicketInput,
): SafeCodingKernelState {
  const nowMs = timestampMilliseconds(
    input.now,
    'Ticket registration time',
    'ticket-invalid',
  );
  const ticket = validatedTicket(input.ticket);
  const expected = input.expectedActive;
  const lineage = ownValue(state.lineages, expected.contractId);
  if (!lineage) {
    throw kernelError(
      'contract-not-found',
      `Contract lineage ${expected.contractId} does not exist`,
    );
  }
  const current = currentRevision(lineage);
  if (current.status === 'revoked') {
    throw kernelError(
      'contract-revoked',
      `Contract lineage ${expected.contractId} is revoked`,
    );
  }
  if (current.status !== 'active') {
    throw kernelError(
      'contract-not-active',
      `Contract lineage ${expected.contractId} is not active`,
    );
  }
  assertActiveSnapshotMatches(lineage, current, expected);
  assertContractUsableAt(current.contract, nowMs);
  assertTicketBindsContract(ticket, current, lineage.revocationEpoch);
  assertTicketTimeWindow(ticket, current.contract, nowMs);
  assertLimitsMatch(input.limits, current.contract.authority.limits);
  const charge = validatedCharge(input.charge);

  if (hasOwn(state.tickets, ticket.ticketId)) {
    throw kernelError(
      'ticket-replay',
      `Execution ticket ${ticket.ticketId} has already been registered`,
    );
  }
  if (hasOwn(state.requestIds, ticket.requestId)) {
    throw kernelError(
      'request-replay',
      `Request ${ticket.requestId} has already consumed a ticket`,
    );
  }
  if (hasOwn(state.reservationIds, ticket.budgetReservationId)) {
    throw kernelError(
      'reservation-replay',
      `Budget reservation ${ticket.budgetReservationId} has already been consumed`,
    );
  }

  const objectAlreadyCharged = lineage.budget.modifiedObjectIds.includes(
    ticket.resolvedObjectId,
  );
  const reservesObject = charge.uniqueModifiedFiles === 1;
  const uniqueModifiedFiles = reservesObject && !objectAlreadyCharged ? 1 : 0;
  const modifiedObjectIds =
    uniqueModifiedFiles === 1
      ? [...lineage.budget.modifiedObjectIds, ticket.resolvedObjectId]
      : lineage.budget.modifiedObjectIds;
  const mutationBytes = safeAddBudget(
    lineage.budget.mutationBytes,
    charge.mutationBytes,
    'Mutation byte budget exceeds the safe integer range',
  );
  const testRuns = safeAddBudget(
    lineage.budget.testRuns,
    charge.testRuns,
    'Test-run budget exceeds the safe integer range',
  );
  const nextBudget = {
    modifiedObjectIds,
    mutationBytes,
    testRuns,
  };
  const limits = current.contract.authority.limits;
  if (
    modifiedObjectIds.length > limits.maxUniqueModifiedFiles ||
    mutationBytes > limits.maxMutationBytes ||
    testRuns > limits.maxTestRuns
  ) {
    throw kernelError(
      'budget-exhausted',
      'Execution ticket would exceed the contract lineage budget',
    );
  }

  const reservedCharge: KernelBudgetCharge = {
    uniqueModifiedFiles,
    mutationBytes: charge.mutationBytes,
    testRuns: charge.testRuns,
  };
  const aggregateCharge: KernelBudgetCharge = {
    uniqueModifiedFiles: modifiedObjectIds.length,
    mutationBytes,
    testRuns,
  };
  const record: KernelTicketRecord = {
    ticket,
    contractId: expected.contractId,
    status: 'registered',
    registeredAt: input.now,
    commitPermittedAt: null,
    terminalAt: null,
    terminalReason: null,
    resultHash: null,
    reservedCharge,
    aggregateCharge,
  };

  return {
    ...state,
    lineages: {
      ...state.lineages,
      [expected.contractId]: {
        ...lineage,
        budget: nextBudget,
      },
    },
    tickets: {
      ...state.tickets,
      [ticket.ticketId]: record,
    },
    requestIds: {
      ...state.requestIds,
      [ticket.requestId]: ticket.ticketId,
    },
    reservationIds: {
      ...state.reservationIds,
      [ticket.budgetReservationId]: ticket.ticketId,
    },
  };
}

export function commitPermitTransition(
  state: SafeCodingKernelState,
  input: CommitPermitInput,
): CommitPermitTransitionResult {
  let nowMs: number;
  let ticket: SafeCodingExecutionTicket;
  try {
    nowMs = timestampMilliseconds(
      input.now,
      'Commit-permit time',
      'ticket-invalid',
    );
    ticket = validatedTicket(input.ticket);
  } catch (error) {
    return commitFailure(state, asKernelError(error, 'ticket-invalid'));
  }

  const record = ownValue(state.tickets, ticket.ticketId);
  if (!record) {
    return commitFailure(
      state,
      kernelError(
        'ticket-not-found',
        `Execution ticket ${ticket.ticketId} is not registered`,
      ),
    );
  }
  if (!sameTicket(record.ticket, ticket)) {
    return commitFailure(
      state,
      kernelError(
        'ticket-invalid',
        'Commit request does not contain the exact registered ticket',
      ),
    );
  }
  if (record.status === 'commit-permit') {
    return commitFailure(
      state,
      kernelError(
        'ticket-not-executable',
        `Execution ticket ${ticket.ticketId} has already issued its one-shot commit permit`,
      ),
    );
  }
  if (record.status !== 'registered') {
    return commitFailure(
      state,
      kernelError(
        'ticket-terminal',
        `Execution ticket ${ticket.ticketId} is already terminal`,
      ),
    );
  }
  if (
    nowMs <
      timestampMilliseconds(
        record.registeredAt,
        'Ticket registration time',
        'ticket-invalid',
      ) ||
    nowMs <
      timestampMilliseconds(
        ticket.issuedAt,
        'Ticket issuance time',
        'ticket-invalid',
      )
  ) {
    return commitFailure(
      state,
      kernelError(
        'ticket-invalid',
        'Commit permit cannot precede ticket issuance or registration',
      ),
    );
  }
  if (
    nowMs >=
    timestampMilliseconds(
      ticket.expiresAt,
      'Ticket expiry time',
      'ticket-invalid',
    )
  ) {
    return terminalCommitFailure(
      state,
      record,
      input.now,
      kernelError(
        'ticket-expired',
        `Execution ticket ${ticket.ticketId} expired before commit permit`,
      ),
    );
  }

  const lineage = ownValue(state.lineages, record.contractId);
  if (!lineage || !ticketMatchesActiveLineage(ticket, lineage, nowMs)) {
    return terminalCommitFailure(
      state,
      record,
      input.now,
      kernelError(
        'ticket-stale',
        `Execution ticket ${ticket.ticketId} no longer matches the exact active contract revision`,
      ),
    );
  }

  const nextRecord: KernelTicketRecord = {
    ...record,
    status: 'commit-permit',
    commitPermittedAt: input.now,
  };
  const nextState: SafeCodingKernelState = {
    ...state,
    tickets: {
      ...state.tickets,
      [ticket.ticketId]: nextRecord,
    },
  };
  return {
    ok: true,
    state: nextState,
    permit: {
      ticketId: ticket.ticketId,
      requestId: ticket.requestId,
      contractHash: ticket.contractHash,
      contractRevision: ticket.contractRevision,
      revocationEpoch: ticket.revocationEpoch,
      budgetReservationId: ticket.budgetReservationId,
      permittedAt: input.now,
    },
  };
}

/**
 * Close a prepared ticket when trusted runtime readiness fails before the
 * COMMIT_PERMIT linearization point. Replay identifiers and conservative
 * budget reservations remain consumed.
 */
export function failBeforeCommitTransition(
  state: SafeCodingKernelState,
  input: FailBeforeCommitInput,
): SafeCodingKernelState {
  const nowMs = timestampMilliseconds(
    input.now,
    'Pre-commit failure time',
    'ticket-invalid',
  );
  const record = ownValue(state.tickets, input.ticketId);
  if (!record) {
    throw kernelError(
      'ticket-not-found',
      `Execution ticket ${input.ticketId} is not registered`,
    );
  }
  if (record.status === 'commit-permit') {
    throw kernelError(
      'ticket-not-executable',
      `Execution ticket ${input.ticketId} already crossed COMMIT_PERMIT`,
    );
  }
  if (record.status !== 'registered') {
    throw kernelError(
      'ticket-terminal',
      `Execution ticket ${input.ticketId} is already terminal`,
    );
  }
  if (
    nowMs <
    timestampMilliseconds(
      record.registeredAt,
      'Ticket registration time',
      'ticket-invalid',
    )
  ) {
    throw kernelError(
      'ticket-invalid',
      'Pre-commit failure cannot precede ticket registration',
    );
  }
  const reason = optionalReason(input.reason, null);
  if (reason === null) {
    throw kernelError(
      'ticket-invalid',
      'Pre-commit failure requires a bounded non-empty reason',
    );
  }

  return {
    ...state,
    tickets: {
      ...state.tickets,
      [input.ticketId]: {
        ...record,
        status: 'failed-no-effect',
        terminalAt: input.now,
        terminalReason: reason,
        resultHash: null,
      },
    },
  };
}

export function settleTicketTransition(
  state: SafeCodingKernelState,
  input: SettleKernelTicketInput,
): SafeCodingKernelState {
  const nowMs = timestampMilliseconds(
    input.now,
    'Ticket settlement time',
    'ticket-invalid',
  );
  const record = ownValue(state.tickets, input.ticketId);
  if (!record) {
    throw kernelError(
      'ticket-not-found',
      `Execution ticket ${input.ticketId} is not registered`,
    );
  }
  if (record.status !== 'commit-permit') {
    if (record.status === 'registered') {
      throw kernelError(
        'ticket-not-executable',
        `Execution ticket ${input.ticketId} has no commit permit`,
      );
    }
    throw kernelError(
      'ticket-terminal',
      `Execution ticket ${input.ticketId} is already terminal`,
    );
  }
  if (!isSettlementStatus(input.status)) {
    throw kernelError('ticket-invalid', 'Ticket settlement status is invalid');
  }
  const permittedAt = record.commitPermittedAt;
  if (
    permittedAt === null ||
    nowMs <
      timestampMilliseconds(permittedAt, 'Commit-permit time', 'ticket-invalid')
  ) {
    throw kernelError(
      'ticket-invalid',
      'Ticket settlement cannot precede its commit permit',
    );
  }
  const resultHash = optionalDigest(input.resultHash, 'Ticket result hash');
  const reason = optionalReason(input.reason, null);
  const nextRecord: KernelTicketRecord = {
    ...record,
    status: input.status,
    terminalAt: input.now,
    terminalReason: reason,
    resultHash,
  };

  return {
    ...state,
    tickets: {
      ...state.tickets,
      [input.ticketId]: nextRecord,
    },
  };
}

function validateVerifiedContract(input: ActivateKernelContractInput): {
  readonly contract: SafeCodingIntentContract;
  readonly contractHash: string;
} {
  try {
    const contract = validateSafeCodingIntentContract(
      input.verifiedContract.contract,
    );
    const canonicalPayload = canonicalizeJson(contract);
    if (canonicalPayload !== input.verifiedContract.canonicalPayload) {
      throw kernelError(
        'contract-invalid',
        'Verified contract canonical bytes do not match its contract value',
      );
    }
    const contractHash = input.verifiedContract.contractHash;
    if (!SHA256_PATTERN.test(contractHash)) {
      throw kernelError(
        'contract-invalid',
        'Verified contract hash must be a lowercase SHA-256 digest',
      );
    }
    return { contract, contractHash };
  } catch (error) {
    throw asKernelError(error, 'contract-invalid');
  }
}

function validatedTicket(value: unknown): SafeCodingExecutionTicket {
  try {
    return validateSafeCodingExecutionTicket(value);
  } catch (error) {
    throw asKernelError(error, 'ticket-invalid');
  }
}

function currentRevision(
  lineage: KernelContractLineage,
): KernelContractRevisionRecord {
  for (let index = lineage.revisions.length - 1; index >= 0; index -= 1) {
    const revision = lineage.revisions[index];
    if (revision?.contractHash === lineage.currentContractHash) return revision;
  }
  throw kernelError(
    'contract-not-found',
    `Contract lineage ${lineage.contractId} has no current revision record`,
  );
}

function assertCasMatches(
  lineage: KernelContractLineage,
  current: KernelContractRevisionRecord,
  expected: KernelContractCasExpectation,
): void {
  if (
    expected.contractHash !== current.contractHash ||
    expected.revision !== current.revision ||
    expected.revocationEpoch !== lineage.revocationEpoch
  ) {
    throw kernelError(
      'contract-cas-mismatch',
      'Contract state changed since the supplied CAS expectation',
    );
  }
}

function assertActiveSnapshotMatches(
  lineage: KernelContractLineage,
  current: KernelContractRevisionRecord,
  expected: KernelActiveContractSnapshot,
): void {
  if (
    expected.contractId !== lineage.contractId ||
    expected.contractHash !== current.contractHash ||
    expected.revision !== current.revision ||
    expected.revocationEpoch !== lineage.revocationEpoch ||
    expected.status !== current.status ||
    expected.status !== 'active'
  ) {
    throw kernelError(
      'contract-cas-mismatch',
      'Active contract state changed before ticket registration',
    );
  }
}

function assertContractUsableAt(
  contract: SafeCodingIntentContract,
  nowMs: number,
): void {
  const notBeforeMs = timestampMilliseconds(
    contract.validity.notBefore,
    'Contract notBefore',
    'contract-invalid',
  );
  const expiresAtMs = timestampMilliseconds(
    contract.validity.expiresAt,
    'Contract expiresAt',
    'contract-invalid',
  );
  if (nowMs < notBeforeMs || nowMs >= expiresAtMs) {
    throw kernelError(
      'contract-not-active',
      'Contract is outside its authorized validity interval',
    );
  }
}

function assertTicketBindsContract(
  ticket: SafeCodingExecutionTicket,
  current: KernelContractRevisionRecord,
  revocationEpoch: number,
): void {
  const contract = current.contract;
  if (
    ticket.contractHash !== current.contractHash ||
    ticket.contractRevision !== current.revision ||
    ticket.revocationEpoch !== revocationEpoch ||
    canonicalizeJson(ticket.subject) !== canonicalizeJson(contract.subject) ||
    canonicalizeJson(ticket.audience) !== canonicalizeJson(contract.audience) ||
    ticket.policyDigest !== contract.bindings.policyDigest ||
    ticket.registryDigest !== contract.bindings.adapterRegistryDigest ||
    ticket.runnerRegistryDigest !== contract.bindings.runnerRegistryDigest ||
    ticket.effectRegistryDigest !== contract.bindings.effectRegistryDigest ||
    !contract.authority.allowedEffectClasses.includes(ticket.effectClass)
  ) {
    throw kernelError(
      'ticket-stale',
      'Execution ticket is not bound to the exact active contract authority',
    );
  }
}

function assertTicketTimeWindow(
  ticket: SafeCodingExecutionTicket,
  contract: SafeCodingIntentContract,
  nowMs: number,
): void {
  const issuedAtMs = timestampMilliseconds(
    ticket.issuedAt,
    'Ticket issuedAt',
    'ticket-invalid',
  );
  const expiresAtMs = timestampMilliseconds(
    ticket.expiresAt,
    'Ticket expiresAt',
    'ticket-invalid',
  );
  const contractNotBeforeMs = timestampMilliseconds(
    contract.validity.notBefore,
    'Contract notBefore',
    'contract-invalid',
  );
  const contractExpiresAtMs = timestampMilliseconds(
    contract.validity.expiresAt,
    'Contract expiresAt',
    'contract-invalid',
  );
  if (
    issuedAtMs < contractNotBeforeMs ||
    issuedAtMs > nowMs ||
    expiresAtMs > contractExpiresAtMs
  ) {
    throw kernelError(
      'ticket-invalid',
      'Execution ticket lies outside the active contract time window',
    );
  }
  if (nowMs >= expiresAtMs) {
    throw kernelError(
      'ticket-expired',
      'Execution ticket expired before it could be registered',
    );
  }
}

function assertLimitsMatch(
  supplied: SafeCodingIntentContract['authority']['limits'],
  authoritative: SafeCodingIntentContract['authority']['limits'],
): void {
  if (
    !supplied ||
    supplied.maxUniqueModifiedFiles !== authoritative.maxUniqueModifiedFiles ||
    supplied.maxMutationBytes !== authoritative.maxMutationBytes ||
    supplied.maxTestRuns !== authoritative.maxTestRuns
  ) {
    throw kernelError(
      'contract-cas-mismatch',
      'Ticket registration limits do not match the active contract',
    );
  }
}

function validatedCharge(charge: KernelBudgetCharge): KernelBudgetCharge {
  if (
    !charge ||
    !Number.isSafeInteger(charge.uniqueModifiedFiles) ||
    (charge.uniqueModifiedFiles !== 0 && charge.uniqueModifiedFiles !== 1) ||
    !Number.isSafeInteger(charge.mutationBytes) ||
    charge.mutationBytes < 0 ||
    !Number.isSafeInteger(charge.testRuns) ||
    charge.testRuns < 0
  ) {
    throw kernelError(
      'ticket-invalid',
      'Ticket budget charge must contain non-negative safe integers and at most one resolved object',
    );
  }
  return {
    uniqueModifiedFiles: charge.uniqueModifiedFiles,
    mutationBytes: charge.mutationBytes,
    testRuns: charge.testRuns,
  };
}

function ticketMatchesActiveLineage(
  ticket: SafeCodingExecutionTicket,
  lineage: KernelContractLineage,
  nowMs: number,
): boolean {
  let current: KernelContractRevisionRecord;
  try {
    current = currentRevision(lineage);
  } catch {
    return false;
  }
  if (
    current.status !== 'active' ||
    ticket.contractHash !== current.contractHash ||
    ticket.contractRevision !== current.revision ||
    ticket.revocationEpoch !== lineage.revocationEpoch
  ) {
    return false;
  }
  const notBeforeMs = timestampMilliseconds(
    current.contract.validity.notBefore,
    'Contract notBefore',
    'contract-invalid',
  );
  const expiresAtMs = timestampMilliseconds(
    current.contract.validity.expiresAt,
    'Contract expiresAt',
    'contract-invalid',
  );
  return nowMs >= notBeforeMs && nowMs < expiresAtMs;
}

function failRegisteredTickets(
  tickets: SafeCodingKernelState['tickets'],
  contractId: string,
  now: string,
  reason: string,
): SafeCodingKernelState['tickets'] {
  let changed = false;
  const nextTickets: Record<string, KernelTicketRecord> = {};
  for (const [ticketId, record] of Object.entries(tickets)) {
    if (record.contractId === contractId && record.status === 'registered') {
      changed = true;
      nextTickets[ticketId] = {
        ...record,
        status: 'failed-no-effect',
        terminalAt: now,
        terminalReason: reason,
        resultHash: null,
      };
    } else {
      nextTickets[ticketId] = record;
    }
  }
  return changed ? nextTickets : tickets;
}

function terminalCommitFailure(
  state: SafeCodingKernelState,
  record: KernelTicketRecord,
  now: string,
  error: SafeCodingKernelError,
): CommitPermitTransitionFailure {
  const nextRecord: KernelTicketRecord = {
    ...record,
    status: 'failed-no-effect',
    terminalAt: now,
    terminalReason: error.message,
    resultHash: null,
  };
  return {
    ok: false,
    state: {
      ...state,
      tickets: {
        ...state.tickets,
        [record.ticket.ticketId]: nextRecord,
      },
    },
    error,
  };
}

function commitFailure(
  state: SafeCodingKernelState,
  error: SafeCodingKernelError,
): CommitPermitTransitionFailure {
  return { ok: false, state, error };
}

function sameTicket(
  stored: SafeCodingExecutionTicket,
  supplied: SafeCodingExecutionTicket,
): boolean {
  try {
    return canonicalizeJson(stored) === canonicalizeJson(supplied);
  } catch {
    return false;
  }
}

function isSettlementStatus(
  value: unknown,
): value is SettleKernelTicketInput['status'] {
  return (
    value === 'failed-no-effect' ||
    value === 'committed' ||
    value === 'result-unavailable' ||
    value === 'uncertain'
  );
}

function optionalDigest(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (!SHA256_PATTERN.test(value)) {
    throw kernelError(
      'ticket-invalid',
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

function optionalReason(
  value: string | null | undefined,
  fallback: string | null,
  code: SafeCodingKernelErrorCode = 'ticket-invalid',
): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw kernelError(
      code,
      'Transition reason must be a non-empty bounded string',
    );
  }
  try {
    canonicalizeJson(value);
  } catch {
    throw kernelError(
      code,
      'Transition reason must be a canonical JSON string',
    );
  }
  return value;
}

function timestampMilliseconds(
  value: string,
  label: string,
  code: SafeCodingKernelErrorCode,
): number {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw kernelError(code, `${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw kernelError(code, `${label} must be a real timestamp`);
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== value) {
    throw kernelError(code, `${label} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function safeIncrement(
  value: number,
  code: SafeCodingKernelErrorCode,
  message: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value === Number.MAX_SAFE_INTEGER
  ) {
    throw kernelError(code, message);
  }
  return value + 1;
}

function safeAddBudget(left: number, right: number, message: string): number {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(result)
  ) {
    throw kernelError('budget-exhausted', message);
  }
  return result;
}

function assertNotBefore(
  value: number,
  lowerBound: number,
  code: SafeCodingKernelErrorCode,
  message: string,
): void {
  if (value < lowerBound) throw kernelError(code, message);
}

function hasOwn<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): boolean {
  return Object.hasOwn(record, key);
}

function ownValue<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Value | undefined {
  return hasOwn(record, key) ? record[key] : undefined;
}

function kernelError(
  code: SafeCodingKernelErrorCode,
  message: string,
): SafeCodingKernelError {
  return new SafeCodingKernelError(code, message);
}

function asKernelError(
  error: unknown,
  fallbackCode: SafeCodingKernelErrorCode,
): SafeCodingKernelError {
  if (error instanceof SafeCodingKernelError) return error;
  return kernelError(
    fallbackCode,
    error instanceof Error
      ? error.message
      : 'Safe-coding kernel validation failed',
  );
}
