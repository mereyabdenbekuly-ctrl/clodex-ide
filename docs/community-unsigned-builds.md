# Community unsigned desktop builds

This document defines the only authorized path for producing desktop binaries
before the project has macOS Developer ID/notarization and Windows
Authenticode credentials. It is a non-promotional, open-source testing path,
not an alternative release channel.

The normative key words **MUST**, **MUST NOT**, **SHOULD**, and **SHOULD NOT**
are used as requirements.

## Trust statement

A community unsigned build is compiled from the exact canonical `main` commit
recorded by its GitHub Actions run. Open source makes the source inspectable; it
does not authenticate a downloaded binary.

The platform trust state is intentionally limited:

- macOS applications use an ad-hoc signature and are not Developer ID signed,
  notarized, or accepted by Gatekeeper as an identified-developer release;
- Windows applications have no Authenticode publisher signature and may be
  blocked or warned about by Windows security controls; and
- Linux packages have no project release signature.

The ad-hoc macOS signature can bind the assembled application bytes, but it
does not identify CLODEx as the publisher. SHA-256 values provide integrity
relative to the manifest from the same canonical workflow run; they do not
replace a platform publisher identity.

Users MUST download only from the exact canonical Actions run or from a
corresponding GitHub community prerelease published under the bounded process
below. They must verify the recorded source commit and checksums and keep the
community application separate from any future official installation.
Documentation MUST NOT advise users to disable Gatekeeper, SmartScreen,
antivirus, or other OS security controls globally.

## Build identity

The workflow uses:

```text
RELEASE_CHANNEL=release
CLODEX_DISTRIBUTION_MODE=community-unsigned
```

`release` is retained only for the conservative feature policy and strict
packaged attribution gate. It does not make the artifact a stable release.
The distribution mode gives the application a separate identity:

```text
base name:  clodex-community-unsigned
display:    Clodex Agentic IDE (Community Unsigned)
bundle ID:  xyz.clodex.agentic-ide.community-unsigned
output:     apps/browser/out/community-unsigned
```

Package metadata uses `<base-version>-community<GITHUB_RUN_NUMBER>`, a single
SemVer prerelease identifier. The exact source SHA remains the authoritative
build identity. The build workflow MUST NOT create or reuse a Git tag for this
metadata version. A later bounded GitHub community prerelease may create a tag
that points to that exact source commit; the tag does not participate in the
build and does not convert the artifact into an official release.

## Workflow contract

`.github/workflows/community-unsigned-build.yml` MUST:

1. run only through `workflow_dispatch` from the canonical `main` branch;
2. require the exact confirmation text `BUILD_COMMUNITY_UNSIGNED`;
3. pin the dispatch SHA to the live canonical `main` SHA before any build;
4. use read-only repository permissions and check out without persisted
   credentials;
5. expose no GitHub Environment, secret, repository/environment variable,
   signing credential, publication token, or OIDC/attestation permission;
6. build macOS arm64, macOS x64, Linux x64, and Windows x64 on isolated GitHub
   hosted runners;
7. install only from the frozen lockfile after the pnpm bootstrap policy check;
8. keep authentication and telemetry disabled and compile no update-server
   origin or update feed;
9. run the strict dependency/attribution gate and the platform validator in
   `community-unsigned` mode;
10. pass the exact validation manifest and source commit to the bounded
    community-bundle assembler; and
11. upload the assembled outputs only as short-retention GitHub Actions
    artifacts.

The assembler output MUST contain only the validated installer packages,
canonical final-artifact CycloneDX SBOMs, validation manifest, warning,
SHA-256 file, and machine-readable community bundle manifest. Installer, SBOM,
and validation filenames identify the platform, architecture, and community
metadata version. The Actions artifact name carries the short source SHA; the
warning and bundle manifest bind the full source SHA. No output may claim a
release tag.

## Mandatory build exclusions

The community build workflow MUST NOT:

- reference the protected `Release` Environment or any other GitHub
  Environment;
- read `secrets.*`, `vars.*`, inherited secrets, signing material, telemetry
  keys, or publication credentials;
- request `contents: write`, `actions: write`, `id-token: write`, or
  `attestations: write`;
- create, move, fetch as authority, or publish a Git tag;
- create, update, upload to, publish, or delete a GitHub Release;
- call `_release-browser.yml`, `auto-release.yml`,
  `technical-preview-release.yml`, or any release publication workflow;
- set `UPDATE_SERVER_ORIGIN`, generate an official update feed, publish a
  `RELEASES` feed as a supported channel, or enable the in-app updater;
- register the official external `clodex` or `clodex-ide` protocol handlers;
- write under `.release-evidence`, use a release promotion manifest, or emit
  `ready-as-rollback-baseline`, `ready-for-canary`, or `ready-for-stable`;
- produce PostHog observation traffic or count installations toward preview,
  canary, stable, rollback, or feature-promotion evidence; or
- use `preview`, `canary`, `stable`, `release candidate`, or `official release`
  as the artifact's distribution status.

Build validation reports, checksums, and SBOMs are community build diagnostics.
They are not protected acceptance evidence and MUST remain outside the
preview.2 -> preview.3 -> stable evidence chain.

## Optional GitHub community prerelease

The release owner may copy the exact validated installer bytes from one
successful canonical community workflow run to a GitHub **prerelease** for
public testing. This is a distribution convenience only; it is not the
protected signed release pipeline.

Publication MUST satisfy all of the following:

1. the tag is `v<community-version>`, points to the exact source commit recorded
   by the bundle manifests, and is not reused by any official channel;
2. the GitHub record is marked prerelease, is not selected as `latest`, and its
   title contains `Community Unsigned`;
3. every installer is byte-for-byte identical to the validated Actions output;
4. `SHA256SUMS.txt` is uploaded alongside the installers and verified again
   after upload;
5. the notes link the canonical Actions run and exact source commit and state
   that signing, account sign-in, telemetry, auto-update, and promotion
   evidence are unavailable;
6. the release is excluded from update feeds, preview/canary/stable acceptance,
   installation counters, and rollback baselines; and
7. a changed installer is published only through a new canonical community
   build and a new community prerelease. Published assets are never replaced
   in place.

If the tag target, manifest, version, filename, size, or hash differs, the
publication must stop. A community prerelease never satisfies Developer ID,
notarization, Authenticode, protected acceptance, canary, or stable release
requirements.

## Redistribution and review gate

Unsigned status does not relax source, license, provenance, or bundled-notice
requirements. Every assembled platform artifact MUST contain a `READY`
attribution bundle and pass final-artifact SBOM validation. A `dev` or
`BLOCKED_DEV_ONLY` attribution result is not distributable through this path.

The automated result is an engineering check, not a legal conclusion. The
release owner must still close the residual custom/commercial terms and
platform redistribution decisions recorded in
`docs/provenance/OCB_006_RELEASE_LICENSE_BLOCKERS.md` before advertising an
artifact as generally redistributable.

## Promotion isolation and lifecycle

Community test reports may identify defects and improve source quality. They do
not authorize a rollback baseline, canary, stable promotion, update feed, or
public website download.

When official signing credentials become available, the project MUST build new
artifacts through the protected signed release workflow. A community artifact
must never be renamed, signed in place, or promoted/re-uploaded as the official
binary.
