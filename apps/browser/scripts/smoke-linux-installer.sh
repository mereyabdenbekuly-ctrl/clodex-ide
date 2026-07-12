#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

channel="${1:-release}"
arch="${2:-x64}"
version="${3:-}"

case "$channel" in
  dev) base_name="clodex-dev" ;;
  nightly) base_name="clodex-nightly" ;;
  prerelease) base_name="clodex-prerelease" ;;
  release) base_name="clodex" ;;
  *) echo "Unsupported channel: $channel" >&2; exit 1 ;;
esac

browser_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
make_dir="$browser_dir/out/$channel/make"
deb_path="$(find "$make_dir" -type f -name '*.deb' -print -quit)"
if [[ -z "$deb_path" ]]; then
  echo "Debian package not found under $make_dir" >&2
  exit 1
fi

profile_dir="$(mktemp -d)"
log_path="$browser_dir/out/$channel/validation/linux-$arch-${version:-unknown}-installer-smoke.log"
mkdir -p "$(dirname "$log_path")"

cleanup() {
  sudo apt-get purge -y "$base_name" >/dev/null 2>&1 || true
  rm -rf "$profile_dir"
}
trap cleanup EXIT

echo "[linux-installer-smoke] Installing $deb_path"
sudo apt-get update -qq
sudo apt-get install -y "$deb_path"

executable="/usr/bin/$base_name"
if [[ ! -x "$executable" ]]; then
  echo "Installed executable is missing: $executable" >&2
  exit 1
fi

echo "[linux-installer-smoke] Running installed application"
set +e
timeout 120s xvfb-run -a "$executable" \
  --no-sandbox \
  --disable-gpu \
  "--user-data-dir=$profile_dir" \
  --smoke-test >"$log_path" 2>&1
exit_code=$?
set -e
cat "$log_path"

if [[ "$exit_code" -ne 0 ]]; then
  echo "Installed application smoke failed with exit $exit_code" >&2
  exit "$exit_code"
fi
if ! grep -Fq '[smoke-test] App ready — all modules loaded successfully.' "$log_path"; then
  echo "Installed application did not emit the smoke success marker" >&2
  exit 1
fi

echo "[linux-installer-smoke] Uninstalling $base_name"
sudo apt-get purge -y "$base_name"
if command -v "$base_name" >/dev/null 2>&1; then
  echo "Executable remains on PATH after uninstall: $base_name" >&2
  exit 1
fi

echo "[linux-installer-smoke] Passed"
