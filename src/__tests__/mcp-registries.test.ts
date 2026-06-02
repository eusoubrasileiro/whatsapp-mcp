import { describe, expect, it } from "vitest";
import pino from "pino";

import { registerConnectionTools } from "../mcp/tools/connection.ts";
import { registerContactsTools } from "../mcp/tools/contacts.ts";
import { registerMessagesTools } from "../mcp/tools/messages.ts";
import { registerChatsTools } from "../mcp/tools/chats.ts";
import { registerGroupsTools } from "../mcp/tools/groups.ts";
import { registerSendingTools } from "../mcp/tools/sending.ts";
import { registerActionsTools } from "../mcp/tools/actions.ts";
import { registerMediaTools } from "../mcp/tools/media.ts";
import { registerWebhooksTools } from "../mcp/tools/webhooks.ts";

import type { ToolRegistrar, ToolDeps } from "../mcp/tools/types.ts";

function createStubRegistrar(): { registrar: ToolRegistrar; names: string[] } {
  const names: string[] = [];
  const registrar: ToolRegistrar = {
    addTool: ((tool: { name: string }) => {
      names.push(tool.name);
    }) as ToolRegistrar["addTool"],
  };
  return { registrar, names };
}

function deps(): ToolDeps {
  const logger = pino({ level: "silent" });
  return { mcpLogger: logger, waLogger: logger };
}

describe("MCP tool registries", () => {
  it("connection registers get_connection_status and logout", () => {
    const { registrar, names } = createStubRegistrar();
    registerConnectionTools(registrar, deps());
    expect(names).toEqual(["get_connection_status", "logout"]);
  });

  it("contacts registers search_contacts and list_contacts", () => {
    const { registrar, names } = createStubRegistrar();
    registerContactsTools(registrar, deps());
    expect(names).toEqual(["search_contacts", "list_contacts"]);
  });

  it("messages registers list/today/search/context tools", () => {
    const { registrar, names } = createStubRegistrar();
    registerMessagesTools(registrar, deps());
    expect(names).toEqual([
      "list_messages",
      "get_messages_today",
      "search_messages",
      "get_message_context",
    ]);
  });

  it("chats registers list_chats and get_chat", () => {
    const { registrar, names } = createStubRegistrar();
    registerChatsTools(registrar, deps());
    expect(names).toEqual(["list_chats", "get_chat"]);
  });

  it("groups registers get_group_info", () => {
    const { registrar, names } = createStubRegistrar();
    registerGroupsTools(registrar, deps());
    expect(names).toEqual(["get_group_info"]);
  });

  it("sending registers send_message and send_file", () => {
    const { registrar, names } = createStubRegistrar();
    registerSendingTools(registrar, deps());
    expect(names).toEqual(["send_message", "send_file"]);
  });

  it("actions registers react/delete/mark_read", () => {
    const { registrar, names } = createStubRegistrar();
    registerActionsTools(registrar, deps());
    expect(names).toEqual([
      "react_to_message",
      "delete_message",
      "mark_chat_read",
    ]);
  });

  it("media registers download_media", () => {
    const { registrar, names } = createStubRegistrar();
    registerMediaTools(registrar, deps());
    expect(names).toEqual(["download_media"]);
  });

  it("webhooks registers register/deregister/list tools", () => {
    const { registrar, names } = createStubRegistrar();
    registerWebhooksTools(registrar, deps());
    expect(names).toEqual([
      "register_webhook",
      "deregister_webhook",
      "list_webhooks",
    ]);
  });
});

describe("startMcpServer export", () => {
  it("re-exports startMcpServer from src/mcp.ts", async () => {
    const mod = await import("../mcp.ts");
    expect(typeof mod.startMcpServer).toBe("function");
  });
});
