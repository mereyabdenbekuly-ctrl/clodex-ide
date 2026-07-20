# CLODEx Repository Agent Rules

These instructions apply to the entire repository. They are mandatory for
human-assisted and autonomous changes.

## Open/closed product boundary

CLODEx uses this product model:

> **Open:** how a security decision is described, made, enforced locally, and
> independently verified.
> **Closed:** how the same contract is operated for many tenants, agents, and
> organizations.

### Commercial product invariant

- Treat every local or client-side capability merged into the public AGPL
  `main` branch as permanently available to Community users at source level.
  Never design it as a durable paid entitlement or rely on client feature
  flags, obfuscation, license keys, renderer checks, distribution identity, or
  packaging omissions to keep it paid.
- Assume users can compile and patch the public client and remove UI gates.
  Paid entitlements, authorization, metering, and billing must be enforced by
  the separately operated service, never trusted to the public IDE.
- Paid-only capabilities must be implemented and authorized server-side in a
  separately secured private managed service. The public client may contain
  only reviewed public contracts, thin connectors, and fail-closed entitlement
  UX; it must not contain a client-side bypass that grants managed access.
- Never place managed Gateway, enterprise administration, cloud control-plane,
  fleet, SSO/SCIM, RBAC/ABAC, billing/metering, compliance/SIEM, or premium
  managed-service implementation in a public CLODEx repository.
- Keep the public Community product secure and useful on its own. Do not weaken
  local Guardian, authorization, approvals, evidence, MCP isolation, or other
  local protections to manufacture a paid tier.
- Protocol v0 schemas, governance, reviews, and future conformance artifacts
  define a public interoperability boundary only. They do not authorize
  paid/private implementation in public `main`, SDK publication, or Gateway
  implementation before all documented gates and explicit maintainer/legal
  approval.
- If a requested feature must remain commercially exclusive but can operate
  entirely in the public client or locally, stop and require a product-boundary
  decision before editing or staging it.

### Current Protocol v0 phase

- The current Protocol v0 phase is governance and evidence-intake only.
- Every Protocol v0 gate remains OPEN. An intake, checklist, validator, review
  template, or collected source does not close a gate by itself.
- No Protocol v0 schema authoring or schema change, conformance fixture or
  implementation, code generation, SDK publication, Gateway bootstrap,
  enterprise/cloud implementation, or relicensing is authorized until the
  applicable gates are independently reviewed and explicitly closed.
- Preserve fail-closed state in code and documentation: pending, conditional,
  incomplete, unattributed, or stale evidence is not approval.

The public repository may contain:

- the IDE and local-first user experience;
- Intent Contract, approval, evidence, receipt, and replay semantics;
- Guardian, the local security kernel, MCP isolation, local ledgers, and local
  enforcement;
- local or reference coordinators, registries, runners, and adapters;
- reviewed wire schemas, conformance vectors, generated/thin clients, and
  sanitized security documentation;
- community policy packs and synthetic examples.

The following are **private product code** and must not be implemented in,
copied into, or staged from this public repository:

- the managed multi-tenant Agent Gateway or tenant control plane;
- centralized policy distribution, managed evidence ingestion/query, global
  scheduling, fleet management, metering, or billing;
- enterprise SSO/SCIM, RBAC/ABAC, admin, SIEM, compliance, and premium
  connectors;
- production cloud infrastructure, HSM/KMS custody, secret brokers, signing
  systems, regional failover, and operations;
- private threat intelligence, risk heuristics, benchmark holdouts,
  customer-specific Policy Packs, and customer connectors.

The following are **restricted data** and must never be committed:

- customer prompts, source, traces, audit records, identifiers, or credentials;
- production secrets, keys, key identifiers, topology, or unsanitized
  deployment manifests;
- active incident material or reproducible exploit chains before coordinated
  remediation;
- internal security reports, private benchmark data, fundraising decks,
  investor material, pricing negotiations, contracts, or customer terms.

