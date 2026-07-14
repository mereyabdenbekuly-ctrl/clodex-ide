# CLODEx Signed Deterministic Intent Contracts

- **Status:** Draft 0.1
- **Date:** July 14, 2026
- **Scope:** filesystem, Git inspection, and sandboxed test execution
- **Implementation status:** normative target with a partially enforced
  Artifact Bridge subset through Session 4 plus an isolated, recording-only,
  non-durable Session 5 reference slice
- **Related:** ADR-0001 through ADR-0005 and security invariants

## 1. Thesis

CLODEx does not make human intent generally machine-verifiable.

CLODEx makes **conformance to an active, signed, bounded Intent Contract**
machine-checkable.

The normative control flow is:

```text
LLM or deterministic compiler proposes
        ↓
trusted policy or canonical human approval authorizes
        ↓
Issuance Authority signs an immutable contract revision
        ↓
Guardian checks exact-action conformance
        ↓
Guardian issues a short-lived one-shot Execution Ticket
        ↓
runtime obtains an inert prepared effect from the trusted adapter
        ↓
Guardian revalidates and synchronously asserts final authority
        ↓
kernel synchronously consumes the ticket and returns COMMIT_PERMIT
        ↓
runtime invokes the prepared effect at most once
        ↓
adapter emits an Effect Attestation
        ↓
ledger records terminal or uncertain state
```

An Intent Contract is an upper bound on authority. It is not a bearer token and
does not directly authorize dispatch.

## 2. Normative language

MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are normative terms.

Fail-closed means that missing, malformed, stale, ambiguous, unavailable, or
unverifiable state results in denial or explicit escalation. It never creates
broader authority.

## 3. Non-goals

Intent Contracts do not:

1. infer true human intent;
2. prove that an action is necessary in the general case;
3. trust an LLM, model rationale, MCP server, tool output, generated app,
   plugin, skill, repository content, or memory item;
4. prove an external effect merely because an observer signed a receipt;
5. provide perfect semantic taint tracking through arbitrary model cognition;
6. guarantee safety after Guardian, adapter, executor, kernel, or signing-key
   compromise;
7. make broad human approval safe;
8. make an effect idempotent, reversible, local, or observable because an
   untrusted caller labels it so;
9. permit descriptive fields to grant authority;
10. provide universal exactly-once execution.

If necessity is not decidable in the active domain, policy MUST deny or require
fresh explicit approval.

## 4. Threat model

The attacker may:

- inject instructions through any untrusted source;
- propose valid-looking but overbroad contracts;
- exploit misleading approval summaries;
- mutate paths, Git refs, manifests, tool descriptors, endpoints, adapters,
  policies, sessions, or identities between approval and execution;
- race revocation, expiry, cancellation, navigation, crash, retry, and handoff;
- replay contracts, approvals, tickets, and attestations;
- split a forbidden aggregate effect across agents;
- exploit test scripts, Git hooks, package scripts, redirects, DNS rebinding,
  symlinks, hardlinks, junctions, mounts, and case-folding;
- return an oversized or unserializable result after an effect occurred;
- cause partial or uncertain external state;
- use memory or a receipt as forged authority.

The first slice does not claim protection against a compromised host kernel,
covert channels, or uninstrumented legacy effect paths.

## 5. Trusted computing base

The minimum TCB is:

1. strict schema validator;
2. canonicalizer and hash verifier;
3. issuance and approval authority;
4. contract registry and anti-rollback revocation store;
5. deterministic Guardian;
6. delegation and budget resolver;
7. trusted policy, adapter, runner, and effect registries;
8. filesystem, Git, and test adapters;
9. sandbox and process supervisor;
10. one-shot ticket store;
11. effect attestation signer;
12. evidence ledger and protected checkpoints;
13. trusted clock, nonce source, and protected key storage;
14. canonical approval renderer.

The TCB MUST NOT include the LLM, agent process, renderer, iframe, MCP server,
semantic classifier, or durable memory content.

## 6. Artifact separation

CLODEx MUST keep these artifacts distinct:

| Artifact           | Authority                | Purpose                                      |
| ------------------ | ------------------------ | -------------------------------------------- |
| Intent Proposal    | none                     | untrusted semantic proposal                  |
| Intent Contract    | upper bound              | signed bounded authority envelope            |
| Approval Artifact  | approval evidence        | binds approver to exact contract hash        |
| Execution Ticket   | exact one-shot authority | permits one exact dispatch                   |
| Effect Attestation | none                     | records an observer claim and evidence level |
| Ledger Record      | none                     | preserves lifecycle and recovery state       |

Each artifact type MUST use a separate signature domain so an attestation cannot
be replayed as a ticket and a proposal cannot be replayed as a contract.

## 7. Effective authority

At time t:

```text
EffectiveAuthority(C, t) =
    ContractAuthority(C)
  intersect IssuerAuthority(C)
  intersect ParentDelegation(C)
  intersect PinnedPolicy(C)
  intersect CurrentMandatoryRestrictions(t)
  intersect CurrentRevocationState(t)
```

A later policy MAY narrow or revoke old authority. It MUST NOT expand an issued
contract without a new approved revision.

## 8. Authoritative and descriptive fields

Every contract separates:

- **authority**: closed-schema fields with deterministic semantics;
- **nonAuthoritative**: goal labels, explanations, rationale, and notes.

Guardian MUST ignore nonAuthoritative fields for positive authorization.

The authority schema MUST reject fields named or equivalent to:

- purpose;
- necessary;
- necessaryFor;
- safe;
- lowRisk;
- alignedWithUserGoal;
- modelConfidence;
- recommended.

A signed descriptive field is integrity-protected but still grants no authority.

## 9. Logical v1 payload

The following is explanatory, not canonical bytes:

