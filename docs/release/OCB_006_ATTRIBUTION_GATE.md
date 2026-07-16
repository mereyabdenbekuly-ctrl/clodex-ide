# OCB-006 desktop attribution and SBOM gate

**Status:** source-tree strict gate GREEN (835 macOS arm64 components: 834
package versions plus the bundled `vscode-eslint` server; its 9 exact
production-lock packages are license/integrity bound and 7 are proven emitted;
0 blockers);
final artifact evidence must still pass before a distributable build can be
promoted

## Release invariant

A community unsigned, preview, nightly, prerelease, or stable desktop artifact
is not distributable unless all of the following are true:

1. the packaged application contains the repository AGPL license,
   `THIRD-PARTY-NOTICES.md`, `CLODEX_VS_UPSTREAM.md`, `CONTRIBUTORS.md`, and the
   Karton MIT license, plus the Electron license and Chromium runtime notice
   inventory copied from the installed Electron distribution;
2. every inventoried open-source or custom-license runtime/bundled dependency
   has a non-empty, non-`Unknown` license declaration and distributable license
   text;
3. the packaged attribution manifest hashes match the bytes in the final
   application;
4. platform validation emits a CycloneDX SBOM from the packaged `app.asar`, the
   attribution inventory, observed unpacked/native package manifests, and every
   applicable non-npm bundled component;
5. every native package observed in the packaged application is present in the
   approved dependency-license inventory; and
6. every downloaded source archive and fixed binary bundle is immutable-version
   and SHA-256 pinned, and every final bundled file matches its reviewed or
   generated provenance record; and
7. Nucleo assets are absent or covered by an `APPROVED`, unexpired record
   in
   [`NUCLEO_REDISTRIBUTION_EVIDENCE.json`](../provenance/NUCLEO_REDISTRIBUTION_EVIDENCE.json).

The gate does not treat `NUCLEO_LICENSE_KEY`, package names, or the existence of
source files as redistribution permission. Contracts, license keys, receipts,
and other non-public evidence remain outside Git; the public evidence record
contains only a non-secret decision and external evidence references.

## Current Nucleo decision: removed

No redistribution right is claimed or invented. The ten former local
`nucleo-*` compatibility packages were removed, their package dependencies were
deleted, and active imports now resolve to the AGPL `@clodex/icons`
compatibility package backed exclusively by the separately inventoried
`lucide-react` dependency. Unused placeholder SVGs and the local custom GitHub
SVG were not moved; the GitHub icon now uses Lucide.

If a future change adds an obvious `nucleo-*` or `@nucleo/*` dependency/import,
license-key path, or Nucleo-named asset, the automated gate becomes applicable
again and can become green only through one of these reviewed changes:

- replace/remove every Nucleo package and prove the final artifact contains none;
  or
- update the evidence record to `APPROVED` with exact package coverage,
  `desktop-application-binary` scope, accountable approval, validity dates, the
  applicable license name, and non-secret references to the external rights
  evidence.

Changing the JSON status without the underlying evidence is a release-policy
violation.

The source scan is defense in depth, not a claim that renamed or obfuscated
vendor assets can always be identified automatically. Final-artifact inspection
and accountable release review remain mandatory for that class of evidence.

## Exact-version license supplements

Some exact npm tarballs declare a license while omitting the corresponding
root text. CLODEx does not solve that with a generic SPDX or package-name
fallback. The public
[`DEPENDENCY_LICENSE_OVERRIDES.json`](../provenance/DEPENDENCY_LICENSE_OVERRIDES.json)
registry binds each exception to exact `package@version`, npm tarball integrity,
review status, a public provenance trail, and a SHA-256-pinned local text.

An override is applicable only when the exact package is missing license text
or has missing/`Unknown` metadata. It may not contradict a non-empty package
declaration. Duplicate identities, unsafe paths, missing evidence, hash drift,
unreviewed status, or a changed exact package-file license all fail closed.

The current macOS arm64 strict inventory applies 42 reviewed records:

- 28 pinned upstream license texts;
- 6 pinned SPDX canonical supplements where the exact package already declares
  the matching SPDX license;
- 2 exact package-file metadata repairs;
- 4 combined license/notice bundles; and
- 2 public GSAP custom-license snapshots.

The registry contains 54 records in total. The additional twelve exact,
integrity-bound records cover platform-specific native variants or exact
lockfile variants not present in this macOS arm64 inventory.

The Linux x64 CI inventory applies 43 reviewed records because it includes the
exact `@libsql/linux-x64-musl@0.5.29` platform record alongside the applicable
GNU variant. Its applied basis counts are 29 upstream, 6 canonical, 2 exact
package files, 4 combined bundles, and 2 custom-license snapshots; 11 registry
records are non-current on that host.

The GSAP snapshot is attribution evidence, not a determination that every
CLODEx use is permitted. Release ownership and specialist counsel must review
those custom terms. The sharp-libvips bundle likewise retains GPL/LGPL terms
and pinned third-party notices, but final artifact/source-obligation review is
still mandatory.

