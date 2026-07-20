# Protocol v0 extraction audit

## Decision

**Current result: RED for direct extraction; YELLOW for a specification-first,
independent implementation.**

CLODEx should not copy or relicense existing TypeScript types, validators,
tests, constants, module layouts, or runner interfaces into a new permissively
licensed `clodex-protocol` repository. A publishable, extractable, independently
licensed Protocol v0 may proceed only from an approved requirements corpus and
public standards, with a fresh implementation history and the gates in this
document. A YELLOW in-repository incubator draft may exist only for review and
must not be represented or used as that independent artifact.

This audit covers engineering provenance at commit
`f331fa976f043f5e909ea0e60aeafbdd4fd1446a` on **July 14, 2026**. It is not a
legal opinion. Counsel must review the intended license and final dependency
graphs before a permissive protocol, SDK, private Gateway, or desktop release.

## Intended outcome

The clean boundary is:

```text
clodex-ide (public, current licenses)
    -> Protocol v0 messages (public, schema-only, independently authored)
    -> managed Agent Gateway (private, independently implemented)
```

Protocol v0 should define interoperability, not host business logic. The
public specification may describe how a decision is represented and verified;
the private service owns how multi-tenant admission, scheduling, compliance,
and operations are implemented.

## Status definitions

- **GREEN source** — may be used for the stated specification task with source,
  version, license, authorship, and required notice recorded.
- **YELLOW source** — may inform a requirements discussion only after a
  provenance reviewer approves its exact use; do not copy code or structure.
- **RED source** — exclude from implementation context and do not copy,
  translate, generate from, or use as a structural blueprint.

## Candidate-source audit

| Candidate | Observed evidence | Status for Protocol v0 | Permitted use now | Gate to GREEN |
| --- | --- | --- | --- | --- |
| Public standards and official protocol/RFC documentation | External specifications can be implementation-neutral inputs when their exact version and terms are recorded | **GREEN**, per-source review required | Cite normative behavior and independently implement it | Pin source/version/URL/license or terms; preserve attribution; do not copy non-permitted prose or reference code |
| `docs/INTENT_CONTRACT_SPEC.md` | Detailed public specification in the AGPL repository; designed as normative security semantics | **YELLOW** | Extract requirement statements into an approved design record; no source-code assumptions | Record file revision, authors/contributors, AI/source context, and reviewer approval; identify which statements become normative Protocol v0 requirements |
| `docs/adr/**`, `docs/security/**`, MCP threat model and roadmap documents | Architecture decisions, invariants, threat models, and implementation status; contain mixed specification and current-implementation detail | **YELLOW** | Use approved security requirements and negative constraints | Curate an exact allowlist of paragraphs/requirements; exclude implementation structure and unverified claims; record revisions and authorship |
| `packages/clodex-contracts/**` | Registry status `independent`, but package is AGPL-3.0-only; contains TypeScript interfaces, canonicalization, validators, crypto constants, and tests | **RED** for code extraction; **YELLOW** as behavior to specify | Observe documented wire concepts only through an approved requirements record | File-level rights review or a fully independent implementation from approved specs; no copied code/tests/names-by-structure; external license review |
| `packages/mcp-runtime/src/protocol.ts`, `config.ts`, `policy.ts` | MIT package metadata, CLODEx authorship metadata, no component-registry entry, no package-level license/notice, and mixed schema/runtime/policy responsibilities | **YELLOW** | Inventory concepts only; do not copy schemas or tests | Audit commit history and AI/source context; register component; separate standard-derived fields from CLODEx policy; add license/notice evidence; approve exact specification inputs |
| `packages/runner-sdk/**` | MIT metadata, but directly imports and re-exports Stagewise-attributed `@clodex/agent-shell` types and implementation helpers | **RED** | None as an extraction seed | Delete the legacy dependency edge; independently define wire-only runner messages from Protocol v0; add history, registry, license, notice, and conformance evidence |
| `packages/agent-shell/**`, `packages/agent-core/**`, `agent/runtime-node/**` | Registry status `legacy`; MIT metadata explicitly preserves Stagewise authorship; repository notice requires a package-level audit before independent publication | **RED** | Exclude from protocol-authoring and private-Gateway implementation context | Independent replacement from approved specs or reviewed permission; preserve upstream notices; external licensing review |
| `packages/karton/**` | Legacy Stagewise-attributed MIT transport with a preserved package license | **RED** as a clean protocol blueprint | Continue current licensed use only | Define a new transport from Protocol v0 requirements without using Karton decomposition/control flow; maintain migration evidence |
| `apps/browser/**`, including shared/IPC schemas | AGPL package, registry status `legacy`, mixed Stagewise-derived and CLODEx code | **RED** | Black-box interoperability observations only if separately approved and recorded | Write external behavior scenarios without consulting source structure; independently implement and review |
| `packages/api-client/**` | Missing license and author metadata; unregistered; current product endpoints are not an Agent Gateway protocol | **RED** | None | Provenance/metadata audit, then keep it out of Protocol v0 unless a separately approved endpoint is genuinely part of the standard |
| `apps/clodex-cli/**` | Missing license/author metadata and direct dependencies on legacy `agent-core` and `agent-shell` | **RED** | None | Cut legacy dependencies; consume only the future protocol/SDK; register and audit before publication |
| Existing tests and fixtures in any audited package | Tests encode source-specific naming, decomposition, edge cases, and potentially third-party structure | **RED** for copying | Convert approved requirements into newly authored conformance vectors | Independent authorship record; vector provenance; review that no fixtures or assertions were mechanically translated |

