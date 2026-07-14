# Release signing and update-server readiness

This checklist covers the content-free preflight for distributable desktop
releases. It does not create a tag, build an installer, submit an artifact for
notarization, create a GitHub release, or change repository settings.

## GitHub Environment contract

Create or use the GitHub Environment named exactly `Release`. The reusable
browser release workflow binds both its promotion gate and build matrix to that
environment, so environment protection rules run before a release tag is
created and environment-scoped secrets and variables are available to the
preflight.

For a macOS artifact set, the `Release` Environment must contain these
**GitHub Secrets**:

```text
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
APPLE_SIGNING_IDENTITY
MACOS_CERT_P12_BASE64
MACOS_CERT_P12_PASSWORD
```

For a Windows artifact set, it must contain these **GitHub Secrets**:

```text
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
AZURE_ACCOUNT_NAME
AZURE_ACCOUNT_ENDPOINT_URI
AZURE_CERTIFICATE_PROFILE_NAME
```

Every distributable artifact set must contain this **GitHub Variable**:

```text
UPDATE_SERVER_ORIGIN
```

`UPDATE_SERVER_ORIGIN` must be an absolute HTTPS URL. A path prefix is allowed;
credentials, query parameters, and fragments are rejected. The preflight never
prints the URL or any secret value.

`APPLE_SIGNING_IDENTITY` must select a valid `Developer ID Application`
identity imported by `MACOS_CERT_P12_BASE64`. The optional macOS readiness job
imports the P12 into its ephemeral runner keychain and verifies the configured
identity without printing the identity list.

The readiness CLI and manual readiness workflow default to `macos`, matching
the current macOS-arm64 Preview target. In that mode, missing Azure values do
not block readiness. Use `--artifacts=all` (or `artifact_set=all`) for the
cross-platform release workflow, which builds both macOS and Windows artifacts
and therefore requires both secret groups.

Preview, alpha, and beta observation builds additionally require this
**GitHub Secret** before the release tag is created:

```text
POSTHOG_API_KEY
```

The readiness CLI defaults to `--channel=release`. Pass `--channel=preview`
(or `release_channel=preview` in the manual workflow) for the technical
preview preflight.

## Content-free blocker codes

Missing Environment entries use deterministic codes:

```text
GH_ENV_RELEASE_SECRET_APPLE_ID_MISSING
GH_ENV_RELEASE_SECRET_APPLE_PASSWORD_MISSING
GH_ENV_RELEASE_SECRET_APPLE_TEAM_ID_MISSING
GH_ENV_RELEASE_SECRET_APPLE_SIGNING_IDENTITY_MISSING
GH_ENV_RELEASE_SECRET_MACOS_CERT_P12_BASE64_MISSING
GH_ENV_RELEASE_SECRET_MACOS_CERT_P12_PASSWORD_MISSING
GH_ENV_RELEASE_SECRET_AZURE_TENANT_ID_MISSING
GH_ENV_RELEASE_SECRET_AZURE_CLIENT_ID_MISSING
GH_ENV_RELEASE_SECRET_AZURE_CLIENT_SECRET_MISSING
GH_ENV_RELEASE_SECRET_AZURE_ACCOUNT_NAME_MISSING
GH_ENV_RELEASE_SECRET_AZURE_ACCOUNT_ENDPOINT_URI_MISSING
GH_ENV_RELEASE_SECRET_AZURE_CERTIFICATE_PROFILE_NAME_MISSING
GH_ENV_RELEASE_SECRET_POSTHOG_API_KEY_MISSING
GH_ENV_RELEASE_VAR_UPDATE_SERVER_ORIGIN_MISSING
GH_ENV_RELEASE_VAR_UPDATE_SERVER_ORIGIN_INVALID
```

The macOS keychain and packaged-signature checks can also report:

```text
MACOS_KEYCHAIN_CHECK_REQUIRES_MACOS
MACOS_KEYCHAIN_IDENTITY_QUERY_FAILED
MACOS_DEVELOPER_ID_IDENTITY_NOT_FOUND
MACOS_DEVELOPER_ID_IDENTITY_TYPE_INVALID
MACOS_DEVELOPER_ID_AUTHORITY_MISSING
MACOS_DEVELOPER_ID_TEAM_MISMATCH
```

JSON reports contain only requirement names, statuses, and blocker codes. They
contain no values, lengths, hashes, or encoded secret material.

## Safe dry runs

Generate a local content-free report. With no release credentials in the local
environment, this intentionally exits successfully and lists the exact
blockers:

```bash
pnpm release:signing:readiness -- \
  --artifacts=macos \
  --channel=preview \
  --allow-blocked \
  --report=/tmp/clodex-signing-readiness.json
```

List configured names without printing values:

```bash
gh secret list --env Release --json name --jq '.[].name'
gh variable list --env Release --json name --jq '.[].name'
```

After the readiness workflow exists on the selected Git ref, dispatch only the
non-distributable readiness workflow:

```bash
gh workflow run release-signing-readiness.yml \
  --ref <workflow-ref> \
  -f ref=<candidate-ref> \
  -f artifact_set=macos \
  -f release_channel=preview \
  -f check_macos_keychain=true
```

Do not use `auto-release.yml`, `technical-preview-release.yml`, or
`nightly-release.yml` for a readiness-only check: those workflows can create
tags, installers, and GitHub releases.

## What the real macOS validator enforces

For a non-ad-hoc distributable build, `validate-macos-release.mjs` requires:

1. an HTTPS `UPDATE_SERVER_ORIGIN` accepted by the update client contract;
2. a hardened-runtime signature with a signing team identifier;
3. a `Developer ID Application` leaf authority whose team matches the signed
   application's team identifier;
4. successful Gatekeeper assessment of the DMG, mounted app, and copied app;
5. valid stapled notarization tickets on the DMG, mounted app, and copied app;
6. the existing checksum, ZIP, ASAR integrity, entitlement, fuse, smoke, and UI
   launch checks.

Electron Forge notarizes the application during packaging. The release workflow
then submits the DMG with `notarytool --wait`, staples it, validates the DMG
ticket, and runs the validator.

## External blockers not resolved by readiness code

- A repository administrator must provision the `Release` Environment and its
  protection rules, Secrets, and Variable.
- Apple must accept the credentials and the final binaries. Presence checks and
  a valid local Developer ID identity cannot guarantee a future notarization
  response.
- The configured update server must be deployed, reachable, and serving the
  expected feeds. The preflight validates the URL contract, not production
  availability.
- Azure Trusted Signing account/profile policy and credentials must be active;
  the content-free contract only verifies their configured presence.
