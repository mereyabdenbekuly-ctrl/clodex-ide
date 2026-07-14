# CLODEx Security Guarantee Manifest

- **Version:** 0.13
- **Date:** July 14, 2026
- **Rule:** only ENFORCED claims may be described as runtime guarantees.
- **Source specification:** ../INTENT_CONTRACT_SPEC.md
- **Implementation plan:** ../developer/ZERO_TRUST_EXECUTION_5_SESSION_PLAN.md
- **Current working-tree verification:** `UNEXECUTED`. GitHub CI is green at
  commit `1ad58e67`, but that commit is the pre-tranche baseline only. Existing
  `ENFORCED` and `TESTED` rows are not a re-attestation of changed code paths in
  the later P0 working tree. Any changed path must be treated as
  `IMPLEMENTED_UNVERIFIED` until the independent testing handoff passes.

## Status values

| Status         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| ENFORCED       | runtime boundary exists and required tests pass                                              |
| TESTED         | a schema or isolated component property is tested, but complete mediation is not established |
| IMPLEMENTED_UNVERIFIED | implementation exists, but the current code tranche was intentionally not tested or validated |
| IN_PROGRESS    | code is being integrated in the current session                                              |
| SPEC_ONLY      | normative design exists without runtime enforcement                                          |
| BLOCKED        | a confirmed production gap prevents the claim                                                |
| NOT_APPLICABLE | intentionally outside the active profile                                                     |

## Guarantee inventory

