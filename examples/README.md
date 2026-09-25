# Integration examples

Talking to a deployed `whatsapp-mcp` from different runtimes. Replace `mcp.example.com` with your own host. The endpoint is:

```
https://mcp.example.com/mcp
Authorization: Bearer <MCP_AUTH_TOKEN>
Content-Type:  application/json
Accept:        application/json, text/event-stream
```

## Files

| File | When to use |
|------|-------------|
| [`mcp-clients.md`](./mcp-clients.md) | MCP-aware clients: Claude Code, Claude Desktop, Cursor, custom TS agents with `@modelcontextprotocol/sdk` |
| [`python-client.py`](./python-client.py) | Calling tools from plain Python (n8n glue code, scripts, non-LLM automation) via raw HTTPS JSON-RPC |
| This README (below) | Raw `curl` transcript to understand the wire protocol |

## Raw HTTPS JSON-RPC with curl

The MCP `httpStream` transport is JSON-RPC 2.0 over HTTP with an SSE-style `Accept` header. You can drive it without any MCP SDK — useful for shell scripts, n8n HTTP nodes, Zapier Code steps, Postman, etc.

### 1. Initialize a session

```bash
export TOKEN="<your-MCP_AUTH_TOKEN>"

curl -sS -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0" }
    }
  }'
```

Expected: HTTP 200 with a JSON-RPC result and a `Mcp-Session-Id` header. Capture that session id — every subsequent call must echo it back.

### 2. List tools

```bash
curl -sS -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: <from-initialize>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'
```

### 3. Call a tool

```bash
curl -sS -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: <from-initialize>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_chats",
      "arguments": { "limit": 5 }
    }
  }'
```

### 4. Smoke-test auth matrix

See [`../scripts/smoke-test.sh`](../scripts/smoke-test.sh) — runs the no-bearer / wrong-bearer / right-bearer triad against a local container.

## Notes

- **Errors**: the send tools (`send_message`, `send_file`) return a text confirmation (`… sent successfully … (ID: …)`) on success and fail with an MCP tool error (`isError: true`) otherwise — unknown recipient, server rejection, or a local policy refusal. Check `isError` in your glue code, and never auto-retry a refused send (the error text says `DO NOT RETRY` when it matters).
- **Rate limiting**: sends are paced account-wide and first-contact sends are refused by default — see [`../docs/account-restrictions.md`](../docs/account-restrictions.md). This is not a bulk sender.
- **Session lifetime**: the session id from `initialize` is kept server-side. Drop it after ~5 min of inactivity and re-initialize.
- **Streaming**: tool responses come back as a single JSON body for most tools. A few (search, list_messages with large pages) may stream — honour `text/event-stream` framing if you see `data:` prefixes.
