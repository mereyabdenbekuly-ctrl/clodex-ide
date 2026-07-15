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

Non-npm build inputs and binary bundles are recorded separately in the
SHA-256-pinned
[`docs/provenance/BUNDLED_COMPONENTS.json`](./docs/provenance/BUNDLED_COMPONENTS.json)
registry. Final-artifact validation verifies the applicable registry entries,
the bytes shipped with the application, and the corresponding CycloneDX
components. These records are engineering provenance evidence, not a grant of
rights or a legal conclusion.

These records do not relicense dependencies and are not a legal conclusion.
They may supplement only an exact package whose text or metadata is missing;
an upstream declaration conflict or evidence hash drift blocks release.

## vscode-eslint language server

The desktop application builds and bundles the server portion of
[`microsoft/vscode-eslint`](https://github.com/microsoft/vscode-eslint) version
`3.0.10`, licensed under the MIT License.

Copyright (c) Microsoft Corporation

The build downloads the archive for immutable Git revision
`790646388696511b2665a4d119bf0fb713dd990d` and requires SHA-256
`24ebbef9ee5c716d4653c193bca00192b19787cc7152c3d61a474a10920d6239`
before extraction. The exact upstream `License.txt` is retained in the bundled
server directory and in the packaged attribution evidence. A generated
provenance manifest records the SHA-256 and byte count of every emitted server
bundle file; final validation rejects missing, additional, or modified files.
The single Node 22 compatibility transform to the archived webpack config is
also recorded with exact before/after SHA-256 values. The exact archived server
lock and all nine production-lock packages are separately integrity-bound with
exact license text in the bundled-component registry. Source-map inspection
currently proves that seven of those packages are emitted by webpack; the final
CycloneDX document records those seven as dependencies of the server bundle and
does not overstate the two lock-only packages as shipped content.

## VCRuntime.CefSharp.140

Windows x64 packages copy five runtime DLLs from exact NuGet package
[`VCRuntime.CefSharp.140` version `1.0.5`](https://www.nuget.org/packages/VCRuntime.CefSharp.140/1.0.5).
The package is owned on NuGet by `havendv`; its metadata names Microsoft as the
author and copyright holder and declares the package license expression `MIT`.
The source `.nupkg` is pinned to SHA-256
`063bbdc41bab3911677feac7a6373ba9d60e0b497b994cfc947bc3735359d2c0`
and the NuGet catalog SHA-512. Each copied `vcruntime140*.dll` and
`msvcp140*.dll` is independently byte-counted and SHA-256-pinned in the bundled
component registry and final SBOM.

The exact package metadata and the MIT text from the package project's source
revision `3db205447bf52b66b61f7881a9294cf495d92eeb` are retained as provenance
evidence. This repository **does not assert** that the NuGet package's MIT
expression alone grants redistribution rights to Microsoft runtime binaries.
Before distribution, the release owner and specialist counsel must verify the
applicable
[Microsoft Visual C++ 2022 runtime terms](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/)
and the organization's entitlement. The registry records this state as
`CONDITIONAL_UPSTREAM_TERMS`, not as legal approval.

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
