#!/usr/bin/env bash
# pg-backup.sh — wrapper for pg_dump | gzip
# Called by cron or manually. Writes to /data/backups/ (or $BACKUP_DIR).
#
# Usage:
#   DATABASE_URL="postgresql://..." ./scripts/pg-backup.sh
#
# Environment:
#   DATABASE_URL — Postgres connection string (required)
#   BACKUP_DIR   — destination directory (default: /data/backups)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
mkdir -p "${BACKUP_DIR}/daily"

DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
DAILY_FILE="${BACKUP_DIR}/daily/whatsapp-mcp-${DATE}.sql.gz"
HOURLY_FILE="${BACKUP_DIR}/hourly/whatsapp-mcp.sql.gz"

# Daily backup (one per day, not overwritten)
if [ ! -f "${DAILY_FILE}" ]; then
  echo "[${TIMESTAMP}] Creating daily backup: ${DAILY_FILE}"
  pg_dump "${DATABASE_URL}" | gzip > "${DAILY_FILE}"
fi

# Hourly snapshot (overwritten each run)
mkdir -p "${BACKUP_DIR}/hourly"
echo "[${TIMESTAMP}] Creating hourly snapshot: ${HOURLY_FILE}"
pg_dump "${DATABASE_URL}" | gzip > "${HOURLY_FILE}"

# Retention: 14 days for daily backups
find "${BACKUP_DIR}/daily" -name "whatsapp-mcp-*.sql.gz" -mtime +14 -delete 2>/dev/null || true

echo "[${TIMESTAMP}] Backup complete."