```json
{
  "kind": "clodex.intent-contract",
  "specVersion": "1.0.0",
  "contractId": "UUID",
  "revision": 1,
  "previousRevisionHash": null,
  "issuedAt": "2026-07-13T08:00:00Z",
  "validity": {
    "notBefore": "2026-07-13T08:00:00Z",
    "expiresAt": "2026-07-13T10:00:00Z"
  },
  "subject": {
    "principalId": "agent principal",
    "instanceId": "agent runtime instance"
  },
  "audience": {
    "guardianId": "guardian identity",
    "executorId": "executor identity",
    "runtimeEpoch": 7,
    "taskId": "task identity",
    "workspaceId": "workspace identity"
  },
  "bindings": {
    "policyDigest": "sha256 value",
    "adapterRegistryDigest": "sha256 value",
    "runnerRegistryDigest": "sha256 value",
    "effectRegistryDigest": "sha256 value",
    "approvalRendererVersion": "version"
  },
  "authority": {
    "filesystem": [],
    "git": [],
    "testProfiles": [],
    "allowedEffectClasses": [],
    "limits": {},
    "ambientAuthority": {},
    "delegation": {}
  },
  "nonAuthoritative": {
    "goalLabel": "Fix authentication tests",
    "notes": []
  }
}
```

All authority-bearing objects MUST set additionalProperties to false.

## 10. Decidable resource selectors

The first version supports only:

```json
{"kind":"file","path":"src/auth/login.ts"}
{"kind":"tree","path":"src/auth"}
```

It does not support glob, regex, negative patterns, shell expansion, absolute
paths, parent traversal, backslashes, NUL, empty components, or implicit case
folding.

An empty path is allowed only for a tree selector and means workspace root.

Coverage is:

```text
tree(P) covers file(Q) when Q equals P or is a descendant of P
tree(P) covers tree(Q) when Q equals P or is a descendant of P
file(P) covers file(Q) only when P equals Q
file(P) never covers tree(Q)
```

This deliberately restricted language makes delegation containment decidable.

String validation alone is insufficient. At activation and execution, the
trusted adapter MUST bind selectors to workspace identity and resolve objects
using descriptor-based traversal that does not follow symlinks.

## 11. Canonicalization

Contracts MUST pass:

1. strict JSON parsing with duplicate-key rejection;
2. closed-schema validation;
3. Unicode NFC validation;
4. ASCII identifiers, enum values, and digest encoding;
5. integer-only authority values from zero through the safe-integer limit;
6. canonical UTC timestamps;
7. lowercase hexadecimal digests;
8. sorted and unique set arrays;
9. RFC 8785 JSON Canonicalization Scheme;
10. byte-for-byte equality with the submitted canonical payload.

Non-canonical input MUST be rejected, not silently normalized before signature
verification.

The contract hash is:

```text
SHA-256(
  "clodex.intent-contract.v1"
  || zero byte
  || canonical payload bytes
)
```

## 12. Signature and trust policy

The contract payload SHOULD use a DSSE v1 envelope with payload type:

```text
application/vnd.clodex.intent-contract.v1+jcs
```

The v1 algorithm is P-256 ECDSA with SHA-256, IEEE P1363 fixed-width signature
encoding, and canonical low-S verification. This matches the existing protected
runner authority while preventing signature-encoding ambiguity. A future
algorithm change requires a new payload type and interoperability test vectors.

The external Guardian trust store defines accepted signer roles. A contract
MUST NOT declare which signatures are sufficient for itself.

Root activation requires one of:

- an accepted human-authorizer signature; or
- an accepted deterministic policy-authorizer signature.

Model, agent, renderer, iframe, MCP, and provider keys MUST NOT be root
authorizer keys.

## 13. Approval model

Approval UI is part of the TCB.

It MUST render from canonical authority fields and show:

- subject and application identity;
- task and workspace;
- all allowed and denied actions;
- every resource selector;
- network, secrets, process, and shell policy;
- effect classes;
- all budgets;
- expiry;
- delegation depth and child limits;
- policy and registry bindings;
- the full authority delta from the prior or parent revision;
- every external or non-revocable effect.

It MUST NOT use an LLM summary as the security view, truncate authoritative
fields, hide wildcards, or accept a hash different from the rendered hash.

The Approval Artifact binds:

- exact contract hash;
- rendered-authority hash;
- renderer version;
- resolved subject or app identity digest;
- task and workspace;
- policy and registry digests;
- approval session identity;
- approver identity and assurance level;
- timestamp and expiry.

Backend identity is resolved at dialog open and again at submit. Caller-provided
identity cannot satisfy this check.

Human approval MUST NOT override platform hard denies.

## 14. Revision and revocation

Revisions are immutable.

Revision n plus one MUST:

- reuse contractId;
- increment revision by one;
- bind previousRevisionHash to the active revision;
- activate through atomic compare-and-swap;
- receive new approval when authority broadens or registry bindings change.

Only one revision hash may be active. Losing forks are stale.

Revocation is a separately signed monotonic artifact stored outside restorable
workspace state. The MVP revocation scope is the complete contract lineage.

Revocation semantics have a defined linearization point:

```text
If revocation commits before COMMIT_PERMIT,
the effect MUST NOT begin.

If COMMIT_PERMIT commits first,
the operation may complete and must be attested.
```

Offline sensitive execution without fresh revocation state is prohibited.

Parent revocation, expiry, or supersession invalidates descendants and all
outstanding tickets.

## 15. Delegation

The agent does not sign child authority. It submits a child proposal to a host
Delegation Authority.

A child is valid only when all are true:

1. workspace binding matches;
2. audience is equal or narrower;
3. child validity is inside parent validity;
4. every child operation is allowed by parent;
5. every child selector is covered by parent;
6. test profiles are a subset;
7. effect classes are a subset;
8. numeric limits are no greater;
9. ambient authority is no broader;
10. registry bindings match;
11. remaining depth decreases;
12. parent permits delegation;
13. every ancestor is active and unrevoked.

If subset proof cannot be completed, delegation is denied.

Sibling agents share atomic lineage budgets. Parent budget is not copied to each
child. Authority from independent parents MUST NOT be unioned without an
explicit trusted join protocol.

## 16. Trusted effect registry

Effect class is assigned by a signed trusted adapter registry, never by the
model, MCP hints, HTTP method, tool annotations, or contract display text.

| Class                  | Meaning                                            | MVP                 |
| ---------------------- | -------------------------------------------------- | ------------------- |
| local.observation      | no intended durable mutation                       | allow               |
| local.reversible       | local mutation with before and after evidence      | allow               |
| local.versioned        | mutation recorded in a version graph               | disabled by default |
| sandbox.ephemeral      | code runs with durable effects confined to scratch | allow               |
| external.idempotent    | remote effect with enforced idempotency            | deny                |
| external.compensatable | external effect with separate compensation         | deny                |
| external.irreversible  | non-revocable external effect                      | deny                |
| unknown                | effect closure cannot be established               | deny                |

A registry entry binds adapter identity, adapter digest, operation, argument
schema digest, effect class, commit protocol, idempotency rules, observer
strength, reconciliation, approval, and secret-handling requirements.

The contract can only narrow allowed effect classes. It cannot override the
registry classification.

## 17. First-slice action vocabulary

| Action             | Rule                                 |
| ------------------ | ------------------------------------ |
| filesystem.stat    | selected objects only                |
| filesystem.list    | selected trees only                  |
| filesystem.read    | selected objects only                |
| filesystem.create  | selected trees, target absent        |
| filesystem.replace | selected file, before digest matches |
| filesystem.delete  | disabled in initial MVP              |
| filesystem.mkdir   | selected trees only                  |
| git.status         | trusted library adapter only         |
| git.diff           | trusted library adapter only         |
| git.commit         | disabled initially                   |
| git.push           | hard deny                            |
| test.run           | registered profile only              |
| network.request    | hard deny                            |
| secret.read        | hard deny                            |
| shell.exec         | hard deny                            |

Test code is untrusted. A test profile fixes executable digest, argv grammar,
working directory, sandbox image, read-only mounts, disposable scratch,
environment allowlist, resource limits, and network denial.

Repository-controlled test scripts, Git hooks, diff drivers, package scripts,
and credential helpers MUST NOT expand the profile's effect closure.

## 18. Guardian and runtime execution algorithm

Guardian and the trusted runtime process an action as follows:

1. authenticate caller principal and runtime instance;
2. strictly parse request and contract;
3. verify canonical bytes, hash, signature, signer role, and key status;
4. verify exact active contract hash and revision;
5. verify validity, subject, task, workspace, audience, runtime epoch, and all
   ancestors;
6. load exactly pinned policy and registries, then apply current mandatory deny
   overlay;
7. resolve adapter operation and effect class from the trusted registry;
8. parse action arguments against the trusted operation schema;
9. run Guardian's side-effect-free object/state PREPARE;
10. resolve resources using trusted object handles;
11. check action, selector, effect-class, ambient-authority, approval, and state
    preconditions;
12. atomically reserve budgets in the contract and every ancestor;
13. reject reused request IDs;
14. persist a PREPARED write-ahead record;
15. issue an opaque short-lived one-shot Execution Ticket;
16. the runtime pins the trusted adapter and obtains an inert prepared effect
    from `adapter.prepare`;
17. Guardian asynchronously revalidates active revision, revocation, registry
    bindings, resource state, runtime or session epoch, policy, and budget;
18. Guardian performs a final synchronous composite authority assertion;
19. the local kernel synchronously records COMMIT_PERMIT and consumes the
    ticket;
20. the runtime invokes the pinned prepared effect exactly once;
21. observe post-state and emit a signed Effect Attestation;
22. record terminal, failed-no-effect, or uncertain recovery state.

The runtime owns steps 16–20. The trusted adapter may construct an inert
prepared effect, but it does not control revalidation, the final authority
assertion, ticket consumption, or execution ordering.

The Execution Ticket MUST bind:

- contract hash and revision;
- subject, task, workspace, audience, and runtime epoch;
- action descriptor hash;
- canonical arguments hash;
- resolved object identity;
- state commitments;
- adapter and registry digests;
- effect class;
- revocation epoch;
- budget reservation;
- nonce and expiry.

The ticket is never returned to the model.

## 19. Action state machine

```text
PROPOSED
  ├─ DENIED
  ├─ ESCALATION_REQUIRED
  └─ AUTHORIZED
       ↓
     BUDGET_RESERVED
       ↓
     PREPARED
       ↓
     REVALIDATING
       ├─ STALE
       ├─ REVOKED
       └─ COMMIT_PERMIT
            ↓
          EXECUTING
            ├─ FAILED_NO_EFFECT
            ├─ UNCERTAIN
            └─ EFFECT_COMMITTED
                 ├─ RESULT_FINALIZED
                 └─ RESULT_UNAVAILABLE
                       ↓
                    ATTESTED
```

Once an effect may have begun, the action MUST NOT return to an executable
approved state.

Effect success plus result serialization failure yields
EFFECT_COMMITTED and RESULT_UNAVAILABLE. It does not create retry authority.

Ambiguous timeout or crash for a non-idempotent effect yields UNCERTAIN and
requires reconciliation. Automatic retry is prohibited.

## 20. Effect Attestation

An attestation binds:

