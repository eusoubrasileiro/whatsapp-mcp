#!/usr/bin/env sh
# Merge an external whatsapp.db into the current one. Idempotent.
# Container MUST be stopped (WAL lock).
#
# Merge policy:
#   chats     — UPSERT, keep newest last_message_time, keep existing name
#   contacts  — UPSERT, prefer existing non-null fields (target wins)
#   messages  — INSERT OR IGNORE on (id, chat_jid); media_local_path set to NULL
#               on import because external paths don't exist on this host
#
# Usage on host (with a one-shot container that has sqlite3):
#   docker run --rm \
#     -v /storage/whatsapp-mcp:/data \
#     -v /tmp:/src \
#     -v /root/whatsapp-mcp/scripts:/scripts \
#     --entrypoint sh \
#     ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
#     /scripts/merge-db.sh /src/old-wa.db
set -eu

SRC="${1:?usage: merge-db.sh <source-db>}"
BASE="${WHATSAPP_MCP_DATA_DIR:-/data}"
DB="$BASE/data/whatsapp.db"

[ -f "$SRC" ] || { echo "merge-db.sh: source not found: $SRC" >&2; exit 1; }
[ -f "$DB" ]  || { echo "merge-db.sh: target DB not found: $DB" >&2; exit 1; }

if command -v fuser >/dev/null 2>&1 && fuser "$DB" >/dev/null 2>&1; then
  echo "merge-db.sh: $DB is in use — stop the container first." >&2
  exit 1
fi

count() { sqlite3 "$1" "SELECT (SELECT COUNT(*) FROM chats)||'/'||(SELECT COUNT(*) FROM messages)||'/'||(SELECT COUNT(*) FROM contacts);"; }

echo "merge-db.sh: target before $(count "$DB") (chats/msgs/contacts)"
echo "merge-db.sh: source        $(count "$SRC")"

sqlite3 "$DB" <<SQL
ATTACH DATABASE '$SRC' AS ext;
BEGIN IMMEDIATE;

-- chats: keep newest last_message_time
INSERT INTO chats (jid, name, last_message_time)
  SELECT jid, name, last_message_time FROM ext.chats WHERE true
  ON CONFLICT(jid) DO UPDATE SET
    last_message_time = CASE
      WHEN excluded.last_message_time IS NOT NULL
       AND (chats.last_message_time IS NULL
            OR excluded.last_message_time > chats.last_message_time)
      THEN excluded.last_message_time
      ELSE chats.last_message_time
    END,
    name = COALESCE(chats.name, excluded.name);

-- contacts: target wins, fill nulls from source
INSERT INTO contacts (jid, name, notify, phone_number)
  SELECT jid, name, notify, phone_number FROM ext.contacts WHERE true
  ON CONFLICT(jid) DO UPDATE SET
    name         = COALESCE(contacts.name, excluded.name),
    notify       = COALESCE(contacts.notify, excluded.notify),
    phone_number = COALESCE(contacts.phone_number, excluded.phone_number);

-- messages: immutable by (id, chat_jid). Translate absolute media_local_path
-- from the source host (anything/.../media/X/Y) into the local container
-- path (/data/data/media/X/Y). Assumes the caller rsync'd media files
-- alongside the DB. If the source path doesn't contain "/media/", null out.
INSERT OR IGNORE INTO messages (
  id, chat_jid, sender, content, timestamp, is_from_me,
  media_type, mimetype, media_key, direct_path, media_url,
  file_length, file_sha256, file_enc_sha256, media_local_path
) SELECT
  id, chat_jid, sender, content, timestamp, is_from_me,
  media_type, mimetype, media_key, direct_path, media_url,
  file_length, file_sha256, file_enc_sha256,
  CASE
    WHEN media_local_path IS NULL THEN NULL
    WHEN instr(media_local_path, '/media/') > 0
      THEN '/data/data/media/' || substr(media_local_path, instr(media_local_path, '/media/') + 7)
    ELSE NULL
  END
FROM ext.messages;

COMMIT;
DETACH DATABASE ext;
SQL

echo "merge-db.sh: target after  $(count "$DB")"
echo "merge-db.sh: OK — start the container and verify with list_messages."
