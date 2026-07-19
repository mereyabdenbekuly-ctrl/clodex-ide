<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/clodex-logo-on-dark.png">
  <img src="./apps/website/public/clodex-logo-on-light.png" alt="CLODEx" height="72">
</picture>

# CLODEx

### One task. One durable engineering workspace.

[![Website](https://img.shields.io/badge/website-ide.clodex.xyz-00d88a?style=flat-square)](https://ide.clodex.xyz)
[![Free build status](https://img.shields.io/badge/free_build-verification_pending-f59e0b?style=flat-square)](https://ide.clodex.xyz/download)
[![CI](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/workflows/monorepo-ci.yml/badge.svg?branch=main)](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/workflows/monorepo-ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-111827?style=flat-square)](./LICENSE)
![Node](https://img.shields.io/badge/node-22.23.1-43853d?style=flat-square)
![pnpm](https://img.shields.io/badge/pnpm-10.30.3-f69220?style=flat-square)

CLODEx is an open-source, local-first agentic IDE for long-running engineering
work. It keeps code, Git, terminal, browser, models, and MCP tools inside one
durable desktop workspace, with approval and review surfaces for sensitive
actions.

The source is available today. Publication of the next verified cross-platform
**Technical Preview** build for macOS, Windows, and Linux is pending.

<p align="center">
  <strong><a href="https://ide.clodex.xyz/download">Free build status</a></strong>
  ·
  <a href="#free-product-scope">See the Free product scope</a>
  ·
  <a href="#run-from-source">Build from source</a>
  ·
  <a href="./short_doc.md">Русский обзор</a>
</p>

<p align="center">
  <img src="./apps/website/public/product/current/workspace.png" alt="CLODEx durable agent task workspace" width="100%">
</p>

| Durable work | One engineering workspace | Models on your terms |
| --- | --- | --- |
| Keep task history and recover work after restarts instead of rebuilding context from scratch. | Move between files, diffs, Git, terminal, browser, and MCP without leaving the task. | Sign in with CLODEx, bring your own provider key, use a compatible endpoint, or connect local Ollama. |

> **Release status:** direct downloads are paused until a new artifact built
> from canonical `main` passes the enforced Free/managed boundary and
> packaged-byte verification. Community Observed 8 predates that boundary and
> is a legacy tester artifact, not a build verified against the current
> [Free Product Contract](./docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md).

## Why CLODEx

Most AI coding interfaces are optimized for the next message. Real engineering
work is longer: understand a repository, plan a change, edit multiple files,
run commands, inspect the application, review the diff, recover from failure,
and continue tomorrow.

CLODEx treats that work as a durable task rather than a disposable chat.

| A chat-first workflow | CLODEx |
| --- | --- |
| Context is rebuilt from messages | The task retains its workspace and history |
| Tools feel like separate integrations | Files, Git, terminal, browser, and MCP share one workspace |
| A patch is the end of the interaction | Pending edits, diffs, command output, and review remain part of the task |
| One provider defines the workflow | Account-backed models, BYOK, compatible endpoints, and local models coexist |
| Automation is difficult to inspect | Sensitive operations can require explicit approval and remain reviewable |

The product principle is simple:

> **Model output is input, not authority.**

## Free product scope

The following capabilities define the open, local Community product scope.
Release notes remain the source of truth for what is present and accepted in a
specific packaged artifact. The next verified cross-platform build is pending.

| Area | Free product scope |
| --- | --- |
| **Durable tasks** | Searchable task history, workspace-aware context, cancellation, restart recovery, and continued work across sessions. |
| **Code and review** | File editing, Pending Edits, line-level diffs, Git operations, worktrees, local commits, and pull-request review workflows. |
| **Terminal and browser** | Persistent local shell sessions, local ports, embedded browsing, console inspection, screenshots, and visual verification. |
| **Models** | CLODEx account integration, provider API keys, custom OpenAI-compatible endpoints, model selection, and local Ollama. |
| **MCP** | User-configured stdio and remote MCP servers, HTTP/SSE transports, OAuth flows, tools, resources, prompts, and approval-aware execution. |
| **Account access** | Secure CLODEx.xyz sign-in through the system browser with an RFC 8252 loopback callback, state, and PKCE S256. |
| **Language and privacy** | English and Русский (beta), plus a required first-launch allow-or-decline choice for optional product statistics. |
| **Distribution** | macOS Apple Silicon, macOS Intel, Windows x64, Debian/Ubuntu x64, and Fedora/RHEL x64 are planned tester targets; direct packages remain unavailable until the new build passes verification. |

### A typical workflow

1. Open a repository and start a task.
2. Ask CLODEx to explain, plan, implement, or review a change.
3. Let the agent inspect files and use approved local tools.
4. Review Pending Edits, line-level diffs, terminal output, browser state, and
   any permission requests.
5. Accept, revise, commit, or continue the same task later.

CLODEx is designed to keep the core engineering loop in one place, not to
hide it behind a single “done” message.

## Built for review

CLODEx keeps user control visible throughout the task.

```text
Developer request
      ↓
Agent proposes a plan or action
      ↓
Permission and approval checks
      ↓
Local tool or integration executes
      ↓
Diffs, outputs, artifacts, and task history return for review
```

The public source includes explicit permission, approval, diff, and review
surfaces. Read [Security and data](./docs/developer/security-and-data.md) for
the public security model and data-handling contract.

## Proof, not promises

| Claim | Public evidence |
| --- | --- |
| The Free/managed product boundary is explicit and must fail closed for Community packaging | [Free Product Contract](./docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md) · boundary policy and CI checks in this repository |
| The current verified Free binary is not yet published | The [build-status page](https://ide.clodex.xyz/download) remains pending until a new build from canonical `main` passes packaged-byte verification |
| Community Observed 8 is not certified against the current Free contract | Its [legacy release page](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved8) is retained for historical tester context, not as the recommended current download |
| The repository includes CI, provenance, contribution, and secret-scanning controls | [GitHub Actions](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions) · [DCO](./DCO) · [security policy](./SECURITY.md) |
| The project documents its upstream lineage and redistribution obligations | [CLODEx vs Stagewise](./CLODEX_VS_UPSTREAM.md) · [Third-party notices](./THIRD-PARTY-NOTICES.md) |

The evidence archive intentionally distinguishes observed evidence from claims
about external effects. A validation report proves what it actually checked;
it does not turn a preview into a stable product.

## Free build status

Direct downloads are temporarily unavailable. The next Community artifact
will be linked only after all of the following are true:

1. it is built from the exact canonical `main` revision recorded in its release;
2. the Free/managed boundary checks pass;
3. the packaged application passes byte-level inspection;
4. checksums, SBOMs, validation manifests, warnings, and release evidence are
   published with it.

Track publication on the [Free build-status page](https://ide.clodex.xyz/download).
Community Observed 8 remains visible only as a **legacy tester artifact**. It
predates the enforced boundary and must not be treated as satisfying the
current Free Product Contract or as the recommended download.

Unless a future release explicitly says otherwise, Technical Preview packages
do not have a trusted publisher identity: macOS packages may be ad-hoc signed
but are not signed with a trusted Developer ID and are not notarized, Windows
packages are not Authenticode-signed, and Linux packages do not carry a CLODEx
vendor signature. Verify the published checksum and use only the operating
system's per-application review flow. Do not disable Gatekeeper, SmartScreen,
Defender, or equivalent protections globally.

Report installation or testing problems through
[GitHub Issues](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new/choose)
or the [support guide](./SUPPORT.md).

## Connect your models

CLODEx supports four practical connection paths:

1. **CLODEx account:** sign in through CLODEx.xyz and use the keys and models
   available to that account.
2. **Bring your own key:** connect supported model providers directly.
3. **Compatible endpoint:** use a custom OpenAI-compatible API.
4. **Local inference:** connect Ollama, normally at
   `http://localhost:11434`.

For BYOK and custom endpoints, provider terms, availability, and charges remain
between the user and the selected provider. Never include API keys, tokens,
private source, or unredacted logs in a public issue.

## Security and privacy

The Technical Preview is built around inspectable boundaries rather than
invisible trust.

- **Local-first workspace:** task state and desktop tooling are local by
  default. Network access is used only by features and services the user
  selects, such as hosted models, account access, remote MCP, browser
  navigation, or opted-in statistics.
- **System-browser authentication:** CLODEx.xyz login uses state, PKCE S256, a
  one-time opaque code, and an exact loopback callback. Bearer tokens are not
  returned in the callback URL.
- **Protected credentials:** account and provider credentials use the
  application’s protected storage path rather than renderer-local storage.
- **Reviewable actions:** permission prompts, Pending Edits, diffs, and Git
  review surfaces let users inspect changes before commit or merge.
- **Explicit statistics choice:** Community Observed telemetry starts only
  after the user chooses allow or decline.
- **Bounded pseudonymous events:** when allowed, product statistics may include
  a pseudonymous installation ID, counters, bounded timing, enum values, and
  app/platform metadata. The Community Observed contract excludes prompts,
  messages, source code, commands, paths, URLs, API keys, tool arguments, error
  text, feedback text, session recording, and AI tracing.

Read [Security and data](./docs/developer/security-and-data.md). Report
vulnerabilities privately through [SECURITY.md](./SECURITY.md), not through a
public issue.

## Preview scope

The capabilities listed in [Free product scope](#free-product-scope) define the
baseline Community product contract. Source-tree experiments and feature-gated
surfaces are not part of that baseline promise. Release notes are the source of
truth for each published build. Community Observed 8 predates the enforced
Free/managed boundary and is not certified against the current contract.

Contributors can start with the [repository map](./docs/developer/repository-map.md)
and [architecture documentation](./docs/developer/architecture.md).

## Run from source

### Requirements

- Node.js `22.23.1`
- pnpm `10.30.3`
- Git
- macOS, Linux, or Windows

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

Use the checked development command when type checking should run in parallel
with Electron:

```bash
pnpm --dir apps/browser start
```

Environment and provider configuration are documented in
[local development](./docs/developer/local-development.md). Never commit
`.env` files, credentials, signing keys, or local runtime state.

## Validation

Before opening a pull request:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm security:secrets
```

GitHub CI, release manifests, checksums, and attestations are the source of
truth for published artifacts. Start with
[testing and release](./docs/developer/testing-and-release.md) and
[VERSIONING.md](./VERSIONING.md).

## Documentation

| Goal | Document |
| --- | --- |
| Understand the product quickly | [Product overview](./short_doc.en.md) · [Русский обзор](./short_doc.md) |
| Run and develop locally | [Developer handbook](./DEVELOPERS.md) · [Local development](./docs/developer/local-development.md) |
| Navigate the repository | [Repository map](./docs/developer/repository-map.md) |
| Review architecture | [Architecture](./docs/developer/architecture.md) |
| Review security and data handling | [Security and data](./docs/developer/security-and-data.md) · [Security policy](./SECURITY.md) |
| Understand the current preview | [Community Observed builds](./docs/community-observed-builds.md) |
| Understand what the Free build includes | [Community Free Product Contract](./docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md) |
| Understand project lineage | [CLODEx and Stagewise](./CLODEX_VS_UPSTREAM.md) |
| Contribute or collaborate | [Contributing](./CONTRIBUTING.md) · [Collaboration paths](./COLLABORATE.md) |

## Extending CLODEx

The repository contains integration surfaces for:

- MCP servers and OAuth-enabled remote MCP connections;
- reusable skills and context files;
- plugins and extension metadata.

Availability depends on the release channel. Review
[extensions and integrations](./docs/developer/extensions-and-integrations.md)
and the current release notes before presenting an integration as generally
available.

## Project lineage

CLODEx began as a modified version of the open-source Stagewise codebase and
has diverged into an independently maintained project focused on durable agent
work, governed execution, model choice, integration boundaries, and release
evidence.

The exact upstream base commit, reproducible diff method, CLODEx-specific
systems, and continuing upstream-derived areas are documented in
[CLODEx vs Stagewise](./CLODEX_VS_UPSTREAM.md). Upstream copyright and license
notices are preserved in [Third-party notices](./THIRD-PARTY-NOTICES.md).
CLODEx is not affiliated with or endorsed by Stagewise.

## Contributing

Contributions should be scoped, testable, and reviewable.

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md).
2. Follow [VERSIONING.md](./VERSIONING.md).
3. Sign commits according to the repository [DCO](./DCO).
4. Run formatting, type checking, tests, and secret scanning.
5. Include focused tests for changed behavior.

Bug reports, installation feedback, provider problems, documentation fixes,
security reviews, and focused pull requests are welcome.

## Maintainer and community

CLODEx is independently maintained by
[Merey Abdenbekuly](https://github.com/mereyabdenbekuly-ctrl).

- Website: [ide.clodex.xyz](https://ide.clodex.xyz)
- Updates: [X · @CLODEx_lab](https://x.com/CLODEx_lab)
- Testing and support: [SUPPORT.md](./SUPPORT.md)
- Governance: [GOVERNANCE.md](./GOVERNANCE.md)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

If CLODEx is useful, support options are listed on the
[project website](https://ide.clodex.xyz/#support).

## License

CLODEx is distributed under the
[GNU Affero General Public License v3.0](./LICENSE). Third-party components
retain their original licenses and notices.
