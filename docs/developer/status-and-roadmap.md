# Status and roadmap

For release sequencing, provenance/Protocol v0 gates, and the rule that the
private managed Gateway starts only after those gates, see
[`RELEASE_GATES_AND_ROADMAP.md`](./RELEASE_GATES_AND_ROADMAP.md). The feature
list below is not release authorization.

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

The gate-based product calendar, including the next `1.16.0` preview/stable
targets and the later Protocol/Gateway milestones, is maintained in
[`docs/roadmap/PRODUCT_RELEASE_PLAN.md`](../roadmap/PRODUCT_RELEASE_PLAN.md).

## 4. Next development sequence

Two paths proceed in parallel:

1. **Local `1.16`:** integrate and independently verify the durable P0
   approval/MCP lifecycle, clear batched audit/test debt, close desktop
   attribution `OCB-006`, then promote preview/canary/stable.
2. **Protocol/service:** close provenance and Protocol v0 input/requirements
   evidence, independently review/re-derive the schema draft, implement boundary
   CI, and only after `B0`–`B5` plus `PV0-G01`–`PV0-G10` start a synthetic
   Gateway slice in a separate private repository.

Protocol/Gateway work does not delay the local `1.16` release; only its own P0,
verification, attribution, signing, and operational gates do.

Budgets/dashboard, worktree UX, background processes, steering, session
transfer, and team distribution remain post-`1.16` backlog unless explicitly
re-prioritized. Public reference audit/signing contracts may be designed here;
enterprise managed audit/signing implementation belongs only in the private
product track.

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
