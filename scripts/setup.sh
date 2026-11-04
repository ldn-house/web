#!/usr/bin/env bash
#
# Prepare a clone or worktree for development:
#   - copy .dev.vars from the main clone into a linked worktree
#   - install the pinned toolchain with mise and require the pinned Bun
#   - install dependencies
#
# Idempotent, so safe to re-run: `scripts/setup.sh` or `bun run setup`.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

warnings=()
step() { printf '\n==> %s\n' "$1"; }
warn() {
  printf '!!  %s\n' "$1"
  warnings+=("$1")
}

main_worktree=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
if [ "$main_worktree" != "$repo_root" ]; then
  step "Copying .dev.vars from $main_worktree"
  if [ -e .dev.vars ]; then
    echo "    kept existing .dev.vars"
  elif [ -e "$main_worktree/.dev.vars" ]; then
    cp "$main_worktree/.dev.vars" .dev.vars
    echo "    copied .dev.vars"
  else
    warn "no .dev.vars in $main_worktree; local secrets are unset"
  fi
fi

step "Installing the pinned toolchain"
if command -v mise >/dev/null 2>&1; then
  mise trust --quiet mise.toml
  mise install
  # Use the pinned tools for the rest of setup, even before shell activation.
  eval "$(mise env --shell bash)"
else
  warn "mise is not installed (https://mise.jdx.dev/getting-started.html); using the tools on PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is not on PATH. Install mise, then re-run scripts/setup.sh." >&2
  exit 1
fi
expected=$(bun -p 'require("./package.json").packageManager.match(/^bun@([^+]+)/)?.[1] ?? ""')
actual=$(bun --version)
if [ "$actual" != "$expected" ]; then
  echo "package.json pins Bun ${expected:-(none)}, but $(command -v bun) is Bun $actual." >&2
  echo "Install mise, then re-run scripts/setup.sh." >&2
  exit 1
fi
echo "    bun $actual, node $(node --version 2>/dev/null || echo 'not found')"

step "Installing dependencies"
bun install --frozen-lockfile --prefer-offline

if [ ${#warnings[@]} -ne 0 ]; then
  printf '\n==> Warnings\n'
  printf '!!  %s\n' "${warnings[@]}"
fi
printf '\nSetup complete.\n'
