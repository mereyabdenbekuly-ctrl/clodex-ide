# `@clodex/production`

Fail-closed production admission boundary for the independent Clodex execution
packages. It does not enable a feature gate. Its only authority-bearing output
is a frozen `ProductionAuthorityHandle`; every failed or incomplete admission
returns `authority: null` plus a non-authoritative diagnostic.

## Admission order

`bootstrapProductionAuthority` publishes no callbacks until it has completed,
in order:

1. exact current deployment binding and synchronous deployment fence;
2. evidence-backed Linux adapter-confinement attestation and synchronous
   platform fence, including proof that the per-attempt final authority fence
   is consumed inside the serialized adapter dispatch boundary;
3. a durable, linearizable, multi-process, **independently protected** and
   anti-rollback registry-head profile plus its synchronous protection fence;
4. signature/current-head admission of exact adapter, runner, and effect
   manifests bound to workspace, task, root object, policy, configuration,
   build, epoch, predecessor, validity, issuer, and pinned manifest hashes;
5. exact signed membership for every exposed fixed operation and exact binding
   of the constructed adapter set to those memberships and registry hashes;
6. complete `@clodex/promotion` evidence with no blockers, followed by a
   separate explicit reviewed gate decision; promotion eligibility alone can
   never publish authority;
7. construction of `@clodex/control-plane` with the exact durable storage
   adapter and a COMMIT_PERMIT trust port wrapped by all production fences;
8. restart recovery before publication, evidence-only reconciliation, a final
   scan requiring terminal records with delivered evidence, and an external
   serialized recovery-barrier admission; and
9. one final synchronous deployment/platform/head/registry/promotion/review/
   recovery fence before returning the handle.

Every later authority-producing callback repeats those synchronous fences.
The only effect callback is the fixed adapter authority port installed inside
the control plane; callers cannot inject an arbitrary effect port. Its fence is
repeated through a one-shot, request-bound capability that the adapter must
consume exactly once with the exact request object, after all pre-dispatch
awaits and synchronously inside its serialized/prepared boundary immediately
before the first effect-capable OS operation. A missing, mismatched, duplicate,
rejected, or late consumption fails closed;
the adapter attestation must additionally cover the no-yield/no-retry dispatch
implementation because outer JavaScript cannot prove where an OS call occurs.
Terminal-only control-plane callbacks (`abortPrepared`, `deliverEvidence`,
reads) remain
usable after a later gate revocation so revocation cannot prevent durable
closure.

## Adapter boundary

This package intentionally has no hard dependency on
`@clodex/adapters-node` internals. A constructed fixed-operation adapter set is
supplied through `ProductionAdapterAuthorityPort`, normally backed by
`CapabilityConfinedAdapterRegistry` and the Linux Node capabilities. The port
contains no generic filesystem, shell, argv, process, network, credential,
mount, image-selection, or container API.

The `ProductionAdapterConfinementAttestation` is not treated as proof merely
because it is a data record. A trusted deployment verifier must supply the
attestation, evidence digest, bounded validity, and a synchronous current-state
fence. It must also attest that the supplied per-attempt final authority
capability is invoked after all awaits, under dispatch serialization, with no
yield before the first OS operation and no internal retry. If that external TCB
is absent, stale, mismatched, or returns a Promise, bootstrap remains disabled.

## Deliberate non-claims

Source composition alone does not provide production key custody, an HSM or
remote monotonic service, Linux/openat2/AppArmor/seccomp enforcement, trusted
container-daemon configuration, compiled-helper provenance, signed release
publication, browser/Electron migration wiring, packaged smoke evidence, or a
reviewed release decision. The local POSIX registry-head reference explicitly
does not satisfy the independently protected head contract.

The control plane atomically owns its local ticket/permit/ledger/evidence
outbox record. It still does not make an external filesystem, Git, process, or
container effect atomic with that storage transaction; ambiguous effects close
`UNCERTAIN` and are never replayed by recovery.

No production write, package, plugin, shell, network, secret, commit, or push
gate default is changed by this package.

## Verification status

The first independent verification tranche adds executable Vitest coverage for
the fail-closed input boundary. It covers exact deployment, adapter
attestation, protected-head, reviewed-decision, recovery-profile/admission,
registry expectation/membership, and adapter-binding validation. Adversarial
cases include accessors without getter execution, hidden and symbol fields,
foreign prototypes, sparse and extended arrays, malformed digests and
timestamps, validity-window drift, Promise-returning synchronous fences, and
hash-output drift.

Bootstrap tests currently prove that invalid or accessor-backed deployment
input, current-deployment drift, and an asynchronous deployment fence all
return `authority: null`, publish no authority callbacks, and do not invoke
later adapter, promotion, or recovery ports. They also stop on capability-scope
drift, stale adapter evidence, an asynchronous adapter fence, and a registry
head that is not independently protected before crossing the next authority
boundary.

The following larger matrix remains deferred and must not be represented as
verified by the current suite:

- a complete successful bootstrap fixture through signed registry admission,
  reviewed promotion, durable control-plane construction, recovery, and final
  authority publication;
- every remaining blocker returning `authority: null` with zero leaked
  callbacks, including concrete local POSIX/in-memory registry-head port
  wiring rejected for absence of an independently protected profile;
- registry rollback, fork, stale signer, expiry, scope/digest drift, and exact
  adapter/runner/effect membership failures;
- missing/blocked promotion evidence and absence, expiry, revocation, or drift
  of the separate reviewed decision;
- memory-only/wrong durable control-plane adapter rejection;
- crash states before/after COMMIT_PERMIT, no effect replay, evidence-only
  recovery, unresolved/READY records, and recovery-barrier drift;
- revocation between every asynchronous step and the final synchronous permit
  or prepared-effect fence, including missing, mismatched-request, duplicate,
  caught-rejection, retained, late, and pre-await adapter consumption of the
  dispatch capability;
- terminal closure remaining possible after gate revocation; and
- port replacement and revocation races across every asynchronous boundary.

Targeted verification commands for this package are:

```sh
pnpm --dir packages/clodex-production test
pnpm --dir packages/clodex-production typecheck
pnpm exec biome check packages/clodex-production
pnpm typecheck
pnpm check:boundaries
pnpm check:provenance
git diff --check
```
