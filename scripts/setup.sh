#!/usr/bin/env bash
# Set up a clone or worktree: pinned toolchain via mise, then dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v mise >/dev/null; then
  mise trust --quiet mise.toml
  mise install
  eval "$(mise env --shell bash)"
  # Put the pinned tools ahead of any others already on PATH (e.g. vite-plus's Node).
  PATH="$(mise bin-paths | paste -sd: -):$PATH"
else
  echo "warning: mise not installed; using Bun $(bun --version), pin is $(grep -o 'bun@[^"]*' package.json)" >&2
fi

bun install --frozen-lockfile

# In a worktree, copy .dev.vars from the main clone.
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
[ -e .dev.vars ] || [ ! -e "$main/.dev.vars" ] || cp "$main/.dev.vars" .dev.vars
