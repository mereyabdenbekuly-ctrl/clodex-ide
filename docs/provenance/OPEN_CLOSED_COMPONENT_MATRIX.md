# Open/closed component matrix

## Purpose and snapshot

This matrix records the engineering boundary for the proposed CLODEx open-core
model:

> Open-source IDE and security protocol; separately implemented private
> managed Agent Gateway.

The snapshot was prepared on **July 14, 2026** from commit
`f331fa976f043f5e909ea0e60aeafbdd4fd1446a`. It is an engineering provenance
and release-readiness audit, **not legal advice**. A qualified open-source
licensing review remains a release gate for any relicensing, proprietary
distribution, or dual-licensing decision.

The repository-wide [provenance policy](../governance/PROVENANCE_POLICY.md) and
[component registry](./components.yml) remain authoritative. Directory names,
package metadata, and a network boundary do not by themselves establish clean
provenance or permission to relicense.

## Status meanings

The matrix deliberately separates current open use from extraction or private
use:

- **GREEN** — the observed evidence is sufficient for the stated engineering
  use in its current license zone. GREEN never means that code may be
  relicensed.
- **YELLOW** — work may continue only inside the current public repository;
  publication, extraction, or boundary claims require the listed evidence.
- **RED** — do not copy, relicense, publish as a clean permissive component, or
  import into private Gateway code. The listed gate must be satisfied first.

## Non-negotiable target boundary

```text
PUBLIC: clodex-ide (AGPL and preserved package-level terms)
        + independently authored protocol specification and schemas
        + conformance vectors and SDK only after provenance gates are GREEN
                         |
                         | versioned HTTPS/gRPC messages
                         | no source or runtime dependency edge
                         v
PRIVATE: managed Agent Gateway, enterprise services, operations, and data
```

The private side must not import, vendor, generate from, or structurally
rewrite code from this monorepo. Public protocol messages are the only intended
integration boundary. Whether that architecture is legally sufficient still
requires counsel; this policy is the stricter engineering floor.

## Component matrix

