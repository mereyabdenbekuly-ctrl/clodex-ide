# CLODEx Security Guarantee Manifest

- **Version:** 0.9
- **Date:** July 14, 2026
- **Rule:** only ENFORCED claims may be described as runtime guarantees.
- **Source specification:** ../INTENT_CONTRACT_SPEC.md
- **Implementation plan:** ../developer/ZERO_TRUST_EXECUTION_5_SESSION_PLAN.md

## Status values

| Status         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| ENFORCED       | runtime boundary exists and required tests pass                                              |
| TESTED         | a schema or isolated component property is tested, but complete mediation is not established |
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
| INV-READ-FENCE-001    | Suspended or replaced host session cannot start direct read-only MCP dispatch after descriptor await | Artifact Bridge current read     | ENFORCED  | exact grant/document commitment plus supervisor-side callback after `ensureReady()` and immediately before IPC dispatch, with adversarial races                                 | Supported local-agent profile only; no packaged Electron smoke                                                                                            |
| INV-REV-001           | Revocation before final dispatch prevents every modeled effect                                       | current Artifact Bridge adapters | ENFORCED  | grant revision fences, exact host generation, MCP supervisor callback, ask-agent callback, automation serialized callback, operation-local one-shot fences, and races           | Package/plugin authority remains disabled; no packaged Electron smoke                                                                                     |
| INV-DESC-001          | Reviewed MCP descriptor matches the current local dispatch snapshot immediately before IPC dispatch  | Artifact Bridge MCP effects      | ENFORCED  | full local server/runtime/descriptor/classification/adapter/argument/policy commitment recomputed at final MCP dispatch, with endpoint/schema/annotation/generation drift tests | The MCP call protocol carries no descriptor version/hash accepted by the remote server; remote execution semantics are therefore not claimed identical    |
| INV-RETRY-001         | Result processing failure cannot replay a committed effect                                           | all Artifact Bridge effects      | BLOCKED   | reviewed MCP write/sensitive paths use terminal WAL states and one-shot tokens; async operations preserve in-process `uncertain` evidence                                       | Direct ask-agent, automation, and ordinary async MCP effects do not yet have universal durable replay closure                                             |
| INV-WAL-001           | Every irreversible effect has a durable PREPARED/COMMITTED write-ahead record                        | effect ledger                    | BLOCKED   | encrypted durable WAL and startup recovery are enforced for reviewed MCP write and sensitive calls                                                                              | WAL is not yet universal for ask-agent, direct automation, ordinary async MCP, and every asynchronous effect                                              |
| INV-ATOMIC-001        | Authorization remains exact through the final dispatch boundary for every effect                     | effect adapters                  | BLOCKED   | current Artifact Bridge adapters expose final-dispatch fences; the Session 5 reference runtime owns prepare/revalidate/assert/permit/execute ordering                           | Automation definition/model-adapter identity, composite create-agent→mount/message closure, and universal durable effect closure remain incomplete        |
| INV-TICKET-001        | Execution Ticket is short-lived, exact-action, and single-use                                        | independent control-plane slice  | TESTED    | closed ticket validation, Guardian issuance/revalidation, kernel registration and synchronous one-shot `COMMIT_PERMIT`, plus focused contracts/Guardian/kernel/runtime tests    | Recording-only and memory-only; runner registry digest is bound, but concrete runner membership is not verified                                           |
| INV-REF-CLOSURE-001   | The recording-only runtime owns PREPARE, final authority, permit, and one post-permit execute        | Session 5 reference runtime      | TESTED    | closed prepared-effect/permit shapes; accessors are not evaluated; prototype/symbol/non-enumerable/extra permit drift closes `UNCERTAIN` before execute                         | Non-durable reference only; PREPARE is trusted inert behavior, with no host effect, crash-safe transaction, cross-process commit, or production promotion |
| INV-APPROVAL-REF-001  | Canonical approval binds only machine-readable authority and current commitments                     | independent approval reference   | TESTED    | canonical render model/artifact, DSSE verification, trusted reviewer snapshot, final trust/commitment fences, and one-shot replay tests                                         | No production UI, key custody, signing service, or durable replay store                                                                                   |
| INV-LEDGER-REF-001    | Ticket, effect attempt, evidence expectation, and evidence outbox share one CAS record               | independent ledger reference     | TESTED    | closed transitions, reachable revisions, global identity reservations, verified admission receipts, recovery tests, and POSIX snapshot adapter                                  | Not atomically linked to kernel/effect/evidence systems; no protected anti-rollback head                                                                  |
| INV-EVIDENCE-REF-001  | Signed evidence chain detects bounded replay, fork, rollback, and trust drift                        | independent evidence reference   | TESTED    | executor/observer signatures, trust epoch/registry binding, final synchronous signer-set fence, idempotency registry, chain/checkpoint tests                                    | Default ledger/checkpoint adapters are memory-only; no atomic protected checkpoint/trust transaction                                                      |
| INV-ADAPTER-SCOPE-001 | Reference adapters reject cross-workspace/task confused-deputy use before any capability port        | independent adapter reference    | TESTED    | immutable workspace/task/root scope, ticket-audience fence, scope propagation, mixed-scope registry rejection, and accessor/adversarial tests                                   | Signed scoped registry manifest and real OS-confined filesystem/Git/test implementations are absent                                                       |
| INV-PROMOTION-001     | Promotion assessment cannot itself enable a feature gate                                             | independent promotion reference  | TESTED    | exact environment/build/config/policy/evidence bindings, trusted clock/hash/final fence, and fail-closed eligibility tests                                                      | Eligibility is not production promotion; reviewed release control remains external                                                                        |
| INV-DELEG-001         | Child authority is a deterministic subset of parent authority                                        | multi-agent                      | SPEC_ONLY | planned Guardian subset evaluator                                                                                                                                               | Current capabilities are coarse and aggregate budgets are absent                                                                                          |
| INV-EFFECT-001        | Every modeled effect reaches one durable terminal closure state                                      | effect adapters                  | BLOCKED   | isolated ledger/evidence/runtime references and reviewed-MCP WAL prove narrower closure properties                                                                              | No atomic universal production linkage among authorization, effect, ledger, evidence, checkpoint, and trust state                                         |
| INV-MEM-001           | Memory cannot mint authority                                                                         | memory/control plane             | SPEC_ONLY | Intent Contract authority model                                                                                                                                                 | Complete semantic lineage and universal runtime mediation are not claimed                                                                                 |
| INV-SANDBOX-001       | Test execution has no host filesystem, credential, or network escape                                 | sandbox/test adapter             | BLOCKED   | digest-pinned reference profile and capability-scoped adapter protocol                                                                                                          | No Docker/VM/OS runner currently enforces the descriptor; confirmed sandbox and isolated-fs bypasses must be fixed                                        |
| INV-MCP-001           | Every MCP invocation is mediated at the registry boundary                                            | MCP                              | BLOCKED   | planned centralized gateway                                                                                                                                                     | Current policy is wrapper-specific                                                                                                                        |
| INV-CLOUD-001         | Stale local owner cannot execute after cloud handoff                                                 | execution lanes                  | BLOCKED   | planned final lane fence                                                                                                                                                        | Ownership fence is not wired at every dispatch boundary                                                                                                   |

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
- Remaining Session 4 blockers: universal WAL/replay closure for direct
  ask-agent, automation, and ordinary async MCP effects; review-bound
  automation definition plus model-adapter commitment; and durable closure or
  compensation for the composite create-agent→mount/message effect.
  Package/plugin authority, write defaults, and ephemeral-grant defaults remain
  unpromoted. A packaged Electron smoke run is not claimed.
- Production main wires and verifies the durable audit ledger, but deliberately
  omits every Session 4 authority-promotion callback (write, sensitive egress,
  async operations, runtime quotas, lifecycle events, inspector, ephemeral
  grants, and package capabilities). The corresponding feature-gate catalog
  entries are not evidence that those runtime authorities can be enabled.

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
- Claim boundary: Session 5 remains `IN_PROGRESS`. Independent audit found no
  remaining P0/P1 issue inside the stated reference boundaries. Production
  guarantees remain blocked by the lack of atomic kernel/effect/ledger/evidence/
  checkpoint/trust persistence, protected anti-rollback heads, production key
  custody and registries, a signed scoped adapter-registry manifest, real
  `openat2`/Git/sandbox implementations, production browser wiring, and packaged
  Electron validation. No feature-gate default or authority-promotion callback
  changed. `INV-EFFECT-001` and `INV-SANDBOX-001` remain non-enforced.

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

A documentation change cannot upgrade a status. Status changes require links to
the exact enforcement code and passing executable tests.