- attestation and request IDs;
- ticket, contract, revision, and action hashes;
- delegation lineage hash;
- adapter, runner, executor, and observer identities and digests;
- effect class and registry revision;
- revocation or fencing epoch;
- pre-state and post-state digests where observable;
- idempotency key where applicable;
- result digest where available;
- budget charges;
- timestamps;
- terminal status;
- evidence level;
- reconciliation or compensation references;
- signer key and signature.

Allowed statuses include:

- denied;
- noop;
- committed;
- failed_no_effect;
- rolled_back;
- uncertain;
- committed_result_unavailable.

Evidence levels include:

- attempt_only;
- adapter_observed;
- local_state_reconciled;
- remote_provider_attested;
- independently_reconciled.

An attestation is evidence, not authority. It MUST NOT claim a stronger
observation level than the adapter supports.

## 21. Ledger and memory rules

The ledger stores non-sensitive integrity envelopes separately from encrypted
payloads.

Integrity envelopes contain identifiers, hashes, revisions, principal and
adapter identities, timestamps, status, previous envelope hash, signer, and
signature.

Raw prompts, secrets, full output, and sensitive tool results MUST NOT be placed
in the integrity envelope.

A local hash chain without an independently protected head does not prevent
full-history replacement. Production MUST protect periodic checkpoints in a
separate signing or storage boundary.

Memory content cannot grant authority. Instrumented lineage may mark known
descendants stale or invalidated, but CLODEx does not claim complete semantic
lineage through arbitrary reasoning.

## 22. Core security invariants

### IC-1 Model non-authority

Model output alone cannot activate a contract, issue a ticket, assign an effect
class, or sign an attestation.

### IC-2 Exact revision

Execution requires request.contractHash equal to the active hash, not only a
matching contract ID or revision number.

### IC-3 Complete mediation

Every modeled effect requires a valid one-shot ticket. A direct host effect is a
security defect.

### IC-4 Trusted effect classification

Effect class equals the pinned trusted registry entry. Caller classification is
ignored or rejected.

### IC-5 Object confinement

Every resolved object is covered by an authorized selector and accessed through
trusted handles.

### IC-6 Delegation attenuation

Every child is a proven subset of every ancestor.

### IC-7 Aggregate budgets

The sum of parent and descendant charges never exceeds ancestor limits.

### IC-8 State revalidation

Mutable state at COMMIT_PERMIT equals the authorized state commitment.

### IC-9 Revocation ordering

Revocation before COMMIT_PERMIT implies no target effect.

### IC-10 Replay resistance

At most one COMMIT_PERMIT exists for one request ID and ticket ID.

### IC-11 Denial non-effect

A denied action never reaches adapter execution.

### IC-12 No ambient authority

Executor does not inherit host credentials, unrestricted filesystem, network,
shell, or environment.

### IC-13 Crash-safe evidence

A committed effect has a signed attestation or a durable uncertain record and
resource quarantine.

### IC-14 Descriptive non-authority

Changing goal label, summary, risk hint, or explanation cannot authorize a new
action.

### IC-15 MVP external-effect exclusion

The first slice cannot execute an external effect class.

### IC-16 Effect closure

Every issued Execution Ticket reaches exactly one durable terminal class:
failed-no-effect, committed, uncertain, rolled-back, or expired-before-commit.
Every observed modeled effect maps to exactly one consumed ticket.

### IC-17 No blind retry

UNCERTAIN and committed-result-unavailable states never create implicit retry
authority. Recovery first reconciles the original effect or obtains a new
explicit authorization whose adapter proves idempotent replay.

## 23. Filesystem, Git, and test MVP

Example authority for “Fix authentication tests”:

- read workspace files;
- create or replace files only under src/auth and tests/auth;
- inspect Git status and diff;
- run profile tests.auth.unit;
- at most 12 unique modified files;
- at most 1 MiB mutation data;
- at most four test runs;
- no deletion;
- no shell;
- no network;
- no secrets;
- no commit or push;
- two-hour expiry;
- at most one delegation level.

Filesystem execution MUST use no-follow handle traversal. Replace uses a
same-filesystem temporary file, flush, atomic rename, and before/after digest.
Multi-file atomicity is not claimed in v1.

Git inspection uses a trusted library with hooks, external diff, textconv,
filters, pagers, credential helpers, and network disabled.

Test execution mounts the workspace read-only and places all writes in
disposable scratch. Network and host credentials are unavailable.

## 24. Artifact Bridge mini-contract profile

Artifact Bridge is a concrete follow-on profile. Its contract additionally
binds:

- generated app identity and manifest digests;
- app ID and owner principal;
- exact iframe session ID and navigation epoch;
- expected origin and document identity;
- grant ID and grant epoch;
- MCP server runtime identity;
- server configuration and endpoint digest;
- tool descriptor and input-schema digests;
- trusted effect classification and registry revision;
- adapter identity and version;
- canonical arguments hash;
- write and egress budgets;
- expiry and one-shot approval.

Every request and response is bound to a trusted document slot, Electron frame
revision, exact isolated app origin, session ID, navigation epoch, app identity,
and preview route revision. Artifact Bridge traffic uses a document-local
MessagePort retained by isolated preload and trusted main-process code; no
authority-bearing response is delivered through a WindowProxy. Navigation or
reload revokes the old session.

Approval becomes stale when any bound identity, descriptor, endpoint, schema,
effect class, adapter, policy, manifest, or session value changes.

Revoke is an execution fence. The final trusted check occurs immediately before
the irreversible tool call.

A successful write followed by oversized or unserializable result handling
remains terminal and non-retryable.

## 25. Verified current implementation status

Sections 1–24 define the broad normative target. This section records only the
currently verified implementation subset and MUST NOT be read as whole-spec
conformance or as production enablement of every described authority path.

