# GitHub repository bootstrap

This page records the minimum GitHub settings for the early, solo-maintained
Clodex project. It is intentionally staged: the repository should be safe for
external pull requests without pretending that multiple independent maintainers
already exist.

## Enabled on July 13, 2026

The public repository has:

- Issues and Discussions enabled;
- GitHub private vulnerability reporting enabled;
- dependency vulnerability alerts and automated security fixes enabled;
- GitHub secret scanning and push protection enabled in addition to Gitleaks;
- Squash merge as the only enabled pull-request merge method;
- automatic deletion of merged head branches;
- contributor branch update support; and
- DCO sign-off required for commits created in the GitHub web interface.

Repository files define structured issue forms, a pull-request template,
`CODEOWNERS`, a DCO workflow, and full CI for every pull request.

## Bootstrap protection for `main`

Apply this protection only after the governance and workflow files containing
the `DCO` and `Full CI (PR)` checks have reached `main`:

```bash
gh api --method PUT \
  repos/mereyabdenbekuly-ctrl/clodex-ide/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Full CI (PR)", "DCO", "Provenance", "Architecture boundaries", "Changed commits"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON
```

Requiring a pull request but zero independent approvals is deliberate during
the solo-maintainer phase: the maintainer cannot approve their own pull request,
but the change still receives a public diff, required automation, and resolved
review conversations.

## After a second active maintainer joins

Update branch protection to:

- require one approval;
- require CODEOWNER review;
- require approval after the most recent push; and
- keep administrators subject to the same rules.

Security-boundary, release, credential, and irreversible migration changes
should receive two-person review whenever two qualified reviewers are
available. Access to private vulnerability reports, repository secrets,
signing, releases, and administration remains separate from the general
Maintainer role.

## Release infrastructure is a later gate

Do not treat configured workflow files as evidence that a release system is
operational. Before automated signed releases, create and protect the required
GitHub Environments, provision only the documented secrets and variables,
validate tag-to-artifact binding, and run the release acceptance plan.

The Technical Preview may continue to use explicitly labeled unsigned or ad-hoc
artifacts for testing, but their release notes must identify the exact source
commit, checksum, signature state, and limitations.
