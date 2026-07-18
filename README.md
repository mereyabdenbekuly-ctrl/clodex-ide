<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/clodex-logo-on-dark.png">
  <img src="./apps/website/public/clodex-logo-on-light.png" alt="Clodex" height="72">
</picture>

# Clodex

### Local-first agentic IDE with governed execution

[![Website](https://img.shields.io/badge/website-ide.clodex.xyz-00d88a?style=flat-square)](https://ide.clodex.xyz)
![Status](https://img.shields.io/badge/status-technical_preview-2563eb?style=flat-square)
[![Community build](https://img.shields.io/badge/community_observed-1.16.0--observed7-00d88a?style=flat-square)](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved7)
[![License](https://img.shields.io/badge/license-AGPL--3.0-111827?style=flat-square)](./LICENSE)
![Node](https://img.shields.io/badge/node-22.23.1-43853d?style=flat-square)
![pnpm](https://img.shields.io/badge/pnpm-10.30.3-f69220?style=flat-square)
[![X](https://img.shields.io/badge/X-@CLODEx__lab-111111?style=flat-square)](https://x.com/CLODEx_lab)

Clodex is an open-source, local-first agentic development environment for
governed software work. It combines durable AI tasks, code and Git tools,
terminal, browser, memory, model routing, and controlled execution in one
Electron workspace. Local testing does not require a Clodex account: use your
own provider API key, a custom OpenAI-compatible endpoint, or a local Ollama
runtime.

It is an early-stage, solo-led research and engineering project. The current
Technical Preview is intended to validate architecture and real workflows; it
is not presented as a production-mature IDE or an established community.

It is built around a simple principle:

> Model output is untrusted input. Authority comes from explicit policy,
> isolated runtimes, and user-controlled review.

**Current release status:** Technical Preview. The architectural core is
implemented and tested locally. The public desktop binaries described below
are unsigned community test artifacts, not an official stable release.
Advanced execution lanes remain feature-gated until their live promotion
evidence and manual sign-off are complete.

## Community test build

The current public tester build is **`1.16.0-communityobserved7`**, produced from the
canonical `main` commit
[`981311304fb4c648ebbaa0b85fbed0602aab2c9f`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/commit/981311304fb4c648ebbaa0b85fbed0602aab2c9f)
by [GitHub Actions run `29615260553`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/runs/29615260553)
and published as a clearly separated
[GitHub community prerelease](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved7).
It adds the **Русский (beta)** interface and a required first-launch privacy
choice with **Allow anonymous statistics** as the primary action and a visible
**Continue without statistics** path. The previous
[community4 prerelease](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-community4)
remains available as the telemetry-free predecessor.

| Platform            | Package   | Download |
| ------------------- | --------- | -------- |
| macOS Apple Silicon | ARM64 DMG | [Download](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/clodex-community-observed-1.16.0-communityobserved7-arm64.dmg) |
| macOS Intel         | x64 DMG   | [Download](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/clodex-community-observed-1.16.0-communityobserved7-x64.dmg) |
| Windows             | x64 EXE   | [Download](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/clodex-community-observed-1.16.0-communityobserved7-x64-setup.exe) |
| Linux               | x64 DEB   | [Download](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/clodex-community-observed_1.16.0-communityobserved7_amd64.deb) |
| Linux               | x64 RPM   | [Download](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/clodex-community-observed-1.16.0.communityobserved7-1.x86_64.rpm) |

Download [`SHA256SUMS.txt`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/SHA256SUMS.txt)
from the same prerelease and verify the installer before opening it. The exact
source manifests, CycloneDX SBOMs, warnings, platform validation reports, and
byte-level audit report are retained in the compact
[evidence archive](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved7/clodex-community-observed-1.16.0-communityobserved7-evidence.zip).
Do not use repackaged binaries from an unverified mirror.

Before onboarding, the build requires an explicit allow-or-decline choice. No
PostHog client starts before that decision. If anonymous statistics are
allowed, only the backend client may send allowlisted counters, bounded timing,
enum metadata, app/platform metadata, and a pseudonymous installation ID.
Renderer capture, person profiles, GeoIP enrichment, prompts, messages, source
code, commands, paths, URLs, API keys, tool arguments, error or feedback text,
exceptions, account identification, session recording, full telemetry, and AI
tracing are disabled. The choice can be changed later in Settings.

### Verify and install

Community packages intentionally have no trusted publisher identity. macOS
apps are ad-hoc signed and not notarized, Windows packages are not
Authenticode-signed, and Linux packages have no CLODEx release signature.
Open source makes the source inspectable; it does not authenticate a downloaded
binary.

1. Confirm that the bundle manifest records the expected version, platform,
   architecture, and source commit.
2. Verify the selected file before installation. For example:

   ```bash
   # macOS: replace FILE with the downloaded DMG name
   grep "  FILE$" SHA256SUMS.txt | shasum -a 256 -c -

   # Linux: replace FILE with the downloaded DEB or RPM name
   grep "  FILE$" SHA256SUMS.txt | sha256sum -c -
   ```

   On Windows, compare `Get-FileHash <installer.exe> -Algorithm SHA256` with
   the installer entry in `SHA256SUMS`.
3. Install for your platform:
   - **macOS:** open the matching DMG and drag the app to `/Applications`. On
     first launch, use Finder's per-app **Control-click -> Open** review only
     after verifying the bundle. Do not disable Gatekeeper globally.
   - **Windows:** run the x64 setup. SmartScreen may warn about an unknown
     publisher; use only its per-file review path after verifying the bundle.
     Do not disable SmartScreen or Defender globally.
   - **Linux:** install either the downloaded DEB (`apt install ./<file>.deb`)
     or RPM (`rpm -i ./<file>.rpm`) for your distribution.

The observed community build has a separate application identity. The
currently published `communityobserved7` artifact remains unchanged and does
not include account sign-in. Starting with the next observed build produced
from the updated policy, secure CLODEx.xyz sign-in is enabled through the
system browser with an RFC 8252 loopback callback bound by state and PKCE.
Default OS protocol registration and auto-update remain excluded, the
first-launch privacy choice must be completed before normal IDE use, and newer
community builds must still be installed manually.

### First launch: connect a model

1. Choose **System**, **English**, or **Русский (beta)** in onboarding or
   **Settings -> General**, then restart once to verify persistence.
2. Leave anonymous telemetry off, or explicitly opt in after reviewing the
   description in onboarding or settings.
3. Open a local project or workspace.
4. In onboarding or **Settings -> Models & Providers**, choose one of:
   - a BYOK API key for a supported provider such as OpenAI, Anthropic, or
     Google;
   - a custom OpenAI-compatible endpoint; or
   - local Ollama, normally at `http://localhost:11434`.
5. Test the connection, select a discovered model, and start a small task.

Provider usage and billing remain between you and the provider. Never include
API keys, tokens, private source, or unredacted logs in an issue or tester
report. See the full
[community unsigned build policy](./docs/community-unsigned-builds.md) and
[support guide](./SUPPORT.md).

## Start here

| Goal                                    | Document                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Install the current community build     | [Community build above](#community-test-build) · [Build policy](./docs/community-unsigned-builds.md) |
| Understand the product in a few minutes | [Product overview](./short_doc.en.md) · [Русский обзор](./short_doc.md)                       |
| Run Clodex locally                      | [Developer handbook](./DEVELOPERS.md)                                                         |
| Study the complete system               | [Full project documentation](./full_doc.md)                                                   |
| Navigate the engineering documentation  | [Developer documentation index](./docs/developer/README.md)                                   |
| Review the architecture                 | [Architecture](./docs/developer/architecture.md)                                              |
| Review security and data handling       | [Security and data](./docs/developer/security-and-data.md) · [Security policy](./SECURITY.md) |
| Understand project lineage              | [Clodex and Stagewise upstream](./CLODEX_VS_UPSTREAM.md)                                     |
| Contribute or collaborate               | [Contributing](./CONTRIBUTING.md) · [Collaboration paths](./COLLABORATE.md)                   |
| Get help or report a testing problem    | [Support and report channels](./SUPPORT.md)                                                   |
| Understand project governance           | [Governance](./GOVERNANCE.md) · [Code of conduct](./CODE_OF_CONDUCT.md)                      |
| Follow the independent-kernel migration | [Hybrid strangler plan](./docs/migration/README.md)                                           |
| Explore the live project                | [ide.clodex.xyz](https://ide.clodex.xyz)                                                      |

<p align="center">
  <img src="./apps/website/public/product/current/workspace.png" alt="Clodex persistent task workspace" width="100%">
</p>

## Project lineage

Clodex began as a modified version of the open-source Stagewise codebase and
has since diverged into an independently maintained project focused on
governed execution, evidence, policy enforcement, model routing, runner
isolation, and session continuity.

The exact upstream base commit, reproducible diff method, Clodex-specific
systems, and continuing upstream-derived areas are documented in
[`CLODEX_VS_UPSTREAM.md`](./CLODEX_VS_UPSTREAM.md). Upstream copyright and
license notices are preserved in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). Clodex is not affiliated
with or endorsed by Stagewise.

## Why Clodex

A conventional coding assistant produces the next answer or patch. Clodex
models engineering work as a durable task with its own state, workspaces,
processes, permissions, evidence, and review lifecycle.

A task can:

1. retain context across long-running work and application restarts;
2. operate across files, Git, terminals, browser tabs, MCP tools, and runners;
3. route work between models without changing the surrounding workflow;
4. request approval before high-impact shell, network, browser, or remote
   actions;
5. execute locally or move to Docker, SSH, or cloud-backed environments;
6. return diffs, receipts, artifacts, and a self-contained final result.

## Core capabilities

| Area                       | What Clodex provides                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Persistent tasks**       | Searchable task history, projects, workspaces, forks, goals, progress, token budgets, and time budgets.                      |
| **Agent runtime**          | Managed turns, cancellation, recovery, collaboration modes, tool execution, and supervised lifecycle handling.               |
| **Code workspace**         | File editing, pending edits, line-level diffs, Git operations, worktrees, pull-request review, and protected merge flows.    |
| **Terminal and browser**   | Persistent shell sessions, local ports, browser/CDP context, console output, screenshots, and visual verification.           |
| **Evidence-backed memory** | Scoped memory, append-only evidence records, retrieval, provenance, checkpoints, and bounded context injection.              |
| **Model Fabric**           | Provider-neutral model routing, endpoint health, fallbacks, budget controls, usage accounting, and policy publication.       |
| **Execution Fabric**       | Local execution, SSH sessions, Docker runners, custom runner contracts, cloud-task foundations, and portable snapshots.      |
| **Guardian**               | Independent authorization decisions for sensitive capabilities, fail-closed outcomes, approval escalation, and audit events. |
| **Network Policy**         | Destination grants, DNS validation, controlled browser access, MCP egress enforcement, and an audit ledger.                  |
| **Extensions**             | MCP servers, skills, signed plugins, private marketplaces, runner SDKs, and capability-bounded generated apps.               |
| **Continuity**             | Session checkpoints, crash recovery, memory synchronization, artifact capture, and experimental session teleportation.       |

## Architecture

Clodex separates user interface, agent execution, tools, secrets, and policy
into explicit process and trust boundaries.

```mermaid
flowchart TB
    USER["Developer"] --> UI["Electron renderer"]
    UI <--> IPC["Karton typed IPC"]
    IPC <--> MAIN["Electron main process"]

    MAIN <--> AGENT_HOST["Agent Host process"]
    MAIN <--> MCP_HOST["MCP Host process"]
    MAIN <--> SANDBOX["Sandbox workers"]

    AGENT_HOST --> CORE["Agent Core"]
    CORE --> TASKS["Task lifecycle and goals"]
    CORE --> MEMORY["Evidence memory and context ledger"]
    CORE --> FABRIC["Model Fabric"]
    CORE --> POLICY["Guardian and Zero-Trust policy"]

    POLICY --> EXECUTION["Local, SSH, Docker, or cloud execution"]
    EXECUTION --> ARTIFACTS["Artifacts, receipts, and checkpoints"]
    ARTIFACTS --> MEMORY
```

### Important packages

```text
apps/browser/                 Electron desktop application
apps/website/                 Public project website
agent/runtime-node/           Isolated Node.js agent runtime
packages/agent-core/          Agent lifecycle, memory, routing, and policy
packages/agent-shell/         Shell and execution contracts
packages/clodex-contracts/    Shell-independent Stage 0 kernel contracts
packages/mcp-runtime/         MCP transport and protocol runtime
packages/runner-sdk/          External runner integration SDK
packages/karton/              Typed state and RPC transport
packages/stage-ui/            Shared interface components
```

For a complete map, see
[`docs/developer/repository-map.md`](./docs/developer/repository-map.md).

## Security model

Clodex does not rely on a prompt asking the model to behave safely. Sensitive
operations pass through deterministic controls outside the model runtime.

- **Fail closed:** ambiguous or invalid authorization results do not execute.
- **Isolated hosts:** agent turns, MCP servers, and sandboxed workloads run
  outside the renderer.
- **Explicit capabilities:** possessing a tool does not automatically grant
  authority to use it.
- **Controlled egress:** network destinations are evaluated independently of
  model intent.
- **Protected storage:** credentials use OS-backed storage; sensitive task
  artifacts use context-bound authenticated encryption.
- **Human review:** pending edits, permission prompts, protected merge flows,
  and high-impact approvals keep final authority with the user.
- **Supply-chain checks:** extension identity, signatures, integrity,
  compatibility, rollback, and quarantine are verified before activation.
- **Privacy-aware audit:** operational events avoid storing prompts, source
  code, audio, credentials, or other unnecessary sensitive content.

Read the detailed model in
[`docs/developer/security-and-data.md`](./docs/developer/security-and-data.md).
Report vulnerabilities through [`SECURITY.md`](./SECURITY.md), not through a
public issue.

## Capability status

| Capability                                           | Status                          |
| ---------------------------------------------------- | ------------------------------- |
| Desktop workspace, files, Git, terminal, and browser | **Available for local testing** |
| Task lifecycle, goals, scoped memory, and recovery   | **Available for local testing** |
| MCP runtime and isolated Agent Host                  | **Available for local testing** |
| Local and SSH execution                              | **Available for local testing** |
| Docker and external runner control plane             | **Preview**                     |
| Guardian and managed network egress                  | **Preview**                     |
| Signed extensions and generated apps                 | **Preview**                     |
| Cloud Tasks and Session Teleport                     | **Labs / promotion-gated**      |
| Unsigned macOS, Windows, and Linux community builds  | **Available for public testing** |
| Official signed cross-platform distribution          | **Pending promotion evidence**  |

The status labels are deliberate: implemented foundations are not presented as
stable production capabilities until real installation evidence, monitoring,
rollback, and manual promotion checks are complete.

## Run from source

### Requirements

- Node.js `22.23.1`
- pnpm `10.30.3`
- Git
- macOS, Linux, or Windows for development
- macOS for DMG packaging and notarization

### Setup

```bash
git clone https://github.com/mereyabdenbekuly-ctrl/clodex-ide.git
cd clodex-ide

corepack enable
corepack prepare pnpm@10.30.3 --activate

cp .env.example .env
cp .env.example .env.dev

pnpm install --frozen-lockfile
pnpm build:packages
pnpm --dir apps/browser start:fast
```

Use the checked development command when you want type checking to run in
parallel with Electron:

```bash
pnpm --dir apps/browser start
```

Environment and provider configuration are documented in
[`docs/developer/local-development.md`](./docs/developer/local-development.md).
Never commit `.env`, credentials, signing keys, or local runtime state.

## Validation

Run the complete local validation suite before opening a pull request:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm security:secrets
```

Validated baseline on **July 12, 2026**:

| Gate                     |           Result |
| ------------------------ | ---------------: |
| Package builds           |          `7 / 7` |
| Typecheck tasks          |        `14 / 14` |
| Test tasks               |        `16 / 16` |
| Automated tests          |   `3,322 passed` |
| Working-tree secret scan |     `0 findings` |
| Website production build |         `passed` |
| Desktop startup smoke    |         `passed` |
| Main-plan readiness      |     `ready=true` |
| Stable promotion         | `evidence-gated` |

CI and signed release evidence remain the source of truth for a published
artifact. See
[`docs/developer/testing-and-release.md`](./docs/developer/testing-and-release.md)
and [`VERSIONING.md`](./VERSIONING.md).

## Extending Clodex

Clodex exposes several integration surfaces:

- **MCP:** connect local stdio or remote Streamable HTTP/SSE servers;
- **Skills:** package reusable agent instructions and workflows;
- **Plugins:** distribute signed capabilities and optional executable runtimes;
- **Runner SDK:** integrate Docker, SSH, cluster, or custom execution backends;
- **Generated Apps:** create task-owned interactive tools with explicit grants;
- **Automations:** schedule bounded tasks with declared capabilities.

Start with
[`docs/developer/extensions-and-integrations.md`](./docs/developer/extensions-and-integrations.md).

## Contributing

Contributions should be scoped, testable, and reviewable.

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md).
2. Follow the commit and versioning rules in [`VERSIONING.md`](./VERSIONING.md).
3. Sign commits according to the repository [`DCO`](./DCO).
4. Run formatting, type checking, tests, and secret scanning.
5. Include focused tests for changed behavior.

Use the repository issue templates for bugs, feature proposals, documentation,
installation and provider problems, security questions, and independent tester
reports. Use GitHub Discussions for design questions and community proposals.

The contributor trust ladder, maintainer responsibilities, and access policy
are defined in [`GOVERNANCE.md`](./GOVERNANCE.md). Scoped compute grants and
longer-term collaboration paths are described in
[`COLLABORATE.md`](./COLLABORATE.md).

## Maintainers and community

Clodex is currently maintained independently by
[Merey Abdenbekuly](https://github.com/mereyabdenbekuly-ctrl) and welcomes
external contributors, testers, security reviewers, research collaborators,
and integration partners. Current roles and upstream credits are listed in
[`CONTRIBUTORS.md`](./CONTRIBUTORS.md).

Follow project updates on [X · @CLODEx_lab](https://x.com/CLODEx_lab).

## Support independent development

If Clodex is useful to you, the current support options and their terms are
listed on the [Clodex website](https://ide.clodex.xyz/#support). Financial
support does not buy roadmap priority, repository access, or merge decisions.

## License

Clodex is distributed under the
[GNU Affero General Public License v3.0](./LICENSE).
Third-party components and notices are listed in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
