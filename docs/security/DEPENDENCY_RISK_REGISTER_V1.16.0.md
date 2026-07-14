# Dependency risk register for v1.16.0

## DR-001: legacy esbuild in Drizzle Kit's deprecated loader

| Field | Value |
| --- | --- |
| Status | Pending release-owner security acceptance |
| Recorded | 2026-07-15 |
| Severity | Moderate |
| Advisory | pnpm advisory `1102341` |
| Residual package | `esbuild@0.18.20` |
| Dependency path | `better-auth > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` |
| Required patched version | `esbuild >=0.25.0` |
| Review deadline | Before v1.17.0 or 2026-08-15, whichever is earlier |

### Reachability assessment

The affected esbuild behavior is its development server accepting requests from
arbitrary websites. The deprecated `@esbuild-kit/core-utils@3.3.2` package uses
the affected copy only through `transform` and `transformSync`; it does not call
esbuild's development-server API. The dependency is reached through Drizzle
Kit, which is developer tooling resolved as an optional Better Auth peer, not a
runtime server exposed by the packaged IDE.

### Why the patched version is not forced

`@esbuild-kit/core-utils@3.3.2` declares `esbuild ~0.18.20`. Overriding it to
`>=0.25.0` would cross multiple pre-1.0 API boundaries and violate the parent's
declared compatibility range. The latest Drizzle Kit release still carries the
deprecated loader, so there is no upstream-compatible patched update available.
Forcing the override would replace a low-reachability development-server risk
with an unvalidated build-tool compatibility risk.

### Compensating controls

- Do not expose Drizzle Kit or esbuild development servers on untrusted network
  interfaces.
- Release builds must use the pinned Node/pnpm toolchain and the locked
  dependency graph.
- Keep `pnpm audit --prod` at zero critical, high, and low advisories; this is
  the only currently documented moderate residual.
- Remove the deprecated `@esbuild-kit` path when Drizzle Kit publishes a
  compatible update, or validate a scoped esbuild override in an isolated
  follow-up change before the review deadline.

This record documents the residual risk but does not itself grant release
acceptance. The release owner must explicitly sign off before stable release.
