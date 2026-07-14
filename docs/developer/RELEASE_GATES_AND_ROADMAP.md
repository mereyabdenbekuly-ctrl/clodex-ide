# CLODEx release gates and implementation roadmap

**Updated:** 2026-07-15  
**Planning model:** gate-based; this document does not promise a calendar date
or replace legal review.

## Current position

The P0 zero-trust implementation is on `main` in commit `f331fa97` (PR #15).
That baseline includes the local Guardian/security path, atomic effect work,
durable control-plane/reference components, MCP dispatch hardening, and a
testing handoff. Bulk audit and regression testing remain a separate release
gate; source implementation alone is not a release authorization.

The next correct sequence is:

```text
public/private boundary
        -> provenance and redistribution gate
        -> Protocol v0
        -> integrated audit/test/signing evidence
        -> technical preview
        -> stable release observation window
        -> private Gateway, in a separate repository
```

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
- made future `nucleo-*` use fail closed without exact approved evidence.

Current release blockers are emitted by
`pnpm --dir apps/browser release:attribution:check -- --channel=release`.
They must be resolved with real package-specific provenance and license text;
the gate must not be weakened to make the list green.
The current macOS-arm64 snapshot is
[`OCB_006_RELEASE_LICENSE_BLOCKERS.md`](../provenance/OCB_006_RELEASE_LICENSE_BLOCKERS.md).

**Exit criteria:**

- zero unknown license declarations;
- zero missing distributable license texts;
- final macOS, Windows, and Linux packages contain verified notices;
- final SBOMs match the packaged bytes and native manifests;
- file-level provenance classification is GREEN for any code proposed for a
  future permissive repository.

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
number does not make an artifact releasable. The next technical preview can be
tagged only after Gates 0–3 are green on the same commit and the platform
artifacts are reviewed. Stable `1.16.0` additionally requires the preview
observation window, blocker triage, rollback readiness, and explicit human
sign-off.

No honest date can be assigned while the provenance gate is red and Protocol
v0 is not frozen. Progress should be reported as completed gates and remaining
blockers, not as percentage guesses.

## Gate 4 — private managed Gateway (later)

Gateway implementation starts only after Gates 1 and 2 are complete and a
specialist boundary/license review approves the dependency model. It must be
created in an empty private repository and may not import this AGPL
implementation. Enterprise admin, multi-tenancy, fleet, billing, compliance,
SIEM, production topology, signing infrastructure, and private security data
remain outside this repository.
