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
frozen-lockfile install. The schema-v3 report separately binds 459 lock direct
dependency records, 458 manifest dependency records, and 70 positively resolved
`workspace:*` links. This is intentional: the desktop Vite/Electron build
currently reaches some shipped modules through the browser workspace's dev
dependency graph, so a production-only traversal would omit real release
inputs.

The gate audits 1,863 package names / 2,180 exact versions through npm's
supported bulk advisory endpoint. Every one of the 2,180 registry package
locators must carry a valid SHA-512 integrity and must not declare a tarball;
every observed record must resolve to its canonical npm registry URL. The gate
also binds all 2,197 lock snapshots to 2,197 distinct observed virtual-store
paths, preserving peer variants that a name/version set alone would collapse
while rejecting patched dependency identities. It fails closed on
lockfile-version, source-locator, patched-dependency, integrity, registry-URL,
importer, workspace-link, alias, direct-dependency, snapshot, path-multiplicity,
empty-inventory, endpoint, or advisory drift. There is no release audit
exception for this advisory; reintroducing a vulnerable version is a blocker.

This register records the repository control state. It is not a legal opinion
or a substitute for release-owner review of the generated dependency report
and final packaged SBOM.
