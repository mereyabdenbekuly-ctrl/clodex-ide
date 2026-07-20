# Model Fabric local/reference policy publication

**Classification:** `PUBLIC CORE / LOCAL REFERENCE TOOLING`

This implementation is Community-available under the repository license. It
is not a paid entitlement, a hosted CLODEx publisher, a managed enterprise
control plane, or an authorization to implement one in this repository. The
tooling remains public because it has already been published and is useful for
local/synthetic verification. Any future paid managed publisher must be a
greenfield private implementation behind a reviewed public wire contract.

## Purpose

The reference publication plane converts synthetic or operator-controlled
policy inputs into the same version-3 trust snapshot consumed by the IDE
runtime. It is designed for local/offline evaluation and provides:

- Ed25519 signing for the rootset, delegated keyset, and policy envelope;
- a root-signed publication authority manifest;
- individually signed, time-bounded operator approvals;
- role and distinct-approver thresholds per rollout stage;
- an explicit canary-to-production promotion boundary;
- signed, content-free publication receipts;
- a publisher-signed, atomic anti-rollback/replay state file;
- retained previous trust material for cross-signed root rotation.

The runtime data plane is unchanged. A successful publication emits a normal
version-3 control-plane snapshot, so the offline publisher and the IDE use the
same cryptographic verifier.

## Security boundary

Private keys are read only from regular files. On POSIX systems each private
key file must have no group/other permissions, normally mode `0600`. Private
key contents are never written to stdout, receipts, state, or diagnostics.

The publication state file is a security artifact and must be retained in a
protected CI artifact store, encrypted object store, or similarly controlled
location. Its authority watermark, latest receipt hash, latest snapshot/trust
hashes, publisher identity, and sorted approval-nonce ledger are signed by the
active publisher. Historical state remains verifiable after publisher-key
revocation, provided the key identity is still present in the append-only
authority history.

The signature detects field insertion, deletion, and replacement, but cannot
detect wholesale rollback to an older, still-valid signed state by itself.
Deployments that require rollback resistance across machine or artifact-store
compromise must also retain the highest state/receipt hash in external
monotonic storage such as protected CI metadata, an append-only transparency
log, or a KMS-backed counter. Removing all state discards the publisher's local
watermark. A missing state file is accepted only when the operator explicitly
passes `--bootstrap true`, and only a canary can be the first stage.

## Artifacts

### Publication authority

The authority manifest is signed by the configured offline root and contains:

- a monotonic authority revision and validity window;
- append-only approver and publisher key histories;
- approver roles;
- per-stage approval thresholds and required roles;
- the mandatory `production -> requiresPriorStage: canary` rule.

Example unsigned authority:

```json
{
  "schemaVersion": 1,
  "authorityId": "engineering-policy-authority",
  "revision": 1,
  "issuedAt": 1783814400000,
  "expiresAt": 1815350400000,
  "signedBy": "offline-root-2026",
  "approvers": [
    {
      "keyId": "release-operator-a",
      "publicKey": "<Ed25519 SPKI PEM>",
      "status": "active",
      "notBefore": 1783814400000,
      "notAfter": 1815350400000,
      "roles": ["release"]
    },
    {
      "keyId": "security-operator-a",
      "publicKey": "<Ed25519 SPKI PEM>",
      "status": "active",
      "notBefore": 1783814400000,
      "notAfter": 1815350400000,
      "roles": ["security"]
    }
  ],
  "publishers": [
    {
      "keyId": "policy-ci-publisher",
      "publicKey": "<Ed25519 SPKI PEM>",
      "status": "active",
      "notBefore": 1783814400000,
      "notAfter": 1815350400000
    }
  ],
  "stages": [
    {
      "stage": "canary",
      "requiredApprovals": 1,
      "requiredRoles": ["release"]
    },
    {
      "stage": "production",
      "requiredApprovals": 2,
      "requiredRoles": ["release", "security"],
      "requiresPriorStage": "canary"
    }
  ]
}
```

Approver and publisher IDs cannot disappear or reuse different key material in
a later authority revision. Revoked identities cannot be reactivated.

### Approval

An approval contains no policy body. It signs:

- authority ID, revision, and canonical hash;
- target snapshot hash;
- rollout stage;
- approver ID;
- issue/expiry times;
- a cryptographically random replay nonce.

Approvals are accepted only from active authority members, must be unexpired,
and are bound to one exact snapshot and stage. The state file stores hashed
nonces so a signed approval cannot be replayed for a later publication.

### Receipt

The publisher signs one receipt after all approvals and rollout checks pass.
The receipt contains only hashes, revisions, stage, timestamp, publisher key
ID, hashed approver identities, and the previous receipt hash. It never
contains policies, prompts, source code, endpoint URLs, bearer credentials, or
public/private key material.

### State

The state stores:

- the latest verified signed authority;
- the highest authority revision and canonical hash;
- the latest signed publication receipt;
- the exact latest signed version-3 snapshot used as previous trust material;
- hashes of consumed approval nonces.

