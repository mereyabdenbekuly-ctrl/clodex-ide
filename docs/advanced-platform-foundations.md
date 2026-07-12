# Advanced platform foundations

Дата: 2026-07-11

Этот инкремент добавляет backend foundations для функций, найденных при
сравнении с Claude Desktop.

## Scheduled Automations

- persistent encrypted store;
- once, interval и five-field cron schedules;
- timezone-aware cron evaluation;
- retry с exponential backoff;
- missed-run policies: `skip`, `run-on-wake`, `coalesce`;
- обработка Electron `powerMonitor.resume`;
- local/cloud execution target;
- bounded run ledger;
- explicit capability grants для unattended mode;
- Karton API: list/create/update/delete/run/enable.

Feature gate: `automations`.

Scheduler теперь синхронизирует least-privilege native registration с ближайшим
enabled run. Windows Task Scheduler использует `WakeToRun`; macOS launchd и
Linux user systemd запускают Clodex в due time либо сразу после resume. Любая
ошибка registration fail-safe откатывается к Electron resume reconciliation.

## Generated App Capability Bridge

- versioned `postMessage` request/response protocol;
- encrypted grants scoped by owner agent and app;
- expiry/revoke;
- 30 calls per minute;
- 1 MB result limit;
- read-only allowlisted MCP calls;
- bounded 30-second `askAgent`;
- launch existing automation.

Feature gate: `artifact-bridge`.

Capabilities are denied until the trusted Clodex UI stores a grant.

## Executable Extensions

- plugin permission `process`;
- stdio MCP summary type;
- `runtime/manifest.json`;
- platform/architecture compatibility;
- entrypoint containment and realpath check;
- SHA-256 integrity binding;
- executable-file validation;
- fixed runtime arguments;
- default-disabled feature gate;
- execution remains in the existing supervised MCP host process.

Feature gate: `executable-extensions`.

Example:

```json
{
  "schemaVersion": 1,
  "runtimes": [
    {
      "id": "server",
      "kind": "executable",
      "entrypoint": "runtime/server",
      "sha256": "<64 lowercase hex chars>",
      "args": [],
      "platforms": ["darwin", "linux", "win32"],
      "architectures": ["arm64", "x64"],
      "limits": {
        "maxMemoryMb": 256,
        "requestTimeoutMs": 30000
      }
    }
  ]
}
```

`limits` are validated as a signed policy contract and are now forwarded to
the isolated MCP host:

- Linux uses Bubblewrap for a deny-by-default write/network boundary and
  `prlimit` when available, plus an RSS kill monitor.
- macOS uses `sandbox-exec` with a generated deny-default profile and an RSS
  kill monitor.
- Windows fails closed when a plugin requests denied network/filesystem
  capabilities that this build cannot isolate. Fully granted runtimes still
  receive timeout and working-set enforcement.
- Every MCP operation is capped by the runtime-specific request timeout.

## Spaces

- encrypted persistent Space domain;
- workspace paths, links, instructions and archive state;
- CRUD Karton API;
- one-time migration/import from current workspace-derived Projects;
- workspace-root deduplication.

Feature gate: `spaces`.

Sessions, generated apps and automations remain independent records and can be
joined to a Space by workspace/owner IDs in the product UI. A later schema
migration can add explicit relation tables without changing existing agents.

## Session continuity

- readiness API for cloud teleport and sharing;
- continuation of an existing session with `executionTarget: cloud`;
- read-only transcript payload containing only user/assistant text;
- maximum 200 messages and 50,000 characters per message;
- configured HTTPS sharing adapter;
- expiring share records;
- revoke and local encrypted ledger.

Feature gate: `session-continuity`.

Sharing backend:

```text
POST   <CLODEX_SESSION_SHARING_URL>/v1/session-shares
DELETE <CLODEX_SESSION_SHARING_URL>/v1/session-shares/:id
```

Both calls require the current account bearer token. Share creation remains
unavailable when the HTTPS endpoint or signed-in account is absent.

## Product UX

The desktop UI now includes:

1. An Automations settings screen with create/edit/delete, run-now,
   enable/disable, schedule, retry, missed-run, execution-target and capability
   grant controls.
2. Generated-app capability grant/revoke UI with per-tool MCP allowlisting and
   grant expiry.
3. Signed executable runtime review during plugin install/update, including
   package/runtime hashes, platform/architecture and declared limits.
4. A Spaces view alongside Projects with CRUD, project import, workspace paths,
   links, persistent instructions and related sessions.
5. Session context-menu actions for cloud teleport, readiness diagnostics,
   read-only share creation/copy/revoke and expiry.

## Remaining product work

1. Join generated apps and automations explicitly into Space detail.
2. Add a Windows Job Object backend so Windows runtimes can support restricted
   network/filesystem grants instead of failing closed.
3. Replace deprecated macOS `sandbox-exec` with a separately signed native
   sandbox helper before Apple removes the compatibility interface.

## Native wake registration

The automation scheduler keeps one least-privilege OS registration synchronized
with its earliest enabled run:

- Windows Task Scheduler uses `WakeToRun=true` and can wake the machine.
- macOS launchd starts Clodex at the scheduled time or coalesces the launch
  immediately after resume. It deliberately does not invoke privileged
  `pmset`.
- Linux installs a persistent user systemd timer, which launches immediately
  after a missed timer on resume or reboot.

Commands are invoked directly without a shell, registration files are written
with user-only permissions, and failures fall back to Electron resume
reconciliation.