| ID                    | Claim                                                                                                | Scope                            | Status    | Enforcement/evidence                                                                                                                                                            | Limitations / blocker                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-CI-001            | Pages sources are part of mandatory browser typecheck                                                | browser build                    | ENFORCED  | browser `typecheck` runs `tsc -p tsconfig.pages.json --noEmit`; root CI runs `pnpm typecheck`                                                                                   | Does not make shared protocol or Pages compatibility code a production authority boundary                                                                 |
| INV-PROTO-001         | Artifact Bridge v1 request envelopes are rejected                                                    | shared protocol                  | TESTED    | v2 Zod schemas and negative tests in `src/shared/artifact-bridge.test.ts`                                                                                                       | Does not independently establish production session authenticity                                                                                          |
| INV-PROTO-002         | Port requests require a UUID session and positive navigation epoch                                   | shared protocol                  | TESTED    | strict session-binding schemas and shared protocol tests                                                                                                                        | Schema evidence; runtime binding is covered by INV-SESSION-001                                                                                            |
| INV-PROTO-003         | Port responses must echo the active session and navigation epoch                                     | preload port client              | TESTED    | strict response schema and `artifact-bridge-port-client.test.ts`                                                                                                                | Isolated component evidence only                                                                                                                          |
| INV-ORIGIN-001        | An isolated app host is cryptographically bound to decoded app identity                              | app protocol                     | ENFORCED  | full-SHA-256 Base32 origin helper, strict production parser, canonical path validation, and adversarial tests                                                                   | No packaged Electron smoke is claimed                                                                                                                     |
| INV-PORT-001          | App JavaScript receives only a frozen request proxy, not the port/session binding                    | isolated preload                 | ENFORCED  | context-bridge proxy, private preload port client, production frame broker, and focused tests                                                                                   | Scope is transport isolation, not universal capability authorization                                                                                      |
| INV-PAGES-001         | Shared v2 schemas and Pages compatibility code are not the production Artifact Bridge path           | Pages/shared protocol            | TESTED    | shared protocol tests, mandatory Pages typecheck, Pages marker-drop compatibility code, and production isolated preload/broker                                                  | No Pages Artifact Bridge RPC or handler; no dedicated renderer E2E for the marker drop and no packaged smoke                                              |
| INV-GATE-001          | Disabled Artifact Bridge cannot grant or execute capability                                          | Artifact Bridge                  | ENFORCED  | service feature-gate assertions, post-resolver gate revalidation, and gate-off regressions                                                                                      | Existing feature-gate defaults are unchanged                                                                                                              |
| INV-APP-001           | App identity must resolve and remain exact before a grant is saved                                   | Artifact Bridge                  | ENFORCED  | canonical review consumption plus post-resolver identity, manifest, policy, feature, and write-gate revalidation                                                                | Enforced only for supported local agent apps; plugin/package resolution fails closed                                                                      |
| INV-RESOLVER-001      | Production resolver returns a verified whole-tree identity for local agent apps                      | identity resolver                | ENFORCED  | bounded canonical resolver, whole-tree hashes, exact-byte asset snapshots, production main wiring, and resolver tests                                                           | Plugin and package contexts return `null`; no package/plugin authority and no packaged Electron smoke                                                     |
| INV-SESSION-001       | Session is host-issued and bound to document slot, revision, origin, identity, and epoch             | document transport               | ENFORCED  | production frame broker, backend host sessions, revision registry, isolated preload, ordered teardown, and focused tests                                                        | Does not establish generalized final effect fencing                                                                                                       |
| INV-NAV-001           | Navigation cannot inherit a prior document session, response, or content binding                     | document transport               | ENFORCED  | exact navigation tickets, synchronous navigation revoke, port-close suspension, reconnect-grace nonce preservation, exact trusted-token rotation, and broker tests              | Content unbind occurs on navigation/revoke/grace expiry/destroy/teardown; no packaged smoke                                                               |
| INV-CONTENT-001       | Authority-bearing app bytes are served from the snapshot that produced `assetHash`                   | app protocol/content binding     | ENFORCED  | `resolveAsset`, post-resolver binding recheck, exact snapshot responses, provisional/trusted nonce lifecycle, and 97/97 tests                                                   | Local agent apps only; legacy/plugin live-file rendering carries no Artifact Bridge authority                                                             |
| INV-EGRESS-001        | Isolated generated apps cannot use ambient external network or popup/OS-protocol egress              | browser session/navigation       | ENFORCED  | CSP/bootstrap, session request guard, frame-navigation guard, fail-closed window-open helper, and nine popup tests including source-inspection failure                          | Same-app and explicitly allowed local data/blob assets remain available; no packaged Electron smoke                                                       |
| INV-REVIEW-001        | Canonical approval binds exact app identity, manifest, policy, and selected authority                | approval UI/registry             | ENFORCED  | canonical review schemas, one-shot registry, manifest-derived UI model, submit revalidation, and integration tests                                                              | Current read, ask-agent, and automation profile only; write and ephemeral-gate promotion are not claimed                                                  |
| INV-REVIEW-002        | Reviewer authority cannot be spoofed by a renderer-selected caller string                            | trusted UI transport             | ENFORCED  | dedicated `ui-main` channel, exact current WebContents/main-frame admission, generic-role exclusion, and transport tests                                                        | No packaged Electron smoke is claimed                                                                                                                     |
| INV-READ-FENCE-001    | Suspended or replaced host session cannot start direct read-only MCP dispatch after descriptor await | Artifact Bridge current read     | IMPLEMENTED_UNVERIFIED | the previously tested supervisor-side callback remains, while the changed registry path now also enters the unexecuted central commitment/final-fence gateway                   | Current MCP source changed after green baseline `1ad58e67`; supported local-agent profile only; no packaged Electron smoke                                 |
| INV-REV-001           | Revocation before final dispatch prevents every modeled effect                                       | current Artifact Bridge adapters | IMPLEMENTED_UNVERIFIED | historical grant/session/adapter fences remain in source and new cloud/MCP/automation fences narrow additional dispatch paths                                                     | Current adapter, WAL, MCP, and ownership paths changed after the green baseline and were intentionally not revalidated                                     |
| INV-DESC-001          | Reviewed MCP descriptor matches the current local dispatch snapshot immediately before IPC dispatch  | Artifact Bridge MCP effects      | IMPLEMENTED_UNVERIFIED | changed source recomputes exact descriptor, authority, classification, runtime, Guardian revision, argument, and policy commitments at final dispatch                              | Central MCP integration and approval authority are unexecuted; remote MCP still does not accept a descriptor digest, so remote semantics are not claimed   |
| INV-RETRY-001         | Result processing failure cannot replay a committed effect                                           | modeled browser effects          | IMPLEMENTED_UNVERIFIED | universal Artifact Bridge WAL covers direct ask-agent, automation, reviewed/ordinary async MCP; AutomationService adds one-shot manual/timer/resume/startup occurrence closure and never replays `DISPATCHING` | Current changes were intentionally not tested; external-provider atomicity and protected WAL anti-rollback remain outside the claim                        |
| INV-WAL-001           | Every modeled irreversible browser effect has a durable preparation/dispatch/terminal record         | effect ledgers                   | IMPLEMENTED_UNVERIFIED | encrypted Artifact Bridge WAL classes include `agent-ask`, `automation`, and `mcp-read-async`; AutomationService adds `PREPARED → DISPATCHING → SUCCEEDED/FAILED_PRE_EFFECT/UNCERTAIN` for every scheduled/manual entry path | Current changes were intentionally not tested; synchronous read-MCP external semantics and effects outside modeled paths are not universally covered      |
| INV-ATOMIC-001        | Authorization remains exact through the final dispatch boundary for every effect                     | effect adapters                  | IMPLEMENTED_UNVERIFIED | final commitments bind ask model/adapter inputs, complete automation definition/composite state, cloud ownership state, and MCP descriptor/runtime state; partial composite failure closes `UNCERTAIN` | No transaction is atomic across the MCP broker JSON store, Agent SQLite, final dispatch, or an external provider/target; current implementation and prepared tests are unexecuted |
| INV-TICKET-001        | Execution Ticket is short-lived, exact-action, and single-use                                        | independent control-plane slice  | TESTED    | closed ticket validation, Guardian issuance/revalidation, kernel registration and synchronous one-shot `COMMIT_PERMIT`, plus focused contracts/Guardian/kernel/runtime tests    | Recording-only and memory-only; runner registry digest is bound, but concrete runner membership is not verified                                           |
| INV-REF-CLOSURE-001   | The recording-only runtime owns PREPARE, final authority, permit, and one post-permit execute        | Session 5 reference runtime      | TESTED    | closed prepared-effect/permit shapes; accessors are not evaluated; prototype/symbol/non-enumerable/extra permit drift closes `UNCERTAIN` before execute                         | Non-durable reference only; PREPARE is trusted inert behavior, with no host effect, crash-safe transaction, cross-process commit, or production promotion |
| INV-APPROVAL-REF-001  | Canonical approval binds only machine-readable authority and current commitments                     | independent approval reference   | TESTED    | canonical render model/artifact, DSSE verification, trusted reviewer snapshot, final trust/commitment fences, and one-shot replay tests                                         | No production UI, key custody, signing service, or durable replay store                                                                                   |
| INV-LEDGER-REF-001    | Ticket, effect attempt, evidence expectation, and evidence outbox share one CAS record               | independent ledger reference     | TESTED    | closed transitions, reachable revisions, global identity reservations, verified admission receipts, recovery tests, and POSIX snapshot adapter                                  | Not atomically linked to kernel/effect/evidence systems; no protected anti-rollback head                                                                  |
| INV-EVIDENCE-REF-001  | Signed evidence chain detects bounded replay, fork, rollback, and trust drift                        | independent evidence reference   | TESTED    | executor/observer signatures, trust epoch/registry binding, final synchronous signer-set fence, idempotency registry, chain/checkpoint tests                                    | Default ledger/checkpoint adapters are memory-only; no atomic protected checkpoint/trust transaction                                                      |
| INV-CONTROL-PLANE-001 | Ticket reservation, permit consumption, effect attempt, ledger projection, and evidence outbox advance in one local CAS | independent control plane | IMPLEMENTED_UNVERIFIED | `@clodex/control-plane` and POSIX adapter implement one closed record, one-shot in-flight transition, terminal outbox, conservative restart recovery, and no effect replay | 35 prepared scenarios are unexecuted; external effect and independently stored trust/evidence systems are not part of the local transaction; no protected head |
| INV-REGISTRY-001      | Adapter, runner, and effect membership is resolved only from an exact signed workspace/task/root-scoped manifest and monotonic head | independent registry | IMPLEMENTED_UNVERIFIED | `@clodex/registry` implements canonical signed manifests, exact membership, immutable signer snapshot, final synchronous trust/time/head fences, and monotonic predecessor CAS | 18 prepared scenarios are unexecuted; production crypto/key custody/trust registry and an independently protected linearizable head are absent            |
| INV-ADAPTER-SCOPE-001 | Reference adapters reject cross-workspace/task confused-deputy use before any capability port        | independent adapter reference    | TESTED    | immutable workspace/task/root scope, ticket-audience fence, scope propagation, mixed-scope registry rejection, and accessor/adversarial tests                                   | Signed registry and Linux implementation source now exist but are separately unverified and not production-deployed                                       |
| INV-OS-ADAPTER-001    | Fixed filesystem/Git/test capabilities are confined by descriptor-relative resolution and a digest-pinned OS sandbox | Linux Node adapters | IMPLEMENTED_UNVERIFIED | `@clodex/adapters-node` adds a pinned ELF/openat2 helper, fixed create/mkdir/replace, deterministic tree commitments, digest-pinned read-only/networkless Git and test containers, limits, seccomp and AppArmor inputs | Native helper/container/LSM code was not compiled or tested; strict namespace CAS, daemon-socket protection, deployment profile enforcement, and production wiring are not yet proven |
| INV-PROMOTION-001     | Promotion assessment cannot itself enable a feature gate                                             | independent promotion reference  | TESTED    | exact environment/build/config/policy/evidence bindings, trusted clock/hash/final fence, and fail-closed eligibility tests                                                      | Eligibility is not production promotion; reviewed release control remains external                                                                        |
| INV-PRODUCTION-BOOTSTRAP-001 | Production execution authority is absent unless registry, protected head, confinement, recovery, promotion, and reviewed gate evidence all pass | production composition | IMPLEMENTED_UNVERIFIED | `@clodex/production` returns `authority: null` on any gap; browser `SafeCodingProductionAuthorityService` is wired from `main.ts` with `provider: null`, exposes only fixed callbacks, and stops admission/drains before dependent teardown | Package/browser composition are untested; real protected head, key custody, deployment attestation, recovery reconciler, trusted non-null provider, reviewed decision, and packaged smoke are external requirements |
| INV-SHELL-001         | Production shell dispatch requires a brokered, auditable object capability                           | browser shell tools              | IMPLEMENTED_UNVERIFIED | platform integration constructs `ShellCapabilityBroker` with a dedicated audit path; PTY creation and command/stdin/kill/poll bind exact action state and consume one-shot authority immediately before the shell effect | Source-only wiring was not tested; OS process confinement, audit durability/anti-rollback, denial races, and packaged behavior are not established         |
| INV-JS-SANDBOX-001    | Agent JavaScript cannot gain host filesystem authority or execute remotely fetched modules           | browser JavaScript sandbox       | IMPLEMENTED_UNVERIFIED | remote/data module import fails closed; `fs`, `fsPromises`, `require('fs')`, and mount-to-filesystem authority are removed from the worker                                      | Source was not tested against aliases, caches, alternate loaders, process escapes, or packaged Electron behavior                                           |
| INV-OPENMANUS-001     | OpenManus receives no raw secret, host path, endpoint, argv/environment, or ambient host process authority | OpenManus agent host          | IMPLEMENTED_UNVERIFIED | protocol v4 removes ambient authority and the old host-spawn path; execution requires a trusted `OpenManusOsConfinedAdapter`, which production does not install                | The brokered adapter and target-OS confinement do not yet exist as verified production evidence; OpenManus is intentionally disabled                       |
| INV-MOUNT-001         | Missing or ambient workspace state cannot mint delegated write authority                             | Toolbox mounts / Swarm           | IMPLEMENTED_UNVERIFIED | exact per-agent permissions are exposed; an attached mount with absent metadata defaults read-only; guessed cross-agent prefixes deny; Swarm no longer auto-mounts ambient workspaces | Source was not tested; this is narrowing only, not a complete deterministic Guardian subset evaluator or aggregate-budget system                           |
| INV-DELEG-001         | Child authority is a deterministic subset of parent authority                                        | multi-agent                      | SPEC_ONLY | planned Guardian subset evaluator                                                                                                                                               | Current capabilities are coarse and aggregate budgets are absent                                                                                          |
| INV-EFFECT-001        | Every modeled effect reaches one durable terminal closure state                                      | effect adapters                  | BLOCKED   | tested isolated ledger/evidence/runtime references plus unverified universal Artifact Bridge WAL and atomic local control-plane implementations narrow the gap | External effects, independently stored trust/evidence/checkpoints, protected heads, and packaged production wiring still do not share one atomic authority/effect transaction |
| INV-MEM-001           | Memory cannot mint authority                                                                         | memory/control plane             | SPEC_ONLY | Intent Contract authority model                                                                                                                                                 | Complete semantic lineage and universal runtime mediation are not claimed                                                                                 |
| INV-SANDBOX-001       | Test execution has no host filesystem, credential, or network escape                                 | sandbox/test adapter             | BLOCKED   | reference profile plus unverified `@clodex/adapters-node` implementation require digest-only images, `--pull=never`, no network/credentials, read-only workspace/root, disposable scratch, dropped capabilities, LSM/seccomp and limits | No target-platform execution evidence exists; daemon endpoint protection, loaded LSM state, container escape testing, and packaged production wiring remain blocking |
| INV-MCP-001           | Every agent-reachable MCP tool call is mediated by exact descriptor/runtime commitment, approval authority where required, Guardian policy, and a final fence | MCP tool dispatch | IMPLEMENTED_UNVERIFIED | registry tools and the allowlisted read-only Clodex-cloud tool use the central trusted-dispatch gateway; effectful cloud tools remain unregistered; Toolbox's encrypted approval store persists exact bounded identity/descriptor/context/effect/decision digests and the lifecycle `STAGED → RESPONSE_RECORDED → APPROVED → CLAIMED`, with `DENIED`, `EXPIRED`, and `INVALIDATED` terminal closure; `claim()` accepts only `APPROVED`, retains replay tombstones, and reconciles ambiguous saves by exact read-back without treating a rejected save as authority success | Source was not tested; `APPROVED` does not prove dispatch and `CLAIMED` does not prove final-authority consumption, IPC/network send, or effect commit; no cross-process/cross-store atomicity exists; deletion/reset, wall-clock rollback, Windows directory-fsync absence, SQLite power-loss durability, and the same-file revision's lack of protected anti-rollback/existence anchors remain outside the claim; resource/prompt agent tools remain disabled/settings-only |
| INV-APPROVAL-RESP-001 | A broker-managed MCP approval on a persistent agent cannot authorize continuation before its exact decision is durably bound in the broker and the exact AgentStore message is strictly committed | browser persistent-agent MCP approval continuation | IMPLEMENTED_UNVERIFIED | the common `BaseAgent` ingress snapshots exactly one `approval-requested` part, waits for the originating step to settle, prepares the durable broker decision, performs an exact state mutation, and enters a strict per-agent serialized Agent SQLite save that binds the enqueue-time full message and reads back exact ID/role/parts/metadata inside the transaction before broker commit and continuation; `RESPONSE_RECORDED` is non-authorizing; new-message/stop/flush/system cancellation invalidates open broker records, a per-agent Toolbox epoch rejects/cleans late stale staging and pending-index publication, and rejected sweep saves retain dirty rows behind a retry barrier | Source was not tested; broker JSON and Agent SQLite do not share a transaction; rollback can conservatively leave a sticky admission barrier; ordinary restart neither reconstructs ephemeral `pendingApprovals` UI nor automatically continues the turn; coordinated rollback/deletion of both stores and cross-process writers remain outside the claim |
| INV-CLOUD-001         | Stale local owner cannot execute after cloud handoff                                                 | execution lanes                  | IMPLEMENTED_UNVERIFIED | router/browser-executor omission defaults deny; final checks cover local/remote turn, host model/tool, wrapped local tool, and intended Swarm model/tool/history dispatches        | Source-only changes were not tested across lease races, awaits, Swarm direct paths, restart, or packaged execution                                          |

