# Preview release acceptance

Target: `v1.16.0-preview.2`

Rollback target: `v1.16.0-preview.1`

Canary: five installations for at least 24 hours

The preview acceptance harness combines deterministic source checks, the
existing macOS package-validation manifest, explicit manual acceptance, a
content-free canary aggregate, and a reviewed rollback drill. It never stores
prompts, messages, workspace data, credentials, user identifiers, installation
identifiers, or raw logs.

## Toolchain

```bash
export PATH=/private/tmp/clodex-toolchains/node-v22.23.1-darwin-arm64/bin:$PATH
node -v
corepack pnpm -v
```

Expected versions are Node.js `v22.23.1` and pnpm `10.30.3`.

## Create an evidence template

Run this from the exact clean release worktree:

```bash
node --import tsx scripts/release/check-preview-acceptance.ts \
  --print-template \
  --output=/private/tmp/clodex-preview-2-acceptance-input.json
```

Set only aggregate check statuses in that file. Do not add free-form logs,
credentials, trace IDs, account IDs, installation IDs, prompts, or workspace
paths.

## Automated acceptance

When the macOS artifact session emits its validation manifest, run:

```bash
node --import tsx scripts/release/check-preview-acceptance.ts \
  --input=/private/tmp/clodex-preview-2-acceptance-input.json \
  --artifact-validation=/path/to/macos-arm64-1.16.0-preview.2.json \
  --packaged-app=/path/to/Clodex.app \
  --run-source-checks \
  --allow-hold \
  --output=/private/tmp/clodex-preview-2-acceptance-report.json
```

Automated checks cover:

- exact source commit and clean worktree;
- pinned Node.js and pnpm versions;
- package validation manifest, packaged smoke, and clean-profile launch;
- packaged application icon;
- Developer ID, Gatekeeper, and notarization evidence;
- green Quick Task visual regression;
- task creation, controlled browser, MCP, Guardian/Egress, and session recovery
  contracts.

An ad-hoc artifact may prove smoke and UI launch, but it cannot pass the
`security.distribution-trust` gate.

## Manual acceptance

Use a temporary profile only:

```bash
profile="$(mktemp -d)/profile"
"/path/to/Clodex.app/Contents/MacOS/Clodex" \
  --user-data-dir="$profile" \
  --disable-gpu
```

Complete every manual matrix row:

1. Dock or tray surface displays the current Clodex badge.
2. Quick Task is green, creates a task, and opens it.
3. Terminal executes `printf 'clodex-acceptance\n'` and closes normally.
4. Controlled browser opens a local page without unrestricted egress.
5. A local non-secret MCP fixture connects and exposes one safe tool.
6. A guarded network action displays the expected Guardian/Egress prompt.
7. After restart, the accepted task and its workspace state recover correctly.

The main user profile must not be used for release acceptance.

## Canary-5

Run exactly five installations for at least 24 hours. Store only aggregate
counts:

- launch attempts and failures;
- crashes and crash loops;
- authentication attempts and failures;
- Guardian/Egress prompts, missing prompts, and unexpected allows;
- restart/recovery attempts and failures;
- data-loss, Guardian-bypass, and signature/trust incidents.

Promotion requires:

- five installations;
- ten launches, five auth attempts, five egress prompts, and five recovery
  attempts;
- zero failures, crashes, unexpected allows, data-loss incidents, bypasses, or
  trust failures;
- a full 24-hour observation window.

Immediately stop the canary on any crash, launch failure, recovery failure,
data loss, missing Guardian prompt, unexpected egress allow, Guardian bypass,
signature/trust failure, or authentication failure rate above 20% after at
least five attempts. A sixth installation is also a scope violation and stops
the canary; the acceptance gate requires exactly five unique installations.

## Rollback drill

The harness emits these reviewable commands but never executes them:

```bash
export ROLLBACK_DIR="$(mktemp -d)"
gh release view v1.16.0-preview.1 --json tagName,isPrerelease,assets
gh release view v1.16.0-preview.2 --json tagName,isPrerelease,assets
gh release download v1.16.0-preview.1 \
  --pattern '*.dmg' \
  --pattern '*.sha256' \
  --dir "$ROLLBACK_DIR"
shasum -a 256 -c "$ROLLBACK_DIR"/*.sha256
```

Incident-only distribution stop:

```bash
gh release edit v1.16.0-preview.2 --draft
```

Do not run the incident command during rehearsal. Electron updates are
forward-only: stopping preview.2 protects users who have not upgraded, but an
already-updated client requires a manual reinstall of preview.1 or a newer
forward-fix build.
