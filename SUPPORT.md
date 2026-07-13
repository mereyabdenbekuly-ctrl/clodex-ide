# Clodex Support

Choose the narrowest public channel that matches your request. Structured reports are easier to reproduce, route, and resolve than blank issues, so blank issues are disabled.

## Public support channels

| Request | Where to post |
| --- | --- |
| Installation, update, launch, dependency, or first-time setup failure | [Installation problem](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=1.installation_problem.yml) |
| Model provider, endpoint, authentication, relay, routing, or provider-response problem | [Provider problem](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=2.provider_problem.yml) |
| A repeatable product or code defect with exact reproduction steps | [Reproducible bug](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=3.reproducible_bug.yml) |
| A bounded, actionable product or engineering proposal | [Feature request](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=4.feature_request.yml) |
| Missing, incorrect, outdated, or unclear documentation | [Documentation](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=5.documentation.yml) |
| A public question about security design, hardening, trust boundaries, or safe configuration that is **not a vulnerability** | [Security question](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=6.security_question.yml) |
| Results from a preview build, release candidate, test plan, or exploratory testing session | [Tester report](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/issues/new?template=7.tester_report.yml) |
| General usage questions, setup advice, early ideas, design discussion, or requests that are not yet actionable | [GitHub Discussions](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/discussions) |

Search existing issues and discussions before posting. Use one issue for one actionable problem. If testing uncovers a separate reproducible defect, open a bug report and link it from the tester report.

## What to include

For technical reports, include as much of the following as applies:

- the exact Clodex version, build, artifact, or commit;
- operating system, architecture, runtime versions, and installation method;
- the affected application, package, provider, model, endpoint type, or execution mode;
- minimal, numbered reproduction steps;
- expected and actual behavior;
- exact commands and redacted errors or logs;
- screenshots, recordings, traces, or other user evidence;
- the last known working version when reporting a regression.

Do not publish API keys, access tokens, cookies, authorization headers, private keys, private repository content, customer data, personal data, credential-bearing URLs, or unredacted secret-scanning output. Replace sensitive values with clear placeholders and verify attachments before submitting.

## Security vulnerabilities and confidential reports

Do **not** use Issues, Discussions, pull requests, or the public security-question form for a suspected vulnerability, exploitable weakness, security bypass, leaked secret, or report that should remain confidential.

Read [SECURITY.md](SECURITY.md), then use [GitHub private vulnerability reporting](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/security/advisories/new). Include only the information necessary to reproduce and assess the issue, and rotate or revoke any credential that may already be exposed.

## Feature and design discussions

Use GitHub Discussions when a request is still exploratory, has unclear scope, or needs community design input. Open a feature issue once the user problem, intended outcome, scope boundaries, and main risks are concrete enough to act on.

## Contributing a fix

If you want to contribute a fix or improvement, first open or reference the appropriate issue for substantial changes. Follow [CONTRIBUTING.md](CONTRIBUTING.md), open a Draft pull request early for alignment, keep the change within the agreed scope, and sign off every commit as required by the [DCO](DCO).
