# Clodex architecture boundaries

## Purpose

Clodex Research Preview used Stagewise as its initial bootstrap. The migration
now builds independent Clodex contracts, kernel, runtime, policy, evidence, and
desktop surfaces while keeping the working Preview available.

The governing rule is:

> Legacy code may call independent Clodex components. Independent Clodex
> components must never depend on legacy implementation details.

## Component registry

[`docs/provenance/components.yml`](../provenance/components.yml) is the source
of truth for component status, ownership, planned paths, and permitted
dependencies. Directory naming alone does not establish independence.
The registry intentionally uses the JSON-compatible subset of YAML so the
bootstrap checker can parse it without executing third-party lifecycle code.

Statuses are:

- `independent` — shell-neutral Clodex architecture;
- `migration` — a temporary adapter between legacy and independent zones;
- `legacy` — an existing Stagewise-derived or mixed implementation; and
- `third_party` — externally maintained code or assets retained under their
  applicable license.

Independent packages use a deny-by-default dependency model. They may import
only their own files, registered independent components, explicitly approved
external packages, explicitly approved platform builtins, and registered
TypeScript libraries and ambient types.

Dependency sources are part of the boundary. Component manifests, root and
workspace overrides, patch settings, lockfile importers, and effective package
resolution records must resolve only to approved workspace targets or
integrity-pinned registry packages. Package-manager manifest-rewrite hooks are
disabled unless a future policy explicitly models and approves them.

## Independent zone

Independent components contain durable Clodex contracts and business logic.
They must not directly or transitively depend on:

- Stagewise implementation modules or `@stagewise/*`;
- Karton or `stage-ui`;
- legacy browser state, RPC, persistence, or UI contracts;
- Electron, React, or browser APIs unless a future component registration
  explicitly permits them; or
- aliases, re-exports, symlinks, non-literal module loading, dynamic code
  evaluation, ambient type discovery, or generated entrypoints that bypass the
  registered graph.

Cross-boundary data uses versioned Clodex contracts. Legacy objects must not
leak into the kernel.

## Migration zone

A migration component may depend on the specifically registered legacy and
independent components required to translate between them. It must:

- contain no durable product policy;
- identify the current source of truth;
- have an owner and removal issue before implementation;
- preserve rollback until cutover is proven; and
- avoid becoming a permanent home for new features.

## Legacy zone

Legacy components may receive security fixes, critical bug fixes,
compatibility/release fixes, minimal adapters, and changes needed to remove
replaced code. Unavoidable new legacy behavior requires a recorded owner,
removal plan, and exit criteria.

Moving, renaming, or mechanically rewriting legacy code does not make it an
independent component.

## Migration lifecycle

Domains normally move through:

```text
legacy -> shadow -> kernel -> legacy removal
```

The [parity matrix](../migration/parity-matrix.md) identifies the authoritative
implementation, comparison fields, cutover criteria, and rollback path.

### Pure computation

Both implementations may run for policy evaluation, state-transition
calculation, serialization, ranking, and planning. Inputs must be equivalent and
outputs normalized before comparison.

### Side effects

Terminal commands, file or Git writes, network requests, cloud jobs, messages,
credential access, and persistence writes must not execute twice. Shadow mode
compares plans and executes exactly one selected plan:

```text
legacy plan -+
             +-> compare -> select -> execute once
kernel plan -+
```

The non-authoritative implementation may instead use a recording executor or a
disposable sandbox. A policy mismatch must never select the more permissive
result. Dual-write requires an explicit exception, monitoring, rollback, and an
expiry no later than one release.

## Review and enforcement

Ordinary changes require maintainer review. Contracts, Guardian authority,
credentials, persistence schemas, network policy, component status, and
dependency allowlists require project-owner review and another qualified
reviewer when available. During bootstrap, the owner records the decision when
no independent reviewer exists.

Changes larger than approximately 800 lines should receive design review but
are not rejected solely because of size.

CI validates the component registry, package manifests, source imports,
TypeScript aliases, package entrypoints, and symlink boundaries. Exceptions
must be narrow, documented, owner-approved, and time-limited.
