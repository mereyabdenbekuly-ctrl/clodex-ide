## Persistent JavaScript Sandbox (`executeSandboxJs`)

Isolated Node.js VM running in a **separate worker process** — not inside any browser tab. No direct Web APIs (`document`, `window` unavailable). Browser interaction requires CDP (`API.sendCDP`). Data and functions stored on `globalThis` persist across calls and messages. Scripts run inside an async IIFE.

- **Use for:** browser/CDP tasks, processing fetched data, mini-app orchestration, and complex async workflows that fit the bundled runtime.
- **Do NOT use for:** reading, writing, searching, or modifying files; inspecting existing attachments; or loading external JavaScript packages. Use native tools (`read`, `write`, `multiEdit`, `ls`, `glob`, `grepSearch`, `copy`, `delete`) for files and attachments.

### Output

The sandbox has exactly **two output channels** — everything else (including `console.log`) is invisible:

1. **`API.output(data)`** — text/JSON streamed to the chat in real time. Can be called multiple times; outputs appear in order. The script's **`return` value** is appended as the final output.
2. **`API.createAttachment(fileName, data)`** — binary/multimodal output. Saved files are **automatically injected as visual content** (images, PDFs, etc.) the agent can see on the next step. Use for screenshots, generated images, or any file the agent needs to inspect visually.

**`console.log()` and all other console methods are silently lost.** Output goes to an internal worker process stdout that is invisible to both user and agent. Never use console methods for output. After sandbox execution, do **NOT** read console logs from browser tabs — the sandbox does not execute in any tab.

### Core API

| Method | Purpose |
|--------|---------|
| `API.output(data: any): void` | Emit visible output (also resets inactivity timer) |
| `API.sendCDP(tabId, method, params?): Promise<any>` | Send CDP command to a browser tab |
| `API.createAttachment(fileName, data): Promise<string>` | Save file to `att/`, returns obfuscated name |
| `API.openApp(appId, opts?): Promise<{ tabId?: string }>` | Open mini-app in a browser tab |
| `API.getCredential(typeId): Promise<Record<string, string> \| null>` | Retrieve stored credential |
| `API.onCDPEvent(tabId, event, callback): () => void` | Subscribe to CDP events (persistent across calls) |

### Timeouts

- **Inactivity:** 45 seconds. Each `API.output()` or `API.createAttachment()` call resets the timer.
- **Hard cap:** 3 minutes wall-clock (non-resettable). Split work across multiple invocations if needed.
- For long-running tasks, call `API.output()` periodically as a heartbeat.

### Pitfalls

- Unbounded `while(true)` / `await Promise.resolve()` — blocks the worker permanently. Always use bounded loops; yield with `await new Promise(r => setTimeout(r, 0))` every ~1000 sync iterations.
- **Remote module imports are disabled.** Neither `await import()` nor `importModule()` can load fetched JavaScript. Do not retry them, fetch JavaScript and evaluate it, or use CDN/npm package URLs. Use the allowed bundled Node.js built-ins or native Clodex tools instead. `fetch()` is for data only.

### Files and attachments

- **Host filesystem access is disabled in the sandbox.** `fs`, `fsPromises`, and `require('fs')` are unavailable.
- Use native file tools for workspace files and existing attachments. In particular, use `read` to load an existing image or PDF into model context instead of trying to decode it in the sandbox.
- `API.createAttachment()` creates new sandbox output for the next model step; it does not grant read access to host files or existing attachments.

### Examples

```js
// Multi-step output
API.output("Fetching data...");
const resp = await fetch("https://api.example.com/data");
const data = await resp.json();
API.output(`Got ${data.items.length} items`);
return data;
```

```js
// Screenshot
const { data } = await API.sendCDP(tabId, "Page.captureScreenshot", { format: "png" });
const fileName = await API.createAttachment("screenshot.png", Buffer.from(data, "base64"));
return `Saved as ${fileName}`;
```

**Read the `javascript-sandbox` plugin** for CDP domain rules, credential details, runtime/module lists, and advanced patterns.
