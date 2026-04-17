# WhatsApp MCP Server

MCP server for WhatsApp integration using Baileys, enabling Claude/Cursor to interact with WhatsApp messages and contacts.

## Quick Start

```bash
pnpm install
pnpm start
```

First run opens a QR code in browser - scan with WhatsApp mobile (Settings > Linked Devices).

## Requirements

- Node.js >= 23.10.0 (uses `--experimental-strip-types`)

## Claude Code MCP Setup & Troubleshooting

> **Read this first.** These lessons were learned the hard way through painful debugging sessions. Every item below has caused silent failures that waste hours.

### 1. Correct Setup Procedure

```bash
# Step 1: Ensure Node.js >= 23.10.0 (NOT 22.x — native modules like better-sqlite3 won't work)
node -v  # must show v23.10.0 or higher

# Step 2: Install dependencies with the SAME Node version you'll use in claude mcp add
pnpm install

# Step 3: First-run authentication (scan QR code with WhatsApp mobile)
pnpm start

# Step 4: Register with Claude Code
claude mcp add --scope user whatsapp -- /home/you/.nvm/versions/node/v23.11.1/bin/node --experimental-strip-types /path/to/whatsapp-mcp/src/main.ts

# Step 5: Verify
claude mcp list          # should show: whatsapp: ... ✓ Connected
# Then inside Claude Code, type /mcp to confirm tools are available
```

### 2. Critical Architecture Constraint — Startup Order

The MCP stdio server **MUST** start before the WhatsApp connection. `src/main.ts` starts MCP first, then launches WhatsApp connection in the background — **DO NOT reverse this order**.

**Why:** Claude Code sends the MCP `initialize` message immediately after spawning the process. If WhatsApp's Baileys connection blocks startup, the MCP handshake times out and Claude Code kills the process.

### 3. Troubleshooting "Failed to connect"

| Problem | Symptoms | Fix |
|---------|----------|-----|
| Native module ABI mismatch | Silent exit code 1, no logs written | Run `pnpm install` with the correct Node version in PATH |
| Wrong Node version in MCP config | Same as above | `claude mcp remove --scope user whatsapp` then re-add with Node 23 path |
| Startup order reversed | Server starts but Claude Code kills it in ~1–4s | MCP server must initialize before WA connect in `main.ts` |
| WhatsApp 401 loggedOut | WA logs show "loggedOut", tools fail after connect | Delete `auth_info/*`, restart, re-scan QR via `get_connection_status` |
| Logs not where expected | Project dir logs are stale / empty | Claude Code CWD = `~`, so check `~/mcp-logs.txt` and `~/wa-logs.txt` |

### 4. Debugging Silent Crashes

- **Pino logs to files, NOT stderr** — errors are invisible by default in Claude Code's stdio transport
- To debug: run the server manually with `node --trace-exit --experimental-strip-types src/main.ts`
- Test MCP stdin handling: pipe `< /dev/null` to simulate Claude Code's closed stdin
- The `process.exit(1)` in catch handlers can trigger pino's "sonic boom not ready" warning which **masks the real error** — look at the full log file, not just stderr

### 5. After Switching Node.js Versions Checklist

```bash
# EVERY TIME you change Node versions, run ALL of these:
export PATH="/home/you/.nvm/versions/node/v23.11.1/bin:$PATH"

# 1. Rebuild native modules (better-sqlite3 etc.)
pnpm install

# 2. Remove old MCP config (it has the old Node path baked in)
claude mcp remove --scope user whatsapp

# 3. Re-add with new Node path
claude mcp add --scope user whatsapp -- /home/you/.nvm/versions/node/v23.11.1/bin/node --experimental-strip-types /path/to/whatsapp-mcp/src/main.ts

# 4. Verify
claude mcp list
```

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
- `wa-logs.txt` - WhatsApp/Baileys logs
- `mcp-logs.txt` - MCP server logs

All data directories are gitignored for security.

## Deploy (Docker + Traefik on VPS)

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
