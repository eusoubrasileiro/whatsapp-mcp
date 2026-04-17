# WhatsApp MCP Server

WhatsApp as an MCP server. Canonical deployment is a long-lived Docker daemon on the VPS, exposed as `https://mcp.amiticia.cc/mcp` (Bearer auth) with a public QR page at `https://wa.amiticia.cc/`. Built on `@amiticia/baileys-client`.

User-facing overview lives in [`README.md`](./README.md). This file is the internal contributor / operator reference.

## Requirements

- Node.js `>= 23.10.0` (uses `--experimental-strip-types` and bundled `node:sqlite`)
- pnpm (strict workspace, managed via `corepack`)
- Docker + BuildKit for image builds

## Claude Code MCP Setup

> The canonical path is **HTTP-to-remote**. Do NOT reintroduce stdio via `claude mcp add` — it overwrites the working HTTP config.

### Canonical setup (HTTP, connects to the deployed service)

Edit `~/.claude.json`. Inside the top-level `mcpServers` object:

```json
"whatsapp": {
  "type": "http",
  "url": "https://mcp.amiticia.cc/mcp",
  "headers": {
    "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
  }
}
```

Claude Code expands `${MCP_AUTH_TOKEN}` from your shell env. If you don't want env expansion, paste the literal token — `~/.claude.json` is `0600`.

Verify:

```bash
claude mcp list          # whatsapp: ✓ Connected
# In a session:
/mcp                     # expects the 17 whatsapp tools listed
```

The same JSON shape works for Claude Desktop (`~/.config/Claude/claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`). See `examples/mcp-clients.md` for all three.

### Stdio fallback (local dev only)

Useful when iterating on source without rebuilding the Docker image. The MCP stdio server must start before the WhatsApp connection — `src/main.ts` already enforces that order (MCP handshake completes first, Baileys connects in the background). Do not reverse it, or Claude Code kills the process during handshake timeout.

```bash
pnpm install
pnpm start               # MCP_TRANSPORT defaults to stdio
```

Register with Claude Code only if you want to hit local dev instead of the deployed instance:

```bash
claude mcp remove --scope user whatsapp    # remove HTTP entry first
claude mcp add --scope user whatsapp -- \
  $(which node) --experimental-strip-types \
  $(pwd)/src/main.ts
```

Remember to swap back to the HTTP entry afterwards.

### Troubleshooting (HTTP path)

| Symptom | Fix |
|---------|-----|
| `claude mcp list` shows whatsapp `✗ Failed to connect` | Check `curl -sS -o /dev/null -w '%{http_code}' https://mcp.amiticia.cc/health` — if not reachable, DNS or Traefik issue. See `systems/vps/stacks/whatsapp-mcp/README.md`. |
| `HTTP 401` from MCP endpoint | `MCP_AUTH_TOKEN` mismatch between `.env` on VPS and your `~/.claude.json`. Regenerate or re-sync. |
| TLS cert failing (`SSL_ERROR_*`) | Let's Encrypt / Traefik didn't issue yet. Check CF DNS proxy is **off** (grey cloud) for `mcp`/`wa` records. |
| `wa.amiticia.cc` 404 | Traefik label typo or `certresolver` name mismatch with the running Traefik config (should be `myresolver`). |
| ntfy silent | `NTFY_TOPIC_URL` unset on VPS, or topic not subscribed in the ntfy app. Check `docker exec whatsapp-mcp grep ntfy /data/wa-logs.txt`. |
| Container `unhealthy` | Healthcheck hits `http://127.0.0.1:39002/health`. If the QR web server failed to bind (port clash), container flaps. `docker logs whatsapp-mcp`. |

### Troubleshooting (stdio fallback only)

| Symptom | Fix |
|---------|-----|
| Silent exit code 1, no logs | Native module ABI mismatch — `pnpm install` with the correct Node version in PATH |
| Server starts, Claude Code kills it in ~1-4s | Startup order regression — MCP server must initialize before WA connect in `main.ts` |
| Logs stale / empty in repo dir | Claude Code CWD is usually `~`, so check `~/mcp-logs.txt` and `~/wa-logs.txt` |
| "sonic boom not ready" masks real error | Look at the full log file, not stderr |

### After switching Node.js versions (stdio only)

```bash
pnpm install                             # rebuild native modules
claude mcp remove --scope user whatsapp  # nuke old Node path
claude mcp add --scope user whatsapp -- \
  $(which node) --experimental-strip-types $(pwd)/src/main.ts
claude mcp list
```

Not needed for the HTTP path — the container pins its own Node.

---

## Development Practices

### Extreme TDD — non-negotiable

Every change ships only after a failing test was written first. **No exceptions.** Follow the strict Red → Green → Refactor cycle:

