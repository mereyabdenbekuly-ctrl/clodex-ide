import {
  EFFECT_ATTESTATION_KIND,
  INTENT_CONTRACT_SPEC_VERSION,
  canonicalizeJson,
  encodeUtf8,
  hashSafeCodingAction,
  parseCanonicalJson,
  validateSafeCodingAction,
  validateSafeCodingEffectAttestation,
  type CanonicalJsonValue,
  type HashPort,
  type SafeCodingAction,
  type SafeCodingEffectAttestation,
  type SafeCodingEvidenceLevel,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';
import type { TrustedSafeCodingAdapterBinding } from '@clodex/guardian';
import type {
  KernelCommitPermit,
  KernelTerminalTicketStatus,
  KernelTicketRecord,
} from '@clodex/kernel';

const RESULT_HASH_DOMAIN = 'clodex.safe-coding.result.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

export const REFERENCE_SAFE_CODING_RUNTIME_PROFILE = Object.freeze({
  durability: 'non-durable-reference',
  executionMode: 'recording-only',
  promotion: 'disabled',
} as const);

export interface SafeCodingRuntimeAdapterPrepareInput {
  readonly action: SafeCodingAction;
  readonly ticket: SafeCodingExecutionTicket;
}

export interface SafeCodingRuntimeAdapterResult {
  readonly result: CanonicalJsonValue;
  readonly preStateHash: string | null;
  readonly postStateHash: string | null;
  readonly evidenceLevel: SafeCodingEvidenceLevel;
}

interface ObservedSafeCodingRuntimeAdapterResult {
  readonly result: unknown;
  readonly preStateHash: string | null;
  readonly postStateHash: string | null;
  readonly evidenceLevel: SafeCodingEvidenceLevel;
}

/**
 * A prepared effect is inert authority: construction MUST be side-effect free.
 * The runtime pins `execute` and invokes it exactly once only after the kernel
 * has returned COMMIT_PERMIT.
 */
export interface PreparedRuntimeEffect {
  execute():
    | SafeCodingRuntimeAdapterResult
    | Promise<SafeCodingRuntimeAdapterResult>;
}

/**
 * This surface is for trusted recording/sandbox adapters only. It deliberately
 * exposes no filesystem, Git, shell, process, network, or credential API.
 */
export interface SafeCodingRuntimeAdapter {
  readonly binding: TrustedSafeCodingAdapterBinding;
  prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): PreparedRuntimeEffect | Promise<PreparedRuntimeEffect>;
}

export interface SafeCodingRuntimeAdapterRegistryPort {
  resolve(
    action: SafeCodingAction,
  ): SafeCodingRuntimeAdapter | null | Promise<SafeCodingRuntimeAdapter | null>;
}

export interface SafeCodingRuntimeGuardianPort {
  issueExecutionTicket(input: {
    readonly signedContract: unknown;
    readonly action: unknown;
  }): Promise<SafeCodingExecutionTicket>;
  revalidateExecutionTicket(
    ticket: SafeCodingExecutionTicket,
    action: SafeCodingAction,
  ): void | Promise<void>;
  assertFinalAuthority(
    ticket: SafeCodingExecutionTicket,
    action: SafeCodingAction,
  ): void;
}

export interface SafeCodingRuntimeKernelPort {
  /**
   * Local synchronous linearization point. An asynchronous/remote commit port
   * would reopen a policy/revocation gap after the synchronous final fence and
   * is intentionally outside this reference profile.
   */
  commitPermit(ticket: SafeCodingExecutionTicket): KernelCommitPermit;
  failBeforeCommit(
    ticketId: string,
    reason: string,
  ): KernelTicketRecord | Promise<KernelTicketRecord>;
  settleTicket(input: {
    readonly ticketId: string;
    readonly status: KernelTerminalTicketStatus;
    readonly resultHash?: string | null;
    readonly reason?: string | null;
  }): KernelTicketRecord | Promise<KernelTicketRecord>;
  getTicket(
    ticketId: string,
  ): KernelTicketRecord | null | Promise<KernelTicketRecord | null>;
}

export interface SafeCodingEvidenceSink {
  record(attestation: SafeCodingEffectAttestation): void | Promise<void>;
}

export interface SafeCodingRuntimeClockPort {
  now(): string;
}

export interface SafeCodingRuntimeIdPort {
  nextAttestationId(): string;
}

export interface SafeCodingRuntimeRunnerIdentity {
  readonly runnerId: string;
  readonly runnerDigest: string;
  readonly observerId: string;
}

export interface ReferenceSafeCodingRuntimeDependencies {
  readonly guardian: SafeCodingRuntimeGuardianPort;
  readonly kernel: SafeCodingRuntimeKernelPort;
  readonly adapters: SafeCodingRuntimeAdapterRegistryPort;
  readonly hash: HashPort;
  readonly clock: SafeCodingRuntimeClockPort;
  readonly ids: SafeCodingRuntimeIdPort;
  readonly evidence: SafeCodingEvidenceSink;
  readonly runner: SafeCodingRuntimeRunnerIdentity;
}

