# Cloud Task Memory Atomic Sync

The `atomic-v1` protocol removes the time-of-check/time-of-use window between
Evidence Memory divergence proof and cloud ledger mutation.

## Commit request

`POST /v1/cloud-tasks/executions/:executionId/evidence-memory/merge`

The request contains:

- a deterministic `mutationId`, also sent as `Idempotency-Key`;
- the expected remote checkpoint used as a compare-and-swap precondition;
- the exact target checkpoint;
- ordered Evidence Memory batches.

## Required server transaction

The cloud implementation must perform the following in one database
transaction:

1. Load the current task-scoped checkpoint.
2. Return HTTP `409` when it differs from `expectedRemoteCheckpoint`.
3. Look up `mutationId`. If already committed with the same request identity,
   return the stored receipt with `replayed: true`.
4. Reconcile every batch while rejecting different content under a shared
   event ID.
5. Recompute the ledger checkpoint and require it to equal
   `targetCheckpoint`.
6. Persist the ledger and immutable commit receipt atomically.

No events may become visible if steps 2–5 fail.

## Reference transaction store

`SqliteCloudTaskMemoryAtomicLedger` provides the executable server-side
reference implementation used by the E2E and chaos harness. It includes:

- write-serialized SQLite transactions;
- durable event storage and immutable idempotency receipts;
- CAS validation inside the write transaction;
- rollback when a fault occurs after event insertion but before receipt commit;
- epoch and fencing-token-hash validation;
- receipt retention cleanup;
- cursor-based pull batches compatible with the desktop synchronizer.

The production cloud service can place authentication, execution binding, and
HTTP routing in front of this transaction contract or port the same invariants
to its managed database.

## Client recovery

- Network failures retry the same pending mutation ID.
- A CAS conflict discards the stale pending request and rebuilds retrieval and
  divergence proof from the new cloud checkpoint.
- A process restart may generate a new mutation ID, but replay remains
  idempotent because event ingestion is deterministic and duplicate-safe.
- Automatic union merge is disabled when the atomic endpoint is unavailable.

The renderer receives only content-free protocol diagnostics:
`atomic-v1`, CAS classification, and whether a receipt was replayed.