The complete state is signed by the publisher that signed the latest receipt.
Loading state verifies that outer signature, the historical publisher key,
the receipt, the retained snapshot, and every receipt-to-snapshot watermark.
Revoked publisher keys are accepted only for historical state whose bound
receipt timestamp falls inside that key's original validity window; they
cannot authorize a new publication.

Each new canary must preserve every component revision and canonical hash. At
least one of rootset, keyset, or policy revision must advance. Production must
publish the exact snapshot from the immediately preceding canary receipt.

## CLI workflow

The commands are available from `apps/browser`:

```bash
pnpm policy:publication -- help
```

### 1. Sign the authority

```bash
pnpm policy:publication -- sign-authority \
  --authority authority.unsigned.json \
  --root-private-key root.private.pem \
  --root-public-key root.public.pem \
  --out authority.signed.json
```

### 2. Build and sign a v3 snapshot

The unsigned payload contains rootset, keyset, and policy payloads without
their signatures. The tool verifies that every supplied private key matches
the declared Ed25519 public key, signs all three layers, assembles the snapshot,
and passes it through the production runtime verifier before writing it.

```bash
pnpm policy:publication -- prepare-snapshot \
  --payload snapshot.unsigned.json \
  --root-public-key root.public.pem \
  --rootset-private-key root.private.pem \
  --keyset-private-key active-root.private.pem \
  --policy-private-key policy-signing.private.pem \
  --state publication-state.json \
  --out snapshot.signed.json
```

Omit `--state` only for the initial pinned-root snapshot. After bootstrap, the
CLI verifies the state signature and passes its retained snapshot into the
runtime verifier. This is required when a new rootset is signed by a rotated
root rather than the original pinned root.

### 3. Collect canary approval

```bash
pnpm policy:publication -- approve \
  --authority authority.signed.json \
  --root-public-key root.public.pem \
  --snapshot snapshot.signed.json \
  --approver-id release-operator-a \
  --approver-private-key release-operator-a.private.pem \
  --stage canary \
  --ttl-hours 24 \
  --state publication-state.json \
  --out approval.canary.release.json
```

After bootstrap, approvals should also receive `--state`. This prevents an
operator from signing an approval for a snapshot that only validates as a new,
unanchored trust universe or conflicts with the retained rollout watermark.

### 4. Publish the initial canary

`--bootstrap true` is required only when no state file exists.

```bash
pnpm policy:publication -- publish \
  --authority authority.signed.json \
  --root-public-key root.public.pem \
  --snapshot snapshot.signed.json \
  --approval approval.canary.release.json \
  --publisher-id policy-ci-publisher \
  --publisher-private-key policy-ci-publisher.private.pem \
  --stage canary \
  --bootstrap true \
  --state publication-state.json \
  --receipt publication-receipt.canary.json \
  --out control-plane-canary.json
```

### 5. Promote the exact canary to production

Create production approvals for the same snapshot and stage, then publish
without the bootstrap flag:

```bash
pnpm policy:publication -- publish \
  --authority authority.signed.json \
  --root-public-key root.public.pem \
  --snapshot snapshot.signed.json \
  --approval approval.production.release.json \
  --approval approval.production.security.json \
  --publisher-id policy-ci-publisher \
  --publisher-private-key policy-ci-publisher.private.pem \
  --stage production \
  --state publication-state.json \
  --receipt publication-receipt.production.json \
  --out control-plane-production.json
```

### 6. Verify retained state

```bash
pnpm policy:publication -- verify-state \
  --state publication-state.json \
  --root-public-key root.public.pem
```

All output files are written with temp-file, `fsync`, rename, and owner-only
permissions. The state is written last so a failed output publication does not
consume approvals and can be retried safely.

## Operational quarantine

The former public GitHub Actions publisher was removed on July 20, 2026. A
public repository workflow must not materialize a Model Fabric publisher
private key or perform canary/production publication. The local CLI and crypto
module remain available for synthetic fixtures, offline evaluation, and
verification of operator-controlled artifacts.

The stage names `canary` and `production` describe the reference state machine
only. They do not prove CLODEx production deployment, managed-service
authorization, organizational separation, external monotonic storage, key
custody, or commercial entitlement.

The public main-plan readiness command does not accept Model Fabric state or
root-key arguments and reports the promotion contract as `not-yet-defined`.
Locally generated or caller-supplied publication artifacts can therefore never
make a public release gate promotion-ready.

Do not add hosted upload/deployment behavior, CLODEx production credentials,
GitHub Environment publisher secrets, enterprise administration, or managed
policy distribution to this public tooling. A future managed implementation
must start separately after the documented Protocol, provenance, private-CI,
maintainer, and legal gates are GREEN.

## Failure behavior

Publication fails before changing state when any of these checks fail:

- malformed or expired authority/snapshot/approval;
- key mismatch or non-Ed25519 key material;
- authority, rootset, keyset, or policy rollback/conflict;
- missing stage roles or approval threshold;
- duplicate approvers or consumed approval nonce;
- direct production without the exact prior canary;
- rotated-root snapshots without authenticated previous trust;
- missing state without explicit bootstrap authorization;
- private key file permissions broader than owner-only;
- receipt/state signature or hash-chain tampering.
