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

| Component                     | Current path                                              | Origin/base                                                                    | Status        | Target boundary                     | Evidence required                                                                                                   |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Karton transport              | `packages/karton/`                                        | Stagewise; MIT notice retained                                                 | Replace       | shell adapter only during migration | protocol inventory, replacement IPC tests, license audit                                                            |
| Shared UI                     | `packages/stage-ui/`                                      | Stagewise-derived                                                              | Replace       | new desktop shell                   | component/asset inventory and visual parity                                                                         |
| Desktop shell                 | `apps/browser/`                                           | mixed Stagewise/Clodex                                                         | Adapt         | legacy-shell adapter                | domain-by-domain ownership map                                                                                      |
| Guardian                      | `apps/browser/src/backend/services/guardian/`             | Clodex-specific path after recorded base                                       | Audit pending | `clodex-guardian`                   | provenance audit, contract extraction, fail-closed tests                                                            |
| Evidence memory               | `packages/agent-core/src/services/evidence-memory/`       | Clodex-specific path after recorded base                                       | Audit pending | `clodex-evidence`                   | provenance and persistence-port extraction                                                                          |
| Network policy                | `apps/browser/src/backend/services/network-policy/`       | Clodex-specific path after recorded base                                       | Audit pending | runtime/guardian adapter            | egress threat model and regression suite                                                                            |
| Agent/runtime foundations     | `agent/`, `packages/agent-core/`, `packages/agent-shell/` | mixed                                                                          | Audit pending | kernel/runtime ports                | file-level license/provenance audit                                                                                 |
| New contracts                 | `packages/clodex-contracts/`                              | Clodex Stage 0 specification                                                   | Independent   | `clodex-contracts`                  | ADR review and boundary CI                                                                                          |
| Safe Coding Guardian          | `packages/clodex-guardian/`                               | independently implemented from `INTENT_CONTRACT_SPEC.md`                       | Independent   | `clodex-guardian`                   | canonical-contract, preflight, final-fence, and adversarial tests                                                   |
| Safe Coding kernel            | `packages/clodex-kernel/`                                 | independently implemented from `INTENT_CONTRACT_SPEC.md`                       | Independent   | `clodex-kernel`                     | CAS, revocation, budget, replay, and terminal-state tests                                                           |
| Safe Coding reference runtime | `packages/clodex-runtime/`                                | independently implemented recording-only slice                                 | Independent   | `clodex-runtime`                    | final-dispatch, exactly-once simulation, attestation, and failure-closure tests; production adapters remain blocked |
| Canonical approval reference  | `packages/clodex-approval/`                               | independently implemented from the authority-only approval specification       | Independent   | `clodex-approval`                   | canonical rendering/artifact, reviewer trust, replay, expiry, and final-fence tests                                 |
| Safe Coding logical ledger    | `packages/clodex-ledger/`                                 | independently implemented transaction/outbox reference                         | Independent   | `clodex-ledger`                     | reachable transitions, identity reservation, verified admission, bounded scan, and recovery tests                   |
| POSIX ledger adapter          | `packages/clodex-ledger-node/`                            | independently implemented trusted-local-filesystem adapter                     | Independent   | `clodex-ledger-node`                | file/directory fsync, atomic rename, reconciliation, inode, restart, and process-CAS tests                          |
| Signed evidence reference     | `packages/clodex-evidence/`                               | independently implemented from the Effect Attestation/checkpoint specification | Independent   | `clodex-evidence`                   | dual signature, trust snapshot, replay, chain, fork/rollback, and checkpoint tests                                  |
| Capability-scoped adapters    | `packages/clodex-adapters/`                               | independently implemented fixed-operation reference protocols                  | Independent   | `clodex-adapters`                   | audience/scope, exact-state, one-shot, mixed-registry, and accessor tests; OS implementations remain blocked        |
| Promotion assessment          | `packages/clodex-promotion/`                              | independently implemented fail-closed eligibility reference                    | Independent   | `clodex-promotion`                  | exact evidence binding, trusted clock/hash/final fence, and no-gate-authority tests                                 |

## Entry requirements

Each future row or update records the upstream source/commit when applicable,
license, responsible reviewer, design specification, tests, and the pull request
that changed status. Removing the last upstream file does not by itself change a
component to **Independent**.
