import { canonicalizeJson, encodeBase64Url } from '@clodex/contracts';
import type {
  SafeCodingExecutionTicket,
  SafeCodingIntentContract,
  VerifiedIntentContract,
} from '@clodex/contracts';
import { describe, expect, it } from 'vitest';
import { InMemorySafeCodingKernel } from './in-memory-kernel.js';
import {
  SafeCodingKernelError,
  createEmptySafeCodingKernelState,
  type KernelActiveContractSnapshot,
  type KernelBudgetCharge,
  type SafeCodingKernelErrorCode,
  type SafeCodingKernelState,
} from './state.js';
import {
  activateContractTransition,
  commitPermitTransition,
  failBeforeCommitTransition,
  registerTicketTransition,
  revokeContractTransition,
  settleTicketTransition,
} from './transitions.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const CONTRACT_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_NOW = '2026-07-14T00:10:00Z';

class MutableClock {
  public constructor(public current = DEFAULT_NOW) {}

  public now(): string {
    return this.current;
  }
}

function createContract(
  revision = 1,
  previousRevisionHash: string | null = null,
  limits: SafeCodingIntentContract['authority']['limits'] = {
    maxUniqueModifiedFiles: 10,
    maxMutationBytes: 10_000,
    maxTestRuns: 10,
  },
): SafeCodingIntentContract {
  return {
    kind: 'clodex.intent-contract',
    specVersion: '1.0.0',
    contractId: CONTRACT_ID,
    revision,
    previousRevisionHash,
    issuedAt: '2026-07-14T00:00:00Z',
    validity: {
      notBefore: '2026-07-14T00:00:00Z',
      expiresAt: '2026-07-14T02:00:00Z',
    },
    subject: { principalId: 'agent:one', instanceId: 'runtime:one' },
    audience: {
      guardianId: 'guardian:local',
      executorId: 'executor:sandbox',
      runtimeEpoch: 7,
      taskId: 'task:kernel',
      workspaceId: 'workspace:kernel',
    },
    bindings: {
      policyDigest: HASH_A,
      adapterRegistryDigest: HASH_B,
      runnerRegistryDigest: HASH_C,
      effectRegistryDigest: HASH_D,
      approvalRendererVersion: 'renderer:1',
    },
    authority: {
      filesystem: [
        {
          action: 'filesystem.replace',
          selector: { kind: 'file', path: 'src/example.ts' },
        },
      ],
      git: [{ action: 'git.diff' }, { action: 'git.status' }],
      testProfiles: ['tests.unit'],
      allowedEffectClasses: [
        'local.observation',
        'local.reversible',
        'sandbox.ephemeral',
      ],
      limits,
      ambientAuthority: {
        network: false,
        secrets: false,
        shell: false,
        delete: false,
        gitCommit: false,
        gitPush: false,
      },
      delegation: { allowed: false, maxDepth: 0 },
    },
    nonAuthoritative: { goalLabel: 'Kernel invariant test', notes: [] },
  };
}

