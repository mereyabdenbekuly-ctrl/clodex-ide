# `@clodex/registry`

Independent reference package for signed, scope-bound adapter, runner, and
effect registry manifests.

## Implemented scope

- strict canonical JSON and DSSE PAE payloads with exactly one canonical
  64-byte, in-range, low-S P-256/P1363 signature;
- manifests bind registry type, `workspaceId`, `taskId`, `rootObjectId`, policy,
  configuration and build digests, a bounded validity window, issuer/key,
  monotonic epoch, predecessor hash, and closed/sorted members;
- adapter members bind implementation, operation, argument schema, effect and
  optional runner identity/digest;
- runner members bind runner/profile/image digests and the initial networkless,
  credentialless, read-only-workspace/disposable-scratch profile;
- effect members bind adapter/operation/schema, effect class, commit protocol,
  idempotency, observer strength, reconciliation, approval and secret handling;
- verification resolves one immutable signer snapshot, verifies against that
  snapshot, then performs synchronous final trust/time/head fences;
- the caller supplies the exact manifest digest already committed by trusted
  authority;
- protected-head CAS accepts only genesis or the exact next hash-linked epoch,
  rejecting rollback, same-epoch forks, skipped epochs and wrong predecessors;
- exact closed-record membership APIs for adapters, runners and effects repeat
  synchronous trust, validity and current-head fences on every lookup;
- a deterministic in-memory head exists for reference tests only.

## Deliberate non-claims

This package does **not** implement P-256, key custody, revocation storage, a
hardware/remote protected monotonic head, cross-system atomicity, production
registry publication, browser wiring, or feature-gate promotion. The injected
signature verifier must perform the actual cryptographic verification against
the exact key material selected by the immutable trust snapshot and its
registry digest. The in-memory head is neither durable nor anti-rollback
protected.

`@clodex/registry-node` supplies an honest local POSIX snapshot adapter, but its
entire file can still be replaced or rolled back by a same-UID actor. It is not
the independently protected production head required by the security plan.

## Verification handoff

```sh
pnpm --dir packages/clodex-registry test
pnpm --dir packages/clodex-registry typecheck
pnpm exec biome check packages/clodex-registry
```

No authority gate is enabled by this package.