export interface SafeCodingRuntimeExecutionInput {
  readonly signedContract: unknown;
  readonly action: unknown;
}

export interface SafeCodingRuntimeResult {
  readonly ticket: SafeCodingExecutionTicket;
  readonly result: CanonicalJsonValue;
  readonly attestation: SafeCodingEffectAttestation;
}

export type SafeCodingRuntimeErrorCode =
  | 'action-hash-mismatch'
  | 'adapter-binding-mismatch'
  | 'adapter-failed-before-effect'
  | 'adapter-failed-after-commit'
  | 'attestation-sink-unavailable'
  | 'result-unavailable'
  | 'runtime-state-invalid';

export class SafeCodingRuntimeError extends Error {
  public constructor(
    public readonly code: SafeCodingRuntimeErrorCode,
    message: string,
    public readonly terminalStatus: KernelTerminalTicketStatus | null,
    public readonly ticket: SafeCodingExecutionTicket | null,
    public readonly attestation: SafeCodingEffectAttestation | null,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'SafeCodingRuntimeError';
  }
}

/**
 * Non-durable reference orchestrator for the Session 5 recording-only slice.
 *
 * Constructor ports form the stable TCB. The class has no platform imports and
 * cannot itself access a host filesystem, Git repository, shell, process,
 * network, credential, or promotion control.
 */
export class ReferenceSafeCodingRuntime {
  public readonly durability = REFERENCE_SAFE_CODING_RUNTIME_PROFILE.durability;
  public readonly executionMode =
    REFERENCE_SAFE_CODING_RUNTIME_PROFILE.executionMode;
  public readonly promotion = REFERENCE_SAFE_CODING_RUNTIME_PROFILE.promotion;

  readonly #dependencies: ReferenceSafeCodingRuntimeDependencies;

  public constructor(dependencies: ReferenceSafeCodingRuntimeDependencies) {
    this.#dependencies = snapshotRuntimeDependencies(dependencies);
  }