1. **Red** — Write a failing test that describes the expected behavior.
2. **Green** — Write the minimal code that makes the test pass.
3. **Refactor** — Clean up while tests stay green.

This rule applies to **all** of the following — not just new features:

- New features and tool additions
- Bug fixes and regressions (reproduce the bug as a failing test first)
- Refactors (the existing tests become the safety net; if coverage is thin, add tests *before* refactoring)
- Configuration changes with observable behavior (tsconfig flags, vitest options, MCP registration, pino transports)
- **Dependency updates — both minor and major.** Before bumping any package version, a contract test must pin the consumed API surface (e.g. zod schema parsing, fastmcp tool registration, pino log-line shape, p-retry option shape). The test must pass on the current version and catch breakage on the new one.

If a change has no observable behavior and genuinely cannot be tested (pure formatting or comment edits), document the reason in the commit message. This escape hatch is for cosmetics only — never for code, config, or dependency changes.

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm start` | Run TypeScript directly with Node |
| `pnpm typecheck` | Type check with tsc |
| `pnpm test` | Run tests with vitest |

## Architecture

```
src/
├── main.ts        # Entry point, logging setup, graceful shutdown
├── mcp.ts         # MCP server, tool definitions (17 tools)
├── whatsapp.ts    # Adapter layer over @amiticia/baileys-client + media download
├── database.ts    # Drizzle ORM + better-sqlite3 (chats, messages, contacts)
└── db/
    └── schema.ts  # Drizzle table schemas
```

**Key dependency:** `@amiticia/baileys-client` handles Baileys connection, message parsing, QR code generation, and reconnection logic. This package keeps only a thin adapter layer in `whatsapp.ts` that bridges baileys-client events to database operations.

## MCP Tools (17 total)

### Connection / Auth
| Tool | Description |
|------|-------------|
| `get_connection_status` | Check WhatsApp connection; saves QR as PNG and auto-opens it if pending |
| `logout` | Log out from WhatsApp and clear session data |

### Contacts
| Tool | Description |
|------|-------------|
| `search_contacts` | Search contacts by name or phone number |
| `list_contacts` | List all contacts with optional filter |

### Messages
| Tool | Description |
|------|-------------|
| `list_messages` | Get message history with pagination and date filtering |
| `get_messages_today` | Convenience tool for today's messages |
| `search_messages` | Full-text search with optional date filtering |
| `get_message_context` | Get messages before/after a target message |

### Chats
| Tool | Description |
|------|-------------|
| `list_chats` | List chats with filtering/sorting |
| `get_chat` | Get detailed chat information |

### Groups
| Tool | Description |
|------|-------------|
| `get_group_info` | Get group metadata (participants, admins, etc.) |

### Sending
| Tool | Description |
|------|-------------|
| `send_message` | Send text message to contact or group |
| `send_file` | Send image/video/document/audio file |

### Message Actions
| Tool | Description |
|------|-------------|
| `react_to_message` | React to a message with emoji |
| `delete_message` | Delete/revoke a message you sent |
| `mark_chat_read` | Mark all messages in chat as read |

### Media
| Tool | Description |
|------|-------------|
| `download_media` | Download media (image/video/audio/document/sticker) from a message to local disk |

## Authentication

On first run or after logout, call `get_connection_status`. A QR code PNG will be saved to `/tmp/whatsapp-mcp-qr.png` and opened automatically in your default image viewer. Scan with WhatsApp mobile (Settings > Linked Devices).
Auth credentials are saved in `auth_info/` for subsequent runs.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_MCP_DATA_DIR` | `.` | Base directory for `auth_info/`, `data/`, and pino log files |
| `LOG_LEVEL` | `info` | Pino log level |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `httpstream` |
| `MCP_HOST` | `127.0.0.1` | Bind host when `MCP_TRANSPORT=httpstream` |
| `MCP_PORT` | `3001` | Bind port when `MCP_TRANSPORT=httpstream` |
| `MCP_ENDPOINT` | `/mcp` | HTTP path for MCP when `MCP_TRANSPORT=httpstream` |
| `MCP_AUTH_TOKEN` | _(unset)_ | If set, HTTP MCP requires `Authorization: Bearer <token>`. If unset, endpoint accepts unauthenticated requests (stdio/local dev only — never run like this in prod). |
| `QR_SERVER_HOST` | `127.0.0.1` | Bind host for the public QR web page |
| `QR_SERVER_PORT` | `39002` | Bind port for the QR web page |
| `PUBLIC_QR_URL` | `https://wa.amiticia.cc/` | URL sent in ntfy `Click` header so tapping the push opens the QR page |
| `NTFY_TOPIC_URL` | _(unset)_ | ntfy.sh topic URL; unset = notifications disabled |
| `NTFY_TOKEN` | _(unset)_ | Bearer token for protected ntfy topics |
| `EXPECTED_WA_NUMBER` | _(unset)_ | If set, only pairings whose JID starts with this prefix are accepted. A mismatch triggers `socket.logout()`, purges `auth_info/`, and fires an ntfy alert. Critical when the QR page is publicly reachable. |

