# Provenance ledger

This ledger records architectural lineage during the strangler migration. It is
not a substitute for Git history, license notices, SBOMs, or legal review.
Machine-readable component status and dependency permissions live in
[`docs/provenance/components.yml`](../provenance/components.yml); this ledger
records the supporting migration evidence.

## Status values

- **Retain:** keep the component and preserve its upstream license/notice.
- **Adapt:** keep upstream-derived behavior behind a documented Clodex port.
- **Replace:** remove the implementation after parity and migration evidence.
- **Independent:** designed from Clodex contracts/specifications without a
  file-by-file rewrite.
- **Audit pending:** origin or licensing needs further verification.

| Component | Current path | Origin/base | Status | Target boundary | Evidence required |
| --- | --- | --- | --- | --- | --- |
| Karton transport | `packages/karton/` | Stagewise; MIT notice retained | Replace | shell adapter only during migration | protocol inventory, replacement IPC tests, license audit |
| Shared UI | `packages/stage-ui/` | Stagewise-derived | Replace | new desktop shell | component/asset inventory and visual parity |
| Desktop shell | `apps/browser/` | mixed Stagewise/Clodex | Adapt | legacy-shell adapter | domain-by-domain ownership map |
| Guardian | `apps/browser/src/backend/services/guardian/` | Clodex-specific path after recorded base | Audit pending | `clodex-guardian` | provenance audit, contract extraction, fail-closed tests |
| Evidence memory | `packages/agent-core/src/services/evidence-memory/` | Clodex-specific path after recorded base | Audit pending | `clodex-evidence` | provenance and persistence-port extraction |
| Network policy | `apps/browser/src/backend/services/network-policy/` | Clodex-specific path after recorded base | Audit pending | runtime/guardian adapter | egress threat model and regression suite |
| Agent/runtime foundations | `agent/`, `packages/agent-core/`, `packages/agent-shell/` | mixed | Audit pending | kernel/runtime ports | file-level license/provenance audit |
| New contracts | `packages/clodex-contracts/` | Clodex Stage 0 specification | Independent | `clodex-contracts` | ADR review and boundary CI |

## Entry requirements

Each future row or update records the upstream source/commit when applicable,
license, responsible reviewer, design specification, tests, and the pull request
that changed status. Removing the last upstream file does not by itself change a
component to **Independent**.
