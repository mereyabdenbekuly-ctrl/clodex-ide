import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  encodeBase64Url,
  type SafeCodingAttestationStatus,
  type SafeCodingEffectAttestation,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';
import { InMemorySafeCodingLedgerStore } from './in-memory-store.js';
import { SafeCodingEffectLedger } from './ledger.js';
import { IN_MEMORY_SAFE_CODING_LEDGER_DURABILITY } from './in-memory-store.js';
import {
  SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_KIND,
  SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_VERSION,
  SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH,
  safeCodingLedgerIdentityKeys,
  validateSafeCodingLedgerRecord,
  type SafeCodingEvidenceAdmissionReceipt,
  type SafeCodingEvidenceExpectation,
  type SafeCodingLedgerRecord,
} from './records.js';
import { classifySafeCodingLedgerRecovery } from './recovery.js';
import type {
  SafeCodingLedgerPersistenceMutation,
  SafeCodingLedgerPersistenceTransactionPort,
} from './persistence.js';
import { validateSafeCodingLedgerPersistenceCasResult } from './persistence.js';
import {
  assertSafeCodingLedgerSuccessor,
  closeSafeCodingLedgerCommitted,
  closeSafeCodingLedgerFailedPreEffect,
  closeSafeCodingLedgerResultUnavailable,
  closeSafeCodingLedgerUncertain,
  createPreparedSafeCodingLedgerRecord,
  markSafeCodingLedgerEvidenceAdmitted,
  recordSafeCodingCommitPermit,
  verifySafeCodingEvidenceAdmissionReceipt,
} from './transitions.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const PREPARED_AT = '2026-07-14T00:01:00Z';
const PERMITTED_AT = '2026-07-14T00:02:00Z';
const TERMINAL_AT = '2026-07-14T00:03:00Z';
const ADMITTED_AT = '2026-07-14T00:04:00Z';

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function ticketFixture(index = 1): SafeCodingExecutionTicket {
  return {
    kind: 'clodex.execution-ticket',
    specVersion: '1.0.0',
    ticketId: uuid(index),
    requestId: `request:${index}`,
    contractHash: HASH_A,
    contractRevision: 1,
    subject: { principalId: 'agent:one', instanceId: 'runtime:one' },
    audience: {
      guardianId: 'guardian:local',
      executorId: 'executor:sandbox',
      runtimeEpoch: 1,
      taskId: 'task:one',
      workspaceId: 'workspace:one',
    },
    actionHash: HASH_B,
    argumentsHash: HASH_C,
    resolvedObjectId: `object:${index}`,
    stateCommitmentHash: HASH_D,
    adapterId: 'adapter:safe-file',
    adapterDigest: HASH_E,
    policyDigest: HASH_A,
    registryDigest: HASH_B,
    runnerRegistryDigest: HASH_C,
    effectRegistryDigest: HASH_D,
    effectClass: 'local.reversible',
    revocationEpoch: 0,
    budgetReservationId: `reservation:${index}`,
    nonce: nonceFixture(index),
    issuedAt: '2026-07-14T00:00:00Z',
    expiresAt: '2026-07-14T00:10:00Z',
  };
}

function nonceFixture(index: number): string {
  const bytes = new Uint8Array(16);
  bytes[12] = (index >>> 24) & 0xff;
  bytes[13] = (index >>> 16) & 0xff;
  bytes[14] = (index >>> 8) & 0xff;
  bytes[15] = index & 0xff;
  return encodeBase64Url(bytes);
}

function attestationFixture(input: {
  ticket?: SafeCodingExecutionTicket;
  attestationId?: string;
  status: SafeCodingAttestationStatus;
  finishedAt?: string;
  resultHash?: string | null;
  effectCompletionObserved?: boolean;
}): SafeCodingEffectAttestation {
  const ticket = input.ticket ?? ticketFixture();
  const expectation = evidenceExpectationFixture(ticket);
  const noEffect =
    input.status === 'failed_no_effect' ||
    (input.status === 'uncertain' && !input.effectCompletionObserved);
  return {
    kind: 'clodex.effect-attestation',
    specVersion: '1.0.0',
    attestationId: input.attestationId ?? uuid(10_001),
    requestId: ticket.requestId,
    ticketId: ticket.ticketId,
    contractHash: ticket.contractHash,
    contractRevision: ticket.contractRevision,
    actionHash: ticket.actionHash,
    delegationLineageHash: expectation.delegationLineageHash,
    adapterId: ticket.adapterId,
    adapterDigest: ticket.adapterDigest,
    runnerId: expectation.runnerId,
    runnerDigest: expectation.runnerDigest,
    executorId: ticket.audience.executorId,
    observerId: expectation.observerId,
    effectClass: ticket.effectClass,
    registryDigest: ticket.registryDigest,
    revocationEpoch: ticket.revocationEpoch,
    preStateHash: expectation.preStateHash,
    postStateHash: noEffect ? null : expectation.completionPostStateHash,
    idempotencyKey: expectation.idempotencyKey,
    resultHash: input.resultHash ?? null,
    budgetCharges: noEffect
      ? { uniqueModifiedFiles: 0, mutationBytes: 0, testRuns: 0 }
      : expectation.completionBudgetCharges,
    startedAt: PREPARED_AT,
    finishedAt: input.finishedAt ?? TERMINAL_AT,
    status: input.status,
    evidenceLevel: noEffect
      ? 'attempt_only'
      : expectation.completionEvidenceLevel,
    reconciliationRef: noEffect
      ? null
      : expectation.completionReconciliationRef,
  };
}

