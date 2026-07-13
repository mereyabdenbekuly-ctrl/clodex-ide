# Contributing to Clodex

Thank you for helping improve Clodex. Contributions to code, tests,
documentation, security controls, provider integrations, and developer
experience are welcome.

By participating, you agree to follow the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). For questions about where to post,
read [`SUPPORT.md`](SUPPORT.md).

## Contributor workflow

The default external contribution path is:

```text
Issue -> Fork -> Branch -> Draft PR -> CI -> Review -> Squash merge
```

New contributors do not need write or administrator access. Work from a fork,
open a Draft pull request early, and convert it to ready-for-review only after
the acceptance criteria are met.

For a substantial change, start with an issue that states:

- the concrete outcome;
- the files or modules that may be changed;
- sensitive or unrelated areas that must not be changed;
- acceptance criteria;
- required tests and documentation; and
- compatibility, migration, privacy, and security constraints.

If implementation reveals that the scope must expand, stop and discuss the
change before modifying additional subsystems.

## Good first contributions

The safest first contributions are usually:

- a reproducible bug fix in an isolated area;
- focused tests for existing behavior;
- documentation or onboarding improvements;
- a bounded provider or MCP integration;
- accessibility fixes; or
- diagnostics and error-message improvements.

Security-critical authorization, release credentials, irreversible database
migrations, and broad architectural rewrites are not suitable first tasks.
More responsibility is earned progressively under
[`GOVERNANCE.md`](GOVERNANCE.md).

## Development setup

```bash
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm install --frozen-lockfile
pnpm build:packages
```

Use the narrowest relevant commands while developing. Before requesting
review, run the checks affected by the change. The complete baseline is:

```bash
pnpm check
pnpm check:governance
pnpm typecheck
pnpm test
pnpm security:secrets
```

Generated bundles and vendored assets must be updated through their source
scripts rather than edited manually.

## Pull request requirements

A pull request must:

- link the issue or explain why no issue is needed;
- describe the problem, chosen solution, and explicit scope boundaries;
- identify security, privacy, migration, network, and compatibility impact;
- add or update tests for changed behavior;
- include screenshots or a short recording for visible UI changes;
- document new environment variables and external network dependencies;
- preserve upstream and third-party attribution;
- contain no unrelated formatting or refactoring; and
- resolve all review conversations before merge.

Maintainers may ask for a large pull request to be split. The default merge
method for external contributions is **Squash and merge** so that a contribution
can be audited and reverted as one logical change.

## Security and architecture boundaries

Changes touching Guardian decisions, network policy, secrets, process
isolation, protected files, execution runners, release signing, or persistence
migrations require explicit security review by the relevant code owner.

Do not weaken a fail-closed path to make a test pass. Do not add privileged
imports to the renderer, bypass policy checks, log credentials or prompts, or
introduce direct network/filesystem authority into an untrusted process.

Architecture decisions that change a trust boundary should be proposed before
implementation and recorded under [`docs/adr/`](docs/adr/).

## Independent-kernel migration

The current migration follows `legacy -> shadow -> kernel`. Legacy code may
call shell-independent Clodex packages, but `packages/clodex-*` must not depend
on Electron, Karton, `stage-ui`, `apps/browser`, or `@stagewise/*`.

Independent implementations must be driven by Clodex contracts, ADRs,
behavioral specifications, public protocols, and independently written tests.
Do not copy, mechanically translate, rename, or use AI to perform a
source-guided rewrite of legacy or third-party code.

Shadow execution may run both implementations only for pure computation. For
terminal commands, file or Git writes, network requests, persistence, and other
side effects, compare execution plans and execute exactly one plan, or run the
non-authoritative implementation in a disposable sandbox.

See the [migration plan](docs/migration/README.md), [parity
matrix](docs/migration/parity-matrix.md), [provenance
ledger](docs/migration/provenance-ledger.md), and
[ADR-0005](docs/adr/0005-hybrid-strangler-migration.md). Normative rules live
in the [architecture boundaries](docs/architecture/BOUNDARIES.md),
[provenance policy](docs/governance/PROVENANCE_POLICY.md), [security
invariants](docs/security/INVARIANTS.md), and [component
registry](docs/provenance/components.yml).

## AI-assisted contributions

AI assistance is allowed, but the human submitter remains responsible for every
line, test, license obligation, and security consequence. Disclose material
AI-generated portions in the pull request, review them manually, and do not
submit code or assets whose provenance or license you cannot establish.

## Secrets and private data

Do not include API keys, access tokens, private keys, customer data, private
prompts, production URLs containing credentials, or unredacted logs in issues,
commits, fixtures, or pull requests.

Report suspected vulnerabilities privately through
[`SECURITY.md`](SECURITY.md), not through a public issue or discussion.

## Developer Certificate of Origin (DCO)

Clodex uses the [Developer Certificate of Origin 1.1](DCO) for pull requests.
The imported and early bootstrap history predates automated enforcement. By
contributing, you certify that you have the right to submit the contribution
under the applicable open-source license identified for the affected
component.

Every commit must include a `Signed-off-by` trailer matching the commit author:

```text
Signed-off-by: Jane Developer <jane@example.com>
```

Add it automatically with `-s` or `--signoff`:

```bash
git commit -s -m "feat: add local provider adapter"
```

Verified Dependabot commits may use GitHub's canonical Dependabot sign-off.
Other bot or automation exceptions require an explicit, reviewable policy
change; author metadata alone is not trusted as proof of bot identity.

The DCO sign-off is separate from a cryptographic GPG or SSH signature. Pull
requests with missing sign-offs will not be merged.

DCO certifies the contributor's right to submit the change. It does not replace
third-party license compliance or automatically grant the project a unilateral
right to relicense the contribution later. Any future CLA or dual-licensing
requirement must be published before it applies to new contributions.

## Recognition and grants

Merged contributions remain credited through Git history, pull requests,
release notes, and [`CONTRIBUTORS.md`](CONTRIBUTORS.md). Some scoped work may be
eligible for a compute grant under [`COLLABORATE.md`](COLLABORATE.md).

A grant never guarantees merge, review priority, maintainer status, or
architectural authority. Acceptance is based on scope, quality, security, and
project fit.
