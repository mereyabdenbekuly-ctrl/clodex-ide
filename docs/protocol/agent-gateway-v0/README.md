# CLODEx Agent Gateway Protocol v0 — schema-only draft

> **Status: `DRAFT / IMPLEMENTATION FORBIDDEN / UNVERIFIED`.**
>
> This directory is a provisional, schema-only boundary proposal. It does **not**
> contain a Gateway, SDK, client, server, policy engine, Guardian, persistence
> model, scheduler, authentication system, billing logic, secrets, deployment
> topology, or private implementation fields.

## Why this exists

The intended product boundary is an open IDE/security client speaking a small,
explicit protocol to a separately governed managed Gateway. Defining that
boundary before writing the Gateway prevents runtime dependencies and inherited
implementation details from silently crossing the open/closed boundary.

This draft describes one operation: submit one identity-bound, digest-bound,
replay-protected agent effect and receive canonical terminal evidence.

It does **not** authorize Gateway implementation yet. Provenance, licensing,
security review, and an explicit publication decision must turn this draft
GREEN first.

## Standards baseline

- `openapi.yaml` uses **OpenAPI 3.2.0**.
- JSON schemas use **JSON Schema Draft 2020-12**.
- Protocol draft version: `0.1.0-draft`; major version `0` has no stability or
  compatibility promise.
- OpenAPI declares the Draft 2020-12 dialect explicitly.
- Implementations must treat `date-time` and `uri` formats as validation
  assertions, not annotations only.

These versions are intentional. No older OpenAPI compatibility mode is used in
this draft.

Normative external references:

