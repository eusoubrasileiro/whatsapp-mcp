import { FastMCP } from "fastmcp";
import type { Logger } from "pino";

import { registerActionsTools } from "./mcp/tools/actions.ts";
import { registerChatsTools } from "./mcp/tools/chats.ts";
import { registerConnectionTools } from "./mcp/tools/connection.ts";
import { registerContactsTools } from "./mcp/tools/contacts.ts";
import { registerGroupsTools } from "./mcp/tools/groups.ts";
import { registerMediaTools } from "./mcp/tools/media.ts";
import { registerMessagesTools } from "./mcp/tools/messages.ts";
import { registerSendingTools } from "./mcp/tools/sending.ts";
import { registerWebhooksTools } from "./mcp/tools/webhooks.ts";
import type { ToolDeps } from "./mcp/tools/types.ts";

export async function startMcpServer(
  mcpLogger: Logger,
  waLogger: Logger,
): Promise<void> {
  mcpLogger.info("Initializing FastMCP server...");

  const authToken = process.env.MCP_AUTH_TOKEN;
  if (!authToken) {
    mcpLogger.warn(
      "MCP_AUTH_TOKEN not set — HTTP MCP endpoint will accept unauthenticated requests. OK for stdio/local, DO NOT run like this in production.",
    );
  }

  const server = new FastMCP({
    name: "whatsapp-baileys-ts",
    version: "0.3.0",
    authenticate: async (request) => {
      // stdio transport passes undefined — trust local invocation.
      if (!request) return {};

      if (!authToken) return {};

      const header = request.headers.authorization;
      const raw = Array.isArray(header) ? header[0] : header;
      if (!raw || !raw.startsWith("Bearer ")) {
        throw new Response(null, {
          status: 401,
          statusText: "Missing or invalid Authorization header",
        });
      }
      if (raw.slice(7) !== authToken) {
        throw new Response(null, { status: 401, statusText: "Invalid token" });
      }
      return {};
    },
  });

  const deps: ToolDeps = { mcpLogger, waLogger };

  // Per-domain tool registries. Each registry owns the tools listed in its
  // CLAUDE.md section: name, schema, execute body — nothing more.
  registerConnectionTools(server, deps);
  registerContactsTools(server, deps);
  registerMessagesTools(server, deps);
  registerChatsTools(server, deps);
  registerGroupsTools(server, deps);
  registerSendingTools(server, deps);
  registerActionsTools(server, deps);
  registerMediaTools(server, deps);
  registerWebhooksTools(server, deps);

  // ── Resource ──────────────────────────────────────────────────────

  server.addResource({
    uri: "schema://whatsapp/main",
    name: "Database Schema",
    description: "The SQLite schema for WhatsApp data",
    async load() {
      return {
        text: `
TABLE chats (jid TEXT PK, name TEXT, last_message_time TEXT)
TABLE messages (
  id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER,
  media_type TEXT, mimetype TEXT, media_key TEXT, direct_path TEXT, media_url TEXT,
  file_length INTEGER, file_sha256 TEXT, file_enc_sha256 TEXT, media_object_key TEXT,
  PK(id, chat_jid), FK(chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
)
TABLE contacts (jid TEXT PK, name TEXT, notify TEXT, phone_number TEXT)
TABLE webhook_subscriptions (
  id TEXT PK, tenant_id TEXT, target_url TEXT, secret TEXT, auth_mode TEXT,
  allowed_jids TEXT, transcribe INTEGER, include_from_me INTEGER, label TEXT, active INTEGER,
  created_at TEXT, updated_at TEXT
)
        `.trim()
      };
    }
  });

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "stdio") {
    mcpLogger.info("FastMCP server configured. Starting (stdio)...");
    await server.start();
    return;
  }
  if (transport === "httpstream" || transport === "http" || transport === "sse") {
    const port = Number(process.env.MCP_PORT ?? 3001);
    const host = process.env.MCP_HOST ?? "127.0.0.1";
    const endpoint = (process.env.MCP_ENDPOINT ?? "/mcp") as `/${string}`;
    mcpLogger.info({ port, host, endpoint }, "FastMCP server configured. Starting (httpStream)...");
    await server.start({
      transportType: "httpStream",
      httpStream: { port, host, endpoint },
    });
    return;
  }
  throw new Error(`Invalid MCP_TRANSPORT: "${transport}". Expected "stdio" or "httpStream".`);
}
