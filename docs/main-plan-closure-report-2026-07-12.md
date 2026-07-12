# Main Plan Closure Report

Date: 2026-07-12

## Verdict

**Engineering scope: COMPLETE.**
**Release promotion: HOLD pending real operational evidence.**

The original five-epic plan is now closed at the implementation and release
governance layers:

1. Evidence Graph Memory;
2. Provider-Neutral Model Fabric;
3. Session Teleporter;
4. Decoupled Execution;
5. Generated App Capability Bridge.

All five implementations are code-complete, independently feature-gated, and
covered by a concrete fail-closed promotion contract. Missing evidence is safe
while the corresponding release behavior remains gated; malformed or
insufficient evidence blocks the build.

## Closure matrix

| Epic | Implementation | Promotion contract | Current promotion state | Remaining external action |
| --- | --- | --- | --- | --- |
| Evidence Graph Memory | Complete | Signed, commit-bound release evidence | Absent from release evidence | Release-owned Ed25519 key, exact-commit artifacts, authorized sign-off |
| Provider-Neutral Model Fabric | Complete | Authenticated policy publication | Absent | Publish signed canary/production state and pinned root; release requires `production` |
| Session Teleporter | Complete | Cloud Tasks release-readiness evidence | Absent | 72-hour observation, platform/SLO evidence, human sign-off |
| Decoupled Execution | Complete | Trusted signed paired-replay evidence | Absent | Physical SSH/Docker run, pinned collector, at least 4 fresh samples across 2 command classes |
| Generated App Capability Bridge | Complete | Linked runtime evaluation evidence | Absent | Promotion aggregate and manual quality gates linked to deterministic evaluation |

Automatic runner routing, stable default-on memory rollout, external HSM/KMS
adapters, and broader enterprise rollout remain explicitly post-v1 or
operational promotion work. They are not hidden implementation blockers for
the main engineering plan.

## Verification performed

- Main-plan prerelease closure gate: `ready=true`, `codeComplete=true`,
  `buildReady=true`, `promotableEpicCount=5`.
- Strict `--require-promotion all`: expected fail-closed result with all five
  release evidence packages absent.
- Repository Biome check: 1,928 files passed.
- Monorepo typecheck: 17/17 Turbo tasks passed.
- Browser test suite: 231 files and 1,842 tests passed.
- New promotion assessment coverage includes:
  - authenticated Model Fabric production publication;
  - missing/untrusted roots and collectors;
  - fresh SSH paired replay;
  - stale and controlled-only evidence rejection;
  - duplicated bundle, sample, receipt, and job replay rejection.

Machine-readable reports:

- `apps/browser/test-results/main-plan-readiness.json`;
- `apps/browser/test-results/main-plan-promotion-readiness.json`.

## What is deliberately not claimed

- The shared working tree is currently dirty and concurrently used, so this is
  not an exact clean release-candidate attestation.
- Local development keys and drills are not release authorization.
- No physical SSH/Docker promotion bundle is present in `.release-evidence/`.
- No missing human sign-off has been synthesized.

## Final operational sequence

1. Freeze and commit the exact release candidate.
2. Run the five evidence collectors against that exact candidate.
3. Obtain release-owner/security approvals and signatures.
4. Place only aggregate, content-free artifacts under `.release-evidence/` or
   inject them through protected CI.
5. Run:

   ```bash
   pnpm --dir apps/browser check:main-plan-readiness -- \
     --channel prerelease \
     --require-clean \
     --require-promotion all \
     --out test-results/main-plan-readiness.json
   ```

6. Promote only the approved prerelease canary. Stable defaults remain gated
   until the observation windows stay green.
