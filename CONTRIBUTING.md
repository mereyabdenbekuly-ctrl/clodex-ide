# Contributing to Clodex

Thank you for helping improve Clodex. Contributions to code, documentation,
tests, security controls, provider integrations, and developer experience are
welcome.

## Before opening a pull request

1. Open or reference an issue for substantial changes.
2. Keep the pull request focused on one concern.
3. Add or update tests for behavioral changes.
4. Run the relevant formatting, typecheck, and test commands.
5. Ensure every commit includes a DCO sign-off.

Do not include API keys, access tokens, private keys, customer data, production
URLs containing credentials, or other secrets in issues, commits, fixtures, or
logs.

## Developer Certificate of Origin (DCO)

Clodex uses the [Developer Certificate of Origin 1.1](DCO). By contributing,
you certify that you have the right to submit the contribution under the
project's open-source license.

Every commit must include a `Signed-off-by` trailer matching the commit author:

```text
Signed-off-by: Jane Developer <jane@example.com>
```

Git can add the trailer automatically with `-s` or `--signoff`:

```bash
git commit -s -m "feat: add local Ollama provider"
```

The sign-off is a DCO certification. It is separate from cryptographically
signing a commit with GPG or SSH.

If a commit is missing the trailer, amend it before pushing:

```bash
git commit --amend --no-edit -s
```

For multiple local commits, use an interactive rebase and amend each commit:

```bash
git rebase -i origin/main
git commit --amend --no-edit -s
git rebase --continue
```

Pull requests with unsigned commits will not be merged. Maintainers should
enable the DCO GitHub App and make its status check required on protected
branches.

## Development setup

```bash
pnpm install
pnpm --filter clodex typecheck
```

Use the narrowest relevant test command while developing. Before requesting
review, run the repository checks affected by your change.

Generated bundles and vendored assets should be updated through their source
scripts rather than edited manually.

## Pull request expectations

- Explain the problem and the chosen solution.
- Identify security, privacy, migration, and compatibility impact.
- Include screenshots for visible UI changes.
- Document new environment variables and external network dependencies.
- Preserve upstream attribution and third-party license notices.
- Avoid unrelated formatting or refactoring.

## Reporting security vulnerabilities

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.

## Community

Use GitHub Issues for actionable bugs and feature proposals. Use GitHub
Discussions for design questions and broader community conversations.
