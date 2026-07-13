> Open a **Draft pull request early** when you want feedback on direction, interfaces, or scope. Keep it in Draft while implementation, tests, documentation, or evidence are incomplete. Mark it ready for review only when the relevant checklist items below are satisfied.

## Linked issue

<!-- Substantial changes should have an agreed issue. Use "Closes #123" when this PR fully resolves it. -->

Closes #

## Contribution category

- [ ] Independent Clodex implementation
- [ ] Migration adapter, shadow comparison, or cutover
- [ ] Legacy / compatibility fix
- [ ] Legacy removal
- [ ] Specification or documentation
- [ ] Security-sensitive change

**Components and registry status:**

<!-- List affected entries from docs/provenance/components.yml, or explain why none apply. -->

## Problem and outcome

<!-- What user or maintainer problem does this solve? What observable outcome does the change provide? -->

## Scope boundaries

**In scope**

<!-- List the packages, files, behavior, and contracts intentionally changed. -->

**Out of scope**

<!-- List adjacent behavior, refactors, migrations, or follow-up work intentionally not included. -->

## Implementation summary

<!-- Explain the approach and any important architectural decision. Do not rely only on the diff to communicate intent. -->

## Risk assessment

**Risk level:** Low / Medium / High

<!--
Describe impact and mitigations for every relevant area:
- security and trust boundaries
- privacy, credentials, telemetry, or user data
- database, state, migration, or data loss
- network access, providers, external services, or supply chain
- public APIs, protocols, stored formats, backward compatibility, or performance
- packaging, updates, releases, or rollback

Write "None identified" only after considering these areas.
-->

**Rollback or recovery plan**

<!-- How can maintainers safely revert, disable, migrate away from, or recover from this change? -->

**Source of truth before this PR:**

**Source of truth after this PR:**

## Tests and verification

<!-- List the exact commands and results. Explain anything not run and why. -->

| Check | Command or procedure | Result |
| --- | --- | --- |
| Static checks |  |  |
| Automated tests |  |  |
| Manual verification |  |  |

## User evidence

<!--
For user-visible or behavioral changes, attach redacted screenshots, recordings, logs, traces, or before/after output and explain what they prove.
If evidence is not applicable, explain why.
Never include secrets, credentials, private repository content, customer data, or unredacted personal data.
-->

## Documentation

<!-- List updated documentation, release notes, environment variables, migration guidance, or state why no documentation change is needed. -->

## Upstream and third-party attribution

<!--
Write "None" or list every upstream project, source URL, commit/version, license, copied/adapted file or asset, and modification made.
Preserve copyright, attribution, and license notices required by the upstream source.
-->

## Provenance and AI assistance

**Specifications, ADRs, public protocols, or documentation used**

<!-- List the independent sources that drove this implementation. -->

**Other implementations inspected**

<!-- Write "None" or disclose material exposure relevant to an independent replacement. -->

**AI assistance**

<!--
Write "None" or identify the tool, work performed, and source material or
classes of context supplied to it. Routine autocomplete need not be itemized
unless it received restricted source or generated a substantial part of the change.
-->

## Contributor checklist

- [ ] The linked issue and this PR agree on the intended outcome.
- [ ] The change stays within the stated scope and contains no unrelated refactoring or formatting churn.
- [ ] I added or updated tests for behavioral changes, or explained why a test is not applicable.
- [ ] I included redacted user evidence for user-visible or behavioral changes, or explained why it is not applicable.
- [ ] I documented relevant security, privacy, data, migration, network, provider, API, compatibility, packaging, and rollback risk.
- [ ] I added or updated documentation where appropriate.
- [ ] I did not commit secrets, credentials, private data, unreviewed generated output, or sensitive logs.
- [ ] I identified all upstream or third-party code and assets and preserved required attribution and license notices, or this PR contains none.
- [ ] Independent code was implemented from approved specifications rather than copied or source-guided legacy structure.
- [ ] I did not ask AI to disguise, paraphrase, or rewrite legacy or third-party source as an independent implementation.
- [ ] Shadow comparison executes each real side effect at most once, or this PR does not use shadow execution.
- [ ] The change respects the component registry and independent-package dependency allowlists.
- [ ] Every commit includes a `Signed-off-by` trailer required by the [Developer Certificate of Origin](../DCO).
- [ ] This PR is ready for review. If it is not ready, I left it as a Draft.