## Session 1 evidence

- CI path: [browser typecheck command](../../apps/browser/package.json) and
  [root CI invocation](../../.github/workflows/monorepo-ci.yml).
- Protocol path: [v2 envelope schema](../../apps/browser/src/shared/artifact-bridge.ts)
  and [negative schema tests](../../apps/browser/src/shared/artifact-bridge.test.ts).
- Pages/build path:
  [typed Pages contract](../../apps/browser/src/shared/karton-contracts/pages-api/index.ts),
  [generic iframe compatibility code](../../apps/browser/src/pages/lib/iframe-app-bridge.ts),
  [Pages TypeScript project](../../apps/browser/tsconfig.pages.json), and
  [browser scripts](../../apps/browser/package.json). The current tree has no
  Pages Artifact Bridge RPC or handler. Shared v2 schema and Pages compilation
  MUST NOT be cited as the production generated-app bridge.
- Session 1 preserved the then-current null resolver and unchanged feature-gate
  defaults. The resolver was replaced only by the scoped local-agent resolver
  after Session 3 review and tests.
- Verification on July 13, 2026 recorded full browser, Pages, and backend
  typechecks plus focused shared-protocol and gate tests. Session 3 revalidated
  the current shared protocol and production transport in its broader focused
  suite; no historical Pages RPC test count is claimed.

