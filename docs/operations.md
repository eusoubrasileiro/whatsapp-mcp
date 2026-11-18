# Operations

The step-by-step runbook for a Docker + Traefik host — first deploy, adding a number, updates,
token rotation, logs, media plane, backups, restore — is
[`deploy/README.md`](../deploy/README.md). This page holds the background and the
troubleshooting tables.

## Building the image

The image needs the sibling `baileys-client` checkout as a BuildKit build context:

```bash
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=../baileys-client \
  -t whatsapp-mcp:latest .
```

Both compose files in `deploy/` reference `ghcr.io/amiticia-autosys/whatsapp-mcp:latest` (the
maintainers' private registry) — tag your build with that name or change `image:`. The same
image runs a WhatsApp number (the default command) and the hub
(`node --experimental-strip-types src/hub/main.ts`).

Smoke test a fresh build:

```bash
docker run --rm -d --name wa-mcp-smoke \
  -p 39001:39001 -p 39002:39002 \
  -v /tmp/wa-mcp-test-data:/data \
  -e MCP_AUTH_TOKEN=test123 \
  whatsapp-mcp:latest
curl -sS http://127.0.0.1:39002/health
curl -sS -o /dev/null -w "%{http_code}\n" -H 'Authorization: Bearer test123' \
  http://127.0.0.1:39001/mcp
```

[`scripts/smoke-test.sh`](../scripts/smoke-test.sh) runs the no-bearer / wrong-bearer /
right-bearer auth matrix.

## Pairing

On first run or after `logout`, the server shows a QR code; scan it from WhatsApp → Settings →
Linked Devices on the phone of **that** number. Credentials persist in `auth_info/`.

- **Production**: open the hub (`https://wa.example.com/`), enter the PIN, and scan the code on
  that number's card. The card names the number (label, description, last 4 digits) so the
  right phone is picked up, and the code refreshes by itself.
- **Locally**: call `get_connection_status` (it saves the code as a PNG and opens it), or open
  `http://127.0.0.1:39002/qr.png`.

A number has no web page of its own: its status port serves `/health`, `/live` and `/qr.png`
(plus the hub's unlink call when `HUB_INSTANCE_SECRET` is set), and in production that port is
not routed publicly. Set `EXPECTED_WA_NUMBER` for every
number — it logs out and purges a pairing made by any other phone. Write it as WhatsApp itself
writes that number, not as you dial it: a value in another form purges a correct pairing
([`deploy/README.md`](../deploy/README.md#add-a-number)).

## The hub

One small program in the same image (`pnpm start:hub`; variables in
[`configuration.md`](./configuration.md#environment-variables-the-hub)). It polls each number's
status port every 2 seconds and shows one card per number: connected, waiting for a scan,
starting, disconnected, down (the hub cannot reach it), or mismatch (the server at that address
reports another label). It never talks to WhatsApp and never holds a number's MCP token.

- **PIN**: everything but the PIN form answers 401 without a session. Five wrong PINs from one
  address lock that address for 15 minutes; twenty from anywhere lock the form for everyone for
  60 minutes and send one ntfy push. The counters are on disk and survive a restart.
- **Connect a client**: each card has a collapsed block with that number's MCP address, an
  `mcpServers` entry and a `claude mcp add` command, each with a copy button. The token is
  written as `<token>`: the hub does not know it.
- **Unlink**: exists only when `HUB_INSTANCE_SECRET` (at least 32 characters) is set to the
  same value on the hub and on the number. It asks for the PIN again and for the label typed
  out, then logs that one number out — the same action as the `logout` tool. A wrong PIN on
  that form counts on the same counters as the sign-in form. Never use it, and never pair,
  while WhatsApp shows a restriction countdown on that phone: see
  [`account-restrictions.md`](./account-restrictions.md).
- **Language**: `HUB_LANG=en` (default) or `pt-BR`.
- **What it shows of a number**: label, description, state, how long it has been down, the
  last 4 digits of the phone number and its public MCP address. Never the full number, a JID
  or a token.
- **Monitoring from outside**: the hub answers every path that no number answers, with the PIN
  form (401). So `GET /<label>/upload` reads 405 while that number is up and 401 when it is
  down; `/<label>/mcp` reads 401 either way and cannot tell them apart
  ([`deploy/README.md`](../deploy/README.md#monitoring)).

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
| `claude mcp list` shows a WhatsApp entry `✗ Failed to connect` | Check `curl -sS -o /dev/null -w '%{http_code}' -X POST https://wa.example.com/<label>/mcp` — `401` means the number is up and routed (then it is the client's token or URL). No answer: DNS or Traefik. The hub's PIN form (HTML) on that path: that number's container is down. See [`deploy/README.md`](../deploy/README.md). |
| An agent used the wrong number | Each number is its own client entry (`whatsapp-<label>`) and its own token. The server instructions name the line, `get_connection_status` returns it, and every send result ends with `Sent from the "<label>" line.` — check which entry the agent called. |
| `HTTP 401` from MCP endpoint | `MCP_AUTH_TOKEN` mismatch between that number's `.env.<label>` on the VPS and your `~/.claude.json` — or the entry carries another number's token. Regenerate or re-sync. |
| TLS cert failing (`SSL_ERROR_*`) | Let's Encrypt / Traefik didn't issue yet. If the record sits behind a proxying CDN (e.g. Cloudflare's orange cloud), switch it to DNS-only — Traefik's TLS-ALPN challenge can't pass through the proxy. |
| `wa.example.com` 404 | The hub is down, a Traefik label typo, or a `certresolver` name mismatch with the running Traefik config (should be `myresolver`). `docker logs whatsapp-mcp-hub`. |
| ntfy silent | `NTFY_TOPIC_URL` unset on VPS, or topic not subscribed in the ntfy app. Check `docker exec whatsapp-mcp-<label> grep ntfy /data/wa-logs.txt`. Pushes carry `[<label>]` at the start of the title. |
| Container `unhealthy` | Healthcheck hits `http://127.0.0.1:39002/live`, which is 200 whenever the process serves HTTP. If the status server failed to bind (port clash), the container flaps. `docker logs whatsapp-mcp-<label>`. A wedged WhatsApp socket does **not** make the container unhealthy — see the next row. |
| A number's URLs fall through to the hub, or `docker ps` shows `unhealthy` | Traefik drops unhealthy containers, and plain Docker never restarts them, so a probe that fails on a wedged socket takes the public URLs down (63 h on 2026-11-13). Make sure the image and `deploy/docker-compose.instance.yaml` probe `/live`, not `/health`. The self-heal is the in-process watchdog: after `WATCHDOG_RESTART_AFTER_S` (default 600 s) of the socket being down it pushes a priority-5 ntfy and exits so `restart: unless-stopped` restarts the container, at most `WATCHDOG_MAX_RESTARTS` (default 3) times per 6 h (state in `/data/watchdog-state.json`). Past the cap it only pushes "precisa de você" every 30 min — fix by hand: `docker restart whatsapp-mcp-<label>` (saved credentials reconnect in ~60 s, no QR). Never self-restarts while a QR scan is pending. To switch it off: `WATCHDOG_RESTART_AFTER_S=0` in that number's `deploy/.env.<label>`, then `docker compose --env-file .env.<label> up -d`. Whether an alert went out: `docker exec whatsapp-mcp-<label> grep -iE 'ntfy push sent|watchdog' /data/wa-logs.txt`. |
| `send_file` fails with "cannot read local file …" or "ENOENT" | The MCP server runs in a remote container — it can't see your host disk. Use `POST /upload` to publish the file first, then pass the returned URL to `send_file`. See [`tools.md`](./tools.md#sending-host-disk-files-the-upload-endpoint). |
| `POST /upload` returns 401 | `MCP_AUTH_TOKEN` mismatch — same secret as that number's MCP endpoint. Uploading to `/<label>/upload` with another number's token is refused. |
| `POST /upload` returns 415 | Bytes didn't match any known magic header. Re-encode the file or check it's not truncated; `sniffMimetype` only recognises JPEG/PNG/GIF/WebP/PDF/MP4/3GP/MOV/M4A/OGG/WAV/MP3. |
| `POST /upload` returns 413 | Body over 16 MB. WABA's hard limit — compress first. |
| A media link answers 404 under one label and 200 under another | Each number has its own store: `/<label>/media/…` reaches only the store of `<label>`. Use the link exactly as the tool returned it. |

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
