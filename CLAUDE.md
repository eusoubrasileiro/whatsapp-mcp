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
| `WHATSAPP_MCP_DATA_DIR` | `.` | Directory for database and logs |
| `LOG_LEVEL` | `info` | Pino log level |

## Data Storage

- `auth_info/` - WhatsApp authentication (Baileys multi-file auth state)
- `data/whatsapp.db` - SQLite database (chats, messages, contacts)
- `data/media/` - Downloaded media files (organized by chat JID)
- `wa-logs.txt` - WhatsApp/Baileys logs
- `mcp-logs.txt` - MCP server logs

All data directories are gitignored for security.

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
