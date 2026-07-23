#!/usr/bin/env bash
# cleanup-worktrees.sh — whatsapp-mcp (single-package MCP server) variant
#
# Adapted from libs/baileys-client/scripts/cleanup-worktrees.sh. No Postgres DB
# to drop — just remove the worktree, optionally delete the branch (only if
# merged into main, or --force). The node_modules symlink dispatch creates is
# removed with the worktree.
#
# Usage:  pnpm dispatch:cleanup --slug <slug> [--force]

set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage: pnpm dispatch:cleanup --slug <slug> [--force]
EOF
  exit 2
}

TARGET_SLUG=""
FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)   [ $# -ge 2 ] || usage; TARGET_SLUG="$2"; shift 2 ;;
    --force)  FORCE="force"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done
[ -n "$TARGET_SLUG" ] || usage

if ! printf '%s' "$TARGET_SLUG" | grep -Eq '^[a-z0-9-]{1,40}$'; then
  echo "Error: slug must match [a-z0-9-]{1,40}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --git-common-dir)"
case "$COMMON_DIR" in
  /*) COMMON_DIR_ABS="$COMMON_DIR" ;;
  *)  COMMON_DIR_ABS="$(cd "$SCRIPT_DIR" && cd "$COMMON_DIR" && pwd)" ;;
esac
PARENT_ROOT="$(cd "$COMMON_DIR_ABS/.." && pwd)"
cd "$PARENT_ROOT"

wt=".claude/worktrees/$TARGET_SLUG"
branch="agent/$TARGET_SLUG"

echo "[cleanup] slug=$TARGET_SLUG branch=$branch wt=$wt"

# Drop the node_modules symlink first so `git worktree remove` never chases it.
[ -L "$PARENT_ROOT/$wt/node_modules" ] && rm -f "$PARENT_ROOT/$wt/node_modules"

if git -C "$PARENT_ROOT" worktree list --porcelain | awk '$1=="worktree"{print $2}' | grep -Fxq "$PARENT_ROOT/$wt"; then
  if [ "$FORCE" = "force" ]; then
    git -C "$PARENT_ROOT" worktree remove --force "$wt" || true
  else
    git -C "$PARENT_ROOT" worktree remove "$wt" || {
      echo "[cleanup] worktree $wt is dirty — pass --force to discard." >&2
      exit 1
    }
  fi
else
  [ -e "$PARENT_ROOT/$wt" ] && rm -rf "$PARENT_ROOT/$wt"
fi

if git -C "$PARENT_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
  if [ "$FORCE" = "force" ]; then
    git -C "$PARENT_ROOT" branch -D "$branch" || true
  else
    if git -C "$PARENT_ROOT" merge-base --is-ancestor "$branch" main 2>/dev/null; then
      git -C "$PARENT_ROOT" branch -D "$branch"
    else
      echo "[cleanup] keeping unmerged branch $branch (use --force to discard)."
    fi
  fi
fi

git -C "$PARENT_ROOT" worktree prune
echo "[cleanup] done."
