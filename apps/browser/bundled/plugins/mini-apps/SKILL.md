---
name: mini-apps
description: Guide for building custom interactive web apps ("mini apps") displayed in browser tabs — scaffolding, iframe constraints, bidirectional messaging with the sandbox, and iteration workflows.
---

# Mini Apps

Mini apps are custom interactive web apps that render in dedicated clodex browser tabs. Useful for dashboards, visualizations, forms, interactive tools, and any UI that benefits from rich HTML/CSS/JS beyond plain text.

---

## Apps Directory (`apps/`)

The `apps/` mount is always available with full read-write permissions. Each app lives in its own subfolder with `index.html` as the required entry point. Optional sibling assets (`styles.css`, `script.js`, images, etc.) are resolved via relative references.

```
apps/{appId}/
  index.html      ← entry point (required)
  styles.css      ← optional
  script.js       ← optional
```

---

## Writing App Files

Create and edit app files (`index.html`, `styles.css`, `script.js`), then open or reload via the sandbox with `await API.openApp("appId", { title: 'Readable title' })`.

---

## Iframe Constraints

- Renders inside a dedicated browser tab with normal Clodex browser chrome.
- The app itself is sandboxed in an `app://` iframe inside a trusted `clodex://internal/preview/{appId}` shell.
- Design responsively. Always include responsive base styles and a viewport meta tag.

---

## Opening Apps (Sandbox)

Use `API.openApp(appId, opts?)` from the sandbox. The sandbox is used **only** for opening apps and communicating with them.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pluginId` | `string` | — | Opens a plugin app instead of an agent app |
| `title` | `string` | — | Human-readable tab breadcrumb label |
| `target` | `'tab'` | `'tab'` | Explicit tab target; retained for compatibility/documentation |
| `setActive` | `boolean` | `true` | Whether the preview tab should become active immediately |

- `API.openApp()` always opens an internal preview tab with a sandboxed `app://` iframe.
- Calling with the **same `appId` opens a refreshed tab** — use after editing files.

---

## Bidirectional Messaging

Apps and the sandbox communicate via `postMessage`.

**Sandbox → App:** `API.sendMessage(appId, data, opts?)` — sends a JSON-serializable message to the active app.

**App → Sandbox:** `API.onMessage(appId, callback, opts?)` — registers a listener for messages the app sends via `window.parent.postMessage(data, "*")`. Returns an unsubscribe function. Listeners persist across IIFE executions; use `globalThis` to accumulate messages.

**Inside the app (HTML/JS):**

- Receive: `window.addEventListener("message", (e) => { /* e.data */ })`
- Send: `window.parent.postMessage({ action: "clicked", id: 1 }, "*")`

## Capability Bridge

Agent-owned apps can request explicitly granted Clodex capabilities through
the versioned parent bridge. No capability is available by default. Grants are
stored by the trusted Clodex UI, are scoped to `agentId + appId`, can expire,
and can be revoked.

Supported methods:

- `getCapabilities`
- `callMcpTool` — only a specifically granted MCP tool whose effective policy
  is automatic allow, whose descriptor is read-only, and which is not
  destructive
- `askAgent` — bounded prompt and response
- `runAutomation` — launch an existing automation by ID

Minimal client:

```js
const pending = new Map();

window.addEventListener("message", (event) => {
  const message = event.data;
  if (
    message?.__clodexArtifactBridge !== 1 ||
    message.type !== "response"
  ) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) request.resolve(message.result);
  else request.reject(new Error(message.error || "Capability request failed"));
});

function callClodex(method, params = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage(
      {
        __clodexArtifactBridge: 1,
        type: "request",
        request: { id, method, params },
      },
      "*",
    );
  });
}

const capabilities = await callClodex("getCapabilities");
```

Never treat the presence of the bridge as permission. Always inspect
`getCapabilities`, handle revocation/expiry errors, and provide a
non-privileged fallback UI.

---

## Best Practices

- **Sandbox usage:** Use the sandbox only for `openApp`, `sendMessage`, and `onMessage`.
- **Responsive design:** Support both narrow and wide tab widths. Use `max-width: 100%`, `overflow-x: hidden`, `box-sizing: border-box`.
- **Viewport meta tag:** Always include `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- **File organization:** `index.html` as entry point. Split CSS and JS into separate files for maintainability.
- **Message protocol:** Define a clear `action` field to distinguish message types.
- **Cleanup listeners:** Unsubscribe from `API.onMessage` when interaction is complete.
- **Error handling:** Validate incoming messages on both sides. Gracefully handle unexpected data.

## References

For detailed examples, see:

- `references/examples.md` — Full mini app examples (minimal app, multi-file app, interactive picker with messaging)
