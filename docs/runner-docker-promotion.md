# Physical Docker runner promotion evidence

Checkpoint date: 2026-07-12.

## Purpose

The Decoupled Execution promotion gate requires evidence from a real non-local
execution provider. Unit tests and mocked transports do not satisfy it.
`.github/workflows/runner-docker-promotion.yml` runs the production
`DockerCliRunnerTransport` and `DockerRunnerAdapter` on a GitHub-hosted Linux
runner with an actual Docker daemon.

The workflow produces at least four successful paired-replay samples across at
least two command classes. Each sample compares a local baseline with a fresh
disposable Docker workspace and persists only hashes, bounded timings, outcome
classes, provider metadata, and signed receipts.

## Commit-bound evidence contract

Runner dogfood evidence uses schema version 2. The collector signature now
binds `sourceCommitSha` in addition to the bundle ID, collection time, collector
identity, and every sample. Main-plan readiness passes the exact build commit to
the Decoupled Execution assessor and rejects any bundle from another commit with
`runner-source-commit-mismatch`.

The SSH dogfood collector was upgraded to the same contract. Schema-v1 bundles
cannot unlock promotion.

## Real Docker isolation path

The workflow:

1. checks out the exact trusted `main` commit and requires
   `source_commit == GITHUB_SHA`;
2. resolves the official Alpine base tag to its pulled immutable digest;
3. builds a minimal Git-capable runner image and pushes it to a job-local Docker
   registry so the production transport receives a digest-pinned image ref;
4. creates a detached worktree for the exact commit plus a controlled tracked
   patch and untracked file;
5. packages the real `WorkspaceSnapshot` materialization;
6. executes four read-only Git workloads through fresh Docker containers;
7. verifies the signed bundle with the pinned collector identity and runs
   `check:main-plan-readiness --require-promotion decoupled-execution`.

Every execution container is created by the production transport with:

- `--network none`;
- a read-only root filesystem;
- numeric non-root user `65532:65532`;
- private PID, IPC, and UTS namespaces;
- all Linux capabilities dropped;
- `no-new-privileges`;
- bounded CPU, memory, PID, file-descriptor, and execution-time limits;
- disposable tmpfs mounts for `/tmp` and `/workspace`.

The runner image build has network access only before dogfood execution. The
actual execution containers have no network access.

## Collector trust

The `runner-docker-promotion` GitHub Environment is restricted to `main` and
contains:

- Environment secret `CLODEX_RUNNER_DOGFOOD_COLLECTOR_IDENTITY`;
- Environment variable `CLODEX_RUNNER_DOGFOOD_COLLECTOR_PUBLIC_KEY`;
- Environment variable `CLODEX_RUNNER_DOGFOOD_COLLECTOR_KEY_ID`.

The secret is a versioned P-256 keypair JSON document. It is materialized only
after dependencies and contract tests are complete, written with owner-only
permissions, matched against the pinned public variable, and deleted in an
`always()` cleanup step. The private key is never placed in repository files,
logs, reports, or uploaded artifacts.

The uploaded bundle contains the public collector trust file used by strict
readiness. This proves which configured collector signed the physical run; it
does not represent an independent human release approval. Required GitHub
reviewers remain a separate repository-administration control.

## Dispatch

The workflow must first exist on `main`. Then dispatch it against the exact
current main revision:

```bash
SOURCE_COMMIT="$(gh api repos/mereyabdenbekuly-ctrl/stagewise/commits/main --jq .sha)"

gh workflow run runner-docker-promotion.yml \
  --repo mereyabdenbekuly-ctrl/stagewise \
  --ref main \
  -f source_commit="$SOURCE_COMMIT" \
  -f repetitions=1
```

Do not reuse an artifact after the source commit changes. The strict gate will
reject it even if the collector signature and physical samples remain valid.

Before the workflow reaches `main`, pushing the dedicated
`release-evidence/runner-docker-candidate` branch runs the same physical path
against that exact candidate commit. This is useful for proving the Docker
infrastructure and schema-v2 gate, but it is not the final main-branch release
attestation. The Environment branch policy explicitly names this one candidate
branch; arbitrary feature branches cannot receive the collector identity.

## Outputs

The checksummed artifact contains:

- `runner-routing/*.json` — signed schema-v2 physical replay bundle;
- `runner-routing-trusted-collectors.txt` — pinned public collector key;
- `docker-dogfood-report.json` — content-free physical-run diagnostics;
- `main-plan-readiness.json` — strict Decoupled Execution promotion result;
- `workflow-metadata.json` — source commit, base/runner image digests, collector
  key ID, artifact hashes, actor, and immutable workflow URL;
- deterministic tarball and SHA-256 checksum.

The report stores no commands, command output, workspace paths, prompts,
credentials, or repository contents.