## Why the current runner SDK is a hard blocker

`packages/runner-sdk/src/index.ts` is not a wire-only SDK. It currently:

- imports `RunnerCapabilities`, `WorkspaceExecutionProvider`, and provider-kind
  types from `@clodex/agent-shell`;
- requires implementations of host-side provider methods such as workspace
  preparation, session creation, command execution, cancellation, and disposal;
- re-exports job, lease, artifact, receipt, error, and timing types from
  `agent-shell`; and
- re-exports signing, hashing, and verification helpers from `agent-shell`.

Consequently, its apparent MIT package boundary does not create an independent
protocol or a clean dependency graph. The replacement must depend only on
Protocol v0 artifacts and explicitly approved permissive dependencies. Host
provider interfaces and implementations belong in separate public reference or
private adapter packages, not in the schema package.

## Protocol v0 allowed scope

The first protocol should be deliberately small. Candidate wire concepts are:

1. protocol/version negotiation and feature advertisement;
2. stable principal, tenant, workspace, task, runner, and request identifiers;
3. admission request and fail-closed admission decision envelopes;
4. immutable policy, descriptor, schema, registry, and content digest
   references;
5. bounded capability and effect-class declarations;
6. runner job request, acceptance/rejection, cancellation, and terminal-state
   envelopes;
7. signed effect receipt and evidence-reference envelopes;
8. idempotency, nonce, expiry, revocation epoch, replay, and supersession
   fields;
9. structured, versioned error envelopes; and
10. deterministic serialization/signature profiles and conformance vectors.

Each item remains provisional until the Protocol v0 owner records its normative
source and resolves naming independently. Existing identifiers and object
layouts are not automatically approved merely because the same concept is
needed.

## Explicit exclusions

Protocol v0 must not contain:

- Guardian or policy-evaluation implementation;
- admission heuristics, risk scoring, anti-abuse rules, or threat feeds;
- database schemas, storage adapters, queues, schedulers, or retry workers;
- tenant authentication provider, SSO, SCIM, RBAC/ABAC implementation;
- secrets, credential values, KMS/HSM key identifiers, or production topology;
- cloud-runner implementations, shell/process abstractions, or host filesystem
  APIs;
- billing, metering, pricing, SLA, or customer-entitlement rules;
- customer prompts, code, traces, policy packs, evidence, or audit records;
- browser IPC, Electron, React, Karton, or Stagewise compatibility types; or
- convenience runtime logic that makes the schema package depend on the IDE,
  agent runtime, control plane, or private Gateway.

## Required extraction procedure

### 1. Freeze and classify inputs

Create a machine-readable extraction manifest containing, for every input:

- repository and immutable commit;
- path or public-standard locator;
- author/copyright and license/terms evidence;
- whether the source was read as specification, black-box observation, or
  implementation;
- contributor exposure and substantial AI context; and
- reviewer decision: GREEN, YELLOW with constraints, or RED.

Unknown inputs default to RED.

