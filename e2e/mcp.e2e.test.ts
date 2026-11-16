import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeRequest, type McpSession, openSession, post } from "./support/mcp-client.ts";
import { type E2eServer, startServer } from "./support/server.ts";

/**
 * The registered tool set is a contract with every deployed MCP client: a rename or a
 * removal must be a conscious change to this list.
 */
const EXPECTED_TOOLS = [
  "delete_message",
  "deregister_webhook",
  "download_media",
  "follow_chat",
  "get_chat",
  "get_connection_status",
  "get_group_info",
  "get_message_context",
  "get_messages_today",
  "get_new_messages",
  "list_chats",
  "list_contacts",
  "list_messages",
  "list_webhooks",
  "logout",
  "mark_chat_read",
  "react_to_message",
  "register_webhook",
  "search_contacts",
  "search_messages",
  "send_file",
  "send_message",
  "wait_for_messages",
];

// NOTE: no spec here calls `get_connection_status`. While disconnected it lazily starts a
// WhatsApp connection (src/mcp/tools/connection.ts), and this suite must never open one.

let server: E2eServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

describe("MCP over HTTP: authentication", () => {
  it("rejects a request with no Authorization header with 401", async () => {
    const res = await post(server.mcpUrl, initializeRequest);

    expect(res.status).toBe(401);
    expect(res.sessionId).toBeNull();
  });

  it("rejects a wrong Bearer token with 401", async () => {
    const res = await post(server.mcpUrl, initializeRequest, {
      authorization: `Bearer ${server.token}-wrong`,
    });

    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer Authorization scheme with 401", async () => {
    const res = await post(server.mcpUrl, initializeRequest, {
      authorization: `Basic ${server.token}`,
    });

    expect(res.status).toBe(401);
  });

  it("accepts the Bearer token and starts a session", async () => {
    const res = await post(server.mcpUrl, initializeRequest, {
      authorization: `Bearer ${server.token}`,
    });

    expect(res.status).toBe(200);
    expect(res.sessionId).toBeTruthy();
    expect(res.message?.result.serverInfo.name).toBe("whatsapp-baileys-ts");
  });
});

describe("MCP over HTTP: tools", () => {
  let session: McpSession;

  beforeAll(async () => {
    session = await openSession(server.mcpUrl, server.token);
  });

  afterAll(async () => {
    await session.close();
  });

  it("lists exactly the registered tool set", async () => {
    const tools = await session.listTools();

    expect([...tools].sort()).toEqual(EXPECTED_TOOLS);
  });

  it("returns an empty, well-formed result from list_chats on the empty database", async () => {
    const result = await session.callTool("list_chats");

    expect(result).toEqual({ isError: false, text: "No chats found." });
  });

  it("round-trips a webhook subscription through the real SQLite file", async () => {
    const db = new Database(path.join(server.dataDir, "data", "whatsapp.db"), { readonly: true });
    const storedUrls = () =>
      db
        .prepare("SELECT target_url FROM webhook_subscriptions")
        .all()
        .map((row) => (row as { target_url: string }).target_url);
    try {
      expect(JSON.parse((await session.callTool("list_webhooks")).text)).toEqual([]);

      const registered = await session.callTool("register_webhook", {
        target_url: "https://hooks.example.invalid/whatsapp",
        allowed_jids: ["*"],
        secret: "shh",
        label: "e2e",
      });
      const { id } = JSON.parse(registered.text);
      expect(registered.isError).toBe(false);
      expect(id).toEqual(expect.any(String));

      const listed = JSON.parse((await session.callTool("list_webhooks")).text);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id,
        target_url: "https://hooks.example.invalid/whatsapp",
        allowed_jids: ["*"],
        label: "e2e",
        has_secret: true,
        active: true,
      });
      expect(storedUrls()).toEqual(["https://hooks.example.invalid/whatsapp"]);

      const removed = await session.callTool("deregister_webhook", { id });
      expect(JSON.parse(removed.text)).toEqual({ removed: true });
      expect(JSON.parse((await session.callTool("list_webhooks")).text)).toEqual([]);
      expect(storedUrls()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("refuses to register a webhook with a non-http(s) URL", async () => {
    const result = await session.callTool("register_webhook", {
      target_url: "ftp://example.invalid/hook",
      allowed_jids: ["*"],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("http(s)");
  });
});