  public async execute(
    input: SafeCodingRuntimeExecutionInput,
  ): Promise<SafeCodingRuntimeResult> {
    const action = validateSafeCodingAction(input.action);
    const startedAt = this.readClock();
    const attestationId = this.nextAttestationId();
    const ticket = await this.#dependencies.guardian.issueExecutionTicket({
      signedContract: input.signedContract,
      action,
    });

    let recomputedActionHash: string;
    try {
      recomputedActionHash = await hashSafeCodingAction(
        action,
        this.#dependencies.hash,
      );
    } catch (error) {
      return await this.failBeforeEffect({
        code: 'action-hash-mismatch',
        message: 'Runtime could not recompute the issued action hash',
        reason: 'runtime-action-hash-failed',
        ticket,
        action,
        startedAt,
        attestationId,
        cause: error,
      });
    }
    if (recomputedActionHash !== ticket.actionHash) {
      return await this.failBeforeEffect({
        code: 'action-hash-mismatch',
        message: 'Runtime action hash does not match the issued ticket',
        reason: 'runtime-action-hash-mismatch',
        ticket,
        action,
        startedAt,
        attestationId,
      });
    }

    let adapterCandidate: SafeCodingRuntimeAdapter | null;
    try {
      adapterCandidate = await this.#dependencies.adapters.resolve(action);
    } catch (error) {
      return await this.failBeforeEffect({
        code: 'adapter-binding-mismatch',
        message: 'Trusted runtime adapter registry failed closed',
        reason: 'runtime-adapter-registry-failed',
        ticket,
        action,
        startedAt,
        attestationId,
        cause: error,
      });
    }
    if (!adapterCandidate) {
      return await this.failBeforeEffect({
        code: 'adapter-binding-mismatch',
        message: 'Trusted runtime adapter is unavailable',
        reason: 'runtime-adapter-unavailable',
        ticket,
        action,
        startedAt,
        attestationId,
      });
    }
    let adapter: SafeCodingRuntimeAdapter;
    try {
      adapter = pinAdapter(adapterCandidate);
    } catch (error) {
      return await this.failBeforeEffect({
        code: 'adapter-binding-mismatch',
        message: 'Trusted runtime adapter could not be pinned',
        reason: 'runtime-adapter-pin-failed',
        ticket,
        action,
        startedAt,
        attestationId,
        cause: error,
      });
    }
    if (!adapterExactlyMatches(adapter, action, ticket)) {
      return await this.failBeforeEffect({
        code: 'adapter-binding-mismatch',
        message: 'Runtime adapter does not exactly match the issued ticket',
        reason: 'runtime-adapter-binding-mismatch',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
      });
    }

    let preparedCandidate: PreparedRuntimeEffect;
    try {
      preparedCandidate = await adapter.prepare({ action, ticket });
    } catch (error) {
      return await this.failBeforeEffect({
        code: 'adapter-failed-before-effect',
        message: 'Adapter PREPARE failed before any effect was authorized',
        reason: 'adapter-prepare-failed',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
        cause: error,
      });
    }

    let prepared: PreparedRuntimeEffect;
    try {
      prepared = pinPreparedEffect(preparedCandidate);
    } catch (error) {
      return await this.failBeforeEffect({
        code: 'adapter-failed-before-effect',
        message: 'Adapter returned an invalid prepared effect',
        reason: 'adapter-prepared-effect-invalid',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
        cause: error,
      });
    }

    let permit: KernelCommitPermit | null = null;
    let finalFenceThrew = false;
    let finalFenceFailure: unknown;
    try {
      await this.#dependencies.guardian.revalidateExecutionTicket(
        ticket,
        action,
      );
      this.#dependencies.guardian.assertFinalAuthority(ticket, action);
      permit = this.#dependencies.kernel.commitPermit(ticket);
    } catch (error) {
      finalFenceThrew = true;
      finalFenceFailure = error;
    }

    if (finalFenceThrew) {
      const ticketRecord = await this.requireTicket(ticket.ticketId);
      if (hasCrossedCommitPermit(ticketRecord)) {
        return await this.failAfterCommit({
          code: 'runtime-state-invalid',
          message: 'The final execution fence failed after COMMIT_PERMIT',
          reason: 'final-execution-fence-failed-after-commit-permit',
          ticket,
          action,
          adapter,
          startedAt,
          attestationId,
          cause: finalFenceFailure,
        });
      }
      return await this.failBeforeEffect({
        code: 'adapter-failed-before-effect',
        message: 'The runtime final execution fence denied the prepared effect',
        reason: ticketRecord.terminalReason ?? 'final-execution-fence-denied',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
        cause: finalFenceFailure,
      });
    }

    if (!permit || !permitExactlyMatches(permit, ticket)) {
      const ticketRecord = await this.requireTicket(ticket.ticketId);
      if (!hasCrossedCommitPermit(ticketRecord)) {
        return await this.failBeforeEffect({
          code: 'runtime-state-invalid',
          message:
            'Kernel returned no exact COMMIT_PERMIT for the prepared effect',
          reason: 'runtime-commit-permit-invalid',
          ticket,
          action,
          adapter,
          startedAt,
          attestationId,
        });
      }
      return await this.failAfterCommit({
        code: 'runtime-state-invalid',
        message:
          'Kernel returned a malformed COMMIT_PERMIT after consuming authority',
        reason: 'runtime-commit-permit-invalid-after-consumption',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
      });
    }

    let adapterResult: SafeCodingRuntimeAdapterResult | null = null;
    let executeThrew = false;
    let executeFailure: unknown;
    try {
      adapterResult = await prepared.execute();
    } catch (error) {
      executeThrew = true;
      executeFailure = error;
    }
    if (executeThrew) {
      return await this.failAfterCommit({
        code: 'adapter-failed-after-commit',
        message:
          'Prepared effect failed after COMMIT_PERMIT; retry is forbidden',
        reason: 'prepared-effect-failed-after-commit-permit',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
        cause: executeFailure,
      });
    }

    const ticketRecord = await this.requireTicket(ticket.ticketId);
    if (ticketRecord.status !== 'commit-permit') {
      return await this.failAfterCommit({
        code: 'runtime-state-invalid',
        message: 'Kernel state diverged after the prepared effect executed',
        reason: 'runtime-commit-permit-state-invalid',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
      });
    }

    let observedResult: ObservedSafeCodingRuntimeAdapterResult;
    try {
      observedResult = validateAdapterResultObservation(adapterResult);
    } catch (error) {
      return await this.failAfterCommit({
        code: 'result-unavailable',
        message:
          'Effect crossed COMMIT_PERMIT but the adapter returned no trustworthy observation',
        reason: 'adapter-result-observation-invalid',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
        cause: error,
      });
    }

    let normalizedResult: SafeCodingRuntimeAdapterResult;
    let resultHash: string;
    try {
      normalizedResult = finalizeAdapterResult(observedResult);
      resultHash = await hashAdapterResult(
        normalizedResult.result,
        this.#dependencies.hash,
      );
    } catch (error) {
      if (
        observedResult.evidenceLevel === 'attempt_only' ||
        observedResult.postStateHash === null
      ) {
        return await this.failAfterCommit({
          code: 'result-unavailable',
          message:
            'Effect crossed COMMIT_PERMIT but no observed post-state can support result-unavailable closure',
          reason: 'result-unavailable-without-observed-post-state',
          ticket,
          action,
          adapter,
          startedAt,
          attestationId,
          cause: error,
        });
      }
      return await this.failResultUnavailable({
        code: 'result-unavailable',
        message:
          'Effect crossed COMMIT_PERMIT but its result could not be canonically finalized',
        reason: 'result-serialization-or-hash-failed',
        ticket,
        action,
        adapter,
        startedAt,
        attestationId,
        observation: observedResult,
        cause: error,
      });
    }

    const attestation = this.createAttestation({
      attestationId,
      ticket,
      action,
      adapter,
      startedAt,
      status: 'committed',
      evidenceLevel: normalizedResult.evidenceLevel,
      preStateHash: normalizedResult.preStateHash,
      postStateHash: normalizedResult.postStateHash,
      resultHash,
      reconciliationRef: null,
    });

    // Evidence admission precedes the final `committed` publication in this
    // non-durable reference adapter. If the sink fails after the simulated
    // effect, the ticket is conservatively closed as result-unavailable rather
    // than publishing a success that has no admitted attestation.
    try {
      await this.#dependencies.evidence.record(attestation);
    } catch (error) {
      const hasObservedPostState =
        normalizedResult.evidenceLevel !== 'attempt_only' &&
        normalizedResult.postStateHash !== null;
      await this.settleIfNeeded(ticket.ticketId, {
        status: hasObservedPostState ? 'result-unavailable' : 'uncertain',
        resultHash: hasObservedPostState ? resultHash : null,
        reason: 'attestation-sink-unavailable-after-effect',
      });
      const fallback = this.createAttestation({
        attestationId,
        ticket,
        action,
        adapter,
        startedAt,
        status: hasObservedPostState
          ? 'committed_result_unavailable'
          : 'uncertain',
        evidenceLevel: hasObservedPostState
          ? normalizedResult.evidenceLevel
          : 'attempt_only',
        preStateHash: hasObservedPostState
          ? normalizedResult.preStateHash
          : null,
        postStateHash: hasObservedPostState
          ? normalizedResult.postStateHash
          : null,
        resultHash: null,
        reconciliationRef: null,
      });
      throw new SafeCodingRuntimeError(
        'attestation-sink-unavailable',
        'Effect completed but attestation admission failed; retry is forbidden',
        hasObservedPostState ? 'result-unavailable' : 'uncertain',
        ticket,
        fallback,
        error,
      );
    }

    try {
      await this.#dependencies.kernel.settleTicket({
        ticketId: ticket.ticketId,
        status: 'committed',
        resultHash,
        reason: null,
      });
    } catch (error) {
      await this.settleIfNeeded(ticket.ticketId, {
        status: 'uncertain',
        resultHash,
        reason: 'kernel-settlement-failed-after-effect',
      });
      throw new SafeCodingRuntimeError(
        'runtime-state-invalid',
        'Effect and evidence completed but terminal kernel settlement failed',
        'uncertain',
        ticket,
        attestation,
        error,
      );
    }

    return Object.freeze({
      ticket,
      result: parseCanonicalJson(canonicalizeJson(normalizedResult.result)),
      attestation,
    });
  }

  private async failBeforeEffect(input: {
    code: SafeCodingRuntimeErrorCode;
    message: string;
    reason: string;
    ticket: SafeCodingExecutionTicket;
    action: SafeCodingAction;
    adapter?: SafeCodingRuntimeAdapter;
    startedAt: string;
    attestationId: string;
    cause?: unknown;
  }): Promise<never> {
    let record = await this.requireTicket(input.ticket.ticketId);
    if (record.status === 'commit-permit') {
      return await this.failAfterCommit({
        ...input,
        code: 'adapter-failed-after-commit',
        message:
          'Pre-effect failure raced with COMMIT_PERMIT; outcome is uncertain',
        reason: 'pre-effect-failure-after-commit-permit',
      });
    }
    if (record.status === 'registered') {
      try {
        record = await this.#dependencies.kernel.failBeforeCommit(
          input.ticket.ticketId,
          input.reason,
        );
      } catch (error) {
        record = await this.requireTicket(input.ticket.ticketId);
        if (record.status === 'commit-permit') {
          return await this.failAfterCommit({
            ...input,
            code: 'adapter-failed-after-commit',
            message:
              'Pre-effect failure raced with COMMIT_PERMIT; outcome is uncertain',
            reason: 'pre-effect-failure-raced-with-commit-permit',
            cause: error,
          });
        }
        if (record.status !== 'failed-no-effect') throw error;
      }
    }
    if (record.status !== 'failed-no-effect') {
      throw new SafeCodingRuntimeError(
        'runtime-state-invalid',
        'Kernel did not preserve a failed-no-effect terminal state',
        isTerminalStatus(record.status) ? record.status : null,
        input.ticket,
        null,
        input.cause,
      );
    }
    const attestation = this.createAttestation({
      attestationId: input.attestationId,
      ticket: input.ticket,
      action: input.action,
      adapter: input.adapter,
      startedAt: input.startedAt,
      status: 'failed_no_effect',
      evidenceLevel: 'attempt_only',
      preStateHash: null,
      postStateHash: null,
      resultHash: null,
      reconciliationRef: null,
      budgetCharges: zeroBudgetCharge(),
    });
    try {
      await this.#dependencies.evidence.record(attestation);
    } catch (error) {
      throw new SafeCodingRuntimeError(
        'attestation-sink-unavailable',
        'No effect occurred, but its failed-no-effect attestation was unavailable',
        'failed-no-effect',
        input.ticket,
        attestation,
        error,
      );
    }
    throw new SafeCodingRuntimeError(
      input.code,
      input.message,
      'failed-no-effect',
      input.ticket,
      attestation,
      input.cause,
    );
  }

  private async failAfterCommit(input: {
    code: SafeCodingRuntimeErrorCode;
    message: string;
    reason: string;
    ticket: SafeCodingExecutionTicket;
    action: SafeCodingAction;
    adapter?: SafeCodingRuntimeAdapter;
    startedAt: string;
    attestationId: string;
    cause?: unknown;
  }): Promise<never> {
    await this.settleIfNeeded(input.ticket.ticketId, {
      status: 'uncertain',
      resultHash: null,
      reason: input.reason,
    });
    const attestation = this.createAttestation({
      attestationId: input.attestationId,
      ticket: input.ticket,
      action: input.action,
      adapter: input.adapter,
      startedAt: input.startedAt,
      status: 'uncertain',
      evidenceLevel: 'attempt_only',
      preStateHash: null,
      postStateHash: null,
      resultHash: null,
      reconciliationRef: null,
    });
    try {
      await this.#dependencies.evidence.record(attestation);
    } catch (error) {
      throw new SafeCodingRuntimeError(
        'attestation-sink-unavailable',
        'Effect outcome is uncertain and attestation admission also failed',
        'uncertain',
        input.ticket,
        attestation,
        error,
      );
    }
    throw new SafeCodingRuntimeError(
      input.code,
      input.message,
      'uncertain',
      input.ticket,
      attestation,
      input.cause,
    );
  }

  private async failResultUnavailable(input: {
    code: SafeCodingRuntimeErrorCode;
    message: string;
    reason: string;
    ticket: SafeCodingExecutionTicket;
    action: SafeCodingAction;
    adapter: SafeCodingRuntimeAdapter;
    startedAt: string;
    attestationId: string;
    observation: ObservedSafeCodingRuntimeAdapterResult;
    cause?: unknown;
  }): Promise<never> {
    await this.settleIfNeeded(input.ticket.ticketId, {
      status: 'result-unavailable',
      resultHash: null,
      reason: input.reason,
    });
    const attestation = this.createAttestation({
      attestationId: input.attestationId,
      ticket: input.ticket,
      action: input.action,
      adapter: input.adapter,
      startedAt: input.startedAt,
      status: 'committed_result_unavailable',
      evidenceLevel: input.observation.evidenceLevel,
      preStateHash: input.observation.preStateHash,
      postStateHash: input.observation.postStateHash,
      resultHash: null,
      reconciliationRef: null,
    });
    try {
      await this.#dependencies.evidence.record(attestation);
    } catch (error) {
      throw new SafeCodingRuntimeError(
        'attestation-sink-unavailable',
        'Result is unavailable and its attestation could not be admitted',
        'result-unavailable',
        input.ticket,
        attestation,
        error,
      );
    }
    throw new SafeCodingRuntimeError(
      input.code,
      input.message,
      'result-unavailable',
      input.ticket,
      attestation,
      input.cause,
    );
  }

  private createAttestation(input: {
    attestationId: string;
    ticket: SafeCodingExecutionTicket;
    action: SafeCodingAction;
    adapter?: SafeCodingRuntimeAdapter;
    startedAt: string;
    status: SafeCodingEffectAttestation['status'];
    evidenceLevel: SafeCodingEvidenceLevel;
    preStateHash: string | null;
    postStateHash: string | null;
    resultHash: string | null;
    reconciliationRef: string | null;
    budgetCharges?: SafeCodingEffectAttestation['budgetCharges'];
  }): SafeCodingEffectAttestation {
    const binding = input.adapter?.binding;
    return validateSafeCodingEffectAttestation({
      kind: EFFECT_ATTESTATION_KIND,
      specVersion: INTENT_CONTRACT_SPEC_VERSION,
      attestationId: input.attestationId,
      requestId: input.ticket.requestId,
      ticketId: input.ticket.ticketId,
      contractHash: input.ticket.contractHash,
      contractRevision: input.ticket.contractRevision,
      actionHash: input.ticket.actionHash,
      delegationLineageHash: input.ticket.contractHash,
      adapterId: binding?.adapterId ?? input.ticket.adapterId,
      adapterDigest: binding?.adapterDigest ?? input.ticket.adapterDigest,
      runnerId: this.#dependencies.runner.runnerId,
      runnerDigest: this.#dependencies.runner.runnerDigest,
      executorId: input.ticket.audience.executorId,
      observerId: this.#dependencies.runner.observerId,
      effectClass: binding?.effectClass ?? input.ticket.effectClass,
      registryDigest: input.ticket.registryDigest,
      revocationEpoch: input.ticket.revocationEpoch,
      preStateHash: input.preStateHash,
      postStateHash: input.postStateHash,
      idempotencyKey: null,
      resultHash: input.resultHash,
      budgetCharges: input.budgetCharges ?? budgetChargeForAction(input.action),
      startedAt: input.startedAt,
      finishedAt: this.readClock(),
      status: input.status,
      evidenceLevel: input.evidenceLevel,
      reconciliationRef: input.reconciliationRef,
    });
  }

  private async settleIfNeeded(
    ticketId: string,
    settlement: {
      status: KernelTerminalTicketStatus;
      resultHash: string | null;
      reason: string;
    },
  ): Promise<KernelTicketRecord> {
    const current = await this.requireTicket(ticketId);
    if (isTerminalStatus(current.status)) return current;
    if (current.status !== 'commit-permit') {
      throw new SafeCodingRuntimeError(
        'runtime-state-invalid',
        'A post-effect settlement requires an exact COMMIT_PERMIT state',
        null,
        current.ticket,
        null,
      );
    }
    return await this.#dependencies.kernel.settleTicket({
      ticketId,
      status: settlement.status,
      resultHash: settlement.resultHash,
      reason: settlement.reason,
    });
  }

  private async requireTicket(ticketId: string): Promise<KernelTicketRecord> {
    const record = await this.#dependencies.kernel.getTicket(ticketId);
    if (!record) {
      throw new SafeCodingRuntimeError(
        'runtime-state-invalid',
        'Kernel lost the registered execution ticket',
        null,
        null,
        null,
      );
    }
    return record;
  }

  private readClock(): string {
    return requireTimestamp(this.#dependencies.clock.now(), 'Runtime clock');
  }

  private nextAttestationId(): string {
    const id = this.#dependencies.ids.nextAttestationId();
    if (!UUID_PATTERN.test(id)) {
      throw new SafeCodingRuntimeError(
        'runtime-state-invalid',
        'Runtime attestation ID port returned a non-canonical UUID',
        null,
        null,
        null,
      );
    }
    return id;
  }
}

