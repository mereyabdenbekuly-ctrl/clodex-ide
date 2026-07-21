# Community observed builds

`community-observed` is a separate, manually dispatched distribution lane for
privacy-safe product telemetry experiments. It does not replace or mutate any
existing `community-unsigned` artifact, including `1.16.0-community4`.

## Identity and version namespace

- distribution mode: `community-observed`;
- app name: `Clodex Agentic IDE (Community Observed)`;
- executable/package base: `clodex-community-observed`;
- bundle ID: `xyz.clodex.agentic-ide.community-observed`;
- version: `<base>-communityobserved<workflow-run-number>`, for example
  `1.16.0-communityobserved42`;
- build output: short-lived GitHub Actions artifacts named
  `clodex-community-observed-*`;
- public output, when separately approved: one immutable prerelease containing
  exactly five unchanged installers, one evidence ZIP, and `SHA256SUMS.txt`.

The build workflow has read-only repository permissions and creates no tag or
release. Publication is a separate protected workflow that pins one successful
build run, exact source commit, version-derived tag, immutable-release
attestation, and redistribution approval. It stages a draft, uploads and
verifies all seven assets, then publishes once; updater and promotion assets are
forbidden.

## Current public Technical Preview

Community Observed 14 (`1.16.0-communityobserved14`) is built from exact source
[`0ea2e51368410d2d197d14f34c0c0640bc16323f`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/commit/0ea2e51368410d2d197d14f34c0c0640bc16323f)
by [Actions run `29840259012`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/runs/29840259012)
and published under
[`v1.16.0-communityobserved14`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved14).

The packaged Free/managed boundary, byte-level audit, artifact identity, and
metadata gates passed. This is still an unsigned/ad-hoc, non-notarized test
prerelease and is excluded from auto-update and official preview/canary/stable
acceptance.

## Unsigned community trust boundary

Observed builds preserve the `community-unsigned` operating-system trust
semantics:

- macOS is ad-hoc signed and not notarized;
- Windows executables are explicitly `NotSigned`;
- Linux packages have no CLODEx vendor package signature;
- secure CLODEx.xyz account authentication is enabled through the system
  browser; an RFC 8252 loopback callback is bound to the initiating IDE with
  state and PKCE S256;
- legacy query-code and unbound bearer callbacks remain rejected;
- auto-update, update payloads, and default OS protocol registration remain
  disabled;
- the separate app/bundle identity creates a separate local profile.

The artifact validators and bundle assembler fail closed unless these
properties and the exact source commit are present.

Authentication is part of the `community-observed` distribution policy, not a
one-off workflow override. Future observed builds must keep
`CLODEX_AUTH_ENABLED=true` while leaving default protocol registration off.
The `community-unsigned` lane remains account-free.

## Telemetry contract

Telemetry remains **off until the user makes a required first-run choice**.
The blocking screen provides two equally available outcomes: allow anonymous
statistics or continue without statistics. The decision is versioned and
stored locally; it can be changed later in Settings without signing in.
Profiles created by an earlier observed build have no current decision marker
and must make the new choice once after upgrading, including profiles that had
previously enabled the older checkbox.
Only the current consent version together with the `anonymous` telemetry level
starts the backend client. Selecting `full`, or setting `anonymous` without a
current consent marker, is treated as telemetry off in this distribution.

When opted in:

- only `posthog-node` in the backend receives the project ingestion key;
- PostHog `privacyMode`, GeoIP disablement, remote-config disablement and
  exception-autocapture disablement are enforced;
- PostHog person-profile processing is disabled for every observed event;
- renderer PostHog has no key; autocapture and session recording are disabled;
- account identification/aliasing, exception events and AI model tracing are
  disabled;
- lifecycle events do not inspect the host running-process list;
- a stable pseudonymous installation identifier separates installations
  without sending an account identity;
- a central sanitizer retains bounded enum metadata, booleans and numeric
  counters while dropping strings/objects that could contain prompts, source,
  messages, tool arguments, commands, paths, URLs, API keys, credentials,
  errors, titles or feedback.

Packaged-ASAR validation requires exactly one `phc_` project key in the backend
entry graph, rejects that key in every other ASAR entry and in
`app.asar.unpacked`, and records the privacy contract in validation evidence.

## Manual workflow setup

The workflow is `.github/workflows/community-observed-build.yml`.

1. Create the protected GitHub Environment `CommunityTelemetry`.
2. Add exactly one environment secret named `POSTHOG_PROJECT_API_KEY`.
3. Store a PostHog project ingestion key (`phc_...`), never a Personal API key.
4. Dispatch from the exact canonical `main` commit and enter
   `BUILD_COMMUNITY_OBSERVED`.

The job validates the secret before installing/building and maps it to
`POSTHOG_API_KEY` only for the Electron packaging step. It is never mapped to a
`VITE_*` renderer variable, committed to the repository, printed, used for
source-map upload, or included in release authority workflows.

## Protected publication

The publication workflow is
`.github/workflows/community-observed-publish.yml`. It must run from canonical
`main` after immutable GitHub Releases are enabled and the protected `Release`
environment approves the exact build identity. The publisher verifies the
source SHA, run ID, run attempt, artifact names and digests, installer bytes,
evidence contents, checksum coverage, draft asset set, and terminal immutable
release before reporting success.
