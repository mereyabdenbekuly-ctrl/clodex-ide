# Collaborating with Clodex

Clodex welcomes focused contributions to code, tests, documentation, security
controls, packaging, integrations, and contributor experience. This guide
describes how work is scoped and how longer-term collaboration is built. For
commit and pull-request requirements, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Start with a bounded task

The best first contribution has one observable outcome and a small review
surface. Suitable examples include:

- reproducing and documenting a confirmed bug;
- adding a regression test for an existing behavior;
- correcting a focused documentation or onboarding gap;
- fixing an isolated UI, provider, packaging, or platform issue;
- improving diagnostics without changing a security boundary.

Before substantial implementation, use an issue or discussion to agree on:

- the problem and acceptance criteria;
- what is explicitly out of scope;
- affected platforms and security or privacy considerations;
- the expected tests and documentation;
- the Maintainer or Collaborator who can review the work.

Do not start with a repository-wide rewrite, new framework, broad redesign, or
large dependency migration unless a Maintainer has approved a written proposal.
Issue assignment reserves coordination, not ownership. If work becomes inactive,
the participants should check in before the task is offered to someone else.

## A practical contribution cycle

1. Comment on or open an issue. Use private vulnerability reporting for suspected
   security defects as described in [SECURITY.md](SECURITY.md).
2. Confirm the narrowest useful scope and the evidence that will show completion.
3. Open a draft pull request early when design or platform feedback would prevent
   rework.
4. Keep one concern per pull request, add DCO sign-offs, and include relevant
   tests, logs, screenshots, or reproduction steps.
5. Respond to review comments and record intentional follow-up work rather than
   silently expanding scope.
6. After merge, help verify the result and report regressions.

A successful pull request is merged, passes the required checks, preserves
security and attribution, addresses review feedback, and leaves the repository
in a maintainable state. A closed or unmerged proposal can still be valuable,
but it is not used as evidence for expanded access.

## Building a trusted working relationship

All contributors begin without elevated permissions. The normal path is
**External Contributor -> Regular Contributor -> Collaborator -> Maintainer ->
Core Maintainer**, as defined in [GOVERNANCE.md](GOVERNANCE.md).

The first two or three successful pull requests should be small enough for full
independent review. They should demonstrate reliable communication, safe handling
of feedback, and sound judgment in the relevant area. Only after that record
exists may a Maintainer nominate someone for expanded responsibility. Access is
limited to a recorded responsibility zone and is reduced when the work ends.

Role progression is optional. Valuable contributors may remain External or
Regular Contributors indefinitely. There is no contribution quota, guaranteed
review time, guaranteed merge, or entitlement to repository access.

## Community metrics and endorsements

Clodex does not buy, exchange, or reward stars, forks, watches, downloads,
reviews, testimonials, or superficial activity. Compute grants are available
only for scoped engineering, documentation, research, integration, or testing
work; they are never offered in return for engagement metrics.

Repository star and fork counts are not presented as proof of adoption or
product maturity. Public claims should rely on reproducible builds, test
evidence, attributable reports, merged contributions, and clearly disclosed
relationships. A tester or reviewer who received project resources must state
that relationship in the report.

## Reviews and decisions

Reviewers evaluate correctness, tests, maintainability, user impact, security,
privacy, compatibility, licensing, and fit with recorded project decisions.
Feedback should address the work rather than the author. Authors should disclose
generated code, copied or adapted material, relevant upstream sources, and
conflicts of interest.

For consequential changes, link the relevant decision record or create one under
the process in [GOVERNANCE.md](GOVERNANCE.md). A grant, sponsorship, friendship,
employment relationship, or prior contribution does not replace technical review.

## Compute grants

The project may provide limited API credits, hosted runners, test devices, or
other compute resources when they are necessary for an agreed Clodex task.
Availability depends on budget and provider constraints; grants may be refused,
reduced, expired, or revoked.

### Purpose and status

A compute grant is intended as restricted in-kind project support, not payment
for a pull request, reimbursement, a prize, or a purchase of services. By
itself it does not establish employment, a contractor relationship, a
partnership, agency, minimum hours, delivery obligation, or promise of future
work. Any paid work must use a separate written agreement and must not be
represented as a compute grant. Applicable law and the actual working
relationship remain controlling.

Accepting or declining a grant has no effect on review standards, role eligibility,
or community standing. Grant recipients receive no preference in issue assignment
or roadmap decisions.

### Approval and limits

Each grant must have a recorded purpose, recipient, provider or resource, allowed
use, hard spending or usage limit, and expiry date. The approving Maintainer must
not be the sole reviewer of work funded by the grant when another qualified
reviewer is available. Conflicts of interest must be disclosed.

Grant-funded changes follow the same tests, DCO, review, and merge requirements
as every other contribution. There is no pay-to-merge, credit-to-merge, sponsored
exception, or guaranteed acceptance. Unused credits do not entitle a recipient
to cash or transfer to another project.

### Credentials and acceptable use

- Every recipient receives a separate credential or account with the narrowest
  permissions, a hard limit, and an expiry. Shared keys are prohibited.
- Credentials may not be forwarded, sold, published, embedded in code or logs,
  or used by another person. Sub-grants require a new approval and credential.
- Use is limited to the recorded Clodex task. Unrelated workloads, resale,
  cryptocurrency mining, service abuse, policy evasion, credential testing, and
  attempts to exceed limits are prohibited.
- Do not submit production secrets, customer data, private repositories, or other
  sensitive data unless the grant explicitly authorizes an approved environment
  and data-handling plan.
- A suspected leak or misuse must be reported immediately. Stop using the
  credential until it is rotated or the project confirms that use may resume.
- The project may inspect provider usage metadata, stop workloads, rotate keys,
  or revoke access to control cost and investigate misuse.

When the task or grant ends, the recipient should provide any non-sensitive
reproduction information needed to maintain the contribution. The project then
revokes the credential and closes the grant record.

## Working boundaries

Collaboration is asynchronous. Do not pressure contributors through repeated
private messages, demand unpaid availability, or move decisions out of public
records for convenience. Private channels are reserved for security, conduct,
personal data, credentials, and other genuinely sensitive matters.

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in every project space. Preserve
upstream attribution and third-party notices. If scope, ownership, or authority
is unclear, pause and ask in the related issue rather than assuming permission.
