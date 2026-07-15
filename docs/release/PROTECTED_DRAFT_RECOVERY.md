# Protected GitHub Draft Recovery

The protected release publisher may resume a draft only when one GitHub
Release record uses the requested tag and all of the following are exact:

- release ID and exact-ID upload URL;
- tag, immutable target commit, draft/prerelease state, name, and body;
- every existing asset's unique name, non-zero size, `uploaded` state, and
  GitHub `sha256:` digest against the locally staged file.

In that state, a retry uploads only missing assets and re-verifies the complete
draft. It never updates or deletes a release or asset. A published release is
immutable and is never a retry target.

Stable manifests also stage a protected draft with no public download links.
Attestation verifies that draft before any separately reviewed publication
effect. The public
[`STABLE_LEASE_PUBLICATION.md`](./STABLE_LEASE_PUBLICATION.md) slice defines a
lease-bound, single-PATCH effect contract, but no workflow invokes it and the
current stable publisher remains `NOT_READY`. It does not change the no-update,
no-delete recovery behavior of the protected draft stager described above.

## Read-only triage

Use an operator token only in the protected release environment. Do not paste
tokens into commands, logs, issues, or this repository.

```bash
export REPOSITORY=mereyabdenbekuly-ctrl/clodex-ide
export TAG=v1.16.0-preview.2

gh api --paginate "repos/${REPOSITORY}/releases?per_page=100" \
  --jq '.[] | select(.tag_name == env.TAG) | {id,tag_name,target_commitish,draft,prerelease,name,published_at,assets}'
```

Record the workflow run ID, expected source SHA, release IDs, and asset
metadata before any manual action.

## States requiring manual recovery

| State                                                                  | Required disposition                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published release                                                      | Stop. Preserve it unchanged and prepare a new reviewed version/tag if another release is required.                                                |
| Multiple records for one tag                                           | Stop. Have repository administrators identify the authoritative draft and resolve duplicates through the approved change process before retrying. |
| Wrong target SHA, tag, name, body, draft, or prerelease state          | Stop. Do not repurpose the record. Retire or correct it only through an independently reviewed administrator action.                              |
| Unexpected or duplicate asset name                                     | Stop. Preserve evidence and reconcile the asset inventory manually before retrying.                                                               |
| Wrong asset size or SHA-256                                            | Stop. Treat the draft as untrusted; rebuild from the immutable source and resolve the bad asset through the approved administrator process.       |
| Asset with missing digest, zero size, or a state other than `uploaded` | Stop. Inspect the failed GitHub upload and resolve the incomplete asset manually; automation will not delete it.                                  |
| Missing expected assets only                                           | Safe automated state. Re-run the same exact-SHA protected workflow; only the missing files are uploaded.                                          |

After manual recovery, repeat the read-only query and retry only when exactly
one exact draft remains. Keep the recovery evidence with the release sign-off;
do not claim publication, notarization, acceptance, or canary completion from a
recovered draft alone.
