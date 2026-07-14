# P0 Zero-Trust testing handoff

- **Status:** `FOCUSED_LOCAL_PASS_BROAD_CI_PENDING`
- **Date:** July 15, 2026
- **Owner:** PR #16 remediation handoff to root reviewer and independent CI
- **Worktree:** branch `security/p0-durable-mcp-approval-20260714`, based on
  commit `94eadfadeb172898308136b95700aca75a8cbfd6`, with the remediation diff
  still uncommitted at evidence capture time. The intended next step is root
  review followed by a DCO-signed follow-up commit; no final commit SHA is
  claimed here.
- **Current claim:** focused source regression and typecheck evidence passed on
  one local macOS arm64 host. Nothing in this handoff upgrades a manifest row
  to `ENFORCED`, and nothing below claims packaged, Linux, Windows, native
  helper, container, LSM, crash/power-loss, or external-effect coverage.

## PR #16 focused remediation evidence

Environment: Darwin 24.6.0 arm64, pinned Node.js `v22.23.1` from
`/private/tmp/clodex-toolchains/node-v22.23.1-darwin-arm64/bin`, pnpm
`10.30.3`.

The following commands completed successfully against the uncommitted
worktree described above:

```sh
export PATH=/private/tmp/clodex-toolchains/node-v22.23.1-darwin-arm64/bin:$PATH

pnpm -F @clodex/agent-core exec vitest run \
  src/services/agent-manager/state-mutations/approvals.test.ts
# 1 file, 4 tests passed

pnpm -F clodex exec vitest run \
  src/backend/agent-host/openmanus-runtime.test.ts \
  src/backend/services/toolbox/tools/agents/run-openmanus.test.ts \
  src/backend/agent-host/supervisor.test.ts \
  src/backend/startup/phases/platform-integration-services.test.ts \
  src/backend/services/automations/index.test.ts \
  src/backend/agent-host/browser-agent-step-executor.test.ts \
  src/backend/agent-host/execution-target-router.test.ts \
  src/backend/services/swarm-runtime/index.test.ts \
  src/backend/services/toolbox/services/clodex-mcp/index.test.ts \
  src/backend/services/mcp/index.test.ts \
  src/backend/services/mcp/trusted-dispatch-gateway.test.ts \
  src/backend/services/artifact-bridge/index.test.ts \
  src/backend/services/artifact-bridge/session4-adversarial.test.ts \
  src/backend/services/artifact-bridge/host-session.test.ts \
  src/backend/services/artifact-bridge/async-operation-final-dispatch.test.ts \
  src/backend/services/artifact-bridge/effect-wal-integration.test.ts
# 16 files, 211 tests passed

pnpm -F @clodex/agent-core typecheck
# passed

pnpm -F clodex typecheck
# agent-core and agent-shell builds plus ui/pages/backend/preload/storybook/visual
# TypeScript projects all passed

pnpm check
# exited 0 with three pre-existing website warnings; no Biome errors

git diff --check
# passed
```

This is **215 focused unit tests**, not the repository-wide test matrix. GitHub
CI, the full repository test command, Windows, Linux, packaged Electron, and
native/adversarial batches remain required independent evidence.

## Required testing principles

1. Start from a clean commit containing the P0 implementation.
2. Do not enable any production feature-gate default while testing.
3. Run destructive filesystem, Git, Docker, crash, and recovery scenarios only
   in disposable workspaces and temporary data roots.
4. Treat timeout, process death, result loss, checkpoint failure, and storage
   ambiguity after final dispatch as `UNCERTAIN`; never retry an effect merely
   because a response was unavailable.
5. Verify negative properties by inspecting the external target, durable WAL,
   ledger, evidence outbox, checkpoint, and consumed-ticket state together.
6. Keep every production authority gate default-off. Passing a test batch is
   evidence input for a later reviewed promotion decision, not permission for
   the test model to enable a gate.

## Current source-only P0 closure tranche

The following source-only P0 claims are broader than the focused remediation
matrix above. Only the exact files and commands recorded above were locally
executed; the remainder still requires the independent broad, packaged,
cross-platform, native, and fault-injection work described later in this
handoff:

- a durable one-shot Automation WAL covers manual, timer, system-resume, and
  startup-reconciliation dispatches, commits the exact definition/occurrence/
  attempt, and recovers `PREPARED → FAILED_PRE_EFFECT` and
  `DISPATCHING → UNCERTAIN` without replay;
