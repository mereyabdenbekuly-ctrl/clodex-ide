# CLODEx Community Free Product Contract

**Status:** current public Technical Preview contract for Community builds
produced after the enforced Free/managed boundary landed on canonical `main`.

This contract is not retroactive. **Community Observed 8 predates the enforced
boundary and has not been verified against this contract.** It remains a legacy
tester artifact.

## Current verified artifact

**Community Observed 13** (`1.16.0-communityobserved13`) is the current Free
Technical Preview verified against the packaging boundary defined below. It was
built from exact canonical source
[`eb1ea435c8c11ecb9c57c9a61d3e08ec56d9a1fc`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/commit/eb1ea435c8c11ecb9c57c9a61d3e08ec56d9a1fc)
by [Actions run `29813149668`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/runs/29813149668)
and published as
[`v1.16.0-communityobserved13`](https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved13).

The release's Free/managed checks and packaged-byte audit passed. Its
`SHA256SUMS.txt` covers five unchanged installers and the evidence archive; the
evidence contains validation manifests, SBOMs, warnings, internal checksums,
and the root byte-audit report. This verifies the documented packaging
boundary, not complete hardening, absence of vulnerabilities, end-to-end
acceptance of every source-tree feature, or stable-release readiness.

The packages remain unsigned/ad-hoc and non-notarized: macOS is ad-hoc signed
without a trusted Developer ID or notarization, Windows is not
Authenticode-signed, and Linux packages have no CLODEx vendor signature.

CLODEx Community is the free, local-first desktop IDE distributed from this
repository. Its value does not depend on a hosted control plane, and local
security must not be weakened to create a paid tier.

## Commercial product invariant

Any capability that can operate entirely in the public desktop client and is
merged into the public AGPL `main` branch is treated as Community-available at
source level. Distribution identity, signing, packaging omissions, local
license keys, renderer checks, obfuscation, or client-side feature flags are
not accepted as a durable paid boundary because the public client can be built
and modified independently.

CLODEx may charge for official distribution, support, hosted access, managed
operations, enterprise administration, integrations, compliance, and service
levels. Access to those separately operated services must be authorized,
metered, and billed by the service. The public IDE may present reviewed
entitlement UX and fail-closed connectors, but it must not make the
value-bearing entitlement decision or contain a client-side bypass that grants
managed access.

If a proposed capability must remain commercially exclusive but can function
fully offline or entirely inside the public client, it requires a new explicit
product-boundary and licensing decision before implementation. It must not be
quietly added as a disabled "premium" feature in the Community source tree.

## Included in the Free build

- persistent local tasks and recovery after an application restart;
- local workspaces, file editing, pending changes, diffs, Git and worktrees;
- local terminal and browser tools subject to the IDE's approval and security
  controls;
- bring-your-own model providers, OpenAI-compatible endpoints and local Ollama;
- user-configured MCP connections over the supported local and remote
  transports;
- optional CLODEx account sign-in and the public model-relay connector where
  that separately operated service is available;
- the Community build's documented language and privacy choices.

Availability in source code does not by itself mean that an experimental
feature has passed release acceptance. The release notes for a specific build
remain the source of truth for its verified feature set.

## Free-eligible Preview surfaces

User-controlled SSH runners and remote workspaces are eligible to ship in a
Community build without becoming a managed-service entitlement. They are
Preview surfaces, not part of the baseline Free availability promise.

The release notes for each artifact determine whether those surfaces are
present and accepted for testing in that build. Remote execution or continuity
that depends on CLODEx-operated hosted infrastructure remains outside the Free
build regardless of similarly named client-side or experimental source code.

## Not granted by the Free build

Installing a Community artifact does **not** bundle a configured or operational
CLODEx-managed service, activate one, or grant access to managed cloud
execution, hosted session sharing, hosted organization operations, centrally
operated administration, or other managed services. Account sign-in is not a
managed-service entitlement.

Public client contracts and local/reference components may remain in the open
source tree, but the operational managed implementation, service
configuration, authorization and data plane are separate from the Community
license and artifact. No pricing, service level or commercial entitlement is
defined by this document.

## Enforced release boundary

For `community-unsigned` and `community-observed` artifacts:

1. managed-service connectors are disabled by distribution policy;
2. cloud execution is kill-switched and remains fail-closed even if a saved
   feature preference asks for it;
3. hosted MCP, cloud-task and session-sharing endpoints are not embedded;
4. ambient service endpoint or credential overrides are discarded;
5. the account and model-relay integrations use reviewed public endpoints;
6. local operation and local security controls remain available without any
   managed service.

CI checks this boundary before Community packaging. A change that adds a
managed endpoint or enables a managed connector in a Community artifact must
be treated as a product-boundary change and reviewed explicitly.

Trusted signing and the `official` distribution identity do not imply a
managed-service entitlement. Official builds keep managed connectors disabled
unless a separate, explicit build-time opt-in is supplied outside the Free
release workflows.

## License and support

The repository license governs the Community software. Network services have
their own availability and terms. Community builds are Technical Preview
artifacts unless a release explicitly states otherwise; see the repository's
release notes and support policy for current limitations.