function adapterExactlyMatches(
  adapter: SafeCodingRuntimeAdapter,
  action: SafeCodingAction,
  ticket: SafeCodingExecutionTicket,
): boolean {
  return (
    adapter.binding.action === action.action &&
    adapter.binding.adapterId === ticket.adapterId &&
    adapter.binding.adapterDigest === ticket.adapterDigest &&
    adapter.binding.policyDigest === ticket.policyDigest &&
    adapter.binding.adapterRegistryDigest === ticket.registryDigest &&
    adapter.binding.runnerRegistryDigest === ticket.runnerRegistryDigest &&
    adapter.binding.effectRegistryDigest === ticket.effectRegistryDigest &&
    adapter.binding.effectClass === ticket.effectClass
  );
}

function pinAdapter(
  adapter: SafeCodingRuntimeAdapter,
): SafeCodingRuntimeAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    throw new Error('Runtime adapter must be an object');
  }
  const bindingValue = readOwnDataValue(adapter, 'binding');
  const binding = snapshotRuntimeAdapterBinding(bindingValue);
  return Object.freeze({
    binding,
    prepare: pinRuntimePortMethod(adapter, 'prepare', 'Runtime adapter'),
  });
}

function snapshotRuntimeAdapterBinding(
  value: unknown,
): TrustedSafeCodingAdapterBinding {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactOwnEnumerableDataFields(value, [
      'action',
      'adapterDigest',
      'adapterId',
      'adapterRegistryDigest',
      'effectClass',
      'effectRegistryDigest',
      'policyDigest',
      'runnerRegistryDigest',
    ])
  ) {
    throw new Error(
      'Runtime adapter binding must be a closed data-only object',
    );
  }
  const action = readOwnDataValue(value, 'action');
  const effectClass = readOwnDataValue(value, 'effectClass');
  if (typeof action !== 'string') {
    throw new Error('Runtime adapter action must be a string');
  }
  if (
    effectClass !== 'local.observation' &&
    effectClass !== 'local.reversible' &&
    effectClass !== 'sandbox.ephemeral'
  ) {
    throw new Error('Runtime adapter effect class is unsupported');
  }
  return Object.freeze({
    action: action as SafeCodingAction['action'],
    policyDigest: requireDigest(
      readOwnDataValue(value, 'policyDigest'),
      'Adapter policy digest',
    ),
    adapterId: requireIdentifier(
      readOwnDataValue(value, 'adapterId'),
      'Adapter ID',
    ),
    adapterDigest: requireDigest(
      readOwnDataValue(value, 'adapterDigest'),
      'Adapter digest',
    ),
    adapterRegistryDigest: requireDigest(
      readOwnDataValue(value, 'adapterRegistryDigest'),
      'Adapter registry digest',
    ),
    runnerRegistryDigest: requireDigest(
      readOwnDataValue(value, 'runnerRegistryDigest'),
      'Runner registry digest',
    ),
    effectRegistryDigest: requireDigest(
      readOwnDataValue(value, 'effectRegistryDigest'),
      'Effect registry digest',
    ),
    effectClass,
  });
}