## Session 2 evidence

- Origin boundary: [isolated origin helper](../../apps/browser/src/shared/isolated-app-origin.ts),
  [pure adversarial tests](../../apps/browser/src/shared/isolated-app-origin.test.ts),
  [preview URL construction](../../apps/browser/src/pages/routes/preview/$appId.tsx),
  and [strict app protocol parser](../../apps/browser/src/backend/services/app-protocol.ts).
- App-facing boundary: [isolated preload API](../../apps/browser/src/web-content-preload/artifact-bridge.ts),
  [private port client](../../apps/browser/src/web-content-preload/artifact-bridge-port-client.ts),
  and [port-client tests](../../apps/browser/src/web-content-preload/artifact-bridge-port-client.test.ts).
- Trusted component boundary: [main-process frame broker](../../apps/browser/src/backend/services/artifact-bridge/frame-broker.ts),
  [broker tests](../../apps/browser/src/backend/services/artifact-bridge/frame-broker.test.ts),
  [host-session service](../../apps/browser/src/backend/services/artifact-bridge/index.ts),
  and [host-session tests](../../apps/browser/src/backend/services/artifact-bridge/host-session.test.ts).
- Production wiring: [main construction](../../apps/browser/src/backend/main.ts)
  starts the broker after the Artifact Bridge service, while the
  [shutdown coordinator](../../apps/browser/src/backend/services/shutdown-coordinator.ts)
  tears down the broker before the service.
