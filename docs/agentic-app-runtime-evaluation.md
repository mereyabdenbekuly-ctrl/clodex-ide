# Agentic App Runtime Evaluation Suite

Checkpoint date: 2026-07-11.

The evaluation suite is a deterministic, content-free release gate for the
Generated App Capability Bridge. It exercises the real `ArtifactBridgeService`,
package trust service, sensitive-egress policy, async operation registry and
Runtime Inspector using in-memory persistence and MCP adapters.

## Commands

Run the suite and write strict JSON evidence:

```bash
cd apps/browser
pnpm eval:agentic-app-runtime
```

The default evidence path is:

```text
apps/browser/test-results/agentic-app-runtime-evaluation.json
```

Validate previously generated evidence:

```bash
pnpm check:agentic-app-runtime-evaluation
```

Custom paths and machine-readable output are supported:

```bash
pnpm eval:agentic-app-runtime -- --output /tmp/runtime-eval.json
pnpm check:agentic-app-runtime-evaluation -- \
  --evidence /tmp/runtime-eval.json \
  --json
```

## Scenarios

The release gate requires every scenario:

1. `session-replay`
   - closes a session-scoped grant;
   - reuses the same session identifier;
   - verifies that the old grant cannot be replayed.
2. `one-time-commit`
   - commits an approved sensitive MCP request;
   - retries the same commit token;
   - verifies idempotent result delivery without a second provider execution;
   - verifies that a different token is denied.
3. `cross-principal-isolation`
   - verifies that another agent and a package principal cannot inherit a
     grant;
   - verifies that an async operation cannot be read from another preview
     session.
4. `grant-revoke-latency`
   - collects at least 25 revoke-to-denial samples;
   - verifies immediate backend denial after every revoke.
5. `credential-egress`
   - verifies result redaction;
   - blocks raw credential-shaped arguments before provider execution;
   - verifies provider-error and audit redaction.
6. `package-trust`
   - rejects signing-key substitution;
   - rejects silent re-trust after revocation;
   - enforces publisher allowlists;
   - invalidates an active package grant when package trust disappears.
7. `runtime-inspector-content-free`
   - creates pending writes and completed sensitive calls with canary content;
   - verifies that Runtime Inspector snapshots contain neither arguments,
     results nor approval tokens.

## Release thresholds

Security rates are zero-tolerance:

| Metric                    |      Required |
| ------------------------- | ------------: |
| Scenario failure rate     |           `0` |
| Replay acceptance rate    |           `0` |
| Cross-principal leak rate |           `0` |
| Secret leak rate          |           `0` |
| Package-trust bypass rate |           `0` |
| Revoke latency samples    |       `>= 25` |
| Revoke-to-denial p95      |   `<= 100 ms` |
| Revoke-to-denial maximum  |   `<= 250 ms` |
| Evidence age              | `<= 24 hours` |

The suite also requires content-free report, audit and Runtime Inspector quality
gates plus fail-closed package revocation.

The latency metric measures the deterministic local control-plane path. It does
not claim to measure renderer scheduling, human approval time, network latency
or remote MCP cancellation latency.

## CI and release integration

Monorepo CI executes the suite and then parses the serialized evidence again.
The browser release workflow applies the same gate to non-nightly builds.

Evidence parsing is strict. Unknown fields, stale evidence, missing scenarios,
insufficient samples or any non-zero security violation fail the command.

## Evidence safety

Evidence contains only:

- scenario identifiers and pass/fail state;
- assertion counts and bounded failure codes;
- aggregate violation counters;
- aggregate latency percentiles;
- boolean quality gates.

It deliberately excludes prompts, MCP arguments, MCP results, source code,
credentials, commit tokens and raw exception messages.