Use synthetic, non-secret fixtures only. Keep private work in a separate
private repository or the external private data room, never as an ignored
subtree used for normal development inside this repository.

API Relay/CLODEX.XYZ is a separate product. Do not mix its code, architecture,
customer material, pricing, or roadmap into the CLODEx IDE unless an explicit
integration decision defines the public contract and data boundary.

## Current authorization state

The managed Gateway server is **not authorized for implementation yet**.
The currently authorized boundary work is:

1. a component-level provenance, copyright, license, and dependency audit;
2. a schema-only Protocol v0 design and planned synthetic conformance-vector
   definitions; fixture authoring starts only after its input/requirements gates;
3. a deny-by-default dependency policy for future private repositories;
4. governance and release documentation.

Gateway bootstrap becomes eligible only after all of these gates are green:

- provenance and rights review;
- Protocol v0 review and versioning decision;
- automated dependency-boundary enforcement;
- a separately secured private repository baseline;
- explicit maintainer authorization and required legal review.

Eligibility applies **only** to a separately secured private repository. The
managed Gateway, enterprise service, and cloud implementation remain
permanently forbidden in this public repository even after those gates pass.

## Mandatory engineering rules

1. **Classify before editing.** Decide whether each artifact is public core,
   public specification/reference, private product, or restricted data.
2. **Preserve current rights.** Do not move, copy, extract, or relicense
   existing code merely to create a public/private boundary. A GREEN
   provenance result permits the reviewed action only; it does not silently
   grant relicensing rights.
3. **Keep Protocol v0 schema-only.** It may define versioned envelopes,
   digests, decisions, receipts, errors, replay/idempotency, and conformance
   vectors. It must not contain a managed Gateway implementation.
4. **Keep the private side clean-room.** Do not copy public implementation
   source into a private repository. Do not use workspace, `file:`, `link:`, or
   Git dependencies that point back to this monorepo.
5. **Deny unsafe dependency closure.** Private code must not depend on
   `@stagewise/*` or CLODEx implementation packages. The only future exception
   is an explicitly reviewed, independently publishable protocol schema or
   generated/thin SDK artifact.
6. **Do not treat transport as legal separation.** HTTPS, gRPC, or process
   separation is an engineering boundary, not by itself a licensing
   conclusion.
7. **Do not weaken the local product.** Local Guardian, authorization,
   approvals, evidence, and fail-closed behavior may not be made unsafe to
   create a paid tier.
8. **Do not bypass ignore protections.** Never use `git add -f` for a boundary
   artifact. `.gitignore` is defense in depth, not permission to store private
   material in the public worktree.
9. **Sanitize public documentation.** Public docs may describe architecture
   and security semantics, but not private topology, customer material,
   production identifiers, unresolved exploit detail, pricing, or investor
   content.
10. **Record deferred verification honestly.** Implementation that has not yet
    passed the required audit, tests, and CI must be labeled
    `IMPLEMENTED_UNVERIFIED`; it is not release-ready.
11. **Preserve redistribution evidence.** Keep upstream copyright, license,
    attribution, NOTICE, DCO, and provenance records intact. Do not invent
    rights or substitute guessed license text; any missing or ambiguous license
    remains a release blocker.

## Stop conditions

Stop and report to the maintainer instead of staging a change when:

- provenance, license, or authorship is unknown for an extraction or new
  dependency;
- a requested public change contains private product logic or restricted data;
- a private implementation would import or copy from this monorepo;
- a fixture is derived from real customer or production data;
- the change would claim Apache/MIT/permissive status before the rights review;
- the only way forward is to override an ignore, boundary, security, or release
  gate.

The detailed normative policy is
[`docs/governance/OPEN_CLOSED_BOUNDARY.md`](docs/governance/OPEN_CLOSED_BOUNDARY.md).
The release sequence and gates are in
[`docs/roadmap/PRODUCT_RELEASE_PLAN.md`](docs/roadmap/PRODUCT_RELEASE_PLAN.md).
