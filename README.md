# WhatsApp MCP Server

WhatsApp as an MCP server. Runs as a long-lived Docker daemon, accessed over HTTPS with Bearer auth, and pushes [ntfy](https://ntfy.sh) notifications when your session needs attention (QR expired, connection dropped). Built on [Baileys](https://github.com/WhiskeySockets/Baileys) via the `@amiticia/baileys-client` wrapper.

## Who this is for

You want your personal WhatsApp account reachable as a set of tools from **Claude Code, Claude Desktop, Cursor, or any custom MCP/HTTP client** — from any machine — with the WhatsApp connection surviving client restarts, multiple clients sharing one socket, and a push telling you on your phone when you need to re-scan a QR.

## Features

- **HTTP MCP endpoint** (`httpStream` transport) — connect from anywhere, share the session across multiple clients without Baileys fighting for the socket
- **Bearer-token auth** on the MCP endpoint
- **Public QR web page** (protected by paired-number check) — tap the ntfy push and scan directly from your phone browser
- **ntfy push** on: first QR after disconnect, every 2min while still waiting, connection drop, reconnect after drop, and unexpected pairings
- **Bad-pairing protection** — if someone else scans the public QR, the app auto-logs out and purges credentials (`EXPECTED_WA_NUMBER`)
- **17 MCP tools** — search contacts/messages, list chats, send text/media, react, delete, mark read, download media (see table below)
- **Persistent SQLite** (chats/messages/contacts) and Baileys multi-file auth stored in a Docker volume

## Architecture

```
                    https (Bearer)
  MCP clients  ───────────────────▶  Traefik  ──▶  :39001 (FastMCP httpStream)
  (Claude Code, Desktop,                                │
   Cursor, custom agents)                               │
                                                        ▼
                    https (public)                 whatsapp-mcp
  Phone browser ───────────────▶  Traefik  ──▶  :39002 (QR page)
                                                        │
                                                        ▼
                                                    Baileys
                                                        │ WA Web API
                                                        ▼
                                                  WhatsApp servers

                                                   outbound only ▲
                                                        │
                                                       POST
                                                        │
                                                     ntfy.sh
                                                        │ push
                                                        ▼
                                                     Your phone
```

One container exposes two HTTP servers on different ports. Traefik terminates TLS (Let's Encrypt) and routes by hostname.

## Quick start for MCP clients

The canonical deployment exposes:

- `https://mcp.amiticia.cc/mcp` — MCP endpoint, requires `Authorization: Bearer <MCP_AUTH_TOKEN>`
- `https://wa.amiticia.cc/` — QR web page

If you run your own instance, replace hostnames accordingly.

### Claude Code

Edit `~/.claude.json`, in the top-level `mcpServers` object:

```json
"whatsapp": {
  "type": "http",
  "url": "https://mcp.amiticia.cc/mcp",
  "headers": {
    "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
  }
}
```

Export `MCP_AUTH_TOKEN` in your shell (or put the token literally — `~/.claude.json` is `0600`). Restart Claude Code, run `/mcp` — should show `whatsapp: ✓ Connected`.

### Claude Desktop

`~/.config/Claude/claude_desktop_config.json` (Linux) / `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "http",
      "url": "https://mcp.amiticia.cc/mcp",
      "headers": { "Authorization": "Bearer your-token-here" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` — same shape as Claude Desktop above.

### Other clients / custom code

See [`examples/`](./examples/) for a raw HTTPS JSON-RPC transcript (curl), a Python client, and a custom TypeScript agent using `StreamableHTTPClientTransport`.

## MCP tools

The server exposes 17 tools. Full details are in [`CLAUDE.md`](./CLAUDE.md).

| Category | Tools |
|----------|-------|
| Connection / Auth | `get_connection_status`, `logout` |
| Contacts | `search_contacts`, `list_contacts` |
| Messages | `list_messages`, `get_messages_today`, `search_messages`, `get_message_context` |
| Chats | `list_chats`, `get_chat` |
| Groups | `get_group_info` |
| Sending | `send_message`, `send_file` |
| Actions | `react_to_message`, `delete_message`, `mark_chat_read` |
| Media | `download_media` |

## Deployment

Full deploy / update / rotate-secrets / troubleshoot runbook lives in the sibling `systems` repo:

`systems/vps/stacks/whatsapp-mcp/README.md` (branch `non-swarm`).

The image is published privately as `ghcr.io/amiticia-autosys/whatsapp-mcp:latest`. Build recipe (BuildKit, requires sibling `baileys-client/`):

```bash
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=../baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest .
```

## Local development

For development without Docker, keep the default stdio transport:

```bash
pnpm install
pnpm test       # vitest — must stay green before commits (extreme TDD)
pnpm typecheck
pnpm start      # node --experimental-strip-types src/main.ts
```

Requires Node.js `>= 23.10.0` for `--experimental-strip-types` and native `better-sqlite3`.

For local HTTP mode (same as production minus Traefik):

```bash
MCP_TRANSPORT=httpstream MCP_AUTH_TOKEN=dev pnpm start
# then: curl -H 'Authorization: Bearer dev' http://127.0.0.1:39001/mcp ...
```

See [`scripts/smoke-test.sh`](./scripts/smoke-test.sh) for the auth matrix.

## Environment variables

See the full table in [`CLAUDE.md#environment-variables`](./CLAUDE.md). Highlights:

| Variable | Purpose |
|----------|---------|
| `MCP_AUTH_TOKEN` | Bearer token required by the HTTP MCP endpoint (mandatory in production) |
| `NTFY_TOPIC_URL` | Unset = no push notifications; set to enable |
| `EXPECTED_WA_NUMBER` | Prefix allowed to pair; wrong scan → auto-logout + purge (strongly recommended when `wa.amiticia.cc` is public) |
| `WHATSAPP_MCP_DATA_DIR` | Base dir for `auth_info/`, `data/`, and logs (defaults to `.`, Docker uses `/data`) |

## Data storage & privacy

- **Credentials**: `WHATSAPP_MCP_DATA_DIR/auth_info/` (Baileys multi-file auth state)
- **Messages / chats / contacts**: `WHATSAPP_MCP_DATA_DIR/data/whatsapp.db` (SQLite via Drizzle + `better-sqlite3`)
- **Media**: served from a RustFS sidecar on the same VPS, behind Traefik at `https://mcp.amiticia.cc/media/<key>`. The `download_media` tool returns an MCP `resource_link` pointing at that URL (publicly fetchable, no Bearer needed) plus inline `imageContent`/`audioContent` on the first call. Cache hits return the URL only.
- **Logs**: `WHATSAPP_MCP_DATA_DIR/{wa,mcp}-logs.txt` (pino JSON lines)

Everything stays on the VPS (Docker bind mount in production, filesystem in dev). Data leaves the VPS only when an MCP client explicitly invokes a tool.

All data directories are `.gitignore`d. Treat them as sensitive — anyone with `auth_info/` can impersonate your WhatsApp session.

## Credits

- Conceptual origin: [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) (Go + Python).
- Fork history: started from `jlucaso1/whatsapp-mcp-ts`, heavily rewritten for AmiticIA-AutoSys infrastructure.
- Maintained by [AmiticIA-AutoSys](https://github.com/AmiticIA-AutoSys).

## License

ISC — see `package.json`.