## Non-npm bundled components

[`BUNDLED_COMPONENTS.json`](../provenance/BUNDLED_COMPONENTS.json) covers
runtime material that package-manifest traversal cannot discover:

- the `vscode-eslint` `3.0.10` server build is bound to immutable Git revision
  `790646388696511b2665a4d119bf0fb713dd990d`, a SHA-256-pinned source archive,
  and the exact upstream MIT text. The build emits `provenance.json` with the
  byte count and SHA-256 of every generated file and the exact before/after
  hashes for its reviewed Node 22 webpack transform. Final validation rejects
  missing, extra, or changed bundle files. Every invocation downloads and
  verifies the immutable archive again; local bundle/provenance files never
  authorize a skip. Extraction runs from the verified in-memory bytes in a
  per-run private directory, rejects traversal, filesystem aliases, path/type
  collisions, unreviewed symlinks, special entries, and resource-limit drift,
  and materializes only the two exact reviewed upstream symlinks.
  Same-filesystem staging, lock, and rollback state lives outside the packaged
  `bundled/` tree; stale work fails closed, and the bundled-assets validator
  independently rejects reserved work-state siblings before packaging. The
  archived npm locks are installed by invoking the official `npm-cli.js`
  through the pinned Node executable, avoiding platform-specific shell wrappers.
  The exact archived server lock and
  nine production packages are integrity/license bound. Source-map inspection
  currently proves seven are emitted by webpack; only those seven become child
  CycloneDX components, while `lru-cache` and `yallist` remain explicitly
  classified as production-lock-only evidence;
- Windows x64 `VCRuntime.CefSharp.140` `1.0.5` is bound to the exact NuGet URL,
  archive SHA-256, NuGet catalog SHA-512, exact nuspec, signature-entry hash,
  and five independently pinned DLLs. The package metadata and project MIT text
  are retained as evidence.

The VCRuntime record is deliberately
`CONDITIONAL_UPSTREAM_TERMS`. The engineering gate does not infer from the
NuGet package's MIT expression that redistribution of Microsoft runtime DLLs is
automatically authorized. Release ownership and specialist counsel must verify
the applicable Microsoft runtime terms and organizational entitlement before
distribution. No `APPROVED` rights record is fabricated.

## Generated and packaged files

Electron Forge generates `apps/browser/.generated/release-attribution/` and
copies it into the application resources as `release-attribution/`. Generated
files are not committed. Forge also copies Electron's `LICENSE` and
`LICENSES.chromium.html` into the application resources so macOS, Windows, and
Linux artifacts retain the runtime notices even when the platform packager does
not preserve the files at the application root. The attribution bundle contains:

- the required root/upstream/Karton notices;
- `dependency-licenses.json` with the complete gate result;
- the public Nucleo evidence record;
- the reviewed exact-version dependency-license override registry; and
- the bundled-component registry plus exact upstream license/metadata evidence;
- `manifest.json` with byte counts and SHA-256 hashes.

The Windows/Linux and macOS release validators re-read this directory from the
packaged application, reject missing or modified files, compare native package
manifests with the inventory, and retain the generated CycloneDX SBOM under
`apps/browser/out/<channel>/validation/`.

## Local development

The `dev` channel may generate a `BLOCKED_DEV_ONLY` attribution bundle so local
development can continue while gaps are visible. That status is rejected by
every distributable channel and by final release validation. There is no
environment-variable bypass for a release-channel build.

## Community unsigned builds

The community path uses `RELEASE_CHANNEL=release` together with the orthogonal
`CLODEX_DISTRIBUTION_MODE=community-unsigned`. This preserves the strict
attribution policy while giving the unsigned application a separate identity
and disabling release publication, external protocol registration, telemetry,
and updates.

Every assembled community artifact must contain a `READY` packaged attribution
bundle and the final-artifact CycloneDX SBOM. Community validation output is a
build diagnostic only: it is not protected preview/canary/stable evidence and
must not be written under `.release-evidence`. The complete non-promotional
contract is in
[`../community-unsigned-builds.md`](../community-unsigned-builds.md).

## Commands

```bash
# Must print 835 dependencies and 0 blockers on macOS arm64: 834 package
# versions plus the bundled vscode-eslint component.
pnpm --dir apps/browser release:attribution:check -- --channel=release

# Development-only bundle; blockers remain recorded in the manifest.
pnpm --dir apps/browser release:attribution:prepare -- --channel=dev
```

OCB-006 is closed only when a final installer/app bundle passes the platform
validator and its retained SBOM/manifest evidence is reviewed. Passing the
source-tree gate or unit tests alone does not authorize distribution. The
current reproducible GREEN-gate result and residual legal/release decisions are
recorded in
[`OCB_006_RELEASE_LICENSE_BLOCKERS.md`](../provenance/OCB_006_RELEASE_LICENSE_BLOCKERS.md).
