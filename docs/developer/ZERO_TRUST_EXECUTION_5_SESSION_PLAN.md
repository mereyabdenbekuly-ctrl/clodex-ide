# Zero-Trust Execution Layer: five-session implementation plan

- **Date:** July 14, 2026
- **Source specification:** ../INTENT_CONTRACT_SPEC.md
- **Feature-gate rule:** Artifact Bridge write authority remains disabled until
  Session 5 promotion criteria pass.

## Progress

| Session                                      | Status      | Evidence boundary                                                                                                                                                            |
| -------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. CI and protocol truth                     | COMPLETE    | Pages is in mandatory typecheck; shared v2 protocol scaffolding is tested but is not the production generated-app bridge                                                     |
| 2. Session and navigation boundary           | COMPLETE    | Document-bound transport is wired fail-closed in main, has ordered teardown, and passed 111/111 focused tests plus all required typechecks                                   |
| 3. Resolver and canonical authority approval | COMPLETE    | Local-agent resolver, trusted reviewer, canonical current-profile review, exact-byte revision lifecycle, and isolated-app egress controls passed 252/252 tests               |
| 4. Atomic authorization-to-effect safety     | IN_PROGRESS | Grant epochs, MCP commitments, true adapter fences, reviewed MCP WAL/no-retry closure, and async UNCERTAIN handling pass focused tests; universal effect WAL remains blocked |
| 5. Safe Coding vertical slice and promotion  | IN_PROGRESS | Ten independent reference packages pass 230/230 tests; atomic production wiring, OS confinement, protected heads, and authority promotion remain blocked                     |

## Session 1 — CI and protocol truth

### Objective

Make Pages sources part of the mandatory build truth and remove the known
Artifact Bridge protocol split without treating shared schema or Pages
compatibility code as a production authority boundary or enabling authority.

### Deliverables

- browser typecheck includes tsconfig.pages.json;
- all Pages TypeScript errors are fixed;
- the shared authority protocol is v2-only, and legacy Pages forwarding of
  bridge envelopes is removed;
- every request and response carries a UUID session ID;
- v1, missing session, and invalid session schemas are rejected by tests;
- shared v2 protocol schemas and Pages compatibility sources compile without
  creating a Pages Artifact Bridge RPC or production generated-app transport;
- bundled mini-app guidance no longer recommends v1;
- Security Guarantee Manifest records enforced and blocked claims.

### Exit criteria

- Pages typecheck passes;
- focused shared-protocol tests and Pages compilation pass;
- main browser typecheck starts the Pages job;
- production resolver remains null and feature-gate configuration is not
  broadened.

### Completion evidence

- Pages, backend, and the full browser typecheck pass;
- invalid or missing protocol session IDs are rejected by the shared schemas;
- bundled mini-app assets, targeted formatting, and diff checks pass;
- the current tree contains no Pages Artifact Bridge RPC or handler; Pages
  compatibility code is not an authority-bearing transport;
- `resolveApp: async () => null` and feature-gate configuration were unchanged
  at Session 1 completion. The resolver state was superseded only by the
  reviewed local-agent implementation in Session 3.

## Session 2 — Session and navigation boundary

### Objective

Give each generated-app document a host-issued, revocable session identity
bound to trusted Electron document identity rather than renderer-supplied
window state.

### Deliverables

- per-app isolated `app://` origin;
- isolated subframe preload with a private MessagePort;
- frozen `window.clodexArtifactBridge.request` proxy with no session or port
  exposure to generated app JavaScript;
- main-process hello/connect broker;
- host-issued session ID and navigation epoch;
- webContents, frame-tree slot, frame revision, exact origin, app, agent,
  plugin, and preview-route binding;
- open, rotate, close, and revoke lifecycle;
- reload, navigation, close, and route-change revocation;
- port-only request and response delivery;
- stale callback cancellation.

### Completion evidence

- the shared isolated-origin helper and backend parser bind a full SHA-256
  Base32 host to decoded app identity and reject malformed authority forms;
- the isolated preload retains the MessagePort and session binding outside app
  JavaScript;
- production main starts the frame broker against the Artifact Bridge service;
- host-session and frame-broker runtime paths enforce independent document
  slots, navigation epochs, trusted sender-frame checks, and port-only
  responses;
- shutdown tears down the frame broker before the underlying Artifact Bridge
  service, preventing new document traffic during service teardown;
- the focused Session 2 suite passes 111/111 tests, including malformed hello,
  origin/path mismatch, stale epoch, frame replacement, delayed response,
  concurrent preview, port close, reload rotation, gate-off, and teardown
  cases;
- Pages, backend, and web-content-preload typechecks pass independently;
- the complete browser typecheck passes, including agent-core, agent-shell, UI,
  Pages, backend, preload, Storybook, and visual projects;