function pinPreparedEffect(value: unknown): PreparedRuntimeEffect {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactOwnEnumerableDataFields(value, ['execute'])
  ) {
    throw new Error('Prepared runtime effect must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'execute');
  if (!descriptor || !('value' in descriptor)) {
    throw new Error(
      'Prepared runtime effect execute must be an own data field',
    );
  }
  const execute = descriptor.value;
  if (typeof execute !== 'function') {
    throw new Error('Prepared runtime effect must expose execute()');
  }
  return Object.freeze({ execute: execute.bind(value) });
}

function permitExactlyMatches(
  permit: KernelCommitPermit,
  ticket: SafeCodingExecutionTicket,
): boolean {
  if (!isClosedCommitPermit(permit)) return false;
  return (
    permit.ticketId === ticket.ticketId &&
    permit.requestId === ticket.requestId &&
    permit.contractHash === ticket.contractHash &&
    permit.contractRevision === ticket.contractRevision &&
    permit.revocationEpoch === ticket.revocationEpoch &&
    permit.budgetReservationId === ticket.budgetReservationId &&
    timestampIsWithinTicket(permit.permittedAt, ticket)
  );
}

function isClosedCommitPermit(value: unknown): value is KernelCommitPermit {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const expected = [
    'budgetReservationId',
    'contractHash',
    'contractRevision',
    'permittedAt',
    'requestId',
    'revocationEpoch',
    'ticketId',
  ];
  return hasExactOwnEnumerableDataFields(value, expected);
}

function hasExactOwnEnumerableDataFields(
  value: object,
  expectedFields: readonly string[],
): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  if (
    names.length !== expectedFields.length ||
    names.some((name, index) => name !== expectedFields[index])
  ) {
    return false;
  }
  for (const name of expectedFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function timestampIsWithinTicket(
  value: unknown,
  ticket: SafeCodingExecutionTicket,
): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== value) return false;
  return (
    milliseconds >= Date.parse(ticket.issuedAt) &&
    milliseconds < Date.parse(ticket.expiresAt)
  );
}

