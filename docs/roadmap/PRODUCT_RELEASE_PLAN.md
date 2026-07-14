# CLODEx Product and Release Plan

**Planning baseline:** 2026-07-14
**Current source version metadata:** `1.16.0`
**Current committed candidate target:** `v1.16.0-preview.2`

Dates in this plan are target windows, not promises. A release moves when its
gates are green; a date never overrides a failed security, provenance, test,
signing, or operational gate.

## 1. Release strategy

CLODEx has two parallel but separate delivery tracks:

1. **Local secure IDE track:** finish the P0 security closure, ship the next
   preview candidate, then promote a stable local-first `1.16.0`.
2. **Open-protocol/private-service track:** audit provenance, define public
   Protocol v0, enforce the dependency boundary, and only then build a private
   managed Gateway toward `1.17.0`.

The Gateway is not a prerequisite for the stable local IDE. It must not delay
`1.16.0`, and it must not be rushed into the public monorepo.

Version ownership is separated by artifact:

| Artifact | Repository/visibility | Version owner |
| --- | --- | --- |
| CLODEx IDE and local security core | This public repository | Public Git tags such as `v1.16.0` and `v1.17.0-alpha.1` |
| Protocol schemas/conformance corpus | Public incubator here, then a separately approved public package/repository | Its own `0.x` schema/package version after provenance approval |
| Managed Agent Gateway and enterprise service | Separate private repositories only | Private build/service version; never created, tagged, or packaged from this repository |

Later `1.17`/`1.18` milestones below name the public IDE/client compatibility
line and a product channel. They do not grant the private service the same Git
tag or authorize private artifacts in this repository.

Repository version metadata, source completion, and product promotion are
different states. The presence of `1.16.0` metadata does not mean the stable
release gates have passed.

## 2. Status at the planning baseline

| Workstream | Status on 2026-07-14 | Remaining release work |
| --- | --- | --- |
| P0 zero-trust foundation | Implemented on `main` | Integrate and verify the final durable approval/MCP lifecycle increment |
| Durable lifecycle increment | Candidate in PR #16; `IMPLEMENTED_UNVERIFIED` until required checks and review pass | Resolve CI/review findings, merge, run the batched independent audit/test gate |
| `v1.16.0-preview.2` plan | Committed release target; `preview.1` is the published rollback baseline | Revalidate the manifest against the exact final source; use a different `preview.N` only if the release owner explicitly re-plans; never reuse a published tag |
| Provenance/license boundary | Started as a decision record | Complete component, author, dependency, asset, and notice evidence |
| Public Protocol v0 | YELLOW schema-only incubator draft; not publishable/extractable | Approve immutable inputs and requirements, independently review/re-derive schemas, then author synthetic conformance vectors |
| Boundary CI | Not complete | Deny forbidden private dependencies, copied source, secrets, and unreviewed generated inputs |
| Managed Gateway | Not started; intentionally blocked | Begin only after boundary gates B0–B5 and Protocol gates PV0-G01–PV0-G10 |
| Enterprise/cloud operations | Planned | Begin after the synthetic Gateway slice is accepted |

## 3. Milestones and target release windows

### M0 — Boundary sprint and P0 integration

**Window:** 2026-07-14 through 2026-07-28
**Release:** none by itself

Parallel deliverables:

1. component-level provenance/license/dependency matrix;
2. Protocol v0 schema and conformance-vector draft;
3. private-repository dependency deny policy;
4. P0 durable lifecycle integration and CI remediation;
5. governance, sanitized product packaging, and release evidence plan.

Exit criteria:

- no unresolved P0 implementation blocker;
- every boundary candidate classified GREEN/YELLOW/RED for its stated use;
- Protocol v0 contains no managed server implementation;
- no private or restricted material is staged in the public repository;
- deferred verification is explicitly recorded, not treated as completion.

### M1 — Next `1.16.0` security preview

**Target window:** 2026-07-27 through 2026-07-31
**Version:** `v1.16.0-preview.2`. Use another `v1.16.0-preview.N` only if the
release owner explicitly re-plans before promotion; never move or reuse a
published tag.

Scope:

- P0 zero-trust and durable MCP approval lifecycle;
- fail-closed persistence, replay protection, lifecycle/preemption fences;
- no managed Gateway implementation;
- release notes that accurately distinguish implemented, verified, and gated
  capabilities.

Required gates:

- PR #16 or its successor merged without unresolved blocking review;
- required CI, typecheck, lint, unit/integration, and platform checks green;
- independent security-focused source review complete;
- desktop attribution gate `OCB-006` green from the final packaged artifacts;
- signed/notarized artifacts and validation manifests for supported platforms;
- manual acceptance and rollback target confirmed;
- five-installation canary with at least a 24-hour clean observation window.

If implementation work intentionally defers local tests, the preview remains
blocked until GitHub CI or the designated verification model produces the
missing evidence.

### M2 — Stable local secure IDE

**Target window:** 2026-08-10 through 2026-08-14
**Version:** `v1.16.0`

Release promise:

- secure local IDE and local Guardian path;
- durable approval/effect persistence and recovery;
- no dependency on the private Gateway for baseline security;
- advanced cloud/remote capabilities remain gated unless their own evidence
  is green.

Required gates:

- M1 canary remains clean and all stop conditions are closed;
- no open P0/P1 security defect in the release scope;
- clean install, upgrade, restart/recovery, approval, MCP, and rollback
  acceptance;
- release signing/notarization, checksums, SBOM/provenance evidence, owner
  sign-off, monitoring, and rollback ownership;
- desktop attribution gate `OCB-006` remains green for the promoted artifacts,
  including Nucleo redistribution evidence or removal;
- public documentation and support scope match shipped behavior.

This is the first near-term user release target. It does **not** wait for a
commercial Gateway.

### Boundary checkpoints before the alpha

These checkpoints do not publish a Gateway release:

| Checkpoint | Target date | Required outcome |
| --- | --- | --- |
| **Day 30** | 2026-08-13 | Reviewed provenance matrix, Protocol v0 review candidate, synthetic conformance vectors, and boundary-CI design |
| **Day 60 review** | 2026-09-14 | First-business-day review after calendar day 60 (2026-09-12): boundary gates B0–B5 decision, secured private-repository baseline, and—only if all gates are green—an internal synthetic vertical slice |
| **Day 90** | 2026-10-12 | Independent boundary/security review, protocol compatibility decision, and alpha go/no-go evidence |

Missing a checkpoint moves the alpha date; it does not authorize parallel
implementation around the failed gate.

### M3 — Protocol/Gateway alpha

**Target window:** 2026-10-12 through 2026-10-16
**Public IDE/client version:** `v1.17.0-alpha.1`
**Private service version:** separately assigned in the private repository

Public scope:

- reviewed Protocol v0 schemas, version negotiation, errors, replay and
  idempotency rules, signed receipt semantics, synthetic conformance vectors;
- IDE client integration behind a non-production feature gate;
- thin/generated SDK only if its provenance and package-license gate is green.

Private scope:

- separately hosted synthetic vertical slice:
  `IDE -> admission -> policy -> runner interface -> signed receipt -> audit`;
- no customer data, production credentials, or public-monorepo runtime import.

Required gates:

- boundary policy B0, provenance B1, protocol B2, enforcement B3, private
  baseline B4, and explicit authorization B5 all green;
- protocol threat model and compatibility policy reviewed;
- automated proof of zero forbidden AGPL/Stagewise implementation dependency
  closure in private code;
- synthetic end-to-end receipt/evidence verification.

### M4 — Design-partner beta

**Target window:** 2026-12-07 through 2026-12-11
**Public IDE/client version:** `v1.17.0-beta.1`
**Private service version:** separately assigned in the private repository

Scope:

- tenant control plane, OIDC/SSO, initial RBAC, policy synchronization;
- managed runner scheduler and secret-broker interfaces;
- evidence retention/query, audit/SIEM export, metering;
- isolated staging, key rotation, backup/restore, monitoring, and incident
  runbooks.

Required gates:

- tenant-isolation and authorization review;
- idempotency/replay and signed-receipt verification under failure/retry;
- privacy, retention, residency, and data-deletion policy approved;
- restore drill and incident exercise passed;
- independent security and open-source boundary review;
- design partners and datasets explicitly approved—synthetic by default.

Beta is a controlled pilot, not general availability.

### M5 — `1.17.0` release candidate and limited availability

**RC target:** 2027-02-01 through 2027-02-05 (`v1.17.0-rc.1`)
**Limited-availability target:** 2027-03-15 through 2027-03-19 (public
IDE/client compatibility line `v1.17.0`; private service version remains
separate)