Initial repository inspection on July 13, 2026 identified protocol and
build-truth gaps. Sessions 1–4 established the deliberately narrow Artifact
Bridge boundaries recorded below. Session 5 adds isolated, recording-only
component evidence; it does not extend production enforcement:

1. Pages sources remain part of mandatory build truth, while shared v2 protocol
   schemas and Pages compatibility code remain non-authoritative scaffolding;
   the current tree has no Pages Artifact Bridge RPC or handler, and Pages is
   not the production generated-app bridge;
2. production main constructs a `GeneratedAppIdentityResolver` and supplies
   its result to Artifact Bridge for supported local agent-generated apps only;
   package and plugin contexts resolve to `null`;
3. the resolver derives canonical manifest, executable-tree, asset-tree, and
   policy identity using bounded exact traversal and rejects aliases, links,
   mutation, and configured size, entry-count, or depth violations;
4. authority-bearing HTML and subresources are served from the exact resolver
   snapshot bytes that produced `assetHash`, rather than from a later live
   filesystem read;
5. canonical `clodexRev` navigation uses a one-shot provisional binding before
   parser subresources and an exact-nonce upgrade to the trusted broker
   binding. Port retirement closes the transport and serializes exact
   host-session suspension before reconnect activation, while preserving the
   content nonce during reconnect grace; same-document reconnect rotates the
   exact trusted document token. Content bindings are removed on
   navigation, explicit revoke, grace expiry, WebContents destruction, and
   teardown; history mutation cannot replace the active authority revision;
6. preview URLs retain the full-SHA-256 per-app isolated `app://` host, strict
   decoded-identity parser, private preload MessagePort, host-issued session,
   navigation epoch, frame broker validation, port-only response delivery, and
   ordered shutdown established in Session 2;
7. canonical review runs over a dedicated trusted `ui-main` transport whose
   reviewer identity is derived from the current Electron WebContents and main
   frame; renderer-selected generic roles cannot acquire reviewer authority;
8. the one-shot review path renders and revalidates exact manifest-, policy-,
   identity-, context-, selection-, and expiry-bound authority for the current
   read, ask-agent, and automation profile;
9. isolated generated apps are denied ambient external network access, and
   popup, target-blank, custom-protocol, and reveal-file requests fail closed
   before generic tab or operating-system handlers;
10. navigation synchronously clears the exact content binding and closes the
    old port; backend host-session close or suspension is serialized before a
    reconnect can activate. After an awaited descriptor lookup, the current
    direct read-only MCP path rechecks that host binding immediately before
    `callTool`, so a suspended or replaced document cannot begin that effect;
11. the focused Session 3 suite passes **252/252 tests across 18 files**, and
    the exact-byte/revision subset passes **97/97**. Pages, backend,
    web-content-preload, and the complete browser typecheck also pass;
12. no packaged Electron smoke is claimed. Package/plugin authority remains
    unsupported, and write and ephemeral-grant feature-gate defaults remain
    unpromoted;
13. Session 4 now assigns each current grant a unique runtime ID and monotonic
    revision backed by a shared synchronous revoke fence. Replacement, expiry,
    session close, and revoke invalidate derived proposals and operations;
14. persistent grant save/revoke is serialized and staged through durable
    `pendingMutations`. Ambiguous or incomplete mutations cannot publish
    authority and are removed during startup reconciliation. Audit records use
    prepared-only semantics rather than claiming atomic commit across the audit
    and grant stores;
15. production startup verifies and wires the durable audit ledger as recorder
    and reader. Audit corruption is sticky, and audit/persisted writes fsync the
    file and containing directory where supported;
16. MCP effects commit the local server configuration and endpoint,
    configuration revision, sensitive-enforcement profile, runtime/catalog
    generation, complete locally cached
    descriptor/schema/annotations, trusted
    classification, adapter version, canonical arguments, policy, grant,
    identity, and document generation. The exact commitment is recomputed in
    the supervisor-side callback after its final await and before IPC dispatch.
    The remote MCP server does not accept a descriptor version/hash, so equality
    with remote execution semantics is not claimed;
17. MCP host protocol v6 carries per-connection identity. Host, supervisor, and
    registry reject stale close, list-change, catalog, and out-of-order connect
    results across connection replacement races;
18. reviewed MCP write and sensitive calls use an encrypted durable WAL with
    `PREPARED`, `DISPATCHING`, `COMMITTED`, `RESULT_UNAVAILABLE`, `UNCERTAIN`,
    and `FAILED_PRE_EFFECT` states. A consumed ticket never returns to an
    approved state, and interrupted dispatch recovers as `UNCERTAIN`;
19. ask-agent and automation have adapter-side callbacks after their last
    application-owned await. AutomationService requires callback consumption,
    rechecks its gate for manual/startup/scheduled paths, and Artifact Bridge
    automation uses a single attempt with strict failure propagation and a
    redacted minimal result;
20. MCP, automation, and sensitive MCP asynchronous operations use an
    operation-local one-shot final fence. Timeout, cancellation, adapter
    failure, revoke, or session close after final dispatch produces retained
    `uncertain` evidence. Proposal/ticket expiry and async/sensitive kill
    switches are rechecked at final dispatch;
21. approval-audit failure does not expose a write/sensitive token. The
    write-ambiguous attempt is closed as `FAILED_PRE_EFFECT` or `UNCERTAIN`, and
    a fresh proposal/review is required instead of retrying the same append;
22. the complete browser suite passes **2215/2215 tests across 269 files**, the
    exact-byte/revision subset remains **97/97**, MCP runtime passes **27/27**,
    targeted agent-core create-handler passes **8/8**, relevant typechecks and
    MCP host build pass, and bundled assets validate. Universal WAL/replay
    closure for direct ask-agent, automation, and ordinary async MCP effects,
    review-bound automation definition/model-adapter commitment, and durable
    closure or compensation for the composite create-agent→mount/message effect
    remain incomplete. Runtime grant revisions do not prove durable anti-rollback,
    and the local audit chain has no independently protected head.