function evidenceExpectationFixture(
  _ticket = ticketFixture(),
  overrides: Partial<SafeCodingEvidenceExpectation> = {},
): SafeCodingEvidenceExpectation {
  return {
    delegationLineageHash: HASH_A,
    runnerId: 'runner:recording',
    runnerDigest: HASH_D,
    observerId: 'observer:recording',
    preStateHash: HASH_B,
    completionPostStateHash: HASH_C,
    idempotencyKey: null,
    completionBudgetCharges: {
      uniqueModifiedFiles: 1,
      mutationBytes: 8,
      testRuns: 0,
    },
    completionEvidenceLevel: 'adapter_observed',
    completionReconciliationRef: null,
    ...overrides,
  };
}

function preparedFixture(
  ticket = ticketFixture(),
  index = 1,
): SafeCodingLedgerRecord {
  return createPreparedSafeCodingLedgerRecord({
    ticket,
    attemptId: `attempt:${index}`,
    evidenceIntentId: `evidence:${index}`,
    attestationId: uuid(10_000 + index),
    evidenceExpectation: evidenceExpectationFixture(ticket),
    now: PREPARED_AT,
  });
}

async function verifiedReceiptFixture(
  record: SafeCodingLedgerRecord,
  overrides: Partial<SafeCodingEvidenceAdmissionReceipt> = {},
) {
  return await verifySafeCodingEvidenceAdmissionReceipt(
    receiptFixture(record, overrides),
    {
      verify: () => true,
      assertVerified: () => undefined,
    },
  );
}

function receiptFixture(
  record: SafeCodingLedgerRecord,
  overrides: Partial<SafeCodingEvidenceAdmissionReceipt> = {},
): SafeCodingEvidenceAdmissionReceipt {
  return {
    kind: SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_KIND,
    version: SAFE_CODING_EVIDENCE_ADMISSION_RECEIPT_VERSION,
    transactionId: record.transactionId,
    evidenceIntentId: record.evidenceAdmission.intentId,
    attestationId: record.evidenceAdmission.attestationId,
    attestation: record.evidenceAdmission.attestation!,
    envelopeHash: HASH_A,
    evidenceLedgerId: 'evidence:primary',
    evidenceSequence: 1,
    evidenceHeadHash: HASH_B,
    checkpointPublicationId: 'checkpoint:publication:1',
    checkpointDigest: HASH_C,
    receiptHash: HASH_D,
    admittedAt: ADMITTED_AT,
    ...overrides,
  };
}

function permitFixture(ticket = ticketFixture()) {
  return {
    ticketId: ticket.ticketId,
    requestId: ticket.requestId,
    contractHash: ticket.contractHash,
    contractRevision: ticket.contractRevision,
    revocationEpoch: ticket.revocationEpoch,
    budgetReservationId: ticket.budgetReservationId,
    permittedAt: PERMITTED_AT,
  };
}

function committedFixture(): SafeCodingLedgerRecord {
  const prepared = preparedFixture();
  const permitted = recordSafeCodingCommitPermit(
    prepared,
    permitFixture(prepared.ticketState.ticket),
  );
  return closeSafeCodingLedgerCommitted(permitted, {
    now: TERMINAL_AT,
    resultHash: HASH_F,
    attestation: attestationFixture({
      ticket: prepared.ticketState.ticket,
      attestationId: prepared.evidenceAdmission.attestationId,
      status: 'committed',
      resultHash: HASH_F,
    }),
  });
}