- [OpenAPI Specification 3.2.0](https://spec.openapis.org/oas/v3.2.0.html)
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 4648: Base64 URL and filename-safe alphabet](https://www.rfc-editor.org/rfc/rfc4648)
- [RFC 8032: Ed25519](https://www.rfc-editor.org/rfc/rfc8032)

## Files

| File | Purpose |
| --- | --- |
| `openapi.yaml` | Logical HTTP-shaped contract; no server or deployment URL |
| `REQUIREMENTS.md` | Stable reconstructed requirement IDs for review; not proof of pre-schema approval |
| `common.schema.json` | Shared identity, digest, signature, policy, replay, artifact, and terminal-outcome types |
| `request-envelope.schema.json` | Signed request for exactly one tool effect |
| `approval-evidence-reference.schema.json` | Signed, expiring reference to a decision bound to that exact effect |
| `signed-effect-receipt.schema.json` | Signed terminal authorization/execution evidence |
| `error-envelope.schema.json` | Non-evidentiary protocol/transport error |
| `version-negotiation.schema.json` | Signed offer/selection with no silent downgrade |

## Mandatory security invariants

### 1. One immutable effect binding

`EffectBinding` fixes all of the following before authorization:

- tenant;
- actor and authentication-context digest;
- device and optional attestation digest;
- agent identity, instance, and build;
- task;
- step and attempt;
- tool, namespace, server, and version;
- intent digest;
- tool-descriptor digest;
- context digest;
- requested-effect digest;
- policy identifier, version, and digest.

An approval evidence reference and the resulting receipt must repeat an exactly
equal binding. A conforming endpoint rejects any mismatch; it must never
"repair," partially merge, infer, or broaden a binding.

The request also carries digest-bearing artifacts. Their values must match the
binding exactly:

```text
binding.intentDigest     == intent.artifact.digest
binding.descriptorDigest == toolDescriptor.digest
binding.contextDigest    == context.digest
binding.effectDigest     == requestedEffect.artifact.digest
```

JSON Schema cannot express cross-object digest equality, so these comparisons
are normative protocol validation requirements.

This exact single-effect binding is the v0 object-level capability boundary:
authority covers only the concrete objects and operation encoded by the signed
requested-effect artifact. Wildcards, ambient authority, reusable broad grants,
and post-authorization target substitution are not representable in v0.

### 2. Canonical digests

- Digest algorithm is SHA-256.
- Encoding is unpadded base64url.
- `jcs-rfc8785` means RFC 8785 JSON Canonicalization Scheme bytes.
- Before schema or signature processing, JSON decoders must reject duplicate
  object member names, invalid Unicode, non-finite numbers, and values outside
  the RFC 8785/I-JSON serialization domain. Implementations must not normalize
  Unicode strings before hashing or signing.
- `raw-bytes` means the exact referenced byte sequence, with no Unicode,
  newline, archive, media-type, or object normalization.
- Inline JCS artifacts use `contentEncoding: json`; the `content` JSON value is
  canonicalized directly. Inline raw bytes use unpadded base64url with
  `contentEncoding: base64url`; the decoded bytes are hashed.
- Inline, reference, and out-of-band forms are mutually exclusive. An inline
  artifact has no locator; a referenced artifact has no inline content; an
  out-of-band artifact has neither.
- Every base64url value is canonical and unpadded. Validators must decode and
  re-encode it and require byte-for-byte equality, rejecting invalid final
  quanta and alternate encodings.
- The digest does not provide confidentiality. Inline content and locators are
  sensitive and must not be logged merely because a digest is present.

Content fetched through a locator is accepted only when its calculated digest
equals the signed digest. Mutable locator contents never alter the binding.
Locators are references, not authority: deployment profiles must allowlist
schemes and origins, reject embedded credentials and unexpected redirects, and
must not permit `file:`, loopback, link-local, metadata-service, or arbitrary
private-network fetches. Transport credentials are supplied out of band and
are never encoded in a signed locator.

### 3. Envelope signatures

The v0 signature profile is `clodex-agent-gateway-v0.jcs` with Ed25519.

To construct signature input:

1. Copy the complete envelope.
2. Remove only `/signature/value`; keep `profile`, `algorithm`, `keyId`, and
   `createdAt` in the object.
3. Canonicalize that object using RFC 8785.
4. Prefix the canonical bytes with the ASCII domain separator
   `CLODEX-AGENT-GATEWAY-V0\0`.
5. Sign the resulting byte sequence with the key identified by `keyId`.

Duplicate-key rejection occurs on the original UTF-8 JSON before object-model
construction; accepting a last-wins or first-wins parse would make signature
meaning parser-dependent.

For any signed envelope, `EnvelopeDigest` is SHA-256 over the exact
domain-separated bytes produced by steps 1–4: it includes the signature
metadata but excludes only `signature.value`. Its `profile` is
`clodex-agent-gateway-v0.jcs`; the generic artifact `Digest` type is not valid
for an envelope digest. `requestEnvelopeDigest` hashes the complete request
envelope by this procedure, and `approvalEvidenceDigest` hashes the complete
`ApprovalEvidenceReference` by the same procedure. Signature verification, key
trust, tenant scope, revocation, and time validity are all required before an
envelope is used.

### 4. Expiry, nonce, and idempotency

- `issuedAt` must be earlier than `expiresAt`.
- An expired request or approval reference never authorizes execution.
- A structurally valid, signature-authenticated effect request is assigned its
  canonical lifecycle before expiry disposition. If the request or its approval
  evidence is expired before execution claim, the endpoint produces a signed
  terminal `EXPIRED + NOT_APPLIED` receipt, not an unsigned/plain HTTP `410`.
  If expiry occurs before authorization evaluation, the receipt records
  `authorization.decision: NOT_EVALUATED` and
  `decisionSource: LIFECYCLE`; it must not fabricate approval or denial. If an
  `AUTHORIZED` decision already exists, that decision is preserved with the
  pre-claim `EXPIRED` outcome.
- Replay, evidence, and negotiation nonces encode at least 128 bits generated
  by a CSPRNG and use canonical unpadded base64url.
- Replay nonces are single-use within the tenant and protocol-version scope,
  except for the exact idempotent replay rule below.
- Idempotency keys are scoped to the tenant and original canonical request.
- Repeating the same key and same canonical request returns the original
  terminal receipt.
- Repeating the key with any changed bytes, binding, policy, evidence, nonce,
  or payload is `IDEMPOTENCY_CONFLICT` and must not execute.
- Clock-skew policy is deployment policy and is intentionally absent here; it
  may only narrow, never extend, a signed expiry.

The required lookup order is deterministic: first resolve
`tenantId + idempotencyKey` and compare the stored `requestEnvelopeDigest`.
An exact match may only return the already stored terminal receipt and does not
reauthorize, reclaim, or re-execute the effect. A different digest is
`IDEMPOTENCY_CONFLICT`. Only a previously unseen idempotency key proceeds to
nonce replay admission; reuse of its nonce is `REPLAY_DETECTED`. After nonce
admission, approval-evidence consumption is reserved atomically with creation of
the canonical effect lifecycle, before authorization or execution claim.

### 5. Approval evidence is exact and narrow

An approval evidence reference is `SINGLE_EFFECT`, signed, expiring, and bound
to one complete `EffectBinding`. It identifies the decision maker separately
from the evidence issuer/signing key.

Only an unexpired `APPROVED` decision may contribute authorization. `DENIED`
is durable negative evidence and can never be converted into approval by retry,
fallback, missing state, or a different policy version.

Terminal precedence is fail-closed: exact valid `DENIED` evidence produces
`DENIED + NOT_APPLIED` even if the request or denial reference is also expired;
otherwise pre-evaluation request expiry or expired `APPROVED` evidence produces
`NOT_EVALUATED/LIFECYCLE + EXPIRED + NOT_APPLIED`.

If the request carries exact, valid `DENIED` approval evidence, the receipt must
contain `authorization.decision: DENIED` and
`outcome: {status: DENIED, effectState: NOT_APPLIED}`. Policy or Guardian
fallback must not override that negative evidence.

`tenantId + evidenceId + evidenceNonce + binding` is single-consumption
authorization. It may be associated with only one canonical request envelope.
An exact duplicate delivery of that request may only return its stored receipt;
reuse of the evidence in a different `requestId`, idempotency key, nonce, or
canonical request is `EVIDENCE_REPLAY` and must not authorize or execute.

The reference does not contain Guardian logic, policy heuristics, conversation
text, or storage design. `evidenceLocator` is an opaque content location whose
bytes must match `evidenceDigest`.

### 6. Authorization and execution stay bound

Passing schema validation does not grant authority. A conforming Gateway must
make the authorization decision against the signed binding and claim that same
binding for execution without a time-of-check/time-of-use substitution window.
The protocol intentionally does not prescribe the private implementation of
that atomicity guarantee.

The receipt's authorization policy must equal `binding.policy`. When approval
evidence is cited, both its identifier and digest are present. The receipt's
`approvalEvidenceDigest` is the `EnvelopeDigest` of the complete signed
`ApprovalEvidenceReference` under the same signature-input profile; it is
different from the reference's `evidenceDigest`, which binds the separately
retained decision evidence. A receipt cannot claim an authorization source that
was not verified for the exact request.

The receipt must repeat the request's exact `binding` and
`requestReplayProtection`, plus the exact `negotiation` binding; cross-object
equality is a normative validation requirement even where JSON Schema cannot
express it.

The authorization disposition is one of:

- `AUTHORIZED` from policy, Guardian, or exact approval evidence;
- `DENIED` from policy, Guardian, or durable exact denial evidence;
- `NOT_EVALUATED` from `LIFECYCLE` when expiry terminates the request before
  authorization evaluation.

### 7. Receipts are terminal and signed

The terminal outcome matrix is:

| Status | Allowed `effectState` | Meaning |
| --- | --- | --- |
| `SUCCEEDED` | `APPLIED` | The bound effect completed; result digest is present |
| `DENIED` | `NOT_APPLIED` | Authorization was denied |
| `CANCELLED` | `NOT_APPLIED` | Cancellation completed before application |
| `EXPIRED` | `NOT_APPLIED` | Request/evidence expired before execution claim |
| `SUPERSEDED` | `NOT_APPLIED` | A newer lifecycle generation displaced the request |
| `INVALIDATED` | `NOT_APPLIED` | Broker/system lifecycle invalidation or tombstone |
| `FAILED` | `APPLIED`, `NOT_APPLIED`, or `UNKNOWN` | Execution failed; the receipt states what can safely be proven |

`INVALIDATED` is a broker/system lifecycle fact. It must **not** masquerade as
canonical human denial evidence.

`FAILED + UNKNOWN` is fail-closed evidence: an effect might have occurred.
Clients must not create a new idempotency key and retry automatically. They must
reconcile the external effect or obtain stronger terminal evidence first.

`EXPIRED` is valid only before execution claim. After claim, expiry alone cannot
prove non-application: cancellation must produce `CANCELLED` if non-application
is established, or `FAILED + UNKNOWN` if the effect cannot be reconciled.

`claimedAt` is required for `SUCCEEDED` and for `FAILED + APPLIED/UNKNOWN`,
forbidden for `DENIED` and `EXPIRED`, and optional for `FAILED + NOT_APPLIED`
and other `NOT_APPLIED` lifecycle outcomes because they may occur before claim
or race with it while still proving non-application. Temporal order is:

```text
authorization.decidedAt <= claimedAt? <= completedAt <= issuedAt
signature.createdAt >= issuedAt
```

For a request or approval reference, `issuedAt/decidedAt < expiresAt`. Every
negotiation selection has `issuedAt < validUntil`. A `SELECTED` response and a
non-expiry rejection must not extend beyond the signed offer's expiry. An
`OFFER_EXPIRED` rejection is issued at or after offer expiry and uses a separate,
short server evidence-validity window; it never revives the offer or authorizes
a protocol version. A terminal receipt remains evidence after request expiry;
key-retention and historical verification policy are outside this v0 schema.

Signature timestamps also remain inside the signed message window: request and
offer `issuedAt <= signature.createdAt <= expiresAt`; approval evidence
`decidedAt <= signature.createdAt <= expiresAt`; selection
`issuedAt <= signature.createdAt <= validUntil`; receipt
`issuedAt <= signature.createdAt`; signed error
`issuedAt <= signature.createdAt`.

### 8. Error envelopes are not effect evidence

An error envelope represents a parsing, authentication, negotiation, replay, or
pre-lifecycle availability fault. It is never proof of approval, denial, effect
application, or non-application. An expired negotiation offer uses the signed
`REJECTED + OFFER_EXPIRED` selection; an authenticated effect request uses the
signed `EXPIRED` receipt defined above.

`error.message` must be generic, bounded, and safe for the intended caller. It
must not contain prompts, tool input, credentials, customer identifiers,
topology, stack traces, private policy detail, or raw upstream/provider output.
`detailsDigest` may bind separately retained diagnostic evidence; it is not a
locator and does not authorize disclosure.

Once an effect may have started, an endpoint must return a signed terminal
receipt. If it cannot establish whether the effect happened, that receipt is
`FAILED + UNKNOWN`; returning a plain `503` would be unsafe.

### 9. Resource limits fail before execution

Deployments must publish and enforce bounded request-body, inline-artifact,
referenced-artifact, nesting, string, collection, and decompression limits.
Oversized or expansion-unsafe input is rejected before authorization or effect
claim. Protocol v0 does not set universal numeric limits because transport and
deployment profiles differ; negotiated capabilities may only narrow limits and
must never silently broaden the signed request.

### 10. Version negotiation never silently downgrades

The signed client offer orders supported versions by preference and separates
required from optional capabilities. The signed server response either chooses
one offered version and an explicit capability set or rejects the negotiation.

The selection repeats the offer's negotiation identifier and nonce. It expires
at `validUntil`. Missing capabilities, unknown fields, or negotiation failure
must not cause fallback to an older or less strict protocol.

If the offer is already expired, the only negotiation result is signed
`REJECTED + OFFER_EXPIRED`. Its `issuedAt` is at or after the offer expiry and
its short `validUntil` is server evidence retention, not an extension of client
authority.

Required and optional capability sets in an offer are disjoint. For a
`SELECTED` response, `selectedVersion` must occur in both the signed client
offer and `serverSupportedVersions`; `acceptedCapabilities` must contain every
required capability and may contain only capabilities the client offered. A
`REJECTED` response contains no selected version and an empty accepted set.
Every subsequent request, approval-evidence reference, receipt, and error for
this draft uses exactly `0.1.0-draft`, and an implementation must additionally
verify that it equals the negotiated selection. Schema validity alone never
authorizes a downgrade.

Every effect request contains a signed `NegotiationBinding` with the
`negotiationId`, selected version, and `EnvelopeDigest` of the complete signed
`SELECTED` response. Before request admission, the endpoint verifies that exact
selection, its server identity/signature, validity window, selected version,
and accepted capabilities. Concurrent, expired, rejected, or substituted
selections cannot authorize a request. The receipt repeats the exact negotiation
binding from the request.

## Scope deliberately excluded from v0

The following are private implementation concerns or later protocol work and
must not be added to this schema as leaked runtime structures:

- Guardian internals or decision heuristics;
- policy evaluation algorithms;
- database tables, queues, workers, scheduling, or storage layout;
- authentication-provider configuration;
- secrets, key material, billing, pricing, tenancy topology, or deployment
  topology;
- model-provider internals;
- generated SDKs or runtime workspace dependencies;
- bulk effects, wildcards, reusable broad approvals, or implicit tool identity;
- compatibility adapters for current IDE/runtime object shapes.

## Provenance and open/closed boundary

Repository inspection baseline:
`f331fa976f043f5e909ea0e60aeafbdd4fd1446a` (July 14, 2026). This directory is
a newly authored review draft based on high-level architectural constraints,
the external standards listed above, and the same-change provenance controls
documented in:

- `docs/provenance/PROTOCOL_EXTRACTION_AUDIT.md`;
- `docs/provenance/OPEN_CLOSED_COMPONENT_MATRIX.md`;
- `docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json`.

No direct extraction or copying of a source file, type definition, test fixture,
schema, constant set, or call contract from `clodex-contracts`, browser schemas,
`runner-sdk`, `agent-shell`, `agent-core`, tests, or fixtures is approved for
this draft. Those are RED extraction sources. In particular, the
`runner-sdk -> agent-shell` dependency is a hard boundary blocker, not a
shortcut for protocol implementation.

Documentation/spec inputs are YELLOW and still require exact file-and-revision
mapping, source-context disclosure, and independent approval. The provisional
input inventory is in
`docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json`; the reconstructed requirement
catalogue is [`REQUIREMENTS.md`](./REQUIREMENTS.md). Because the catalogue was
recorded in the same change as the schemas, it is review evidence, not proof
that approved requirements preceded authoring. This draft must not be
represented as a completed clean-room or publishable artifact until an
independent reviewer approves the inputs and re-derivation/mapping record.

This directory does not change the repository's license and does not establish
that the schema can be relicensed, moved into a private repository, or used to
generate private implementation code. A network/API boundary alone is not a
legal provenance boundary.

## Gate before any Gateway code

Do **not** publish, relicense, generate SDKs, or begin private Gateway
implementation from this draft until all of the following are recorded:

1. provenance matrix is GREEN with exact file/revision ownership evidence;
2. input manifest and stable requirement catalogue are independently approved;
3. legal/license owner approves the protocol publication license explicitly;
4. no AGPL/Stagewise-derived runtime, schema, fixture, or transitive dependency
   crosses the boundary;
5. threat model covers canonicalization, signatures, replay, expiry,
   idempotency, confused-deputy identity, evidence substitution, and unknown
   effect state;
6. protocol review resolves every normative/schema mismatch;
7. conformance fixtures are authored independently from the approved spec;
8. a clean-room implementation plan names separate inputs, owners, and review
   evidence.

Until then, the correct next step is review of provenance and Protocol v0—not
Gateway implementation.
