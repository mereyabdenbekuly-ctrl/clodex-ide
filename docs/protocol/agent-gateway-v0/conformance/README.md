# Protocol v0 conformance-vector plan

> **Definitions only.** This directory contains no fixture payloads, keys,
> signatures, test runner, generated SDK, runtime dependency, or Gateway code.

`manifest.json` reserves stable identifiers and expected semantics for future
clean-room synthetic conformance vectors. The vectors must be authored only
after the input, requirement, and schema-provenance phase (`PV0-G01` through
`PV0-G05`) is GREEN and a maintainer explicitly authorizes vector authoring.
The independently reviewed vectors then close `PV0-G06`; they are not required
to exist before the earlier phase can become eligible for that work.

## Planned fixture shape

Each future vector should live in a directory named after its manifest ID and
contain only the minimal synthetic artifacts needed for that case:

```text
<vector-id>/
  input.json
  expected.json
  provenance.json
```

- `input.json` will contain a synthetic envelope or envelope pair.
- `expected.json` will contain machine-readable validation/admission semantics,
  not a private implementation trace.
- `provenance.json` will record the author, reviewed spec revision, creation
  method, and confirmation that no RED source was consulted or copied.

No vector may contain real tenant, actor, device, agent, task, tool, approval,
key, locator, policy, receipt, or production payload data. Identifiers must be
obviously synthetic. Test keys, when later approved, must be deterministic,
public, fixture-only keys that are impossible to confuse with deployment keys.
No conformance vector may invoke a real tool or external side effect; even the
valid-request vector proves only structural/cryptographic behavior against a
synthetic harness.

## Reserved behavior cases

| Vector ID | Planned assertion |
| --- | --- |
| `agw-v0-valid-request-001` | A correctly signed, unexpired, exactly bound request is structurally admissible |
| `agw-v0-replay-original-001` | Same idempotency key and same canonical request returns the original receipt without another effect |
| `agw-v0-idempotency-conflict-001` | Same idempotency key with changed binding/payload is rejected before execution |
| `agw-v0-digest-drift-001` | Artifact digest differing from `EffectBinding` is rejected before authorization/execution |
| `agw-v0-expired-evidence-001` | Expired approval evidence cannot authorize an effect |
| `agw-v0-receipt-substitution-001` | A valid receipt from another request/binding cannot be substituted as evidence |
| `agw-v0-failed-unknown-001` | `FAILED + UNKNOWN` is terminal fail-closed evidence and cannot trigger automatic new-key retry |
| `agw-v0-denied-evidence-no-override-001` | Exact valid denial evidence forces `DENIED + NOT_APPLIED` and cannot fall back to policy authorization |
| `agw-v0-denied-expiry-precedence-001` | Exact denial evidence remains terminal negative evidence when expiry is also true |
| `agw-v0-evidence-replay-001` | Approval evidence consumed by one canonical request cannot authorize a different request |
| `agw-v0-version-downgrade-001` | A selection outside the signed client offer is rejected |
| `agw-v0-selection-substitution-001` | An effect request bound to a different/expired/rejected signed selection is rejected |
| `agw-v0-required-capability-missing-001` | A selection missing any required capability is rejected |
| `agw-v0-offer-expired-window-001` | An expired offer receives only a signed `OFFER_EXPIRED` rejection with a separate short evidence window |
| `agw-v0-inline-locator-conflict-001` | An inline artifact containing a locator is structurally invalid |
| `agw-v0-invalid-base64url-001` | A non-canonical or invalid final base64url quantum is rejected |
| `agw-v0-timestamp-claim-order-001` | Invalid temporal order or impossible `claimedAt` presence is rejected |

## Future acceptance rules

Before fixture material is added:

1. pin the exact reviewed protocol commit in every `provenance.json`;
2. independently derive canonical JSON and signatures from this published spec;
3. obtain review from someone who did not author the fixture;
4. confirm all identifiers and payloads are synthetic;
5. keep expected results transport-neutral and free of storage, scheduling,
   policy-engine, Guardian, authentication-provider, billing, or topology
   internals;
6. add a runner only in a separately approved implementation change.

The manifest is therefore a fixture roadmap, not evidence that Protocol v0 has
been validated or implemented.