- a central trusted MCP **tool-call** dispatch boundary commits the exact
  descriptor, trusted classification, authority binding, and current runtime
  generation, runs Guardian policy, requires exact affirmative approval
  authority for any approval-required call, and consumes that authority at the
  final dispatch fence. The approval broker must derive sign-off from canonical
  AgentStore approval history; `requiresApproval`, `needsApproval`, MCP
  annotations, or a model-selected field are not approval evidence. Its
  source-only durable store persists bounded identities plus exact descriptor/
  context/effect/decision digests, writes `STAGED` before `needsApproval`
  returns true or the host pending-approval record is published, and implements
  the explicit-response lifecycle
  `STAGED → RESPONSE_RECORDED → APPROVED → CLAIMED` or
  `STAGED → RESPONSE_RECORDED → DENIED`. `RESPONSE_RECORDED` is deliberately
  non-authorizing. The common `BaseAgent` ingress requires exactly one matching
  `approval-requested` part, waits for the originating step's UI stream and
  final best-effort save attempt to settle without a step failure, runs broker
  prepare, performs an exact AgentStore mutation, and strictly persists the
  full affected message payload for the persistent browser agent through a
  per-agent serialized Agent SQLite queue. That queue binds the enqueue-time
  payload, rechecks fresh AgentStore, and reads back message ID, role, parts,
  and metadata inside the transaction before broker commit. Only then may
  continuation be scheduled. User-message ingress, queue flush, stop/recovery,
  retry, replace, revert, and recovered UI replay are serialized per agent.
  Priority stop/flush/recovery advances the step and approval generations and
  aborts the current controller synchronously before its durable cleanup waits
  for that queue. Destructive history rewrites hold an admission gate across
  host undo and the exact synchronous mutation. Recovered replay uses one
  session-bound generation and a bounded closed-execution tombstone set, so a
  superseded late chunk cannot reopen the stream. Replay ingress that overlaps
  a queued priority stop/flush/recovery is tombstoned before admission. Before
  subscriber-visible `beginStep`, replay also snapshots the history-preemption
  generation; synchronous AgentStore priority preemption wins before replay
  session identity is published, and a `finally` path records the tombstone
  even when that subscriber throws. A failed strict save or broker commit rolls
  the in-memory part back when its exact binding is still present; otherwise a
  sticky admission barrier prevents continuation. New user messages, stop,
  queue flush, and system
  interruption durably invalidate open broker records before their existing
  AgentStore sweeps; broker `INVALIDATED` records do not masquerade as canonical
  human denial evidence. A failed automatic-sweep save retains its dirty rows
  behind a fail-closed retry barrier, including a synchronous subscriber
  failure after mutation commit.
  Exact affirmative evidence is hashed into the claimed record and
  re-read after persistence; expiry, or invalid evidence observed during claim,
  closes `EXPIRED`/`INVALIDATED`. Encrypted broker writes fsync the temporary
  file and fsync the containing directory on platforms where that operation is
  supported (the current Windows path skips directory fsync). Ambiguous broker
  save outcomes are reconciled by exact read-back without converting a rejected
  save into authority issuance; an intended read-back remains
  durability-pending and must pass a later idempotent save barrier before
  another mutation or teardown reports success;
- production shell session creation and command/stdin/kill/poll dispatch are
  staged and one-shot consumed through `ShellCapabilityBroker`, including the
  exact mount prefix and resolved host cwd for PTY creation; the browser wires
  a dedicated audit path rather than exposing an unfenced shell callback;
- the JavaScript sandbox rejects remote `import(data:)`/URL module execution,
  ambient `fs`, `fsPromises`, and `require('fs')`; mount metadata no longer
  mints host-filesystem authority inside the worker;
- OpenManus protocol v4 carries no raw credential, host path, executable,
  argv/environment, model endpoint, or base-URL authority. Production injects
  no OS-confined brokered adapter, so OpenManus execution fails closed;
- cloud/local ownership is checked at routing and again before local
  execution, remote-turn dispatch, host model calls, and host tool calls;
  omission of the ownership callback defaults to deny;
- missing mount permissions default to read-only, exact per-agent permissions
  are exposed to mediated tools, and Swarm no longer auto-mounts global,
  stored, last-used, or recent host workspaces;
- browser `main.ts` constructs the Safe Coding production composition with
  `provider: null`, therefore authority remains null. Shutdown first stops
  admission and drains this service before effect-serving dependencies are
  torn down; neither the raw production authority handle nor an effect port is
  exposed.