function verified(
  contract = createContract(),
  contractHash = HASH_A,
): VerifiedIntentContract {
  return {
    contract,
    canonicalPayload: canonicalizeJson(contract),
    contractHash,
    signerKeyId: 'human:key',
    signerRole: 'human-authorizer',
    signer: {
      keyId: 'human:key',
      role: 'human-authorizer',
      trustEpoch: 1,
      registryDigest: HASH_E,
    },
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function createTicket(
  active: KernelActiveContractSnapshot,
  contract: SafeCodingIntentContract,
  index: number,
  overrides: Partial<SafeCodingExecutionTicket> = {},
): SafeCodingExecutionTicket {
  return {
    kind: 'clodex.execution-ticket',
    specVersion: '1.0.0',
    ticketId: uuid(100 + index),
    requestId: `request:${index}`,
    contractHash: active.contractHash,
    contractRevision: active.revision,
    subject: { ...contract.subject },
    audience: { ...contract.audience },
    actionHash: HASH_A,
    argumentsHash: HASH_B,
    resolvedObjectId: `object:file:${index}`,
    stateCommitmentHash: HASH_C,
    adapterId: 'adapter:safe-file',
    adapterDigest: HASH_D,
    policyDigest: contract.bindings.policyDigest,
    registryDigest: contract.bindings.adapterRegistryDigest,
    runnerRegistryDigest: contract.bindings.runnerRegistryDigest,
    effectRegistryDigest: contract.bindings.effectRegistryDigest,
    effectClass: 'local.reversible',
    revocationEpoch: active.revocationEpoch,
    budgetReservationId: `reservation:${index}`,
    nonce: encodeBase64Url(new Uint8Array(16).fill(index)),
    issuedAt: DEFAULT_NOW,
    expiresAt: '2026-07-14T00:20:00Z',
    ...overrides,
  };
}

function activate(limits?: SafeCodingIntentContract['authority']['limits']): {
  active: KernelActiveContractSnapshot;
  clock: MutableClock;
  contract: SafeCodingIntentContract;
  kernel: InMemorySafeCodingKernel;
} {
  const clock = new MutableClock();
  const kernel = new InMemorySafeCodingKernel({ clock });
  const contract = createContract(1, null, limits);
  const active = kernel.activateContract({
    verifiedContract: verified(contract),
    expectedPrevious: null,
  });
  return { active, clock, contract, kernel };
}

function registration(
  ticket: SafeCodingExecutionTicket,
  active: KernelActiveContractSnapshot,
  contract: SafeCodingIntentContract,
  charge: KernelBudgetCharge,
) {
  return {
    ticket,
    expectedActive: active,
    limits: contract.authority.limits,
    charge,
  };
}

function expectKernelError(
  operation: () => unknown,
  code: SafeCodingKernelErrorCode,
): SafeCodingKernelError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SafeCodingKernelError);
    expect((error as SafeCodingKernelError).code).toBe(code);
    return error as SafeCodingKernelError;
  }
  throw new Error(`Expected SafeCodingKernelError(${code})`);
}

