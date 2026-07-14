# Safe Coding Autopilot MVP

- **Status:** `HISTORICAL_REFERENCE / SUPERSEDED_FOR_CURRENT_WIRING`
- **Date:** July 14, 2026
- **Execution profile at this snapshot:** independent reference components; no
  production wiring claimed by this slice
- **Promotion at this snapshot:** disabled

This document preserves the original reference-slice claims and gaps. It is not
the source of truth for current `main` wiring or release readiness; use the P0
handoff/status documents and the gate-based product release plan for that.

## Scope

This slice demonstrates machine-checkable conformance to a signed, bounded
Safe Coding Intent Contract without touching the host workspace or enabling a
production feature gate.

The model, renderer, request payload, and adapter result are not authority.
Trusted constructor ports provide signature trust, caller identity, current
mandatory policy, registry identity, final authority snapshot, kernel state,
and evidence admission.

## Implemented independent packages

### `@clodex/contracts`

- closed Safe Coding v1 contract, action, Execution Ticket, and Effect
  Attestation validators;
- exact file/tree selector grammar and deterministic containment;
- canonical JSON/UTF-8, duplicate-key rejection through exact canonical-byte
  equality, accessor rejection, sorted unique authority sets, and safe-integer
  limits;
- DSSE-style envelope PAE, canonical base64url, domain-separated hashes, and
  injected signature/hash trust ports;
- hard-denied network, secrets, shell, delete, Git commit, and Git push fields.

### `@clodex/guardian`

- one public class-based issuance path; raw structural objects cannot issue
  authority through exported helper functions;
- root-authorizer signature verification before identity, registry, or
  PREPARE;
- caller identity derived from a trusted port, not request JSON;
- expiry, context, scope, active revision, current mandatory policy,
  policy/adapter commitments, and runner/effect registry digests checked before
  PREPARE and rechecked after asynchronous work;
- constructor-port snapshots and immutable snapshots of caller, active state,
  adapter binding, and PREPARE output;
- short-lived exact-action tickets registered through the kernel port;
- asynchronous final revalidation plus a synchronous composite
  `assertFinalAuthority` fence for immediate use before `COMMIT_PERMIT`.

### `@clodex/kernel`

- immutable pure transitions for activation CAS, revision chains,
  supersession, revocation epochs, budgets, and replay protection;
- atomic request/ticket/reservation registration;
- one-shot `COMMIT_PERMIT` with exact active-revision and expiry checks;
- `failBeforeCommit`, `failed-no-effect`, `committed`, `result-unavailable`, and
  `uncertain` terminal closure;
- in-memory reference adapter explicitly marked `memory-only`.

### `@clodex/runtime`

- recording-only, runtime-owned orchestration from signed contract to ticket,
  inert prepared effect, final fence, simulated effect, kernel terminal state,
  and validated Effect Attestation;
- exact two-phase execution order:

  ```text
  preparedEffect = await adapter.prepare
  await Guardian.revalidateExecutionTicket
  Guardian.assertFinalAuthority       // synchronous composite snapshot
  Kernel.commitPermit                 // synchronous local linearization
  await preparedEffect.execute
  ```

- adapter and prepared-effect pinning plus exact policy/adapter and
  runner/effect-registry digest matching; prepared effects require a closed
  own-data shape, and an accessor-based `execute` is rejected without evaluating
  the accessor;
- the runtime, rather than the adapter, owns revalidation, the final synchronous
  authority assertion, `COMMIT_PERMIT`, and the single post-permit invocation;
- PREPARE, revalidation, final-authority, and permit failures close before
  `preparedEffect.execute`; execution is never invoked without an exact permit;
- `commitPermit` is a synchronous local kernel port. A missing or malformed
  permit—including prototype, symbol, non-enumerable, accessor, or extra-field
  drift—after ticket consumption closes the reference ticket as `uncertain`
  before execute and never creates retry authority;
- no retry after `COMMIT_PERMIT`, ambiguous adapter failure, result
  finalization failure, or evidence admission failure;
- package contains no filesystem, Git, shell, process, network, credential, or
  promotion implementation.

### `@clodex/approval`

- canonical authority-only review model and Approval Artifact; model summaries
  do not grant authority;
- DSSE-style signed envelope, reviewer identity/trust snapshot, exact current
  commitment revalidation, bounded validity, and one-shot replay registry;
- synchronous final reviewer-trust and current-commitment fences after the last
  asynchronous verification step;
- reference ports only: no production UI, key store, P-256 implementation, or
  durable replay database is included.

### `@clodex/ledger` and `@clodex/ledger-node`

- one logical CAS record owns ticket state, effect attempt, immutable evidence
  expectation, and evidence-admission outbox identity;
- closed reachable state/revision transitions, global ticket/request/nonce/
  reservation/attempt/evidence/attestation/idempotency identity reservations,
  restart recovery classification, and one-shot verified admission receipts;
- POSIX snapshot adapter uses a private fixed-name lock, `0600` staging file,
  file `fsync`, same-directory rename, directory `fsync`, exact post-rename
  read-back reconciliation, base-directory inode pinning, and bounded snapshots;
