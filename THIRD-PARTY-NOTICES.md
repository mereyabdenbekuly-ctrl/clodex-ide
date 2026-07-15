# Third-party licenses and notices

Clodex is distributed under the GNU Affero General Public License v3.0. This
document records attribution for upstream projects and third-party material
incorporated into the repository.

## Stagewise

Clodex was initially developed from the open-source Stagewise codebase and was
subsequently modified and independently maintained as a separate project.

- Upstream project: [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise)
- Recorded upstream base:
  [`ef9d249f29f2a98dfeac80b2f1013315333994d6`](https://github.com/stagewise-io/stagewise/commit/ef9d249f29f2a98dfeac80b2f1013315333994d6)
- Upstream repository license: [GNU Affero General Public License v3.0](https://github.com/stagewise-io/stagewise/blob/ef9d249f29f2a98dfeac80b2f1013315333994d6/LICENSE)
- Detailed lineage: [`CLODEX_VS_UPSTREAM.md`](./CLODEX_VS_UPSTREAM.md)

Some source files, package structures, interfaces, assets, dependency names,
and compatibility paths remain derived from Stagewise. Copyright in those
portions remains with the Stagewise authors and contributors. Copyright in
later Clodex-specific modifications remains with their respective authors.

Clodex is not affiliated with, sponsored by, or endorsed by Stagewise or its
maintainers. The Stagewise name is used solely for attribution and lineage.

Separately licensed upstream subpackages retain their package-level terms.
Karton retains the Stagewise MIT copyright and license notice in
[`packages/karton/LICENSE.md`](./packages/karton/LICENSE.md). The upstream
`agent-core`, `agent-shell`, and Node agent runtime package metadata also
declared MIT licensing and Stagewise authorship; their current package metadata
preserves that origin, and their package directories now retain the matching
MIT text. Independent publication still requires a package-specific provenance
and legal review rather than relying on the desktop inventory alone.

## Lucide

The local `@clodex/icons` compatibility package delegates icon rendering to
[`lucide-react`](https://github.com/lucide-icons/lucide), distributed under the
ISC license. Its historical export names are compatibility aliases only; the
desktop dependency graph contains no `nucleo-*` package and no Nucleo vendor
asset. The exact Lucide version and license text are recorded in the generated
desktop dependency inventory and CycloneDX SBOM.

## class-variance-authority

This repository contains code derived from
[class-variance-authority](https://github.com/joe-bell/cva), licensed under the
Apache License 2.0.

Copyright (c) 2022 Joe Bell

- Source: [joe-bell/cva](https://github.com/joe-bell/cva)
- License: [Apache License 2.0](https://github.com/joe-bell/cva/blob/main/LICENSE)

## Desktop dependency inventory

The distributable desktop application includes a generated exact-version
dependency inventory rather than relying on this summary alone. Some exact npm
tarballs declare a license but omit its standalone text. The reviewed,
SHA-256-pinned engineering records for those cases are public in
[`docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json`](./docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json),
and the corresponding texts are retained under
[`docs/provenance/dependency-license-texts/`](./docs/provenance/dependency-license-texts/).
The final application embeds each applicable text in its dependency inventory
and retains a CycloneDX SBOM.

These records do not relicense dependencies and are not a legal conclusion.
They may supplement only an exact package whose text or metadata is missing;
an upstream declaration conflict or evidence hash drift blocks release.

## GSAP

The desktop dependency graph includes `gsap` and `@gsap/react`, which reference
Webflow's custom standard license rather than an OSI open-source license. A
public terms snapshot and exact package provenance are retained in the reviewed
registry. Distribution requires release-owner and specialist counsel review of
the actual CLODEx use; inclusion in the inventory is not a permission finding.

## sharp-libvips

The supported macOS and Linux graphs include prebuilt `@img/sharp-libvips-*`
distributions. The reviewed evidence bundle retains the applicable GPL/LGPL
terms, the sharp-libvips build-wrapper license, and the exact pinned upstream
third-party notice table. Final artifact review must confirm the notices and
applicable corresponding-source obligations for each shipped binary.
