# `@clodex/approval`

Shell- and UI-independent reference package for canonical CLODEx approval
evidence.

## Implemented scope

- deterministic approval renderer model containing only authoritative Intent
  Contract fields (never `nonAuthoritative` goal labels, notes, or LLM prose);
- domain-separated digest of that complete canonical security view;
- closed canonical Approval Artifact bound to the exact contract hash/revision,
  authority digest, policy/adapter/runner/effect registry digests, renderer
  version, reviewer identity/role, issuance/expiry, and nonce;
- DSSE PAE signing and verification flow with injected identity, contract
  signature, reviewer trust-store, signing, hash, clock, ID, commitment, and
  replay ports;
- identity and current-digest revalidation plus synchronous final trust and
  commitment fences;
- one-time review challenges and one-shot artifact admission;
- strict canonical JSON/UTF-8, exact-key validators, and preflight rejection of
  accessors, hidden fields, symbols, sparse/extended arrays, exotic
  prototypes, and cycles;
- a synchronous `memory-only` replay registry reference implementation.

## Deliberate non-claims

This package does **not** provide or claim a production approval UI, protected
key store, P-256 implementation, durable or multi-process replay store,
rollback-resistant trust/registry state, atomic contract activation, or browser
production wiring. The trust-store verifier is responsible for canonical low-S
P-256/P1363 enforcement. A production adapter must replace the memory-only
registry and implement the final fences from protected current state.

## Checks

```sh
pnpm --dir packages/clodex-approval test
pnpm --dir packages/clodex-approval typecheck
pnpm exec biome check packages/clodex-approval
```
