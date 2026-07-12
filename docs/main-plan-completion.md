# Main platform plan completion gate

Date: 2026-07-12

## Scope

The original five-epic platform plan is now tracked as one release surface:

1. Evidence Graph Memory;
2. Provider-Neutral Model Fabric;
3. Session Teleporter;
4. Decoupled Execution;
5. Generated App Capability Bridge.

The closure gate deliberately separates three questions that must not be
collapsed into one boolean:

- `codeComplete`: are the v1 contracts and independently gated implementations
  present for all five epics?
- `buildReady`: is the selected channel safe to build, with no malformed
  promotion evidence and no unapproved release-default capability?
- `promotionReady`: do all epics that currently have a release-evidence
  contract possess valid promotion evidence?

Code completion does not default-enable an experimental subsystem. Missing
evidence is safe only while the corresponding release behavior remains gated.
If an evidence artifact exists but is malformed, stale, insufficient, or fails
its linked checker, the unified gate fails closed even when the feature is
currently default-off.

## Command

Run from `apps/browser`:

```bash
pnpm check:main-plan-readiness -- --channel release
```

This is the normal integration/release safety check. It succeeds when the five
v1 epics are code-complete and unpromoted capabilities remain safely gated.

For an exact release-candidate source tree:

```bash
pnpm check:main-plan-readiness -- \
  --channel release \
  --require-clean \
  --out test-results/main-plan-readiness.json
```

Promotion operators explicitly name the epics being advanced:

```bash
pnpm check:main-plan-readiness -- \
  --channel prerelease \
  --require-promotion all \
  --out test-results/main-plan-readiness.json
```

`--require-promotion all` is intentionally strict. It requires evidence for all
five epics and therefore remains red until the release-owned keys, physical
providers, observation windows, and human approvals are supplied.

## Evidence adapters

The gate reuses existing authorities rather than reimplementing their rules:

- Evidence Memory invokes the signed, commit-bound rollout verifier and its
  linked quality/trace artifacts;
- Generated App Capability Bridge invokes Agentic App Runtime promotion and
  linked deterministic-evaluation verification;
- Session Teleporter consumes the strict Cloud Tasks release-readiness schema,
  including 72-hour observation, platform smoke, SLO, and human sign-off;
- Model Fabric verifies the authenticated policy-publication state, pinned
  roots, validity windows, and channel-appropriate canary/production stage;
- Decoupled Execution verifies fresh signed paired-replay bundles from pinned
  collectors and requires a successful physical SSH/Docker canary. This does
  not default-enable automatic routing;

Default evidence paths are under `.release-evidence/`. Cloud Tasks uses
`.release-evidence/cloud-tasks.json`; Model Fabric uses its publication state
and pinned root; runner evidence uses `runner-routing/` plus the trusted
collector key file. Optional CLI path overrides exist for release automation
and local drills.

## Report security

The schema-v1 report contains only:

- source commit and clean/dirty state;
- selected release channel;
- gate availability/default state;
- implementation and promotion states;
- bounded blocker/check identifiers;
- post-v1 scope markers.

It never contains prompts, source excerpts, tool output, credentials, signing
keys, provider endpoints, runner paths, or raw evidence payloads. `--out`
writes atomically with owner-only permissions. The report is an aggregation
receipt, not a release signature; each underlying promotion authority remains
responsible for authenticating its own evidence.

The reusable Browser release workflow runs the gate with `--require-clean`,
writes this report, and uploads it as a retained CI artifact before creating a
release tag.

## Definition of main-plan completion

The engineering plan is complete when:

- `codeComplete=true` for all five epics;
- monorepo typecheck, tests, formatting and deterministic packaging pass;
- the release-channel closure gate reports `buildReady=true`;
- every unpromoted subsystem remains default-off or unavailable in release;
- post-v1 enhancements remain explicitly outside the v1 completion boundary.

Default-on promotion is a separate operational process and still requires the
real keys, physical providers/platforms, observation windows, and human
approvals named by each subsystem's evidence contract.