The current provisional inventory is
[`PROTOCOL_V0_INPUT_MANIFEST.json`](./PROTOCOL_V0_INPUT_MANIFEST.json). It is
explicitly `UNAPPROVED_INPUT_INVENTORY`; its existence does not close
`PV0-G01`, `PV0-G02`, or `PV0-G04`.

### 2. Produce requirements before schemas

Write implementation-neutral requirements with stable IDs, for example:

```text
PV0-REPLAY-001: A terminal effect receipt cannot authorize another effect.
PV0-BIND-002: An admission decision binds the exact policy and descriptor
digests evaluated by the decision authority.
```

Requirements describe observable behavior and security invariants. They must
not mirror current filenames, function boundaries, union ordering, validator
control flow, or test layout.

The current reconstructed catalogue is
[`docs/protocol/agent-gateway-v0/REQUIREMENTS.md`](../protocol/agent-gateway-v0/REQUIREMENTS.md).
Because it was added in the same change as the schemas, it must be independently
approved and re-derived/mapped before `PV0-G03` can close.

### 3. Implement in a fresh history

Create Protocol v0 in a new repository or an isolated, policy-enforced package
with:

- a fresh module layout chosen from the requirements;
- schema artifacts as the primary deliverable;
- no workspace, file, Git, or generated dependency on this monorepo;
- a deny-by-default dependency allowlist;
- no install/build lifecycle scripts that fetch or transform restricted source;
  and
- a per-file provenance header or ledger entry linked to approved requirement
  IDs.

### 4. Author new conformance evidence

Write vectors from requirements, including malformed/unknown fields, version
downgrade, stale epoch, digest drift, replay, duplicate idempotency key,
expired decision, cancellation races, receipt substitution, and oversized
payload cases. Do not copy or mechanically translate current tests or
fixtures.

### 5. Perform independent review

Reviewers must verify:

- every implementation file maps to approved requirements and inputs;
- no RED source appears in prompts, generated artifacts, imports, comments,
  tests, or fixtures;
- naming and decomposition are justified by the new specification;
- dependency and generated-file provenance is complete;
- the protocol contains no private implementation details; and
- the chosen license is supported by the rights record and external review.

Similarity tooling may be used as a warning signal but cannot prove clean
provenance or cure an unapproved source-guided rewrite.

## CI gap analysis

The current controls are useful but insufficient for an open/closed boundary:

| Current control | What it does | Gap |
| --- | --- | --- |
| `scripts/ci/check-provenance.mjs` | Verifies a small fixed set of attribution strings and rejects unsupported legal-entity names | Does not inventory package licenses/authors, validate source/AI declarations, check notice completeness, inspect dependency licenses, or prove notices ship in artifacts |
| `scripts/ci/check-clodex-boundaries.mjs` | Enforces allowlists for components already marked `independent` | `mcp-runtime`, `runner-sdk`, `api-client`, CLI, website, update server, support packages, and Nucleo assets are not covered as independent components; it has no private-repository dependency rule |
| Contribution-policy workflow | Runs DCO, provenance string checks, and architecture-boundary checks on pull requests to `main` | DCO is not a copyright assignment; no extraction-manifest check, protocol-source allowlist, license compatibility gate, or private-boundary scan exists |
| Browser license plugin | Generates a UI list from declared dependencies | Excludes all `@clodex/*` packages, including Stagewise-attributed packages; accepts unknown/empty license text; is not demonstrated to inventory the final packaged artifact |
| Root `THIRD-PARTY-NOTICES.md` | Records Stagewise and selected third-party lineage | Packaging config does not explicitly include the root notice, upstream comparison, or Karton license in desktop extra resources |

## Required new controls