- Verification on July 14, 2026: 111/111 focused tests; independent Pages,
  backend, and web-content-preload typechecks; complete browser typecheck;
  targeted Biome and Prettier; bundled-asset validation; and
  `git diff --check` all pass.
- Session 2 enforcement remains the document-bound transport foundation. Its
  completion did not claim resolver, reviewer, grant, effect, write, or
  packaged Electron guarantees.

## Session 3 evidence

- Agent-only identity: [bounded resolver](../../apps/browser/src/backend/services/generated-app-library/identity-resolver.ts),
  [resolver adversarial tests](../../apps/browser/src/backend/services/generated-app-library/identity-resolver.test.ts),
  and [production main wiring](../../apps/browser/src/backend/main.ts).
- Exact bytes and revision lifecycle:
  [app protocol](../../apps/browser/src/backend/services/app-protocol.ts),
  [revision registry](../../apps/browser/src/backend/services/app-protocol-revision-binding.ts),
  [security policy](../../apps/browser/src/backend/services/app-protocol-security.ts),
  [frame broker](../../apps/browser/src/backend/services/artifact-bridge/frame-broker.ts),
  [exact-serving tests](../../apps/browser/src/backend/services/app-protocol.test.ts),
  [revision tests](../../apps/browser/src/backend/services/app-protocol-revision-binding.test.ts),
  and [broker tests](../../apps/browser/src/backend/services/artifact-bridge/frame-broker.test.ts).
- Trusted review:
  [dedicated UI transport](../../apps/browser/src/backend/services/trusted-ui-karton-transport.ts),
  [transport tests](../../apps/browser/src/backend/services/trusted-ui-karton-transport.test.ts),
  [review registry](../../apps/browser/src/backend/services/artifact-bridge/grant-review-registry.ts),
  [review integration tests](../../apps/browser/src/backend/services/artifact-bridge/grant-review-integration.test.ts),
  [canonical UI model](../../apps/browser/src/ui/screens/generated-apps/generated-app-capabilities-dialog-model.ts),
  and [UI model tests](../../apps/browser/src/ui/screens/generated-apps/generated-app-capabilities-dialog-model.test.ts).
- Egress and suspension:
  [isolated request/navigation controls](../../apps/browser/src/backend/services/app-protocol-security.ts),
  [window-open policy](../../apps/browser/src/backend/services/isolated-app-window-open-policy.ts),
  [window-open tests](../../apps/browser/src/backend/services/isolated-app-window-open-policy.test.ts),
  [host-session tests](../../apps/browser/src/backend/services/artifact-bridge/host-session.test.ts),
  and broker revision-lifecycle tests.
- Verification on July 14, 2026: **252/252 focused tests across 18 files**;
  **97/97 exact-byte/revision tests**; independent backend, Pages, and
  web-content-preload TypeScript checks; full browser typecheck; targeted Biome;
  and `git diff --check` all pass.
- Claimed scope: local agent apps and the current read, ask-agent, and automation
  review profile. A packaged Electron smoke run is not claimed. Plugin/package
  authority remains fail-closed. Write and ephemeral-grant feature-gate defaults
  were not promoted.
- At Session 3 completion, explicitly deferred to Session 4: universal final
  effect fencing, full
  descriptor/runtime commitment, durable WAL, retry closure, and terminal
  effect attestation.

## Session 4 checkpoint evidence

- Grant and revoke boundary:
  [Artifact Bridge service](../../apps/browser/src/backend/services/artifact-bridge/index.ts)
  uses a per-grant ID, monotonic revision, shared revoke fence, exact
  post-resolver revalidation, and complete derived-state invalidation.
  [Session 4 adversarial tests](../../apps/browser/src/backend/services/artifact-bridge/session4-adversarial.test.ts)
  cover paused resolver, revoke, identical replacement, stale G1 tokens, and
  MCP endpoint/descriptor/runtime drift.
- Durable grant mutation boundary: persistent save and revoke operations are
  serialized and staged with `pendingMutations`. A crash or ambiguous write
  cannot publish the grant in memory, and startup reconciliation removes any
  authority covered by an incomplete mutation marker. Audit actions are named
  `grant.save-prepared` and `grant.revoke-prepared`; they attest review and
  preparation, not cross-file atomic commit of the separate audit and grant
  stores.
