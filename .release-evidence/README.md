# Release evidence

This directory stores aggregate, content-free evidence used by automated
release promotion gates.

For the isolated agent runtime, add `isolated-agent-runtime.json` only after
the prerelease observation window is complete. Follow
`docs/isolated-agent-runtime-rollout.md`.

Never store raw telemetry rows, prompts, messages, tool inputs/outputs, trace
IDs, agent IDs, installation IDs, credentials, or workspace data here.

Evidence Memory canary promotion uses three files:

- `evidence-memory.json` — signed, expiring promotion envelope;
- `evidence-memory-quality.json` — deterministic aggregate quality receipt;
- `evidence-memory-trace-replay.json` — external content-free replay receipt.

The schema-v2 envelope is Ed25519-signed and binds both receipt byte hashes,
their policy hashes, the replay trace-set hash, the target canary stage, the
delivery mode, and the exact source commit. Private signing keys must never be
stored in this directory.

Two fail-closed delivery modes are supported:

- `external-ci-artifact`: CI injects the three files after checkout. The signed
  source commit must equal the build commit exactly.
- `repository-evidence-commit`: generate the files from an already committed
  source revision, then commit only the three generated files in a descendant
  commit. The rollout checker verifies Git ancestry and rejects any intervening
  path outside the three files listed above. This avoids the impossible
  self-reference that would result from signing the hash of a commit containing
  its own signature.

Safe repository workflow:

1. Commit the complete canary candidate, including the rollout policy change.
2. Run quality and external content-free trace replay on that source commit.
3. Sign with `--source-commit <source-sha> --delivery-mode
   repository-evidence-commit` using the protected release key.
4. Commit only the three generated Evidence Memory files.
5. Run `check:evidence-memory-rollout`; full Git history is required.

## Protected promotion workflows

### Evidence Memory

`.github/workflows/evidence-memory-promotion.yml` uses two jobs. Candidate code
runs first without release secrets and emits only bounded content-free receipts.
A fresh trusted job checks out the default-branch workflow revision, validates
the transport manifest, enters the protected Environment, signs the schema-v2
envelope, and verifies exact source/delivery binding.

For repository delivery, review and apply only the generated three-file patch.
For external delivery, inject the three files into the exact source build
without committing them. Never upload the Ed25519 private key.

### Model Fabric

Model Fabric promotion uses authenticated inputs rather than repository policy
files:

- a root-signed publication authority;
- a signed version-3 snapshot;
- externally signed, stage-bound approvals;
- previous signed state after bootstrap.

`.github/workflows/model-fabric-publication.yml` validates those inputs in a
secretless job and exposes only the protected publisher identity in the second
job. It never creates release/security approvals. Production must publish the
exact snapshot from the immediately preceding canary state.

### Agentic App Runtime

Agentic App promotion uses a commit-bound pair:

- `agentic-app-runtime.json` — content-free dogfood aggregate, six explicit
  manual gates, and the evaluation link;
- `agentic-app-runtime-evaluation.json` — deterministic evaluation bytes.

`.github/workflows/agentic-app-runtime-promotion.yml` requires
`source_commit == GITHUB_SHA`, regenerates the evaluation from trusted `main`,
checks all source/hash/manual gates, and uploads a checksummed evidence bundle.

### Cloud Tasks

Cloud Task promotion uses schema-v2 evidence bound to the exact source commit,
plus fresh macOS, Windows, and Linux suspend/resume receipts. Product, security,
and operations attestations are mandatory inputs. Synthetic fixtures cannot
replace the physical platform receipts.

### Decoupled Execution

Runner promotion uses:

- `runner-routing/*.json` — signed, content-free paired-replay bundles;
- `runner-routing-trusted-collectors.txt` — pinned P-256 collector public keys.

Schema-v2 bundles bind `sourceCommitSha`. At least four fresh promotion-eligible
SSH/Docker samples across two command classes must succeed. Controlled fault
samples remain diagnostic only. `.github/workflows/runner-docker-promotion.yml`
runs the production Docker transport against a digest-resolved disposable
image and signs the resulting bundle with the protected collector identity.
