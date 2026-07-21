# OCB-006 release-license gate result

**Observed:** 2026-07-15 on macOS arm64 with the pinned Node 22 toolchain

**Strict gate:** GREEN

**Inventory:** 835 unique inventoried components on macOS arm64 (834 package
versions plus the bundled `vscode-eslint` server); 0 blockers

**Reviewed exact-version overrides:** 42 applied on macOS arm64 and 43 on
Linux x64 from a 60-record release-matrix registry

The registry was extended on 2026-07-21 with five exact-version records for
pending Dependabot graphs; those versions were not present in the observed
baseline inventory above.

**Nucleo:** `NOT_REQUIRED`; no `nucleo-*` package is present

**Reviewed non-npm bundled components:** 2 records; one cross-platform
`vscode-eslint` source build (9 exact production-lock dependencies reviewed;
7 proven emitted by webpack)
and one Windows x64 VCRuntime binary archive

This is an engineering attribution result, not a legal conclusion. Specialist
open-source counsel and the release owner still must review custom/commercial
terms and the final packaged artifacts before distribution.

Reproduce with:

```bash
pnpm install --frozen-lockfile
pnpm --dir apps/browser release:attribution:check -- --channel=release
```

Expected result:

```text
[release-attribution] 835 dependencies; 0 blocker(s); Nucleo=NOT_REQUIRED
```

## Closed baseline blockers

The previous reproducible snapshot contained 58 blockers:

- 54 `PACKAGE_LICENSE_TEXT_MISSING`;
- 4 `PACKAGE_LICENSE_UNKNOWN`.

They were closed without a broad or name-only fallback:

1. eight exact packages already shipped valid `LICENSE-*`, lowercase `license`,
   or equivalent package-root texts; the detector now recognizes those common
   filenames;
2. four MIT workspace packages now carry their declared package-level MIT text;
3. two workspace packages without separate terms now explicitly record the
   repository's existing `AGPL-3.0-only` license metadata; and
4. exact `package@version` records are pinned in
   [`DEPENDENCY_LICENSE_OVERRIDES.json`](./DEPENDENCY_LICENSE_OVERRIDES.json):
   the current macOS arm64 graph applies 28 pinned upstream texts, 6 pinned
   SPDX canonical supplements for packages whose exact manifest declares a
   license but whose tarball omits the text, 2 exact package-file metadata
   repairs, 4 combined license/notice bundles, and 2 GSAP custom-license
   snapshots.

The registry contains 60 records in total. Eighteen additional integrity-bound
records cover platform-specific native variants or exact lockfile variants not
present in this macOS arm64 inventory. Across all 60 records the basis counts
are 40 pinned upstream, 10 pinned canonical supplements, 2 exact package
files, 6 combined license/notice bundles, and 2 custom-license snapshots.

The Linux x64 CI inventory applies the exact
`@libsql/linux-x64-musl@0.5.29` record in addition to the applicable GNU
variant. It therefore applies 43 records (29 upstream, 6 canonical, 2 exact
package files, 4 combined bundles, and 2 custom-license snapshots), leaving 17
release-matrix records non-current on that host.

Every override is bound to an exact npm tarball and integrity value, a reviewed
license identity, public source references, and a SHA-256-pinned local text.
An override may fill only missing text or missing/`Unknown` metadata. A conflict,
hash drift, path traversal, duplicate identity, unreviewed record, or changed
package file fails closed.

## Closed non-npm attribution blockers

The previous gate did not inventory or hash-verify two shipped inputs that are
outside the npm dependency traversal:

1. `vscode-eslint` `3.0.10` was downloaded through a mutable tag URL, the
   archive hash was not checked, and the emitted server bundle had no packaged
   license/provenance record or SBOM component. It is now bound to immutable
   revision `790646388696511b2665a4d119bf0fb713dd990d`, source archive SHA-256
   `24ebbef9ee5c716d4653c193bca00192b19787cc7152c3d61a474a10920d6239`,
   and the exact upstream MIT text. The generated provenance manifest hashes
   every emitted bundle file and final validation rejects hash or file-set
   drift. All nine packages in the exact server production lock now carry npm
   integrity, tarball SHA-256, and exact license evidence. Source-map inspection
   proves seven are emitted by webpack and includes only those seven in the
   generated provenance module set and parent/child CycloneDX records;
   `lru-cache` and `yallist` are retained as production-lock-only evidence.
2. `VCRuntime.CefSharp.140` `1.0.5` was downloaded without verifying the
   `.nupkg` or copied DLL bytes and was absent from notices, the attribution
   inventory, and the SBOM. The exact NuGet URL, archive SHA-256, catalog
   SHA-512, nuspec, signature-entry hash, source revision, and five Windows x64
   DLL byte counts/SHA-256 values are now reviewed and fail closed.

The public
[`BUNDLED_COMPONENTS.json`](./BUNDLED_COMPONENTS.json) registry and exact
license/metadata evidence are copied into the packaged attribution bundle.
Platform validators require the applicable component set and emit both logical
components and exact file hashes in CycloneDX.

## Important residual release decisions

A green source-tree inventory does not by itself close final distribution:

- GSAP and `@gsap/react` use Webflow's custom standard license, not an OSI
  open-source license. The public terms snapshot is retained, but the release
  owner/counsel must confirm the product's use is permitted.
- `@img/sharp-libvips-darwin-arm64` retains the applicable GPL/LGPL terms,
  build-wrapper license, and exact pinned third-party notices. Final macOS
  artifacts still must be checked for those notices and corresponding source
  obligations.
- Platform-specific Windows/Linux dependency graphs may add packages and must
  pass the same strict gate on the exact final lockfile.
- The NuGet package metadata for `VCRuntime.CefSharp.140` declares MIT for the
  package and Microsoft copyright for its DLLs. This engineering record does
  not claim that MIT alone authorizes Microsoft runtime redistribution. The
  release owner and specialist counsel must verify the applicable Microsoft
  Visual C++ runtime terms and organizational entitlement; the registry status
  remains `CONDITIONAL_UPSTREAM_TERMS`.
- OCB-006 is release-closed only after the exact final app/installer passes the
  packaged attribution validator and the retained CycloneDX SBOM/manifest is
  reviewed.
