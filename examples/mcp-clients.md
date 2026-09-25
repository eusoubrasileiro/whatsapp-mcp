# MCP client configs

Copy-pasteable snippets for every tested client. Replace `https://mcp.example.com/mcp` with your deployment's endpoint and `<your-token>` with your `MCP_AUTH_TOKEN`.

## Claude Code

File: `~/.claude.json`. Add under the top-level `mcpServers` object (or edit the existing `whatsapp` entry):

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

`${VAR}` is expanded from your shell env by Claude Code. If you prefer the literal token, paste it — `~/.claude.json` is `0600` by default.

Verify:

```bash
claude mcp list     # whatsapp: ✓ Connected
# inside a session:
/mcp                # should list the 23 whatsapp tools
```

## Claude Desktop

File:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Cursor

File: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Restart Cursor. Tools show up in the Composer sidebar.

## Custom TypeScript agent (`@modelcontextprotocol/sdk`)

Minimal client using the StreamableHTTP transport. Works for anything driving the MCP protocol by hand — your own LangChain/LangGraph nodes, an Express endpoint that proxies tools, a CLI.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.MCP_AUTH_TOKEN;
if (!token) throw new Error("MCP_AUTH_TOKEN is required");

const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.example.com/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  },
);

const client = new Client({ name: "my-agent", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("available tools:", tools.tools.map((t) => t.name));

const result = await client.callTool({
  name: "list_chats",
  arguments: { limit: 5 },
});
console.log(result);

await client.close();
```

Install:

```bash
pnpm add @modelcontextprotocol/sdk
```

Run with `node --experimental-strip-types` if you keep it as `.ts`, or compile.

## Raw HTTP (no MCP SDK)

See `README.md` in this directory for curl/Python examples if your runtime doesn't have an MCP SDK.

## `download_media` response shape

`download_media` returns multiple content blocks. The order and presence depends on whether this is a first download or a cache hit:

```jsonc
{
  "content": [
    // (first call only, if image and < MEDIA_INLINE_MAX_BYTES) inline base64 image
    { "type": "image", "data": "<base64>", "mimeType": "image/jpeg" },
    // always present — public URL to the stored object
    {
      "type": "resource_link",
      "uri": "https://mcp.example.com/media/t/default/5511999999999@s.whatsapp.net/3EB0C1A....jpg",
      "name": "3EB0C1A....jpg",
      "mimeType": "image/jpeg"
    },
    // always present — JSON metadata
    { "type": "text", "text": "{ \"status\": \"uploaded\" | \"cached\", \"url\": \"…\", \"media_type\": \"image\", \"mimetype\": \"image/jpeg\", \"file_size\": 123456 }" }
  ]
}
```

Notes for integrators:

- The `resource_link.uri` is **public** — no `Authorization` header needed when fetching it.
- The host is the same as the MCP endpoint (`mcp.example.com`), routed by path (`/media/*`) to an S3-compatible bucket (a RustFS sidecar in the production compose). Same TLS cert, no extra DNS.
- Audio messages get `{ "type": "audio", … }` instead of `image` on first call.
- For files larger than `MEDIA_INLINE_MAX_BYTES` (default 5 MiB), no inline block is returned — fetch via `resource_link.uri`.
- Subsequent calls for the same `(message_id, chat_jid)` skip Baileys and return only the `resource_link` + JSON metadata (`status: "cached"`).