These are source statements, not runtime guarantees. External-effect
atomicity, independently protected/linearizable anti-rollback heads,
production key custody, target-OS/native-helper/container/LSM evidence, and a
packaged Electron smoke remain explicit non-claims. MCP `STAGED`,
`RESPONSE_RECORDED`, `APPROVED`, and `CLAIMED` records survive ordinary restart
while the encrypted broker store remains present, and a claimed
agent/tool-call identity is retained as a bounded fail-closed replay tombstone.
The exact `approval-responded` message is separately committed to Agent SQLite,
but this does not reconstruct ephemeral AgentStore `pendingApprovals`, restore a
resumable approval UI, or automatically continue the turn after restart.
`APPROVED` means only that the exact response passed the ordered broker and
Agent SQLite barriers; it does not prove dispatch. Nor does `CLAIMED` prove that
the in-memory final authority was consumed, that IPC/network dispatch occurred,
or that the external effect committed. The broker revision is stored in the
same encrypted file and has no independently protected monotonic or existence
anchor, so hostile rollback, deletion, or reset to a fresh empty store remains
outside the claim. Coordinated rollback or deletion of both the broker and
Agent SQLite stores is not detected. Expiry uses the wall clock rather than a
trusted monotonic clock, so clock rollback can extend open-record validity.
Windows lacks the containing-directory fsync used for the broker on supported
platforms, and SQLite power-loss durability has not been established.
Tombstones are retained up to the bounded capacity and capacity exhaustion
fails closed rather than pruning replay history. The implementation does not
provide cross-process writer serialization or a transaction shared by broker
JSON, Agent SQLite, final MCP dispatch, and the external effect; the lifecycle
is deliberately ordered and fail-closed, not cross-store atomic.

Source map for the testing model:

- [Automation WAL](../../apps/browser/src/backend/services/automations/dispatch-wal.ts)
  and [Automation service](../../apps/browser/src/backend/services/automations/index.ts);
- [MCP gateway](../../apps/browser/src/backend/services/mcp/trusted-dispatch-gateway.ts),
  [approval broker](../../apps/browser/src/backend/services/mcp/approval-broker.ts),
  [registry service](../../apps/browser/src/backend/services/mcp/index.ts),
  [registry agent tools](../../apps/browser/src/backend/services/mcp/tools.ts),
  and [Clodex-cloud tools](../../apps/browser/src/backend/services/toolbox/services/clodex-mcp/index.ts);
- [common approval ingress](../../packages/agent-core/src/agents/base-agent.ts),
  [exact approval mutations](../../packages/agent-core/src/services/agent-manager/state-mutations/approvals.ts),
  [manager hook and serialized persistence wiring](../../packages/agent-core/src/services/agent-manager/agent-manager.ts),
  and [Agent SQLite persistence](../../packages/agent-core/src/services/agent-persistence/db.ts);
- [Toolbox broker adapters](../../apps/browser/src/backend/services/toolbox/index.ts),
  [browser AgentManager composition](../../apps/browser/src/backend/services/agent-manager/agent-manager.ts),
  and [main-process hook wiring](../../apps/browser/src/backend/main.ts);
- [shell capability broker](../../apps/browser/src/backend/services/guardian/shell-capability-broker.ts),
  [shell action fences](../../packages/agent-shell/src/tools/execute-shell-command.ts),
  and [platform wiring](../../apps/browser/src/backend/startup/phases/platform-integration-services.ts);
- [JavaScript sandbox worker](../../apps/browser/src/backend/services/sandbox/sandbox-worker.ts);
- [OpenManus runtime](../../apps/browser/src/backend/agent-host/openmanus-runtime.ts),
  [protocol](../../apps/browser/src/backend/agent-host/protocol.ts), and
  [supervisor](../../apps/browser/src/backend/agent-host/supervisor.ts);
- [browser executor](../../apps/browser/src/backend/agent-host/browser-agent-step-executor.ts),
  [execution router](../../apps/browser/src/backend/agent-host/execution-target-router.ts),
  [Swarm runtime](../../apps/browser/src/backend/services/swarm-runtime/index.ts),
  and [mount manager](../../apps/browser/src/backend/services/toolbox/services/mount-manager/index.ts);
- [Safe Coding browser composition](../../apps/browser/src/backend/services/safe-coding/production-authority.ts),
  [main wiring](../../apps/browser/src/backend/main.ts), and
  [ordered shutdown](../../apps/browser/src/backend/services/shutdown-coordinator.ts).

## Batch A — browser closure regression

Before the independent model runs broad repository validation, it must add or
complete focused tests for the source-only paths above. At minimum, prove:

1. Automation manual/timer/resume/startup paths all persist `PREPARED` before
   `DISPATCHING`, never blind-retry an occurrence, expose machine-readable
   `uncertain`, reject cycles/accessors/sparse arrays/oversized commitments,
   and flush after active mutations during teardown.
