# Migration parity matrix

Update this table in the pull request that changes a domain mode. `Kernel` means
one authoritative kernel/store; it does not mean that both shells have complete
UI parity.

| Domain | Current owner | Mode | Shadow comparison | Kernel exit criteria | Rollback |
| --- | --- | --- | --- | --- | --- |
| Task lifecycle | legacy agent/core services | Legacy | Not defined | create, resume, cancel, fork, restart recovery through contracts | legacy service flag |
| Model calls | mixed provider/model layer | Legacy | request identity, model, status, usage | provider-neutral request/result owned by kernel | legacy router |
| Guardian | Clodex backend Guardian | Legacy | decision outcome and reason codes | exact-action authorization; fail-closed parity | current Guardian adapter |
| Execution | agent-shell and backend adapters | Legacy | command/action status and receipt hashes | approved action executes once with cancellation and replay rules | legacy execution provider |
| Evidence | Clodex evidence memory | Legacy | compare receipt plans through a recording sink; no durable shadow write | kernel records append-only provenance before persistence acknowledgement | disable kernel writer before cutover |
| Persistence | mixed SQLite/service ownership | Legacy | snapshot revision and durable state hashes | one kernel store owns task state and recovery | legacy database owner |
| Workspace/Git/diff | current desktop services | Legacy | file identity, status, diff summary | shell-independent ports with identical repository outcome | legacy workspace adapter |
| Terminal | current desktop/agent-shell | Legacy | process lifecycle, exit, bounded output | approved commands and recovery through runtime port | legacy terminal service |
| Desktop shell | Electron/Karton/stage-ui | Legacy | user-flow acceptance tests | open repo, resume task, edit, diff, approved command, evidence, restart | current shell |

## Mode-change checklist

- [ ] Contract and owner are named.
- [ ] Legacy behavior has characterization tests.
- [ ] Shadow execution has no duplicate side effects.
- [ ] Effectful domains compare plans and execute only one real operation, or use a disposable sandbox/recording sink.
- [ ] Comparison fields and mismatch threshold are recorded.
- [ ] Migration and rollback are tested from real persisted state.
- [ ] Provenance ledger entry is updated.
- [ ] Security and privacy review is complete.
