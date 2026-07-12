# Agent platform

## 1. Agent lifecycle

Agent Core represents every task as an agent instance with:

- a stable instance identifier;
- agent type;
- message history;
- mounted workspaces;
- active model;
- tool approval mode;
- task goal and progress;
- runtime status and errors;
- persisted metadata and artifacts.

`AgentManager` owns creation, loading, message dispatch, state mutation,
persistence coordination, forking, archive semantics, and teardown.

Agent types are registered through `AgentTypeRegistry`. The primary types are
the chat agent and the workspace-context agent.

## 2. Prompt and environment assembly

The chat system prompt is composed from:

1. the core introduction;
2. behavioral principles;
3. environment sections supplied by domain adapters;
4. output-style and protocol rules;
5. authority boundaries.

Domain adapters expose only the environment state enabled by the host profile.
Typical domains include:

- workspaces;
- project instructions;
- skills;
- memory;
- plans;
- logs;
- file diffs;
- shell sessions.

The output contract separates:

- **commentary** — short milestone updates while work is running;
- **final** — the complete terminal response.

## 3. Context Ledger

The Context Ledger is an append-only evidence system implemented in
`packages/agent-core/src/services/evidence-memory`.

### Data model

- immutable events;
- normalized claims;
- evidence and provenance edges;
- repository revisions;
- relationships such as supersedes, invalidates, narrows, expands, confirms,
  and contradicts;
- retrieval and admission receipts;
- short and long materialized summaries.

### Retrieval

Context creation follows a guarded sequence:

1. identify task, workspace, and repository revision;
2. retrieve lexical candidates;
3. reject stale, mismatched, unsupported, or contradictory claims;
4. apply token and claim limits;
5. render a prompt-inert Context Pack;
6. record content-free evaluation metrics.

Current source code is always read from the workspace. Historical code excerpts
are not treated as current truth.

### Recursive summaries

- short summaries materialize on approximately ten-minute boundaries;
- long summaries compact short summaries on six-hour boundaries;
- source event identifiers remain traceable;
- model-assisted summaries are optional;
- deterministic fallback keeps memory available when providers fail;
- automatic destructive pruning remains separately controlled.

## 4. Model Fabric

Model Fabric separates model choice from agent behavior.

Inputs include:

- task intent;
- required model capabilities;
- context size;
- latency or quality preference;
- provider health;
- quotas and budget policy;
- release policy.

Outputs include:

- selected route;
- structured route decision;
- fallback order;
- usage and budget events;
- health and quota-window updates.

Shadow routing can evaluate recommendations without changing the active model.
Active routing remains feature-gated and policy-controlled.

## 5. Zero-Trust Policy Engine

Policy evaluation receives fixed-shape, content-free action context:

- action kind;
- capabilities;
- resource scope;
- target trust;
- read-only and irreversible flags;
- user authorization;
- narrow evidence codes.

The deterministic matrix is authoritative:

- safe bounded reads can be approved;
- side effects can require explicit approval;
- high-risk actions require sufficient authorization and scope;
- critical actions are denied;
- invalid context escalates or denies.

An optional provider-neutral classifier runs only in shadow mode. It cannot
grant a capability or override the deterministic decision.

## 6. Tool execution

Tools are resolved through the agent toolbox and host adapters. Side-effecting
tools carry approval and capability metadata.

Execution lanes:

- local host service;
- Agent Host utility process;
- MCP Host;
- sandbox worker;
- local PTY;
- SSH runner;
- Docker runner;
- cloud task provider.

Dispatched work is not silently replayed after process failure. Idempotent
protocols use explicit operation or commit identifiers.

## 7. Runner routing

Runner routing combines:

- workspace snapshot identity;
- command class;
- provider capabilities;
- historical execution evidence;
- environment compatibility;
- policy and feature gates.

Shadow routing records a recommendation without changing dispatch. Paired replay
executes safe samples on disposable snapshots to compare providers. Automatic
routing requires signed, fresh evidence and a pre-dispatch fallback path.

## 8. Session continuity

Portable snapshots contain:

- source revision;
- dirty patch identity;
- workspace mounts;
- environment fingerprint;
- materialization archive identity;
- checkpoint and memory-sync metadata.

Lease and fencing fields prevent stale workers from publishing state. Restore
receipts bind the restored session to the expected snapshot.

## 9. Generated-app runtime

Generated apps are untrusted principals.

The runtime provides:

- principal-scoped sessions;
- explicitly granted capabilities;
- quotas;
- read-only MCP and model access;
- prepare/approve/commit for sensitive writes;
- replay-resistant commit tokens;
- audit and inspector output without app content;
- package trust and revocation checks.

The generated app never receives direct credentials or unrestricted host IPC.

## 10. Goals

Task goals are part of the agent state and persistence contract. Goal updates
must preserve valid progress unless the operation explicitly resets it. Fork
behavior must state whether goal state is copied or reset.

Time and token budgets are advisory controls unless a specific execution lane
enforces a hard limit. UI warnings must be derived from persisted state rather
than hidden renderer-only counters.