- targeted Biome, Prettier, bundled-asset validation, and `git diff --check`
  pass.

Session 2 completion is scoped strictly to the document-bound transport
boundary. It does not claim a packaged Electron smoke run and did not promote
resolver, reviewer, grant, capability, or write authority.

### Exit criteria

- old document cannot receive or reuse a new session;
- new document cannot receive an old asynchronous response;
- source, origin, session, and epoch mismatches fail closed;
- production construction starts and tears down the trusted frame broker;
- no Artifact Bridge request or response uses `window.postMessage` or a
  WindowProxy;
- the full lifecycle and adversarial suite passes through production wiring.

All exit criteria above are satisfied for the documented transport boundary.
Packaged Electron smoke remains an explicit non-claimed validation layer.

## Session 3 — Resolver and canonical authority approval

### Objective

Bind current read, ask-agent, and automation grants for local agent-generated
apps to verified whole-tree identity through a trusted canonical review path.

### Deliverables

- production-wired `GeneratedAppIdentityResolver` for local agent apps only;
- canonical manifest, executable-tree, asset-tree, and policy digests;
- bounded exact filesystem traversal with alias, symlink, hardlink, mutation,
  size, entry-count, and depth rejection;
- exact-byte serving from the same snapshot that produced `assetHash`;
- canonical `clodexRev` navigation, one-shot provisional binding before parser
  subresources, trusted broker upgrade, port-close transport removal and exact
  host-session suspension, reconnect-grace nonce preservation, exact
  same-document token rotation, and lifecycle cleanup;
- isolated-app direct network denial plus fail-closed popup/custom-protocol
  denial before generic tab and OS handlers;
- dedicated trusted `ui-main` reviewer transport derived from current Electron
  WebContents and main-frame identity rather than renderer-selected caller IDs;
- canonical manifest- and policy-derived capability review UI for the current
  read, ask-agent, and automation profile;
- one-shot review registry with exact context, identity, policy, manifest,
  selection, expiry, and submission revalidation;
- persistent and session-scoped grant validation while preserving existing
  feature-gate defaults.

### Exit criteria

- unsupported, unavailable, or invalid identities cannot create a host session
  or grant;
- identity, manifest, asset, executable, policy, write-gate, or feature-gate
  drift invalidates or consumes the pending review;
- renderer-selected Karton roles cannot acquire reviewer authority;
- generated app JavaScript cannot create or expand its own grant;
- stale bytes, revisions, frame generations, responses, and navigation epochs
  fail closed;
- a suspended or replaced local-agent host session cannot begin the current
  direct read-only MCP effect after asynchronous descriptor lookup;
- package and plugin contexts continue to resolve to `null` for Artifact Bridge
  authority.

### Completion evidence

- production main constructs one `GeneratedAppIdentityResolver` and passes its
  agent-only `resolve` result to Artifact Bridge;
- authority-bearing HTML and subresources are returned from resolver snapshot
  bytes rather than a later live filesystem read;
- app protocol and broker share a per-session revision registry, bind before
  port activation, retain exact nonces across provisional-to-trusted upgrade,
  close the retired port and serialize exact host-session suspension before any
  reconnect activation, preserve the content nonce through reconnect grace,
  rotate the exact trusted document token on same-document reconnect, and
  unbind content on navigation, explicit revoke, grace expiry, WebContents
  destruction, and teardown;
- history mutation cannot change the active authority revision, and already
  issued subresource bindings become invalid after exact unbind;
- ambiguous `window.open`, target-blank, external-protocol, and reveal-file
  requests are denied whenever a tab hosts an isolated generated app, with the
  shared fail-closed helper covered by nine focused tests including
  source-inspection failure;
- canonical review accepts only current manifest/policy-declared selectors and
  burns one-shot reviews before asynchronous revalidation;
- the direct read-only MCP path rechecks exact host binding after asynchronous
  descriptor lookup immediately before `callTool`;
- the focused Session 3 suite passes **252/252 tests across 18 files**; the
  exact-byte/revision subset passes **97/97**;
- Pages, backend, and web-content-preload TypeScript checks pass independently,
  and the full browser typecheck passes;
- targeted Biome and `git diff --check` pass.

Session 3 completion is deliberately narrow. No packaged Electron smoke is
claimed. Plugin and package Artifact Bridge identities remain unsupported.
Write and ephemeral-grant feature-gate defaults were not promoted. Canonical
review enforcement is claimed only for the current read, ask-agent, and
automation profile. General write, sensitive-egress, asynchronous-operation,
descriptor-commitment, revocation-fence, WAL, retry, and terminal-effect safety
remain Session 4 work.

## Session 4 — Atomic authorization-to-effect safety

### Objective

Ensure approval, revocation, and the actual effect remain bound across races,
crashes, retries, and descriptor drift.

