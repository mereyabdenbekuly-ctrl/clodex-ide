# P2 Desktop Automation macOS preview — threat model

## Security objective

Desktop automation is a narrow fallback for native macOS UI. Browser/CDP
remains the preferred automation path for web content.

The preview must not:

- run without explicit user enablement and a visible active session;
- operate without Screen Recording and Accessibility permission;
- act in an unknown application without an allowlist decision or live
  approval;
- expose editable text values, secure fields, passwords, or arbitrary
  accessibility attributes;
- execute model-provided AppleScript, shell commands, coordinates, or native
  binaries;
- continue after the global kill switch, permission revocation, feature-gate
  disablement, teardown, or application focus change.

## Architecture

The trusted Electron main process owns `DesktopAutomationService`. It is
feature-gated by `desktop-automation-macos-preview`, which is disabled by
default on every release channel.

The macOS adapter uses only:

- Electron `desktopCapturer` for a bounded frontmost-window screenshot;
- Electron `systemPreferences` for Screen Recording and Accessibility status;
- Electron `globalShortcut` for the fixed emergency accelerator
  `CommandOrControl+Shift+Escape`;
- `/usr/bin/osascript` with three static, source-controlled scripts for
  frontmost-app metadata, bounded accessibility inspection, and `AXPress`.

`shell: true`, arbitrary script input, dynamic AppleScript source, extracted
third-party Swift/Rust modules, and redistributed native bindings are
forbidden.

## Permission and session boundary

1. The user enables the preview feature gate.
2. The Agent OS settings screen explicitly requests Screen Recording and
   Accessibility/Automation access.
3. The provider cannot be enabled until both required statuses are granted.
4. Enabling the provider must successfully register the global kill switch.
5. The user starts a protected session.
6. A persistent visual indicator remains visible for the whole active session.
7. Disabling the gate/provider, stopping the session, revoking a permission,
   teardown, or the global kill switch fails pending work closed.
8. Permission, session ID, kill-switch state, frontmost bundle ID, and
   frontmost window title are revalidated immediately before and after
   provider calls.

The persisted Agent OS state never restores an active session after restart.
Session IDs, current-app state, pending approvals, and kill-switch registration
are excluded from persisted state and reset during startup. Only durable
provider settings, permission snapshots, app policies, kill-switch state, and
content-free timestamps remain on disk.

## Capture boundary

Capture is restricted to the frontmost application window:

- maximum requested thumbnail size is 1920×1080;
- maximum accepted PNG payload is 12 MiB;
- whole-screen capture is not exposed to the agent tool;
- source selection uses only one exact normalized window-title match, or one
  exact normalized app-name fallback;
- substring matches and ambiguous exact matches fail closed;
- the frontmost bundle ID and window title are checked before and after
  capture;
- resulting images are stored through `AttachmentsService`, so P1 protected
  attachment storage remains in effect;
- capture requires an active visible session and an app policy decision.

## Accessibility boundary

Inspection returns at most 100 pressable elements and only these roles:

- `AXButton`;
- `AXCheckBox`;
- `AXRadioButton`;
- `AXPopUpButton`;
- `AXMenuButton`;
- `AXLink`;
- `AXDisclosureTriangle`.

Editable text controls, text areas, values, selected text, clipboard contents,
keyboard input, coordinates, drag operations, and secure fields are not
exposed. The static AppleScript also rejects `AXSecureTextField`.

Every returned target receives a random opaque UUID backed by an in-memory
locator. All locators are invalidated as soon as one press begins, after
another inspection, on session stop, and on the kill switch. Before `AXPress`,
the adapter revalidates bundle ID, frontmost window title, element index, role,
title, enabled state, and secure subrole.

## App policy and approvals

Per-bundle policy is `ask | allow | block`; unknown apps default to `ask`.
`block` is stronger than a live request.

Applications with a `com.apple.*` bundle ID are classified as system targets.
Controls with destructive/system labels such as delete, erase, uninstall,
purchase, send, submit, shutdown, restart, logout, or localized equivalents
are classified as irreversible.

System and irreversible actions always require one-time human approval even
when the app is allowlisted. An `always-allow` response to such a prompt is
treated only as approval for the current action and does not weaken the
persisted policy.

## Audit and privacy

Telemetry and debug audit records are content-free. They may contain:

- operation class;
- success/failure;
- bundle ID;
- risk class;
- policy decision/reason;
- accessibility role;
- latency.

They must not contain screenshot bytes, window titles, control labels,
AppleScript source/output, prompts, typed text, or accessibility values.

The signed macOS build declares the Apple Events automation entitlement and
the Apple Events/Screen Capture usage descriptions required by the bounded
provider. No general shell or dynamic script entitlement is introduced.

## Out of scope

- compromise of the trusted Electron main process;
- a same-user process with independent Screen Recording/Accessibility access;
- OCR, semantic interpretation, arbitrary keyboard entry, drag-and-drop, or
  coordinate clicking;
- automation on Windows or Linux;
- bypassing macOS TCC or enterprise device-management policy;
- browser-page automation already covered by Browser/CDP.

## Verification

```bash
pnpm --filter clodex exec vitest run \
  src/shared/feature-gates.test.ts \
  src/backend/services/agent-os/desktop-capture-source.test.ts \
  src/backend/services/agent-os/desktop-automation.test.ts \
  src/backend/services/toolbox/tools/desktop-automation/index.test.ts \
  src/backend/agents/chat/chat.test.ts
pnpm --filter clodex typecheck
pnpm --filter clodex test
```

The static AppleScript sources must also compile with `/usr/bin/osacompile`
without executing or requesting permissions.
