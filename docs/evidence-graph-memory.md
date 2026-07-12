# Evidence Graph Memory

## Status

Phase 1 is integrated behind feature gates. The protected ledger now performs
deterministic, LLM-free claim extraction for user constraints, explicit
decisions, file operations, verification results, and tool failures. Every
persistent agent step builds a token-bounded Context Pack in shadow mode;
Guarded Memory Injection v1 is independently gated and compressed history
remains the fallback. Injection is model-only and fails closed unless the host
can prove a current repository/dirty-patch identity, direct event provenance,
resolved truth, current fingerprints, retrieval quality, and rendered token
budget. A task-scoped Memory Inspector exposes admitted, rejected, and consumed
decisions behind a separate development gate.

Validation snapshot (July 12, 2026): all 88 focused Evidence Memory service
tests pass. The deterministic 1,000-observation quality suite reports 100%
fact recall, 0% stale injection, 100% synchronization convergence, 0% false
automatic merges, and 79.5% token savings. The 100-observation paired replay
reports 100% guarded recall, a 20-point recall lift, 0% stale leakage, and 10%
token overhead. These fixtures establish regression readiness; production
injection still requires a fresh signed real-task dogfood cohort.

## Problem

The existing task-memory pipeline has two useful but deliberately separate
properties:

1. Full task history is archived losslessly as Markdown and JSONL.
2. Old active context is compressed into a bounded LLM-generated briefing.

The archive is not automatically retrieved, while the active briefing is lossy.
Evidence Graph Memory adds provenance-aware retrieval without removing either
existing behavior.

## Safety invariants

- Existing history compression remains the fallback until retrieval passes the
  evaluation suite and is enabled through a feature gate.
- A memory-storage failure must never stop an agent step.
- Task and workspace identifiers are not stored in plaintext query indexes.
- Event payloads are protected at rest when host data protection is available.
- Cross-workspace retrieval is denied by default.
- Code evidence is not injected after its repository or symbol fingerprint has
  become stale.
- Claims without evidence cannot be treated as high-confidence active facts.
- Retrieved claim text is escaped and marked as historical data with no
  instruction authority.
- Raw retrieval queries are never repeated in injection-decision events; only
  their protected query hash, selected claim IDs, reason codes, token count,
  policy hash, and repository identity are recorded.

## Cross-epic boundaries

Evidence Graph Memory must remain independently shippable from the other
platform epics:

- Provider-neutral model routing is consumed only through the existing model
  host/provider contracts; Evidence Memory does not hard-code a provider.
- Session Teleporter and Decoupled Execution own transport. Their only shared
  state boundary with memory is the canonical `WorkspaceSnapshot` /
  session-checkpoint contract (repository revision, file hashes, dirty patch
  metadata, and execution target identity).
- Generated App Capability Bridge is an isolated browser capability surface
  and receives no direct access to the evidence database or encryption keys.
- Evidence Memory storage, hybrid retrieval, prompt injection, inspector, and
  rollout telemetry each have independent feature gates. Disabling any one of
  them must leave the current compressed-memory and local execution paths
  operational.

No implementation may introduce a second workspace-snapshot shape merely for
Evidence Memory. Repository validity must adapt the shared snapshot contract or
use the CodeGraph provider seam.

## Architecture

```text
agent events
  -> protected append-only event ledger
  -> deterministic claims and provenance
  -> lexical and structural retrieval
  -> shadow Context Pack
  -> staleness and contradiction checks
  -> guarded prompt injection
  -> optional semantic retrieval and reranking
```

## Milestones

### M1 — Event ledger

- SQLite schema and migrations.
- Task/workspace-scoped event recording.
- Protected fields and fail-closed reads.
- Deterministic event types.
- Restart and data-protection tests.

### M2 — Claims and lexical retrieval

- Claims, evidence, entities, and typed relations.
- FTS5 or a protected lexical-index equivalent.
- Token-budgeted Context Pack generation in shadow mode.

### M3 — Repository validity

- Repository revision and file content hashes.
- Stable symbol identities and body fingerprints.
- CodeGraph expansion and stale-evidence refresh.

Current implementation status: revision-bound claims are classified as
`current`, `stale`, or `unbound` during retrieval. Stale claims are excluded
from Context Packs by default and their IDs are retained in shadow-run
telemetry so refresh behavior can be evaluated without exposing repository
revisions in plaintext.