describe('Safe Coding kernel ordering and replay invariants', () => {
  it('makes revoke-before-COMMIT_PERMIT a terminal failed-no-effect outcome', () => {
    const { active, contract, kernel } = activate();
    const ticket = createTicket(active, contract, 1);
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 1,
        mutationBytes: 10,
        testRuns: 0,
      }),
    );

    const revoked = kernel.revokeContract({
      contractId: CONTRACT_ID,
      expectedActive: active,
      reason: 'operator-revoked',
    });

    expect(revoked).toMatchObject({
      status: 'revoked',
      revocationEpoch: active.revocationEpoch + 1,
    });
    expect(kernel.getTicket(ticket.ticketId)).toMatchObject({
      status: 'failed-no-effect',
      terminalReason: 'operator-revoked',
    });
    expectKernelError(() => kernel.commitPermit(ticket), 'ticket-terminal');
  });

  it('allows commit-before-revoke to settle exactly once', () => {
    const { active, contract, kernel } = activate();
    const ticket = createTicket(active, contract, 2);
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 1,
        mutationBytes: 10,
        testRuns: 0,
      }),
    );

    const permit = kernel.commitPermit(ticket);
    expectKernelError(
      () => kernel.commitPermit(ticket),
      'ticket-not-executable',
    );
    kernel.revokeContract({
      contractId: CONTRACT_ID,
      expectedActive: active,
      reason: 'late-revoke',
    });

    expect(permit).toMatchObject({
      ticketId: ticket.ticketId,
      requestId: ticket.requestId,
      permittedAt: DEFAULT_NOW,
    });
    expect(kernel.getTicket(ticket.ticketId)?.status).toBe('commit-permit');
    expect(
      kernel.settleTicket({
        ticketId: ticket.ticketId,
        status: 'committed',
        resultHash: HASH_E,
      }),
    ).toMatchObject({ status: 'committed', resultHash: HASH_E });
    expectKernelError(
      () =>
        kernel.settleTicket({
          ticketId: ticket.ticketId,
          status: 'uncertain',
          reason: 'must-not-reopen',
        }),
      'ticket-terminal',
    );
  });

  it('rejects ticket, request, and reservation replay atomically', () => {
    const { active, contract, kernel } = activate();
    const first = createTicket(active, contract, 3);
    const charge = {
      uniqueModifiedFiles: 1,
      mutationBytes: 10,
      testRuns: 0,
    } as const;
    kernel.registerTicket(registration(first, active, contract, charge));

    expectKernelError(
      () =>
        kernel.registerTicket(registration(first, active, contract, charge)),
      'ticket-replay',
    );

    const requestReplay = createTicket(active, contract, 4, {
      requestId: first.requestId,
    });
    expectKernelError(
      () =>
        kernel.registerTicket(
          registration(requestReplay, active, contract, charge),
        ),
      'request-replay',
    );

    const reservationReplay = createTicket(active, contract, 5, {
      budgetReservationId: first.budgetReservationId,
    });
    expectKernelError(
      () =>
        kernel.registerTicket(
          registration(reservationReplay, active, contract, charge),
        ),
      'reservation-replay',
    );

    expect(kernel.snapshot().tickets).toEqual({
      [first.ticketId]: expect.any(Object),
    });
    expect(kernel.getBudget(CONTRACT_ID)).toEqual({
      modifiedObjectIds: [first.resolvedObjectId],
      mutationBytes: 10,
      testRuns: 0,
    });
  });

  it('closes adapter-readiness failure only before COMMIT_PERMIT', () => {
    const { active, contract, kernel } = activate();
    const ticket = createTicket(active, contract, 6);
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 1,
        mutationBytes: 10,
        testRuns: 0,
      }),
    );
    const budgetBefore = kernel.getBudget(CONTRACT_ID);

    expectKernelError(
      () =>
        kernel.settleTicket({
          ticketId: ticket.ticketId,
          status: 'failed-no-effect',
          reason: 'generic-settlement-must-not-close-registered',
        }),
      'ticket-not-executable',
    );

    const registeredBeforeInvalidReason = kernel.snapshot();
    expectKernelError(
      () => kernel.failBeforeCommit(ticket.ticketId, 'e\u0301'),
      'ticket-invalid',
    );
    expect(kernel.snapshot()).toEqual(registeredBeforeInvalidReason);

    expect(
      kernel.failBeforeCommit(ticket.ticketId, 'adapter-readiness-failed'),
    ).toMatchObject({
      status: 'failed-no-effect',
      terminalReason: 'adapter-readiness-failed',
    });
    expect(kernel.getBudget(CONTRACT_ID)).toEqual(budgetBefore);
    expect(kernel.snapshot().requestIds[ticket.requestId]).toBe(
      ticket.ticketId,
    );
    expect(kernel.snapshot().reservationIds[ticket.budgetReservationId]).toBe(
      ticket.ticketId,
    );
    expectKernelError(() => kernel.commitPermit(ticket), 'ticket-terminal');
    expectKernelError(
      () => kernel.failBeforeCommit(ticket.ticketId, 'must-not-reopen'),
      'ticket-terminal',
    );
  });
});