| Control | Priority | Acceptance condition |
| --- | --- | --- |
| Package metadata/provenance inventory | P0 | CI fails if any first-party package lacks registry status, license policy, author/copyright source, notice path, and publication classification |
| Protocol source allowlist | P0 | Every protocol file and generated artifact traces to GREEN inputs and requirement IDs; unapproved paths and generated dependencies fail CI |
| Protocol dependency allowlist | P0 | Schema package has no IDE, agent, browser, Electron, Karton, Stagewise, control-plane, or private dependencies; lockfile resolutions are pinned and reviewed |
| Private dependency firewall | P0 before Gateway code | Private CI rejects `@clodex/*` monorepo packages except separately published GREEN protocol/SDK artifacts; rejects file/workspace/Git links and forbidden licenses |
| Notice and license completeness | P0 before publication/release | Unknown or absent license/notice evidence fails; all required texts are included in the published package or desktop artifact |
| SBOM and artifact inspection | P0 before release | SBOM is produced from the final package/installer, compared to the approved inventory, signed or hashed, and retained as release evidence |
| Extraction-manifest review | P0 | A YELLOW incubator draft cannot be extracted, relicensed, published as a protocol package, or used for SDK/private implementation until immutable input revisions, AI/source-context disclosure, requirement mapping, and provenance-owner approval are complete |
| Independently authored conformance vectors | P0 | Vector provenance is recorded; no copied legacy fixtures; SDK and private implementation pass the same public schema/vector corpus |
| Similarity/forbidden-source warning scan | P1 | Scan identifies copied comments, distinctive literals, fixtures, and module-shape anomalies for human review; it is never treated as dispositive proof |

## Engineering control update — 2026-07-20

The current M0 engineering increment adds review infrastructure without
claiming clean-room completion or closing a Gateway gate:

- the input inventory now pins repository inputs by immutable commit, Git blob,
  and SHA-256 and records repository exposure as RED for fresh protocol
  authorship;
- a file and field-level traceability record binds every incubator artifact to
  candidate inputs and stable requirement IDs;
- Protocol governance CI rejects unallowlisted files, schema/hash drift,
  unresolved references, premature conformance fixtures, or publication and
  private-implementation authorization;
- a synthetic private-dependency firewall reference rejects forbidden package
  sources, implementation dependencies, copied-source fingerprints, secret or
  restricted markers, and unreviewed generated inputs; and
- all conformance fixture payloads and runners remain absent and prohibited.

This is engineering progress, not approval. PV0-G01 and PV0-G03 still require
named independent review. PV0-G02 and PV0-G04 require an authoring/review
context that was not exposed to RED implementation source. PV0-G06 remains
blocked until the earlier gates are GREEN. PV0-G09 and B3 remain open until an
independently reviewed firewall is actually operating in the future private
repository. The runner-sdk to agent-shell dependency remains unchanged and
RED.

## Protocol v0 release gates

Protocol v0 is GREEN only when every gate is closed:

- [ ] `PV0-G01` — exact source inventory and immutable revisions approved;
- [ ] `PV0-G02` — RED sources excluded from author and AI implementation
      context;
- [ ] `PV0-G03` — requirement catalogue reviewed independently of current code
      structure;
- [ ] `PV0-G04` — fresh schema implementation and generated artifacts have a
      complete per-file provenance record;
- [ ] `PV0-G05` — no runtime dependency on any current monorepo package;
- [ ] `PV0-G06` — conformance vectors are newly authored from requirements;
- [ ] `PV0-G07` — package metadata, license text, notices, authorship policy,
      SBOM, and reproducible publication evidence are complete;
- [ ] `PV0-G08` — the future SDK depends only on Protocol v0 and approved
      permissive dependencies; the `runner-sdk -> agent-shell` edge is absent;
- [ ] `PV0-G09` — private-repository CI firewall is operating before the first
      Gateway implementation commit;
- [ ] `PV0-G10` — external licensing review approves the intended protocol/SDK
      distribution and reviews the final Gateway dependency graph.

Gate ordering is phased, not circular:

1. `PV0-G01` through `PV0-G05` approve the exact inputs, requirement catalogue,
   independently authored schema history, and dependency closure.
2. Only then may maintainers authorize clean-room conformance-vector authoring;
   independent review of those vectors closes `PV0-G06`.
3. `PV0-G07` through `PV0-G10` close publication, SDK, private-firewall, and
   external licensing evidence. Overall Protocol v0 status remains non-GREEN
   until all ten gates are closed.

## Gateway start condition

Writing product requirements, threat models, and deployment-independent
acceptance criteria for the Gateway may proceed now. Implementing the private
Gateway must wait until `PV0-G01` through `PV0-G10` and boundary gates `B0`
through `B5` are GREEN, and the protocol artifact is immutable and consumable
without this monorepo.

The first private vertical slice should then be limited to:

```text
IDE protocol client
  -> admission request
  -> private policy/admission service
  -> runner dispatch
  -> signed terminal effect receipt
  -> public evidence/audit envelope
```

No shared source tree, workspace dependency, copied validator, or private
backdoor field is permitted across that slice.
