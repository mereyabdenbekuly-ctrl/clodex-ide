# Dependency risk register for v1.16.0

## DR-001: legacy esbuild in Drizzle Kit's deprecated loader

| Field | Value |
| --- | --- |
| Status | Closed in the locked dependency graph |
| Recorded | 2026-07-15 |
| Advisory | `GHSA-67mh-4wv8-2f99` |
| Former vulnerable package | `esbuild@0.18.20` |
| Former dependency path | `better-auth > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` |
| Resolution | `@esbuild-kit/core-utils@3.3.2>esbuild` is pinned to `0.25.9` |

The committed `pnpm-lock.yaml` no longer contains `esbuild@0.18.20` or its
platform packages. The scoped override keeps the deprecated loader edge on the
patched `0.25.9` resolution without changing unrelated esbuild consumers.
The exact override
`@electron/rebuild@3.7.2>@electron/node-gyp=10.2.0-electron.2` also replaces
Electron Rebuild's former codeload commit with the integrity-bound npm registry
release, leaving the lockfile with `sourceLocatorCount=0`.

Release builds use the pinned Node/pnpm toolchain and the frozen lockfile.
The canonical Linux CI and protected release-gate jobs run
`pnpm security:dependencies`. It binds all 33 lockfile importers and each direct
`dependencies`, `devDependencies`, and `optionalDependencies` category to the
unfiltered recursive `pnpm list --lockfile-only` result after the preceding
frozen-lockfile install. The schema-v3 report separately binds 461 lock direct
dependency records, 460 manifest dependency records, and 70 positively resolved
`workspace:*` links. This is intentional: the desktop Vite/Electron build
currently reaches some shipped modules through the browser workspace's dev
dependency graph, so a production-only traversal would omit real release
inputs.

The gate audits 1,821 package names / 2,116 exact versions through npm's
supported bulk advisory endpoint. Every one of the 2,116 registry package
locators must carry a valid SHA-512 integrity and must not declare a tarball;
every observed record must resolve to its canonical npm registry URL. The gate
also binds all 2,138 lock snapshots to 2,138 distinct observed virtual-store
paths, preserving peer variants that a name/version set alone would collapse
while rejecting patched dependency identities. It fails closed on
lockfile-version, source-locator, patched-dependency, integrity, registry-URL,
importer, workspace-link, alias, direct-dependency, snapshot, path-multiplicity,
empty-inventory, endpoint, or advisory drift. There is no release audit
exception for this advisory; reintroducing a vulnerable version is a blocker.

This register records the repository control state. It is not a legal opinion
or a substitute for release-owner review of the generated dependency report
and final packaged SBOM.

## DR-002: July 24 dependency advisory refresh

| Field | Value |
| --- | --- |
| Status | Closed in the locked dependency graph |
| Recorded | 2026-07-24 |
| Resolution | Updated direct pins and root overrides to the first safe line or newer |

The frozen graph now resolves `@hono/node-server@2.0.11`,
`dompurify@3.4.12`, `fast-uri@3.1.4`, `linkify-it@5.0.2`,
`next@16.2.11`, and `sharp@0.35.3`. The canonical schema-v3 audit returned
zero findings, zero blockers, and zero residual exceptions after the refresh.
This entry records the dependency state only; platform builds and the final
packaged SBOM remain release-gate evidence.

## DR-003: July 26 advisory closure and packaging compatibility refresh

| Field | Value |
| --- | --- |
| Status | Dependency advisories closed in the locked graph; merge gated on cross-platform packaging CI |
| Recorded | 2026-07-26 |
| Advisories | `GHSA-qq9h-g4jm-xgf3`, `GHSA-mh99-v99m-4gvg`, `GHSA-r28c-9q8g-f849`, `GHSA-r292-9mhp-454m` |
| Runtime | Repository-pinned Node `22.23.1` and pnpm `10.30.3` |
| Resolution | Updated safe dependency lines and removed incompatible legacy consumers without adding an advisory exception |

The refreshed graph pins `better-auth` and `@better-auth/electron` to `1.6.22`,
sets the PostCSS advisory floor to `8.5.18`, resolves affected tar consumers to
`7.5.21`, and contains only `brace-expansion@5.0.8`. The brace-expansion change
is not a blanket major override: parent-scoped compatibility overrides move the
remaining packaging paths to `@electron/asar@4.2.1`,
`@electron/universal@3.0.6`, and `glob@8.1.0`, while compatible glob and direct
runtime consumers are normalized on `minimatch@9.0.8`. Unused legacy
`@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` dependencies
were removed instead of forcing their older minimatch consumers across an
incompatible module API.

This repository contains the reviewed Better Auth client dependency graph, not
the separately operated authentication service. That service must independently
upgrade its Better Auth server packages to `1.6.22` or newer before the related
advisory can be considered closed for the deployed system.

The canonical schema-v3 audit covers 33 importers, 461 lock direct records,
460 manifest records, 70 validated workspace links, 1,821 package names,
2,116 exact registry versions/package locators, and 2,138 snapshot/path
variants. It reports `sourceLocatorCount=0`, zero findings, zero blockers, and
zero residual exceptions. Installation and build evidence must use Node
`22.23.1`; older Node runtimes are outside this refreshed dependency baseline.

The dependency audit does not by itself prove that every Electron Forge,
installer, ASAR, or platform-specific packaging path remains behaviorally
compatible. Required pull-request jobs perform clean frozen-lock installs and
real Forge builds on macOS arm64/x64, Windows x64, and Linux x64 before merge;
their retained GitHub Actions run is the compatibility evidence for this
bridge. CLODEx does not currently produce a universal macOS artifact, so the
Universal 3 implementation path is outside the v1.16.0 artifact set. The final
packaged SBOM and release-owner review remain separate release gates.
