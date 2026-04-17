#!/usr/bin/env bash
# End-to-end regression test for the DB persistence fix + backup script.
# Requires: sudo docker access. Run from repo root or anywhere.
#
#   bash scripts/smoke-backup.sh 2>&1 | tee /tmp/wa-smoke.log
#
# PASS criteria:
#   - whatsapp.db appears under the host bind mount (fix works)
#   - backup.sh produces a file under backups/hourly/
#   - After `docker rm` + fresh `docker run`, the DB is still there
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BAILEYS="${BAILEYS_DIR:-$REPO/../baileys-client}"
DATA="${DATA_DIR_SMOKE:-/tmp/wa-smoke-data}"
IMG="wa-mcp:smoke"
CNAME="wa-mcp-smoke"

section() { printf '\n\033[1;34m=== %s ===\033[0m\n' "$*"; }
pass()    { printf '\033[1;32mPASS\033[0m: %s\n' "$*"; }
fail()    { printf '\033[1;31mFAIL\033[0m: %s\n' "$*"; exit 1; }

cleanup() { sudo docker rm -f "$CNAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$DATA" && mkdir -p "$DATA"

section "1. Build image"
sudo DOCKER_BUILDKIT=1 docker build \
  --build-context "baileys=$BAILEYS" \
  -t "$IMG" "$REPO"

section "2. First run"
cleanup
sudo docker run -d --name "$CNAME" \
  -v "$DATA:/data" \
  -e MCP_AUTH_TOKEN=smoke-token \
  -e PUBLIC_QR_URL=http://localhost:39002/ \
  -p 39001:39001 -p 39002:39002 \
  "$IMG" >/dev/null

section "3. Wait for init (12s)"
sleep 12

section "4. REGRESSION TEST — DB on bind mount"
sudo ls -la "$DATA/data/" || fail "no data/ dir on host"
if sudo test -f "$DATA/data/whatsapp.db"; then
  SIZE=$(sudo stat -c%s "$DATA/data/whatsapp.db")
  pass "DB on bind mount (size=$SIZE bytes)"
else
  sudo docker logs "$CNAME" 2>&1 | tail -30
  fail "DB missing on host — fix did NOT take effect"
fi

section "5. backup.sh inside container"
sudo docker exec "$CNAME" /app/whatsapp-mcp/scripts/backup.sh
sudo ls -la "$DATA/backups/hourly/"
sudo test -f "$DATA/backups/hourly/whatsapp.db" \
  && pass "hourly snapshot created" \
  || fail "hourly snapshot missing"

section "6. Daily snapshot + auth tarball (if auth_info exists)"
sudo ls -la "$DATA/backups/daily/" || true

section "7. Kill container, recreate, verify DB persists"
FIRST_SIZE=$(sudo stat -c%s "$DATA/data/whatsapp.db")
cleanup
sudo docker run -d --name "$CNAME" \
  -v "$DATA:/data" \
  -e MCP_AUTH_TOKEN=smoke-token \
  -p 39001:39001 -p 39002:39002 \
  "$IMG" >/dev/null
sleep 5
if sudo test -f "$DATA/data/whatsapp.db"; then
  SECOND_SIZE=$(sudo stat -c%s "$DATA/data/whatsapp.db")
  pass "DB survived recreation (before=$FIRST_SIZE bytes, after=$SECOND_SIZE bytes)"
else
  fail "DB lost after container recreation"
fi

section "ALL GREEN"