### Deliverables

- grant and revocation epoch;
- universal final execution fence immediately before every effect;
- server, endpoint, descriptor, schema, annotation, classification, adapter,
  argument, policy, and contract commitments;
- durable write-ahead effect record;
- one-shot Execution Ticket;
- terminal committed-result-unavailable and uncertain states;
- no blind retry;
- complete derived-proposal invalidation.

### Exit criteria

- revoke before final dispatch prevents every modeled effect;
- descriptor drift requires re-review;
- successful effect plus result failure cannot repeat the effect;
- crash and timeout produce deterministic recovery or UNCERTAIN;
- write, sensitive-egress, and asynchronous-operation adapters enforce the same
  exact final-dispatch boundary as the current direct read-only path.

### Current checkpoint — July 14, 2026

Implemented and verified:

- in-memory `grantId` plus monotonic grant revision and shared synchronous
  revoke fences; replacement, expiry, session close, and revoke invalidate
  derived proposals and operations;
- serialized durable grant save/revoke mutations staged through
  `pendingMutations`; incomplete or ambiguous mutations fail closed and are
  reconciled on startup before authority can be published;
- prepared-only grant audit semantics (`grant.save-prepared` and
  `grant.revoke-prepared`), production audit recorder/reader wiring, sticky
  integrity failure, and file plus directory fsync for audit/persisted writes;
- final MCP dispatch validation inside `McpHostSupervisor`, after
  `ensureReady()` and immediately before the synchronous IPC request;
- MCP host protocol v6 connection identity, serialized per-server lifecycle,
  and stale close/list/catalog/connect rejection across A→B→A races;
- exact MCP effect commitments over principal, app identity, document
  generation, grant revision, local server/endpoint/config, runtime and catalog
  generations, configuration revision, sensitive-enforcement profile, the
  complete locally cached descriptor/schema/annotations, trusted
  classification, adapter version, canonical arguments, and policy;
- durable encrypted effect WAL for reviewed MCP write and sensitive calls with
  `PREPARED`, `DISPATCHING`, `COMMITTED`, `RESULT_UNAVAILABLE`, `UNCERTAIN`, and
  `FAILED_PRE_EFFECT` states, crash recovery, and consumed one-shot tokens;
- automation and ask-agent adapter callbacks at their last application-owned
  await boundary; AutomationService requires callback consumption and rechecks
  its feature gate for manual, startup, and scheduled dispatch. Artifact Bridge
  automation uses one attempt, strict error propagation, redacted errors, and a
  minimal success result;
- operation-local one-shot final fences for MCP, automation, and sensitive MCP
  async operations. Timeout, cancellation, adapter failure, revoke, or session
  close after final dispatch preserves terminal `uncertain` evidence;
- proposal/ticket expiry and async/sensitive feature-gate state are rechecked at
  the final dispatch fence;
- approval-audit failure burns the write/sensitive WAL ticket fail-closed;
  concurrent approvers receive the same failure and a fresh proposal/review is
  required instead of retrying a write-ambiguous audit append;
- complete browser suite **2215/2215 tests across 269 files**, including the
  complete Session 1–4 regression corpus and **97/97** exact-byte/revision
  tests; MCP runtime **27/27**; targeted agent-core create-handler **8/8**;
  browser, MCP runtime, and agent-core typechecks; MCP host build; and
  bundled-asset validation pass.

Session 4 remains `IN_PROGRESS`. The durable WAL and exact action commitment are
not yet universal for direct ask-agent, automation, or ordinary async MCP
effects, and automation definition/model-adapter identity is not yet
review-bound. Automation is also a composite create-agent→mount/message effect:
the initial upsert is fenced, but later partial failure has no universal durable
`UNCERTAIN` or compensation closure. Runtime grant revisions do not prove
durable anti-rollback, and the local audit hash chain has no independently
protected head. No feature-gate default or write/package/plugin promotion
changed, and no packaged Electron smoke is claimed. Production `main.ts`
intentionally does not pass the write, sensitive-egress, async-operation,
runtime-quota, lifecycle, inspector, ephemeral-grant, or package-capability
enablement callbacks into Artifact Bridge; their feature-gate definitions alone
therefore cannot promote those authorities before Session 5.

## Session 5 — Safe Coding vertical slice and promotion

### Objective

Demonstrate the Intent Contract architecture with executable invariants and
decide whether Artifact Bridge may advance beyond prototype.

### Deliverables

- signed filesystem, Git-inspection, and test Intent Contract;
- canonical approval;
- Guardian ticket issuance;
- trusted file and test adapters;
- Effect Attestations and closure records;
- end-to-end adversarial suite;
- completed Security Guarantee Manifest;
- release/promotion check that keeps the gate off on any failed P0 invariant.

