# Integration Promotion Status

Date: 2026-07-12
Baseline commit: `cf3f34048`

## Decision

Large feature development remains frozen. The integration branch is in:

**Stabilization → CI → Dogfood → Security → Promotion**

No major system should become default-on until its promotion evidence passes
fail-closed checks.

## Stabilization and CI

| Gate                               | Result                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Root monorepo typecheck            | PASS — 17/17 Turbo tasks                                                                |
| Browser typecheck                  | PASS — UI, backend, preload, Storybook, visual                                          |
| Browser tests                      | PASS — 230 files, 1,836 tests                                                           |
| Agent Core tests                   | PASS — 76 files, 861 tests                                                              |
| Agent Shell tests                  | PASS — 13 files, 228 tests                                                              |
| Network Policy tests               | PASS — 2 files, 28 tests                                                                |
| Targeted changed-file Biome checks | PASS                                                                                    |
| `git diff --check`                 | PASS                                                                                    |
| GitHub workflow YAML parsing       | PASS                                                                                    |
| Full repository `pnpm check`       | PASS — 0 errors                                                                         |
| Deterministic prerelease package   | PASS — verified ASAR/metadata/hash, valid ad-hoc signature, isolated macOS import smoke |
| Five-epic main-plan closure gate   | PASS — 5/5 v1 code-complete and release-safe while unpromoted capabilities remain gated |

### Current integration drift

The latest concurrent Model Fabric, SSH, auth and icon changes have now been
reconciled in the shared working tree. A fresh `pnpm check` passes with zero
errors (29 non-blocking warnings), and the root `pnpm typecheck` passes all
17 Turbo tasks, including Browser UI, backend, preload, Storybook and visual
projects. Targeted Model Fabric, model-usage and runner-routing verification
also passes 139 tests across 13 files. `git diff --check`, Evidence Memory
promotion gates and the deterministic packaging guard remain green.

The root typecheck exposed and the stabilization pass fixed a newly introduced
`TS1355` error in the Network Policy audit ledger. The audit schema version now
uses the literal-typed constant directly instead of applying an invalid
expression-level `as const`.

The unified `check:main-plan-readiness` gate now aggregates Evidence Memory,
Model Fabric, Session Teleporter, Decoupled Execution and Generated App
Capability Bridge. It reports code completion separately from promotion,
rejects malformed or insufficient evidence, and permits missing evidence only
while the corresponding release behavior remains safely default-off. The
current release-channel result is `codeComplete=true`, `buildReady=true`, and
`promotionReady=false`, which is the expected pre-promotion state.

### Biome stabilization

The full CI command `pnpm check` is green. This stabilization pass removed
generated/minified bundles from Biome source linting:

- `apps/browser/src/backend/services/agent-os/remote-control-client.bundle.js`
- `apps/browser/bundled/generated-app-sdk/index.js`

Before that exclusion, those two files accounted for 391 of 541 errors. The
remaining format diagnostics were resolved in bounded Agent Core, Agent Shell,
SDK, Browser, Website and icon-package batches. All seven actionable
accessibility errors in the Docker Runner and Model Fabric settings panels were
also fixed. The formatter pass was followed by monorepo typecheck and full
Agent Core, Agent Shell and Browser test suites.

## Runtime and fault gates

| Gate                                                   | Result                     |
| ------------------------------------------------------ | -------------------------- |
| Agent Host happy-path smoke                            | PASS                       |
| Agent Host crash/restart/resync fault smoke            | PASS                       |
| Post-dispatch local fallback during crash              | PASS — 0 fallbacks         |
| Cloud memory chaos/recovery tests                      | PASS in full Browser suite |
| Guardian, sandbox, credential and network-policy tests | PASS in full Browser suite |
| Agentic App Runtime deterministic evaluation           | READY — 7/7 scenarios      |

Agent Host fault result:

```text
crashed=true restarted=true resynced=true localFallbacks=0
```

Agentic App Runtime evaluation reported no replay, isolation, secret, or trust
violations. Revoke latency p95 was approximately 1.65 ms.

## Runner dogfood

Paired-replay readiness:

- Local read-only: ready.
- Local Node build/test: ready.
- Local direct Node tool: ready.
- Local Go test: ready.
- Docker: unavailable on this machine.
- SSH: client available, but `CLODEX_RUNNER_DOGFOOD_SSH_TARGET` is not
  configured.

This proves local admission readiness, not cross-provider route quality.
Promotion of guarded automatic routing still requires real paired observations
against at least one physical non-local provider. Configure Docker or SSH and
collect replay receipts before changing rollout defaults.

## Evidence Memory dogfood

The live-model dogfood suite now creates real compressed-history checkpoints,
isolates each run by a hashed cohort identity, records explicit ground truth,
and emits content-free retrieval/admission/token diagnostics. Prompt injection
remains default-off and independently fail-closed.

Latest isolated live cohort (`gpt-5.4-mini`):

- 140 paired observations across 4 distinct tasks;
- 16/16 persisted compression checkpoints replayed as restart probes;
- 0 archive failures and 0 skipped replay observations;
- exact facts: 60/45 required;
- user constraints: 28/20 required;
- staleness: 20/15 required;
- supersession: 16/10 required;
- restart: 16/10 required.