2. Every agent-reachable registry tool and the current host-allowlisted
   read-only Clodex-cloud tool enter the central gateway. Effectful/
   approval-required Clodex-cloud tools remain intentionally unregistered;
   their durable-approval path is wiring only unless a read-only cloud tool is
   escalated by Guardian. A tool requiring approval cannot dispatch unless the
   exact tool name, tool-call ID, principal, descriptor digest,
   approval-context digest, canonical arguments, approval ID, and committed
   affirmative decision match a single AgentStore part.
   Prove `STAGED` is durable before `needsApproval` returns true and before the
   host pending-approval record is published; exact duplicate staging is
   idempotent while changed bindings fail closed. Prove the explicit order
   `originating-step settlement → broker prepare → exact AgentStore mutation →
   strict exact-payload Agent SQLite commit → broker commit → continuation`;
   neither `STAGED` nor
   `RESPONSE_RECORDED` may pass `claim()` or start continuation. Cover explicit
   approve and deny, broker-level exact-duplicate idempotency, common-ingress
   duplicate/double-click rejection, opposite-decision conflict,
   unknown/ambiguous approval IDs, true dynamic-tool names, non-tail message
   persistence, an approval click while the originating UI stream is still
   draining, and response input/tool/approval binding drift. Prove a strict
   persistence failure or broker-commit failure never schedules continuation,
   restores the exact request plus pending-approval metadata when possible, and
   otherwise leaves the admission barrier closed. Race double-click,
   approve-versus-deny, UI-versus-remote ingress, a response against an
   overlapping ordinary save, and multiple simultaneous approvals. Verify the
   per-agent queue reads a fresh AgentStore snapshot inside serialization so an
   older save cannot overwrite a committed response. The strict DB path must
   verify that each enqueue-time expected message ID, role, parts, and metadata
   payload exists at its exact SQLite sequence before the transaction commits.
   Prove new user message, stop, queue flush,
   and system interruption invalidate the listed records plus any unpublished
   open MCP record for the same agent before the AgentStore sweep, clear orphan
   `pendingApprovals` keys, strictly persist affected history rows, retain and
   retry dirty rows after a rejected save or synchronous subscriber failure,
   never record broker state `DENIED` or treat cancellation output as canonical
   `approval-responded` human evidence. Race cancellation against the gap between
   broker stage, pending-approval indexing, UI-part merge, and a stale
   `needsApproval` callback (MCP, remote, shell, or sandbox) that runs after
   cancellation linearizes. Exercise recovered replay while a priority
   stop/flush/recovery is already pending and when that priority action is
   enqueued after replay ingress but before its serialized worker starts. Also
   exercise a `beginStep` subscriber that (a) enqueues each priority action and
   returns and (b) enqueues it and throws. Prove the chunk is never merged,
   sequence-marked, or persisted; no replay identity is published; the
   execution is tombstoned; and every later chunk is `duplicate` while the
   queued priority worker still owns cleanup. Crash after every lifecycle
   transition and confirm that restart does
   not reconstruct the pending-approval UI or automatically continue a turn.
   Affirmative evidence must be hashed and rechecked after persistence, and
   `CLAIMED` must be durably saved before authority return. Restart must preserve
   claimed replay tombstones, expire stale open records, reject
   duplicate/reused/denied/ambiguous/malformed evidence, and fail closed at the
   bounded capacity. Fault save-before-apply, apply-then-throw, read-back
   mismatch, corrupt/truncated data, unavailable encryption, and teardown with
   queued mutations; prove every rejected save rejects the claim even when
   read-back contains the intended tombstone.
   Prove that the intended tombstone remains burned in memory and that the next
   mutation/flush/teardown retries the same persistence barrier before success.
   Separately cover deleted/reset stores, wall-clock rollback, Windows' missing
   directory-fsync guarantee, and restart without reconstructed AgentStore
   pending-approval UI. Descriptor/runtime/Guardian revision drift must still
   fail at the last synchronous fence. Report
   `APPROVED` only as a committed response, not dispatch, and `CLAIMED` only as
   a replay tombstone, not proof of final consumption, dispatch, or effect;
   separately demonstrate that rollback of the broker file, coordinated
   rollback/deletion of broker plus Agent SQLite, and cross-process writers are
   not protected without independent anchors/serialization. Treat SQLite
   power-loss durability as unproven. If MCP resource/prompt agent tools remain
   disabled, prove resource/prompt access is settings-only and cannot become an
   agent effect path.
