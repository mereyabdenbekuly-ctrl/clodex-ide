#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root"

image_ref="${CLODEX_UPDATE_SERVER_IMAGE_REF:-clodex-update-server:ci-$(git rev-parse --short=12 HEAD)}"
output_directory="${CLODEX_UPDATE_SERVER_EVIDENCE_DIR:-security-reports/update-server-image}"
sbom_path="$output_directory/update-server.cyclonedx.json"
record_path="$output_directory/update-server-image-inspection.json"
toolchain_policy="apps/update-server/deploy-toolchain.json"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/clodex-update-server-sbom.XXXXXX")"
cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

node scripts/ci/check-update-server-deploy.mjs
mkdir -p "$output_directory"
rm -f "$sbom_path" "$record_path"

DOCKER_BUILDKIT=1 docker build \
  --file apps/update-server/Dockerfile \
  --pull \
  --tag "$image_ref" \
  .

runtime_user="$(docker image inspect --format '{{.Config.User}}' "$image_ref")"
test "$runtime_user" = node

docker run --rm --entrypoint sh "$image_ref" -eu -c '
  test -f /app/dist/index.js
  test -f /app/package.json
  test ! -e /app/src
  test ! -e /app/package-lock.json
  test ! -e /app/pnpm-lock.yaml
  test ! -e /app/node_modules/.pnpm-workspace-state-v1.json
  test ! -e /app/node_modules/typescript
  test ! -e /app/node_modules/vitest
'

expected_node_version="$(node -p "require('./$toolchain_policy').node.version")"
actual_node_version="$(docker run --rm --entrypoint node "$image_ref" --version)"
test "$actual_node_version" = "v$expected_node_version"

expected_gh_version="$(node -p "require('./$toolchain_policy').githubCli.version")"
actual_gh_version="$(docker run --rm --entrypoint gh "$image_ref" version | awk 'NR == 1 { print $3 }')"
test "$actual_gh_version" = "$expected_gh_version"

gh_help="$(docker run --rm --entrypoint gh "$image_ref" attestation verify --help)"
while IFS= read -r required_flag; do
  grep -F -- "$required_flag" <<<"$gh_help" >/dev/null
done < <(
  node -e "for (const flag of require('./$toolchain_policy').githubCli.requiredAttestationFlags) console.log(flag)"
)

case "$(uname -s)" in
  Darwin) syft_os=darwin ;;
  Linux) syft_os=linux ;;
  *) echo "Unsupported Syft host OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) syft_arch=amd64 ;;
  arm64|aarch64) syft_arch=arm64 ;;
  *) echo "Unsupported Syft host architecture: $(uname -m)" >&2; exit 1 ;;
esac

syft_key="$syft_os-$syft_arch"
syft_version="$(node -p "require('./$toolchain_policy').syft.version")"
syft_base_url="$(node -p "require('./$toolchain_policy').syft.sourceBaseUrl")"
syft_archive="$(node -p "require('./$toolchain_policy').syft.archives['$syft_key'].file")"
syft_sha256="$(node -p "require('./$toolchain_policy').syft.archives['$syft_key'].sha256")"

curl \
  --fail \
  --location \
  --retry 5 \
  --retry-all-errors \
  --connect-timeout 20 \
  --max-time 300 \
  --output "$temporary_directory/syft.tar.gz" \
  "$syft_base_url/$syft_archive"

test "$(sha256_file "$temporary_directory/syft.tar.gz")" = "$syft_sha256"
tar --extract --gzip --file "$temporary_directory/syft.tar.gz" --directory "$temporary_directory" syft
actual_syft_version="$("$temporary_directory/syft" version --output json | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
test "$actual_syft_version" = "$syft_version"

SYFT_CHECK_FOR_APP_UPDATE=false "$temporary_directory/syft" scan \
  "docker:$image_ref" \
  --output "cyclonedx-json=$sbom_path" \
  --quiet

image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
source_commit="$(git rev-parse HEAD)"
node scripts/ci/validate-update-server-sbom.mjs \
  --image-id="$image_id" \
  --image-ref="$image_ref" \
  --record="$record_path" \
  --sbom="$sbom_path" \
  --source-commit="$source_commit" \
  --syft-version="$actual_syft_version"

printf 'Update-server image: %s (%s)\n' "$image_ref" "$image_id"
printf 'Runtime SBOM: %s\n' "$sbom_path"
printf 'CI inspection record: %s\n' "$record_path"
