import { FastMCP } from "fastmcp";
import type { Logger } from "pino";

import { type InstanceIdentity, identityParagraph } from "./instance-identity.ts";
import { allowsNoAuth, authenticateMcpRequest, readAuthToken } from "./listener-auth.ts";
import { registerActionsTools } from "./mcp/tools/actions.ts";
import { registerChatsTools } from "./mcp/tools/chats.ts";
import { registerConnectionTools } from "./mcp/tools/connection.ts";
import { registerContactsTools } from "./mcp/tools/contacts.ts";
import { registerGroupsTools } from "./mcp/tools/groups.ts";
import { registerMediaTools } from "./mcp/tools/media.ts";
import { registerMessagesTools } from "./mcp/tools/messages.ts";
import { registerMonitoringTools } from "./mcp/tools/monitoring.ts";
import { registerSendingTools } from "./mcp/tools/sending.ts";
import type { ToolDeps } from "./mcp/tools/types.ts";
import { registerWebhooksTools } from "./mcp/tools/webhooks.ts";

/**
 * Server-level routing hint surfaced to clients under "MCP Server Instructions".
 * Prime real estate every agent reads before choosing a tool — the three-lifetime
 * table steers "monitor / watch / follow / act as me" to the right reactive tool
 * instead of the blocking long-poll. See docs/agent-presence-stream-recipe.md.
 */
const SERVER_INSTRUCTIONS = `
WhatsApp as an MCP server: read/search history, send messages & media, and react to
inbound messages.

REACTING TO INCOMING MESSAGES — pick by how long you must stay reactive:

| Lifetime | Situation | Tool |
|---|---|---|
| Seconds–minutes | "I just sent something, await the reply and have nothing else to do meanwhile" | wait_for_messages (bounded block) |
| Session-length | "Be PRESENT in this chat — monitor / watch / follow a group, act as the user's persona, chat with people over minutes-to-hours while doing other work" | follow_chat (returns a stream URL you attach to your harness's background monitor, e.g. Monitor({ws:{url}}); woken per message, never occupies a turn) |
| Deployment-length | A deployed, headless service that owns its own HTTPS endpoint (server, n8n, cloud function) | register_webhook |

Do NOT loop wait_for_messages to "stay present" — each empty return wastes a turn and
blocks all other work. For standing presence use follow_chat.
`.trim();

/**
 * The instructions this instance sends. With an identity, its paragraph opens them (one blank
 * line, then the text above unchanged); without one they are exactly the text above.
 */
export function buildServerInstructions(identity: InstanceIdentity | null): string {
  return identity
    ? `${identityParagraph(identity)}\n\n${SERVER_INSTRUCTIONS}`
    : SERVER_INSTRUCTIONS;
}

export async function startMcpServer(
  mcpLogger: Logger,
  waLogger: Logger,
  identity: InstanceIdentity | null = null,
): Promise<void> {
  mcpLogger.info("Initializing FastMCP server...");

  // Startup already refused HTTP without a token unless MCP_ALLOW_NO_AUTH=true; the request
  // check below fails closed on its own as well (src/listener-auth.ts).
  const authToken = readAuthToken();
  const allowNoAuth = allowsNoAuth();
  if (!authToken && allowNoAuth) {
    mcpLogger.warn(
      "MCP_ALLOW_NO_AUTH=true and no MCP_AUTH_TOKEN — the HTTP MCP endpoint accepts anyone. Development only.",
    );
  }

  const server = new FastMCP({
    name: "whatsapp-baileys-ts",
    version: "0.3.0",
    instructions: buildServerInstructions(identity),
    authenticate: async (request) => authenticateMcpRequest(request, authToken, allowNoAuth),
  });

  const deps: ToolDeps = { mcpLogger, waLogger, identity };

  // Per-domain tool registries. Each registry owns the tools listed in its
  // CLAUDE.md section: name, schema, execute body — nothing more.
  registerConnectionTools(server, deps);
  registerContactsTools(server, deps);
  registerMessagesTools(server, deps);
  registerMonitoringTools(server, deps);
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
        `.trim(),
      };
    },
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
