# Security Policy

Clodex is currently an early Technical Preview. Security reports are welcome,
but the project does not yet promise production support or a formal response
SLA.

## Report a vulnerability privately

Do **not** open a public issue, discussion, or pull request for a suspected
vulnerability, exploitable policy bypass, leaked credential, or other report
that should remain confidential.

Use [GitHub private vulnerability reporting](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/security/advisories/new):

1. open the repository **Security** tab;
2. select **Report a vulnerability**; and
3. include the minimum information needed to reproduce and assess the issue.

If GitHub private reporting is temporarily unavailable, do not publish the
details. Email **support@clodex.xyz** with the subject `[SECURITY CHANNEL]` and
ask for a secure reporting channel. Do not place exploit details, credentials,
or private data in the initial email.

Public questions about documented trust boundaries or hardening that do not
reveal a suspected vulnerability may use the repository's **Security question**
issue form.

## What to include

When possible, provide:

- the affected release, build, or commit;
- the affected component and deployment mode;
- prerequisites and minimal reproduction steps;
- expected and observed security behavior;
- impact and the data or authority at risk;
- a suggested mitigation, if known; and
- whether any credential or private data may already be exposed.

Remove unrelated secrets and personal data. If a credential may be compromised,
rotate or revoke it immediately rather than waiting for project confirmation.

## Response process

The maintainer will make a best-effort acknowledgement, reproduce the report,
assess severity, prepare a fix, and coordinate disclosure. Complex reports may
take longer while the project is solo-maintained. Please allow a reasonable
private remediation period before public disclosure.

The project does not currently operate a guaranteed bug-bounty program. A
compute grant or other contributor support is not automatically owed for a
security report and never affects severity or disclosure decisions.

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