## Data Storage

Paths are relative to `WHATSAPP_MCP_DATA_DIR` (defaults to `.` when running via `pnpm start`, `/data` in the Docker image):

- `auth_info/` - WhatsApp authentication (Baileys multi-file auth state)
- `data/whatsapp.db` - SQLite database (chats, messages, contacts)
- `data/media/` - Downloaded media files (organized by chat JID)
- `backups/hourly/whatsapp.db` - Rolling hourly snapshot (overwritten, WAL-safe)
- `backups/daily/whatsapp-YYYY-MM-DD.db` - Per-day snapshots (14-day retention)
- `backups/daily/auth_info-YYYY-MM-DD.tar.gz` - Per-day auth tarball
- `wa-logs.txt` - WhatsApp/Baileys logs
- `mcp-logs.txt` - MCP server logs

All data directories are gitignored for security.

## Backup & Restore

The DB and auth state live on the `/data` volume (bind mount on the VPS). Hourly snapshots are written by `scripts/backup.sh`, which ships inside the image.

**Why a script and not just `cp whatsapp.db`:** SQLite runs in WAL mode here (see `src/database.ts` — `journal_mode = WAL`). Copying the `.db` file while the container is writing captures an inconsistent snapshot (WAL pages are still pending). `sqlite3 .backup` is the supported online-backup API and is WAL-safe.

### Snapshot from host (cron)

```
0 * * * * docker exec whatsapp-mcp /app/whatsapp-mcp/scripts/backup.sh >> /var/log/whatsapp-mcp-backup.log 2>&1
```

Produces `backups/hourly/whatsapp.db` every run and promotes to `backups/daily/whatsapp-$(date).db` + `auth_info-$(date).tar.gz` once per day. Retention: 48h hourly, 14d daily — tune with `find` flags in `scripts/backup.sh` if needed.

### Restore (overwrite)

Container MUST be stopped (the live writer holds the WAL lock). Use when you want the incoming DB to replace whatever is there:

```
docker compose stop whatsapp-mcp
# DB only (most common — keeps the already-paired linked device):
./scripts/restore.sh /path/to/source.db
# DB + auth (full disaster recovery, displaces the current linked device):
./scripts/restore.sh /path/to/source.db /path/to/auth_info.tar.gz
docker compose start whatsapp-mcp
```

On the VPS, either set `WHATSAPP_MCP_DATA_DIR=/storage/whatsapp-mcp` before calling `restore.sh` on the host, or use a helper container:

```
docker run --rm -v /storage/whatsapp-mcp:/data \
  -v $(pwd)/scripts:/scripts alpine sh /scripts/restore.sh /data/incoming.db
```

### Merge (import history into a live DB)

Use when you want to fold an external DB's rows into the current one without losing what's already there — e.g. importing a long-lived local bridge's history onto a fresh VPS. Runs `scripts/merge-db.sh`.

Policy:
- `messages` — `INSERT OR IGNORE` on `(id, chat_jid)`. Target row wins on collision.
- `chats` — UPSERT, keeps the newest `last_message_time`, preserves target's `name` if set.
- `contacts` — UPSERT, target wins, source fills NULLs.
- `media_local_path` — translated from any host path containing `/media/X` into the container-local `/data/data/media/X`, so you can rsync the source media tree under `/storage/<stack>/data/media/` and `download_media` resolves cleanly.

Full procedure (local bridge → VPS):

```
# 1. on the local machine — bridge can stay running, .backup is WAL-safe
sqlite3 /home/you/.../whatsapp-mcp/data/whatsapp.db ".backup /tmp/old-wa.db"
tar czf /tmp/old-wa-media.tar.gz -C /home/you/.../whatsapp-mcp/data media
scp /tmp/old-wa.db /tmp/old-wa-media.tar.gz <vps>:/tmp/

# 2. on the VPS
ssh <vps>
cd /root/systems/vps/stacks/whatsapp-mcp
# extract media first (tar -k keeps existing files on conflict):
tar xzkf /tmp/old-wa-media.tar.gz -C /storage/whatsapp-mcp/data/
docker compose stop
docker run --rm \
  -v /storage/whatsapp-mcp:/data \
  -v /tmp:/src \
  -v /root/whatsapp-mcp/scripts:/scripts \
  --entrypoint sh \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /scripts/merge-db.sh /src/old-wa.db
docker compose start
# verify with list_messages
```