- the recorder does not authenticate `COMMIT_PERMIT`, own a trusted clock, or
  make the kernel/effect/evidence systems one durable atomic transaction.

### `@clodex/evidence`

- canonical executor/observer signatures over one Effect Attestation;
- immutable signer trust snapshots with epoch/registry binding and a final
  synchronous full-signer-set trust fence;
- bounded hash-linked chain, idempotency replay protection, sequence/CAS
  checkpoints, and rollback/fork detection;
- in-memory ledger/checkpoint adapters are explicitly unprotected and
  non-durable; production signing keys and protected checkpoint storage remain
  external TCB ports.

### `@clodex/adapters`

- fixed reference operations for filesystem create/replace/mkdir, Git
  status/diff, and registered test profiles;
- every adapter is bound to one immutable workspace/task/root capability scope;
  ticket audience is checked before any content, inspect, profile, or execute
  port is called, and mixed-scope registries are rejected;
- exact content/state digests and expected-state CAS inputs are propagated to
  operation-specific ports;
- no `openat2`, Git subprocess, Docker/VM sandbox, host workspace, credential,
  network, or generic shell implementation exists in this package.

### `@clodex/promotion`

- fail-closed eligibility assessment binds exact environment, build, config,
  policy, issuer, evidence, and maximum-age requirements;
- uses a trusted synchronous clock, trusted hash port, and final current-state
  fence;
- reports eligibility only and has no API that can enable a feature gate.

## Verification

- `@clodex/contracts`: **36/36 tests**;
- `@clodex/guardian`: **19/19 tests**;
- `@clodex/kernel`: **13/13 tests**;
- `@clodex/runtime`: **17/17 tests**;
- `@clodex/approval`: **32/32 tests**;
- `@clodex/ledger`: **30/30 tests**;
- `@clodex/evidence`: **28/28 tests**;
- `@clodex/adapters`: **31/31 tests**;
- `@clodex/ledger-node`: **17/17 tests**;
- `@clodex/promotion`: **7/7 tests**;
- combined independent-package suite: **230/230 tests**;
- root typecheck: **25/25 Turbo tasks**;
- independent-boundary tests: **38/38**;
- dependency/import boundary check: pass;
- provenance guard, targeted Biome, and `git diff --check`: pass.

The complete browser regression remains **2215/2215 tests across 269 files**;
browser typecheck passes all six UI/Pages/backend/preload/Storybook/visual
targets. No packaged Electron smoke is claimed.

## Deliberate non-claims and blockers

This is not a production Safe Coding feature and does not prove filesystem or
test sandbox confinement.

The following remain blocking:

1. the canonical Approval Artifact is an independent reference; no production
   approval UI, key store, signing service, or durable replay store is wired;
2. injected signature verifier/hash ports are not a production key store or
   P-256 implementation;
3. kernel state, ticket consumption, effect settlement, evidence signing,
   protected checkpoint publication, and ledger admission are not one
   crash-safe transaction;
4. the reference evidence chain is signed through injected ports but has no
   production key custody, independently protected anti-rollback head, or
   atomic checkpoint/trust transaction;
5. the recording adapter's side-effect-free PREPARE behavior is a trusted
   reference assumption, not an OS-enforced sandbox property;
6. resource `stateCommitmentHash` is not atomically CAS-checked at
   `COMMIT_PERMIT` by a real effect adapter;
7. the committed `runnerRegistryDigest` is checked, but membership of the
   attested `runnerId`/`runnerDigest` in that registry is not verified;
8. the filesystem adapter protocol has no descriptor-relative `openat2`/
   no-follow implementation and does not resist a same-UID path-race attacker;
9. the hardened Git policy is a committed descriptor, not an implemented Git
   subprocess proving hooks, textconv, external diff, pagers, helpers, and
   network are disabled;
10. digest-pinned test profiles are committed descriptors, not a wired
    Docker/VM sandbox proving read-only workspace, disposable scratch, network
    denial, credential denial, and quarantine;
11. delegation subset proofs and ancestor-shared durable budgets are not yet
    implemented;
12. at this historical snapshot, no browser migration adapter, production main
    wiring, packaged Electron smoke, host-workspace apply, feature-gate
    promotion, or default change was claimed; this is not a statement about the
    newer P0 composition on `main`.

## Historical next implementation order

This sequence is retained for audit context and is superseded where newer P0
plans/status documents record completed or re-ordered work.

1. atomically link durable kernel ticket state, effect ledger, and evidence
   outbox without reopening post-authorization retry authority;
2. add production key custody plus an independently protected, linearizable
   anti-rollback checkpoint/trust service;
3. verify a signed scoped adapter-registry manifest, including workspace,
   task, root object, adapter, runner, and effect registry membership;
4. implement a descriptor-relative filesystem helper, hardened Git observer,
   and isolated digest-pinned test runner;
5. wire canonical approval and the reference control plane through a reviewed
   production migration adapter while all authority gates remain default-off;
6. run packaged Electron and fault-injected crash/recovery validation, then make
   promotion a separate reviewed decision.