Quality result:

- retrieval recall: **100%**;
- compressed-history recall: **45%**;
- Guarded Memory recall: **100%**;
- recall lift: **+55 percentage points**;
- compressed and guarded stale leakage: **0%**;
- guarded latency p95: **14.67 ms**;
- incremental token overhead: **6.89%** (maximum allowed: 20%);
- missing-provenance admissions: **0**;
- unresolved-contradiction injections: **0**;
- promotion blockers: **none**.

The decisive fixes were baseline-aware admission, exact-identifier matching,
query-anchor filtering, per-probe bounded retrieval, compact evidence rendering,
and separate retrieval/admission token budgets. The Inspector now exposes
retrieval packing, admission packing, reason-code counts, envelope tokens and
claim token contribution without retaining prompts or claim text.

### Promotion evidence

- deterministic quality suite: READY — 1,000 observations, 100% recall,
  0% stale rate, 100% convergence, 0 false auto-merges, 79.50% token savings;
- external content-free trace replay: READY — 140 observations, 4 tasks,
  100% guarded recall, +55 point lift, 0% stale leakage, 6.89% overhead;
- local Ed25519 promotion-envelope drill: PASS — every signature, commit,
  freshness, policy, artifact hash and external-trace check passed for a
  `canary-5` target. The candidate is bound to a detached Git snapshot of the
  current working tree; the ephemeral private key was deleted after the drill;
- local technical review: PASS — the generated candidate metadata records all
  automated rollout checks and explicitly marks the key as
  `local-development-only`;
- release-owner manual sign-off: **PENDING** — no authorized approver identity
  or release-owned Evidence Memory signing key was available. The local drill
  is not release authorization and was not copied into `.release-evidence/`.

The dogfood and promotion mechanisms are ready. Actual rollout remains
default-off because the repository does not contain release signing keys and
the release policy is still `hold` with 0% allocation.

## Security

| Scan                                             | Result                                      |
| ------------------------------------------------ | ------------------------------------------- |
| Working tree                                     | PASS — no findings                          |
| Current branch commits relative to `origin/main` | PASS — no findings                          |
| All repository refs/history                      | **REVIEW REQUIRED** — 372 redacted findings |

The all-ref findings occur outside the current branch ancestry, primarily on
`refs/remotes/clodex/*`, an old rollback tag, and one integration branch. The
largest group is in historical migration reports. This does not indicate a
secret in the current integration diff, but published refs must be audited,
credentials rotated where necessary, and history rewritten or refs removed
before an enterprise security attestation.

## Promotion state

### Evidence Memory

**DOGFOOD READY; RELEASE AUTHORIZATION PENDING.** The live cohort, deterministic
quality suite, external trace replay and signed-envelope drill all pass.
Promotion to `canary-5` now requires a release-owned Ed25519 keypair, published
evidence for the release commit, an authorized human sign-off, and an explicit
rollout-policy change. Stable and release channels remain default-off.

### Isolated Agent Runtime

**ARMED, NOT READY.** Stable remains default-off at rollout stage `next`.
Required evidence is still absent. Promotion requires at least:

- 72 observation hours;
- 2 builds;
- 25 installs;
- 500 finished steps;
- passing crash, fallback, telemetry and replay audits.

### Agentic App Runtime

**DETERMINISTIC EVALUATION READY, PROMOTION HOLD.** Promotion evidence is absent,
so the release check correctly reports `ready=false` without default-enabling
the runtime.

### Guarded Automatic Routing

**HOLD.** Local replay admission is ready, but Docker/SSH counterfactual
observations are absent.

## Next execution order

1. Provision the release-owned Evidence Memory Ed25519 signing key and publish
   the public verification key through the release secret/configuration path.
2. Regenerate quality and external trace artifacts for the exact release
   commit, sign the `canary-5` promotion envelope, and run the required-evidence
   rollout check in CI.
3. Arm only the prerelease `canary-5` policy; keep stable/release at 0% until
   canary health receipts remain green through the observation window.
4. Configure one physical Docker or SSH runner and collect verified paired
   replay receipts.
5. Audit and remediate historical all-ref secret-scan findings.
6. Reconcile current concurrent formatting/typecheck drift before merging the
   integration branch.

## Local evidence artifacts

The following generated reports are intentionally ignored by Git:

- `apps/browser/test-results/agentic-app-runtime-evaluation.json`
- `apps/browser/test-results/runner-paired-replay-readiness.json`
- `apps/browser/test-results/evidence-memory-dogfood-readiness.json`
- `apps/browser/test-results/evidence-memory-live-dogfood.json`
- `apps/browser/test-results/evidence-memory-shadow-observations.jsonl`
- `apps/browser/test-results/evidence-memory-quality.json`
- `apps/browser/test-results/evidence-memory-trace-replay.json`
- `apps/browser/test-results/main-plan-readiness.json` (when requested by the
  unified closure CLI)
- `apps/browser/test-results/evidence-memory-local-promotion/` (local-only
  signed drill, public key, verification receipt, and pending-sign-off metadata)
- `security-reports/gitleaks-working-tree.json`
- `security-reports/gitleaks-current-branch.json`
- `security-reports/gitleaks-history.json`
