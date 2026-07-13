# ADR-0001: Model output is untrusted input

- **Status:** Accepted
- **Date:** July 13, 2026

## Context

Prompts cannot reliably grant or constrain operating-system, network, browser,
credential, or repository authority. Model output may also contain mistakes,
prompt-injected instructions, or unsafe tool arguments.

## Decision

Clodex treats model output as untrusted input. Authority comes from explicit
capabilities, deterministic host policy, bounded tool contracts, and user
review. A model recommendation is never itself an authorization decision.

## Consequences

- Sensitive actions require validation outside the model runtime.
- Tool arguments and external content are validated as hostile input.
- Convenience features may not silently convert a model response into broader
  authority.
- Contributors must document any new principal, capability, and approval path.

See `docs/developer/security-and-data.md` and
`docs/developer/architecture.md`.
