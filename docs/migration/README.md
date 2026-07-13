# Hybrid strangler migration

This directory tracks the staged move from the current mixed desktop/core to an
independent Clodex kernel and shell. It is an engineering plan, not a claim that
the migration is already complete.

## Stage 0 deliverables

- versioned shell-independent contracts in `packages/clodex-contracts`;
- [ADR-0005](../adr/0005-hybrid-strangler-migration.md);
- automated forbidden-import checks;
- a machine-readable [component registry](../provenance/components.yml) with
  deny-by-default dependency allowlists;
- a [parity matrix](parity-matrix.md) for domain cutovers; and
- a [provenance ledger](provenance-ledger.md) for retained, adapted, replaced,
  and independently designed components.

Normative dependency and shadow-execution rules are defined in
[`docs/architecture/BOUNDARIES.md`](../architecture/BOUNDARIES.md). Independent
implementation and AI-source rules are defined in the
[provenance policy](../governance/PROVENANCE_POLICY.md).

## Domain cutover

Every migrated domain moves through:

1. **Legacy:** the current service remains authoritative.
2. **Shadow:** the kernel evaluates the same input without side effects and its
   result is compared with the legacy result.
3. **Kernel:** the kernel becomes the only state owner; shells are clients.

Shadow mode requires explicit comparison fields, mismatch budgets, telemetry
that excludes sensitive content, and a rollback switch. A domain cannot enter
Kernel mode while unresolved mismatches can alter authorization, persistence,
or user-visible results.

Both implementations may run only for pure computation such as policy
evaluation, state-transition calculation, serialization, ranking, and planning.
For terminal commands, file or Git writes, network requests, cloud jobs,
messages, credential access, persistence, and other side effects, shadow mode
compares execution plans and executes exactly one selected plan. The
non-authoritative implementation may instead use a recording executor or a
disposable sandbox that cannot affect real state. A policy mismatch must never
select the more permissive result.

## First vertical slice

The first production slice is complete when one task follows this path through
kernel contracts while the existing UI acts only through an adapter:

```text
task -> model call -> proposed action -> Guardian -> execution
     -> evidence receipt -> persistence
```

## Independent V1 exit criteria

- the production dependency graph has no Stagewise, Karton, or `stage-ui`
  dependency;
- the new desktop shell can open a repository, restore a task, read and edit
  files, show a diff, execute an approved command, show evidence, and recover
  after restart;
- upstream assets, fixtures, and shell acceptance tests are replaced or retained
  with explicit licensing;
- persisted-state migration and rollback are tested; and
- provenance, SBOM, and license audits are complete.

## Planning horizon

The current planning assumptions for 4–5 strong engineers plus part-time QA and
design are:

| Stage | Outcome | Effort | Calendar assumption |
| --- | --- | ---: | ---: |
| 0. Boundaries | contracts, ADRs, provenance, import rules, parity matrix | 5–8 person-weeks | 2–3 weeks |
| 1. New center | kernel/Guardian/runtime/ledger/evidence and one vertical slice through the old UI | 30–45 person-weeks | 10–14 weeks |
| 2. Domain migration | tasks, persistence, Agent Host, models, workspace ports, terminal execution | 40–60 person-weeks | 3–5 months |
| 3. New shell | own IPC/state, lifecycle, workspace, Git/diff, terminal, primary UI | 55–80 person-weeks | 4–6 months |
| 4. Legacy removal | preview remnants, assets/tests, migration, packaging, hardening | 25–40 person-weeks | 2–3 months |

Stages may overlap. The working range is 9–15 months for an independent
local-first V1 with that team, and 18–26 months for broad parity with the
current Preview's advanced surfaces. These are capacity assumptions, not
deadlines or maturity claims. Later stages must revise them using measured
delivery rates and domain-specific estimates from completed vertical slices.

Very rough capacity scenarios are 18–26 months with two engineers, 7–10 months
with 6–8 engineers, and 2.5–3.5 years for sustained solo development. Adding
people does not scale linearly because adapters, review, provenance, migration,
and shell parity remain coordination-heavy.