File and symbol evidence now has a durable fingerprint lifecycle:

- file bytes and exact symbol bodies receive independent SHA-256 fingerprints;
- expected and last-observed fingerprints are stored separately, so validation
  never silently rebases stale evidence;
- paths, symbol identities, repository revisions, and CodeGraph expansion are
  protected at rest;
- the local CodeGraph provider resolves exact `path#symbol` references and
  captures bounded caller/callee neighborhoods;
- Context Pack construction can refresh fingerprints automatically and
  fail-closed by excluding changed, missing, or unresolved code evidence;
- an explicit `acceptCurrent` operation is required to make refreshed code the
  new evidence baseline.

Live CodeGraph Refresh v1 is connected to the Browser host for a single indexed
workspace. Before a code-backed claim can be injected, the provider refreshes
authoritative file bytes, exact symbol bodies, repository/dirty-patch identity,
and bounded caller/callee context. The complete refresh has a five-second
deadline, individual CLI processes have a three-second timeout, and cancellation
is propagated to the child process. Timeout, stale, missing, and provider-error
outcomes fail closed and are recorded as task-scoped fingerprint refresh
receipts for the Inspector.

### M4 — Truth lifecycle

- Subject version chains.
- `supersedes`, `invalidates`, `narrows`, `expands`, `confirms`, and
  `contradicts` relations.
- Deterministic active-claim selection.

Current implementation status:

- lifecycle edges update the superseded or invalidated target atomically;
- mixed `supersedes`/`invalidates` cycles are rejected;
- destructive lifecycle edges cannot connect unrelated subjects;
- confirmed claims form one support group and are ranked deterministically by
  active status, evidence count, confidence, recency, and stable ID;
- multiple surviving groups fail closed as `conflicted`, with explicit
  `contradicts` edges distinguished from implicit unresolved competition;
- stale, superseded, and invalidated claims are returned as exclusions rather
  than silently participating in the selected truth.

### M5 — Controlled injection

- Evidence blocks with provenance.
- Token optimizer and deduplication against recent/compressed context.
- Development, dogfood, canary, beta, and default-on rollout.
- Immediate fallback to compressed history.

### M6 — Hybrid retrieval and product surface

- Local embeddings and hybrid ranking.
- Reranking and retrieval cache.
- Memory inspector, evidence explanation, export, reset, and corrections.
- Full security and evaluation dashboards.

Current implementation status:

- `evidence-memory-inspector` independently gates a trusted settings surface;
- inspection is task-scoped and bounded to at most 500 events/claims per
  request;
- claim details expose provenance events, lifecycle relations, fingerprints,
  truth resolution, and explicit exclusions;
- export writes portable decrypted JSON with owner-only file permissions and
  never copies the raw SQLite database;
- reset removes only the selected task in one transaction and also clears its
  lexical and local-embedding indexes;
- raw claim/event content is returned only through explicit Karton procedures,
  never through telemetry.

## Baseline and evaluation

The current compressed-memory implementation is the baseline. Evaluation
fixtures must cover:

- exact flag or UUID recovery after 100, 300, and 1,000 events;
- user-constraint recovery;
- stale code after repository mutation;
- superseded decisions;
- IDE restart;
- fork inheritance and task isolation;
- workspace isolation;
- token cost and retrieval latency.

Initial production targets:

```text
Exact fact recall                  >= 95%
User constraint recall            = 100%
Stale evidence injection          < 1%
Restart recovery                  = 100%
Lexical retrieval p95             < 50 ms
Context Pack build without graph  < 100 ms
Default evidence overhead         <= 15k tokens
```

`runEvidenceMemoryEvaluation` reports exact-fact recall, constraint recall,
restart recovery, stale-evidence injection rate, overall recall, p50/p95
latency, average/maximum/total estimated tokens, scenario count, and exact
failed scenario IDs. `createEvidenceMemoryEvaluationFixture` produces
deterministic 100/300/1,000-event datasets without model calls. Restart
recovery is tested by closing and reopening the durable SQLite ledger before
retrieval.

### Unified Memory Quality Evaluation

`evaluateEvidenceMemoryQuality` combines retrieval and synchronization safety
into one promotion report:

- exact fact recall;
- stale-memory injection rate;
- expected synchronization convergence;
- false automatic merge rate against labelled safe/unsafe merge scenarios;
- absolute and relative token savings against a supplied baseline.

The deterministic `createEvidenceMemoryQualityFixture` supports 100, 500, and
1,000 observations and includes safe append-only merges plus unsafe
same-identity conflict cases that must remain manual.

Default promotion thresholds:

```text
Observations                    >= 100
Synchronization observations   >= 20
Unsafe merge coverage           >= 10
Fact recall                     >= 95%
Stale-memory rate               <= 1%
Convergence                     >= 99%
False automatic merge rate      = 0%
Token savings                   >= 30%
```

Run the reproducible suite with:

```bash
pnpm --dir apps/browser eval:evidence-memory-quality
```

The generated JSON contains only aggregate counters, rates, policy identity,
and blocker codes. Observation identities, prompts, facts, paths, and event
payloads are not written to the report.

### Memory Dogfood & Promotion Suite

`runEvidenceMemoryDogfoodComparison` runs Guarded Memory and the current
compressed-history baseline over the same task-scoped scenarios. Baseline
judging remains an explicit adapter because compressed history is free-form
model output; the suite itself is deterministic and does not call a model.

Promotion evidence is reduced to content-free observations:

- SHA-256 scenario identity;
- expected, recovered, forbidden, and leaked counts;
- baseline and guarded token counts;
- baseline and guarded latency;
- missing-provenance and unresolved-contradiction safety counters.

The protected `memory_dogfood_evaluated` receipt contains only aggregate
metrics, threshold version, policy hash, readiness, and blocker codes. It never
contains prompts, queries, claim IDs, repository paths, or recovered text.

Default promotion policy fails closed unless all conditions hold:

```text
Observations                         >= 100
Guarded recall                       >= 95%
Recall lift over compressed history  >= 10 percentage points
Guarded stale leakage                <= 1%
Guarded retrieval p95                <= 250 ms
Incremental token overhead           <= 20%
Missing-provenance admissions        = 0
Unresolved contradiction injections  = 0
```

The Browser Inspector exposes guarded recall, baseline recall, recall lift,
stale leakage, token overhead, p95 latency, sample count, policy identity, and
the exact promotion blocker list. Promotion evidence is advisory only and does
not enable `evidence-memory-prompt-injection`.

#### Live long-task dogfood

Real-task collection starts automatically once a persistent task has produced
its first compressed history. On each later model step:

1. The latest compressed summary is read without changing it.
2. A normal Context Pack is built from the current task query and repository
   identity.
3. If prompt injection is disabled, the production admission policy is run in
   shadow mode without authority to modify the prompt.
4. The retrieved current claims become the deterministic relevance oracle.
5. A local lexical judge measures which exact claim anchors survived in the
   compressed summary.
6. Only a content-free `memory_dogfood_observed` event is persisted.
7. The latest bounded observation window is evaluated and a protected
   `memory_dogfood_evaluated` receipt is appended.

The collector performs no additional model call. Compressed text, queries,
claim text, paths, and repository revisions are never copied into dogfood
events. Scenario identity is SHA-256-based, stale claims are bounded to the
same maximum-claim policy as injection, and observation aggregation is capped
at 500 recent pairs per task.

The Inspector displays progress toward the first 100 paired observations.
Collection does not grant injection authority: when the prompt-injection gate
is off, the production admission result remains shadow-only.

#### Dogfood operations and promotion cohort

The operational layer maintains a second, synthetic task-scoped cohort ledger.
Every live or replayed observation is copied there only after it has already
been reduced to content-free counters. The cohort stores a one-way task hash,
never the source task ID or archive contents.

Promotion uses a rolling 30-day window capped at the latest 500 observations.
The default cohort requires at least three distinct tasks and the following
scenario mix:

```text
Exact facts       45
User constraints  20
Staleness         15
Supersession      10
Restart           10
```

Observations outside the freshness window are reported as expired and cannot
satisfy promotion thresholds.

The trusted Inspector can explicitly run historical replay. Backfill:

- reads the protected `memory/index.json` registry;
- opens bounded `history.jsonl` archives through `ProtectedFileStorage`;
- finds real compressed-history boundaries;
- reconstructs the following user/assistant query window;
- runs current retrieval and shadow admission without modifying prompts;
- emits stable, idempotent restart and supersession observations;
- caps one run at 100 archives and 250 observations;
- skips corrupt JSONL lines and fails closed on oversized archives.

The cross-task dashboard shows fresh pairs, distinct tasks, expired evidence,
category coverage, aggregate recall/leakage/latency/token metrics, and exact
promotion blockers. Historical replay is user-triggered and never invokes a
model.

#### Trace replay and CI promotion gate

The trace replay harness consumes the same content-free paired observations
produced by live dogfood. It accepts either a versioned JSON bundle or JSONL
with one observation per line, deduplicates by the SHA-256 scenario identity,
and evaluates the complete fresh cross-task cohort policy.

Replay fails closed when an observation is malformed or duplicated. The
generated receipt contains aggregate metrics, policy and trace-set hashes,
coverage counts, and blocker codes; it does not contain task identities,
scenario identities, prompts, claims, paths, or repository content.
External promotion traces must also carry a fresh `observedAt` timestamp on
every observation; timestamp-free deterministic fixtures remain valid only for
the non-production regression gate.

```bash
pnpm --dir apps/browser eval:evidence-memory-trace-replay -- \
  --input content-free-observations.jsonl
pnpm --dir apps/browser check:evidence-memory-promotion
```

`check:evidence-memory-promotion` runs both the deterministic unified quality
suite and paired trace replay. It is wired into pull-request CI and Browser
release promotion. The built-in 100-observation replay is a deterministic
regression fixture; enabling production injection still requires a fresh real
dogfood cohort collected in shadow mode.

### Signed promotion evidence and canary rollout

Prompt injection has a separate channel policy:

```text
dev         canary-100
prerelease  shadow
nightly     shadow
release     hold
```

Advancing a production channel follows only
`shadow -> canary-5 -> canary-25 -> canary-100`. Task assignment is a stable
SHA-256 bucket, so the same task cannot move between treatment and control
groups across restarts.

Promotion requires an Ed25519-signed, maximum-48-hour envelope that binds:

- the exact source commit;
- the unified quality artifact byte hash and policy hash;
- the external content-free trace replay byte hash, policy hash, and trace-set
  hash;
- the requested next canary stage and expiry.

```bash
pnpm --dir apps/browser collect:evidence-memory-promotion -- \
  --trace apps/browser/test-results/evidence-memory-trace-replay.json \
  --private-key /secure/evidence-memory-ed25519-private.pem \
  --public-key /secure/evidence-memory-ed25519-public.pem \
  --source-commit <source-git-sha> \
  --delivery-mode repository-evidence-commit \
  --target-stage canary-5

pnpm --dir apps/browser check:evidence-memory-rollout -- \
  --channel prerelease \
  --require-evidence \
  --public-key /secure/evidence-memory-ed25519-public.pem \
  --build-commit <evidence-only-commit-sha>
```

Passing dogfood and replay gates creates a promotion candidate; it is not human
release approval. The authorized release owner must review the aggregate
receipts for a clean, immutable release commit and run the collector with the
release-owned private key. Ephemeral or developer-generated keys may be used to
test the signing path, but their artifacts must stay outside
`.release-evidence/` and must be labelled local-only.

The runtime also maintains an automatic circuit breaker. After at least 20
fresh paired observations it immediately disables prompt injection when recall
falls below 95%, stale leakage exceeds 1%, p95 exceeds 250 ms, provenance is
missing, or an unresolved contradiction reaches injection. The rollback is
restored from the durable cohort after restart, and
`CLODEX_DISABLE_EVIDENCE_MEMORY_INJECTION=1` provides an emergency kill switch.

## Event-ledger v1

The first implementation records:

```text
user_message
assistant_message
goal_created
goal_updated
file_read
file_written
file_deleted
shell_executed
test_completed
typecheck_completed
lint_completed
tool_failed
decision_recorded
task_forked
task_archived
compression_completed
repository_revision_changed
```

The ledger remains prompt-inert by itself. When `evidence-memory-shadow` is
enabled, deterministic claims and shadow Context Packs are built and measured
without changing model prompts. Evidence reaches the model only when the
separate `evidence-memory-prompt-injection` gate is enabled.
