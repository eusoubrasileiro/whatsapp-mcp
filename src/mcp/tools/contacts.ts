import { z } from "zod";

import { getContacts, searchDbForContacts } from "../../database.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerContactsTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "search_contacts",
    description: "Search for contacts by name or phone number part (JID)",
    parameters: z.object({
      query: z.string().min(1).describe("Search term for contact name or phone number part of JID"),
    }),
    execute: async ({ query }) => {
      mcpLogger.info(`[MCP Tool] Executing search_contacts with query: "${query}"`);
      const contacts = searchDbForContacts(query, 20);
      return JSON.stringify(contacts.map((c) => ({
        jid: c.jid,
        name: c.name ?? c.jid.split("@")[0],
      })), null, 2);
    },
  });

  server.addTool({
    name: "list_contacts",
    description: "List all contacts with optional name/number filter",
    parameters: z.object({
      query: z.string().optional().describe("Optional filter by name or phone number"),
      limit: z.number().int().positive().optional().default(50).describe("Max contacts to return (default 50)"),
    }),
    execute: async ({ query, limit }) => {
      mcpLogger.info(`[MCP Tool] Executing list_contacts, query="${query ?? ""}", limit=${limit}`);
      const contacts = getContacts(query ?? undefined, limit);
      if (!contacts.length) {
        return query ? `No contacts found matching "${query}".` : "No contacts found.";
      }
      return JSON.stringify(contacts, null, 2);
    },
  });
}
