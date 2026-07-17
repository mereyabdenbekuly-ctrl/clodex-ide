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
- output: short-lived GitHub Actions artifacts named
  `clodex-community-observed-*`.

The workflow creates no Git tag or GitHub Release, has read-only repository
permissions, and cannot overwrite the `community4` release assets.

## Unsigned community trust boundary

Observed builds preserve the `community-unsigned` operating-system trust
semantics:

- macOS is ad-hoc signed and not notarized;
- Windows executables are explicitly `NotSigned`;
- Linux packages have no CLODEx vendor package signature;
- authentication, auto-update, update payloads and default protocol
  registration are disabled;
- the separate app/bundle identity creates a separate local profile.

The artifact validators and bundle assembler fail closed unless these
properties and the exact source commit are present.

## Telemetry contract

Telemetry is **off by default**. Only an explicit selection of the existing
`anonymous` telemetry level starts the backend client. Selecting `full` is
treated as telemetry off in this distribution.

When opted in:

- only `posthog-node` in the backend receives the project ingestion key;
- PostHog `privacyMode`, GeoIP disablement, remote-config disablement and
  exception-autocapture disablement are enforced;
- renderer PostHog has no key; autocapture and session recording are disabled;
- account identification/aliasing, exception events and AI model tracing are
  disabled;
- a central sanitizer retains bounded enum metadata, booleans and numeric
  counters while dropping strings/objects that could contain prompts, source,
  tool arguments, commands, paths, URLs, errors, titles or feedback.

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