describe('Safe Coding kernel aggregate budgets', () => {
  it('deduplicates modified object identity and rejects the next unique file', () => {
    const { active, contract, kernel } = activate({
      maxUniqueModifiedFiles: 1,
      maxMutationBytes: 1_000,
      maxTestRuns: 10,
    });
    const first = createTicket(active, contract, 10, {
      resolvedObjectId: 'object:file:shared',
    });
    const sameObject = createTicket(active, contract, 11, {
      resolvedObjectId: first.resolvedObjectId,
    });
    const differentObject = createTicket(active, contract, 12);
    const charge = {
      uniqueModifiedFiles: 1,
      mutationBytes: 1,
      testRuns: 0,
    } as const;

    kernel.registerTicket(registration(first, active, contract, charge));
    kernel.registerTicket(registration(sameObject, active, contract, charge));

    expect(kernel.getTicket(sameObject.ticketId)?.reservedCharge).toEqual({
      uniqueModifiedFiles: 0,
      mutationBytes: 1,
      testRuns: 0,
    });
    expect(kernel.getBudget(CONTRACT_ID)?.modifiedObjectIds).toEqual([
      first.resolvedObjectId,
    ]);
    expectKernelError(
      () =>
        kernel.registerTicket(
          registration(differentObject, active, contract, charge),
        ),
      'budget-exhausted',
    );
    expect(kernel.getTicket(differentObject.ticketId)).toBeNull();
  });

  it('conservatively exhausts mutation-byte reservations', () => {
    const { active, contract, kernel } = activate({
      maxUniqueModifiedFiles: 10,
      maxMutationBytes: 5,
      maxTestRuns: 10,
    });
    const first = createTicket(active, contract, 20);
    const second = createTicket(active, contract, 21);

    kernel.registerTicket(
      registration(first, active, contract, {
        uniqueModifiedFiles: 0,
        mutationBytes: 3,
        testRuns: 0,
      }),
    );
    expectKernelError(
      () =>
        kernel.registerTicket(
          registration(second, active, contract, {
            uniqueModifiedFiles: 0,
            mutationBytes: 3,
            testRuns: 0,
          }),
        ),
      'budget-exhausted',
    );
    expect(kernel.getBudget(CONTRACT_ID)?.mutationBytes).toBe(3);
  });

  it('conservatively exhausts test-run reservations', () => {
    const { active, contract, kernel } = activate({
      maxUniqueModifiedFiles: 10,
      maxMutationBytes: 1_000,
      maxTestRuns: 1,
    });
    const first = createTicket(active, contract, 30);
    const second = createTicket(active, contract, 31);

    kernel.registerTicket(
      registration(first, active, contract, {
        uniqueModifiedFiles: 0,
        mutationBytes: 0,
        testRuns: 1,
      }),
    );
    expectKernelError(
      () =>
        kernel.registerTicket(
          registration(second, active, contract, {
            uniqueModifiedFiles: 0,
            mutationBytes: 0,
            testRuns: 1,
          }),
        ),
      'budget-exhausted',
    );
    expect(kernel.getBudget(CONTRACT_ID)?.testRuns).toBe(1);
  });
});

describe('Safe Coding kernel revision, expiry, and closure invariants', () => {
  it('requires exact revision CAS, preserves budgets, and invalidates old registrations', () => {
    const { active, contract, kernel } = activate();
    const ticket = createTicket(active, contract, 40);
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 1,
        mutationBytes: 7,
        testRuns: 0,
      }),
    );
    const revision2 = createContract(2, HASH_A, contract.authority.limits);

    expectKernelError(
      () =>
        kernel.activateContract({
          verifiedContract: verified(revision2, HASH_B),
          expectedPrevious: { ...active, contractHash: HASH_E },
        }),
      'contract-cas-mismatch',
    );
    expect(kernel.getActiveContract(CONTRACT_ID)).toEqual(active);

    const next = kernel.activateContract({
      verifiedContract: verified(revision2, HASH_B),
      expectedPrevious: active,
    });
    expect(next).toMatchObject({
      contractHash: HASH_B,
      revision: 2,
      revocationEpoch: active.revocationEpoch + 1,
      status: 'active',
    });
    expect(kernel.getTicket(ticket.ticketId)?.status).toBe('failed-no-effect');
    expect(kernel.getBudget(CONTRACT_ID)).toMatchObject({
      modifiedObjectIds: [ticket.resolvedObjectId],
      mutationBytes: 7,
    });

    kernel.revokeContract({
      contractId: CONTRACT_ID,
      expectedActive: next,
      reason: 'lineage-closed',
    });
    const revision3 = createContract(3, HASH_B, contract.authority.limits);
    expectKernelError(
      () =>
        kernel.activateContract({
          verifiedContract: verified(revision3, HASH_C),
          expectedPrevious: next,
        }),
      'contract-revoked',
    );
  });

  it('terminalizes an expired ticket while returning a typed error', () => {
    const { active, clock, contract, kernel } = activate();
    const ticket = createTicket(active, contract, 50, {
      expiresAt: '2026-07-14T00:11:00Z',
    });
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 0,
        mutationBytes: 0,
        testRuns: 0,
      }),
    );
    clock.current = ticket.expiresAt;

    expectKernelError(() => kernel.commitPermit(ticket), 'ticket-expired');
    expect(kernel.getTicket(ticket.ticketId)).toMatchObject({
      status: 'failed-no-effect',
      terminalAt: ticket.expiresAt,
    });
    expectKernelError(() => kernel.commitPermit(ticket), 'ticket-terminal');
  });

  it('terminalizes a stale registered ticket while returning a typed error', () => {
    const { active, clock, contract, kernel } = activate();
    const ticket = createTicket(active, contract, 60);
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 0,
        mutationBytes: 0,
        testRuns: 0,
      }),
    );
    const state = kernel.exportState();
    const lineage = state.lineages[CONTRACT_ID]!;
    const staleState: SafeCodingKernelState = {
      ...state,
      lineages: {
        ...state.lineages,
        [CONTRACT_ID]: {
          ...lineage,
          revocationEpoch: lineage.revocationEpoch + 1,
        },
      },
    };
    const staleKernel = new InMemorySafeCodingKernel({
      clock,
      initialState: staleState,
    });

    expectKernelError(() => staleKernel.commitPermit(ticket), 'ticket-stale');
    expect(staleKernel.getTicket(ticket.ticketId)?.status).toBe(
      'failed-no-effect',
    );
  });

  it.each([
    'result-unavailable',
    'uncertain',
  ] as const)('keeps %s consumed and never creates implicit retry authority', (status) => {
    const { active, contract, kernel } = activate();
    const index = status === 'uncertain' ? 71 : 70;
    const ticket = createTicket(active, contract, index);
    kernel.registerTicket(
      registration(ticket, active, contract, {
        uniqueModifiedFiles: 0,
        mutationBytes: 0,
        testRuns: 0,
      }),
    );
    kernel.commitPermit(ticket);
    kernel.settleTicket({
      ticketId: ticket.ticketId,
      status,
      reason: `terminal:${status}`,
    });

    expect(kernel.getTicket(ticket.ticketId)).toMatchObject({
      status,
      terminalReason: `terminal:${status}`,
    });
    expectKernelError(() => kernel.commitPermit(ticket), 'ticket-terminal');
    expectKernelError(
      () =>
        kernel.settleTicket({
          ticketId: ticket.ticketId,
          status: 'failed-no-effect',
          reason: 'retry-forbidden',
        }),
      'ticket-terminal',
    );
  });
});

