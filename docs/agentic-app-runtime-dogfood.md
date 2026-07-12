# Agentic App Runtime Dogfood and Prerelease Promotion

Checkpoint date: 2026-07-11.

This phase validates the complete Agentic App Runtime in physical prerelease
builds. Automation can collect and verify evidence, but it cannot claim that a
human performed the manual flows. Promotion therefore requires both aggregate
dogfood counters and explicit operator attestations.

## Safety model

Promotion evidence contains only bounded aggregate counters, timestamps,
boolean attestations and a SHA-256 link to deterministic evaluation evidence.
It must never contain prompts, source code, MCP arguments or results,
credentials, approval tokens, user identifiers, app names or exception text.

The collector refuses to write `.release-evidence/agentic-app-runtime.json`
unless every threshold passes. The checker strictly parses both artifacts and
fails if the linked deterministic evaluation file has changed.

Physical builds emit one content-free event:

```text
agentic-app-runtime-dogfood
```

Allowed properties are bounded activity/outcome enums, principal kind,
capability/operation/security categories and an installation-scoped HMAC used
only to count distinct generated apps. Raw app, agent and package IDs never
leave the process. MCP names, arguments, results, errors, prompts, approval
tokens and operation IDs are rejected by the telemetry schema.

## Observation window

Use signed alpha or beta builds with all Agentic App Runtime feature gates
intentionally enabled for the dogfood cohort. Observe at least:

| Requirement              |  Minimum |
| ------------------------ | -------: |
| Observation window       | 72 hours |
| Evidence age             | 48 hours |
| Distinct builds          |        2 |
| Distinct installs        |       25 |
| Preview sessions         |       25 |
| Distinct generated apps  |       10 |
| Capability invocations   |      200 |
| Each privileged flow     |        1 |
| Operational failure rate |  `<= 1%` |
| Security violations      |        0 |

Privileged flows are sensitive approvals, write approvals, async operations,
Runtime Inspector reviews and package trust reviews.

## Manual dogfood matrix

Run every row on a packaged prerelease build. Record defects in the issue
tracker, but put only aggregate counts in the evidence input.

### 1. Preview lifecycle

1. Generate or import an app with no privileged capabilities.
2. Open, reload, close and reopen the preview.
3. Confirm that the iframe stays isolated and the bridge reconnects only
   through a new session handshake.
4. Attest with `--preview-lifecycle-passed`.

### 2. Session-scoped ephemeral grants

1. Approve a capability for the current preview session.
2. Verify the operation succeeds.
3. Reload or close the preview.
4. Verify the previous grant is rejected and a new approval is required.
5. Attest with `--ephemeral-grant-reload-passed`.

### 3. Sensitive MCP approval and redaction

1. Exercise a sensitive MCP operation.
2. Review the separate confirmation surface and deny once.
3. Approve a new request and verify its bounded result.
4. Confirm Preview, errors, Runtime Inspector and audit surfaces reveal no
   credential-shaped values or raw arguments/results.
5. Attest with `--sensitive-approval-passed`.

### 4. Async completion, cancellation and timeout

1. Start an allowed async operation and observe successful completion.
2. Start another operation and cancel it.
3. Exercise the timeout path.
4. Confirm terminal states are stable, scoped to the preview session and do not
   leak provider error content.
5. Attest with `--async-cancel-timeout-passed`.

### 5. Runtime Inspector

1. Review active sessions, grants, pending approvals, operations and audit
   summaries.
2. Revoke a grant and verify immediate denial in the app.
3. Confirm the Inspector is content-free.
4. Attest with `--runtime-inspector-passed`.

### 6. Package trust

1. Import a trusted signed package and review requested capabilities.
2. Reject an untrusted or changed package.
3. Revoke trust from an active package and confirm its grant fails closed.
4. Attest with `--package-trust-review-passed`.

## Automatic aggregate collection

Set a PostHog Personal API key and project ID:

```bash
export POSTHOG_PERSONAL_API_KEY='...'
export POSTHOG_PROJECT_ID='...'
```

During the observation window, collect a progress snapshot without making any
manual promotion attestations:

```bash
cd apps/browser
pnpm collect:agentic-app-runtime-promotion-evidence -- \
  --from 2026-07-01T00:00:00.000Z \
  --to 2026-07-05T00:00:00.000Z \
  --aggregate-only \
  --aggregate-output /secure/path/agentic-app-runtime-dogfood.json
```

The collector submits one aggregate-only HogQL query. PostHog returns a single
row of counts; individual event rows, `distinct_id`, app versions and app HMACs
are never returned to the collector.

The resulting local JSON has this shape:

