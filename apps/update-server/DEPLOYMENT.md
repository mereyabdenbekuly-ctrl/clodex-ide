# Update-server deployment graph

The update server is built from the monorepo root so its production dependency
closure is resolved exclusively by the reviewed root `pnpm-lock.yaml`.
`package-lock.json`, `npm-shrinkwrap.json`, `npm ci`, and app-directory Docker
contexts are not supported deployment inputs.

## Immutable toolchain

`deploy-toolchain.json` records the reviewed runtime inputs:

- the exact Node/Alpine multi-platform manifest digest;
- the pnpm version bound to the root `packageManager` field;
- GitHub CLI release archives and SHA-256 values for Linux amd64 and arm64;
- Syft release archives and SHA-256 values for supported CI hosts;
- direct production components that must be present in the runtime SBOM and
  development components that must not be present.

The Dockerfile verifies the selected GitHub CLI archive before extracting it
and rejects architectures outside the reviewed allowlist. It also checks that
the installed CLI exposes every attestation-policy flag required by the update
server. Changing any version, image digest, archive, checksum, or supported
architecture requires updating the machine-readable policy, tests, and review
in the same pull request.

## Build

From the repository root:

```bash
docker build \
  --file apps/update-server/Dockerfile \
  --pull \
  --tag clodex-update-server:local \
  .
```

`apps/update-server/Dockerfile.dockerignore` is a deny-by-default allowlist for
that root context. The builder performs a frozen, script-free filtered pnpm
install and an injected-workspace `pnpm deploy --prod`. The final image
contains `dist`, production Node modules, the verified `gh` binary, and no
TypeScript source, deployment lockfile, or development dependencies. The root
lockfile is a builder input; removing its deploy copy prevents final-image
scanners from reporting the entire monorepo graph as installed runtime
content. The runtime user is the unprivileged `node` account.

Do not build with `apps/update-server` as the Docker context. That bypasses the
canonical workspace graph and cannot provide the root lockfile.

## Runtime SBOM inspection

Run the same image inspection used by CI:

```bash
scripts/ci/build-update-server-image.sh
```

The script:

1. runs the fail-closed source/deploy policy check;
2. builds the Dockerfile from the repository root;
3. verifies runtime user, Node version, GitHub CLI version and attestation
   flags, expected files, and absence of development-only files;
4. downloads the policy-pinned Syft archive and verifies its SHA-256;
5. scans the final image (not the source tree) into CycloneDX JSON;
6. validates required and forbidden runtime components; and
7. writes a CI inspection record binding the image ID, source commit,
   Dockerfile, root lockfile, toolchain policy, and SBOM hashes.

Default outputs are:

```text
security-reports/update-server-image/update-server.cyclonedx.json
security-reports/update-server-image/update-server-image-inspection.json
```

CI retains these files as a 30-day build artifact. The inspection record is
explicitly marked `releaseEvidence: false`: it proves what a CI-built local
image contained, but it is not a registry digest attestation, deployment
receipt, signing/notarization result, acceptance result, or canary result.
Those later gates must bind the exact promoted registry image and live
deployment without copying or fabricating this record.

## Required checks

```bash
pnpm check:update-server-deploy
pnpm test:boundaries
pnpm --dir apps/update-server build
pnpm --dir apps/update-server test
```

A deployment change is not reviewable if any alternate lockfile is present or
if the image/SBOM job is removed from required monorepo CI.