describe('safe-coding ledger records and transitions', () => {
  it('creates one closed PREPARED transaction containing ticket, attempt, and reserved outbox', () => {
    const record = preparedFixture();

    expect(record).toMatchObject({
      transactionId: ticketFixture().ticketId,
      revision: 1,
      ticketState: { status: 'PREPARED', consumedAt: null },
      effectAttempt: { attemptId: 'attempt:1', commitPermittedAt: null },
      evidenceAdmission: {
        intentId: 'evidence:1',
        status: 'RESERVED',
        attestation: null,
      },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.ticketState.ticket)).toBe(true);
  });

  it('advances exact monotonic revisions through permit, terminal outbox, and admission', async () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    const committed = closeSafeCodingLedgerCommitted(permitted, {
      now: TERMINAL_AT,
      resultHash: HASH_F,
      attestation: attestationFixture({
        ticket: prepared.ticketState.ticket,
        attestationId: prepared.evidenceAdmission.attestationId,
        status: 'committed',
        resultHash: HASH_F,
      }),
    });
    const admitted = markSafeCodingLedgerEvidenceAdmitted(committed, {
      receipt: await verifiedReceiptFixture(committed),
    });

    expect(
      [prepared, permitted, committed, admitted].map((entry) => entry.revision),
    ).toEqual([1, 2, 3, 4]);
    expect(committed.ticketState.status).toBe('COMMITTED');
    expect(committed.evidenceAdmission.status).toBe('PENDING');
    expect(committed.evidenceAdmission.attestation?.resultHash).toBe(HASH_F);
    expect(admitted.ticketState.status).toBe('COMMITTED');
    expect(admitted.evidenceAdmission).toMatchObject({
      status: 'ADMITTED',
      admissionReceipt: { receiptHash: HASH_D },
    });
  });

  it('atomically closes PREPARED as FAILED_PRE_EFFECT with its outbox payload', () => {
    const prepared = preparedFixture();
    const failed = closeSafeCodingLedgerFailedPreEffect(prepared, {
      now: TERMINAL_AT,
      reasonCode: 'adapter-prepare-failed',
      attestation: attestationFixture({
        ticket: prepared.ticketState.ticket,
        attestationId: prepared.evidenceAdmission.attestationId,
        status: 'failed_no_effect',
      }),
    });

    expect(failed.ticketState).toMatchObject({
      status: 'FAILED_PRE_EFFECT',
      consumedAt: null,
      terminalReasonCode: 'adapter-prepare-failed',
    });
    expect(failed.evidenceAdmission.status).toBe('PENDING');
    expect(failed.evidenceAdmission.attestation?.status).toBe(
      'failed_no_effect',
    );
  });

  it('models RESULT_UNAVAILABLE and UNCERTAIN without creating retry authority', () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    const unavailable = closeSafeCodingLedgerResultUnavailable(permitted, {
      now: TERMINAL_AT,
      resultHash: null,
      reasonCode: 'result-serialization-failed',
      attestation: attestationFixture({
        ticket: prepared.ticketState.ticket,
        attestationId: prepared.evidenceAdmission.attestationId,
        status: 'committed_result_unavailable',
      }),
    });
    const secondPrepared = preparedFixture(ticketFixture(2), 2);
    const secondPermitted = recordSafeCodingCommitPermit(
      secondPrepared,
      permitFixture(secondPrepared.ticketState.ticket),
    );
    const uncertain = closeSafeCodingLedgerUncertain(secondPermitted, {
      now: TERMINAL_AT,
      resultHash: null,
      reasonCode: 'crash-after-commit-permit',
      effectCompletionObserved: false,
      attestation: attestationFixture({
        ticket: secondPrepared.ticketState.ticket,
        attestationId: secondPrepared.evidenceAdmission.attestationId,
        status: 'uncertain',
      }),
    });

    expect(unavailable.ticketState.status).toBe('RESULT_UNAVAILABLE');
    expect(uncertain.ticketState.status).toBe('UNCERTAIN');
    expect(classifySafeCodingLedgerRecovery(unavailable)).toMatchObject({
      action: 'DELIVER_EVIDENCE_ONLY',
      effectReplayAllowed: false,
      reconciliationRequired: true,
    });
    expect(classifySafeCodingLedgerRecovery(uncertain)).toMatchObject({
      action: 'DELIVER_EVIDENCE_ONLY',
      effectReplayAllowed: false,
      reconciliationRequired: true,
    });
  });

  it('classifies crash recovery deterministically at every boundary', async () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    const committed = committedFixture();
    const admitted = markSafeCodingLedgerEvidenceAdmitted(committed, {
      receipt: await verifiedReceiptFixture(committed),
    });

    expect(classifySafeCodingLedgerRecovery(prepared)).toMatchObject({
      action: 'CLOSE_FAILED_PRE_EFFECT',
      targetState: 'FAILED_PRE_EFFECT',
      effectMayHaveOccurred: false,
      effectReplayAllowed: false,
    });
    expect(classifySafeCodingLedgerRecovery(permitted)).toMatchObject({
      action: 'CLOSE_UNCERTAIN',
      targetState: 'UNCERTAIN',
      effectMayHaveOccurred: true,
      effectReplayAllowed: false,
    });
    expect(classifySafeCodingLedgerRecovery(committed).action).toBe(
      'DELIVER_EVIDENCE_ONLY',
    );
    expect(classifySafeCodingLedgerRecovery(admitted)).toMatchObject({
      action: 'DELIVER_EVIDENCE_ONLY',
      reasonCode: 'terminal-evidence-reverification-required',
      reconciliationRequired: true,
    });
  });

  it('forbids skipped states, post-permit pre-effect closure, and terminal reopen', () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    const committed = committedFixture();

    expect(() =>
      closeSafeCodingLedgerCommitted(prepared, {
        now: TERMINAL_AT,
        resultHash: HASH_F,
        attestation: attestationFixture({
          attestationId: prepared.evidenceAdmission.attestationId,
          status: 'committed',
          resultHash: HASH_F,
        }),
      }),
    ).toThrow(/Expected COMMIT_PERMIT/);
    expect(() =>
      closeSafeCodingLedgerFailedPreEffect(permitted, {
        now: TERMINAL_AT,
        reasonCode: 'not-allowed',
        attestation: attestationFixture({
          attestationId: prepared.evidenceAdmission.attestationId,
          status: 'failed_no_effect',
        }),
      }),
    ).toThrow(/Expected PREPARED/);
    expect(() =>
      recordSafeCodingCommitPermit(
        committed,
        permitFixture(committed.ticketState.ticket),
      ),
    ).toThrow(/Expected PREPARED/);
  });

  it('rejects attestation status, ticket, result, and reserved-ID substitution', () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );

    expect(() =>
      closeSafeCodingLedgerCommitted(permitted, {
        now: TERMINAL_AT,
        resultHash: HASH_F,
        attestation: attestationFixture({
          ticket: ticketFixture(2),
          attestationId: prepared.evidenceAdmission.attestationId,
          status: 'committed',
          resultHash: HASH_F,
        }),
      }),
    ).toThrow(/does not match|invalid/);
    expect(() =>
      closeSafeCodingLedgerCommitted(permitted, {
        now: TERMINAL_AT,
        resultHash: HASH_F,
        attestation: attestationFixture({
          ticket: prepared.ticketState.ticket,
          attestationId: uuid(99),
          status: 'committed',
          resultHash: HASH_F,
        }),
      }),
    ).toThrow(/does not match/);
    expect(() =>
      closeSafeCodingLedgerCommitted(permitted, {
        now: TERMINAL_AT,
        resultHash: HASH_F,
        attestation: attestationFixture({
          ticket: prepared.ticketState.ticket,
          attestationId: prepared.evidenceAdmission.attestationId,
          status: 'uncertain',
          resultHash: HASH_F,
        }),
      }),
    ).toThrow(/does not match|invalid/);

    const wrongExecutor = attestationFixture({
      ticket: prepared.ticketState.ticket,
      attestationId: prepared.evidenceAdmission.attestationId,
      status: 'committed',
      resultHash: HASH_F,
    });
    expect(() =>
      closeSafeCodingLedgerCommitted(permitted, {
        now: TERMINAL_AT,
        resultHash: HASH_F,
        attestation: { ...wrongExecutor, executorId: 'executor:other' },
      }),
    ).toThrow(/exactly bound|does not match/);
  });

  it('rejects laundering of every immutable evidence expectation field', () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    const base = attestationFixture({
      ticket: prepared.ticketState.ticket,
      attestationId: prepared.evidenceAdmission.attestationId,
      status: 'committed',
      resultHash: HASH_F,
    });
    const forgeries: readonly SafeCodingEffectAttestation[] = [
      { ...base, delegationLineageHash: HASH_B },
      { ...base, runnerId: 'runner:other' },
      { ...base, runnerDigest: HASH_B },
      { ...base, observerId: 'observer:other' },
      { ...base, preStateHash: HASH_A },
      { ...base, postStateHash: HASH_A },
      { ...base, idempotencyKey: 'idempotency:forged' },
      {
        ...base,
        budgetCharges: { ...base.budgetCharges, mutationBytes: 9 },
      },
      { ...base, startedAt: '2026-07-14T00:00:30Z' },
      { ...base, evidenceLevel: 'local_state_reconciled' },
      {
        ...base,
        evidenceLevel: 'independently_reconciled',
        reconciliationRef: 'reconciliation:forged',
      },
    ];

    for (const attestation of forgeries) {
      expect(() =>
        closeSafeCodingLedgerCommitted(permitted, {
          now: TERMINAL_AT,
          resultHash: HASH_F,
          attestation,
        }),
      ).toThrow(/does not match/);
    }
  });

  it('rejects an unclosable non-UUID attestation reservation', () => {
    const ticket = ticketFixture();
    expect(() =>
      createPreparedSafeCodingLedgerRecord({
        ticket,
        attemptId: 'attempt:one',
        evidenceIntentId: 'evidence:one',
        attestationId: 'attestation:not-a-uuid',
        evidenceExpectation: evidenceExpectationFixture(ticket),
        now: PREPARED_AT,
      }),
    ).toThrow(/canonical lowercase UUID/);
    expect(() =>
      createPreparedSafeCodingLedgerRecord({
        ticket,
        attemptId: 'attempt:one',
        evidenceIntentId: 'evidence:one',
        attestationId: uuid(10_001),
        evidenceExpectation: evidenceExpectationFixture(ticket, {
          completionEvidenceLevel: 'adapter_observed',
          completionReconciliationRef: 'reconciliation:invalid',
        }),
        now: PREPARED_AT,
      }),
    ).toThrow(/Only independently reconciled/);
    expect(() =>
      createPreparedSafeCodingLedgerRecord({
        ticket,
        attemptId: 'attempt:one',
        evidenceIntentId: 'evidence:one',
        attestationId: uuid(10_001),
        evidenceExpectation: evidenceExpectationFixture(ticket, {
          observerId: ticket.audience.executorId,
        }),
        now: PREPARED_AT,
      }),
    ).toThrow(/distinct from the ticket executor/);
  });

  it('requires a trusted structured receipt and exact pending-outbox binding', async () => {
    const committed = committedFixture();
    expect(() =>
      markSafeCodingLedgerEvidenceAdmitted(committed, {
        receipt: receiptFixture(committed) as never,
      }),
    ).toThrow(/trusted verifier/);

    const wrong = await verifiedReceiptFixture(committed, {
      evidenceIntentId: 'evidence:other',
    });
    expect(() =>
      markSafeCodingLedgerEvidenceAdmitted(committed, { receipt: wrong }),
    ).toThrow(/does not bind/);

    const wrongPayload = await verifiedReceiptFixture(committed, {
      attestation: {
        ...committed.evidenceAdmission.attestation!,
        runnerId: 'runner:forged',
      },
    });
    expect(() =>
      markSafeCodingLedgerEvidenceAdmitted(committed, {
        receipt: wrongPayload,
      }),
    ).toThrow(/exactly bound/);

    const oneShot = await verifiedReceiptFixture(committed);
    expect(
      markSafeCodingLedgerEvidenceAdmitted(committed, { receipt: oneShot })
        .evidenceAdmission.status,
    ).toBe('ADMITTED');
    expect(() =>
      markSafeCodingLedgerEvidenceAdmitted(committed, { receipt: oneShot }),
    ).toThrow(/trusted verifier/);

    await expect(
      verifySafeCodingEvidenceAdmissionReceipt(receiptFixture(committed), {
        verify: () => true,
        assertVerified: (() => Promise.resolve()) as never,
      }),
    ).rejects.toThrow(/final trust fence failed closed/);
  });

  it('reserves all eight replay identities and keeps prefixed maximum IDs persistable', () => {
    const maximumIdentifier = `a${'b'.repeat(255)}`;
    const ticket = {
      ...ticketFixture(),
      requestId: maximumIdentifier,
      budgetReservationId: maximumIdentifier,
    };
    const record = createPreparedSafeCodingLedgerRecord({
      ticket,
      attemptId: maximumIdentifier,
      evidenceIntentId: maximumIdentifier,
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticket, {
        idempotencyKey: maximumIdentifier,
      }),
      now: PREPARED_AT,
    });
    const identities = safeCodingLedgerIdentityKeys(record);
    expect(identities).toHaveLength(8);
    expect(
      Math.max(...identities.map((key) => key.length)),
    ).toBeLessThanOrEqual(SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH);
    expect(
      validateSafeCodingLedgerPersistenceCasResult({
        outcome: 'IDENTITY_CONFLICT',
        identityKey: identities.find((key) =>
          key.startsWith('evidence-intent:'),
        ),
      }),
    ).toMatchObject({ outcome: 'IDENTITY_CONFLICT' });
  });

  it('requires positive observation before attaching a result hash to UNCERTAIN', () => {
    const prepared = preparedFixture();
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    expect(() =>
      closeSafeCodingLedgerUncertain(permitted, {
        now: TERMINAL_AT,
        resultHash: HASH_F,
        reasonCode: 'settlement-failed',
        effectCompletionObserved: false,
        attestation: attestationFixture({
          ticket: prepared.ticketState.ticket,
          attestationId: prepared.evidenceAdmission.attestationId,
          status: 'uncertain',
          resultHash: HASH_F,
        }),
      }),
    ).toThrow(/requires observed effect completion/);
  });

  it('rejects time regression, expired prepare/permit, and unreachable revisions', () => {
    expect(() =>
      preparedFixture({
        ...ticketFixture(),
        expiresAt: PREPARED_AT,
      }),
    ).toThrow(/outside ticket validity/);

    const prepared = preparedFixture();
    expect(() =>
      recordSafeCodingCommitPermit(prepared, {
        ...permitFixture(prepared.ticketState.ticket),
        permittedAt: '2026-07-14T00:00:30Z',
      }),
    ).toThrow(/timestamp is invalid/);

    expect(() =>
      validateSafeCodingLedgerRecord({
        ...JSON.parse(canonicalizeJson(prepared)),
        revision: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/unreachable/);
  });

  it('rejects extra, hidden, symbol, custom-prototype, and accessor record fields without invoking getters', () => {
    const plain = JSON.parse(canonicalizeJson(preparedFixture())) as Record<
      string,
      unknown
    >;
    expect(() =>
      validateSafeCodingLedgerRecord({ ...plain, surprise: true }),
    ).toThrow(/unknown or missing/);

    const hidden = { ...plain };
    Object.defineProperty(hidden, 'hidden', { value: true });
    expect(() => validateSafeCodingLedgerRecord(hidden)).toThrow(
      /non-enumerable|hidden/,
    );

    const symbol = { ...plain, [Symbol('authority')]: true };
    expect(() => validateSafeCodingLedgerRecord(symbol)).toThrow(/symbol/);

    const custom = Object.assign(Object.create({ inherited: true }), plain);
    expect(() => validateSafeCodingLedgerRecord(custom)).toThrow(
      /plain data|plain object|container/,
    );

    let getterCalls = 0;
    const accessor = { ...plain };
    Object.defineProperty(accessor, 'updatedAt', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return PREPARED_AT;
      },
    });
    expect(() => validateSafeCodingLedgerRecord(accessor)).toThrow(/accessor/);
    expect(getterCalls).toBe(0);
  });

  it('rejects a forged successor revision and terminal-state change', async () => {
    const committed = committedFixture();
    const admitted = markSafeCodingLedgerEvidenceAdmitted(committed, {
      receipt: await verifiedReceiptFixture(committed),
    });
    expect(() =>
      validateSafeCodingLedgerRecord({
        ...JSON.parse(canonicalizeJson(admitted)),
        revision: committed.revision + 2,
      }),
    ).toThrow(/unreachable/);
    const reopenedValue = JSON.parse(canonicalizeJson(admitted)) as Record<
      string,
      unknown
    >;
    const reopenedTicket = reopenedValue.ticketState as Record<string, unknown>;
    reopenedTicket.status = 'UNCERTAIN';
    reopenedTicket.terminalReasonCode = 'forged-reopen';
    const reopenedEvidence = reopenedValue.evidenceAdmission as Record<
      string,
      unknown
    >;
    const reopenedAttestation = reopenedEvidence.attestation as Record<
      string,
      unknown
    >;
    reopenedAttestation.status = 'uncertain';
    const reopenedReceipt = reopenedEvidence.admissionReceipt as Record<
      string,
      unknown
    >;
    const reopenedReceiptAttestation = reopenedReceipt.attestation as Record<
      string,
      unknown
    >;
    reopenedReceiptAttestation.status = 'uncertain';
    const reopened = validateSafeCodingLedgerRecord(reopenedValue);
    expect(() => assertSafeCodingLedgerSuccessor(committed, reopened)).toThrow(
      /cannot reopen or change/,
    );
  });
});

