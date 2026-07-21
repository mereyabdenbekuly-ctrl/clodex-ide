# CLODEx release gates and implementation roadmap

**Updated:** 2026-07-15
**Planning model:** gate-based; this document does not promise a calendar date
or replace legal review.

## Current position

The P0 zero-trust foundation is on `main` in commit `f331fa97` (PR #15), and
the durable approval/MCP lifecycle increment is on `main` in commit `30c8db7d`
(PR #16). Release-plumbing corrections through exact `main`
`4ef3878b0291597b53a9e88b8ba27c6a706e9840` have passed required CI. Those
baselines include the local Guardian/security path, atomic effect work,
durable control-plane/reference components, MCP dispatch hardening, and a
testing handoff. Bulk audit, regression testing, exact packaged attribution,
signing, acceptance, and observation remain release gates; source
implementation alone is not a release authorization.

The ground-truth OCB-006 review reopened two non-npm gaps: the bundled
`vscode-eslint` source build and Windows VCRuntime DLLs. The source-tree
remediation now inventories and hash-binds those inputs, but OCB-006 is not
final-artifact GREEN until the exact platform artifacts and residual terms
review are accepted.

The release and protocol/service tracks are deliberately separate:

```text
local secure IDE 1.16:
public/private boundary (Gate 0)
        -> provenance and redistribution evidence (Gate 1)
        -> integrated audit/test/signing and exact artifact evidence (Gate 3)
        -> accepted preview.2 rollback baseline
        -> trusted exactly-five preview.3 canary and observation window
        -> stable clodex@1.16.0

protocol / managed-service track:
reviewed provenance boundary (Gate 1)
        -> Protocol v0 specification and conformance (Gate 2)
        -> reviewed private-repository boundary
        -> private Gateway, in a separate repository, toward the 1.17 line
```

Protocol v0 and the private Gateway do not block the secure local IDE
`1.16.0` release. Protocol v0 does block any managed Gateway implementation or
claim that a permissive protocol/SDK boundary is ready.

## Gate 0 — repository boundary

**Purpose:** prevent public/private contamination before any commercial work.

Required:

- repo-local `AGENTS.md` defines allowed and forbidden material;
- `.gitignore` blocks common private/data-room artifacts as defense in depth;
- contributors inspect all staged/untracked files before commit;
- private material remains outside public Git worktrees.

**Status:** implemented by the provenance/attribution branch; review required.

## Gate 1 — provenance and redistribution

**Purpose:** establish what may be distributed and what may later be extracted
into an independently licensed protocol/SDK.

Implemented in OCB-006:

- removed the ten local `nucleo-*` compatibility packages rather than
  inventing redistribution permission;
- replaced active aliases with the AGPL `@clodex/icons` package backed by
  `lucide-react`;
- added a fail-closed dependency-license inventory and packaged notice bundle;
- added final-artifact attribution checks and CycloneDX SBOM generation;
- retained Electron and Chromium runtime notices in packaged resources;
- made obvious future `nucleo-*`/`@nucleo/*` package, import, key, or named-asset
  signals fail closed without exact approved evidence, while retaining manual
  final-artifact review for renamed vendor content.

The source-tree strict gate now reports 835 macOS arm64 components (834 package
versions plus the bundled `vscode-eslint` server) and zero blockers on macOS
arm64. The archived server lock has nine separately pinned production packages;
source-map inspection proves seven are emitted and only those seven are
represented as child components in CycloneDX. That graph applies 42 reviewed
exact-version records;
the 60-record registry also covers supported release-matrix and exact lockfile
variants not present in this host inventory. It supplies pinned public evidence
only where an exact tarball omitted text or metadata. The Linux x64 CI graph
applies 43 records because it includes the exact `@libsql/linux-x64-musl`
package. Conflicts and hash drift fail closed. Final
cross-platform app/installer validation is still required. The current result
and residual release/legal decisions are
[`OCB_006_RELEASE_LICENSE_BLOCKERS.md`](../provenance/OCB_006_RELEASE_LICENSE_BLOCKERS.md).

**Exit criteria:**

- zero unknown license declarations;
- zero missing distributable license texts;
- final macOS, Windows, and Linux packages contain verified notices;
- final SBOMs match the packaged bytes and native manifests;
- file-level provenance classification is GREEN for any code proposed for a
  future permissive repository.

**Status:** source inventory engineering-GREEN after the reopened bundled-input
remediation; final macOS/Windows/Linux artifact evidence and residual terms
review remain pending on the exact release commit.

## Gate 2 — Protocol v0

**Purpose:** freeze the public boundary before implementing a managed Gateway.

Protocol v0 is a specification and conformance project, not a cloud service.
It must cover:

- protocol/version negotiation and compatibility rules;
- canonical encoding and hashing;
- principal, session, capability, intent-contract, execution-ticket, approval,
  denial, effect-commitment, effect-attestation, and signed receipt envelopes;
- descriptor and object-level capability binding;
- replay, expiry, grant epoch, revocation, and idempotency semantics;
- explicit error/uncertain outcomes without blind retry;
- signature/key-reference fields without production keys or real key IDs;
- privacy-safe audit correlation and Context Ledger/memory-lineage references;
- deterministic conformance vectors for accept and reject cases.

**Repository rule:** until Gate 1 is GREEN, implement the specification and
reference/conformance work under this repository's existing AGPL license.
Creating an Apache-2.0 `clodex-protocol` or SDK is a later extraction decision,
not part of Protocol v0 implementation.

**Exit criteria:**

- schemas and canonical bytes are frozen as `v0`;
- version negotiation rejects unsupported or downgraded messages;
- conformance vectors cover valid, malformed, expired, replayed, revoked,
  descriptor-mismatched, and signature-invalid messages;
- the IDE/reference implementation passes the conformance suite;
- a boundary/provenance review identifies exactly what can be independently
  reimplemented or extracted.

## Gate 3 — release candidate evidence

This is the intentionally deferred bulk audit/test stage.

Required before a distributable technical preview:

- full typecheck, lint, unit, integration, security invariant, and packaging
  suites on the release commit;
- cross-platform installer smoke and artifact verification;
- macOS signing/notarization and Windows signing evidence owned by release
  identities;
- dependency/secret/provenance scans;
- manual approval, rollback owner, monitoring owner, and release notes;
- no default-on capability whose feature-gate promotion evidence is missing.

## When a version can be released

The repository currently identifies the application as `1.16.0`, but that
number does not make an artifact releasable. The local release path requires
Gates 0, 1, and 3 to be green on the same commit and the platform artifacts to
be reviewed. Its fixed promotion chain is accepted `v1.16.0-preview.2`, then a
trusted exactly-five `v1.16.0-preview.3` canary, then newly built stable
`clodex@1.16.0` artifacts. Stable promotion additionally requires the canary
observation window, blocker triage, rollback readiness, and explicit human
sign-off.

Gate 2 (Protocol v0) is not a prerequisite for local `1.16.0`; it is a
prerequisite for the private Gateway and later protocol/client line. No honest
local-release date can be assigned while final cross-platform provenance,
signing, acceptance, and trusted canary evidence remain incomplete. Progress
should be reported as completed gates and remaining blockers, not as percentage
guesses.

## Gate 4 — private managed Gateway (later)

Gateway implementation starts only after Gates 1 and 2 are complete and a
specialist boundary/license review approves the dependency model. It must be
created in an empty private repository and may not import this AGPL
implementation. Enterprise admin, multi-tenancy, fleet, billing, compliance,
SIEM, production topology, signing infrastructure, and private security data
remain outside this repository.
