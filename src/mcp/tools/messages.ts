import { z } from "zod";

import { getMessagesAround, getMessagesWithDateFilter, searchMessages } from "../../database.ts";
import { formatDbMessageForJson } from "../../formatters.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerMessagesTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "list_messages",
    description:
      "Retrieve message history for a specific chat with pagination and optional date filtering",
    parameters: z.object({
      chat_jid: z
        .string()
        .describe("The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      from_date: z
        .string()
        .optional()
        .describe("Filter messages from this date (ISO 8601, e.g., '2025-01-01')"),
      to_date: z
        .string()
        .optional()
        .describe("Filter messages up to this date (ISO 8601, e.g., '2025-02-01')"),
    }),
    execute: async ({ chat_jid, limit, page, from_date, to_date }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}, from=${from_date}, to=${to_date}`,
      );

      const messages = getMessagesWithDateFilter(chat_jid, from_date, to_date, limit, page);

      if (!messages.length) {
        return page === 0
          ? `No messages found for chat ${chat_jid}.`
          : `No more messages found on page ${page} for chat ${chat_jid}.`;
      }
      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  server.addTool({
    name: "get_messages_today",
    description: "Get today's messages, optionally filtered to a specific chat",
    parameters: z.object({
      chat_jid: z.string().optional().describe("Optional: filter to a specific chat JID"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50)
        .describe("Max messages (default 50)"),
    }),
    execute: async ({ chat_jid, limit }) => {
      mcpLogger.info(`[MCP Tool] Executing get_messages_today, chat=${chat_jid}`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const fromDate = today.toISOString();

      const messages = getMessagesWithDateFilter(chat_jid, fromDate, null, limit, 0);

      if (!messages.length) {
        const scope = chat_jid ? ` in chat ${chat_jid}` : "";
        return `No messages found for today${scope}.`;
      }
      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  server.addTool({
    name: "search_messages",
    description:
      "Search for messages across all chats or within a specific chat, with optional date filtering",
    parameters: z.object({
      query: z.string().min(1).describe("The text to search for"),
      chat_jid: z.string().optional().describe("Optional: Search within a specific chat JID"),
      from_date: z.string().optional().describe("Filter from this date (ISO 8601)"),
      to_date: z.string().optional().describe("Filter up to this date (ISO 8601)"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max results (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (default 0)"),
    }),
    execute: async ({ chat_jid, query, from_date, to_date, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] Executing search_messages, query="${query}", from=${from_date}, to=${to_date}`,
      );
      const messages = searchMessages(query, chat_jid, from_date, to_date, limit, page);

      if (!messages.length) {
        const scope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
        return page === 0
          ? `No messages found containing "${query}" ${scope}.`
          : `No more messages found on page ${page}.`;
      }

      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  server.addTool({
    name: "get_message_context",
    description: "Retrieve messages around a specific message for context",
    parameters: z.object({
      chat_jid: z.string().describe("The JID of the chat where the message lives"),
      message_id: z.string().describe("The ID of the target message"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Messages after (default 5)"),
    }),
    execute: async ({ chat_jid, message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_message_context for msg ${message_id} in ${chat_jid}`,
      );
      const context = getMessagesAround(message_id, chat_jid, before, after);
      if (!context.target) {
        throw new Error(`Message with ID ${message_id} not found in chat ${chat_jid}.`);
      }
      return JSON.stringify(
        {
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        },
        null,
        2,
      );
    },
  });
}