function hasCrossedCommitPermit(record: KernelTicketRecord): boolean {
  return (
    record.status === 'commit-permit' ||
    record.status === 'committed' ||
    record.status === 'result-unavailable' ||
    record.status === 'uncertain'
  );
}

function budgetChargeForAction(action: SafeCodingAction): {
  uniqueModifiedFiles: number;
  mutationBytes: number;
  testRuns: number;
} {
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

function zeroBudgetCharge(): SafeCodingEffectAttestation['budgetCharges'] {
  return Object.freeze({
    uniqueModifiedFiles: 0,
    mutationBytes: 0,
    testRuns: 0,
  });
}

function validateAdapterResultObservation(
  value: unknown,
): ObservedSafeCodingRuntimeAdapterResult {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new Error('Adapter result must be a closed object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(record).sort();
  const expected = ['evidenceLevel', 'postStateHash', 'preStateHash', 'result'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error('Adapter result has unknown or missing fields');
  }
  const values = new Map<string, unknown>();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error('Adapter result fields must be enumerable data fields');
    }
    values.set(key, descriptor.value);
  }
  const evidenceLevel = values.get('evidenceLevel');
  if (
    evidenceLevel !== 'attempt_only' &&
    evidenceLevel !== 'adapter_observed' &&
    evidenceLevel !== 'local_state_reconciled' &&
    evidenceLevel !== 'remote_provider_attested' &&
    evidenceLevel !== 'independently_reconciled'
  ) {
    throw new Error('Adapter result evidence level is invalid');
  }
  return Object.freeze({
    result: values.get('result'),
    preStateHash: optionalDigest(
      values.get('preStateHash'),
      'Adapter pre-state hash',
    ),
    postStateHash: optionalDigest(
      values.get('postStateHash'),
      'Adapter post-state hash',
    ),
    evidenceLevel,
  });
}

