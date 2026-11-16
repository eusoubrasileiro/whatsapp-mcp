#!/bin/sh
# heavy-lock.sh — run a heavy command (a full vitest suite, Playwright, the mutation
# gate) under the machine-wide heavy-job lock, so parallel worktrees queue instead of
# running two 20 GB test pools at once.
#
#   sh scripts/heavy-lock.sh <command> [args...]
#
# Why: between July and October 2026 overlapping wahub test pools ran the 32 GB
# workstation out of memory 13 times — two logouts, one hard reboot. Every git hook
# on the workstation takes the same lock (standards/workstation/husky/init.sh, which
# documents the contract); this is the command form for what agents run by hand.
#
#   lock    $AMITICIA_HEAVY_LOCK_DIR (default /run/user/$UID)/amiticia-heavy.lock via
#           flock. The command inherits fd 9, so a leaked worker holds the queue
#           until it really exits. The override exists for the tests.
#   held    AMITICIA_HEAVY_LOCK=held is exported, so nested calls run straight
#           through (pre-push -> pnpm test:e2e:supabase must not deadlock).
#   victim  oom_score_adj 900: under a memory cap the kernel kills a test worker,
#           never the Claude session that started it.
#   wait    45 min, then fail naming the holder.
#   skip    CI, no flock, or no lock dir: the command just runs.
set -eu

lock_dir="${AMITICIA_HEAVY_LOCK_DIR:-/run/user/$(id -u)}"
if [ -n "${AMITICIA_HEAVY_LOCK-}" ] || [ -n "${CI-}" ] || [ ! -d "$lock_dir" ] ||
  ! command -v flock >/dev/null 2>&1; then
  exec "$@"
fi

lock="$lock_dir/amiticia-heavy.lock"
exec 9>>"$lock"
if ! flock -n 9; then
  echo "heavy-lock: waiting for heavy job: $(cat "$lock.owner" 2>/dev/null || echo unknown)" >&2
  if ! flock -w 2700 9; then
    echo "heavy-lock: gave up after 45 min, still held by: $(cat "$lock.owner" 2>/dev/null)" >&2
    exit 1
  fi
fi
echo "$*, pid $$, in $(pwd), since $(date +%H:%M:%S)" >"$lock.owner"
echo 900 >/proc/self/oom_score_adj 2>/dev/null || :
export AMITICIA_HEAVY_LOCK=held
exec "$@"