23. Session 5 adds ten independent `@clodex/*` reference packages without
    importing legacy browser implementations. They remain disconnected from
    production authority and do not promote any feature-gate default;
24. the reference runtime owns the two-phase order
    `adapter.prepare → Guardian.revalidateExecutionTicket → synchronous
Guardian.assertFinalAuthority → synchronous Kernel.commitPermit →
preparedEffect.execute`. The prepared effect is pinned and invoked once
    only after an exact permit. Accessor-based prepared `execute` is rejected
    without evaluation. Prototype, symbol, non-enumerable, accessor, or
    extra-field permit drift after local ticket consumption closes `uncertain`
    before execute and cannot be retried. Side-effect-free PREPARE is a trusted
    adapter assumption, not an enforced sandbox property;
25. Session 5 core package tests pass **85/85**: contracts **36/36**, Guardian
    **19/19**, kernel **13/13**, and runtime **17/17**. Root typecheck passes
    **25/25 Turbo tasks**, dependency/import and provenance checks pass, and
    independent-boundary tests pass **38/38**;
26. the reference kernel and runtime evidence sink are in-memory. The separate
    signed-evidence and durable-ledger references are not atomically linked to
    ticket consumption or effect settlement, and no independently protected
    ledger/checkpoint head exists;
27. Session 5 has no OS-backed filesystem, Git, or test adapter, no
    host-workspace mutation, no resource-state CAS against a real effect, no
    browser migration or production main wiring, no feature-gate promotion or
    default change, and no packaged Electron smoke claim;
28. the ticket commits `runnerRegistryDigest`, while the attested
    `runnerId`/`runnerDigest` comes from a trusted constructor port. The current
    slice does not verify that concrete runner identity as a member of the
    committed runner registry;
29. `@clodex/approval` implements a canonical authority-only Approval Artifact,
    trusted reviewer snapshots, DSSE verification, exact current commitments,
    bounded validity, one-shot replay, and final synchronous trust/commitment
    fences. It passes **32/32** tests, but has no production UI, key custody, or
    durable replay store;
30. `@clodex/ledger` implements a single CAS record for ticket state, effect
    attempt, immutable evidence expectation, and evidence admission outbox. It
    enforces reachable revisions, global identity reservation, bounded scans,
    one-shot verified admission receipts, and conservative recovery, passing
    **30/30** tests;
31. `@clodex/evidence` implements canonical executor/observer signatures,
    trust epoch/registry snapshots, a final synchronous signer-set trust fence,
    idempotency replay prevention, bounded hash chains, and checkpoint
    fork/rollback detection, passing **28/28** tests. Its default ledger and
    checkpoint adapters are memory-only and unprotected;
32. `@clodex/adapters` implements capability-scoped reference protocols for
    filesystem create/replace/mkdir, Git status/diff, and registered test
    profiles. Workspace/task audience is checked before any port call, full
    workspace/task/root scope is propagated, and mixed-scope registries are
    rejected. It passes **31/31** tests but does not implement `openat2`, Git,
    Docker/VM, host workspace, network, credentials, or shell;
33. `@clodex/ledger-node` implements a bounded trusted-local-POSIX snapshot
    adapter with private locking, file and directory `fsync`, atomic rename,
    post-rename exact read-back reconciliation, inode pinning, restart reads,
    and multi-process CAS, passing **17/17** tests. It has no protected head,
    anti-rollback anchor, same-UID `openat2` path-race defense, or automatic
    stale-lock recovery;
34. `@clodex/promotion` implements fail-closed eligibility over exact release
    evidence, trusted time/hash, and a final current-state fence, passing
    **7/7** tests. It has no API that enables a feature gate. Across all ten
    independent Session 5 packages, **230/230** tests pass. Independent audit
    found no remaining P0/P1 issue inside their stated reference boundaries.

Current classification:

| Area                                           | Status                     |
| ---------------------------------------------- | -------------------------- |
| Pages compile/shared protocol scaffolding      | TESTED, NON-AUTHORITY      |
| document-bound transport path                  | ENFORCED                   |
| local-agent identity resolver                  | ENFORCED, SUPPORTED SCOPE  |
| package/plugin Artifact Bridge authority       | UNSUPPORTED, FAIL-CLOSED   |
| exact snapshot-byte and `clodexRev` lifecycle  | ENFORCED, LOCAL AGENT APPS |
| trusted `ui-main` reviewer transport           | ENFORCED                   |
| canonical read/ask-agent/automation review     | ENFORCED, CURRENT PROFILE  |
| isolated-app external network and popup egress | ENFORCED                   |
| grant/revocation final-dispatch fence          | ENFORCED, CURRENT ADAPTERS |
| local MCP dispatch-snapshot commitment         | ENFORCED, ARTIFACT BRIDGE  |
| remote-server descriptor/version identity      | UNVERIFIED                 |
| reviewed MCP write/sensitive WAL and no-retry  | ENFORCED, NARROW PROFILE   |
| async terminal `uncertain` handling            | ENFORCED, CURRENT PROFILE  |
| isolated one-shot Execution Ticket semantics   | TESTED, RECORDING-ONLY     |
| runtime-owned two-phase reference closure      | TESTED, RECORDING-ONLY     |
| canonical independent Approval Artifact        | TESTED, NOT PRODUCTION UI  |
| logical ticket/effect/evidence CAS ledger      | TESTED, INDEPENDENT        |
| local POSIX ledger snapshot adapter            | TESTED, TRUSTED PATH ONLY  |
| dual-signed evidence chain/checkpoints         | TESTED, REFERENCE STORAGE  |
| capability-scoped fixed adapter protocols      | TESTED, NO OS ENFORCEMENT  |
| fail-closed promotion eligibility              | TESTED, NO GATE AUTHORITY  |
| concrete runner-registry membership            | NOT IMPLEMENTED            |
| real filesystem/Git/test OS mediation          | NOT IMPLEMENTED            |
| durable Session 5 ticket/evidence transaction  | BLOCKED                    |
| universal durable effect closure               | BLOCKED                    |
| production write/sensitive/async promotion     | NOT PROMOTED               |
| universal effect attestation and recovery      | NOT ACTIVE                 |
| packaged Electron validation                   | NOT VERIFIED               |
| whole-spec production security guarantee       | UNVERIFIED                 |