### Exit criteria

- writes outside approved trees fail;
- network, secrets, shell, delete, commit, and push remain denied unless an
  explicit later profile authorizes them;
- every modeled effect has a terminal attestation or uncertain recovery record;
- all P0 Artifact Bridge tests pass through production wiring;
- feature enablement is a separate reviewed decision, not an automatic result.

### Current checkpoint — July 14, 2026

Implemented as independent, fail-closed reference components:

- `@clodex/contracts`: closed Safe Coding v1 contract/action/ticket/attestation
  validation, bounded canonical JSON/UTF-8, canonical base64url, exact
  selectors, hard ambient-authority denies, domain-separated hashing, trusted
  signer epoch/registry snapshots, final synchronous trust fencing, and
  status/evidence semantic validation;
- `@clodex/guardian`: trusted identity and current mandatory-policy ports,
  preflight before PREPARE, descriptor-pinned constructor ports, immutable
  output snapshots, policy/adapter commitments plus runner/effect registry
  digests, atomic kernel registration, async final revalidation, and a
  synchronous composite authority fence;
- `@clodex/kernel`: pure CAS/revision/revocation/budget/replay transitions,
  one-shot `COMMIT_PERMIT`, pre-commit failure closure, and terminal
  committed/result-unavailable/uncertain states, with a memory-only reference
  adapter;
- `@clodex/runtime`: recording-only, runtime-owned two-phase orchestration and
  validated Effect Attestations with exact order
  `adapter.prepare → Guardian.revalidateExecutionTicket → synchronous
Guardian.assertFinalAuthority → synchronous Kernel.commitPermit →
preparedEffect.execute`. Constructor ports, runner identity, adapter binding,
  adapter result, prepared effect, and kernel permit are descriptor-pinned;
- `@clodex/approval`: canonical authority-only review and Approval Artifact,
  DSSE envelope, trusted reviewer snapshots, exact current commitments,
  bounded validity, one-shot replay registration, and final synchronous trust
  and commitment fences;
- `@clodex/ledger`: one logical ticket/effect/evidence-outbox CAS record,
  immutable evidence expectations, closed reachable revisions, global identity
  reservations, verified one-shot evidence admission receipts, bounded scans,
  and conservative recovery classification;
- `@clodex/evidence`: canonical executor/observer signatures, immutable signer
  trust epoch/registry snapshots, idempotency replay prevention, bounded
  hash-linked chains, sequence/CAS checkpoints, and rollback/fork detection;
- `@clodex/adapters`: capability-scoped reference filesystem create/replace/
  mkdir, Git status/diff, and registered test operations. Workspace/task
  audience is checked before every port, the full workspace/task/root scope is
  forwarded to every operation, and mixed-scope registries are rejected;
- `@clodex/ledger-node`: bounded local POSIX snapshot durability with private
  locking, file and directory `fsync`, atomic rename, post-rename exact
  reconciliation, base-directory inode pinning, and fail-closed cleanup;
- `@clodex/promotion`: exact-evidence, trusted-clock, final-fence eligibility
  assessment that reports blockers and cannot enable a gate;
- package tests pass **230/230**: contracts **36**, Guardian **19**, kernel
  **13**, runtime **17**, approval **32**, ledger **30**, evidence **28**,
  adapters **31**, ledger-node **17**, and promotion **7**. Root typecheck passes
  **25/25 Turbo tasks**; dependency/import and provenance checks pass;
  independent-boundary tests pass **38/38**; targeted Biome and
  `git diff --check` pass. The complete browser regression remains
  **2215/2215 tests across 269 files**, and all six browser typecheck targets
  pass.

Session 5 remains `IN_PROGRESS`. The kernel and default evidence adapters are
in-memory and non-durable; the POSIX ledger adapter is durable only inside its
declared trusted-local-filesystem boundary and is not atomically linked to
kernel state, effect execution, evidence signing, or protected checkpoint
publication. The reference runtime has no host filesystem, Git subprocess,
shell, process, network, credential, browser migration adapter, or production
promotion path. Side-effect-free `adapter.prepare` and operation-specific
capability ports are trusted assumptions, not OS confinement. Synchronous
`commitPermit` is only local in-process linearization, not a durable or
cross-process commit. The scoped adapter registry digest is supplied by trusted
deployment configuration; no signed registry manifest proves root-object
membership yet. Production key custody, independently protected anti-rollback
heads, cross-system atomic transactions, real `openat2` filesystem confinement,
hardened Git execution, and a real networkless sandbox remain blocking. No
feature-gate default changed and no packaged Electron smoke is claimed.
Independent audit found no remaining P0/P1 defect inside the stated reference
boundaries. See [Safe Coding Autopilot MVP](SAFE_CODING_AUTOPILOT_MVP.md).
