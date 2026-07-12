# Security Policy

If you believe you have found a security vulnerability, we encourage you to let us know right away.

We will investigate all legitimate reports and do our best to quickly fix the problem.

Our preference is that you make use of GitHub's private vulnerability reporting feature to disclose potential security vulnerabilities in our Open Source Software. 

To do this, please visit the security tab of the repository and click the "Report a vulnerability" button.

## Secret scanning

The repository uses Gitleaks for every pushed commit and pull request. A full
all-refs history scan also runs weekly and can be started manually.

Run the same checks locally:

```bash
pnpm security:secrets
pnpm security:secrets:history
```

The scripts download a pinned Gitleaks release when it is not installed,
verify its SHA-256 checksum, redact detected values, and write reports under
the ignored `security-reports/` directory. Never attach an unredacted secret
scan report to a public issue or pull request.
