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

The IDE may discover a newer compatible Community Observed prerelease and open
its canonical GitHub release page in the user's external browser. This is a
manual release-discovery link, not an updater asset or an auto-update channel.

## Current public Technical Preview

Community Observed 19 (`1.16.0-communityobserved19`) is built from exact source
[`623b7f733b74679468c5107602921f9e26b4a151`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/commit/623b7f733b74679468c5107602921f9e26b4a151)
by [Actions run `30435058244`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/runs/30435058244)
and was published on 2026-07-29 under
[`v1.16.0-communityobserved19`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved19).

The packaged Free/managed boundary, byte-level audit, artifact identity, and
metadata gates passed. This is still an unsigned/ad-hoc, non-notarized test
prerelease and is excluded from auto-update and official preview/canary/stable
acceptance. It includes the release-discovery bridge first published in
Community Observed 15: its Settings → About page can perform an explicit manual
check for a later compatible immutable Community release, while download and
installation remain manual.

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
- Electron auto-update, background update downloads, update payloads/feeds, and
  default OS protocol registration remain disabled;
- the separate app/bundle identity creates a separate local profile.

The artifact validators and bundle assembler fail closed unless these
properties and the exact source commit are present.

## Manual release discovery (not auto-update)

A bridge-enabled Community Observed build may inspect the first bounded page of
public GitHub release metadata after an explicit user action. It considers only
a newer release from the same Community Observed lane. The UI therefore says
“No newer release found” rather than claiming that the installed build is
universally up to date.

Before exposing an action, the bridge requires an immutable prerelease bound to
an exact 40-character source commit, the canonical GitHub release page, exactly
five canonical installers plus the evidence ZIP and SHA256SUMS.txt, uploaded
asset digests and canonical URLs, and a bounded checksum manifest whose entries
match the GitHub digests for all six covered files. A malformed matching
candidate fails closed. Unrelated release lanes are ignored.

**Open GitHub Release** opens only that canonical release page in the system
browser. The bridge does not use Electron auto-update, download or select an
installer, execute a package, replace application files, restart the IDE, or
bypass any operating-system warning. Community installers remain unsigned or
ad-hoc signed and non-notarized. The user must choose the correct package on the
release page and complete installation manually.

The release-index fallback shown after a metadata-check error is also only an
external browser link. It does not treat an unverified release as compatible.
If the strict metadata and checksum checks do not produce the canonical release
URL, the IDE exposes no release action for that result.

An already-installed build cannot acquire this UI retroactively. Users of an
older build must install one bridge-enabled Community build manually once;
future checks from that build remain manual release discovery. Full automatic
download, installation, and restart remain reserved for a separately signed and
approved official release pipeline.

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
