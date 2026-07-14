# Extensions and integrations

## 1. MCP

MCP support is split between the browser MCP service, the supervised MCP Host,
and `packages/mcp-runtime`.

Supported protocol surfaces include:

- stdio and HTTP transport;
- OAuth start and completion;
- tools;
- resources and resource templates;
- prompts;
- elicitation;
- cancellation and timeout;
- reconnect and restart;
- bounded error normalization.

Adding a transport or protocol field requires:

1. shared schema changes;
2. supervisor wire-contract changes;
3. host implementation;
4. cancellation and timeout tests;
5. content-redaction tests;
6. packaged-host smoke coverage.

## 2. Skills

Skills are workspace or global instruction packages discovered through host
paths and exposed through the enabled-skills environment adapter.

Requirements:

- stable metadata;
- explicit scope;
- safe path resolution;
- no implicit credential access;
- deterministic enable/disable state.

## 3. Plugins

The plugin marketplace supports:

- catalog metadata;
- private sources;
- integrity checks;
- staged install;
- updates;
- rollback;
- capability disclosure;
- credential mapping.

Plugin code must use supported extension contracts rather than importing
browser-host internals.

## 4. Model providers

Provider integrations implement the host model contract. They should expose:

- model identity and capabilities;
- authentication requirements;
- context and output limits;
- health and quota signals;
- normalized errors;
- streaming behavior;
- optional structured-output support.

Provider-specific logic must remain outside Agent Core behavior.

## 5. Custom runners

Do not start new external, protocol, or private-Gateway integrations on
`packages/runner-sdk`; its current `agent-shell` dependency makes it an
audit-blocked legacy surface. Existing in-monorepo callers may be maintained
without expanding the boundary. New ecosystem runners must wait for and consume
only a future GREEN Protocol v0 SDK.

A runner declares:

- identity and version;
- supported command classes;
- platform and environment requirements;
- artifact behavior;
- cancellation behavior;
- lease semantics;
- receipt signing;
- security and resource capabilities.

Runner implementations must not bypass snapshot identity, policy admission, or
receipt validation.

## 6. Generated-app SDK

Generated apps communicate with the host through the Artifact Bridge.

The SDK should expose only typed capabilities such as:

- read a granted resource;
- call an approved MCP tool;
- ask a bounded model question;
- prepare a sensitive operation;
- commit an approved operation;
- launch an allowed automation;
- subscribe to bounded lifecycle state.

Do not expose arbitrary Electron IPC, file-system paths, credentials, or raw
provider clients.

## 7. Cloud execution adapters

A cloud adapter receives a bounded task request and snapshot descriptor. It
must implement:

- admission and kill switch;
- region/residency checks;
- scoped secret delivery;
- artifact upload and resume;
- suspend/resume;
- cancellation;
- cleanup;
- usage and SLO reporting;
- exact-source evidence.

## 8. Adding an integration

Use this order:

1. Shared contract and schema.
2. Provider-neutral core interface.
3. Browser-host adapter.
4. Feature gate.
5. UI and settings.
6. Audit and telemetry.
7. Unit and integration tests.
8. Smoke harness.
9. Release-readiness adapter.
10. Operational documentation.
