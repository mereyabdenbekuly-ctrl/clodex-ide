# ADR-0003: Privileged authority stays outside untrusted processes

- **Status:** Accepted
- **Date:** July 13, 2026

## Context

The renderer, model-driven agent steps, web content, MCP servers, plugins, and
generated workloads process data that may be malicious or incorrect. Combining
them with broad host authority would make a single compromise cross every trust
boundary.

## Decision

Privileged filesystem, credential, network, process, and release operations stay
in supervised host services with narrow typed interfaces. Renderer, Agent Host,
MCP Host, preload, and sandbox boundaries remain explicit. New cross-boundary
messages must be validated and capability-scoped.

## Consequences

- Renderer code may not import privileged backend implementations directly.
- Agent and MCP execution does not gain ambient host authority.
- Preload surfaces remain narrow and reviewable.
- Moving authority across a process boundary requires threat-model and security
  review.

See `docs/developer/architecture.md` and
`docs/developer/security-and-data.md`.
