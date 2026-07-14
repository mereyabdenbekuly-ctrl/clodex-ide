import { canonicalizeJson } from '@clodex/contracts';
import type {
  SafeCodingExecutionTicket,
  VerifiedIntentContract,
} from '@clodex/contracts';
import {
  createEmptySafeCodingKernelState,
  type ActivateKernelContractInput,
  type KernelActiveContractSnapshot,
  type KernelBudgetUsage,
  type KernelCommitPermit,
  type KernelContractCasExpectation,
  type KernelTicketRecord,
  type KernelTicketRegistration,
  type RevokeKernelContractInput,
  type SafeCodingKernelState,
  type SettleKernelTicketInput,
} from './state.js';
import {
  activateContractTransition,
  commitPermitTransition,
  failBeforeCommitTransition,
  registerTicketTransition,
  revokeContractTransition,
  settleTicketTransition,
} from './transitions.js';

export interface SafeCodingKernelClock {
  now(): string;
}

export interface InMemorySafeCodingKernelOptions {
  readonly clock?: SafeCodingKernelClock;
  readonly initialState?: SafeCodingKernelState;
}

const systemClock: SafeCodingKernelClock = {
  now: () => canonicalTimestamp(new Date()),
};

/**
 * Synchronous reference adapter for the pure kernel transitions.
 *
 * This adapter provides an atomic assignment boundary inside one JavaScript
 * isolate. It deliberately makes no durability, multi-process, or crash-safety
 * claim; a durable implementation must apply the same transitions inside its
 * own transaction and compare-and-swap boundary.
 */
export class InMemorySafeCodingKernel {
  public readonly durability = 'memory-only' as const;

  readonly #clock: SafeCodingKernelClock;
  #state: SafeCodingKernelState;

  public constructor(options: InMemorySafeCodingKernelOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#state = clonePlainData(
      options.initialState ?? createEmptySafeCodingKernelState(),
    );
  }

  public activateContract(input: {
    readonly verifiedContract: VerifiedIntentContract;
    readonly expectedPrevious: KernelContractCasExpectation | null;
  }): KernelActiveContractSnapshot {
    const transitionInput: ActivateKernelContractInput = {
      ...input,
      now: this.#clock.now(),
    };
    const nextState = activateContractTransition(this.#state, transitionInput);
    this.#state = nextState;
    return this.requireContractSnapshot(
      transitionInput.verifiedContract.contract.contractId,
    );
  }

  public revokeContract(
    input: Omit<RevokeKernelContractInput, 'now'>,
  ): KernelActiveContractSnapshot {
    const nextState = revokeContractTransition(this.#state, {
      ...input,
      now: this.#clock.now(),
    });
    this.#state = nextState;
    return this.requireContractSnapshot(input.contractId);
  }

  /** Guardian-compatible state-port method. */
  public getActiveContract(
    contractId: string,
  ): KernelActiveContractSnapshot | null {
    const lineage = this.#state.lineages[contractId];
    if (!lineage) return null;
    const current = lineage.revisions.find(
      (revision) => revision.contractHash === lineage.currentContractHash,
    );
    if (!current) return null;
    return {
      contractId,
      contractHash: current.contractHash,
      revision: current.revision,
      revocationEpoch: lineage.revocationEpoch,
      status: current.status,
    };
  }

  /** Guardian-compatible state-port method. */
  public registerTicket(input: KernelTicketRegistration): void {
    const nextState = registerTicketTransition(this.#state, {
      ...input,
      now: this.#clock.now(),
    });
    this.#state = nextState;
  }

  public commitPermit(ticket: SafeCodingExecutionTicket): KernelCommitPermit {
    const outcome = commitPermitTransition(this.#state, {
      ticket,
      now: this.#clock.now(),
    });

    // Expiry and stale-authority failures consume the ticket as a durable
    // failed-no-effect terminal record. Publish that state before surfacing the
    // typed error to the caller.
    this.#state = outcome.state;
    if (!outcome.ok) throw outcome.error;
    return outcome.permit;
  }

  public failBeforeCommit(
    ticketId: string,
    reason: string,
  ): KernelTicketRecord {
    const nextState = failBeforeCommitTransition(this.#state, {
      ticketId,
      reason,
      now: this.#clock.now(),
    });
    this.#state = nextState;
    return this.requireTicket(ticketId);
  }

  public settleTicket(
    input: Omit<SettleKernelTicketInput, 'now'>,
  ): KernelTicketRecord {
    const nextState = settleTicketTransition(this.#state, {
      ...input,
      now: this.#clock.now(),
    });
    this.#state = nextState;
    return this.requireTicket(input.ticketId);
  }

  public getTicket(ticketId: string): KernelTicketRecord | null {
    const ticket = this.#state.tickets[ticketId];
    return ticket ? clonePlainData(ticket) : null;
  }

  public getBudget(contractId: string): KernelBudgetUsage | null {
    const budget = this.#state.lineages[contractId]?.budget;
    return budget ? clonePlainData(budget) : null;
  }

  /** Returns a detached, serializable point-in-time snapshot. */
  public snapshot(): SafeCodingKernelState {
    return clonePlainData(this.#state);
  }

  /** Alias that emphasizes handoff to a future durable adapter. */
  public exportState(): SafeCodingKernelState {
    return this.snapshot();
  }

  private requireContractSnapshot(
    contractId: string,
  ): KernelActiveContractSnapshot {
    const snapshot = this.getActiveContract(contractId);
    if (!snapshot) {
      throw new Error('Kernel transition did not publish its contract lineage');
    }
    return snapshot;
  }

  private requireTicket(ticketId: string): KernelTicketRecord {
    const ticket = this.getTicket(ticketId);
    if (!ticket) {
      throw new Error('Kernel transition did not publish its ticket record');
    }
    return ticket;
  }
}

function clonePlainData<Value>(value: Value): Value {
  return JSON.parse(canonicalizeJson(value)) as Value;
}

function canonicalTimestamp(value: Date): string {
  const timestamp = value.toISOString();
  return timestamp.endsWith('.000Z')
    ? timestamp.replace('.000Z', 'Z')
    : timestamp;
}
