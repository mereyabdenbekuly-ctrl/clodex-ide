# Protocol v0 requirement catalogue — reconstructed review draft

> **Status: `RECONSTRUCTED / UNAPPROVED / NOT CLEAN-ROOM EVIDENCE`.**
>
> These IDs make the current schema draft reviewable. The catalogue was written
> in the same change as the schemas, so it does not prove that approved
> requirements preceded schema authoring. Promotion requires approval of the
> input manifest and an independent re-derivation/mapping review.

## Boundary and version

| ID | Requirement |
| --- | --- |
| `PV0-BOUND-001` | The public artifact defines wire semantics only and contains no managed Gateway, storage, policy engine, scheduler, tenant administration, cloud topology, secret custody, or billing implementation. |
| `PV0-VER-001` | Every post-negotiation v0.1 effect request, evidence reference, receipt, and effect-exchange error uses exactly `0.1.0-draft` and must equal the signed negotiated selection. |
| `PV0-VER-002` | No implementation silently selects, retries with, or falls back to an unoffered or less strict protocol version/capability set. |
| `PV0-VER-003` | Bootstrap negotiation errors use the fixed `0.1.0-draft` negotiation envelope version even though no protocol selection exists yet. |

## Identity and immutable effect binding

| ID | Requirement |
| --- | --- |
| `PV0-BIND-001` | One effect binding fixes tenant, actor plus authentication-context digest, device/trust state, agent identity/build, task, step/attempt, exact tool/server/version, intent/descriptor/context/effect digests, and policy ID/version/digest. |
| `PV0-BIND-002` | Request artifacts, approval evidence, authorization decision, execution claim, and receipt repeat the exact binding; an implementation rejects rather than repairs, merges, infers, or broadens a mismatch. |
| `PV0-BIND-003` | `ATTESTED` device state requires an attestation digest; other trust states must not claim one. |
| `PV0-BIND-004` | The exact signed requested-effect artifact is the v0 object-level capability boundary; no wildcard, ambient, reusable broad, or post-authorization substituted target is permitted. |
| `PV0-BIND-005` | Step attempt is a bounded non-negative integer no greater than `2147483647`, preventing cross-runtime numeric rounding in signed data. |

## Artifacts, canonicalization, and signatures

| ID | Requirement |
| --- | --- |
| `PV0-ART-001` | Inline, reference, and out-of-band artifact representations are mutually exclusive. |
| `PV0-ART-002` | Every artifact is bound by SHA-256 and canonical unpadded base64url; JSON uses RFC 8785 bytes and raw content uses the exact decoded byte sequence. |
| `PV0-ART-003` | Base64url decodes successfully and decode/re-encode equality proves the unique canonical representation. |
| `PV0-ART-004` | Locator retrieval cannot add authority and must be scheme/origin allowlisted, credential-free, redirect constrained, and protected from local/private/metadata-network access. |
| `PV0-ART-005` | JSON parsing rejects duplicate member names, invalid Unicode, non-finite/out-of-domain numbers, and parser-dependent normalization before schema, digest, or signature processing. |
| `PV0-SIG-001` | Signed envelopes use Ed25519, the `clodex-agent-gateway-v0.jcs` profile, RFC 8785, and the documented domain separator. |
| `PV0-SIG-002` | An envelope digest hashes the same domain-separated bytes as signature input, including signature metadata and excluding only `signature.value`. |
| `PV0-SIG-003` | Signature use requires key trust, tenant scope, revocation, and time-validity checks; schema validity alone grants no authority. |

## Replay, idempotency, and evidence consumption

| ID | Requirement |
| --- | --- |
| `PV0-REPLAY-001` | Replay, evidence, and negotiation nonces encode at least 128 CSPRNG bits in canonical base64url and are scoped as defined by the protocol. |
| `PV0-REPLAY-002` | `tenantId + idempotencyKey` lookup precedes nonce rejection: exact request digest returns the stored terminal receipt without reauthorization/execution; changed digest is `IDEMPOTENCY_CONFLICT`. |
| `PV0-REPLAY-003` | A new idempotency key carrying an already consumed request nonce is rejected before authorization/execution. |
| `PV0-EVID-001` | Approval evidence is signed, expiring, `SINGLE_EFFECT`, and bound to the complete effect binding. |
| `PV0-EVID-002` | One `evidenceId + evidenceNonce + binding` authorization is single-consumption: it may appear only in the original canonical request; exact duplicate delivery returns the original receipt, and reuse in another request never executes. |
| `PV0-EVID-003` | Valid `DENIED` evidence is durable negative authority and forces `DENIED + NOT_APPLIED`; policy, Guardian, retry, or missing-state fallback cannot override it. |