`merge-db.sh` is idempotent — re-running it is safe (INSERT OR IGNORE + UPSERT). If the first run failed mid-transaction, just re-run.

### Offsite

Backups are on the host side of the bind mount (`/storage/whatsapp-mcp/backups/` on the VPS). Point Borg at that directory using the operator reference in `your backup notes`. **Not automated in the stack today** — run Borg manually or add a separate host cron.

## Deploy (Docker + Traefik on VPS)

Full deploy / update / rotate-secrets / troubleshoot runbook: [`systems/vps/stacks/whatsapp-mcp/README.md`](../systems/vps/stacks/whatsapp-mcp/README.md) (branch `non-swarm`).

Production stack lives in the sibling `systems` repo at:
`systems/vps/stacks/whatsapp-mcp/docker-compose.yaml`

Image is published privately as `ghcr.io/amiticia-autosys/whatsapp-mcp:latest`.

Build locally (BuildKit required — sibling `baileys-client/` must be present):

```bash
cd whatsapp-mcp
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=../baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest .
```

Smoke test:

```bash
docker run --rm -d --name wa-mcp-smoke \
  -p 39001:39001 -p 39002:39002 \
  -v /tmp/wa-mcp-test-data:/data \
  -e MCP_AUTH_TOKEN=teste123 \
  -e PUBLIC_QR_URL=http://localhost:39002/ \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest
curl -sS http://127.0.0.1:39002/health
curl -sS -o /dev/null -w "%{http_code}\n" -H 'Authorization: Bearer teste123' \
  http://127.0.0.1:39001/mcp
```

Publish (private GHCR):

```bash
gh auth refresh -s write:packages,read:packages
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
docker push ghcr.io/amiticia-autosys/whatsapp-mcp:latest
```

Routes after deploy:
- `https://wa.amiticia.cc/` — public QR page (safe because `EXPECTED_WA_NUMBER` check rejects wrong-phone pairings).
- `https://mcp.amiticia.cc/mcp` — MCP endpoint, requires `Authorization: Bearer $MCP_AUTH_TOKEN`.

## MCP Client Configuration

### Claude Desktop (macOS)
`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp/dist/main.js"]
    }
  }
}
```

### Claude Desktop (Linux)
`~/.config/claude/claude_desktop_config.json`

### Cursor
`~/.cursor/mcp.json`

## Claude Code Installation

### Prerequisites
- Node.js >= 23.10.0 (required — native modules like better-sqlite3 fail on 22.x)
- WhatsApp MCP installed: `pnpm install`
- First authentication completed: `pnpm start` (scan QR code)

### Install MCP Server

**IMPORTANT:** You must include `--experimental-strip-types` flag for Node.js to execute TypeScript directly.

```bash
# Get your Node.js path (must be v23.10.0+)
NODE_PATH=$(which node)

# Add to Claude Code (user scope - works in all projects)
claude mcp add --scope user whatsapp -- $NODE_PATH --experimental-strip-types /ABSOLUTE/PATH/TO/whatsapp-mcp/src/main.ts

# Example with full paths:
claude mcp add --scope user whatsapp -- /home/you/.nvm/versions/node/v23.11.1/bin/node --experimental-strip-types /path/to/whatsapp-mcp/src/main.ts
```

### Verify Installation

```bash
claude mcp list
# Should show: whatsapp: ... - ✓ Connected
```

### Troubleshooting

See the comprehensive **"Claude Code MCP Setup & Troubleshooting"** section at the top of this file.

## Database Schema

```sql
-- Chats
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);

-- Messages
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  media_type TEXT,        -- 'image'|'video'|'audio'|'ptt'|'document'|'sticker'
  mimetype TEXT,          -- e.g. 'image/jpeg'
  media_key TEXT,         -- base64 encryption key
  direct_path TEXT,       -- WhatsApp CDN path
  media_url TEXT,         -- full CDN URL (may expire)
  file_length INTEGER,    -- file size in bytes
  file_sha256 TEXT,       -- base64 hash
  file_enc_sha256 TEXT,   -- base64 encrypted hash
  media_local_path TEXT,  -- local path after download
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);

-- Contacts
CREATE TABLE contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT,
  phone_number TEXT
);
```

## References

This project builds on the WhatsApp MCP ecosystem. For additional implementation ideas and features, see:
- [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) - Excellent reference implementation with additional features

## Security Notes

- Uses `@amiticia/baileys-client` (wrapping `@whiskeysockets/baileys`)
- Auth credentials stored locally, never transmitted
- All message data stays local in SQLite (better-sqlite3 + Drizzle ORM)
- Data only sent to LLM when explicitly requested via MCP tools
