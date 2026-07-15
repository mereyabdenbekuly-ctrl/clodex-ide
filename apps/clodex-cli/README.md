# clodex-cli (MVP)

Minimal local CLI for running `@clodex/agent-core` in a headless setup.
It mounts a workspace, sends one prompt to a chat agent, and prints the final
assistant text.

## Usage

```bash
ANTHROPIC_API_KEY=... pnpm -F @clodex/clodex-cli start -- --cwd /tmp/foo "Create hello.txt with hi"
```

### Options

- `--cwd <path>`: workspace path to mount (default: current working directory)
- `--model <modelId>`: model id override
- positional prompt: required prompt text
- `--`: end option parsing when the prompt itself starts with `-`

### Environment

- `ANTHROPIC_API_KEY` (required)
- `CLODEX_CLI_MODEL` (optional default model; defaults to `claude-sonnet-4.6`)

## Notes

- Uses temp, session-scoped host paths under `os.tmpdir()/clodex-cli/<sessionId>/`.
- Rejects missing option values and unknown options before constructing the
  model provider or agent runtime.
- Rejects unsafe agent and attachment path segments before resolving those host
  paths.
- Sets tool approval mode to `alwaysAllow` for local smoke-test ergonomics.
- Uses universal file tools from `createUniversalToolbox`.
