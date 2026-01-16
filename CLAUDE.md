# WhatsApp MCP Server

MCP server for WhatsApp integration using Baileys, enabling Claude/Cursor to interact with WhatsApp messages and contacts.

## Quick Start

```bash
npm install
npm start
```

First run opens a QR code in browser - scan with WhatsApp mobile (Settings > Linked Devices).

## Requirements

- Node.js >= 23.10.0 (uses native `node:sqlite` and `--experimental-strip-types`)

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run TypeScript directly with Node |
| `npm run typecheck` | Type check with tsc |

## Architecture

```
src/
├── main.ts      # Entry point, logging setup, graceful shutdown
├── mcp.ts       # MCP server, tool definitions (7 tools)
├── whatsapp.ts  # Baileys integration, message sync
└── database.ts  # SQLite layer (chats, messages, contacts)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_contacts` | Find contacts by name or JID |
| `list_messages` | Get paginated message history for a chat |
| `list_chats` | List all chats with filtering/sorting |
| `get_chat` | Get single chat details |
| `get_message_context` | Get messages around a target message |
| `send_message` | Send text message to recipient |
| `search_messages` | Full-text search across messages |

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

## Security Notes

- Uses official `@whiskeysockets/baileys` package only
- Auth credentials stored locally, never transmitted
- All message data stays local in SQLite
- Data only sent to LLM when explicitly requested via MCP tools
