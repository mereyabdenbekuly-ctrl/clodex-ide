# Clodex provenance policy

## Purpose

This policy defines what the project accepts as independent Clodex
implementation and how contributors disclose source, AI assistance, and
third-party material. It is an engineering acceptance policy, not a legal
conclusion about a particular implementation.

The strictest rules apply to components marked `independent` in the
[component registry](../provenance/components.yml). Existing notices in legacy
and third-party components must be preserved.

## Independent implementation

Independent code should be created from:

- approved Clodex contracts, ADRs, specifications, and threat models;
- public standards and protocols;
- official API documentation;
- independently written acceptance scenarios;
- documented black-box observations; and
- approved dependencies with understood licenses.

Behavior may be recorded as:

```text
input -> observed result -> independent specification -> implementation
```

The implementation must follow the specification rather than the source
structure of the observed system.

## Source-guided rewriting

Independent components must not include:

- copied code, comments, tests, fixtures, assets, or UI layouts;
- file-by-file or function-by-function rewrites;
- mechanical renaming, syntax translation, or framework translation;
- another implementation's module decomposition or control flow used as a
  blueprint;
- legacy code moved into an independent directory and relabeled; or
- output produced by asking AI to disguise, paraphrase, or rewrite legacy or
  third-party source.

Previous exposure to legacy code does not automatically disqualify a
contributor. Material exposure must be disclosed, and the replacement must be
implemented from an approved specification without consulting the legacy
source as a structural guide.

## AI assistance

AI may assist with design, review, tests, and implementation from approved
specifications. The contributor remains responsible for origin, licensing,
correctness, security, and architecture.

Substantial AI assistance must identify:

- the tool used;
- the work it performed; and
- the source material or classes of context supplied to it.

Routine autocomplete does not require individual logging unless it received
restricted source or generated a substantial part of the change. AI-generated
code is not automatically independent.

## Third-party material

Third-party code, assets, fixtures, schemas, and generated output must record
the exact source, version or commit, license, required notice, and modification
made. Unclear material requires maintainer approval before inclusion and must
be represented in the project's notice and SBOM process.

Removing attribution, changing filenames, or rewriting Git history does not
change provenance.

## DCO and future licensing

Every human-authored contribution requires a DCO sign-off matching the commit
author. Verified Dependabot commits may use GitHub's canonical Dependabot
sign-off. Any other automation exception requires an explicit policy change
and a trusted, non-spoofable identity check.

DCO confirms the right to submit a contribution under the applicable component
license. It does not replace third-party compliance or automatically grant the
project a unilateral right to relicense the contribution later.

Any future CLA or dual-license grant must be published before it applies to new
contributions.

## Pull-request declaration

Substantial pull requests identify:

- changed components and their registry status;
- source of truth before and after the change;
- migration and rollback plan;
- specifications and public documentation used;
- other implementations inspected;
- third-party materials and licenses; and
- substantial AI assistance and supplied context.

Mixed legacy/independent pull requests should be avoided. When unavoidable,
the description must identify which files belong to each zone.

## Enforcement

Maintainers may request provenance clarification, separation of zones,
replacement of uncertain material, a specification-first reimplementation, or
restoration of required notices. Unresolved provenance uncertainty blocks merge
into an independent component. This protects the repository and is not an
allegation about contributor intent.
