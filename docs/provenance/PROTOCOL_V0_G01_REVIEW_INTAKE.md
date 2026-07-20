# Protocol v0 PV0-G01 independent-review intake

**Status:** setup only; awaiting a named independent provenance owner

This intake implements the evidence shape requested by issue `#75`. It does
not contain an attributed review and it does not close `PV0-G01` or any other
Protocol v0 gate.

## Frozen review target

Issue `#75` pins the review to main commit
`374539f98dba20d1aade6208c2834928bf7fa09a`. The machine-readable intake binds
the four named review inputs to their Git blob and SHA-256 values at that
commit. The current `OPEN_CLOSED_BOUNDARY.md` changed after the pinned commit;
a reviewer must inspect the frozen bytes rather than silently substitute the
current file. Retargeting the review requires an explicit issue/baseline
change and newly computed bindings.

## Required independent evidence

A future attributed review must be a separate maintainer-reviewed change. It
must record reviewer identity, role, affiliation, review date, independence,
and source-exposure declarations, then decide every `PV0-IN-001` through
`PV0-IN-011` as `APPROVE`, `REJECT`, or `CONDITIONAL` with rationale, exact
permitted/prohibited use, blocker disposition, and residual conditions.

For `PV0-IN-002` through `PV0-IN-006`, the reviewer must pin the official
revision and content digest and provide final terms, notice, specification
text, example-code, and test-vector conclusions. `PV0-IN-008` must remain
`RED_FOR_PROTOCOL_AUTHORING`; the review may approve only that exact negative
constraint and may not turn repository implementation exposure into a schema,
SDK, fixture, or private implementation input.

## Fail-closed behavior

The checked-in JSON remains `AWAITING_INDEPENDENT_REVIEW`: reviewer and sign-off
fields are empty, all eleven decisions and applicable verification fields are
`PENDING`, all unresolved input IDs are listed, and gate closure is ineligible.
CI rejects missing/duplicate/unknown inputs, baseline drift, terminal decisions
inside this setup artifact, a weakened RED requirement, prefilled attribution,
or any authorization for schemas, conformance payloads, SDK publication,
Gateway implementation, relicensing, or another gate closure.

This scaffold cannot prove reviewer independence. Human attribution and review
are still required before a separate evidence artifact can make a closure
claim. Until then, all `PV0-G01` through `PV0-G10` entries and publication/private
implementation authorization flags remain open and false.
