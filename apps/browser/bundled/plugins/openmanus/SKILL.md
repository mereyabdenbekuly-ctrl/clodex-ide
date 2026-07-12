---
name: openmanus
description: Use OpenManus as an external autonomous Python agent for long-running research, browser-style exploration, data analysis, or multi-step execution tasks from inside a mounted workspace.
---

# OpenManus Plugin

Use this skill when the user explicitly asks to run OpenManus, Manus-style automation, a long autonomous research task, or a Python/browser/data workflow that should run outside the normal Clodex agent loop.

## Prerequisites

OpenManus is not vendored into Clodex by default. Before running it, make sure one of these exists:

- `OPENMANUS_HOME` points to a local `FoundationAgents/OpenManus` checkout that contains `main.py`.
- `bundled/plugins/openmanus/main.py` exists in the installed Clodex app.

Optionally set `OPENMANUS_PYTHON` to the Python executable. If unset, Clodex uses `python3`.

## Tool

Use the `runOpenManus` tool.

Parameters:

- `prompt`: the autonomous task for OpenManus.
- `mountPrefix`: the mounted workspace prefix where the task should operate.
- `timeoutMs`: optional timeout, max 30 minutes.

## Workflow

1. Identify the current workspace mount prefix from the environment context or by listing files.
2. Call `runOpenManus` with a narrow, concrete prompt.
3. Treat its output as an external agent report.
4. If code changes are needed after OpenManus finishes, use normal Clodex edit tools (`write`/`multiEdit`) so the user gets Pending Edits.

## Guardrails

- Do not claim OpenManus changed files unless its output proves it.
- Prefer normal Clodex tools for small code edits.
- Do not run OpenManus against unrelated paths.
- Keep prompts narrow; OpenManus can run for a long time.
