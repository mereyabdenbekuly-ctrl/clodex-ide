# ADR-0005: Use a hybrid strangler migration

- **Status:** Accepted for planning and Stage 0
- **Date:** July 13, 2026

## Context

The current desktop and core contain substantial Stagewise-derived and mixed
layers. A big-bang rewrite would combine provenance, product-parity, security,
and release risk in one cutover. Keeping the current shell forever would leave
new Clodex systems coupled to Karton, `stage-ui`, Electron UI, and legacy state
ownership.

## Decision

Clodex will migrate by domain using three modes:

```text
legacy -> shadow -> kernel
```

The target dependency direction is:

```text
clodex-contracts
        ^
clodex-kernel
        ^
clodex-runtime --- clodex-guardian
        |---------- clodex-ledger
        `---------- clodex-evidence
             ^
     +-------+--------+
legacy-shell       clodex-desktop
adapter            new shell
```

Both shells must use one kernel and one authoritative store. Bidirectional
dual-write may exist only as a bounded migration mechanism and must not survive
longer than one release without a new decision record.

`packages/clodex-*` may not import `apps/browser`, Electron, Karton,
`stage-ui`, or `@stagewise/*`. Platform adapters stay outside the kernel.
The machine-readable component registry and allowlists in
`docs/provenance/components.yml` are authoritative for CI enforcement.

## Consequences

- Stage 0 adds contracts, boundary checks, parity tracking, and provenance
  records before moving behavior.
- Each domain names one source of truth and measurable shadow comparisons.
- The old shell remains a fallback client, not a second business-logic owner.
- File-by-file rewrites are not evidence of independent design. New code must be
  driven by contracts, tests, ADRs, and recorded provenance.
- Estimates remain planning assumptions and are revised from measured slices.

See [`docs/migration/`](../migration/README.md).