| Component or path | Observed provenance/license state | Intended disposition | Current open use | Permissive protocol/SDK extraction | Private Gateway import | Required gate |
| --- | --- | --- | --- | --- | --- | --- |
| Repository root | Root distribution is AGPL-3.0 and records Stagewise lineage at upstream base `ef9d249f29f2a98dfeac80b2f1013315333994d6` | Public source and historical record | **GREEN** under current terms and preserved notices | **RED** as a blanket source corpus | **RED** | Never treat the repository license or DCO as a relicensing grant; audit each candidate file and contributor history |
| `apps/browser/**` | AGPL package; registry status `legacy`; repository documentation says Stagewise-derived and mixed code remains | Open-source IDE and distribution wedge | **YELLOW**; source can remain public, but packaged attribution is not release-ready | **RED** | **RED** | Preserve lineage; package root notices in every desktop artifact; fail release on missing or unknown license text; complete the desktop attribution gate below |
| `packages/clodex-contracts/**`, `clodex-kernel/**`, `clodex-approval/**`, `clodex-guardian/**`, `clodex-ledger*/**`, `clodex-evidence/**`, `clodex-runtime/**`, `clodex-adapters*/**` | Registry status `independent`; package metadata declares AGPL-3.0-only | Open security core, local reference implementation, and public standards work | **GREEN** under AGPL and the existing provenance policy | **RED** for direct code extraction or permissive relicensing; **YELLOW** as semantic input to a separately written specification | **RED** | File-level history and rights review; approved specification-only inputs; independent schema implementation with its own provenance record |
| `packages/clodex-control-plane*/**`, `clodex-registry*/**`, `clodex-production/**`, `clodex-promotion/**` | Registry status `independent`; package metadata declares AGPL-3.0-only | Public single-node/reference coordination, registry, promotion, and production semantics | **GREEN** under AGPL | **RED** for source reuse; **YELLOW** for documented wire semantics only | **RED** | Keep managed multi-tenant implementations separate; publish only stable schemas and conformance behavior after protocol gates |
| `packages/mcp-runtime/**` | Package metadata says MIT and names CLODEx authors, but the package is absent from `components.yml` and has no package-level license/notice file | Candidate public MCP reference runtime; possible input to Protocol v0 | **YELLOW** | **YELLOW**, not yet an approved extraction source | **RED** | Register the component; audit creation history and supplied AI/source context; add license/notice evidence; separate schemas from local runtime and policy code |
| `packages/runner-sdk/**` | Package metadata says MIT, but its only runtime dependency is Stagewise-attributed `@clodex/agent-shell`; it imports and re-exports runner types, constants, hashing, signing, and verification from that package | Future public ecosystem SDK | **RED** as a claimed clean SDK | **RED** | **RED** | Replace every `agent-shell` type and function edge with a GREEN Protocol v0 dependency; independently author conformance behavior; add registry, license, notice, and history evidence |
| `packages/agent-core/**`, `packages/agent-shell/**`, `agent/runtime-node/**` | Registry status `legacy`; MIT metadata preserves Stagewise authorship; repository notice says a complete package-level audit is still required before independent publication | Legacy runtime retained during strangler migration | **YELLOW** inside the current public product | **RED** | **RED** | Preserve Stagewise attribution; finish package-level provenance and notice audit; use an independent replacement or obtain reviewed permission before any different distribution model |
| `packages/karton/**` | Registry status `legacy`; Stagewise-attributed MIT package with a package-level `LICENSE.md` | Legacy public compatibility transport | **GREEN** under its recorded MIT terms and notices; still legacy | **RED** as a clean CLODEx protocol seed | **RED** by project policy pending review | Do not relabel or structurally rewrite it; keep its notice; replace through a specification-first migration if a new transport is needed |
| `packages/stage-ui/**` | Registry status `legacy`; package metadata has no license or author; the repository records Stagewise-derived UI areas | Legacy public UI only | **YELLOW** | **RED** | **RED** | Establish exact upstream lineage and applicable notices; add package metadata; do not use layouts, components, themes, or assets as a private/permissive blueprint |
| `packages/api-client/**` | Package metadata has no license or author and the package is not registered; it contains product API shapes rather than a Gateway contract | Existing public-repository helper only | **YELLOW** | **RED** | **RED** | Register and audit it; explicitly exclude legacy product endpoints from Protocol v0; create a new protocol client only from approved schemas |
| `apps/clodex-cli/**` | Package metadata has no license or author and directly depends on Stagewise-attributed `agent-core` and `agent-shell` | Public CLI after runtime migration | **YELLOW** inside the monorepo | **RED** | **RED** | Add registry and metadata evidence; cut legacy runtime dependencies before claiming a clean protocol client or publishing independently |
| `apps/deprecated-cli/**` | AGPL package; legacy/deprecated application | Retain only for supported migration or removal | **YELLOW** | **RED** | **RED** | Record status in the registry and remove when migration criteria are met |
| `apps/update-server/**`, `apps/website/**` | Package metadata omits license and author; website depends on `stage-ui` and local Nucleo packages | Public operational/marketing surfaces, not Gateway foundations | **YELLOW** | **RED** | **RED** | Register intended status; add explicit metadata and notices; prevent accidental reuse as a private service seed |
| `packages/nucleo-*/**` | Ten private workspace packages omit license and author metadata; release workflows require a `NUCLEO_LICENSE_KEY`; no package-level notices were found | Licensed desktop/website assets only if redistribution rights are documented | **RED** for distributable release until verified | **RED** | **RED** | Record vendor source, entitlement, permitted redistribution, generated modifications, and required attribution; exclude or replace any asset without distributable evidence |
| `packages/tailwindcss-color-modifiers/**`, `packages/typescript-config/**` | MIT metadata, not registered, no package-level license files observed | Build/support packages only | **YELLOW** | **RED** unless independently audited and actually needed | **RED** | Register, audit history, add notice/license evidence, and keep Protocol v0 free of build-system coupling |
| `docs/INTENT_CONTRACT_SPEC.md`, ADRs, threat models, security manifests | Public AGPL repository documentation with detailed semantics; provenance policy allows approved specifications as independent inputs | Candidate specification inputs; public security documentation | **GREEN** in the public repository | **YELLOW** as documented inputs, never automatic code-relicensing evidence | Not executable/importable | Approve an exact source list and revisions; record authorship and AI/source context; write Protocol v0 from requirements rather than current module structure |
| `docs/protocol/agent-gateway-v0/**` | Newly authored schema/documentation draft in this AGPL repository; input manifest and reconstructed requirements are unapproved and the authoring context is not yet clean-room evidence | **PUBLIC SPEC/REFERENCE incubator**, non-publishable | **YELLOW** for review in this repository only | **RED** for extraction, relicensing, package publication, SDK generation, or private implementation input | **RED** | Approve `PROTOCOL_V0_INPUT_MANIFEST.json` and `REQUIREMENTS.md`; independently verify/re-derive schema mappings; close `PV0-G01`–`PV0-G10` before boundary use |
| Future `clodex-protocol` | Does not yet exist as a provenance-approved, permissively licensed component | Public schema-only interoperability standard | **RED** until the extraction audit is closed | **RED** until all Protocol v0 gates are GREEN | Only its published artifacts may cross the boundary | Complete [`PROTOCOL_EXTRACTION_AUDIT.md`](./PROTOCOL_EXTRACTION_AUDIT.md), use a fresh repository/history, and enforce a dependency allowlist |
| Future `clodex-sdk` | Does not yet exist as a clean protocol-only SDK | Public convenience client generated or written from Protocol v0 | **RED** | **RED** | Published SDK may be consumed only after counsel and dependency review | Depend only on GREEN protocol artifacts and approved permissive dependencies; never on `agent-shell`, browser, Guardian runtime, or control-plane code |
| Future private Gateway repositories | No implementation should be derived from the current monorepo | Closed multi-tenant admission, scheduling, enterprise operations, and managed evidence | Not applicable | May implement the public protocol | **RED** until the protocol boundary is GREEN | Fresh repository and access policy; CI denial of monorepo packages and AGPL/legacy sources; dependency SBOM; independent implementation record |

