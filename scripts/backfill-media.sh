#!/usr/bin/env sh
# One-shot migration: uploads existing local media files to S3/R2, sets media_object_key,
# then drops media_local_path column and removes the local media tree.
#
# Must run INSIDE the container (docker exec whatsapp-mcp /app/whatsapp-mcp/scripts/backfill-media.sh)
# so the mc client can reach the S3 endpoint and the DB + media files are accessible.
#
# Idempotent: re-running is safe (rows already migrated are skipped, INSERT OR IGNORE style).
# The DROP COLUMN only runs when 0 rows have media_local_path IS NOT NULL remaining.
set -eu

BASE="${WHATSAPP_MCP_DATA_DIR:-/data}"
DB="$BASE/data/whatsapp.db"
MEDIA_DIR="$BASE/data/media"

S3_BUCKET="${S3_BUCKET:-amiticia-media}"
S3_ALIAS="s3-backfill"
S3_ENDPOINT="${S3_ENDPOINT:-localhost}"
S3_PORT="${S3_PORT:-9000}"
S3_USE_SSL="${S3_USE_SSL:-false}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
TENANT_ID="${TENANT_ID:-default}"

if [ ! -f "$DB" ]; then
  echo "backfill-media.sh: $DB not found." >&2
  exit 1
fi

# Configure mc alias
if [ "$S3_USE_SSL" = "true" ]; then
  MC_SCHEME="https"
else
  MC_SCHEME="http"
fi
mc alias set "$S3_ALIAS" "${MC_SCHEME}://${S3_ENDPOINT}:${S3_PORT}" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --quiet

TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE media_local_path IS NOT NULL AND media_object_key IS NULL;")
echo "backfill-media.sh: $TOTAL rows to migrate."

if [ "$TOTAL" -eq 0 ]; then
  echo "backfill-media.sh: Nothing to migrate."
else
  MIGRATED=0
  SKIPPED=0

  # Fetch rows: id, chat_jid, media_local_path
  sqlite3 "$DB" "SELECT id, chat_jid, media_local_path FROM messages WHERE media_local_path IS NOT NULL AND media_object_key IS NULL;" |
  while IFS='|' read -r MSG_ID CHAT_JID LOCAL_PATH; do
    if [ -z "$LOCAL_PATH" ] || [ ! -f "$LOCAL_PATH" ]; then
      echo "  SKIP  $MSG_ID — file not found: $LOCAL_PATH"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    EXT="${LOCAL_PATH##*.}"
    SANITIZED_JID=$(printf '%s' "$CHAT_JID" | tr -c 'a-zA-Z0-9@._-' '_')
    OBJECT_KEY="t/${TENANT_ID}/${SANITIZED_JID}/${MSG_ID}.${EXT}"
    S3_TARGET="${S3_ALIAS}/${S3_BUCKET}/${OBJECT_KEY}"

    mc cp --quiet "$LOCAL_PATH" "$S3_TARGET"
    sqlite3 "$DB" "UPDATE messages SET media_object_key = '${OBJECT_KEY}', media_local_path = NULL WHERE id = '${MSG_ID}' AND chat_jid = '${CHAT_JID}';"

    echo "  OK    $MSG_ID → $OBJECT_KEY"
    MIGRATED=$((MIGRATED + 1))
  done

  echo "backfill-media.sh: migrated=${MIGRATED} skipped=${SKIPPED}"
fi

REMAINING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE media_local_path IS NOT NULL;")
echo "backfill-media.sh: remaining with media_local_path=$REMAINING"

if [ "$REMAINING" -gt 0 ]; then
  echo "backfill-media.sh: ERROR — $REMAINING rows still have media_local_path set. Fix and re-run before dropping the column." >&2
  exit 1
fi

# All rows migrated — drop column and remove local media tree
sqlite3 "$DB" "ALTER TABLE messages DROP COLUMN media_local_path;" 2>/dev/null || true
echo "backfill-media.sh: Dropped media_local_path column (or it was already gone)."

if [ -d "$MEDIA_DIR" ]; then
  rm -rf "$MEDIA_DIR"
  echo "backfill-media.sh: Removed $MEDIA_DIR"
fi

echo "backfill-media.sh: Done."