3. PTY creation and command/stdin/kill/poll execution cannot bypass the
   capability broker and its audit record; changed mount resolution plus stale,
   missing, mismatched, reused, or unauditable authority fails closed.
4. Sandbox code cannot load remote/data JavaScript or reach host files through
   globals, `require`, mount updates, aliases, or cached module state.
5. OpenManus cannot execute through the Electron utility process or receive
   secrets/paths/process authority; absence or descriptor drift of the
   OS-confined adapter fails closed.
6. A cloud lease change at each await boundary blocks local/remote model and
   tool dispatch, including wrapped local tools. Browser executor callback
   omission must fail closed. Swarm must recheck ownership before every direct
   model, tool, and history-producing dispatch rather than only at routing.
7. Swarm and universal tools receive only explicit per-agent mounts and exact
   permissions. A guessed prefix belonging to another agent must be denied,
   not downgraded to read-only; read-only fallback applies only to an already
   attached mount whose permission metadata is absent. An empty delegated mount
   scope stays empty.
8. Safe Coding browser startup with `provider: null` publishes no authority,
   mutates no gate, exposes only content-free diagnostics, and shutdown drains
   it before dependent services.

Suggested focused commands, to be run only by the testing model after it has
added the missing test files:

```sh
pnpm --dir apps/browser test -- \
  src/backend/services/automations/dispatch-wal.test.ts \
  src/backend/services/automations/index.test.ts \
  src/backend/services/mcp/trusted-dispatch-gateway.test.ts \
  src/backend/services/mcp/approval-broker.test.ts \
  src/backend/services/mcp/approval-lifecycle-wiring.test.ts \
  src/backend/services/mcp/index.test.ts \
  src/backend/services/agent-manager/agent-manager.test.ts \
  src/backend/services/toolbox/services/clodex-mcp/index.test.ts \
  src/backend/services/guardian/shell-capability-broker.test.ts \
  src/backend/services/sandbox/sandbox-worker.test.ts \
  src/backend/agent-host/openmanus-runtime.test.ts \
  src/backend/services/toolbox/tools/agents/run-openmanus.test.ts \
  src/backend/agent-host/cloud-task-execution-lease.test.ts \
  src/backend/agent-host/execution-target-router.test.ts \
  src/backend/agent-host/browser-agent-step-executor.test.ts \
  src/backend/services/swarm-runtime/index.test.ts \
  src/backend/services/toolbox/services/mount-manager/index.test.ts \
  src/backend/services/safe-coding/production-authority.test.ts \
  src/backend/services/shutdown-coordinator.test.ts
pnpm --dir apps/browser typecheck
pnpm --dir packages/agent-core test -- \
  src/services/agent-manager/state-mutations/approvals.test.ts \
  src/agents/base-agent.approval-lifecycle.test.ts \
  src/services/agent-manager/agent-manager.persistence-queue.test.ts \
  src/services/agent-persistence/db.test.ts
pnpm --dir packages/agent-core typecheck
```

If a named focused test does not yet exist, creating it is part of the testing
handoff; do not silently omit that boundary from the evidence report.

## Session P0-1 — universal effect and automation WAL

The testing model must add or complete focused tests proving:

- direct ask-agent dispatch writes `PREPARED` before the final dispatch fence;
- ordinary asynchronous MCP effects use the same durable state machine as
  reviewed write/sensitive calls;
- Artifact Bridge automation binds the exact definition revision, model
  adapter, model ID, message/mount inputs, principal, grant revision, and
  feature-gate snapshot;
- AutomationService manual, timer, system-resume, and startup-reconciliation
  dispatches share the durable one-shot occurrence WAL described in Batch A;
- revoke, expiry, session close, cancellation, timeout, or gate disable before
  final dispatch causes no effect;
- every failure after final dispatch closes `COMMITTED`,
  `RESULT_UNAVAILABLE`, or `UNCERTAIN` and burns the one-shot ticket;
- startup never replays and converts universal orphan states exactly:
  `PREPARED → FAILED_PRE_EFFECT`, `DISPATCHING → UNCERTAIN`, and
  `COMMITTED → RESULT_UNAVAILABLE` because universal results are not persisted;
- partial `create-agent → mount → message` automation is durably uncertain or
  compensates through an explicitly recorded action; it never silently reports
  rollback;
- oversized, cyclic, accessor-based, or unserializable results cannot repeat
  an effect.

