# Agent OS

Agent OS is a local, feature-gated operating layer for Clodex. It adds visual
memory, a floating action controller, browser automation policy, internal
debugging, native skill installation, lifecycle hooks, and LAN remote control.

All Agent OS features are disabled by default. Enabling a preview gate only
makes the corresponding settings available; modules that capture data or
accept remote commands still require their own explicit enablement.

## Architecture

Shared contracts and defaults:

```text
apps/browser/src/shared/agent-os.ts
apps/browser/src/shared/feature-gates.ts
apps/browser/src/shared/karton-contracts/ui/index.ts
```

Backend services:

```text
apps/browser/src/backend/services/agent-os/
  index.ts
  state-store.ts
  privacy.ts
  chronicle.ts
  micro-controller.ts
  browser-use-policy.ts
  debug-inspector.ts
  skill-installer.ts
  hooks.ts
  remote-control.ts
```

Desktop UI:

```text
apps/browser/src/ui/screens/settings/agent-os/
apps/browser/src/ui/screens/main/_components/codex-micro-overlay.tsx
apps/browser/src/ui/screens/main/_components/browser-use-approval-prompt.tsx
```

`AgentOsService` owns the module services, registers Karton procedures, mirrors
the persisted state into `AppState.agentOs`, and exposes narrow integration
methods to the browser sandbox, toolbox, agent manager, and URL handlers.

## Persistence

Agent OS stores local state below the existing Clodex user-data root:

```text
user-data/agent-os/
  state.json
  chronicle/
    segments/
    ocr/
    summaries/
  installed-skills/
  remote-control/
    clients.json
```

State writes use a temporary file plus rename and request owner-only file
permissions. Volatile values such as active capture state, browser approval
requests, server URLs, and QR images are reset during startup.

Chronicle directories request mode `0700`, and screenshot artifacts request
mode `0600`. Retention and state-limit cleanup delete only artifacts resolved
inside the configured Chronicle root; an invalid persisted path is ignored
rather than passed to the filesystem.

## Feature gates

| Module | Gate |
| --- | --- |
| Chronicle | `chronicle-visual-memory` |
| Micro controller | `codex-micro-controller` |
| Browser use policy | `browser-use-policy-engine` |
| Debug inspector | `agent-os-debug-inspector` |
| Native skill install | `native-skill-install` |
| Hooks | `agent-hooks` |
| Remote control | `remote-control-pairing` |

The gates have `defaultEnabled: false` on every release channel. Backend
procedures reject attempts to activate gated functionality when its gate is
off. Disabling a gate does not silently delete user data.

## Chronicle visual memory

Chronicle never captures a screenshot before the user explicitly enables it.
The MVP captures the Clodex UI web contents on demand. Before persistence, the
entire captured image is blurred and textual metadata is redacted. Strict mode
also redacts obvious email addresses.

Supported operations include manual and visual capture, recent-event lookup,
text search, simple time-window summaries, retention cleanup, and complete
artifact deletion.

### Current limitation

The MVP intentionally does not perform native OCR, password-field detection,
private-tab classification, background recording, ScreenCaptureKit capture, or
Apple Vision processing. Full-frame blur is the privacy-preserving fallback
until selective redaction is available.

## Micro virtual controller

The Micro controller is a draggable compact/expanded overlay. Its position,
expanded state, configured slots, last action, and push-to-talk state are
persisted through Agent OS state.

Default slots:

- Push to talk (UI state only)
- New agent
- Insert a skill mention
- Insert `/review`
- Open command palette
- Stop the current agent

There is no physical HID or audio recording integration in this MVP.

## Browser use policy

Browser automation calls from the sandbox and toolbox pass through an
origin-scoped policy checker when the feature gate and module are enabled.

Unknown origins default to:

- `ask` for read, click, file transfer, and history
- `block` for unrestricted CDP access

An `ask` decision creates a short-lived desktop prompt with:

- Allow once
- Always allow for the origin
- Block once
- Always block for the origin

Persistent responses update only the requested capability for the normalized
origin. Disabling the policy engine resolves outstanding requests as blocked.

## Debug inspector

The inspector receives sanitized events from Karton RPC calls, agent command
lifecycle, browser policy decisions, process errors, hooks, and remote control.
It retains at most 500 events and supports pause, filter, search, clear, and
JSON export.

Messages and payloads are redacted before entering the event store. Sensitive
keys such as `password`, `authorization`, `token`, and `apiKey` are replaced,
and supported token/private-key patterns are removed recursively.

## Native skill installation

Supported inputs:

- A single `SKILL.md`/Markdown file
- `.skill`
- `.clodex-skill`
- A ZIP-compatible archive using either package extension
- `clodex://skill/install?path=...`
- `clodex://skill/install?url=...`