function finalizeAdapterResult(
  observation: ObservedSafeCodingRuntimeAdapterResult,
): SafeCodingRuntimeAdapterResult {
  return Object.freeze({
    result: parseCanonicalJson(canonicalizeJson(observation.result)),
    preStateHash: observation.preStateHash,
    postStateHash: observation.postStateHash,
    evidenceLevel: observation.evidenceLevel,
  });
}

async function hashAdapterResult(
  result: CanonicalJsonValue,
  hash: HashPort,
): Promise<string> {
  const digest = await hash.sha256(
    encodeUtf8(`${RESULT_HASH_DOMAIN}\0${canonicalizeJson(result)}`),
  );
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error('Result HashPort output is not a SHA-256 digest');
  }
  return digest;
}

function optionalDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be null or a lowercase SHA-256 digest`);
  }
  return value;
}

function isTerminalStatus(
  status: KernelTicketRecord['status'],
): status is KernelTerminalTicketStatus {
  return (
    status === 'failed-no-effect' ||
    status === 'committed' ||
    status === 'result-unavailable' ||
    status === 'uncertain'
  );
}

function snapshotRuntimeDependencies(
  dependencies: ReferenceSafeCodingRuntimeDependencies,
): ReferenceSafeCodingRuntimeDependencies {
  if (!dependencies || typeof dependencies !== 'object') {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      'Reference runtime requires complete stable constructor ports',
      null,
      null,
      null,
    );
  }
  const guardian = readRuntimeDependency<SafeCodingRuntimeGuardianPort>(
    dependencies,
    'guardian',
    'Guardian port',
  );
  const kernel = readRuntimeDependency<SafeCodingRuntimeKernelPort>(
    dependencies,
    'kernel',
    'Kernel port',
  );
  const adapters = readRuntimeDependency<SafeCodingRuntimeAdapterRegistryPort>(
    dependencies,
    'adapters',
    'Adapter registry port',
  );
  const hash = readRuntimeDependency<HashPort>(
    dependencies,
    'hash',
    'Hash port',
  );
  const clock = readRuntimeDependency<SafeCodingRuntimeClockPort>(
    dependencies,
    'clock',
    'Clock port',
  );
  const ids = readRuntimeDependency<SafeCodingRuntimeIdPort>(
    dependencies,
    'ids',
    'ID port',
  );
  const evidence = readRuntimeDependency<SafeCodingEvidenceSink>(
    dependencies,
    'evidence',
    'Evidence sink',
  );
  const runner = snapshotRunnerIdentity(
    readRuntimeDependency<SafeCodingRuntimeRunnerIdentity>(
      dependencies,
      'runner',
      'Runner identity',
    ),
  );
  return Object.freeze({
    guardian: Object.freeze({
      issueExecutionTicket: pinRuntimePortMethod(
        guardian,
        'issueExecutionTicket',
        'Guardian port',
      ),
      revalidateExecutionTicket: pinRuntimePortMethod(
        guardian,
        'revalidateExecutionTicket',
        'Guardian port',
      ),
      assertFinalAuthority: pinRuntimePortMethod(
        guardian,
        'assertFinalAuthority',
        'Guardian port',
      ),
    }),
    kernel: Object.freeze({
      commitPermit: pinRuntimePortMethod(kernel, 'commitPermit', 'Kernel port'),
      failBeforeCommit: pinRuntimePortMethod(
        kernel,
        'failBeforeCommit',
        'Kernel port',
      ),
      settleTicket: pinRuntimePortMethod(kernel, 'settleTicket', 'Kernel port'),
      getTicket: pinRuntimePortMethod(kernel, 'getTicket', 'Kernel port'),
    }),
    adapters: Object.freeze({
      resolve: pinRuntimePortMethod(
        adapters,
        'resolve',
        'Adapter registry port',
      ),
    }),
    hash: Object.freeze({
      sha256: pinRuntimePortMethod(hash, 'sha256', 'Hash port'),
    }),
    clock: Object.freeze({
      now: pinRuntimePortMethod(clock, 'now', 'Clock port'),
    }),
    ids: Object.freeze({
      nextAttestationId: pinRuntimePortMethod(
        ids,
        'nextAttestationId',
        'ID port',
      ),
    }),
    evidence: Object.freeze({
      record: pinRuntimePortMethod(evidence, 'record', 'Evidence sink'),
    }),
    runner,
  });
}

function readRuntimeDependency<T>(
  dependencies: object,
  name: string,
  label: string,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
  if (!descriptor || !('value' in descriptor)) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} must be an own data field`,
      null,
      null,
      null,
    );
  }
  return descriptor.value as T;
}

function pinRuntimePortMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (
    port === null ||
    (typeof port !== 'object' && typeof port !== 'function')
  ) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} is required`,
      null,
      null,
      null,
    );
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new SafeCodingRuntimeError(
          'runtime-state-invalid',
          `${label} ${String(name)} must be a data method`,
          null,
          null,
          null,
        );
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new SafeCodingRuntimeError(
    'runtime-state-invalid',
    `${label} must provide ${String(name)}()`,
    null,
    null,
    null,
  );
}

function snapshotRunnerIdentity(
  value: SafeCodingRuntimeRunnerIdentity,
): SafeCodingRuntimeRunnerIdentity {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactOwnEnumerableDataFields(value, [
      'observerId',
      'runnerDigest',
      'runnerId',
    ])
  ) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      'Runner identity must be a closed data-only object',
      null,
      null,
      null,
    );
  }
  const runnerId = readOwnDataValue(value, 'runnerId');
  const runnerDigest = readOwnDataValue(value, 'runnerDigest');
  const observerId = readOwnDataValue(value, 'observerId');
  return Object.freeze({
    runnerId: requireIdentifier(runnerId, 'Runner ID'),
    runnerDigest: requireDigest(runnerDigest, 'Runner digest'),
    observerId: requireIdentifier(observerId, 'Observer ID'),
  });
}

function readOwnDataValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor)) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${name} must be an own data field`,
      null,
      null,
      null,
    );
  }
  return descriptor.value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} is not a canonical identifier`,
      null,
      null,
      null,
    );
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} is not a lowercase SHA-256 digest`,
      null,
      null,
      null,
    );
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} is not canonical UTC`,
      null,
      null,
      null,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} is not a real timestamp`,
      null,
      null,
      null,
    );
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== value) {
    throw new SafeCodingRuntimeError(
      'runtime-state-invalid',
      `${label} is not canonical UTC`,
      null,
      null,
      null,
    );
  }
  return value;
}