The current unexecuted implementation adds universal WAL classes
`agent-ask`, `automation`, and `mcp-read-async`; commitment fields
`actionHash`, `definitionHash`, and `adapterHash`; and a deterministic
context/request-scoped effect UUID. Verify different app/agent contexts remain
independent, while the same request ID remains one reserved identity across
session rotation/regrant and rejects any changed commitment without dispatch.
Prove a restarted request cannot reuse an earlier effect ID for different
authority bytes; concurrent exact duplicates must produce at most one effect.
Also exercise malicious reservation/WAL-exhaustion availability pressure.
Verify ask-agent
binds requested/resolved provider/model, adapter version, timeout, output
limit, and `maxRetries: 0`. Verify automation binds its complete definition,
model, workspace, grant, mounts/message, and composite
`create → mounts → message` adapter state. A failure after agent creation must
remain durably `UNCERTAIN`, not be converted to a successful rollback.

Explicit residual scope to preserve in the report: ordinary synchronous
read-MCP external semantics, atomicity with the external provider/MCP/agent
store, and protected WAL anti-rollback are not established by this tranche.
The new AutomationService WAL closes the prior source gap for scheduled/manual
entry paths, but remains `IMPLEMENTED_UNVERIFIED` until Batch A passes.

Verify graceful teardown waits every tracked universal-effect closure and then
flushes the WAL. Abrupt process loss before that barrier must be reconciled by
the startup transitions above. Preserve two explicit non-claims: direct
frame-broker response `postMessage` failure has no delivery acknowledgement
back into the service for immediate `RESULT_UNAVAILABLE`, and injected/custom
hosts that omit durable `effectWalPersistence` remain memory-only even though
production `main.ts` supplies persisted WAL storage.

Suggested commands, to be executed only by the testing model:

```sh
pnpm --dir apps/browser test -- \
  src/backend/services/artifact-bridge/effect-wal.test.ts \
  src/backend/services/artifact-bridge/effect-wal-integration.test.ts \
  src/backend/services/artifact-bridge/async-operation-final-dispatch.test.ts \
  src/backend/services/artifact-bridge/session4-adversarial.test.ts \
  src/backend/services/artifact-bridge/host-session.test.ts \
  src/backend/services/artifact-bridge/index.test.ts \
  src/backend/services/artifact-bridge/evaluation-suite.test.ts \
  src/backend/services/automations/dispatch-wal.test.ts \
  src/backend/services/automations/index.test.ts
pnpm --dir apps/browser typecheck
pnpm --dir apps/browser test
```

## Session P0-2 — atomic control-plane transaction

The implementation currently contains **21 core + 14 Node test declarations**;
none were executed in this tranche.

Required state-machine and fault scenarios:

- atomic creation of the transaction, ticket reservation, effect attempt, and
  evidence outbox;
- exact CAS conflict behavior for transaction, ticket, request, reservation,
  attempt, attestation, evidence-intent, nonce, and idempotency identities;
- crash before permit: `FAILED_PRE_EFFECT`, no effect authority;
- crash after permit but before a positive observation: `UNCERTAIN`, no replay;
- observed effect plus unavailable result: `RESULT_UNAVAILABLE`, no replay;
- terminal evidence admission and checkpoint failure remain recoverable without
  minting a second attestation identity;
- restart reconstruction rejects rollback-shaped revisions, orphan records,
  forked history, truncated snapshots, stale locks, and accessor-shaped port
  outputs;
- post-rename/apply-then-throw paths reconcile exact durable state before
  returning or expose an explicit ambiguous outcome.

Commands will depend on the final package names. At minimum:

```sh
pnpm --filter @clodex/control-plane test
pnpm --filter @clodex/control-plane typecheck
pnpm --filter @clodex/control-plane-node test
pnpm --filter @clodex/control-plane-node typecheck
```

## Session P0-3 — signed registries and protected heads

The implementation currently contains **11 core + 7 POSIX test declarations**;
none were executed in this tranche.

Required adversarial coverage:

- canonical manifest bytes and strict signature encoding;
- workspace/task/root scope is signed and exact;
- adapter, runner, and effect members resolve only from the verified manifest;
- duplicate member IDs or digests, unknown fields, sparse/accessor arrays,
  excessive size/depth, mixed trust epochs, expired manifests, wrong issuer,
  and wrong environment/build/config/policy fail closed;
- previous-hash, epoch, and protected-head rollback/fork rejection;
- key revoke/role/registry drift during verification is caught by the final
  synchronous trust fence;
- a POSIX snapshot without an independent protected anchor is never reported as
  rollback-resistant.

Suggested commands:

```sh
pnpm --filter @clodex/registry test
pnpm --filter @clodex/registry typecheck
pnpm --filter @clodex/registry-node test
pnpm --filter @clodex/registry-node typecheck
```

## Session P0-4 — OS-confined adapters

