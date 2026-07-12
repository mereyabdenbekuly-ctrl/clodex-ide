# Status and roadmap

## 1. Implemented platform

The current integration baseline contains:

- Agent Core lifecycle and persistence;
- two-channel response contract;
- Context Ledger and recursive summaries;
- Model Fabric and usage accounting;
- Zero-Trust Policy Engine;
- managed network egress;
- isolated Agent Host and MCP Host;
- local, SSH, Docker, custom, and cloud execution contracts;
- workspace snapshots and session continuity;
- generated-app capability and package-trust foundations;
- MCP, skills, plugins, automations, and remote connections;
- release-evidence workflows and fail-closed readiness gates.

## 2. Gated capabilities

Many advanced capabilities are intentionally default-off or channel-limited:

- model-assisted policy classification;
- Context Ledger prompt injection;
- active model routing;
- automatic runner routing;
- cloud tasks;
- generated-app writes and package capabilities;
- remote control;
- realtime dictation;
- desktop automation.

The authoritative list is
`apps/browser/src/shared/feature-gates.ts`.

## 3. Operationally pending

Source implementation is not the same as production promotion. Production
still requires:

- an authoritative protected repository;
- release-owned signing identities;
- real observation windows;
- platform and physical-provider smoke;
- required reviewers;
- notarization and official installer validation;
- manual acceptance;
- monitoring and rollback ownership.

Until the corresponding evidence passes, advanced release allocation remains
zero.

## 4. Next development sequence

Recommended order:

1. finalize task-goal time and token budget support;
2. usage and budget dashboard;
3. permission profiles;
4. fork into a new worktree;
5. task-level background process manager;
6. live steering for running work;
7. session import/export;
8. team distribution for plugins and policies;
9. enterprise audit and external signing adapters.

## 5. Definition of done

A capability is complete only when it has:

- source implementation;
- shared schema;
- host ownership;
- UI states where applicable;
- persistence or explicit ephemeral semantics;
- fail-closed security behavior;
- tests and typecheck;
- audit/telemetry rules;
- feature-gate policy;
- developer documentation;
- operational promotion criteria when it affects production side effects.