- Runtime revoke fences are applied before persistence. A failed manual or
  automatic tombstone remains nondispatchable, is surfaced to its caller, and
  is retried during orderly teardown rather than silently restoring authority.
  Runtime grant IDs/revisions do not prove durable anti-rollback of an older
  encrypted grant-store snapshot.
- Production audit boundary:
  [audit ledger](../../apps/browser/src/backend/services/artifact-bridge/audit-ledger.ts)
  is wired in `main.ts` as both recorder and reader and is integrity-checked
  before Artifact Bridge creation. Corruption is a sticky failure for the
  process lifetime. Ledger append and atomic persisted-data writes fsync the
  file and containing directory where supported. The local hash chain has no
  independently protected head, so full-history replacement or suffix
  truncation resistance is not claimed.
- MCP final boundary:
  [registry](../../apps/browser/src/backend/services/mcp/index.ts) forwards the
  callback through internal awaits, while
  [supervisor](../../apps/browser/src/backend/mcp-host/supervisor.ts) executes it
  after readiness and immediately before IPC dispatch. Registry and supervisor
  tests cover paused readiness, restart, revoke, and callback non-forwarding to
  the utility-process protocol.
- MCP lifecycle identity: host protocol v6 carries a per-connection
  `connectionId`; host, supervisor, and registry reject stale close,
  `listChanged`, catalog, and out-of-order connect results, including A→B→A
  replacement races. MCP commitments also bind configuration revision and the
  sensitive-enforcement profile.
- Exact commitments:
  [canonical JSON](../../apps/browser/src/backend/services/artifact-bridge/canonical-json.ts)
  rejects circular, BigInt, undefined, sparse, non-finite, accessor, and
  non-plain values without lossy coercion. The
  [effect commitment](../../apps/browser/src/backend/services/artifact-bridge/effect-commitment.ts)
  binds the complete supported MCP action and is recomputed at final dispatch.
- Durable reviewed-MCP closure:
  [effect WAL](../../apps/browser/src/backend/services/artifact-bridge/effect-wal.ts)
  persists encrypted one-shot state and recovers interrupted `DISPATCHING`
  records as `UNCERTAIN`.
  [integration tests](../../apps/browser/src/backend/services/artifact-bridge/effect-wal-integration.test.ts)
  prove exactly one adapter call for oversized/BigInt result failure, ambiguous
  adapter failure, revoke, and host close.
- Async boundary:
  [async final-dispatch tests](../../apps/browser/src/backend/services/artifact-bridge/async-operation-final-dispatch.test.ts)
  cover MCP, automation, and sensitive MCP before/after-fence timeout,
  cancellation, ignored abort, revoke, and retained `uncertain` evidence.
- Automation adapter:
  [automation service](../../apps/browser/src/backend/services/automations/index.ts)
  requires every adapter dispatch to consume a synchronous callback inside the
  serialized section immediately before the first effect, rechecks the feature
  gate there for manual, startup, and scheduled paths, supports a single-attempt
  Artifact Bridge mode, and can propagate failure after persisting run status.
  Agent creation invokes that callback after model lookup and before the
  agent-store upsert; generated-app results expose only `{ ok: true }` and all
  result/error paths are normalized and redacted.
- Final-race coverage rechecks proposal/ticket expiry plus async and sensitive
  kill switches at the final dispatch fence, not only when preparation starts.
- Approval-audit failure is fail-closed: write/sensitive tokens are not exposed
  before the mandatory audit succeeds. A write-ambiguous audit error burns the
  WAL ticket as `FAILED_PRE_EFFECT` (or `UNCERTAIN` if closure also fails),
  concurrent approvers share the same failure, and a fresh proposal/review is
  required rather than retrying the ambiguous append.
- Verification on July 14, 2026: complete browser suite **2215/2215 tests across
  269 files**; **97/97 exact-byte/revision tests**; MCP runtime **27/27**;
  targeted agent-core create-handler **8/8**; browser, MCP runtime, and
  agent-core typechecks; MCP host build; targeted Biome; **98** bundled assets;
  and `git diff --check` pass. The approval-audit/WAL regression subset passes
  **94/94 tests across 4 files**.
- **P0 browser closure source — intentionally unexecuted:** universal Artifact
  Bridge WAL/replay closure, exact automation/model commitments, and composite
  uncertainty are supplemented by a durable AutomationService WAL for manual,
  timer, system-resume, and startup-reconciliation occurrences. Recovery burns
  `PREPARED` as `FAILED_PRE_EFFECT` and `DISPATCHING` as `UNCERTAIN`; no startup
  path replays an occurrence.
