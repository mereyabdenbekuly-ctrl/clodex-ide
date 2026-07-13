# ADR-0002: Guardian authorization fails closed

- **Status:** Accepted
- **Date:** July 13, 2026

## Context

Authorization can fail because of invalid context, unavailable policy state,
timeouts, assessor errors, or ambiguous results. Treating those failures as
approval would turn reliability faults into security bypasses.

## Decision

Guardian and related policy adapters must fail closed. Invalid or unavailable
authorization cannot execute the sensitive action. The safe result is denial or
explicit escalation to the user; existing explicit blocks remain authoritative.

## Consequences

- Error handling must not return approval as a fallback.
- Approval is bound to the exact action and expires with its context.
- Tests must cover invalid context, timeouts, failures, cancellation, and replay.
- A change to fail-closed semantics requires a replacement ADR and security
  review.

See `docs/guardian-policy-mvp.md` and
`apps/browser/src/backend/services/guardian/`.
