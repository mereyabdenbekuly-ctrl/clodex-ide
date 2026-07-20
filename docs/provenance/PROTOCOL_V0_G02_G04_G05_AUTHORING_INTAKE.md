# Protocol v0 PV0-G02/G04/G05 constrained-authoring intake

**Status:** setup only; execution blocked; every Protocol v0 gate remains open

This artifact prepares the evidence shape requested by issue `#77`. It does
not select or attest an author, reviewer, environment custodian, tool session,
or source-constrained workspace. It does not authorize fresh schema authorship
and does not close `PV0-G02`, `PV0-G04`, `PV0-G05`, or any other gate.

## Frozen contaminated baseline

The machine-readable intake binds issue `#77` and the repository-exposed
Protocol v0 incubator created through PR `#74`:

- PR base `8d2618a91a541607944fb7eb7bad30001d5b4aeb`;
- PR head `c0e0c6d4fb66b98806a2a80884b8f034b2e860b1`;
- merge commit `374539f98dba20d1aade6208c2834928bf7fa09a`;
- protocol Git tree `d36c03eab98cd249a2b52fa1bd662869e7a494b3`.

This is a **deny binding**, not an author input. The existing schemas, OpenAPI,
requirements draft, traceability, conformance definitions, file layout, names,
and repository history remain review-only contaminated evidence. Authors and
normative schema reviewers must not receive them in their working context.

The intake separately binds the frozen review targets for issue `#75`
(`PV0-G01`) and issue `#76` (`PV0-G03`). Both gates are still `OPEN`; their
closure-evidence fields remain empty.

## Required participants

A later activation change must name at least one accountable human schema
author and one different independent schema reviewer. Both must declare that
their supplied runtime context did not include prohibited implementation
source, the current incubator, legacy fixtures, distinctive literals, current
module structure, or prior AI sessions containing those materials.

Unknown exposure is disqualifying until resolved. A self-declaration alone does
not close a gate: participant declarations, constrained-environment evidence,
and independent review are all required. An AI system is recorded as a tool,
not treated as the accountable author or signatory.

A repository-exposed environment custodian may prepare and attest the isolated
environment, but may not author schemas or perform the normative schema review.

## Future allowed author inputs

The current author allowlist is empty. After separate attributed approval of
`PV0-G01` and `PV0-G03`, a new authorization artifact may bind an exact author
packet containing only:

1. the exact approved `PV0-G03` requirement catalogue bytes; and
2. exact approved revisions of `PV0-IN-002` through `PV0-IN-006`, but only when
   the `PV0-G01` decision explicitly permits their use for constrained schema
   authoring and resolves terms, notices, prose, example-code, and test-vector
   restrictions.

Repository-derived inputs `PV0-IN-001`, `PV0-IN-007`, and `PV0-IN-009` through
`PV0-IN-011` must reach the schema author only through the independently
approved requirements catalogue. They are not direct author inputs.

`PV0-IN-008` remains RED for Protocol v0 authoring. Unknown or unbound inputs
default to RED.

## Source and tool isolation

The fresh authoring workspace must have no `clodex-ide` history, repository
mount, imported commit, patch, current protocol tree, CodeGraph/repository
index, GitHub code search, legacy source, tests, fixtures, or prior AI context.
It must start empty and use a deny-by-default input packet.

If AI is used, the later evidence must bind the exact provider, product, model
or version, build, fresh-session state, memory/history/retrieval settings,
network policy, prompts, approved packet, transcript, tools, MCP servers, and
generated outputs by digest. Persistent memory, conversation import,
repository retrieval, and unapproved MCP or search access remain forbidden.
This process makes no unverifiable claim about model pretraining; it records
and constrains the runtime context actually supplied to the tool.

The workspace must have no runtime dependencies and must reject `workspace:`,
`file:`, `link:`, Git/GitHub, `@clodex/*`, and `@stagewise/*` dependency edges.
Any development-only validation tools must later be pinned, reviewed, and
included in the environment evidence.

## Required future provenance

Before `PV0-G04` or `PV0-G05` can close, later evidence must provide:

- a fresh repository history starting from the bound empty commit;
- a per-file record covering input bindings, requirement IDs, human authors,
  independent reviewers, tool runs, generated content, manual edits, Git blob,
  commit, and SHA-256;
- requirements-only semantic-completeness review;
- a post-freeze RED-source warning scan performed by a non-authoring custodian,
  without returning source excerpts to the authors or modifying their work;
- explicit proof of zero runtime or monorepo dependency edges.

Similarity scanning is a warning signal only. It cannot prove clean provenance
or cure an exposed authoring process.

## Fail-closed execution gate

Fresh schema authorship remains blocked because:

- `PV0-G01` is open;
- `PV0-G03` is open;
- no named clean author or reviewer is recorded;
- source exposure is unresolved;
- no approved author packet is bound;
- no fresh workspace is bound;
- no tool context or environment attestation is present.

Therefore `authoringMayBegin` and `schemaEditsAuthorized` remain `false`.
`PV0-G02`, `PV0-G04`, and `PV0-G05` remain open. Every `PV0-G01` through
`PV0-G10` gate remains open.

This setup does not authorize schema changes, conformance payloads or runners,
code generation, SDK publication, protocol publication, relicensing, managed
Gateway implementation, enterprise/cloud implementation, or private product
implementation.

The setup artifact should remain immutable. Once the prerequisites and real
independent evidence exist, maintainers should add a separate attributed
execution-authorization artifact rather than rewriting this scaffold as though
approval existed at setup time.