- The same source tranche adds the central MCP commitment/final-fence gateway
  and an encrypted durable approval broker. The broker persists only bounded
  identifiers and exact digests, writes `STAGED` before `needsApproval` returns
  true or the host pending-approval record is published, and then records an
  explicit response through `STAGED → RESPONSE_RECORDED → APPROVED` or
  `STAGED → RESPONSE_RECORDED → DENIED`. `RESPONSE_RECORDED` never authorizes
  execution. The common approval ingress snapshots one exact pending part,
  waits for the originating step to settle, performs the broker prepare, exact
  AgentStore mutation, and a strict serialized Agent SQLite save of the full
  affected message with enqueue-time/fresh-store binding plus in-transaction
  ID/role/parts/metadata read-back. Broker commit and continuation follow only
  after that barrier. Automatic new-message, stop, queue-flush, and system
  cancellation closes open records as `INVALIDATED`, not as broker `DENIED`,
  and a per-agent host epoch rejects/cleans late stale MCP staging plus generic
  pending-index publication; failed sweep saves retain their dirty rows for a
  fail-closed retry. User-message, destructive history, and recovered-replay
  lifecycles are serialized per agent. Priority cancellation preempts the
  current step synchronously before queued durable cleanup; replace/revert stay
  fenced across host undo and synchronous history mutation, while replay uses a
  session generation and bounded closed-execution tombstones. Pending priority
  work rejects and tombstones replay ingress before admission. At replay
  `beginStep`, synchronous AgentStore subscriber preemption is generation-fenced
  before session identity publication, and a subscriber throw still burns the
  bounded session-local tombstone in `finally`; no late chunk may reopen that
  execution.
  `claim()` accepts only `APPROVED`, saves `CLAIMED` before returning
  one-shot authority, rechecks the exact decision evidence after persistence,
  retains replay tombstones, and closes expiry or invalid evidence as
  `EXPIRED`/`INVALIDATED`. Ambiguous broker writes are reconciled by exact
  read-back, but every rejected save still rejects authority issuance; an
  intended read-back remains durability-pending for an idempotent retry, while
  read-back divergence faults the broker. This tranche also adds
  ShellCapabilityBroker production wiring;
  removal of remote module import and ambient filesystem authority from the JS
  sandbox; fail-closed OpenManus without an OS-confined brokered adapter;
  cloud-ownership checks at model/tool/turn/local dispatch boundaries; exact
  per-agent mount permission lookup; and removal of Swarm ambient workspace
  auto-mounting. `INV-MCP-001` is `IMPLEMENTED_UNVERIFIED`: source now wires
  the durable broker for registry tools and the allowlisted read-only
  Clodex-cloud path; effectful cloud tools remain unregistered. Executable
  evidence must still prove every approval path stages before `needsApproval`
  returns true and before the host pending-approval record is published,
  persists the exact response in both ordered durability barriers before
  continuation, claims only exact committed affirmative evidence, and cannot
  reuse a terminal identity after restart. `APPROVED` is not evidence of
  dispatch. `CLAIMED` is intentionally only a conservative replay tombstone;
  it is not evidence of final-fence consumption, dispatch, or external effect.
- None of those later changes was tested, typechecked, linted, built, packaged,
  or smoke-tested. The green CI head `1ad58e67` is the pre-tranche baseline
  only. Package/plugin authority, write defaults, and ephemeral-grant defaults
  remain unpromoted. The approval-store revision is stored in the same
  encrypted file and has no independent monotonic/existence anchor, so hostile
  rollback, deletion, or reset to a fresh store remains a non-claim. There is
  no atomic transaction between the broker JSON file, Agent SQLite, MCP
  dispatch, or the external effect, and there is no cross-process writer
  serialization. Expiry is wall-clock based; restart neither reconstructs the
  ephemeral pending-approval UI nor automatically continues a response;
  SQLite power-loss durability was not established; and Windows has no
  containing-directory fsync for the broker file. External-effect atomicity,
  protected heads, target-OS confinement evidence, and packaged Electron smoke
  remain non-claims.

## Session 5 checkpoint evidence

- Contract boundary:
  [strict canonical JSON/UTF-8](../../packages/clodex-contracts/src/canonical-json.ts)
  and the
  [closed Intent Contract, action, ticket, and attestation validators](../../packages/clodex-contracts/src/intent-contract.ts)
  reject unknown structure, unsafe or over-budget canonical values,
  non-canonical base64url, inexact selectors, semantic attestation laundering,
  mixed trust-registry snapshots, and hard-denied ambient authority. Signature
  verification ends with a synchronous epoch/digest/key/role trust fence. The
  package passes **36/36 tests**.
- Guardian boundary:
  [Safe Coding Guardian](../../packages/clodex-guardian/src/safe-coding-guardian.ts)
  derives caller identity from a trusted port, applies current mandatory policy,
  commits policy/adapter identity plus runner/effect registry digests, registers
  tickets through the kernel port, performs asynchronous ticket revalidation,
  and exposes a final synchronous composite authority assertion. Constructor
  dependencies, methods, and accepted-role arrays are descriptor-pinned. The
  package passes **19/19 tests**.
- Kernel boundary:
  [pure transitions](../../packages/clodex-kernel/src/transitions.ts) and the
  [reference kernel](../../packages/clodex-kernel/src/in-memory-kernel.ts)
  enforce CAS revisions, revocation epochs, budgets, replay resistance, and
  synchronous one-shot `COMMIT_PERMIT`. The profile is explicitly memory-only and
  non-durable. The package passes **13/13 tests**.
- Runtime boundary:
  [reference runtime](../../packages/clodex-runtime/src/reference-runtime.ts)
  owns the exact two-phase order
  `adapter.prepare → Guardian.revalidateExecutionTicket → synchronous
Guardian.assertFinalAuthority → synchronous Kernel.commitPermit →
preparedEffect.execute`. The prepared effect is pinned and invoked once only
  after an exact permit. Dependency ports, runner identity, adapter binding,
  prepared effects, adapter results, and permits reject accessor or structural
  drift without evaluating accessors. Post-permit failures close
  `UNCERTAIN` or `RESULT_UNAVAILABLE` without retry authority and emit only
  semantically valid attestations.
  [Runtime tests](../../packages/clodex-runtime/src/reference-runtime.test.ts)
  pass **17/17**.
