#!/usr/bin/env bash

set -euo pipefail
umask 077

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_directory}/../.." && pwd)"
mode="${1:-working-tree}"

case "${mode}" in
  working-tree | history)
    report_path="${2:-${repository_root}/security-reports/gitleaks-${mode}.json}"
    ;;
  commits)
    if [[ -z "${2:-}" ]]; then
      echo 'Usage: scan-secrets.sh commits <git-revision-range> [report-path]' >&2
      exit 2
    fi
    revision_range="${2}"
    report_path="${3:-${repository_root}/security-reports/gitleaks-commits.json}"
    ;;
  *)
    echo "Unknown scan mode: ${mode}" >&2
    echo 'Expected working-tree, commits, or history.' >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "${report_path}")"
gitleaks_binary="$("${script_directory}/install-gitleaks.sh")"
config_path="${repository_root}/.gitleaks.toml"

common_arguments=(
  --config "${config_path}"
  --redact=100
  --no-banner
  --report-format json
  --report-path "${report_path}"
)

temporary_directory=''
cleanup() {
  if [[ -n "${temporary_directory}" ]]; then
    rm -rf "${temporary_directory}"
  fi
}
trap cleanup EXIT

set +e
case "${mode}" in
  working-tree)
    temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/clodex-secret-scan.XXXXXX")"
    REPOSITORY_ROOT="${repository_root}" SNAPSHOT_ROOT="${temporary_directory}" \
      python3 - <<'PY'
import os
import pathlib
import shutil
import subprocess

repository = pathlib.Path(os.environ["REPOSITORY_ROOT"]).resolve()
snapshot = pathlib.Path(os.environ["SNAPSHOT_ROOT"]).resolve()
tracked = subprocess.check_output(
    [
        "git",
        "-C",
        str(repository),
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ]
)

for raw_path in tracked.split(b"\0"):
    if not raw_path:
        continue
    relative = pathlib.Path(os.fsdecode(raw_path))
    source = repository / relative
    if not source.is_file() or source.is_symlink():
        continue
    destination = (snapshot / relative).resolve()
    if snapshot not in destination.parents:
        raise RuntimeError(f"unsafe repository path: {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
PY
    "${gitleaks_binary}" dir "${temporary_directory}" "${common_arguments[@]}"
    ;;
  commits)
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0='diff.renameLimit' \
      GIT_CONFIG_VALUE_0='5000' \
      "${gitleaks_binary}" git "${repository_root}" \
      --log-opts="${revision_range}" \
      "${common_arguments[@]}"
    ;;
  history)
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0='diff.renameLimit' \
      GIT_CONFIG_VALUE_0='5000' \
      "${gitleaks_binary}" git "${repository_root}" \
      --log-opts='--all' \
      "${common_arguments[@]}"
    ;;
esac
scan_exit_code=$?
set -e

REPORT_PATH="${report_path}" python3 - <<'PY'
import collections
import json
import os
import pathlib

report = pathlib.Path(os.environ["REPORT_PATH"])
if not report.exists():
    print("Gitleaks did not produce a report.")
    raise SystemExit(0)

findings = json.loads(report.read_text())
if not findings:
    print(f"Gitleaks passed: no findings ({report}).")
    raise SystemExit(0)

rules = collections.Counter(item.get("RuleID", "unknown") for item in findings)
summary = ", ".join(f"{rule}={count}" for rule, count in sorted(rules.items()))
print(f"Gitleaks found {len(findings)} potential secrets: {summary}.")
print(f"Redacted report: {report}")
PY

exit "${scan_exit_code}"
