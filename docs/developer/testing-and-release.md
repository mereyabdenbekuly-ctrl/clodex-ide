# Testing and release

## 1. Validation layers

### Static formatting

```bash
pnpm check
```

Biome is the repository-wide source formatter and linter.

### TypeScript

```bash
pnpm typecheck
```

Browser typecheck includes:

- UI;
- backend;
- preload;
- Storybook;
- visual-regression configuration.

Build package outputs before running Browser TypeScript in a clean worktree.

### Unit and integration tests

```bash
pnpm test
pnpm --dir apps/browser test
pnpm -F @clodex/agent-core test
pnpm -F @clodex/agent-shell test
pnpm -F @clodex/mcp-runtime test
```

### Visual tests

```bash
pnpm --dir apps/browser visual:build
pnpm --dir apps/browser visual:test
```

Visual fixtures must fix time, locale, viewport, device scale, animations, and
remote data.

## 2. Smoke tests

Important Browser smoke commands:

- `smoke:mcp-host`;
- `smoke:agent-host`;
- `smoke:agent-host:fault`;
- `smoke:cloud-tasks:suspend-resume`;
- `smoke:dictation-capabilities`;
- `smoke:dictation-hardware`;
- `smoke:remote-control-physical`.

Physical tests must report sanitized metadata only.

## 3. Packaging

Local package:

```bash
RELEASE_CHANNEL=nightly CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true pnpm --dir apps/browser package
```

Official package:

```bash
pnpm --dir apps/browser make
```

Packaging performs:

- packaging-runtime verification;
- bundled asset generation and checks;
- Vite builds;
- native dependency packaging;
- ASAR creation;
- platform signing;
- installer generation.

Never run multiple Agent Core or Browser package builds concurrently in the
same worktree.

## 4. Package verification

Verify:

- expected application identity;
- required ASAR entries;
- ASAR integrity metadata;
- Electron fuse configuration;
- platform signature;
- installer checksums;
- root and package license/notice bundle is present and user-accessible;
- final-artifact SBOM/inventory contains no unknown or missing license entry;
- Stagewise/Karton attribution is preserved;
- Nucleo redistribution rights are recorded for every bundled asset, or the
  unapproved asset is absent;
- ZIP or DMG extraction;
- clean-profile application startup.

These checks close desktop attribution gate `OCB-006`; a preview, prerelease,
or stable build must not be distributed while that gate is RED.

macOS:

```bash
pnpm release:validate:macos
```

## 5. Release channels

| Channel | Purpose |
| --- | --- |
| `dev` | Local development and broad diagnostics |
| `nightly` | Automated internal builds |
| `prerelease` | Evidence-backed canary |
| `release` | Stable production |

Feature availability is resolved independently from promotion readiness.

## 6. Main-plan readiness

Normal release-safety gate:

```bash
pnpm --dir apps/browser check:main-plan-readiness -- \
  --channel release \
  --require-clean
```

Strict promotion gate:

```bash
pnpm --dir apps/browser check:main-plan-readiness -- \
  --channel prerelease \
  --require-clean \
  --require-promotion all
```

The strict gate is expected to fail while production evidence is absent.

## 7. Promotion evidence

Each promoted subsystem owns a separate evidence authority:

| Subsystem | Evidence |
| --- | --- |
| Context Ledger | Signed quality and trace-replay packet bound to the source commit |
| Model Fabric | Authenticated policy publication and pinned trust root |
| Session continuity / Cloud Tasks | Observation window, platform smoke, SLOs, and approvals |
| Runners | Signed physical SSH/Docker paired replay |
| Generated-app runtime | Deterministic evaluation, observation aggregate, and manual gates |

Local development keys and local packets do not authorize a release.

## 8. CI security

- Pin third-party GitHub Actions to immutable revisions.
- Use protected environments for signing and promotion.
- Keep private keys in environment secrets.
- Require exact source/build identity.
- Run secret scanning on the candidate and new commit range.
- Upload only content-free aggregate reports.

## 9. Release sequence

1. Select an authoritative repository and protected branch.
2. Freeze an exact source commit.
3. Run full source and package validation.
4. Inspect the final artifact for licenses, notices, Nucleo rights, and SBOM
   completeness; close `OCB-006`.
5. Collect real evidence.
6. Obtain required human approvals.
7. Sign and notarize artifacts.
8. Run official packaged smoke and manual acceptance.
9. Enable a narrow prerelease canary.
10. Monitor health and execute a rollback drill.
11. Expand gradually and run the final strict gate.
