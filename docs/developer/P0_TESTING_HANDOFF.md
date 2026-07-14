# P0 Zero-Trust testing handoff

- **Status:** `UNEXECUTED`
- **Date:** July 14, 2026
- **Owner:** next independent testing model
- **Rule:** the implementation session intentionally did not run tests,
  typechecks, linters, packaged smoke, or fault-injection commands after the
  P0 source changes. GitHub CI is green for commit `1ad58e67`, but that commit
  is the **pre-tranche baseline only**. Its results MUST NOT be attributed to
  the current source-only closure tranche.
- **Current claim:** `IMPLEMENTED_UNVERIFIED`. Nothing in this handoff upgrades
  a manifest row to `ENFORCED`.

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

The following paths are present in source but were intentionally not executed,
typechecked, linted, built, packaged, or smoke-tested in this tranche:

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
  context/effect digests, writes `STAGED` before `needsApproval` returns true or
  the host pending-approval record is published, and saves `CLAIMED` before
  returning authority. Exact affirmative evidence is hashed
  into the claimed record and re-read after persistence; expiry, or invalid
  evidence observed during claim, closes `EXPIRED`/`INVALIDATED`. Encrypted
  atomic writes fsync the temporary file and fsync the containing directory on
  platforms where that operation is supported (the current Windows path skips
  directory fsync). Ambiguous save outcomes are reconciled by exact read-back
  without converting a rejected save into authority issuance; an intended
  read-back remains durability-pending and must pass a later idempotent save
  barrier before another mutation or teardown reports success;
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
packaged Electron smoke remain explicit non-claims. MCP `STAGED` and `CLAIMED`
records survive ordinary restart while the encrypted store remains present,
and a claimed agent/tool-call identity is retained as a bounded fail-closed
replay tombstone. This does not reconstruct AgentStore `pendingApprovals` or
guarantee a resumable approval UI/normal continuation after restart. It also
does **not** create a separate durable `APPROVED` state: affirmative evidence
remains canonical, mutable AgentStore history. Nor does `CLAIMED` prove that
the in-memory final authority was consumed, that IPC/network dispatch occurred,
or that the external effect committed. The local revision is stored in the
same encrypted file and has no independently protected monotonic or existence
anchor, so hostile rollback, deletion, or reset to a fresh empty store remains
outside the claim. Expiry uses the wall clock rather than a trusted monotonic
clock, so clock rollback can extend `STAGED` validity. Windows lacks the
containing-directory fsync used on supported platforms, so power-loss
durability there is not claimed. Tombstones are retained up to the bounded
capacity and capacity exhaustion fails closed rather than pruning replay
history. The broker also does not provide cross-process writer serialization
or a transaction shared with AgentStore or the external MCP effect; the
affirmative-response lifecycle and durable claim are not one cross-store atomic
operation.

Source map for the testing model:

- [Automation WAL](../../apps/browser/src/backend/services/automations/dispatch-wal.ts)
  and [Automation service](../../apps/browser/src/backend/services/automations/index.ts);
- [MCP gateway](../../apps/browser/src/backend/services/mcp/trusted-dispatch-gateway.ts),
  [approval broker](../../apps/browser/src/backend/services/mcp/approval-broker.ts),
  [registry service](../../apps/browser/src/backend/services/mcp/index.ts),
  [registry agent tools](../../apps/browser/src/backend/services/mcp/tools.ts),
  and [Clodex-cloud tools](../../apps/browser/src/backend/services/toolbox/services/clodex-mcp/index.ts);
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
   approval-context digest, and canonical arguments match a single affirmative
   AgentStore part.
   Prove `STAGED` is durable before `needsApproval` returns true and before the
   host pending-approval record is published; exact duplicate staging is
   idempotent while changed bindings fail closed; affirmative evidence is
   hashed and rechecked after persistence; and `CLAIMED` is durably saved before
   authority return. Restart must preserve claimed replay tombstones, expire
   stale staged records, reject duplicate/reused/denied/ambiguous/malformed
   evidence, and fail closed at the bounded capacity. Fault save-before-apply,
   apply-then-throw, read-back mismatch, corrupt/truncated data, unavailable
   encryption, and teardown with queued mutations; prove every rejected save
   rejects the claim even when read-back contains the intended tombstone.
   Prove that the intended tombstone remains burned in memory and that the next
   mutation/flush/teardown retries the same persistence barrier before success.
   Separately cover deleted/reset stores, wall-clock rollback, Windows' missing
   directory-fsync guarantee, and restart without reconstructed AgentStore
   pending-approval UI. Descriptor/runtime/Guardian revision drift must still
   fail at the last synchronous fence. Report
   `CLAIMED` only as a replay tombstone, not proof of final consumption,
   dispatch, or effect; separately demonstrate that rollback of the same file
   is not protected without an independent anchor. If MCP resource/prompt agent
   tools remain disabled, prove resource/prompt access is settings-only and
   cannot become an agent effect path.
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
  src/backend/services/mcp/index.test.ts \
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
