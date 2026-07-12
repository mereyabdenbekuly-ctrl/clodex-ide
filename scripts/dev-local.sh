#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HOME="$ROOT_DIR/.home"
export PNPM_HOME="$ROOT_DIR/.home/pnpm"
export XDG_CACHE_HOME="$ROOT_DIR/.home/.cache"

mkdir -p "$HOME" "$PNPM_HOME" "$XDG_CACHE_HOME"

cd "$ROOT_DIR"

pnpm -F @clodex/agent-runtime-node build
pnpm -F @clodex/karton build
pnpm -F @clodex/agent-core build

if ! pnpm -F @clodex/agent-shell build; then
  if [[ -f "$ROOT_DIR/packages/agent-shell/dist/index.js" ]]; then
    echo "agent-shell declaration generation reported TypeScript errors; dist JS exists, continuing for local dev."
  else
    exit 1
  fi
fi

pnpm -F @clodex/tailwindcss-color-modifiers build
pnpm -F clodex start:fast
