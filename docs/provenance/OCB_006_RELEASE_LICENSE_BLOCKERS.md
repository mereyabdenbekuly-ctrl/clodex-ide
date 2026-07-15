# OCB-006 release-license gate result

**Observed:** 2026-07-15 on macOS arm64 with the pinned Node 22 toolchain

**Strict gate:** GREEN

**Inventory:** 834 unique dependency versions; 0 blockers

**Reviewed exact-version overrides:** 42 applied on macOS arm64 and 43 on Linux x64 from a 54-record release-matrix registry

**Nucleo:** `NOT_REQUIRED`; no `nucleo-*` package is present

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
[release-attribution] 834 dependencies; 0 blocker(s); Nucleo=NOT_REQUIRED
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

The registry contains 54 records in total. Twelve additional integrity-bound
records cover platform-specific native variants or exact lockfile variants not
present in this macOS arm64 inventory. Across all 54 records the basis counts
are 35 pinned upstream, 9 pinned canonical supplements, 2 exact package files, 6 combined
license/notice bundles, and 2 custom-license snapshots.

The Linux x64 CI inventory applies the exact
`@libsql/linux-x64-musl@0.5.29` record in addition to the applicable GNU
variant. It therefore applies 43 records (29 upstream, 6 canonical, 2 exact
package files, 4 combined bundles, and 2 custom-license snapshots), leaving 11
release-matrix records non-current on that host.

Every override is bound to an exact npm tarball and integrity value, a reviewed
license identity, public source references, and a SHA-256-pinned local text.
An override may fill only missing text or missing/`Unknown` metadata. A conflict,
hash drift, path traversal, duplicate identity, unreviewed record, or changed
package file fails closed.

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
- OCB-006 is release-closed only after the exact final app/installer passes the
  packaged attribution validator and the retained CycloneDX SBOM/manifest is
  reviewed.
