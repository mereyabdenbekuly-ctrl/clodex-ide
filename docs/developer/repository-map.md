# Repository map

## Applications

### `apps/browser`

The Electron IDE.

- `src/backend/main.ts` — service composition and application startup;
- `src/backend/agent-host` — isolated agent utility process;
- `src/backend/mcp-host` — isolated MCP utility process;
- `src/backend/services` — host services;
- `src/shared` — renderer/backend contracts and validation schemas;
- `src/ui` — React application;
- `src/pages` — isolated pages and generated-app surfaces;
- `scripts` — packaging, evidence, dogfood, release, and smoke tooling;
- `bundled` — assets embedded into the application;
- `.storybook` and `visual-regression` — deterministic UI fixtures.

### `apps/clodex-cli`

Headless host for Agent Core. It demonstrates the minimum integration contract:
host paths, models, persistence, AgentManager, domain adapters, mounts, and
shell tools.

### `apps/update-server`

Update metadata and installer delivery service.

### `apps/website`

Product website and static content.

### `apps/deprecated-cli`

Legacy command-line application. New runtime development should target
`apps/clodex-cli`.

## Core packages

### `packages/agent-core`

Provider-neutral agent runtime: agents, AgentManager, prompt composition,
mounts, persistence, Context Ledger, Model Fabric, runner routing, toolbox,
plans, logs, attachments, and diff history.

### `packages/clodex-contracts`

Stage 0 shell-independent contracts for the hybrid strangler migration. This
package must not depend on Electron, Karton, `stage-ui`, browser code, or other
Clodex runtime packages.

### `packages/agent-shell`

PTY and shell execution: sessions, command framing, terminal logging, shell
integration, and the local execution engine.

### `packages/mcp-runtime`

MCP protocol and transports: stdio, HTTP, OAuth, tools, prompts, resources,
elicitation, cancellation, timeout, restart, and redaction.

### `packages/karton`

Typed state synchronization and RPC between browser processes.

### `packages/runner-sdk`

Public contracts for custom execution providers: manifests, job admission,
leases, artifacts, signed receipts, and capability declarations.

### UI and support packages

- `packages/stage-ui` — shared React primitives;
- `packages/nucleo-*` — local icon packages;
- `packages/typescript-config` — TypeScript configuration;
- `packages/tailwindcss-color-modifiers` — design-token utilities.

## Cross-cutting service map

| Capability | Primary implementation |
| --- | --- |
| Agent lifecycle | `packages/agent-core/src/services/agent-manager` |
| Agent persistence | `packages/agent-core/src/services/agent-persistence` |
| Context Ledger | `packages/agent-core/src/services/evidence-memory` |
| Model Fabric | `packages/agent-core/src/services/model-fabric` |
| Model usage | `packages/agent-core/src/services/model-usage` |
| Zero-Trust Policy Engine | `apps/browser/src/backend/services/guardian` |
| Egress Control Gateway | `apps/browser/src/backend/services/network-policy` |
| Local terminal | `packages/agent-shell` and browser terminal service |
| SSH execution | `apps/browser/src/backend/services/remote-connections` |
| Docker execution | `apps/browser/src/backend/services/docker-runner` |
| Session continuity | `apps/browser/src/backend/services/session-continuity` |
| Generated apps | `apps/browser/src/backend/services/generated-app-library` |
| Artifact Bridge | `apps/browser/src/backend/services/artifact-bridge` |
| MCP | browser MCP service and `packages/mcp-runtime` |
| Plugins | `apps/browser/src/backend/services/plugin-marketplace` |
| Browser runtime | `apps/browser/src/backend/services/window-layout` |
| Git and files | browser Git and file-tree services |

## Generated and local-only directories

Do not commit:

- `node_modules`, `.home`, and `.turbo`;
- application `out` and `dist` directories;
- test results, coverage, Playwright reports, and Storybook output;
- local profiles and credential stores;
- private signing keys;
- temporary evidence and package artifacts.
