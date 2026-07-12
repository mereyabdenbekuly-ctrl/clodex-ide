# Product capabilities

This document maps user-visible functionality to its primary implementation.
Feature gates can make a capability unavailable or default-off in a particular
release channel.

## 1. Tasks and chat

- create, search, resume, archive, and delete tasks;
- stream model reasoning, text, and tool output;
- queue follow-up messages;
- fork a complete task or fork from a selected message;
- display task lineage;
- maintain goals and progress;
- attach files and mount one or more workspaces;
- persist task state across application restarts;
- produce short progress commentary and a self-contained final response.

Primary code:

- `packages/agent-core/src/agents`;
- `packages/agent-core/src/services/agent-manager`;
- `apps/browser/src/ui/screens/main/agent-chat`.

## 2. Projects, files, and code changes

- project and workspace catalog;
- virtualized file tree with paginated directory reads;
- protected file reads;
- file previews;
- pending edits and diff history;
- line-numbered diff review;
- accept or reject individual changes or complete batches;
- Git status, branches, commits, and worktree-aware operations.

Primary code:

- browser `file-tree`, `git`, and `history` services;
- Agent Core pending edits and diff history;
- diff-review UI routes.

## 3. Terminal and shell

- local PTY sessions;
- command execution and cancellation;
- terminal tabs and persistent shell logs;
- approval modes;
- capability-bound shell authorization;
- session-aware tool output;
- content-free lifecycle telemetry.

Primary code:

- `packages/agent-shell`;
- browser terminal and toolbox services;
- policy service shell capability broker.

## 4. Browser and web tools

- shared browser tabs;
- navigation, history, downloads, and permissions;
- screenshots and selected-element context;
- browser-use approval policy;
- managed network egress;
- exact destination grants and revocation;
- origin-scoped automation controls.

Primary code:

- browser window-layout service;
- browser-use policy service;
- network-policy service;
- web-content preload.

## 5. Models and providers

- managed Clodex endpoint;
- provider API keys;
- custom OpenAI-compatible endpoints;
- local model endpoints;
- provider-neutral model catalog;
- model selection per task;
- capability-aware routing;
- usage accounting, quotas, and budget policies;
- health, retry, and circuit-breaker state;
- authenticated managed policy publication.

Primary code:

- provider services under `apps/browser/src/backend`;
- `packages/agent-core/src/services/model-fabric`;
- `packages/agent-core/src/services/model-usage`.

## 6. Context and memory

- lossless task history archive;
- compressed recent-history fallback;
- encrypted global, workspace, and agent notes;
- append-only Context Ledger;
- claims, provenance, contradictions, and supersession;
- lexical retrieval and guarded Context Packs;
- repository-revision checks;
- recursive short and long summaries;
- memory inspector and dogfood evaluation.

Primary code:

- `packages/agent-core/src/services/evidence-memory`;
- `packages/agent-core/src/services/memory-notes`;
- browser evidence-memory inspector.

## 7. Agent execution

- local execution;
- isolated Agent Host utility process;
- SSH execution against saved profiles;
- Docker execution with resource and network restrictions;
- custom runner SDK;
- snapshot-bound jobs;
- leases, receipts, artifacts, and replay protection;
- shadow routing and paired replay;
- cloud tasks with fail-closed admission.

Primary code:

- Agent Host;
- remote-connections and docker-runner services;
- Agent Core runner-routing;
- `packages/runner-sdk`.

## 8. Session continuity

- workspace snapshots;
- Git revision and dirty-state fingerprints;
- checkpoints;
- resumable artifacts;
- lease, epoch, and fencing semantics;
- atomic memory synchronization;
- suspend/resume;
- session teleport controls.

Primary code:

- session-continuity service;
- Agent Host snapshot builder and materialization;
- Agent Core snapshot and checkpoint contracts.

## 9. MCP, skills, and plugins

- MCP stdio and HTTP servers;
- OAuth;
- tools, prompts, resources, elicitation, cancellation, and timeout;
- global and workspace skills;
- native skill installation;
- plugin catalog and private sources;
- signed plugin metadata;
- staged installation, update, rollback, and capability review.

Primary code:

- browser MCP and plugin services;
- `packages/mcp-runtime`;
- skill adapters in Agent Core.

## 10. Generated apps

- agent-owned app library;
- discovery and metadata validation;
- preview and launch;
- regeneration through the owner task;
- safe delete;
- sandboxed runtime;
- session-bound capability bridge;
- read/write separation;
- one-time commit tokens for privileged actions;
- package trust, signing, import, and revocation;
- runtime evaluation and content-free inspection.

Primary code:

- generated-app-library;
- artifact-bridge;
- shared generated-app schemas;
- generated-app SDK packages.

## 11. Collaboration and review

- hosted pull-request detection;
- commits, checks, files, and patches;
- inline review drafts;
- comment, approve, or request changes;
- protected merge with permission, branch-rule, check, freshness, and explicit
  confirmation requirements.

Primary code:

- hosted-pull-request service;
- pull-request UI route.

## 12. Productivity surfaces

- command center;
- native Quick Task window and global shortcut;
- scheduled automations;
- global and realtime dictation;
- remote-control pairing;
- settings for models, MCP, plugins, memory, Agent OS, worktrees, browsing,
  permissions, and remote connections;
- update channel and release information.

## 13. Observability and diagnostics

- task and runtime status;
- content-free telemetry;
- Agent OS inspector;
- Context Ledger inspector;
- egress audit;
- runner shadow ledger;
- generated-app runtime inspector;
- release-readiness reports;
- deterministic smoke scripts and evidence collectors.
