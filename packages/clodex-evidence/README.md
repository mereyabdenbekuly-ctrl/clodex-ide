# `@clodex/evidence`

Reference implementation for canonical, dual-signed Effect Attestations,
hash-linked evidence records, sequence/CAS checkpoints, and fail-closed
rollback/fork/replay detection.

## Implemented scope

- Exact canonical JSON/UTF-8 DSSE-style envelopes with one executor signature
  and one independent observer signature.
- Mandatory Effect Attestation status/evidence semantics through the hardened
  `@clodex/contracts` validator before signing and verification.
- Descriptor-safe snapshots and pinned signer, verifier, hash, checkpoint, and
  option methods across asynchronous boundaries.
- Trusted signer identities bind key, role, principal, monotonic
  `trustEpoch`, and the current signer-trust registry digest.
- One synchronous final `assertTrusted()` fence over the complete signer set
  after the last verification await. Chain verification rejects mixed/stale
  trust snapshots.
- Historical attestation `registryDigest` changes remain verifiable when all
  signer identities are resolved under one current trusted signer-registry
  snapshot; artifact registry and signer-trust registry are separate bindings.
- Chain-wide uniqueness for attestation, request, ticket, and every non-null
  idempotency key.
- Detached chain input before the first await and hard limits for record count,
  canonical payload size, envelope size, and aggregate envelope bytes.
- Protected-checkpoint CAS, exact read-after-publish verification, and explicit
  rollback/fork classification.

## Breaking API changes

- `EffectAttestationTrustedIdentity` requires `trustEpoch` and
  `registryDigest`.
- `EffectAttestationSignatureVerifier` requires synchronous
  `assertTrusted(input): void` in addition to identity lookup and signature
  verification.
- `VerifiedSignedEffectAttestation` exposes signer identities and the verified
  trust snapshot.
- `VerifiedEvidenceChain` exposes idempotency keys, all signer identities,
  trust snapshot, and aggregate envelope bytes.
- Executor and observer principals must be distinct.
- Inputs above `EVIDENCE_VERIFICATION_LIMITS` fail closed.

## Non-claims and trust boundaries

- The package contains no private-key storage or production signing service.
- `InMemoryEvidenceLedger` and `InMemoryUnprotectedCheckpointPort` are
  memory-only, non-durable, non-crash-safe, and not independently protected.
- The reference ledger performs full-chain verification per append. Work is
  hard-bounded, but the adapter is explicitly non-production.
- Checkpoint publication and signer-trust assertion are different external
  protection domains and are not one atomic transaction. A post-publication
  trust failure may require checkpoint repair while local state remains
  unchanged.
- Signature trust, historical key validity, hashing, and checkpoint protection
  are provided by injected TCB ports. Embedded historical registry proofs are
  not implemented.
- A production implementation requires durable evidence storage and a
  linearizable checkpoint service in an independent protection domain.

Run package verification with `pnpm test`, `pnpm typecheck`, and
`pnpm exec biome check .`.
