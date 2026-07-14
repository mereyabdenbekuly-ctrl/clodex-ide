# OCB-006 desktop attribution and SBOM gate

**Status:** source-tree strict gate GREEN (946 dependencies, 0 blockers);
final artifact evidence must still pass before a distributable build can be
promoted

## Release invariant

A preview, nightly, prerelease, or stable desktop artifact is not distributable
unless all of the following are true:

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
   attribution inventory, and observed unpacked/native package manifests;
5. every native package observed in the packaged application is present in the
   approved dependency-license inventory; and
6. Nucleo assets are absent or covered by an `APPROVED`, unexpired record
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

If a future change adds any `nucleo-*` dependency, the gate becomes applicable
again and can become green only through one of these reviewed changes:

- replace/remove every Nucleo package and prove the final artifact contains none;
  or
- update the evidence record to `APPROVED` with exact package coverage,
  `desktop-application-binary` scope, accountable approval, validity dates, the
  applicable license name, and non-secret references to the external rights
  evidence.

Changing the JSON status without the underlying evidence is a release-policy
violation.

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

The current macOS arm64 strict inventory applies 44 reviewed records:

- 28 pinned upstream license texts;
- 8 pinned SPDX canonical supplements where the exact package already declares
  the matching SPDX license;
- 2 exact package-file metadata repairs;
- 4 combined license/notice bundles; and
- 2 public GSAP custom-license snapshots.

The registry contains 53 records in total. The additional nine exact,
integrity-bound records cover platform-specific native variants or exact
lockfile variants not present in this macOS arm64 inventory.

The GSAP snapshot is attribution evidence, not a determination that every
CLODEx use is permitted. Release ownership and specialist counsel must review
those custom terms. The sharp-libvips bundle likewise retains GPL/LGPL terms
and pinned third-party notices, but final artifact/source-obligation review is
still mandatory.

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

## Commands

```bash
# Must print 946 dependencies and 0 blockers on the current exact lockfile.
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