```json
{
  "schemaVersion": 1,
  "sourceChannel": "prerelease",
  "observationStartedAt": "2026-07-01T00:00:00.000Z",
  "observationEndedAt": "2026-07-05T00:00:00.000Z",
  "observedBuildCount": 3,
  "observedInstallCount": 30,
  "dogfood": {
    "previewSessions": 30,
    "distinctGeneratedApps": 12,
    "capabilityInvocations": 250,
    "sensitiveApprovals": 5,
    "writeApprovals": 5,
    "asyncOperations": 10,
    "inspectorReviews": 5,
    "packageTrustReviews": 3,
    "failures": 1,
    "replayViolations": 0,
    "isolationViolations": 0,
    "secretLeaks": 0,
    "trustBypasses": 0
  }
}
```

Unknown fields are rejected. Keep progress snapshots outside version control.
`--dogfood-aggregate` remains available as an offline fallback when the
aggregate row was collected and reviewed separately.

## Create promotion evidence

Run the deterministic suite immediately before collection:

```bash
cd apps/browser
pnpm eval:agentic-app-runtime
pnpm check:agentic-app-runtime-evaluation
```

After completing every manual row:

```bash
pnpm collect:agentic-app-runtime-promotion-evidence -- \
  --from 2026-07-01T00:00:00.000Z \
  --to 2026-07-05T00:00:00.000Z \
  --source-commit "$(git rev-parse HEAD)" \
  --aggregate-output /secure/path/agentic-app-runtime-dogfood.json \
  --preview-lifecycle-passed \
  --ephemeral-grant-reload-passed \
  --sensitive-approval-passed \
  --async-cancel-timeout-passed \
  --runtime-inspector-passed \
  --package-trust-review-passed
```

For an offline reviewed aggregate, replace `--from`, `--to` and
`--aggregate-output` with:

```text
--dogfood-aggregate /secure/path/agentic-app-runtime-dogfood.json
```

The default output is:

```text
.release-evidence/agentic-app-runtime.json
.release-evidence/agentic-app-runtime-evaluation.json
```

The second file is the exact deterministic evidence bytes referenced by the
promotion artifact. Keep the pair together. CI may run a fresh deterministic
suite independently, but promotion verification uses this immutable bundled
copy so its SHA-256 remains reproducible.

## Protected GitHub workflow

`.github/workflows/agentic-app-runtime-promotion.yml` is the trusted collection
path for release evidence. It runs only from `main`, requires
`source_commit == GITHUB_SHA`, decodes a bounded gzip+base64 aggregate, runs a
fresh deterministic suite, and binds the resulting evidence to that exact
commit and evaluation byte hash. All six manual gate booleans must be selected
explicitly; the workflow does not infer or fabricate a human review.

Prepare the reviewed content-free aggregate without placing the uncompressed
input in the repository:

```bash
AGGREGATE_B64="$({ gzip -n -9 -c \
  /secure/path/agentic-app-runtime-dogfood.json \
  | base64 | tr -d '\n'; })"

python3 - "$AGGREGATE_B64" "$(git rev-parse main)" \
  > /tmp/agentic-app-runtime-promotion-input.json <<'PY'
import json, sys
print(json.dumps({
    "source_commit": sys.argv[2],
    "aggregate_gzip_base64": sys.argv[1],
    "preview_lifecycle_passed": True,
    "ephemeral_grant_reload_passed": True,
    "sensitive_approval_passed": True,
    "async_cancel_timeout_passed": True,
    "runtime_inspector_passed": True,
    "package_trust_review_passed": True,
}))
PY

gh workflow run agentic-app-runtime-promotion.yml \
  --repo mereyabdenbekuly-ctrl/clodex-ide \
  --ref main \
  --json < /tmp/agentic-app-runtime-promotion-input.json
rm -f /tmp/agentic-app-runtime-promotion-input.json
```

The uploaded checksummed bundle contains the promotion evidence, its exact
linked evaluation, the strict promotion result, the main-plan readiness report,
and immutable workflow metadata. The `agentic-app-runtime-promotion`
Environment is restricted to the `main` branch. Required reviewers are still a
separate repository-administration control and must not be represented by the
six technical/manual-flow booleans.

## Promotion review

Normal CI allows absent promotion evidence while the runtime remains gated and
prints `ready=false evidence=not-required`. An actual promotion review must
require the artifact:

```bash
pnpm check:agentic-app-runtime-promotion -- \
  --require-evidence \
  --build-commit "$(git rev-parse HEAD)"
```

For an evidence bundle stored elsewhere:

```bash
pnpm check:agentic-app-runtime-promotion -- \
  --require-evidence \
  --evidence /secure/path/agentic-app-runtime.json \
  --evaluation-evidence /secure/path/agentic-app-runtime-evaluation.json \
  --build-commit "$(git rev-parse HEAD)" \
  --json
```

Do not enable release defaults merely because the deterministic suite passes.
Promotion requires fresh physical-build observation, all six human
attestations, zero security violations and product/security/operations review.