Every install requires a preview. Packages must contain exactly one
`SKILL.md` with `name`, `description`, and semantic `version` frontmatter.
Archive traversal, absolute paths, symbolic links, excessive file count, and
oversized compressed or extracted packages are rejected. Existing IDs require
an explicit replace action. Replacement is staged through a temporary copy and
backup so a failed install can restore the previous skill instead of leaving a
partially replaced directory.

Remote package downloads accept only credential-free HTTP/HTTPS URLs. The
downloader resolves and rejects loopback, private, link-local, and otherwise
non-public targets, repeats that validation for every redirect, and streams
the response through a hard size limit. Pending downloads use unique
owner-only temporary files that are removed when superseded or installed.

Installed skills are mounted through the always-enabled
`globalskills-agent-os` global skill source.

## Hooks

Hook definitions are persisted but created disabled. Supported trigger names:

```text
before-turn
after-turn
before-command
after-command
before-file-edit
after-file-edit
approval-requested
```

Prompt hooks can add context to a turn. Command hooks run with a timeout,
restricted environment, capped output, and require both explicit command
approval and a trusted workspace. Failures are recorded and returned without
crashing the agent.

The current automatic integration runs `before-turn` and `after-turn`.
Command, file-edit, and approval triggers are available through the service and
settings test action but are not yet automatically emitted by every legacy
tool path. Agent-kind hooks are represented in the contract but intentionally
skip until a dedicated helper-agent runner is configured.

## Remote control

Remote control starts only after explicit enablement. The server binds on a
random local port and accepts loopback or private-network clients. Pairing uses
a six-digit code that expires after five minutes and a QR URL served by the
desktop.

Successful pairing returns a random client token once. Only its SHA-256 hash is
stored locally. Pairing codes are single-use, expire after five minutes, and
guess attempts are limited to 20 per minute per client address. Expired
pairing state is cleared.

Clients can be revoked, and revocation immediately closes any authenticated
WebSocket for that token. Command handling re-checks authorization so a
revoked token cannot continue issuing commands or authenticate again.
WebSocket commands remain blocked until the user separately enables
**Allow remote commands**.

The MVP transports its pairing page and WebSocket over plain LAN HTTP/WS. It
has no TLS termination, cloud relay, internet discovery, Bonjour
advertisement, or mobile application. It should therefore be used only on a
trusted local network. The bundled page is a minimal LAN command surface.

## RC verification

The Agent OS RC hardening pass was verified on July 11, 2026:

- Full monorepo test run: 14/14 Turbo tasks passed.
- Browser tests: 120 files and 1,167 tests passed.
- Agent Core tests: 52 files and 644 tests passed.
- Focused Agent OS regression suite: 11 files and 60 tests passed.
- `pnpm -F clodex typecheck` passed.
- Scoped Biome checks for the 14 affected source files passed.
- All seven Agent OS feature gates were verified disabled by default on every
  release channel.
- The final arm64 macOS release-channel rehearsal package passed strict
  code-signature verification, DMG and ZIP integrity checks, the
  `--smoke-test` import-tree check, and a clean-profile full UI launch.
- Release packaging is pinned to exact Node.js `22.23.1`; `make`, `package`,
  and `publish` reject a mismatched runtime before Forge starts.
- The clean-profile smoke and UI launch checks use software rendering via
  `--disable-gpu` for deterministic validation on remote macOS runners.

The focused regressions cover pairing replay/rate limiting/revocation,
bounded public-host downloads, transactional skill replacement, Chronicle
artifact permissions and safe deletion, state-limit artifact cleanup, secret
redaction, Micro StrictMode lifecycle, Chronicle attachment, native skill
routing, and Guardian persistence.

On macOS versions before 26, local packaging requires
`CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true` so Forge uses the legacy `.icns`
asset and applies a valid ad-hoc signature. The override is rejected in CI and
its output is for local verification only, not distribution.

The reusable release workflow validates Apple signing/notarization, Azure
Trusted Signing, and update-server configuration before creating the tag. For
macOS artifacts it then notarizes and staples the DMG, runs the installed-app
release validator, and uploads the JSON manifest plus SHA-256 checksums.

The final release checklist and current signing/notarization prerequisites are
recorded in `docs/agent-os-release-acceptance.md`.

## Tests

Focused backend coverage lives beside the services:

```text
privacy.test.ts
browser-use-policy.test.ts
chronicle.test.ts
hooks.test.ts
skill-installer.test.ts
skill-download.test.ts
remote-control.test.ts
```

Run:

```bash
pnpm test
pnpm -F clodex typecheck
```