Run on the exact supported production platform, not only through mocks.

Filesystem cases:

- traversal, absolute paths, symlinks, magic links, mount crossing, hard-link
  aliases, root replacement, parent replacement, and rename races;
- atomic create/mkdir absent-state CAS;
- replace refuses state/content/inode drift between inspect and commit;
- file and parent-directory `fsync` occurs before success;
- revoke before the helper's final syscall prevents mutation;
- helper death after mutation produces durable uncertainty and no retry.

Git cases:

- global/system/local config injection, hooks, pager, external diff, textconv,
  credential helper, filter, submodule, replace-object, and network attempts;
- only fixed `status` and `diff` operations execute;
- output limits, timeout, process-tree termination, repository inode drift, and
  worktree mutation fail closed.

Sandbox cases:

- image digest is exact and `--pull=never` is enforced;
- no network, credentials, Docker socket, writable host workspace, extra mount,
  privilege escalation, device, capability, setuid, or host PID escape;
- read-only root, disposable scratch, resource limits, timeout, output bounds,
  and process-tree cleanup;
- workspace pre/post commitment remains equal.

Implementation-specific work for `@clodex/adapters-node`:

- build the native helper from
  `packages/clodex-adapters-node/native/clodex-openat2-helper.c` and
  `sha256.c` on each claimed Linux architecture; provision the resulting ELF
  mode/read-only ownership exactly as required by its pinned descriptor;
- verify helper execution is from the same hashed fd and the root is the exact
  held fd 4, including `/proc` unavailable/hidden, executable replacement,
  in-place mutation, link-count, owner/mode, set-id, ACL/file-capability,
  dynamic-loader/shared-library closure, truncated stdio, timeout, signal, and
  output-overflow cases;
- fault every create/mkdir/replace point before and after the first mutation,
  file `fsync`, rename/exchange, unlink, parent `fsync`, post-state capture, and
  stdout flush. Anything after the mutation boundary must be terminal
  `UNCERTAIN`, never a retryable pre-effect failure;
- stress directory rename/replacement and same-inode concurrent-write races.
  Do not claim strict atomic expected-state CAS if any namespace schedule can
  return success for a different parent/inode or can mutate outside the exact
  expected object before reporting uncertainty;
- test tree commitment bounds before allocation, deterministic ordering,
  invalid filenames, hard links, symlinks, bind mounts, special files,
  concurrent mutation, entry/depth/byte limits, and repeated scans through the
  same held directory descriptor;
- install and positively verify the exact AppArmor profile; prove names such as
  `unconfined`, complain/disabled profiles, missing profiles, or profile drift
  cannot satisfy production construction;
- pin and verify the exact seccomp bytes and exercise every denied syscall,
  including non-`AF_UNIX` sockets, mount/namespace, ptrace, BPF, keyring,
  io_uring, and process-vm access;
- adversarially replace the Docker/Podman socket and daemon between final
  verification and dispatch. Until the endpoint is independently pinned or
  otherwise protected, record this as a production blocker rather than an
  enforced guarantee;
- prove the public package exports no generic command, argv, environment,
  mount, host-path, or raw process-spawn authority;
- inject repository-local/system/global Git aliases, includes, hooks, filters,
  fsmonitor, pager, external diff, textconv, credential helpers, protocol
  handlers, replace objects, submodules, and malformed output. Confirm only the
  fixed direct Git operations run inside the sandbox and no secret/raw output
  crosses the digest/count result boundary;
- test container-name collisions across workspace/task/root/ticket scope,
  daemon/client death, orphan cleanup, cleanup failure, and ensure compensation
  never changes an uncertain effect into a claimed rollback;
- test image removal/tag drift, exact digest mismatch, implicit pull attempts,
  socket/credential mounts, writable workspace/root, AppArmor/seccomp absence,
  excess output, non-test exit codes, signals, timeout, and post-run workspace
  drift.

Preserve the implementation's explicit non-claims: Git/test use pre/post tree
commitments rather than a frozen snapshot; filesystem replace has no kernel
expected-inode/namespace-freeze CAS primitive; the Docker daemon endpoint is
path-selected rather than independently pinned; and loaded AppArmor enforcement
mode/profile bytes are external deployment evidence.

Deferred commands (Linux runner only):

```sh
make -C packages/clodex-adapters-node/native clean all
pnpm --filter @clodex/adapters-node test
pnpm --filter @clodex/adapters-node typecheck
pnpm exec biome check packages/clodex-adapters-node
```

The checked-in seccomp/AppArmor files are deployment inputs, not evidence that
the host loaded or enforced them. Record kernel, filesystem, container daemon,
LSM, helper/client/image digests, root device/inode, and fault-injection results
before changing any manifest status.

