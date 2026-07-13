# Architecture decision records

Architecture decision records (ADRs) capture durable constraints that
contributors must preserve unless a replacement ADR is accepted.

| ADR | Decision |
| --- | --- |
| [0001](0001-model-output-is-untrusted.md) | Model output is untrusted input |
| [0002](0002-guardian-fails-closed.md) | Guardian authorization fails closed |
| [0003](0003-privileged-process-boundaries.md) | Privileged authority stays outside untrusted UI and agent processes |
| [0004](0004-evidence-requires-provenance.md) | Evidence used for durable memory requires provenance |
| [0005](0005-hybrid-strangler-migration.md) | Migrate through a hybrid legacy-shadow-kernel strangler |

New ADRs use the next four-digit number and include status, date, context,
decision, consequences, and links to implementation evidence. A superseded ADR
remains in the repository and links to its replacement.
