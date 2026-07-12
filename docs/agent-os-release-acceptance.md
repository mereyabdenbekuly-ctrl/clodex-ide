# Agent OS release acceptance

Date: July 11, 2026

Target:

- Product: Clodex Agentic IDE
- Channel rehearsal: `release`
- Version: `1.16.0`
- Platform: macOS arm64

## Acceptance results

- Full monorepo tests: 14/14 Turbo tasks passed.
- Browser tests: 120 files and 1,167 tests passed.
- Agent Core tests: 52 files and 644 tests passed.
- Browser typecheck passed.
- Release promotion gate exited successfully.
- Bundled assets check passed: 100 files, 1.41 MiB.
- Scoped Agent OS and release-tooling Biome checks passed.
- Release-channel Electron packaging completed.
- Packaging and validation ran with the exact pinned runtime, Node.js
  `22.23.1` (ABI 127).
- DMG checksum verification and read-only mounting passed.
- ZIP integrity verification passed.
- The packaged application, the application mounted from the DMG, and its
  copied installation passed strict recursive code-signature verification.
- The application copied from the mounted DMG passed `--smoke-test` on an
  isolated profile.
- A full clean-profile UI launch reached both the startup-complete and
  window-shown markers.
- Smoke and UI validation use `--disable-gpu` so release acceptance is
  deterministic in headless and remote macOS runner environments.
- The single-command build-and-validation path passed:

```bash
PATH=/tmp/clodex-node22.23.1/bin:$PATH \
RELEASE_CHANNEL=release \
pnpm --dir apps/browser release:validate:macos -- \
  --allow-adhoc \
  --ui-launch \
  --channel=release \
  --arch=arm64 \
  --version=1.16.0
```

Validation outputs:

```text
apps/browser/out/release/validation/macos-arm64-1.16.0.json
apps/browser/out/release/validation/macos-arm64-1.16.0.sha256
```

## Rehearsal artifacts

These artifacts use an ad-hoc local signature and must not be distributed:

```text
apps/browser/out/release/make/clodex-1.16.0-arm64.dmg
SHA-256 6ef347f7852c97c95b1ca174f7b6545234c7e4f2aee24a1bf320c348db6cb579

apps/browser/out/release/make/zip/darwin/arm64/clodex-darwin-arm64-1.16.0.zip
SHA-256 c9150311c6576cb95c45f8003297660a40647ba1db89685e04351893429a2243
```

As expected for an ad-hoc rehearsal build, Gatekeeper rejected the app and
`stapler` reported that no notarization ticket was attached.

## Requirements for the distributable RC

The final build requires all of the following:

1. A `Developer ID Application` certificate with its private key imported into
   the build keychain.
2. `APPLE_SIGNING_IDENTITY` matching that certificate.
3. Non-empty `APPLE_ID`, app-specific `APPLE_PASSWORD`, and `APPLE_TEAM_ID`
   values for `notarytool`.
4. A configured `UPDATE_SERVER_ORIGIN`.
5. Azure Trusted Signing credentials for the Windows artifacts.
6. A clean, committed release source revision. The current working tree
   contains extensive uncommitted changes and is not a reproducible release
   source.
7. Exact Node.js `22.23.1`, matching `.node-version`, `.nvmrc`, and CI. The
   packaging preflight rejects other versions. The legacy native dependency
   used by the DMG maker does not build under Node.js 26.

After these prerequisites are available, run the real build without
`CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD`:

```bash
RELEASE_CHANNEL=release pnpm --dir apps/browser release:validate:macos -- \
  --ui-launch \
  --channel=release \
  --arch=arm64 \
  --version=1.16.0
```

The reusable browser release workflow now performs the production sequence
automatically:

1. It validates Apple, Azure, and update-server configuration before creating
   the release tag.
2. It builds signed platform artifacts with Node.js `22.23.1`.
3. On macOS, it submits the DMG with `notarytool`, waits for acceptance,
   staples the ticket, and validates the staple.
4. It runs the release validator against the packaged app, DMG, installed copy,
   and ZIP.
5. It uploads the JSON validation manifest and SHA-256 checksum file with the
   release artifacts.

The same workflow now enforces cross-platform installer acceptance:

- Windows: verifies the signed setup executable and packaged executable,
  validates the full nupkg structure, checks the `RELEASES` SHA-1 and byte
  count, performs a silent install, runs the installed app smoke test on a
  clean profile, and uninstalls it.
- Linux: validates DEB and RPM package metadata, architecture, version, and
  installed binary paths; then installs the DEB, runs the installed app under
  Xvfb on a clean profile, and purges the package.
- macOS: retains the signed/notarized DMG mount, copied-install smoke, and full
  clean-profile UI launch checks described above.
- Every platform uploads a validation JSON manifest and SHA-256 file.

Before a release tag is created, the update-server contract suite verifies
normal rollout, blocked-version fallback, channel pinning, forward-only
rollback behavior, and Squirrel.Windows feed rewriting. Emergency controls are
`UPDATE_BLOCKED_VERSIONS` and `UPDATE_CHANNEL_PINS`; they stop or redirect
further rollout but intentionally never downgrade an already-updated client.

Final acceptance requires:

```bash
codesign --verify --deep --strict --verbose=4 <app>
spctl --assess --type execute --verbose=4 <app>
spctl --assess --type open --context context:primary-signature --verbose=4 <dmg>
xcrun stapler validate <app>
xcrun stapler validate <dmg>
```

Both Gatekeeper assessment and stapler validation must succeed before the RC
is distributed.
