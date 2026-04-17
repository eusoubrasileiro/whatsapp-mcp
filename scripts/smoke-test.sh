#!/usr/bin/env bash
# Smoke test for whatsapp-mcp HTTP endpoints. Assumes the container is running with
# MCP_AUTH_TOKEN=teste123 and ports 39001 (MCP) and 39002 (QR) published.
set -u

URL="http://127.0.0.1:39001/mcp"
PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

echo "--- /health (QR server, 39002) ---"
curl -sS http://127.0.0.1:39002/health
echo

echo "--- /mcp (39001) auth matrix ---"
for LABEL in no-bearer wrong-bearer right-bearer; do
  case "$LABEL" in
    no-bearer)    AUTH=() ;;
    wrong-bearer) AUTH=(-H "Authorization: Bearer outro") ;;
    right-bearer) AUTH=(-H "Authorization: Bearer teste123") ;;
  esac
  CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    "${AUTH[@]}" \
    -d "$PAYLOAD")
  echo "  $LABEL: HTTP $CODE"
done