## Authorization, execution, and receipts

| ID | Requirement |
| --- | --- |
| `PV0-AUTH-001` | Authorization and execution claim use the same immutable binding without a time-of-check/time-of-use substitution window. |
| `PV0-AUTH-002` | The receipt authorization policy equals the binding policy and cited approval evidence is bound by both ID and envelope digest. |
| `PV0-RCPT-001` | Every admitted effect lifecycle ends in one signed terminal receipt; a plain transport error is not effect evidence. |
| `PV0-RCPT-002` | `DENIED` and pre-claim `EXPIRED` are `NOT_APPLIED`; pre-evaluation expiry records `NOT_EVALUATED/LIFECYCLE` rather than fabricating a decision; durable exact denial evidence takes precedence over expiry; `SUCCEEDED` is `APPLIED`; `FAILED` explicitly states `APPLIED`, `NOT_APPLIED`, or `UNKNOWN`. |
| `PV0-RCPT-003` | `FAILED + UNKNOWN` blocks automatic new-key retry until the external effect is reconciled or stronger terminal evidence exists. |
| `PV0-RCPT-004` | `claimedAt` and receipt timestamps follow the status matrix and the documented authorization/claim/completion/issuance order. |

## Errors, negotiation, and limits

| ID | Requirement |
| --- | --- |
| `PV0-ERR-001` | Error envelopes are bounded, caller-safe, non-evidentiary, and contain no prompt, tool input, credential, customer identifier, topology, stack trace, private policy, or raw upstream output. |
| `PV0-ERR-002` | Once an effect may have started, availability or internal failure is represented by a signed terminal receipt, using `FAILED + UNKNOWN` when application cannot be established. |
| `PV0-NEG-001` | A selection is signed and repeats the offer negotiation ID and nonce; selected version belongs to both offered and server-supported sets. |
| `PV0-NEG-002` | Accepted capabilities include every required capability, include only offered capabilities, and are empty on rejection; required and optional offer sets are disjoint. |
| `PV0-NEG-003` | A selected or non-expiry rejection window cannot extend the signed offer; an `OFFER_EXPIRED` rejection uses a separate short evidence-validity window and never revives client authority. Evidence/request expiry cannot be extended by clock-skew or server policy. |
| `PV0-NEG-004` | Every effect request and receipt binds the exact signed selected negotiation by negotiation ID, selected version, and selection envelope digest; substituted, rejected, expired, or capability-incompatible selections are rejected. |
| `PV0-LIMIT-001` | Deployments enforce published request, artifact, nesting, collection, string, and decompression limits before authorization or effect claim. |

## Privacy and provenance

| ID | Requirement |
| --- | --- |
| `PV0-PRIV-001` | Digests do not imply confidentiality; content, locators, identities, and evidence are minimized and never logged by default. |
| `PV0-PROV-001` | Protocol files, vectors, and generated artifacts trace to approved inputs and requirement IDs and contain no RED-source copying or private/customer/production material. |
| `PV0-PROV-002` | This draft does not authorize a license, SDK generation, publication, or private Gateway implementation until `PV0-G01` through `PV0-G10` and `B0` through `B5` are GREEN. |

## Provisional trace map

| Requirement groups | Draft artifacts |
| --- | --- |
| `PV0-VER-*`, `PV0-NEG-*` | `version-negotiation.schema.json`, `openapi.yaml`, README section 10 |
| `PV0-BIND-*`, `PV0-ART-*`, `PV0-REPLAY-*` | `common.schema.json`, `request-envelope.schema.json`, README sections 1–4 |
| `PV0-EVID-*` | `approval-evidence-reference.schema.json`, README section 5 |
| `PV0-AUTH-*`, `PV0-RCPT-*` | `signed-effect-receipt.schema.json`, README sections 6–7 |
| `PV0-ERR-*`, `PV0-LIMIT-*` | `error-envelope.schema.json`, `openapi.yaml`, README sections 8–9 |
| `PV0-PRIV-*`, `PV0-PROV-*` | README boundary/provenance sections and `docs/provenance/PROTOCOL_EXTRACTION_AUDIT.md` |

An independent reviewer must replace this provisional group mapping with
file/field-level evidence before `PV0-G03` or `PV0-G04` can close.
