# `@clodex/control-plane`

Fail-closed, platform-neutral coordinator for the local execution boundary.

## Atomic local unit

One `ControlPlaneTransactionRecord` contains and atomically advances:

- the reserved/consumed execution ticket identity;
- the externally admitted `COMMIT_PERMIT` snapshot;
- the effect-attempt lifecycle;
- a redundant ledger projection; and
- the reserved, ready, or delivered evidence outbox entry.

The injected `ControlPlaneStorageTransactionPort` must reserve every replay
identity and replace that complete record in one linearizable CAS. The optional
synchronous pre-commit fence runs under the storage adapter's mutation
exclusion, after conflict checks and before the local transaction linearizes.
The coordinator itself does **not** sign or issue permits. Signature, issuer,
registry, revocation, and policy verification belong to the injected
`CommitPermitAuthorityPort` TCB.

The synchronous fence does not make an independently stored trust/revocation
registry atomic with this record. The authority TCB must define whether a
verified admission remains consumable once its fence succeeds, or co-locate
its consumption in the same storage transaction. This reference package does
not claim that cross-store guarantee.

## One-shot effect boundary

Before invoking an effect port, the coordinator durably moves the transaction
from `COMMIT_PERMIT` to `EFFECT_IN_FLIGHT`. Only the winning CAS invokes
`executeOnce`, once. It never retries an exception or an invalid/ambiguous
response. Positive observations close `COMMITTED` or `RESULT_UNAVAILABLE`; a
trusted explicit no-effect response closes `FAILED_PRE_EFFECT`; every other
observed ambiguity closes `UNCERTAIN`.

Restart recovery is intentionally conservative:

- `PREPARED` becomes `FAILED_PRE_EFFECT`;
- both `COMMIT_PERMIT` and `EFFECT_IN_FLIGHT` become `UNCERTAIN`;
- terminal records perform evidence-only reconciliation; and
- no recovery action is allowed to execute or replay an effect.

The terminal state and evidence payload become ready in the same local CAS.
Delivery acknowledgement requires a closed receipt verified by a separate
evidence-admission TCB and cannot execute an effect.

## Deliberate impossibility boundary

This package does **not** claim that a local storage commit is atomic with an
external filesystem, Git, process, container, MCP, network, or cloud effect.
A crash can occur after the effect happens and before terminal local state is
durable. That interval is irreducibly ambiguous without a target-specific
transaction, an independently queryable idempotency/reconciliation protocol,
or a single storage system that owns both state and effect. The coordinator
therefore records `UNCERTAIN`, forbids replay, and requires reconciliation.

The in-memory adapter is reference-only and is not restart durable.
