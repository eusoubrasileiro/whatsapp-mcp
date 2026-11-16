#!/usr/bin/env bash
# Usage: ensure-worktree-hooks.sh <worktree-root>
#
# core.hooksPath is the relative `.husky/_` in the shared .git/config, so git
# resolves it per worktree. `.husky/_/` is generated (gitignored), so a worktree
# without it runs NO commit/push gate, silently (seen in wahub #312, and in this
# repo's own worktrees on 2026-11-16). Generate it if missing,
# then fail loudly if it still is not there: a dispatch without hooks must never
# look successful.
set -euo pipefail

WT="${1:?usage: ensure-worktree-hooks.sh <worktree-root>}"
HOOK="$WT/.husky/_/pre-commit"

if [ ! -f "$HOOK" ]; then
  echo "[dispatch] $HOOK missing; running pnpm exec husky"
  # env -u HUSKY: HUSKY=0 in the caller's shell makes husky skip generation.
  (cd "$WT" && env -u HUSKY pnpm exec husky) || true
fi

if [ ! -f "$HOOK" ]; then
  echo "Error: $HOOK is still missing after 'pnpm exec husky'." >&2
  echo "       This worktree would run no git hooks. Fix it, then re-run dispatch." >&2
  exit 1
fi