## Package metadata and notice findings

The current package inventory is mixed:

- AGPL metadata is present on the registered independent security packages and
  the desktop application.
- MIT metadata with Stagewise attribution is present on `agent-core`,
  `agent-shell`, the Node agent runtime, and Karton.
- MIT metadata without complete component-registry or package-level notice
  evidence is present on `mcp-runtime`, `runner-sdk`, and build support
  packages.
- License metadata is missing from `api-client`, `clodex-cli`, `stage-ui`, the
  update server, website, and all local Nucleo packages.
- Only `packages/karton/LICENSE.md` was found as a package-level license file in
  the audited application/package roots.

Package metadata is evidence, not proof of origin or relicensing authority.
Missing metadata does not prove infringement, but it is a hard engineering
blocker for independent publication and private-boundary claims.

## Desktop attribution release gate

The desktop build currently has a material attribution gap:

1. `THIRD-PARTY-NOTICES.md` records Stagewise lineage, but
   `apps/browser/forge.config.mts` does not explicitly copy it,
   `CLODEX_VS_UPSTREAM.md`, or the Karton license into packaged resources.
2. The generated license UI intentionally excludes all `@clodex/*` packages
   as build-only. That also excludes Stagewise-attributed `agent-core`,
   `agent-shell`, Karton, and legacy `stage-ui` from the generated list.
3. The generator accepts `Unknown` and empty license text instead of failing
   the release.
4. Local Nucleo packages have no license fields or package-level notices even
   though they are referenced by desktop and website workspaces.

Therefore a distributable desktop release remains **RED** for provenance until
all of the following are demonstrated from the final installer/app bundle:

- the root AGPL license and all required upstream/package notices are present
  and user-accessible;
- Stagewise attribution and the recorded upstream base are preserved;
- every bundled runtime package and asset has a known license or documented
  commercial redistribution grant;
- missing license text is a release failure, not a UI fallback;
- the generated inventory is based on the actual packaged artifact, not only
  declared workspace dependencies; and
- release evidence archives the notice bundle, SBOM, hashes, and the exact
  source revision.

## Gates and ownership

| Gate | Priority | Owner | Exit evidence |
| --- | --- | --- | --- |
| `OCB-001` Complete registry coverage | P0 | Repository governance | Every first-party app/package is registered as `independent`, `migration`, `legacy`, `third_party`, or an explicitly defined private-excluded class; CI rejects unregistered packages |
| `OCB-002` Complete package provenance records | P0 | Maintainers | License, author/copyright source, source commit/version, notice path, AI-context disclosure, and publication policy recorded for every candidate component |
| `OCB-003` Close Protocol v0 extraction audit | P0 | Protocol owner + provenance reviewer | Every input is GREEN, direct code extraction remains absent, file-level provenance log approved, protocol dependency graph is allowlisted |
| `OCB-004` Replace runner SDK legacy dependency | P0 | Runtime/SDK owner | `runner-sdk` or its replacement depends only on Protocol v0 and approved permissive dependencies; no `agent-shell` symbols or transitive imports remain |
| `OCB-005` Enforce the private dependency firewall | P0 before private code | Gateway owner | Private CI rejects workspace/file/Git dependencies on this monorepo, forbidden package names, copied source fingerprints, and non-approved licenses; SBOM evidence is retained |
| `OCB-006` Package attribution correctly | P0 before desktop release | Desktop/release owner | Artifact inspection proves all licenses/notices are bundled and accessible; unknown/missing entries fail the build; Nucleo rights are documented or assets removed |
| `OCB-007` Obtain external licensing review | P0 before permissive/private release | Project owner | Written review covers the intended protocol license, contributor rights model, Stagewise-derived zones, SDK distribution, Gateway dependency graph, and desktop notices |
| `OCB-008` Establish future contribution rights policy | P1 before accepting protocol contributions | Governance | Published DCO/CLA decision for the new repository; contributors understand whether future dual licensing is intended; existing DCO is not represented as copyright assignment |

## Immediate decision

- Continue maintaining the IDE and security core publicly under their current
  terms: **GO**, subject to the desktop attribution release gate.
- Maintain the current Protocol v0 schema draft as a YELLOW, non-publishable
  review incubator: **GO WITH CONTROLS**. Promotion, extraction, or clean-room
  re-derivation starts only after the exact specification inputs and requirement
  catalogue are approved.
- Copy current contracts, MCP schemas, runner types, or tests into an
  Apache-2.0 repository: **STOP**.
- Start private Gateway implementation against current monorepo packages:
  **STOP**.
- Start private Gateway implementation after Protocol v0, SDK, provenance,
  CI-firewall, and external-review gates are GREEN: **GO**.