`ENFORCED` means source-level production wiring plus focused tests only for the
scope named in the corresponding row. It does not imply packaged Electron
validation, package/plugin authority, generalized write or asynchronous-effect
safety, or conformance to the broad Intent Contract target.

`TESTED, RECORDING-ONLY` means the isolated Session 5 component property has
executable tests. It does not mean production enforcement, durable recovery,
host effect mediation, or sandbox confinement.

## 26. Artifact Bridge enablement order

Production write authority MUST remain unpromoted until all phases pass. The
existing feature-gate configuration is not evidence of completed mediation.

### Phase A: CI and protocol truth — completed in Session 1

- add Pages compilation to required CI;
- converge on one protocol and one shared schema;
- reject v1 and missing sessions;
- add cross-layer schema compatibility tests.

### Phase B: document-bound transport — completed in Session 2

- construct and validate per-app isolated origins;
- retain the authority-bearing MessagePort and session binding outside
  generated app JavaScript;
- wire the main-process frame broker as the sole production generated-app
  transport;
- implement connect, close, rotation, and navigation epochs against trusted
  Electron document identity;
- deliver responses only through the captured document-local port;
- keep Pages compatibility code outside the production authority-bearing path;
- pass focused reload, navigation, replacement-document, close, teardown, and
  concurrent-preview tests through production wiring.

Phase B completion does not claim packaged Electron smoke or activate any
capability/effect authority.

### Phase C: local-agent resolution and canonical current-profile review — completed in Session 3

- wire the production identity resolver for supported local agent apps while
  keeping package and plugin authority fail-closed;
- bind identity to canonical manifest, executable-tree, asset-tree, and policy
  digests with exact snapshot-byte serving;
- bind `clodexRev`, provisional parser access, trusted broker upgrade, session,
  port-close host-session suspension, reconnect-grace nonce preservation, and
  same-document trusted-token rotation to one exact document generation;
- derive reviewer authority from trusted `ui-main` WebContents and main-frame
  identity;
- render and revalidate one-shot canonical authority for the current read,
  ask-agent, and automation profile;
- deny ambient external network and popup/OS-protocol egress from isolated
  generated apps;
- recheck exact host binding after descriptor lookup and immediately before the
  current direct read-only MCP dispatch.

Phase C completion does not claim packaged Electron smoke, package/plugin
authority, write or ephemeral-grant promotion, or a universal final-dispatch
fence.

### Phase D: generalized authorization-to-effect safety — in progress in Session 4

- bind grant and revocation epoch at the final effect boundary;
- commit server, endpoint, descriptor, schema, annotation, trusted effect
  class, adapter, arguments, policy, and contract revision;
- apply a universal final execution fence to write, sensitive-egress, and
  asynchronous operations;
- persist a durable write-ahead effect record and one-shot commit token;
- define terminal committed-result-unavailable and uncertain states;
- prohibit blind retry and invalidate all derived proposals when their parent
  authority becomes stale.

Current Phase D checkpoint implements these requirements for Artifact Bridge
MCP effects and final adapter fencing, including durable reviewed write and
sensitive-call closure plus async `uncertain` handling. Phase D is not complete
until direct ask-agent and automation effects have universal durable replay
closure and their exact action/adapter identity is review-bound.

The Session 5 recording-only reference separately tests the runtime-owned order
`adapter.prepare → Guardian revalidation → synchronous final authority →
synchronous local COMMIT_PERMIT → preparedEffect.execute`, including
fail-closed permit-shape validation before execute. It does not complete Phase D
or permit promotion because local synchronous linearization is neither durable
nor cross-process, and the slice uses an in-memory kernel/evidence path and no
real filesystem, Git, test, browser, or production adapter.

### Phase E: adversarial E2E — after generalized effect safety

Required tests include:

| Scenario                               | Expected                                        |
| -------------------------------------- | ----------------------------------------------- |
| v1 or missing session                  | deny                                            |
| stale navigation epoch                 | deny                                            |
| navigation during request              | old response not delivered to new document      |
| identity changes during review         | approval invalidated                            |
| descriptor or endpoint changes         | stale approval                                  |
| revoke during awaited lookup           | no effect begins                                |
| write succeeds and result is oversized | exactly one effect                              |
| serialization fails after effect       | token stays consumed                            |
| automatic grant invalidation           | all derived proposals invalidated               |
| caller spoofs reviewer identity        | deny                                            |
| parallel children spend final budget   | exactly one reservation wins                    |
| audit sink is unavailable              | specified fail-closed or explicit degraded mode |

## 27. Required negative conformance tests

At minimum:

1. duplicate JSON key;
2. unknown field or schema version;
3. noncanonical set ordering;
4. signature byte mutation;
5. old revision hash;
6. competing revision fork;
7. revoked parent and active child;
8. child selector broader than parent;
9. sibling budget oversubscription;
10. ticket replay;
11. parent traversal, NUL, and absolute path;
12. symlink, hardlink, junction, or mount swap;
13. Unicode or case-fold collision;
14. caller effect-class downgrade;
15. adapter digest mismatch;
16. test network attempt;
17. test read of host credentials;
18. test persistent write outside scratch;
19. state change after authorization;
20. revocation and COMMIT_PERMIT in both race orders;
21. crash before effect;
22. crash after effect before attestation;
23. result serialization failure after effect;
24. ledger unavailability;
25. model direct executor call;
26. receipt replay as ticket;
27. secret-read plus network capability composition;
28. batch with one forbidden nested action.

All negative tests fail closed. A DENY produces no target effect. Crash tests end
in deterministic recovery or UNCERTAIN plus quarantine.

## 28. CLODEx implementation boundaries

Target ownership:

```text
packages/clodex-contracts
  contract, approval, ticket, attestation types

packages/clodex-guardian
  verifier, conformance, delegation, ticket issuance

packages/clodex-kernel
  lifecycle, revisions, revocation, budgets, reservations

packages/clodex-runtime
  runtime-owned adapter PREPARE, Guardian final fence, synchronous local
  COMMIT_PERMIT,
  prepared-effect dispatch, execution state machine

packages/clodex-ledger
  integrity envelopes, checkpoints, reconciliation

packages/clodex-evidence
  attestations, provenance references, memory admission

apps/browser
  migration adapter and canonical approval UI
```

Independent packages MUST NOT import legacy browser implementations.

## 29. Acceptance criteria

The first slice is complete only when:

1. model proposal alone cannot execute;
2. canonical approval renders the exact authority;
3. approved hash equals issued hash;
4. writes outside selected trees are denied;
5. network, secrets, delete, shell, commit, and push are denied;
6. stale, superseded, expired, or revoked authority cannot execute;
7. a child cannot exceed its parent;
8. state mutation after authorization makes the request stale;
9. a committed effect is not repeated after result failure;
10. every effect has an attestation or durable uncertain record;
11. fault injection covers every transition;
12. LLM, summaries, memory, and MCP metadata remain outside the TCB.

The Session 5 recording-only reference tests only isolated portions of these
criteria. It does not satisfy acceptance for real filesystem/Git/test effects,
durable crash recovery, signed evidence, sandbox confinement, or production
wiring.

## 30. Current implementation blockers

The current repository cannot claim conformance until at least these confirmed
boundaries are corrected:

1. sandbox remote module loading can execute host-scope imports;
2. isolated filesystem path and file-descriptor handling permits mount-policy
   bypasses, including symlink-parent and read-only write cases;
3. OpenManus host execution is not mediated by the required Guardian and OS
   sandbox boundary;
4. universal tool mount resolution and swarm auto-mounting do not preserve
   strict per-agent authority;
5. ShellCapabilityBroker exists but is not wired into production shell
   execution;
6. cloud ownership fencing is not enforced at the final local execution
   boundary;
7. MCP enforcement is not centralized at every registry callTool boundary;
8. Artifact Bridge now has grant epochs, exact MCP commitments, final-dispatch
   fences, reviewed MCP write/sensitive WAL closure, and async `uncertain`
   handling. Universal WAL/replay closure for direct ask-agent and automation
   effects plus review-bound automation definition/model-adapter commitment
   remain incomplete, so production write promotion is still blocked;
9. the Session 5 packages are an isolated recording-only reference with an
   in-memory kernel and evidence sink. Synchronous `COMMIT_PERMIT` is local
   in-process linearization, not a durable or cross-process commit. The packages
   are not wired into the browser, host workspace, or any production authority
   path;
10. ticket consumption, terminal settlement, evidence admission, and
    attestation output are not one durable crash-safe transaction/outbox;
11. Effect Attestations are validated objects but are not signed or protected
    by an independently anchored ledger head;
12. no real filesystem, Git-inspection, or test adapter proves object-level
    confinement. The `openat2`/no-follow helper, hardened Git observation, and
    digest-pinned networkless test runner remain unimplemented;
13. real-effect `stateCommitmentHash` CAS at `COMMIT_PERMIT`, a canonical
    Approval Artifact, and production crypto/key-store integration remain
    unimplemented;
14. `runnerRegistryDigest` is committed, but the concrete attested
    `runnerId`/`runnerDigest` is not checked for membership in that registry.

Passing unit tests for an isolated component do not establish any end-to-end
security property while these bypasses exist.

No feature-gate default change, production promotion, host-workspace write, or
packaged Electron smoke is claimed by the Session 5 reference slice.

## 31. Claim discipline

After implementation and evaluation, CLODEx may claim:

- deterministic conformance checking for the specified domain;
- cryptographic binding of issued authority to immutable revisions;
- bounded delegation under the implemented subset relation;
- one-shot replay resistance under stated TCB assumptions;
- measured TOCTOU and recovery behavior for instrumented adapters;
- evidence-level attestations under explicit observer assumptions.

CLODEx must not claim:

- proof of true human intent;
- proof of general necessity;
- universal prompt-injection prevention;
- universal exactly-once external execution;
- proof that every external effect occurred;
- perfect semantic provenance;
- safety after Guardian, adapter, executor, kernel, or key compromise;
- production enforcement before end-to-end wiring and negative tests pass.

## 32. Central statement

CLODEx uses signed deterministic Intent Contracts as the bounded authorization
boundary for agentic execution. LLMs may propose contracts, but only trusted
policy or canonical human approval can activate an immutable revision.
Guardian deterministically verifies conformance and issues a short-lived
one-shot Execution Ticket for an exact action. Trusted adapters revalidate
immediately before effects and emit signed evidence-level attestations with
explicit observer assumptions.

```text
LLM proposes.
Policy or human authorizes.
Guardian enforces.
Adapters attest.
Ledger preserves evidence.
CI and runtime invariants prevent regression.
```