Scope:

- protocol compatibility commitment for the `1.17` line;
- one production deployment model first;
- SCIM, fleet management, enterprise policy, compliance evidence export;
- support/SLA, operational ownership, metering, and rollback procedures;
- sanitized public Security Whitepaper.

Required gates:

- 90-day boundary program evidence complete;
- rights/provenance and dependency-boundary sign-off;
- red-team findings remediated or explicitly accepted by the security owner;
- tenant isolation, HSM/KMS/secret custody, restore, incident, privacy, and
  retention gates green;
- controlled pilot observation meets reliability and security SLOs;
- unit economics and support readiness approved.

The public `v1.17.0` client is the compatibility release for this channel. The
separately versioned managed service remains limited availability for approved
tenants; it is not broad enterprise GA merely because the public client version
is stable.

### M6 — Enterprise GA

**Target window:** 2027-06-14 through 2027-06-18
**Public IDE/client version target:** `v1.18.0`
**Private service version:** separately assigned in the private repository

GA requires evidence from the limited-availability period, a closed critical
security backlog, production incident/restore exercises, capacity and regional
failure tests, support coverage, customer-data controls, and final legal,
security, privacy, and business sign-off.

## 4. Gate catalogue

| Gate | Meaning | Minimum evidence |
| --- | --- | --- |
| **R0 — scope** | Candidate content is frozen and classified | Change list, version/tag check, no private artifacts |
| **R1 — implementation** | Required source behavior exists | Reviewed source, migrations/contracts, `IMPLEMENTED_UNVERIFIED` cleared |
| **R2 — verification** | Behavior is demonstrated | CI, tests, typecheck/lint, security audit, conformance and failure-path evidence |
| **R3 — distribution** | Artifacts are trustworthy | Reproducible inputs, signatures, notarization, checksums, SBOM/provenance |
| **R4 — operations** | Release can be operated and reversed | Acceptance, canary, monitoring, incident owner, rollback drill |
| **B0–B5 — boundary** | Public/private separation is authorized | Evidence defined in `OPEN_CLOSED_BOUNDARY.md` |
| **C1 — customer data** | Real pilot data is authorized | Privacy/retention/residency/deletion approval and tenant consent |
| **C2 — commercial** | Paid operation is supportable | SLA/support, billing, unit economics, legal terms, owner sign-off |

No gate may be waived implicitly. A time-boxed exception must identify the
owner, scope, risk, compensating control, expiry, and rollback condition; P0
authorization, secret custody, tenant isolation, provenance, and release
signing are not schedule-waivable.

## 5. What remains in the overall implementation plan

Two critical paths run in parallel; the protocol/service path does not block the
local `1.16` release.

**Track A — local secure IDE `1.16`:**

1. close PR/CI findings for the durable approval/MCP lifecycle and merge the
   reviewed P0 increment;
2. clear accumulated `IMPLEMENTED_UNVERIFIED` debt through the designated
   verification model and CI;
3. close desktop attribution gate `OCB-006` on final artifacts;
4. promote preview, acceptance, canary, signing/notarization, then stable
   `v1.16.0`.

**Track B — public Protocol/private managed service:**

1. complete component rights, authorship, dependency, asset, and notice
   provenance;
2. approve Protocol inputs/requirements, independently review or re-derive the
   schemas, then author conformance vectors;
3. enforce source/dependency/secret/generated-input firewalls, SBOM, and
   provenance attestations;
4. only after `B0`–`B5` and `PV0-G01`–`PV0-G10`, build the private synthetic
   slice with no production/customer data;
5. add enterprise alpha/beta capabilities, run licensing/security/privacy/
   reliability reviews and pilots, then promote limited availability and GA
   only from measured evidence.

## 6. Definition of release-ready

“Code implemented” is not “version released.” A version is release-ready only
when:

- its exact scope and user promise are written;
- source, schemas, host ownership, persistence semantics, security behavior,
  UI states, and migrations are complete where applicable;
- the batched audit/test/CI evidence is green;
- privacy-safe telemetry, feature gates, rollback, docs, and operational owners
  exist;
- distributed artifacts are signed, verifiable, and accepted on supported
  platforms;
- all boundary, customer-data, and commercial gates required for that channel
  are green.

This permits fast parallel implementation now while preserving one hard rule:
**verification may be deferred during coding, but it may not be deferred past
release promotion.**
