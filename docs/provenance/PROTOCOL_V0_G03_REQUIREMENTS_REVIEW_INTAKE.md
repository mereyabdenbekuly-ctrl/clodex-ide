# Protocol v0 PV0-G03 independent requirements-review intake

**Status:** setup only; awaiting a named independent requirements reviewer

This intake implements only the evidence shape requested by issue `#76`. It
does not contain an attributed requirements review, does not approve or revise
the requirement catalogue, and does not close `PV0-G03` or any other
Protocol v0 gate.

## Frozen review target

Issue `#76` pins the review to main commit
`374539f98dba20d1aade6208c2834928bf7fa09a`. The machine-readable intake
binds the following frozen inputs:

| Path | Git blob | SHA-256 |
| --- | --- | --- |
| `docs/protocol/agent-gateway-v0/REQUIREMENTS.md` | `2a1768411bbf7c78c3c2eca09e86c4a5052477d1` | `e670ea4af006602d304f92b13d977067a7201e185d8db028010c101450958d52` |
| `docs/provenance/PROTOCOL_V0_INPUT_MANIFEST.json` | `5000ec24b5c90c0c0296f0d72076b1710518c1f3` | `73d1b87194605704037162cb7cc5b47ac5fd2dc56dd6c0860d3757f34fd0b1b2` |
| `docs/protocol/agent-gateway-v0/traceability.json` | `a8857d64eb0a5a6891d45937dff5a6692e26b45c` | `e08704376b6955b894b6b0d6ae61de22d3ede1306695a4de96dc567b324b610d` |

A reviewer must inspect those frozen bytes rather than silently substitute
current files. Retargeting requires an explicit issue/baseline change and new
bindings.

## Frozen catalogue scope

The intake contains exactly 39 frozen requirement IDs from the pinned
`REQUIREMENTS.md`, once and in catalogue order. A future attributed report
must decide each one as `APPROVE`, `REVISE`, or `REJECT`, with rationale
and review of necessity, clarity, testability, conflicts, and missing security
or privacy constraints. A `REVISE` decision requires exact replacement text.

It must also identify any missing deployment-independent requirement and bind
the resulting approved catalogue to an exact commit, path, Git blob, SHA-256,
and requirement-ID set.

## Approved-input prerequisite

`PV0-G01` remains open. No attributed terminal input approval or approved
input set exists, so approved-input re-derivation is not yet eligible. The
current input manifest is an inventory under review, not approval evidence.

`traceability.json` is non-normative comparison material. Its source lists,
file paths, schema fields, pointers, and current implementation decomposition
must not be used as authority for requirement necessity, wording, or
structure. `PV0-IN-008` remains RED for protocol authoring.

## Fail-closed behavior

The checked-in JSON remains
`AWAITING_INDEPENDENT_REQUIREMENTS_REVIEW`: attribution and sign-off are
empty; all 39 decisions, assessments, derivations, implementation-independence
reviews, and catalogue-completeness findings remain pending; no approved
catalogue revision exists; every requirement remains unresolved; and
`PV0-G03` remains open.

CI rejects baseline drift, missing/duplicate/unknown/reordered requirement IDs,
prefilled attribution, terminal decisions, copied provisional traceability
inputs, RED-source use, implementation-derived normative authority, fabricated
catalogue completion, a closure claim, or authorization for requirement
changes, schemas, conformance payloads, code generation, SDK publication,
Gateway or enterprise/cloud implementation, relicensing, or another gate
closure.

This scaffold cannot prove reviewer independence. A separate attributed,
maintainer-reviewed evidence change is required. Until then, all `PV0-G01`
through `PV0-G10` remain OPEN and publication/private implementation
authorization remains false.
