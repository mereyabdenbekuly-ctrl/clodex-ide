# Protected preview acceptance and canary

Release chain:

1. `v1.16.0-preview.2` — signed/notarized protected-draft rollback baseline;
2. `v1.16.0-preview.3` — exactly-five controlled canary using accepted
   preview.2 as its rollback baseline;
3. `clodex@1.16.0` — newly built stable artifacts after accepted preview.3.

Both previews remain draft GitHub Releases behind the protected `Release`
environment. Public preview download links are forbidden. Public website download surfaces remain disabled until an eligible stable release exists.
Historical preview.1 is not trusted and the product or website must not link
to preview.1, its static DMG alias, or its GitHub Release assets.

## Trust model

Committed JSON by itself is never release evidence. Two protected workflows
form the evidence chain:

- `release-publication-attestation.yml` queries the live release by database
  ID, validates the exact remote tag and every asset ID/name/size/API
  digest/downloaded SHA-256, validates the committed release-plan hash, and
  attests the exact aggregate publication report bytes.
- `release-acceptance-evidence.yml` verifies that publication attestation using
  the canonical repository, `refs/heads/main`, exact source digest, exact signer
  digest, and `--deny-self-hosted-runners`. Its unprivileged collection job runs
  real source/product checks without OIDC or attestation-write permissions. A
  separate minimal protected job downloads only the exact artifact ID, verifies
  the subject SHA-256 and terminal schema, and attests those bytes without
  checking out or executing release source.

Preview.3 promotion re-runs both preview.2 attestation checks and live release
validation. The stable verifier contains recursive preview.3 → preview.2
validation, but deliberately stops at the `NOT_READY` canary-observation gate
before it can authorize stable. Deleted, empty, substituted, or additional
assets fail closed.

## Publication report

The release workflow builds all four supported targets and emits one
`clodex-release-publication.json` asset. It binds:

- canonical repository, source commit, tag, version, and channel;
- committed release-plan path and SHA-256;
- workflow run ID, run attempt, workflow commit, and `refs/heads/main`;
- all four validation manifests and their check/signing/trust receipt hashes;
- every published asset name, positive byte size, SHA-256, and build identity;
- packaged smoke, clean-profile launch, bundled icon, Developer ID,
  notarization/Gatekeeper, and Windows Authenticode results.

The report is not trusted until the protected publication workflow verifies the
live draft and creates GitHub build-provenance attestation for those exact
bytes.

## Protected acceptance dispatch

Run `Trusted Release Acceptance Evidence` from canonical `main` only. The
protected environment must approve the job. Inputs are deliberately bounded:

- positive draft GitHub Release database ID;
- exact committed manifest path;
- JSON object containing exactly the seven documented manual check IDs, each
  set to `true`;
- confirmation `ATTEST_ACCEPTANCE`.

The workflow installs the exact released workspace, builds package
prerequisites, installs Playwright Chromium, and runs the real Quick Task,
task, browser, MCP, Guardian/egress, and session-recovery source checks. Artifact
and distribution-trust checks come only from the attested aggregate publication
report; the collector cannot synthesize them as passing.

The older `check-preview-acceptance.ts` command is diagnostic only. Its local
output is not trusted promotion evidence and must not be committed as if it
were attested.

## Preview.2 rollback baseline

Preview.2 may produce only `ready-as-rollback-baseline` evidence:

- canary timestamps and installation observations are `null`;
- no rollback target tag is claimed;
- every automated and protected manual check passes;
- the draft release and its asset set remain unchanged.

Download the attested workflow artifact, verify it with `gh attestation
verify`, and only then commit the exact bytes as
`.release-evidence/v1.16.0-preview.2.json`. Preview.3 validation requires the
attestation again and requires `refs/tags/v1.16.0-preview.2^{commit}` to resolve
to the accepted source.

## Preview.3 canary — NOT_READY

Preview.3 may be created only after the complete preview.2 chain passes. Its
controlled distribution is intended for exactly five installations, but the
repository does not yet have a trusted distribution/telemetry observation
source. Therefore the protected collector deliberately rejects every
preview.3 attempt with `stable promotion is NOT_READY`.

Manual or workflow-dispatch JSON cannot become canary evidence. Before the
preview.2 release starts, a separate observation producer must be implemented
and independently reviewed. Its signed, manifest-bound receipt must identify
the canonical repository, preview source/manifest/tag, distribution system,
telemetry source, observation artifact digest, signer workflow and signer
commit. Acceptance must verify that attestation independently before it may
evaluate:

- `startedAt` not earlier than the live release `created_at`;
- non-null `endedAt`, not in the future;
- authenticated `distributionClosedAt` at or after `endedAt`;
- at least 24 hours between start and end;
- at least ten launches, five authentication attempts, five guarded egress
  prompts, and five recovery attempts;
- zero authentication failures, crashes, crash loops, launch/recovery
  failures, unexpected egress allows, missing prompts, data-loss incidents,
  Guardian bypasses, and signature/trust failures.

The first authentication failure is an immediate stop condition. A sixth
installation is also a stop condition. An operator assertion, open window, or
incomplete receipt can never produce `ready-for-stable`.

Do not create or commit `.release-evidence/v1.16.0-preview.3.json` until that
trusted observation path exists and the fail-closed blocker is intentionally
replaced under independent review.

## Stable gate

`.release-notes/clodex-stable.json` intentionally does not exist before real,
fresh, attested preview.3 evidence. Stable promotion is additionally hard
blocked while trusted canary observation status is `NOT_READY`. Auto Release
requires the explicit
`RELEASE_STABLE` confirmation and protected `Release` approval. It then
live-revalidates preview.3 and preview.2, requires exact remote tags, and builds
new stable artifacts; preview files are never renamed or promoted in place.

Any product-code change after an accepted preview source invalidates the chain
and restarts signing, acceptance, and canary from a new baseline.