describe('SafeCodingEffectLedger persistence facade', () => {
  it('declares the reference store memory-only and performs the full logical CAS transaction', async () => {
    const store = new InMemorySafeCodingLedgerStore();
    const ledger = new SafeCodingEffectLedger(store);
    const ticket = ticketFixture();

    expect(ledger.durability).toEqual({
      version: 1,
      mode: 'memory-only',
      adapterId: 'clodex-ledger.in-memory-reference',
      atomicScope: 'single-js-isolate',
      atomicRecordAndOutbox: true,
      stableBeforeSuccess: false,
      restartReadable: false,
      multiProcessCas: false,
    });
    const prepared = await ledger.createPrepared({
      ticket,
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticket),
      now: PREPARED_AT,
    });
    const permitted = await ledger.recordCommitPermit({
      transactionId: ticket.ticketId,
      expectedRevision: prepared.revision,
      permit: permitFixture(ticket),
    });
    const committed = await ledger.closeCommitted({
      transactionId: ticket.ticketId,
      expectedRevision: permitted.revision,
      now: TERMINAL_AT,
      resultHash: HASH_F,
      attestation: attestationFixture({
        ticket,
        attestationId: prepared.evidenceAdmission.attestationId,
        status: 'committed',
        resultHash: HASH_F,
      }),
    });

    expect((await ledger.get(ticket.ticketId))?.revision).toBe(3);
    expect(await ledger.pendingEvidence()).toEqual([committed]);
    expect(store.durability.mode).toBe('memory-only');
  });

  it('rejects a restored terminal record forged back to revision one', () => {
    const failed = closeSafeCodingLedgerFailedPreEffect(preparedFixture(), {
      now: TERMINAL_AT,
      reasonCode: 'recovered',
      attestation: attestationFixture({
        attestationId: uuid(10_001),
        status: 'failed_no_effect',
      }),
    });
    expect(() =>
      validateSafeCodingLedgerRecord({
        ...JSON.parse(canonicalizeJson(failed)),
        revision: 1,
      }),
    ).toThrow(/unreachable/);
  });

  it('allows exactly one winner for concurrent same-revision COMMIT_PERMIT CAS', async () => {
    const ledger = new SafeCodingEffectLedger(
      new InMemorySafeCodingLedgerStore(),
    );
    const ticket = ticketFixture();
    const prepared = await ledger.createPrepared({
      ticket,
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticket),
      now: PREPARED_AT,
    });
    const operation = () =>
      ledger.recordCommitPermit({
        transactionId: ticket.ticketId,
        expectedRevision: prepared.revision,
        permit: permitFixture(ticket),
      });

    const results = await Promise.allSettled([operation(), operation()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect((failure as PromiseRejectedResult).reason).toMatchObject({
      code: 'cas-conflict',
      expectedRevision: 1,
      actualRevision: 2,
    });
  });

  it('reserves request, nonce, reservation, attempt, and evidence identities atomically', async () => {
    const ledger = new SafeCodingEffectLedger(
      new InMemorySafeCodingLedgerStore(),
    );
    const first = ticketFixture(1);
    await ledger.createPrepared({
      ticket: first,
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(first),
      now: PREPARED_AT,
    });
    const replay = {
      ...ticketFixture(2),
      requestId: first.requestId,
      nonce: first.nonce,
      budgetReservationId: first.budgetReservationId,
    };

    await expect(
      ledger.createPrepared({
        ticket: replay,
        attemptId: 'attempt:two',
        evidenceIntentId: 'evidence:two',
        attestationId: uuid(10_002),
        evidenceExpectation: evidenceExpectationFixture(replay),
        now: PREPARED_AT,
      }),
    ).rejects.toMatchObject({ code: 'identity-conflict' });
    expect(await ledger.scan()).toHaveLength(1);
  });

  it('does not implicitly retry a stale caller revision', async () => {
    const ledger = new SafeCodingEffectLedger(
      new InMemorySafeCodingLedgerStore(),
    );
    const prepared = await ledger.createPrepared({
      ticket: ticketFixture(),
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticketFixture()),
      now: PREPARED_AT,
    });

    await expect(
      ledger.recordCommitPermit({
        transactionId: prepared.transactionId,
        expectedRevision: 99,
        permit: permitFixture(prepared.ticketState.ticket),
      }),
    ).rejects.toMatchObject({
      code: 'cas-conflict',
      expectedRevision: 99,
      actualRevision: 1,
    });
    expect((await ledger.get(prepared.transactionId))?.ticketState.status).toBe(
      'PREPARED',
    );
  });

  it('returns detached immutable records rather than store-owned references', async () => {
    const store = new InMemorySafeCodingLedgerStore();
    const ledger = new SafeCodingEffectLedger(store);
    const record = await ledger.createPrepared({
      ticket: ticketFixture(),
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticketFixture()),
      now: PREPARED_AT,
    });

    expect(Object.isFrozen(record)).toBe(true);
    expect(await ledger.get(record.transactionId)).not.toBe(record);
    expect(store.snapshot()[0]).not.toBe(record);
  });

  it('sorts scan/recovery deterministically and never authorizes effect replay', async () => {
    const ledger = new SafeCodingEffectLedger(
      new InMemorySafeCodingLedgerStore(),
    );
    for (const index of [3, 1, 2]) {
      await ledger.createPrepared({
        ticket: ticketFixture(index),
        attemptId: `attempt:${index}`,
        evidenceIntentId: `evidence:${index}`,
        attestationId: uuid(10_000 + index),
        evidenceExpectation: evidenceExpectationFixture(ticketFixture(index)),
        now: PREPARED_AT,
      });
    }
    const records = await ledger.scan();
    const decisions = await ledger.scanRecovery();

    expect(records.map((record) => record.transactionId)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
    ]);
    expect(decisions.every((decision) => !decision.effectReplayAllowed)).toBe(
      true,
    );
  });

  it('fails closed when persistence lies about an APPLIED record', async () => {
    const port = portFixture({
      compareAndSwap: async (mutation) => ({
        outcome: 'APPLIED',
        record: {
          ...JSON.parse(canonicalizeJson(mutation.nextRecord)),
          revision: mutation.nextRecord.revision + 1,
        },
      }),
    });
    const ledger = new SafeCodingEffectLedger(port);

    await expect(
      ledger.createPrepared({
        ticket: ticketFixture(),
        attemptId: 'attempt:one',
        evidenceIntentId: 'evidence:one',
        attestationId: uuid(10_001),
        evidenceExpectation: evidenceExpectationFixture(ticketFixture()),
        now: PREPARED_AT,
      }),
    ).rejects.toMatchObject({ code: 'persistence-invalid' });
  });

  it('rejects malformed CAS responses and duplicate/malformed scan rows', async () => {
    const malformedCas = portFixture({
      compareAndSwap: async () =>
        ({
          outcome: 'APPLIED',
          record: preparedFixture(),
          extra: true,
        }) as never,
    });
    await expect(
      new SafeCodingEffectLedger(malformedCas).createPrepared({
        ticket: ticketFixture(),
        attemptId: 'attempt:one',
        evidenceIntentId: 'evidence:one',
        attestationId: uuid(10_001),
        evidenceExpectation: evidenceExpectationFixture(ticketFixture()),
        now: PREPARED_AT,
      }),
    ).rejects.toMatchObject({ code: 'persistence-invalid' });

    const record = preparedFixture();
    const duplicateScan = portFixture({ scan: async () => [record, record] });
    await expect(
      new SafeCodingEffectLedger(duplicateScan).scan(),
    ).rejects.toMatchObject({ code: 'persistence-invalid' });

    let getterCalls = 0;
    const rows: unknown[] = [];
    Object.defineProperty(rows, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return record;
      },
    });
    rows.length = 1;
    const accessorScan = portFixture({ scan: async () => rows });
    await expect(
      new SafeCodingEffectLedger(accessorScan).scan(),
    ).rejects.toMatchObject({ code: 'persistence-invalid' });
    expect(getterCalls).toBe(0);
  });

  it('rejects restored rows that reuse any cross-record replay identity', async () => {
    const first = preparedFixture(ticketFixture(1), 1);
    const secondTicket = {
      ...ticketFixture(2),
      requestId: first.ticketState.ticket.requestId,
    };
    const second = preparedFixture(secondTicket, 2);
    const restored = portFixture({ scan: async () => [first, second] });

    await expect(
      new SafeCodingEffectLedger(restored).scanRecovery(),
    ).rejects.toMatchObject({ code: 'persistence-invalid' });
  });

  it('bounds restore row count and deeply malformed records before canonicalization', async () => {
    const record = preparedFixture();
    const excessive = portFixture({
      scan: async () => new Array(4097).fill(record),
    });
    await expect(
      new SafeCodingEffectLedger(excessive).scan(),
    ).rejects.toMatchObject({ code: 'persistence-invalid' });

    let nested: unknown = 'leaf';
    for (let index = 0; index < 32; index += 1) nested = { nested };
    const malformed = {
      ...JSON.parse(canonicalizeJson(record)),
      evidenceExpectation: nested,
    };
    expect(() => validateSafeCodingLedgerRecord(malformed)).toThrow(
      /nesting depth|node limit/,
    );
  });

  it('snapshots mutable async inputs before persistence awaits', async () => {
    const prepared = preparedFixture();
    const gate = deferred<SafeCodingLedgerRecord>();
    const port = portFixture({
      read: async () => await gate.promise,
      compareAndSwap: async (mutation) => ({
        outcome: 'APPLIED',
        record: mutation.nextRecord,
      }),
    });
    const ledger = new SafeCodingEffectLedger(port);
    const input = {
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision,
      permit: { ...permitFixture(prepared.ticketState.ticket) },
    };
    const operation = ledger.recordCommitPermit(input);
    input.transactionId = ticketFixture(2).ticketId;
    input.expectedRevision = 99;
    input.permit.permittedAt = '2026-07-14T00:09:00Z';
    gate.resolve(prepared);

    await expect(operation).resolves.toMatchObject({
      transactionId: prepared.transactionId,
      revision: 2,
      effectAttempt: { commitPermittedAt: PERMITTED_AT },
    });
  });

  it('passes an immutable CAS request and compares APPLIED against the captured record', async () => {
    let observedFrozenMutation = false;
    let observedFrozenRecord = false;
    const port = portFixture({
      compareAndSwap: async (mutation) => {
        observedFrozenMutation = Object.isFrozen(mutation);
        observedFrozenRecord = Object.isFrozen(mutation.nextRecord);
        Reflect.set(mutation, 'transactionId', ticketFixture(2).ticketId);
        return { outcome: 'APPLIED', record: mutation.nextRecord };
      },
    });
    const ledger = new SafeCodingEffectLedger(port);
    const ticket = ticketFixture();
    await ledger.createPrepared({
      ticket,
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticket),
      now: PREPARED_AT,
    });
    expect(observedFrozenMutation).toBe(true);
    expect(observedFrozenRecord).toBe(true);
  });

  it('rejects accessor-based persistence methods without invoking them', () => {
    let getterCalls = 0;
    const port = {
      durability: IN_MEMORY_SAFE_CODING_LEDGER_DURABILITY,
      scan: async () => [],
      compareAndSwap: async () => ({
        outcome: 'REVISION_CONFLICT' as const,
        actualRevision: null,
      }),
    } as Partial<SafeCodingLedgerPersistenceTransactionPort>;
    Object.defineProperty(port, 'read', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return async () => null;
      },
    });

    expect(
      () =>
        new SafeCodingEffectLedger(
          port as SafeCodingLedgerPersistenceTransactionPort,
        ),
    ).toThrow(/data method/);
    expect(getterCalls).toBe(0);
  });

  it('surfaces persistence unavailability without publishing a successful transition', async () => {
    let stored: SafeCodingLedgerRecord | null = null;
    const port = portFixture({
      read: async () => stored,
      compareAndSwap: async (mutation) => {
        if (mutation.expectedRevision === null) {
          stored = mutation.nextRecord;
          return { outcome: 'APPLIED', record: mutation.nextRecord };
        }
        throw new Error('storage unavailable');
      },
    });
    const ledger = new SafeCodingEffectLedger(port);
    const prepared = await ledger.createPrepared({
      ticket: ticketFixture(),
      attemptId: 'attempt:one',
      evidenceIntentId: 'evidence:one',
      attestationId: uuid(10_001),
      evidenceExpectation: evidenceExpectationFixture(ticketFixture()),
      now: PREPARED_AT,
    });

    await expect(
      ledger.recordCommitPermit({
        transactionId: prepared.transactionId,
        expectedRevision: prepared.revision,
        permit: permitFixture(prepared.ticketState.ticket),
      }),
    ).rejects.toMatchObject({ code: 'persistence-unavailable' });
    expect((stored as SafeCodingLedgerRecord | null)?.ticketState.status).toBe(
      'PREPARED',
    );
  });
});

function portFixture(
  overrides: Partial<SafeCodingLedgerPersistenceTransactionPort> = {},
): SafeCodingLedgerPersistenceTransactionPort {
  return {
    durability: IN_MEMORY_SAFE_CODING_LEDGER_DURABILITY,
    read: async () => null,
    scan: async () => [],
    compareAndSwap: async (mutation: SafeCodingLedgerPersistenceMutation) => ({
      outcome: 'APPLIED',
      record: mutation.nextRecord,
    }),
    ...overrides,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}
