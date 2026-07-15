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

Release builds use the pinned Node/pnpm toolchain and the frozen lockfile.
The canonical Linux CI and protected release-gate jobs run
`pnpm security:dependencies`. It derives the cross-platform recursive
production inventory from that lockfile, queries npm's supported bulk advisory
endpoint, resolves every finding to exact locked versions, and fails closed.
There is no release audit exception for this advisory; reintroducing a
vulnerable version is a blocker.

This register records the repository control state. It is not a legal opinion
or a substitute for release-owner review of the generated dependency report
and final packaged SBOM.
