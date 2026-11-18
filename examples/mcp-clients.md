# MCP client configs

Copy-pasteable snippets for every tested client. A deployment serves each WhatsApp number at its own address, `https://<host>/<label>/mcp`, with its own token. The examples use the host `wa.example.com` and a number labelled `personal`: replace `https://wa.example.com/personal/mcp` with your number's endpoint and `<your-token>` with that number's `MCP_AUTH_TOKEN`. The deployment's hub page (`https://<host>/`, behind its PIN) shows the exact address and a ready entry for every number.

**One entry per number, named after it** (`whatsapp-<label>`). The entry name is what an agent sees next to every tool, so `whatsapp-personal` and `whatsapp-work` keep it from sending on the wrong line. The server also says which line it is: in its instructions, in `get_connection_status`, and at the end of every send result.

## Claude Code

File: `~/.claude.json`. Add under the top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "type": "http",
      "url": "https://wa.example.com/personal/mcp",
      "headers": {
        "Authorization": "Bearer ${WHATSAPP_PERSONAL_TOKEN}"
      }
    },
    "whatsapp-work": {
      "type": "http",
      "url": "https://wa.example.com/work/mcp",
      "headers": {
        "Authorization": "Bearer ${WHATSAPP_WORK_TOKEN}"
      }
    }
  }
}
```

`${VAR}` is expanded from your shell env by Claude Code. If you prefer the literal token, paste it — `~/.claude.json` is `0600` by default. Each number has its own token; one number's token is refused by the other.

Or from a terminal, one command per number (the form the hub page shows; add `--scope user` to
register it for every project instead of the current one):

```bash
claude mcp add --transport http whatsapp-personal https://wa.example.com/personal/mcp \
  --header "Authorization: Bearer <your-token>"
```

Verify:

```bash
claude mcp list     # whatsapp-personal: ✓ Connected, whatsapp-work: ✓ Connected
# inside a session:
/mcp                # each entry lists the 23 whatsapp tools
```

Permission rules name the entry: tools appear as `mcp__whatsapp-personal__send_message`, so an allowlist written for `mcp__whatsapp__*` no longer matches after a rename.

## Claude Desktop

File:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "type": "http",
      "url": "https://wa.example.com/personal/mcp",
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
    "whatsapp-personal": {
      "type": "http",
      "url": "https://wa.example.com/personal/mcp",
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
  new URL("https://wa.example.com/personal/mcp"),
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
      "uri": "https://wa.example.com/personal/media/t/personal/5511900000007@s.whatsapp.net/3EB0C1A....jpg",
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
- The host is the same as the MCP endpoint (`wa.example.com`), routed by path (`/<label>/media/t/*`) to an S3-compatible bucket (in the production compose, a RustFS container of that number alone, so the link resolves only under the label it was issued with). Same TLS cert, no extra DNS.
- Audio messages get `{ "type": "audio", … }` instead of `image` on first call.
- For files larger than `MEDIA_INLINE_MAX_BYTES` (default 5 MiB), no inline block is returned — fetch via `resource_link.uri`.
- Subsequent calls for the same `(message_id, chat_jid)` skip Baileys and return only the `resource_link` + JSON metadata (`status: "cached"`).
