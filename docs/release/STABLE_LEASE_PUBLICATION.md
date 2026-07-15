# Stable lease-bound GitHub Release publication

**Status:** public implementation slice present; stable publication remains
`NOT_READY` and is not wired to a dispatchable effect.

The stable browser workflow still stops after it revalidates the exact attested
draft. This slice defines the bounded publisher that may be used only after the
external lease authority, producer attestation policy, GitHub immutable-release
configuration, and workflow isolation have received independent review.

It does not implement a lease service, credential store, signing key, production
topology, customer data path, or managed Gateway component.

## Public files

- [`publish-stable-release-with-lease.mjs`](../../scripts/release/publish-stable-release-with-lease.mjs)
  is a standalone Node publisher with no workspace dependency. It validates a
  verified lease receipt and the already-attested draft publication snapshot,
  re-reads the exact GitHub Release by database ID, performs at most one
  conditional `PATCH {"draft":false}`, and terminally re-reads the live state.
- [`stable-publication-lease-receipt.schema.json`](./stable-publication-lease-receipt.schema.json)
  is the strict external receipt schema. Every object rejects unknown fields.
- `scripts/release/fixtures/stable-publication/` contains synthetic, content-free
  fixtures used only by adversarial tests.

## Lease receipt invariant

The exact receipt bytes must be independently attested before the publisher is
invoked. Schema validation alone is not authentication.

The receipt binds:

| Binding | Requirement |
| --- | --- |
| Resource | canonical repository, exact positive GitHub Release database ID, stable `clodex@x.y.z` tag |
| Source | exact lowercase 40-character commit and `refs/heads/main` |
| Manifest | normalized `.release-notes/*.json` path and SHA-256 |
| Draft | SHA-256 of the already-attested publication snapshot |
| Assets | independently recomputed SHA-256 of the canonical asset ID/name/size/content-digest set |
| Metadata | SHA-256 of the exact GitHub Release name and body |
| Holder | expected canonical publisher workflow, run ID, run attempt, and bounded holder ID |
| Lease | positive expected epoch, canonical issuance/expiry, maximum 15-minute lifetime, 256-bit base64url nonce |
| Producer | exact reviewed producer repository/workflow/source commit/run/attempt |
| Effect | one conditional PATCH maximum and an immutable terminal release requirement |

The publisher also limits idempotent recovery to 72 hours after lease expiry.
An expired lease can verify an already-completed exact publication, but it can
never authorize a new PATCH.

## Exact live checks

Immediately before the effect, the publisher requires all of the following:

1. the release database ID, API URL, tag, source commit, stable/non-prerelease
   state, creation time, name, and body match the lease and attested snapshot;
2. the complete asset set has the same unique IDs, names, positive sizes, and
   API SHA-256 digests as the snapshot;
3. the release remains a mutable draft with `published_at=null`;
4. the lease is active and matches independently supplied expected holder,
   producer, epoch, source, manifest, release, and snapshot bindings; and
5. the GET response contains a bounded, newline-free ETag used as `If-Match`.

The only write body is:

```json
{"draft":false}
```

There is no update of the tag, target commit, title, body, prerelease bit, or
assets, and there is no DELETE path.

After a successful response the PATCH body and a separate terminal GET must
both prove the exact public state. Terminal success requires `immutable=true`
and a publication timestamp inside the lease window. A `412` or transport error
causes one terminal GET; the publisher never automatically issues a second
PATCH. A later replay with the same receipt is effect-free only when that exact
immutable release is already public inside the same lease window.

## Required future workflow isolation

Activation should preserve a split-job pattern:

1. an unprivileged job downloads the lease receipt and draft snapshot by exact
   artifact IDs, verifies their SHA-256 values, and runs `gh attestation verify`
   against a reviewed producer workflow and signer commit;
2. a separate protected `Release` job receives only the exact verified artifact
   IDs/digests and expected content-free bindings;
3. the privileged job uses a fresh GitHub-hosted runner, does not check out the
   repository, has only `actions:read`, `attestations:read`, and the minimum
   `contents:write` permission, and materializes the reviewed standalone
   publisher bytes through an independently hash-bound handoff;
4. the write token is exposed only to the final revalidation/PATCH/terminal-GET
   process, with Actions runtime and OIDC variables removed unless explicitly
   required by the reviewed attestation step; and
5. a credential-free terminal job revalidates and attests the published
   snapshot.

No reusable or dispatchable workflow is added by this slice. The current hard
guard in `_release-browser.yml` remains the only reachable stable outcome.

## Activation gates still open

Do not remove `Stable publication is NOT_READY` until all of these are closed:

- a real external single-writer lease producer exists and its attestation
  identity, key custody, monotonic epoch semantics, revocation behavior, and
  outage handling are reviewed;
- the repository has immutable GitHub Releases enabled and a non-production
  exercise proves the API returns `immutable=true` immediately enough for
  terminal verification;
- GitHub documents or an approved live exercise proves the chosen `If-Match`
  behavior for release PATCH requests. Current GitHub GET responses may expose
  weak ETags, so the conditional header remains defense in depth rather than a
  claimed platform CAS guarantee;
- the no-checkout privileged handoff and exact publisher-byte binding are
  implemented and independently reviewed;
- preview.3 trusted canary evidence and the stable release plan exist;
- signing, final-byte OCB-006, acceptance, and update-feed gates are green; and
- adversarial CI passes on the exact immutable main commit.

Until then this code is testable public protocol/effect machinery, not release
authorization.
