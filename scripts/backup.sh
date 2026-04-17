#!/usr/bin/env sh
# Atomic online snapshot of the WhatsApp MCP SQLite DB.
# Runs inside the container (docker exec). Safe against a live writer because
# sqlite3 .backup is WAL-aware — a plain cp would be not.
set -eu

BASE="${WHATSAPP_MCP_DATA_DIR:-/data}"
DB="$BASE/data/whatsapp.db"
HOURLY="$BASE/backups/hourly"
DAILY="$BASE/backups/daily"

if [ ! -f "$DB" ]; then
  echo "backup.sh: $DB not found — nothing to back up." >&2
  exit 1
fi

mkdir -p "$HOURLY" "$DAILY"

sqlite3 "$DB" ".backup '$HOURLY/whatsapp.db'"

STAMP=$(date +%F)
if [ ! -f "$DAILY/whatsapp-$STAMP.db" ]; then
  cp "$HOURLY/whatsapp.db" "$DAILY/whatsapp-$STAMP.db"
  if [ -d "$BASE/auth_info" ]; then
    tar czf "$DAILY/auth_info-$STAMP.tar.gz" -C "$BASE" auth_info
  fi
fi

find "$HOURLY" -type f -mmin +2880 -delete 2>/dev/null || true
find "$DAILY" -type f -mtime +14 -delete 2>/dev/null || true
