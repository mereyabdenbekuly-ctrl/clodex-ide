# Isolated agent runtime rollout

## Current channel policy

| Channel | Default | Stage | Circuit breaker |
| --- | --- | --- | --- |
| dev | on | canary | 3 failures / 1 minute |
| nightly | on | canary | 2 failures / 5 minutes |
| prerelease | on | canary | 2 failures / 10 minutes |
| release | off | next | 2 failures / 10 minutes |

Stable remains default-off while prerelease evidence is collected. The
emergency switches remain available in every channel:

- `CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME=true`
- `--disable-isolated-agent-runtime`

## Start the prerelease observation window

The observation window starts only after an alpha or beta build containing
these telemetry events is published. A nightly build does not count toward the
`sourceChannel: "prerelease"` promotion evidence.

1. Merge the isolated-runtime implementation and release safeguards.
2. Run **Prepare Release** with `package=clodex` and `channel=alpha`.
3. Merge the generated release PR.
4. The reusable release workflow must pass
   `check:isolated-agent-runtime-observation-build` before it creates the tag.
   This gate verifies the prerelease channel/version, default-on canary policy,
   and presence of the PostHog ingestion key.
5. Confirm that `isolated-agent-runtime-rollout-observed` is arriving with
   `app_release_channel=prerelease` and `effective_enabled=true`.
6. Record the first valid event timestamp as the earliest possible observation
   start. Do not backdate the evidence window to the release creation time.

Before pushing the release branch, a local unsigned package can be built for
structural smoke testing:

```bash
cd apps/browser
CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true \
RELEASE_CHANNEL=prerelease \
APP_VERSION_OVERRIDE=1.16.1-alpha001 \
pnpm package
```

This switch is rejected in CI. The resulting app is unsigned, is not promotion
evidence, and must never be distributed.

## Observation signals

Filter all analytics by `app_release_channel=prerelease`.

| Evidence field | Telemetry source |
| --- | --- |
| observed installs/builds | distinct installs and `app_version` values from `isolated-agent-runtime-rollout-observed` where `effective_enabled=true` |
| completed/failed/aborted | `agent-step-runtime-finished.outcome` |
| worker crashes and recoveries | `agent-host-process-lifecycle.phase` |
| circuit breaker opens | `agent-step-runtime-circuit-breaker.state=open` |

Only aggregate counts are allowed in promotion evidence. Prompts, messages,
tool inputs/outputs, trace IDs, agent IDs, installation IDs, and raw event
rows must never be added.

## Stable readiness thresholds

- at least 72 hours of prerelease observation;
- evidence ending no more than 48 hours before the promotion check;
- at least 2 observed builds and 25 observed installs;
- at least 500 finished isolated steps;
- failed rate at most 1% of non-aborted steps;
- aborted rate at most 10%;
- worker crash rate at most 0.2%;
- circuit breaker open rate at most 0.2%;
- every worker crash recovered;
- zero restart spawn failures and restart-budget exhaustion;
- happy smoke and SIGKILL fault smoke pass;
- content-free telemetry and no-post-dispatch-replay audits pass.

## Evidence format

Create `.release-evidence/isolated-agent-runtime.json`:

```json
{
  "schemaVersion": 1,
  "sourceChannel": "prerelease",
  "observationStartedAt": "2026-07-01T00:00:00.000Z",
  "observationEndedAt": "2026-07-05T00:00:00.000Z",
  "observedBuildCount": 3,
  "observedInstallCount": 100,
  "stepOutcomes": {
    "completed": 990,
    "failed": 5,
    "aborted": 5
  },
  "workerLifecycle": {
    "crashed": 1,
    "restartSucceeded": 1,
    "restartSpawnFailed": 0,
    "restartBudgetExhausted": 0
  },
  "circuitBreakerOpened": 1,
  "qualityGates": {
    "happySmokePassed": true,
    "faultSmokePassed": true,
    "contentFreeTelemetryAuditPassed": true,
    "noPostDispatchReplayAuditPassed": true
  }
}
```

The example describes the schema; replace every count and timestamp with
observed aggregate data.

Collect the aggregate row directly from PostHog after the observation window:

```bash
export POSTHOG_PERSONAL_API_KEY=...
export POSTHOG_PROJECT_ID=...
export POSTHOG_API_HOST=https://eu.posthog.com

cd apps/browser
pnpm collect:isolated-agent-runtime-evidence -- \
  --from 2026-07-01T00:00:00.000Z \
  --to 2026-07-05T00:00:00.000Z \
  --happy-smoke-passed \
  --fault-smoke-passed \
  --content-free-telemetry-audit-passed \
  --no-post-dispatch-replay-audit-passed
```

Use the actual inclusive start and exclusive end of the reviewed prerelease
window. The Personal API Key is read only from the environment and is never
printed or written. The collector issues one aggregate-only HogQL query,
rejects unexpected response columns, and refuses to create the artifact if any
promotion threshold is not met.

Run:

```bash
cd apps/browser
pnpm check:isolated-agent-runtime-promotion -- --evidence ../../.release-evidence/isolated-agent-runtime.json
pnpm smoke:agent-host
pnpm smoke:agent-host:fault
```

## Promotion sequence

1. Collect and review prerelease aggregates.
2. Run the promotion checker and both Electron smoke tests.
3. Check in the aggregate evidence artifact.
4. Change the release policy from `defaultEnabled: false, rolloutStage: "next"`
   to `defaultEnabled: true, rolloutStage: "canary"`.
5. Create the stable release. The release workflow runs the promotion gate
   before creating a git tag.
6. Keep the emergency kill switch documented in release operations.

Rollback stable by restoring release to `defaultEnabled: false` and
`rolloutStage: "hold"`, then publish a patch release. Never replay a step that
was already dispatched to the utility process.
