# Clodex security invariants

These invariants apply across legacy, migration, and independent components.
They may be strengthened by a later ADR but must not be silently weakened.

## Authority

1. Model output is untrusted input and never grants authority by itself.
2. Guardian or an explicitly approved deterministic policy owner authorizes
   sensitive actions.
3. Missing, stale, malformed, timed-out, or ambiguous authorization fails
   closed through denial or explicit escalation.
4. Approval is bound to the exact action, task, workspace, policy revision,
   expiry, and execution context.

## Process and capability boundaries

5. Renderer, web content, model-driven agents, MCP servers, plugins, and
   generated workloads do not receive ambient host authority.
6. Filesystem, process, credential, network, and release authority stays in
   supervised host services behind narrow validated contracts.
7. Legacy adapters translate contracts but do not make policy decisions or
   become a new source of durable business logic.

## Credentials, network, and data

8. Credentials use approved protected storage and are not returned through UI
   state, logs, telemetry, fixtures, or error payloads.
9. New egress is deny-by-default and requires destination-aware policy
   evaluation outside the requesting model or renderer.
10. Operational telemetry remains content-free unless a separately approved
    data contract explicitly requires bounded content.

## Side effects and recovery

11. A dispatched side effect is not replayed after crash or restart without an
    explicit idempotency and recovery contract.
12. Shadow mode never executes a real terminal command, file/Git mutation,
    network request, cloud job, message, credential operation, or persistence
    write twice. It compares plans and executes once, or uses a recording sink
    or disposable sandbox.
13. Audit, evidence, and telemetry transport failures must not convert denial
    into approval or otherwise make an operation more permissive.
14. Migration or rollback cannot select a more permissive policy result when
    legacy and kernel decisions diverge.

## Validation expectations

Security-sensitive changes include negative tests for malformed context,
expired or mismatched approval, cancellation, timeout, replay, recovery,
cross-process validation, secret redaction, and egress denial. A change to an
accepted invariant requires a replacement ADR and explicit security review.

See [ADR-0001](../adr/0001-model-output-is-untrusted.md),
[ADR-0002](../adr/0002-guardian-fails-closed.md),
[ADR-0003](../adr/0003-privileged-process-boundaries.md), and the
[architecture boundaries](../architecture/BOUNDARIES.md).
