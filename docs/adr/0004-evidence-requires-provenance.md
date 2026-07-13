# ADR-0004: Evidence used for durable memory requires provenance

- **Status:** Accepted
- **Date:** July 13, 2026

## Context

Long-lived agent memory can amplify stale, contradicted, or fabricated context.
A plausible summary without a traceable source is not sufficient evidence for
future model context or automated decisions.

## Decision

Evidence admitted to durable memory or controlled context injection must retain
task/workspace scope, source events, freshness identity, and truth lifecycle.
Missing provenance, stale fingerprints, or unresolved contradictions exclude the
evidence rather than being silently accepted.

## Consequences

- Evidence records and claims are append-only or lifecycle-tracked.
- Retrieval exposes admissions, exclusions, and supporting source events.
- Injection fails closed when provenance or current identity cannot be proved.
- Tests and promotion evidence track missing-provenance and contradiction
  admissions as safety failures.

See `docs/evidence-graph-memory.md` and
`packages/agent-core/src/services/evidence-memory/`.
