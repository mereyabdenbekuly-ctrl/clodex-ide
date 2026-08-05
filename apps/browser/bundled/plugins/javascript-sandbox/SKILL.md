---
name: javascript-sandbox
description: Best practices for using the clodex built-in JavaScript sandbox for browser debugging, fetched-data processing, attachments, and mini-app orchestration within its bundled capability boundary.
---

# JavaScript Sandbox

The sandbox is an isolated, **persistent** Node.js VM context. Data and functions stored on `globalThis` survive across calls and messages. Scripts run inside an async IIFE. The sandbox offers a standard clodex runtime API through the global object `API`.

---

## Timeouts

- **Inactivity timeout:** 45 seconds. Each call to `API.output()` or `API.createAttachment()` resets the timer.
- **Hard cap:** 3 minutes wall-clock (non-resettable).
- **NEVER** use `await Promise.resolve()` or unbounded `while(true)` loops — these permanently block the sandbox worker.
- In loops, yield with `await new Promise(r => setTimeout(r, 0))` every ~1000 sync iterations.
- Always use bounded loops. Return partial results if hitting the limit.
- For long-running tasks, call `API.output()` periodically as a heartbeat. Split work across multiple invocations if needed.

---

## Creating Outputs

Use `API.output(data: any): void` to generate outputs. Can be called multiple times; outputs are concatenated. **NEVER** use `console.log()` or other console methods.

---

## Creating Attachments

Use `API.createAttachment(originalFileName: string, data: Buffer | string): Promise<string>`.

- `originalFileName`: user-visible name with extension (e.g. `screenshot.png`)
- `data`: binary content or base64-encoded string
- Returns the obfuscated file name in `att/` — **always** use this returned name when referencing the attachment afterwards.

---

## Chrome DevTools Protocol (CDP)

Send commands via `API.sendCDP(tabId, method, params?): Promise<any>`. Listen to events via `API.onCDPEvent(tabId, event, callback): void` (listeners persist across IIFEs; use `globalThis` to accumulate).

- **Pre-enabled** (do NOT call `.enable`): `DOM`, `CSS`, `Page`, `Runtime`, `Log`, `Console`
- **No enable method** (use directly): `Input`, `Emulation`, `IO`, `Target`, `Browser`, `SystemInfo`, `Schema`
- **All others** (e.g. `Network`, `Overlay`, `Debugger`, `Fetch`): call `<Domain>.enable` first.

---

## Files and Existing Attachments

Host filesystem access is intentionally disabled. `fs`, `fsPromises`, and `require('fs')` are unavailable inside the sandbox.

- Use native Clodex tools (`read`, `write`, `multiEdit`, `ls`, `glob`, `grepSearch`, `copy`, `delete`) for workspace files.
- Use the native `read` tool to load an existing attachment, image, or PDF into model context. Do not try to decode host files in the sandbox.
- `API.createAttachment()` creates a new output attachment from data already produced by the script. It does not read host files or existing attachments.

---

## Credentials

Use `API.getCredential(typeId): Promise<string>` to retrieve stored credentials. Secret fields contain opaque placeholders auto-substituted in outgoing `fetch` calls. Plain fields contain real values.

---

## Mini Apps

Mini apps are interactive web UIs rendered in dedicated browser tabs. Use `API.openApp(appId, opts?)` to open one. See the **mini-apps** skill for full details on building, messaging, and best practices.

---

## Available Runtime

**Global APIs:** `Promise`, `Map`, `Set`, `Array`, `Object`, `JSON`, `Math`, `RegExp`, `Date`, `Error`, typed arrays, `setTimeout`, `setInterval`, `setImmediate`, `fetch`, `Headers`, `Request`, `Response`, `AbortController`, `URL`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `Buffer`, `Blob`, `FormData`, `structuredClone`, `queueMicrotask`, `crypto.randomUUID()`, `process` (shim: `env.NODE_ENV`, `nextTick`). **NO DOM or Navigator APIs** — use CDP for tab interaction.

**Node.js built-ins** (via `require()`): `buffer`, `crypto`, `events`, `path`, `querystring`, `stream`, `string_decoder`, `url`, `util`, `zlib`, `assert`. Blocked: `net`, `http`, `https`, `child_process`, `worker_threads`, `vm`.

**Remote module imports are disabled.** Neither `await import()` nor `importModule()` may load fetched JavaScript. External npm/CDN packages are unavailable. Do not retry remote imports or evaluate JavaScript returned by `fetch()`. Use the allowed built-ins above, pure JavaScript, or a native Clodex tool. `fetch()` is for data only.

---

## Important Rules

- Do not load or evaluate remote JavaScript.
- Use `API.output()` instead of console logging.
- Use `fetch` for all network requests.
- Implement error handling with fallbacks and sensible retries.
- Split multi-step scripts into separate invocations.
- After writing or updating mini app files, use `API.openApp` to reload the app and `API.sendMessage` / `API.onMessage` for messaging.

## References

For detailed usage examples, see:
- `references/examples.md` — Common sandbox patterns (CDP, attachments, fetched-data processing, and long-running tasks)
