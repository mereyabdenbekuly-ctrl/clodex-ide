import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_PLANE_EVIDENCE_RECEIPT_KIND,
  CONTROL_PLANE_EVIDENCE_RECEIPT_VERSION,
  TRUSTED_COMMIT_PERMIT_KIND,
  TRUSTED_COMMIT_PERMIT_VERSION,
  ControlPlaneValidationError,
  ExecutionControlPlane,
  InMemoryControlPlaneStore,
  classifyControlPlaneRecovery,
  controlPlaneIdentityKeys,
  type ControlPlaneEvidenceAdmissionReceipt,
  type ControlPlaneFaultPoint,
  type ControlPlaneTransactionRecord,
  type PrepareControlPlaneInput,
  type TrustedCommitPermitAdmission,
} from './index.js';

const T0 = '2026-07-14T00:00:00.000Z';
const T1 = '2026-07-14T00:00:01.000Z';
const T2 = '2026-07-14T00:00:02.000Z';
const T4 = '2026-07-14T00:00:04.000Z';

function prepareInput(suffix = '1'): PrepareControlPlaneInput {
  return {
    transactionId: `ticket-${suffix}`,
    ticketCommitment: `sha256:ticket-commitment-${suffix}`,
    authorityScopeHash: `sha256:authority-scope-${suffix}`,
    nonce: `nonce-${suffix}`,
    budgetReservationId: `budget-${suffix}`,
    attemptId: `attempt-${suffix}`,
    adapterId: 'adapter.filesystem-v1',
    adapterDigest: 'sha256:adapter-digest-v1',
    operationCommitment: `sha256:operation-${suffix}`,
    targetObjectId: `workspace-object-${suffix}`,
    preStateHash: `sha256:pre-state-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    ledgerEntryId: `ledger-entry-${suffix}`,
    evidenceIntentId: `evidence-intent-${suffix}`,
    attestationId: `attestation-${suffix}`,
  };
}

function permitFor(input = prepareInput()): TrustedCommitPermitAdmission {
  return {
    kind: TRUSTED_COMMIT_PERMIT_KIND,
    version: TRUSTED_COMMIT_PERMIT_VERSION,
    permitId: `permit-${input.transactionId}`,
    permitDigest: `sha256:permit-${input.transactionId}`,
    admissionReceiptHash: `sha256:permit-admission-${input.transactionId}`,
    issuerId: 'guardian.production-v1',
    trustEpoch: 7,
    registryDigest: 'sha256:authority-registry-v7',
    ticketId: input.transactionId,
    ticketCommitment: input.ticketCommitment,
    operationCommitment: input.operationCommitment,
    issuedAt: T0,
    expiresAt: '2026-07-14T00:01:00.000Z',
    admittedAt: T1,
  };
}

function receiptFor(
  record: ControlPlaneTransactionRecord,
): ControlPlaneEvidenceAdmissionReceipt {
  return {
    kind: CONTROL_PLANE_EVIDENCE_RECEIPT_KIND,
    version: CONTROL_PLANE_EVIDENCE_RECEIPT_VERSION,
    receiptId: `receipt-${record.transactionId}`,
    transactionId: record.transactionId,
    evidenceIntentId: record.evidenceOutbox.intentId,
    attestationId: record.evidenceOutbox.attestationId,
    evidenceEnvelopeHash: `sha256:evidence-envelope-${record.transactionId}`,
    evidenceLedgerId: 'evidence-ledger.production-v1',
    evidenceSequence: 42,
    checkpointDigest: 'sha256:evidence-checkpoint-42',
    admittedAt: T4,
  };
}

function harness(options?: {
  readonly store?: InMemoryControlPlaneStore;
  readonly fault?: () => ControlPlaneFaultPoint | null;
  readonly permit?: TrustedCommitPermitAdmission;
}) {
  let now = T0;
  const store = options?.store ?? new InMemoryControlPlaneStore();
  const permit = options?.permit ?? permitFor();
  const verifyPermit = vi.fn(() => permit);
  const assertPermit = vi.fn(() => undefined);
  const verifyReceipt = vi.fn((value: unknown) => value);
  const assertReceipt = vi.fn(() => undefined);
  const plane = new ExecutionControlPlane({
    storage: store,
    clock: { now: () => now },
    commitPermits: {
      verifySynchronously: verifyPermit,
      assertTrustedSynchronously: assertPermit,
    },
    evidenceReceipts: {
      verifySynchronously: verifyReceipt,
      assertTrustedSynchronously: assertReceipt,
    },
    faultInjector: {
      inject(point) {
        if (options?.fault?.() === point) throw new Error(`crash:${point}`);
      },
    },
  });
  return {
    plane,
    store,
    permit,
    verifyPermit,
    assertPermit,
    verifyReceipt,
    assertReceipt,
    setNow(value: string) {
      now = value;
    },
  };
}

async function preparedAndPermitted(
  instance = harness(),
  input = prepareInput(),
) {
  const prepared = await instance.plane.prepare(input);
  instance.setNow(T1);
  const permitted = await instance.plane.consumeCommitPermit({
    transactionId: input.transactionId,
    expectedRevision: prepared.revision,
    permitEnvelope: { envelope: 'signed-permit-v1' },
  });
  return { ...instance, input, prepared, permitted };
}

describe('ExecutionControlPlane', () => {
  it('prepares ticket, ledger, effect, and evidence reservation in one record', async () => {
    const instance = harness();
    const record = await instance.plane.prepare(prepareInput());

    expect(record).toMatchObject({
      revision: 1,
      phase: 'PREPARED',
      ticket: { status: 'RESERVED', consumedAt: null },
      commitPermit: null,
      effect: { status: 'NOT_STARTED', startedAt: null },
      ledger: {
        state: 'PREPARED',
        ticketConsumed: false,
        commitPermitDigest: null,
      },
      evidenceOutbox: { status: 'RESERVED', terminalEvidence: null },
    });
    expect(controlPlaneIdentityKeys(record)).toEqual([
      'attempt:attempt-1',
      'attestation:attestation-1',
      'budget-reservation:budget-1',
      'evidence-intent:evidence-intent-1',
      'idempotency:idempotency-1',
      'ledger-entry:ledger-entry-1',
      'nonce:nonce-1',
      'ticket:ticket-1',
    ]);
  });

  it('atomically consumes only an externally verified and finally fenced permit', async () => {
    const result = await preparedAndPermitted();

    expect(result.permitted).toMatchObject({
      revision: 2,
      phase: 'COMMIT_PERMIT',
      ticket: { status: 'CONSUMED', consumedAt: T1 },
      ledger: {
        state: 'COMMIT_PERMIT',
        ticketConsumed: true,
        commitPermitDigest: result.permit.permitDigest,
      },
      evidenceOutbox: { status: 'RESERVED' },
    });
    expect(result.verifyPermit).toHaveBeenCalledOnce();
    expect(result.assertPermit).toHaveBeenCalledOnce();
    expect(controlPlaneIdentityKeys(result.permitted)).toContain(
      `commit-permit:${result.permit.permitId}`,
    );
  });

  it('rejects a permit bound to another operation without consuming the ticket', async () => {
    const input = prepareInput();
    const wrong = {
      ...permitFor(input),
      operationCommitment: 'sha256:other-operation',
    };
    const instance = harness({ permit: wrong });
    await instance.plane.prepare(input);
    instance.setNow(T1);

    await expect(
      instance.plane.consumeCommitPermit({
        transactionId: input.transactionId,
        expectedRevision: 1,
        permitEnvelope: {},
      }),
    ).rejects.toMatchObject({ code: 'authority-rejected' });
    await expect(
      instance.plane.get(input.transactionId),
    ).resolves.toMatchObject({
      revision: 1,
      phase: 'PREPARED',
      commitPermit: null,
    });
  });

  it('runs a positively observed effect exactly once and closes evidence atomically', async () => {
    const instance = await preparedAndPermitted();
    instance.setNow(T2);
    const executeOnce = vi.fn(async () => ({
      outcome: 'COMMITTED',
      resultHash: 'sha256:effect-result',
      postStateHash: 'sha256:post-state',
      observationRef: 'observer-receipt-1',
      reasonCode: 'effect-committed',
    }));

    const terminal = await instance.plane.executeOnce({
      transactionId: instance.input.transactionId,
      expectedRevision: instance.permitted.revision,
      effect: { executeOnce },
    });

    expect(executeOnce).toHaveBeenCalledOnce();
    expect(terminal).toMatchObject({
      revision: 4,
      phase: 'COMMITTED',
      effect: {
        status: 'OBSERVED_COMMITTED',
        resultHash: 'sha256:effect-result',
        postStateHash: 'sha256:post-state',
      },
      ledger: { state: 'COMMITTED', effectMayHaveOccurred: true },
      evidenceOutbox: {
        status: 'READY',
        terminalEvidence: {
          terminalPhase: 'COMMITTED',
          resultHash: 'sha256:effect-result',
        },
      },
    });
  });

  it.each([
    {
      observation: {
        outcome: 'RESULT_UNAVAILABLE',
        postStateHash: 'sha256:post-state',
        observationRef: 'observer-receipt-2',
        reasonCode: 'result-unavailable',
      },
      phase: 'RESULT_UNAVAILABLE',
    },
    {
      observation: { outcome: 'NO_EFFECT', reasonCode: 'precondition-failed' },
      phase: 'FAILED_PRE_EFFECT',
    },
    {
      observation: { outcome: 'UNCERTAIN', reasonCode: 'adapter-ambiguous' },
      phase: 'UNCERTAIN',
    },
  ] as const)('closes $phase without retry', async ({ observation, phase }) => {
    const instance = await preparedAndPermitted();
    instance.setNow(T2);
    const executeOnce = vi.fn(async () => observation);

    const terminal = await instance.plane.executeOnce({
      transactionId: instance.input.transactionId,
      expectedRevision: 2,
      effect: { executeOnce },
    });

    expect(executeOnce).toHaveBeenCalledOnce();
    expect(terminal.phase).toBe(phase);
    expect(terminal.evidenceOutbox.status).toBe('READY');
  });

  it('classifies a thrown executor as UNCERTAIN and never retries it', async () => {
    const instance = await preparedAndPermitted();
    instance.setNow(T2);
    const executeOnce = vi.fn(async () => {
      throw new Error('lost transport after write');
    });

    const terminal = await instance.plane.executeOnce({
      transactionId: instance.input.transactionId,
      expectedRevision: 2,
      effect: { executeOnce },
    });

    expect(executeOnce).toHaveBeenCalledOnce();
    expect(terminal).toMatchObject({
      phase: 'UNCERTAIN',
      effect: { terminalReasonCode: 'executor-threw' },
      ledger: { effectMayHaveOccurred: true },
    });
  });

  it('classifies an invalid executor response as UNCERTAIN', async () => {
    const instance = await preparedAndPermitted();
    instance.setNow(T2);

    const terminal = await instance.plane.executeOnce({
      transactionId: instance.input.transactionId,
      expectedRevision: 2,
      effect: { executeOnce: async () => ({ outcome: 'COMMITTED' }) },
    });

    expect(terminal).toMatchObject({
      phase: 'UNCERTAIN',
      effect: { terminalReasonCode: 'executor-invalid-observation' },
    });
  });

  it('lets only one concurrent caller cross the one-shot effect boundary', async () => {
    const instance = await preparedAndPermitted();
    instance.setNow(T2);
    const executeOnce = vi.fn(async () => ({
      outcome: 'NO_EFFECT',
      reasonCode: 'controlled-no-effect',
    }));
    const call = () =>
      instance.plane.executeOnce({
        transactionId: instance.input.transactionId,
        expectedRevision: 2,
        effect: { executeOnce },
      });

    const results = await Promise.allSettled([call(), call()]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(executeOnce).toHaveBeenCalledOnce();
  });

  it('does not call the effect after a crash immediately after durable in-flight state', async () => {
    let crashPoint: ControlPlaneFaultPoint | null = null;
    const instance = await preparedAndPermitted(
      harness({ fault: () => crashPoint }),
    );
    instance.setNow(T2);
    crashPoint = 'after-effect-in-flight-durable';
    const executeOnce = vi.fn(async () => ({
      outcome: 'NO_EFFECT',
      reasonCode: 'not-reached',
    }));

    await expect(
      instance.plane.executeOnce({
        transactionId: instance.input.transactionId,
        expectedRevision: 2,
        effect: { executeOnce },
      }),
    ).rejects.toThrow('crash:after-effect-in-flight-durable');
    expect(executeOnce).not.toHaveBeenCalled();
    await expect(
      instance.plane.get(instance.input.transactionId),
    ).resolves.toMatchObject({
      phase: 'EFFECT_IN_FLIGHT',
      revision: 3,
    });
    crashPoint = null;
    const recovered = await instance.plane.recover({
      transactionId: instance.input.transactionId,
      expectedRevision: 3,
    });
    expect(recovered.record.phase).toBe('UNCERTAIN');
    expect(recovered.decision.effectReplayAllowed).toBe(false);
    expect(executeOnce).not.toHaveBeenCalled();
  });

  it('never replays after a crash between effect observation and terminal settlement', async () => {
    let crashPoint: ControlPlaneFaultPoint | null = null;
    const instance = await preparedAndPermitted(
      harness({ fault: () => crashPoint }),
    );
    instance.setNow(T2);
    crashPoint = 'after-effect-observation-before-terminal-durable';
    const executeOnce = vi.fn(async () => ({
      outcome: 'COMMITTED',
      resultHash: 'sha256:result-before-crash',
      postStateHash: 'sha256:post-state-before-crash',
      observationRef: 'observer-receipt-before-crash',
      reasonCode: 'effect-committed',
    }));

    await expect(
      instance.plane.executeOnce({
        transactionId: instance.input.transactionId,
        expectedRevision: 2,
        effect: { executeOnce },
      }),
    ).rejects.toThrow('crash:after-effect-observation-before-terminal-durable');
    expect(executeOnce).toHaveBeenCalledOnce();
    crashPoint = null;

    const recovered = await instance.plane.recover({
      transactionId: instance.input.transactionId,
      expectedRevision: 3,
    });

    expect(recovered.record.phase).toBe('UNCERTAIN');
    expect(recovered.decision.effectReplayAllowed).toBe(false);
    expect(executeOnce).toHaveBeenCalledOnce();
  });

  it('recovers PREPARED as no-effect failure and never asks for an effect port', async () => {
    const instance = harness();
    await instance.plane.prepare(prepareInput());
    instance.setNow(T1);

    const result = await instance.plane.recover({
      transactionId: 'ticket-1',
      expectedRevision: 1,
    });

    expect(result.mutated).toBe(true);
    expect(result.decision.effectReplayAllowed).toBe(false);
    expect(result.record).toMatchObject({
      phase: 'FAILED_PRE_EFFECT',
      effect: { status: 'NO_EFFECT' },
      evidenceOutbox: { status: 'READY' },
    });
  });

  it('recovers a crash after durable prepare without replay or permit minting', async () => {
    let crashPoint: ControlPlaneFaultPoint | null = 'after-prepare-durable';
    const instance = harness({ fault: () => crashPoint });

    await expect(instance.plane.prepare(prepareInput())).rejects.toThrow(
      'crash:after-prepare-durable',
    );
    crashPoint = null;
    instance.setNow(T1);
    const recovered = await instance.plane.recover({
      transactionId: 'ticket-1',
      expectedRevision: 1,
    });

    expect(instance.verifyPermit).not.toHaveBeenCalled();
    expect(recovered.record.phase).toBe('FAILED_PRE_EFFECT');
    expect(recovered.decision.effectReplayAllowed).toBe(false);
  });

  it('recovers a crash after durable COMMIT_PERMIT as UNCERTAIN', async () => {
    let crashPoint: ControlPlaneFaultPoint | null = null;
    const instance = harness({ fault: () => crashPoint });
    await instance.plane.prepare(prepareInput());
    instance.setNow(T1);
    crashPoint = 'after-commit-permit-durable';

    await expect(
      instance.plane.consumeCommitPermit({
        transactionId: 'ticket-1',
        expectedRevision: 1,
        permitEnvelope: {},
      }),
    ).rejects.toThrow('crash:after-commit-permit-durable');
    crashPoint = null;
    instance.setNow(T2);
    const recovered = await instance.plane.recover({
      transactionId: 'ticket-1',
      expectedRevision: 2,
    });

    expect(recovered.record.phase).toBe('UNCERTAIN');
    expect(recovered.decision.effectReplayAllowed).toBe(false);
  });

  it('recovers every nonterminal post-permit record as UNCERTAIN without replay', async () => {
    const permitted = await preparedAndPermitted();
    permitted.setNow(T2);

    const result = await permitted.plane.recover({
      transactionId: permitted.input.transactionId,
      expectedRevision: 2,
    });

    expect(result.decision).toMatchObject({
      action: 'CLOSE_UNCERTAIN',
      effectReplayAllowed: false,
      effectMayHaveOccurred: true,
    });
    expect(result.record.phase).toBe('UNCERTAIN');
  });

  it('never offers effect replay for terminal recovery', async () => {
    const instance = harness();
    await instance.plane.prepare(prepareInput());
    instance.setNow(T1);
    const terminal = await instance.plane.abortPrepared({
      transactionId: 'ticket-1',
      expectedRevision: 1,
      reasonCode: 'operator-abort',
    });

    expect(classifyControlPlaneRecovery(terminal)).toMatchObject({
      action: 'DELIVER_EVIDENCE_ONLY',
      effectReplayAllowed: false,
    });
  });

  it('does not repeat an effect when the crash occurs after terminal durability', async () => {
    let crashPoint: ControlPlaneFaultPoint | null = null;
    const instance = await preparedAndPermitted(
      harness({ fault: () => crashPoint }),
    );
    instance.setNow(T2);
    crashPoint = 'after-terminal-durable';
    const executeOnce = vi.fn(async () => ({
      outcome: 'NO_EFFECT',
      reasonCode: 'controlled-no-effect',
    }));

    await expect(
      instance.plane.executeOnce({
        transactionId: 'ticket-1',
        expectedRevision: 2,
        effect: { executeOnce },
      }),
    ).rejects.toThrow('crash:after-terminal-durable');
    crashPoint = null;
    const terminal = await instance.plane.get('ticket-1');
    expect(terminal?.phase).toBe('FAILED_PRE_EFFECT');
    const recovered = await instance.plane.recover({
      transactionId: 'ticket-1',
      expectedRevision: 4,
    });
    expect(recovered.mutated).toBe(false);
    expect(recovered.decision.action).toBe('DELIVER_EVIDENCE_ONLY');
    expect(executeOnce).toHaveBeenCalledOnce();
  });

  it('records a verified evidence receipt without touching effect state', async () => {
    const instance = await preparedAndPermitted();
    instance.setNow(T2);
    const terminal = await instance.plane.executeOnce({
      transactionId: instance.input.transactionId,
      expectedRevision: 2,
      effect: {
        executeOnce: async () => ({
          outcome: 'NO_EFFECT',
          reasonCode: 'controlled-no-effect',
        }),
      },
    });
    const receipt = receiptFor(terminal);

    const delivered = await instance.plane.deliverEvidence({
      transactionId: terminal.transactionId,
      expectedRevision: terminal.revision,
      receiptEnvelope: receipt,
    });

    expect(delivered).toMatchObject({
      phase: 'FAILED_PRE_EFFECT',
      effect: { status: 'NO_EFFECT' },
      evidenceOutbox: {
        status: 'DELIVERED',
        admissionReceipt: { receiptId: receipt.receiptId },
      },
    });
    expect(instance.verifyReceipt).toHaveBeenCalledOnce();
    expect(instance.assertReceipt).toHaveBeenCalledOnce();
  });

  it('reserves identities across records and fails closed on reuse', async () => {
    const instance = harness();
    await instance.plane.prepare(prepareInput('1'));
    const second = { ...prepareInput('2'), nonce: 'nonce-1' };

    await expect(instance.plane.prepare(second)).rejects.toMatchObject({
      code: 'identity-conflict',
    });
  });

  it('rejects accessor-bearing public inputs before storage mutation', async () => {
    const instance = harness();
    const input = prepareInput() as PrepareControlPlaneInput & {
      transactionId: string;
    };
    Object.defineProperty(input, 'transactionId', {
      enumerable: true,
      get() {
        return 'ticket-accessor';
      },
    });

    await expect(instance.plane.prepare(input)).rejects.toBeInstanceOf(
      ControlPlaneValidationError,
    );
    expect(instance.store.snapshot()).toEqual([]);
  });

  it('rejects expired authority before any local ticket consumption', async () => {
    const input = prepareInput();
    const permit = { ...permitFor(input), expiresAt: T1 };
    const instance = harness({ permit });
    await instance.plane.prepare(input);
    instance.setNow(T2);

    await expect(
      instance.plane.consumeCommitPermit({
        transactionId: input.transactionId,
        expectedRevision: 1,
        permitEnvelope: {},
      }),
    ).rejects.toMatchObject({ code: 'authority-rejected' });
    expect((await instance.plane.get(input.transactionId))?.phase).toBe(
      'PREPARED',
    );
  });

  it('honors a final synchronous trust rejection inside storage exclusion', async () => {
    const instance = harness();
    await instance.plane.prepare(prepareInput());
    instance.setNow(T1);
    instance.assertPermit.mockImplementation(() => {
      throw new Error('permit revoked');
    });

    await expect(
      instance.plane.consumeCommitPermit({
        transactionId: 'ticket-1',
        expectedRevision: 1,
        permitEnvelope: {},
      }),
    ).rejects.toMatchObject({ code: 'authority-rejected' });
    await expect(instance.plane.get('ticket-1')).resolves.toMatchObject({
      phase: 'PREPARED',
      revision: 1,
    });
  });
});
