# CLODEx Open/Closed Boundary Policy

**Status:** normative engineering policy
**Effective:** 2026-07-14
**Scope:** public CLODEx repositories, future private CLODEx repositories, and
artifacts exchanged between them

This document is an engineering and product-governance policy, not legal
advice. Open-source counsel must approve licensing conclusions before a
commercial private service is launched or existing code is relicensed.

## 1. Decision

CLODEx adopts this boundary:

> **Open-source IDE + open security protocol + private managed Agent Gateway.**

The security mechanism remains inspectable and locally enforceable. Revenue is
based on managed scale, coordination, enterprise administration, operations,
integrations, compliance, and responsibly governed operational data—not on a
deliberately unsafe free edition.

The shorthand rule is:

> **Open:** how the decision is made and verified.
> **Closed:** how the decision is operated across organizations and fleets.

## 2. Artifact classifications

Every new artifact must receive one of these classifications before it is
created, copied, published, or packaged.

| Classification | May live in the public repository | Examples | Required handling |
| --- | --- | --- | --- |
| **PUBLIC CORE** | Yes | IDE, Guardian, kernel, approval/evidence semantics, local ledger, MCP isolation | Preserve existing license and attribution; keep local security complete |
| **PUBLIC SPEC/REFERENCE** | Yes, after review | Protocol schemas, conformance vectors, thin/generated clients, local/reference coordinators | Schema/reference scope only; synthetic fixtures; provenance and package review |
| **PRIVATE PRODUCT** | No | Managed Gateway, tenant control plane, enterprise admin, cloud operations | Separate access-controlled repository; greenfield implementation; private CI |
| **RESTRICTED DATA** | Never | Customer data, production secrets, active incidents, holdouts, internal reports, pitch/contracts | Approved external system only; never public Git history |

Unclassified artifacts default to **RESTRICTED DATA** until a maintainer
classifies them.

## 3. Public boundary

The public product should include the implementation necessary to understand,
run, and independently verify local security behavior:

- `apps/browser/**` and the local IDE experience;
- Intent Contract, effect, approval, decision, replay, evidence, and signed
  receipt semantics;
- Guardian and the local authorization/security kernel;
- local ledgers, MCP isolation, reference adapters, and local execution;
- local/reference coordination and registry behavior;
- public protocol schemas, compatibility rules, conformance vectors, and
  generated/thin clients after their boundary review;
- sanitized ADRs, threat models, security documentation, and community policy
  packs.

Existing public code remains under its existing terms. Publishing a component
does not authorize copying it into a proprietary repository, and a package
metadata field does not substitute for provenance, dependency-closure, and
notice review.

### Existing mixed or audit-pending areas

Stagewise-derived or provenance-pending areas remain public in place while
their audit or replacement track proceeds. They must not be used as a private
service boundary merely because a package manifest says `MIT` or omits a
license. In particular, private code must not use `apps/browser`,
`packages/agent-core`, `packages/agent-shell`, `packages/stage-ui`, or other
Stagewise-derived implementation source.

`packages/runner-sdk` is not currently a clean private boundary because its
dependency closure includes audit-pending implementation. It may become a
candidate only after that closure is independently remediated and reviewed.

## 4. Private boundary

The following belong only in separately secured private repositories:

- multi-tenant Agent Gateway and tenant admission/control plane;
- centralized policy publication and distribution;
- managed evidence ingestion, retention, search, audit, and SIEM export;
- managed runner scheduling, fleet management, and regional orchestration;
- enterprise SSO, SCIM, RBAC/ABAC, administration, and compliance reporting;
- HSM/KMS custody, credential issuance, secret broker, and production signing;
- billing, metering, SLA operations, cloud infrastructure, and failover;
- premium/customer connectors and customer-specific Policy Packs;
- private risk models, anti-abuse heuristics, threat-intelligence feeds, and
  benchmark holdouts.

Private repositories must be greenfield. Their developers may use reviewed
public wire documentation and generated clients; they may not copy public
implementation source or depend on the public monorepo at source/runtime.

API Relay/CLODEX.XYZ remains a separate product boundary. Its implementation,
commercial material, customer data, and roadmap must not be blended into the
CLODEx IDE or Gateway repositories. A future integration requires its own
versioned public contract, data-flow review, and explicit maintainer decision.

## 5. Restricted material

The following must never enter public Git history, including fixtures, issue
attachments, screenshots, generated reports, or commit messages:

- customer prompts, source code, traces, audit data, identities, and secrets;
- production credentials, signing keys, real HSM/KMS identifiers, private
  certificates, and recovery material;
- production topology and unsanitized deployment manifests;
- active incident-response material and unremediated reproducible exploit
  chains;
- internal security reports, private holdouts, and non-public threat feeds;
- customer-specific policies/connectors and contractual material;
- pitch decks, investor asks, pricing negotiations, customer terms, and
  contracts.

