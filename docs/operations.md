# Operations

The step-by-step runbook for a Docker + Traefik host — first deploy, updates, token rotation,
logs, media plane, backups, restore — is [`deploy/README.md`](../deploy/README.md). This page
holds the background and the troubleshooting tables.

## Building the image

The image needs the sibling `baileys-client` checkout as a BuildKit build context:

```bash
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=../baileys-client \
  -t whatsapp-mcp:latest .
```

`deploy/docker-compose.yaml` references `ghcr.io/amiticia-autosys/whatsapp-mcp:latest` (the
maintainers' private registry) — tag your build with that name or change `image:`.

Smoke test a fresh build:

```bash
docker run --rm -d --name wa-mcp-smoke \
  -p 39001:39001 -p 39002:39002 \
  -v /tmp/wa-mcp-test-data:/data \
  -e MCP_AUTH_TOKEN=test123 \
  -e PUBLIC_QR_URL=http://localhost:39002/ \
  whatsapp-mcp:latest
curl -sS http://127.0.0.1:39002/health
curl -sS -o /dev/null -w "%{http_code}\n" -H 'Authorization: Bearer test123' \
  http://127.0.0.1:39001/mcp
```

[`scripts/smoke-test.sh`](../scripts/smoke-test.sh) runs the no-bearer / wrong-bearer /
right-bearer auth matrix.

## Pairing

On first run or after `logout`, open the QR page (`https://wa.example.com/` in production,
`http://127.0.0.1:39002/` locally) or call `get_connection_status`, and scan it from WhatsApp
→ Settings → Linked Devices. Credentials persist in `auth_info/`. Set `EXPECTED_WA_NUMBER`
before exposing the QR page publicly — otherwise anyone who opens it can pair their own phone.

## Backups: why a script

SQLite runs in WAL mode (`journal_mode = WAL` in `src/database.ts`). Copying `whatsapp.db`
while the container writes captures an inconsistent snapshot; `scripts/backup.sh` uses
`sqlite3 .backup`, the WAL-safe online-backup API. Retention: 48 h hourly, 14 d daily.

`scripts/restore.sh` **overwrites** the DB (optionally auth too). `scripts/merge-db.sh`
**folds** another DB into the live one, idempotently:

- `messages` — `INSERT OR IGNORE` on `(id, chat_jid)`; the target row wins on collision.
- `chats` — upsert, keeps the newest `last_message_time`, preserves the target's `name`.
- `contacts` — upsert, target wins, source fills NULLs.

Both need the container stopped (the live writer holds the WAL lock). Imported messages have no
`media_object_key`; `download_media` re-fetches their media on demand. Commands:
[`deploy/README.md`](../deploy/README.md#restoring-a-db--overwrite-vs-merge).

## Troubleshooting (HTTP deployment)

| Symptom | Fix |
|---------|-----|
| `claude mcp list` shows whatsapp `✗ Failed to connect` | Check `curl -sS -o /dev/null -w '%{http_code}' https://mcp.example.com/health` — if not reachable, DNS or Traefik issue. See [`deploy/README.md`](../deploy/README.md). |
| `HTTP 401` from MCP endpoint | `MCP_AUTH_TOKEN` mismatch between `.env` on VPS and your `~/.claude.json`. Regenerate or re-sync. |
| TLS cert failing (`SSL_ERROR_*`) | Let's Encrypt / Traefik didn't issue yet. If the `mcp`/`wa` records sit behind a proxying CDN (e.g. Cloudflare's orange cloud), switch them to DNS-only — Traefik's TLS-ALPN challenge can't pass through the proxy. |
| `wa.example.com` 404 | Traefik label typo or `certresolver` name mismatch with the running Traefik config (should be `myresolver`). |
| ntfy silent | `NTFY_TOPIC_URL` unset on VPS, or topic not subscribed in the ntfy app. Check `docker exec whatsapp-mcp grep ntfy /data/wa-logs.txt`. |
| Container `unhealthy` | Healthcheck hits `http://127.0.0.1:39002/health`. If the QR web server failed to bind (port clash), container flaps. `docker logs whatsapp-mcp`. |
| `send_file` fails with "cannot read local file …" or "ENOENT" | The MCP server runs in a remote container — it can't see your host disk. Use `POST /upload` to publish the file first, then pass the returned URL to `send_file`. See [`tools.md`](./tools.md#sending-host-disk-files-the-upload-endpoint). |
| `POST /upload` returns 401 | `MCP_AUTH_TOKEN` mismatch — same secret as the MCP endpoint. |
| `POST /upload` returns 415 | Bytes didn't match any known magic header. Re-encode the file or check it's not truncated; `sniffMimetype` only recognises JPEG/PNG/GIF/WebP/PDF/MP4/3GP/MOV/M4A/OGG/WAV/MP3. |
| `POST /upload` returns 413 | Body over 16 MB. WABA's hard limit — compress first. |

Send failures (`463`, `479`, silent non-delivery): [`send-guards.md`](./send-guards.md#error-codes).
Host-level issues (TLS, Traefik routes, media bucket): [`deploy/README.md`](../deploy/README.md#troubleshooting).

## Troubleshooting (local stdio)

| Symptom | Fix |
|---------|-----|
| Silent exit code 1, no logs | Native module ABI mismatch — `pnpm install` with the correct Node version in PATH |
| Server starts, Claude Code kills it in ~1-4s | Startup order regression — MCP server must initialize before WA connect in `main.ts` |
| Logs stale / empty in repo dir | Claude Code CWD is usually `~`, so check `~/mcp-logs.txt` and `~/wa-logs.txt` |
| "sonic boom not ready" masks real error | Look at the full log file, not stderr |

After switching Node.js versions, run `pnpm install` again (native `better-sqlite3`) and
re-register the stdio server so Claude Code picks up the new `node` path.
