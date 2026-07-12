# Operations and troubleshooting

## 1. Missing package subpath

Symptoms:

- TypeScript resolves a package import;
- Vite or Node reports `ERR_MODULE_NOT_FOUND`;
- a declaration file exists but the JavaScript output does not.

Recovery:

```bash
pnpm -F @clodex/agent-runtime-node build
pnpm build:packages
```

Then rerun the Browser build sequentially. Do not build the same package
concurrently from multiple tasks.

## 2. Electron is not installed correctly

This commonly occurs after `pnpm install --ignore-scripts`.

Recovery:

- run the normal install/postinstall for the clean worktree;
- verify the Electron binary exists;
- rerun Browser tests without changing source.

Treat this as an environment failure only when test assertions never started.

## 3. Packaging rejects Node

Use the pinned packaging runtime:

```bash
node --version
# expected for deterministic packaging: v22.23.1
```

The packaging guard intentionally rejects unsupported runtime/ABI combinations.

## 4. Packaging reports an active development process

The deterministic guard prevents dev and release packaging from sharing output
directories.

Stop the dev Electron/Vite process, verify no Forge or package process remains,
then rerun packaging.

## 5. Protected data cannot be read

Check:

- the application profile and product identity;
- OS keychain access;
- protected-file service initialization;
- whether the file is encrypted but the current host lacks the correct
  capability;
- whether an unexpected plaintext file exists in a protected location.

Do not convert or overwrite protected files manually.

## 6. Agent Host or MCP Host restarts

Inspect:

- supervisor lifecycle logs;
- restart budget;
- ready timeout;
- pending request count;
- circuit-breaker state;
- bundled host entry points in ASAR.

In-flight side effects are rejected rather than replayed.

## 7. Network requests are blocked

Check the Egress Control Gateway:

- feature gates;
- proxy runtime status;
- destination grant;
- protocol, hostname, and port;
- DNS/private-network decision;
- audit reason code.

Do not add broad private-network bypasses. Add an exact temporary destination
grant.

## 8. SSH runner failure

Verify:

- saved connection and authentication;
- source revision;
- workspace materialization hash;
- remote dependency profile;
- command class;
- lease and receipt identity;
- artifact cleanup.

Runner promotion requires physical evidence, not only unit tests.

## 9. Docker runner failure

Verify:

- Docker daemon availability;
- digest-pinned image;
- architecture;
- resource policy;
- network-disabled expectations;
- snapshot archive size and hash;
- collector and receipt keys.

## 10. Readiness gate fails

Normal gate failures usually indicate:

- incomplete implementation contract;
- malformed evidence;
- unsafe default-on feature;
- dirty source when `--require-clean` is used.

Strict gate failures can be expected when real promotion evidence is absent.
Read the per-epic blocker IDs instead of bypassing the gate.

## 11. Secret scanner blocks a push

- Do not bypass push protection.
- Determine whether the finding is a real credential or an unsafe fixture.
- Rotate real credentials.
- Replace fixtures with non-secret structured test data.
- If the secret exists in reachable history, decide whether history rewriting
  is required before publishing the repository.

## 12. Safe diagnostic collection

Collect:

- commit and tree identity;
- command exit code;
- bounded test counts;
- process lifecycle status;
- sanitized error category;
- artifact checksums.

Do not collect:

- environment values;
- credentials;
- prompts;
- source contents unrelated to the fault;
- raw user data.