- Approval boundary:
  [canonical approval service](../../packages/clodex-approval/src/approval-service.ts)
  and [artifact model](../../packages/clodex-approval/src/approval-artifact.ts)
  bind authority-only canonical rendering, reviewer identity/trust, current
  policy/registry/renderer commitments, expiry, DSSE signatures, and one-shot
  replay. The package passes **32/32 tests**.
- Ledger boundary:
  [logical ledger](../../packages/clodex-ledger/src/ledger.ts),
  [closed records](../../packages/clodex-ledger/src/records.ts), and
  [transitions](../../packages/clodex-ledger/src/transitions.ts) keep ticket,
  effect attempt, evidence expectation, and admission outbox in one CAS record,
  reserve all modeled identities globally, and accept only a one-shot verified
  evidence receipt. The core passes **30/30 tests**. The
  [POSIX adapter](../../packages/clodex-ledger-node/src/posix-ledger-store.ts)
  passes **17/17 tests** for bounded snapshots, private locking, file/directory
  `fsync`, atomic rename, post-rename reconciliation, restart reads, process CAS,
  and base-inode replacement detection.
- Evidence boundary:
  [signed evidence](../../packages/clodex-evidence/src/signed-evidence.ts) and
  [in-memory reference ledger](../../packages/clodex-evidence/src/in-memory-evidence.ts)
  enforce executor/observer signatures, one atomic trust epoch/registry view,
  a final synchronous signer-set trust fence, idempotency replay protection,
  bounded hash chains, and checkpoint fork/rollback detection. The package
  passes **28/28 tests**.
- Adapter boundary:
  [reference adapters](../../packages/clodex-adapters/src/index.ts) bind one
  immutable workspace/task/root capability scope, reject ticket-audience drift
  before calling a port, propagate the full scope to every operation, and reject
  mixed-scope registries. The package passes **31/31 tests**. These are
  operation-specific port protocols, not OS implementations.
- Promotion boundary:
  [promotion assessment](../../packages/clodex-promotion/src/promotion-assessment.ts)
  binds exact release evidence and uses trusted clock/hash/current-state fences;
  it returns eligibility only and cannot enable a gate. The package passes
  **7/7 tests**.
- Combined Session 5 package tests pass **230/230**. Root typecheck passes
  **25/25 Turbo tasks**; dependency/import and provenance checks pass;
  independent boundary tests pass **38/38**; targeted Biome and
  `git diff --check` pass. Complete browser regression passes **2215/2215 tests
  across 269 files**, and all six browser typecheck targets pass.
- **P0 closure implementation tranche — intentionally unexecuted:** subsequent
  code adds universal Artifact Bridge WAL coverage for ask-agent, automation,
  and ordinary async MCP, plus universal scheduled/manual AutomationService
  WAL; `@clodex/control-plane` plus its POSIX adapter;
  `@clodex/registry` plus its honest non-protected POSIX head; and
  `@clodex/adapters-node` with Linux openat2 and digest-pinned container
  capability implementations; plus `@clodex/production`, a fail-closed
  authority-null bootstrap requiring protected heads, recovery admission,
  promotion evidence, and a separate reviewed gate decision. Browser source
  composes it through `SafeCodingProductionAuthorityService` with
  `provider: null`; shutdown stops admission and drains it before dependent
  teardown. Prepared tests and the complete required command list are recorded in
  [P0_TESTING_HANDOFF.md](../developer/P0_TESTING_HANDOFF.md). Per explicit
  instruction, no test, typecheck, lint, native compilation, container smoke,
  install, or validation command was run after these changes. The historical
  counts above do not validate this tranche; green GitHub CI at `1ad58e67` is
  the pre-tranche baseline only.
- Claim boundary: Session 5 source is `IMPLEMENTED_UNVERIFIED` and remains
  unpromoted. Independent audit found no remaining P0/P1 issue inside the
  previously tested reference boundaries. New P0 implementation source is
  **not** a tested or deployed guarantee.
  Production remains blocked by external-effect/cross-store atomicity,
  independently protected anti-rollback heads, production crypto/key custody
  and signer trust, verified native/container/LSM confinement, protected daemon
  identity, a trusted non-null production provider, and packaged Electron
  validation. No feature-gate default or authority-promotion callback changed.
  `INV-EFFECT-001` and `INV-SANDBOX-001` remain non-enforced.

## Promotion rule

Artifact Bridge MUST remain disabled for production write authority while any
of these guarantees is not ENFORCED:

- INV-SESSION-001;
- INV-NAV-001;
- INV-CONTENT-001;
- INV-EGRESS-001;
- INV-RESOLVER-001;
- INV-REVIEW-001;
- INV-REVIEW-002;
- INV-REV-001;
- INV-DESC-001;
- INV-RETRY-001;
- INV-WAL-001;
- INV-ATOMIC-001.

Safe Coding production authority and any shell/OpenManus/cloud-owned execution
gate MUST also remain default-off while any of these rows is not `ENFORCED`:

- INV-PRODUCTION-BOOTSTRAP-001;
- INV-MCP-001;
- INV-APPROVAL-RESP-001;
- INV-CLOUD-001;
- INV-SHELL-001;
- INV-JS-SANDBOX-001;
- INV-OPENMANUS-001;
- INV-MOUNT-001;
- INV-EFFECT-001;
- INV-SANDBOX-001.

A documentation change cannot upgrade a status. Status changes require links to
the exact enforcement code and passing executable tests.
