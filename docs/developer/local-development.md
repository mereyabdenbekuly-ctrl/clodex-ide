# Local development

## 1. Prerequisites

Required:

- Git;
- Node.js 22;
- pnpm 10.30.3;
- platform build tools required by Electron and native Node modules.

Deterministic release packaging is pinned to Node.js `22.23.1`. Other Node 22
versions may work for ordinary development, but packaging guards can reject
them.

Recommended platform tools:

### macOS

- Xcode Command Line Tools;
- a configured login Keychain for protected local data;
- Apple signing credentials only when producing an official release.

### Windows

- Visual Studio Build Tools;
- PowerShell;
- Windows SDK when building installers or native modules.

### Linux

- standard C/C++ toolchain;
- Electron runtime libraries;
- a working display server or virtual display for UI tests.

## 2. Installation

```bash
pnpm install --frozen-lockfile
```

For an offline validation worktree:

```bash
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm -F @clodex/agent-runtime-node build
pnpm build:packages
```

After `--ignore-scripts`, Electron or native dependencies may require their
normal postinstall step before running the full Browser suite.

## 3. Environment configuration

Copy the template:

```bash
cp .env.example .env.dev
```

Use only the variables required by the feature under development.

### Product endpoints

- `CLODEX_ORIGIN`;
- `CLODEX_LOGIN_URL`;
- `CLODEX_API_URL`;
- `CLODEX_LLM_RELAY_URL`;
- `CLODEX_CONSOLE_URL`;
- `CLODEX_AUTH_CALLBACK_SCHEME`.

### Development controls

- `CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME`;
- `CLODEX_CLOUD_TASKS_KILL_SWITCH`;
- `CLODEX_BROWSER_EGRESS_ALLOWED_HOSTS`;
- `CLODEX_DOCKER_RUNNER_IMAGE`.

### Release-only variables

- Apple signing and notarization variables;
- Windows signing variables;
- promotion signing keys;
- update-server authority.

Never place release private keys in a repository file. Use protected CI secrets
or a local temporary file with owner-only permissions and delete it after use.

## 4. Build order

The Browser application imports generated package outputs. Build the package
layer before standalone Browser TypeScript or packaging:

```bash
pnpm -F @clodex/agent-runtime-node build
pnpm build:packages
pnpm --dir apps/browser typecheck
```

Avoid concurrent nested builds of the same package. They can temporarily remove
or replace generated subpath output while another process is bundling it.

## 5. Starting the application

Fast development start:

```bash
pnpm --dir apps/browser start:fast
```

Start with a parallel typecheck:

```bash
pnpm --dir apps/browser start
```

Run the entire workspace in watch mode:

```bash
pnpm dev
```

Run Storybook:

```bash
pnpm --dir apps/browser storybook
```

## 6. Common development commands

```bash
# Formatting and static checks
pnpm check
pnpm check:fix

# All workspace TypeScript projects
pnpm typecheck

# All workspace tests
pnpm test

# Browser only
pnpm --dir apps/browser typecheck
pnpm --dir apps/browser test

# Core packages
pnpm -F @clodex/agent-core test
pnpm -F @clodex/agent-shell test
pnpm -F @clodex/mcp-runtime test

# Visual regression
pnpm --dir apps/browser visual:build
pnpm --dir apps/browser visual:test
```

## 7. Working-tree rules

- Develop one coherent capability per branch or worktree.
- Never use `git clean` or a broad reset in a shared working directory.
- Do not stage files belonging to another task.
- Validate exact manifests before committing a selective integration.
- Keep test output, package artifacts, local profiles, and keys outside Git.
- Use a clean worktree for release claims and deterministic packaging.

## 8. Adding a feature

1. Define shared schemas and feature gates.
2. Implement backend ownership and validation.
3. Expose typed Karton procedures/state if UI access is required.
4. Add UI with loading, empty, error, and disabled states.
5. Add content-free audit or telemetry.
6. Add focused tests and typechecks.
7. Add a promotion contract if the feature can affect production side effects.
8. Update this handbook and the appropriate specialized document.
