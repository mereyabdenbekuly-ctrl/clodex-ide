#!/usr/bin/env bash

set -euo pipefail

readonly GITLEAKS_VERSION='8.30.1'
readonly RELEASE_BASE_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"

if [[ -n "${GITLEAKS_BIN:-}" ]]; then
  if [[ ! -x "${GITLEAKS_BIN}" ]]; then
    echo "GITLEAKS_BIN is not executable: ${GITLEAKS_BIN}" >&2
    exit 1
  fi
  printf '%s\n' "${GITLEAKS_BIN}"
  exit 0
fi

if command -v gitleaks >/dev/null 2>&1; then
  installed_binary="$(command -v gitleaks)"
  installed_version="$("${installed_binary}" version 2>/dev/null || true)"
  if [[ "${installed_version}" == "${GITLEAKS_VERSION}" ]]; then
    printf '%s\n' "${installed_binary}"
    exit 0
  fi
fi

platform="$(uname -s)"
architecture="$(uname -m)"

case "${platform}/${architecture}" in
  Darwin/arm64)
    archive="gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz"
    checksum='b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'
    ;;
  Darwin/x86_64)
    archive="gitleaks_${GITLEAKS_VERSION}_darwin_x64.tar.gz"
    checksum='dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'
    ;;
  Linux/aarch64 | Linux/arm64)
    archive="gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"
    checksum='e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'
    ;;
  Linux/x86_64)
    archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    checksum='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
    ;;
  *)
    echo "Unsupported platform: ${platform}/${architecture}" >&2
    echo 'Install Gitleaks manually and set GITLEAKS_BIN to its path.' >&2
    exit 1
    ;;
esac

cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/clodex/security/gitleaks/${GITLEAKS_VERSION}"
binary_path="${cache_root}/gitleaks"

if [[ -x "${binary_path}" ]]; then
  printf '%s\n' "${binary_path}"
  exit 0
fi

mkdir -p "${cache_root}"
chmod 700 "${cache_root}"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/clodex-gitleaks.XXXXXX")"
trap 'rm -rf "${temporary_directory}"' EXIT

archive_path="${temporary_directory}/${archive}"
curl --fail --location --silent --show-error \
  --retry 3 \
  --output "${archive_path}" \
  "${RELEASE_BASE_URL}/${archive}"

actual_checksum="$(
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${archive_path}" | awk '{print $1}'
  else
    shasum -a 256 "${archive_path}" | awk '{print $1}'
  fi
)"

if [[ "${actual_checksum}" != "${checksum}" ]]; then
  echo "Gitleaks checksum mismatch for ${archive}" >&2
  exit 1
fi

tar -xzf "${archive_path}" -C "${temporary_directory}" gitleaks
install -m 0755 "${temporary_directory}/gitleaks" "${binary_path}"
printf '%s\n' "${binary_path}"