describe('pure transition boundary', () => {
  it('returns new immutable state graphs without mutating any input snapshot', () => {
    const contract = createContract();
    const empty = createEmptySafeCodingKernelState();
    const emptyBefore = clone(empty);
    const activated = activateContractTransition(empty, {
      verifiedContract: verified(contract),
      expectedPrevious: null,
      now: DEFAULT_NOW,
    });
    expect(empty).toEqual(emptyBefore);
    expect(activated).not.toBe(empty);

    const active: KernelActiveContractSnapshot = {
      contractId: CONTRACT_ID,
      contractHash: HASH_A,
      revision: 1,
      revocationEpoch: 0,
      status: 'active',
    };
    const ticket = createTicket(active, contract, 80);
    const activatedBefore = clone(activated);
    const registered = registerTicketTransition(activated, {
      ...registration(ticket, active, contract, {
        uniqueModifiedFiles: 1,
        mutationBytes: 4,
        testRuns: 0,
      }),
      now: DEFAULT_NOW,
    });
    expect(activated).toEqual(activatedBefore);

    const registeredBefore = clone(registered);
    const failed = failBeforeCommitTransition(registered, {
      ticketId: ticket.ticketId,
      reason: 'pure-transition-check',
      now: DEFAULT_NOW,
    });
    expect(registered).toEqual(registeredBefore);
    expect(failed).not.toBe(registered);

    const permitOutcome = commitPermitTransition(registered, {
      ticket,
      now: DEFAULT_NOW,
    });
    expect(registered).toEqual(registeredBefore);
    expect(permitOutcome.ok).toBe(true);
    if (!permitOutcome.ok) throw permitOutcome.error;

    const permittedBefore = clone(permitOutcome.state);
    const settled = settleTicketTransition(permitOutcome.state, {
      ticketId: ticket.ticketId,
      status: 'committed',
      resultHash: HASH_E,
      now: DEFAULT_NOW,
    });
    expect(permitOutcome.state).toEqual(permittedBefore);

    const settledBefore = clone(settled);
    const revoked = revokeContractTransition(settled, {
      contractId: CONTRACT_ID,
      expectedActive: active,
      now: DEFAULT_NOW,
      reason: 'test-complete',
    });
    expect(settled).toEqual(settledBefore);
    expect(revoked).not.toBe(settled);
  });
});

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}
