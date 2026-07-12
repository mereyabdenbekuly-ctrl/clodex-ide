---
name: open-code-review
description: Use Alibaba Open Code Review (`ocr`) to review git diffs, staged changes, branches, or scan a workspace, then summarize findings and optionally fix high-confidence issues.
---

# Open Code Review Plugin

Use this skill when the user asks for an AI code review, PR review, security review, bug-risk review, regression check, or asks to run `alibaba/open-code-review`.

This plugin integrates Alibaba Open Code Review through its local CLI command `ocr`. It should run inside the mounted workspace, never against unrelated directories.

## Prerequisites

First check whether the CLI exists:

```sh
ocr --version
```

If `ocr` is missing, tell the user to install Alibaba Open Code Review from `https://github.com/alibaba/open-code-review` and stop. Do not fabricate review results.

## Review Modes

Prefer the narrowest review that matches the request:

```sh
# Review current working-tree changes.
ocr review

# Review staged changes only.
ocr review --staged

# Review changes against a base branch.
ocr review --base main

# Machine-readable output for agent post-processing.
ocr review --format json --audience agent

# Broader workspace scan when the user asks for a full audit.
ocr scan --format json --audience agent
```

If the repository's default branch is not obvious, inspect git first:

```sh
git rev-parse --show-toplevel
git branch --show-current
git remote show origin
```

## Workflow

1. Confirm the workspace is a git repository.
2. Inspect the change scope with `git status --short` and, when useful, `git diff --stat`.
3. Run `ocr review --format json --audience agent` for changed files, or `ocr scan --format json --audience agent` for an explicit full audit.
4. Parse the JSON when possible. If the command only returns text, summarize the text faithfully.
5. Report findings ordered by severity, with file paths and line numbers when available.
6. If the user asks to fix findings, use normal Clodex edit tools so changes become Pending Edits for user review.

## Output Style

Lead with actionable findings. Keep summaries short.

Use this shape:

```md
Found N issue(s).

- [High] path/to/file.ts:42 — Issue title.
  Impact: ...
  Fix: ...

No high-confidence issues found.
```

When no issues are found, say that clearly and mention the reviewed scope.

## Guardrails

- Do not apply OCR suggestions blindly. Verify every proposed fix against the code.
- Do not hide uncertain findings. Mark them as "Needs verification".
- Do not show internal mount prefixes like `w48b2/`; use project-relative paths.
- Do not run full scans unless the user asks for a broad audit, because they can be slow and token-heavy.