Only explicitly synthetic data may be used in public examples and conformance
vectors. “Sanitized” means reviewed for both direct values and indirect
identifiers, topology, timing, and behavioral fingerprints.

## 6. Protocol v0 authorization

Protocol v0 is the next authorized technical boundary. It is a **schema-only**
design, not a Gateway server.

The current `docs/protocol/agent-gateway-v0/**` directory is classified
**PUBLIC SPEC/REFERENCE — YELLOW incubator**. It may be reviewed in this
repository but is not publishable, extractable, relicensable, SDK-generating,
or usable as private implementation input until its provenance gates close.

It may define:

- protocol and schema version negotiation;
- tenant, actor, device, agent, task, step, and execution identifiers;
- canonical intent, descriptor, context, policy, effect, and result digests;
- approval evidence references and exact decision/effect binding;
- idempotency keys, nonces, replay rules, timestamps, and expiry;
- policy decisions, terminal outcomes, typed errors, and signed effect
  receipts;
- synthetic conformance vectors and deterministic verification rules.

It must not contain:

- tenant storage, admission service, scheduler, billing, or policy service
  implementation;
- HSM/KMS, credential broker, evidence database, audit query, or operations
  code;
- imports from AGPL/Stagewise-derived implementation packages;
- copied types whose rights or provenance are not approved;
- customer, production, or private threat-intelligence data.

The protocol's prospective permissive license remains **TBD** until rights and
provenance review is GREEN. Until then, no agent may describe it as Apache-2.0,
MIT, dual-licensed, or independently relicensable.

## 7. Dependency direction

The intended dependency graph is one-way:

```text
reviewed public protocol schemas
             |
reviewed generated/thin public SDK
        /                         \
public IDE client        private managed Gateway
```

Forbidden private dependency forms include:

- `workspace:`, `file:`, `link:`, or Git dependencies into `clodex-ide`;
- runtime/source dependencies on `@stagewise/*`;
- runtime/source dependencies on CLODEx implementation packages;
- vendored or copy/pasted public implementation source;
- generated clients produced from unreviewed schemas.

A network or process boundary is not automatically a licensing boundary. The
semantic coupling, dependency closure, provenance, and distribution model must
also pass review.

## 8. Provenance states

The component matrix uses these states:

- **GREEN:** the stated use has adequate provenance and dependency evidence.
  This is not blanket permission to relicense or use the component for another
  purpose.
- **YELLOW:** keep in its current reviewed location/use only; audit or
  remediation is required before extraction, publication, or boundary use.
- **RED:** do not extract, copy, relicense, or use in the private dependency
  closure.

The audit must record at least: current license, copyright holders, authorship
and contribution history, upstream origin, transitive runtime/build
dependencies, generated-code origin, bundled assets, package notices, and the
specific intended use being approved.

## 9. Gateway implementation gates

No managed Gateway implementation may start until all gates below are green:

| Gate | Required evidence |
| --- | --- |
| **B0 — policy** | This policy approved and repository instructions active |
| **B1 — provenance** | Component/rights matrix reviewed; no unresolved RED dependency in the proposed boundary |
| **B2 — protocol** | Protocol v0 input manifest, requirement catalogue, schemas, threat model, versioning, and independently authored conformance vectors reviewed |
| **B3 — enforcement** | CI denies forbidden dependencies, source copying, secret material, and unsafe generated inputs |
| **B4 — private baseline** | Separate private repository with its own `AGENTS.md`/boundary policy, access control, branch protection, CODEOWNERS, secret scan, SAST, SBOM, and provenance attestations |
| **B5 — authorization** | Explicit maintainer approval and required open-source legal review |

After B0–B5, the first private implementation is limited to a synthetic
vertical slice:

```text
IDE client -> admission -> policy decision -> runner interface
           -> signed receipt -> evidence/audit verification
```

It uses no customer data, production credentials, or public-monorepo runtime
imports.

Passing B0–B5 authorizes that work only in the separate private repository. It
never authorizes managed Gateway, enterprise, or cloud implementation in this
public repository.

## 10. Git and agent enforcement

- Root [`AGENTS.md`](../../AGENTS.md) makes this policy visible to repository
  agents.
- Root [`.gitignore`](../../.gitignore) blocks known private/restricted artifact
  locations as defense in depth.
- Ignore rules do not make it acceptable to keep private material in this
  worktree and do not protect already tracked files or forced additions.
- Agents must never use `git add -f` to override a boundary rule.
- Boundary violations must be removed from the candidate change and reported;
  do not attempt to “sanitize” unknown customer or secret material in place.
- Any exception requires a narrowly scoped written decision identifying the
  artifact, intended use, provenance evidence, owner, expiry/review date, and
  legal/security approvals. There is no implied exception.

## 11. Change control

Changes to this policy require maintainer review. Changes that affect license,
relicensing, private/public dependency direction, customer-data handling, or
the Gateway implementation gates also require the appropriate legal or
security owner. Convenience, schedule pressure, or an ignored path is not a
valid exception.