## Session P0-5 — production wiring and promotion

The unexecuted `@clodex/production` bootstrap must be tested as a negative
authority boundary, not merely as a validator library. It must return
`authority: null` and a bounded diagnostic for every absent, malformed, stale,
or mismatched input. Its published handle must never expose a raw runtime
adapter or caller-injected effect callback; execution must go only through the
fixed attested adapter authority and control-plane one-shot path.

Required integration evidence:

- production construction wires only verified registries and durable ports;
- every authority-bearing callback is absent while its P0 invariant is not
  enforced;
- gate-off startup, review, revoke, shutdown, reconnect, crash, and restart
  behavior remains fail closed;
- canonical approval UI is rendered from authority bytes, not model prose;
- packaged Electron smoke covers an isolated generated app through review,
  ticket, final fence, durable record, disposable effect, evidence, and restart;
- promotion assessment cannot enable a gate and rejects any missing, stale, or
  mismatched P0 evidence item.

Browser-composition cases for the current source tranche:

- `main.ts` must construct `SafeCodingProductionAuthorityService` with no
  trusted provider and retain `authority: null`/gate-off behavior;
- diagnostics and snapshots must not expose bootstrap input, registry ports,
  effect ports, bearer credentials, or the raw `ProductionAuthorityHandle`;
- a future trusted provider may be supplied only by deployment composition,
  never by renderer/model/plugin/request data;
- shutdown must stop new admissions and await active Safe Coding operations
  before automation, Artifact Bridge, MCP, agent-host, or persistence teardown;
- startup/provider/bootstrap failure must remain content-bounded, authority-null,
  and unable to mutate a feature gate.

Focused bootstrap cases:

- reject any registry head that is not independently protected, durable,
  linearizable, anti-rollback, multi-process, and synchronously fenced;
- require exact adapter/runner/effect manifests, one shared scope/trust epoch,
  exact membership for every published operation, and a synchronous final
  signer/head/trust fence on every authority use;
- require exact deployment, environment, platform, build, configuration,
  policy, evidence-policy, adapter-confinement, storage-adapter, promotion, and
  reviewed-decision bindings;
- run `recoverAll` before publication, reconcile terminal evidence, require a
  terminal/`DELIVERED` scan plus zero unresolved records, and serialize a final
  recovery admission; no recovery path may receive an effect port;
- revoke or drift deployment, head, registry, confinement attestation,
  promotion assessment, reviewed decision, recovery admission, clock, or
  control-plane storage after bootstrap and prove the synchronous final fence
  blocks the next authority use;
- require the adapter to consume the one-shot request-bound
  `ProductionEffectFinalAuthorityPort` after all adapter awaits inside its
  serialized dispatch boundary; missing, duplicate, caught-rejection, wrong
  request, or late consumption must fail closed and never authorize retry;
- prove closure/reconciliation callbacks remain available after authority is
  revoked, while no new prepare/permit/effect callback remains reachable;
- verify default-off and diagnostic paths never mutate feature gates.

Deferred package commands:

```sh
pnpm --filter @clodex/production typecheck
pnpm --dir apps/browser test -- \
  src/backend/services/safe-coding/production-authority.test.ts \
  src/backend/services/shutdown-coordinator.test.ts
pnpm --dir apps/browser typecheck
pnpm exec biome check packages/clodex-production
```

The independent testing model should add a focused adversarial suite for this
package and the provider-null browser wrapper before any non-null provider or
gate promotion is considered.

## Final repository verification

Execute only after all focused suites pass:

```sh
pnpm install --ignore-scripts
pnpm typecheck
pnpm test
pnpm check:boundaries
pnpm test:boundaries
pnpm check:provenance
pnpm security:secrets
pnpm exec biome check .
git diff --check
```

Then run the existing packaged/browser boundaries and add a dedicated Safe
Coding provider-null acceptance if none exists:

```sh
pnpm --dir apps/browser package:local
pnpm --dir apps/browser smoke:browser-egress:packaged
pnpm --dir apps/browser acceptance:mcp-packaged
pnpm --dir apps/browser smoke:agent-host
pnpm --dir apps/browser smoke:agent-host:fault
```

Also run platform-specific native helper/sandbox tests in CI runners matching
each claimed production platform. Record the exact tested commit, every command
and pass count, OS/kernel/runtime versions, container engine version, native
helper/image/profile digests, registry manifest digest, protected-head backend,
feature-gate snapshot, and the fact that no gate was promoted in the final
evidence bundle.
