# `@clodex/ledger`

Platform-neutral, fail-closed recorder for one-shot safe-coding effect
transactions. One record atomically models the execution ticket lifecycle,
effect attempt, immutable evidence expectations, and evidence-admission outbox.

## Implemented scope

- Exact `PREPARED -> COMMIT_PERMIT -> terminal` state transitions with
  reachable revision/state combinations.
- Immutable `SafeCodingEvidenceExpectation` reserved in `PREPARED` for
  delegation lineage, runner and observer identity, pre/post state,
  idempotency, budget charges, start time, evidence level, and reconciliation.
- Exact terminal-attestation binding to the ticket, attempt, expectation,
  result, and reserved attestation UUID.
- Distinct executor and observer principals.
- CAS-based persistence facade with detached immutable records and no implicit
  effect retry.
- Cross-record uniqueness checks for every `safeCodingLedgerIdentityKeys`
  identity, including a non-null idempotency key.
- Bounded record/scan validation before canonicalization and recovery.
- Closed, one-shot `SafeCodingEvidenceAdmissionReceipt` verification and final
  synchronous trust fence. The receipt binds the exact attestation payload,
  signed-envelope hash, evidence ledger/head, and checkpoint publication.
- Recovery never trusts a persisted `ADMITTED` receipt by structure alone; it
  requests evidence-only revalidation and never authorizes effect replay.

## Breaking API and schema changes

- `createPreparedSafeCodingLedgerRecord()` and
  `SafeCodingEffectLedger.createPrepared()` require `evidenceExpectation`.
- `SafeCodingLedgerRecord` contains a top-level immutable
  `evidenceExpectation`.
- `evidenceAdmission.admissionReceiptHash` was replaced by the full closed
  `evidenceAdmission.admissionReceipt`.
- `markSafeCodingLedgerEvidenceAdmitted()` and
  `SafeCodingEffectLedger.markEvidenceAdmitted()` accept only a one-shot value
  returned by `verifySafeCodingEvidenceAdmissionReceipt()`.
- A record exports seven base replay identities plus an optional idempotency
  identity: at most eight. Persisted identity keys may be up to
  `SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH` (`288`) characters.
- Restored terminal records with unreachable revisions are rejected.

## Non-claims and trust boundaries

- The ledger records an already trusted `COMMIT_PERMIT`; it does not issue or
  authenticate execution authority.
- Caller timestamps are recorder inputs, not proof from a trusted clock.
- `InMemorySafeCodingLedgerStore` is memory-only, non-durable, non-crash-safe,
  and single-isolate only.
- An adapter-declared durable contract is not proof of fsync, restart, or
  multi-process safety; the persistence adapter remains TCB.
- External evidence admission and ledger persistence are not one atomic
  cross-system transaction.
- Receipt verifier, persistence, and any durable storage implementations remain
  trusted ports and require independent production audit.

Run package verification with `pnpm test`, `pnpm typecheck`, and
`pnpm exec biome check .`.
