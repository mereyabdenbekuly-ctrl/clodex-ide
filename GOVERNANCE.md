# Clodex Governance

This document defines how responsibility, repository access, and project
decisions are assigned in Clodex. It complements [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Bootstrap status

Clodex is currently an early-stage, solo-maintained project. This governance
file is a lightweight guardrail for growth, not a claim that a multi-person
organization already exists.

`Clodex Labs` is a project label used on some product and publication surfaces.
It is not a representation that an incorporated entity with that name currently
owns or operates the repository.

[Merey Abdenbekuly](https://github.com/mereyabdenbekuly-ctrl) is the founding
maintainer and temporarily performs the Core Maintainer responsibilities below.
Requirements for multiple independent approvals take effect when enough
eligible, non-conflicted maintainers exist. Until then, consequential decisions
should be recorded publicly and left open for reasonable review whenever there
is no security or release emergency.

The immediate goal is simple: external contributors work through forks and
pull requests, the default branch stays protected, and permissions expand only
after a demonstrated need. More formal councils, elections, and service-level
commitments are out of scope for the bootstrap phase.

The staged GitHub settings for this phase are recorded in
[`docs/maintainers/github-bootstrap.md`](docs/maintainers/github-bootstrap.md).

## Principles

- Decisions should be traceable to technical evidence and project needs.
- Access is granted for a defined responsibility, not as a reward or status.
- Every person and automation receives the least privilege needed for its work.
- Security, privacy, licensing, and upstream attribution take priority over
  delivery speed.
- Financial support, compute access, sponsorship, and personal relationships do
  not buy influence over review, merging, roles, or roadmap decisions.

## Role ladder

The project uses the following progression:

**External Contributor -> Regular Contributor -> Collaborator -> Maintainer -> Core Maintainer**

Promotion is based on demonstrated work, judgment, reliability, and conduct. It
is never automatic.

### External Contributor

Anyone participating through public issues, discussions, reviews, documentation,
or pull requests. External Contributors have no elevated repository permissions.

### Regular Contributor

An External Contributor with a consistent record of useful participation. This
recognition normally follows two or three successful, focused pull requests or
an equivalent body of review, documentation, testing, or triage work. Regular
Contributors do not receive elevated permissions by default.

### Collaborator

A trusted contributor assigned to a specific responsibility zone. A Collaborator
may receive triage access and, only when required, narrowly scoped write access.
They may reproduce issues, manage labels, review changes, and help coordinate
work in their zone. They may not bypass protected branches, grant access, manage
secrets, publish releases, or merge changes unless a separate permission is
explicitly recorded.

### Maintainer

A contributor accountable for the health of one or more responsibility zones.
Maintainers may approve and merge changes within their recorded scope, manage
the relevant backlog, and coordinate releases for that scope. They must obtain
the required cross-zone or security review when a change affects another area.
Maintainer status does not automatically include organization administration,
secret access, security-advisory access, or unrestricted release authority.

### Core Maintainer

A Maintainer entrusted with cross-project stewardship. Core Maintainers oversee
governance, access reviews, protected-branch policy, release integrity, and the
security-response process. High-impact actions should use two-person review
whenever two eligible reviewers are available. Emergency authority is limited to
reversible actions needed to protect users, credentials, or repository integrity.

## Responsibility zones

Each Collaborator or Maintainer must have a recorded scope. A scope can include:

- desktop product and user experience;
- agent execution, policy enforcement, sandboxing, and trust boundaries;
- providers, MCP, and external integrations;
- build, packaging, CI, release, and supply-chain controls;
- testing, documentation, contributor experience, and community triage;
- security response, credentials, and repository administration.

Assignments should be recorded in a public nomination or decision record, except
for details that would expose sensitive security information. A role in one zone
does not confer authority in another. Cross-zone changes require review from an
accountable person in every materially affected zone.

## Least-privilege access

- Permission expansion requires a defined task or ongoing responsibility and a
  track record of two to three successful pull requests demonstrating safe work
  in the relevant area.
- The number of pull requests is a minimum signal, not a promise of promotion.
- Protected branches, required checks, and DCO verification apply to
  maintainers as well as contributors. Independent review is required when an
  eligible, non-conflicted reviewer is available; bootstrap decisions without
  one must be documented publicly unless security requires confidentiality.
- Accounts with elevated access must use strong authentication. Shared accounts,
  shared personal access tokens, and shared provider keys are not permitted.
- Administrative, release, security, and secret access are granted separately,
  only when needed, and may be time-limited.
- Elevated permissions are reviewed at least every 90 days and promptly reduced
  when the underlying responsibility ends.

## Nomination and promotion

1. A Maintainer nominates a candidate in an issue or discussion. The nomination
   describes the proposed role, responsibility zone, evidence of prior work,
   exact permissions requested, and any known conflict of interest.
2. The candidate confirms that they accept the responsibility and will follow
   the project policies.
3. A Collaborator nomination normally requires approval from a Maintainer for
   the affected zone and a Core Maintainer. Maintainer and Core Maintainer
   nominations normally require approval from two eligible Core Maintainers.
4. During the bootstrap phase, the founding maintainer may approve a scoped
   Collaborator role after a seven-day public review. A Maintainer nomination
   should also include public endorsement from at least one Regular Contributor
   or external subject-matter expert who is not receiving the proposed access.
5. Sensitive access, including security advisories, secrets, signing, or
   organization administration, is considered separately and is not implied by
   role promotion.

Reviewers consider technical quality, response to feedback, security judgment,
follow-through, communication, and compliance with the Code of Conduct. Funding,
compute grants, and sponsorship are not promotion criteria.

## Inactivity, resignation, and removal

Contributors may step down at any time. Their prior contributions and attribution
remain intact.

After 90 days without activity in an assigned responsibility, a Core Maintainer
should check whether the role and access are still needed. After 180 days without
a response or relevant activity, elevated permissions may be removed. Planned
leave is not inactivity when it is communicated, and return from inactivity uses
a lightweight review based on the returning contributor's new scope.

Access may be suspended immediately when an account may be compromised, a secret
may be exposed, there is a credible safety risk, or serious misconduct is under
review. Suspension is protective, not a finding of fault. Permanent removal for
cause requires review by two non-conflicted Core Maintainers when available. If
that is impossible, one Core Maintainer and two non-conflicted Maintainers decide.
The affected person should receive the reason and an opportunity to respond,
unless doing so would create an immediate security or safety risk.

Code of Conduct outcomes may also limit or remove participation. All departures
must trigger prompt revocation of unneeded keys, tokens, team memberships, and
release permissions.

## Decision records

Routine decisions are made in issues and pull requests. A durable decision record
is required for changes to architecture, trust boundaries, public interfaces,
data formats, governance, licensing, new hosted dependencies, release policy, or
other choices that are costly to reverse.

A decision record may be an issue, discussion, or repository ADR. It should state:

- context and constraints;
- options considered and relevant evidence;
- security, privacy, compatibility, and operational impact;
- the decision, date, owner, and required reviewers;
- follow-up work and conditions for revisiting the decision.

Working consensus is preferred. If material disagreement remains, the options
are recorded and left open for at least five business days when practical. A
simple majority of non-conflicted Maintainers and Core Maintainers accountable
for the affected zones decides; a tie keeps the current behavior. A Core
Maintainer may take a reversible emergency action without that period, but must
record the action and rationale within 72 hours once disclosure is safe.

## Security escalation

Suspected vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public
issue. If sensitive information appears publicly, stop discussion, preserve the
minimum evidence needed, and move the report to a private channel.

Security-response access is a separate least-privilege assignment. The response
lead may temporarily restrict access, revoke credentials, pause a release, or
disable an affected integration. Information is shared only with people needed
to investigate, remediate, communicate, or meet legal obligations. After the
risk is contained, the project records a non-sensitive summary, corrective
actions, and any governance changes that are safe to publish.

## Conflicts of interest

Anyone participating in a decision must disclose relevant employment, funding,
vendor, family, or personal interests and recuse when impartiality could
reasonably be questioned. An uninvolved Maintainer records the outcome. No
maintainer may approve their own role expansion, grant request, exception, or
appeal.
