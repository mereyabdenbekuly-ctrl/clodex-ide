# Clodex and its Stagewise upstream

Clodex is an independent, security- and governance-focused evolution of the
open-source [Stagewise](https://github.com/stagewise-io/stagewise) codebase. It
was not written entirely from scratch, and Clodex does not claim authorship of
the upstream work on which it was built.

This document records the project lineage, the comparison point used by the
maintainers, and the main areas where the codebases differ.

## Lineage

The Clodex development line diverged from Stagewise at:

- **Upstream repository:** `stagewise-io/stagewise`
- **Upstream commit:**
  [`ef9d249f29f2a98dfeac80b2f1013315333994d6`](https://github.com/stagewise-io/stagewise/commit/ef9d249f29f2a98dfeac80b2f1013315333994d6)
- **Upstream commit date:** July 3, 2026
- **Repository license at the comparison point:** GNU Affero General Public
  License v3.0, with separately licensed subpackages retained where applicable

The public Clodex repository was published on July 12, 2026 as a clean source
snapshot with a squashed project history. The missing ancestry in the public
Git graph does not remove the upstream origin or the rights of Stagewise
authors. Those rights and credits are preserved in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) and
[`CONTRIBUTORS.md`](./CONTRIBUTORS.md).

Clodex is not affiliated with, sponsored by, or endorsed by Stagewise or its
maintainers.

## Reproducible comparison

At Clodex commit
[`d2fa0cfa64622c85981b8ceab46be81d0c33f943`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/commit/d2fa0cfa64622c85981b8ceab46be81d0c33f943)
on July 13, 2026, a direct Git comparison against the upstream base reports:

```text
1,764 files changed, 259,691 insertions(+), 31,665 deletions(-)
```

The result can be reproduced without trusting this document:

```bash
git remote add stagewise-upstream https://github.com/stagewise-io/stagewise.git
git fetch --depth=1 stagewise-upstream \
  ef9d249f29f2a98dfeac80b2f1013315333994d6
git diff --shortstat \
  ef9d249f29f2a98dfeac80b2f1013315333994d6 \
  d2fa0cfa64622c85981b8ceab46be81d0c33f943
```

Changed-line counts are evidence of divergence, not a percentage of
originality. A modified file can still contain important upstream work, and a
new file can depend on upstream interfaces.

## Clodex-specific systems

The following paths were not present at the upstream comparison point or
contain substantial Clodex-specific systems added after it:

| Area | Representative paths |
| --- | --- |
| Guardian authorization and audit | `apps/browser/src/backend/services/guardian/` |
| Managed network policy | `apps/browser/src/backend/services/network-policy/` |
| Evidence-backed memory | `packages/agent-core/src/services/evidence-memory/` |
| Provider-neutral Model Fabric | `packages/agent-core/src/services/model-fabric/` |
| Runner routing and external execution | `packages/agent-core/src/services/runner-routing/`, `packages/runner-sdk/` |
| MCP runtime isolation | `packages/mcp-runtime/`, `apps/browser/src/backend/mcp-host/` |
| Session continuity | `apps/browser/src/backend/services/session-continuity/` |
| Public API and CLI surfaces | `packages/api-client/`, `apps/clodex-cli/` |
| Independent-kernel migration contracts | `packages/clodex-contracts/` |
| Threat models and promotion evidence | `docs/`, `.release-evidence/`, selected `.github/workflows/` |

The directories `packages/api-client`, `packages/mcp-runtime`,
`packages/runner-sdk`, and `apps/clodex-cli` are new relative to the recorded
upstream base.

`packages/clodex-contracts` was added after the recorded July 13 comparison as
the first boundary of the hybrid strangler migration documented in
[`docs/migration/`](./docs/migration/README.md).

## Continuing upstream-derived areas

Clodex still contains upstream-derived foundations, including parts of the
Electron workspace, task and agent infrastructure, typed Karton transport,
shared UI components, package layout, developer tooling, and website
structure. Some compatibility names such as `stage-ui` also remain in the
tree.

Those areas are not relabeled as wholly original Clodex work. Copyright in the
upstream portions remains with the Stagewise authors and contributors;
copyright in later modifications remains with the authors of those changes.

## Ongoing attribution policy

Contributors must:

1. preserve upstream copyright, license, and attribution notices;
2. identify newly imported third-party code or assets in the pull request;
3. add or update notices when a dependency requires attribution;
4. avoid describing upstream contributors as Clodex maintainers unless they
   have explicitly joined this project; and
5. update this document when the recorded lineage or major component map is
   found to be inaccurate.

Questions about project lineage may be raised publicly through GitHub
Discussions. Private legal or licensing concerns may be sent to
**support@clodex.xyz** with the subject `[LICENSING]`; do not use the security
reporting channel unless the concern is also a vulnerability or credential
exposure.
