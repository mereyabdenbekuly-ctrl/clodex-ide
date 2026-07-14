import { canonicalizeJson, parseCanonicalJson } from '@clodex/contracts';
import {
  cloneSafeCodingLedgerRecord,
  safeCodingLedgerIdentityKeys,
  validateSafeCodingLedgerRecord,
  type SafeCodingLedgerRecord,
} from './records.js';
import {
  SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION,
  type MemoryOnlyLedgerDurabilityContract,
  type SafeCodingLedgerPersistenceCasResult,
  type SafeCodingLedgerPersistenceMutation,
  type SafeCodingLedgerPersistenceTransactionPort,
} from './persistence.js';
import { assertSafeCodingLedgerSuccessor } from './transitions.js';

export const IN_MEMORY_SAFE_CODING_LEDGER_DURABILITY = Object.freeze({
  version: SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION,
  mode: 'memory-only',
  adapterId: 'clodex-ledger.in-memory-reference',
  atomicScope: 'single-js-isolate',
  atomicRecordAndOutbox: true,
  stableBeforeSuccess: false,
  restartReadable: false,
  multiProcessCas: false,
} satisfies MemoryOnlyLedgerDurabilityContract);

/**
 * Reference store only. It has an isolate-local atomic assignment boundary but
 * loses all records on process exit and makes no fsync, restart, or
 * multi-process safety claim.
 */
export class InMemorySafeCodingLedgerStore
  implements SafeCodingLedgerPersistenceTransactionPort
{
  public readonly durability = IN_MEMORY_SAFE_CODING_LEDGER_DURABILITY;

  readonly #records = new Map<string, SafeCodingLedgerRecord>();
  readonly #identities = new Map<string, string>();

  public async read(transactionId: string): Promise<unknown | null> {
    const record = this.#records.get(transactionId);
    return record ? cloneSafeCodingLedgerRecord(record) : null;
  }

  public async scan(): Promise<readonly unknown[]> {
    return [...this.#records.values()]
      .sort((left, right) =>
        compareStrings(left.transactionId, right.transactionId),
      )
      .map(cloneSafeCodingLedgerRecord);
  }

  public async compareAndSwap(
    mutation: SafeCodingLedgerPersistenceMutation,
  ): Promise<SafeCodingLedgerPersistenceCasResult> {
    const next = validateSafeCodingLedgerRecord(mutation.nextRecord);
    if (mutation.transactionId !== next.transactionId) {
      throw new Error('Persistence mutation key does not match ledger record');
    }
    const current = this.#records.get(mutation.transactionId) ?? null;
    if (mutation.expectedRevision === null) {
      if (current) {
        return Object.freeze({
          outcome: 'REVISION_CONFLICT',
          actualRevision: current.revision,
        });
      }
      if (next.revision !== 1) {
        throw new Error('New ledger record must start at revision 1');
      }
      if (next.ticketState.status !== 'PREPARED') {
        throw new Error('New ledger record must start in PREPARED');
      }
    } else {
      if (!current || current.revision !== mutation.expectedRevision) {
        return Object.freeze({
          outcome: 'REVISION_CONFLICT',
          actualRevision: current?.revision ?? null,
        });
      }
      assertSafeCodingLedgerSuccessor(current, next);
    }

    for (const key of safeCodingLedgerIdentityKeys(next)) {
      const owner = this.#identities.get(key);
      if (owner !== undefined && owner !== mutation.transactionId) {
        return Object.freeze({
          outcome: 'IDENTITY_CONFLICT',
          identityKey: key,
        });
      }
    }

    const stored = cloneSafeCodingLedgerRecord(next);
    this.#records.set(mutation.transactionId, stored);
    for (const key of safeCodingLedgerIdentityKeys(stored)) {
      this.#identities.set(key, mutation.transactionId);
    }
    return Object.freeze({
      outcome: 'APPLIED',
      record: cloneSafeCodingLedgerRecord(stored),
    });
  }

  /** Test/support snapshot; still explicitly memory-only. */
  public snapshot(): readonly SafeCodingLedgerRecord[] {
    return [...this.#records.values()]
      .sort((left, right) =>
        compareStrings(left.transactionId, right.transactionId),
      )
      .map((record) =>
        validateSafeCodingLedgerRecord(
          parseCanonicalJson(canonicalizeJson(record)),
        ),
      );
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
