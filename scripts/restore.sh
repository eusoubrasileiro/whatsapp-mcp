#!/usr/bin/env sh
# Restore whatsapp.db (and optionally auth_info) from a backup.
# Run on host with WHATSAPP_MCP_DATA_DIR pointing at the bind-mount, OR
# inside an alpine helper:
#   docker run --rm -v /storage/whatsapp-mcp:/data alpine sh /scripts/restore.sh …
# The target container MUST be stopped — a live writer holds the WAL lock
# and copying over it produces a corrupt DB.
set -eu

SRC_DB="${1:?usage: restore.sh <source-db> [source-auth-tar]}"
SRC_AUTH="${2:-}"
BASE="${WHATSAPP_MCP_DATA_DIR:-/data}"
DB="$BASE/data/whatsapp.db"

if [ ! -f "$SRC_DB" ]; then
  echo "restore.sh: source DB not found: $SRC_DB" >&2
  exit 1
fi

if [ -e "$DB" ] && command -v fuser >/dev/null 2>&1 && fuser "$DB" >/dev/null 2>&1; then
  echo "restore.sh: $DB is in use — stop the container first." >&2
  exit 1
fi

mkdir -p "$BASE/data"
cp "$SRC_DB" "$DB"
rm -f "$DB-wal" "$DB-shm"

if [ -n "$SRC_AUTH" ]; then
  if [ ! -f "$SRC_AUTH" ]; then
    echo "restore.sh: source auth tar not found: $SRC_AUTH" >&2
    exit 1
  fi
  rm -rf "$BASE/auth_info"
  tar xzf "$SRC_AUTH" -C "$BASE"
fi

echo "restore.sh: DB restored to $DB. Start the container and verify with list_messages."
