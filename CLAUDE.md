# WhatsApp MCP Server

MCP server for WhatsApp integration using Baileys, enabling Claude/Cursor to interact with WhatsApp messages and contacts.

## Quick Start

```bash
npm install
npm start
```

First run opens a QR code in browser - scan with WhatsApp mobile (Settings > Linked Devices).

## Requirements

- Node.js >= 23.10.0 (uses `--experimental-strip-types`)

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run TypeScript directly with Node |
| `npm run typecheck` | Type check with tsc |
| `npm test` | Run tests with vitest |

## Architecture

```
src/
├── main.ts        # Entry point, logging setup, graceful shutdown
├── mcp.ts         # MCP server, tool definitions (16 tools)
├── whatsapp.ts    # Baileys integration, message sync, p-retry reconnection
├── database.ts    # Drizzle ORM + better-sqlite3 (chats, messages, contacts)
└── db/
    └── schema.ts  # Drizzle table schemas
```

## MCP Tools (16 total)

### Connection / Auth
| Tool | Description |
|------|-------------|
| `get_connection_status` | Check WhatsApp connection, get QR code if pending |
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

## Authentication

On first run or after logout, call `get_connection_status` to get a QR code URL.
Scan the QR code with WhatsApp mobile (Settings > Linked Devices).
Auth credentials are saved in `auth_info/` for subsequent runs.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_MCP_DATA_DIR` | `.` | Directory for database and logs |
| `LOG_LEVEL` | `info` | Pino log level |

## Data Storage

- `auth_info/` - WhatsApp authentication (Baileys multi-file auth state)
- `data/whatsapp.db` - SQLite database (chats, messages, contacts)
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
- Node.js >= 22.6.0 (for `--experimental-strip-types`) or >= 23.10.0 (recommended)
- WhatsApp MCP installed: `npm install`
- First authentication completed: `npm start` (scan QR code)

### Install MCP Server

**IMPORTANT:** You must include `--experimental-strip-types` flag for Node.js to execute TypeScript directly.

```bash
# Get your Node.js path (must be v22.6+)
NODE_PATH=$(which node)

# Add to Claude Code (user scope - works in all projects)
claude mcp add --scope user whatsapp -- $NODE_PATH --experimental-strip-types /ABSOLUTE/PATH/TO/whatsapp-mcp/src/main.ts

# Example with full paths:
claude mcp add --scope user whatsapp -- /home/you/.nvm/versions/node/v22.14.0/bin/node --experimental-strip-types /path/to/whatsapp-mcp/src/main.ts
```

### Verify Installation

```bash
claude mcp list
# Should show: whatsapp: ... - ✓ Connected
```

### Troubleshooting

**"Failed to connect" error:**
- Ensure `--experimental-strip-types` flag is included
- Verify Node.js version is >= 22.6.0: `node -v`
- Check logs: `tail -f /path/to/whatsapp-mcp/mcp-logs.txt`

**Tools not available after restart:**
- The config persists, but the server may fail to start
- Run `claude mcp list` to check connection status
- If showing `✗ Failed to connect`, re-add with correct command above

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

- Uses official `@whiskeysockets/baileys` package only
- Auth credentials stored locally, never transmitted
- All message data stays local in SQLite (better-sqlite3 + Drizzle ORM)
- Data only sent to LLM when explicitly requested via MCP tools
