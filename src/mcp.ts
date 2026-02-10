import { FastMCP } from "fastmcp";
import { z } from "zod";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import path from "node:path";
import fs from "node:fs";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
} from "./database.ts";

import { sendWhatsAppMessage, sendWhatsAppMedia, connectionState, socketState } from "./whatsapp.ts";
import type { Logger } from "pino";

function formatDbMessageForJson(msg: DbMessage) {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: msg.sender
      ? msg.sender.split("@")[0]
      : msg.is_from_me
        ? "Me"
        : "Unknown",
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_display: chat.last_sender
      ? chat.last_sender.split("@")[0]
      : chat.last_is_from_me
        ? "Me"
        : null,
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

export async function startMcpServer(
  mcpLogger: Logger,
  waLogger: Logger,
): Promise<void> {
  mcpLogger.info("Initializing FastMCP server...");

  const server = new FastMCP({
    name: "whatsapp-baileys-ts",
    version: "0.2.0",
  });

  server.addTool({
    name: "get_connection_status",
    description: "Get current WhatsApp connection status and QR code if pending",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing get_connection_status");

      if (connectionState.status === 'qr_pending' && connectionState.qrAscii) {
        return `Status: ${connectionState.status}\n\nScan this QR code with WhatsApp mobile app (Settings > Linked Devices):\n\n${connectionState.qrAscii}`;
      }

      const result: Record<string, unknown> = {
        status: connectionState.status,
      };

      if (connectionState.user) {
        result.user = connectionState.user;
      }

      if (connectionState.status === 'connected') {
        result.message = "WhatsApp is connected and ready";
      } else if (connectionState.status === 'connecting') {
        result.message = "Connecting to WhatsApp...";
      } else {
        result.message = "WhatsApp is disconnected";
      }

      return JSON.stringify(result, null, 2);
    }
  });

  server.addTool({
    name: "logout",
    description: "Log out from WhatsApp and clear session data",
    parameters: z.object({}),
    execute: async () => {
        mcpLogger.info("[MCP Tool] Executing logout");
        if (socketState.socket) {
            await socketState.socket.logout();
            return "Logged out successfully. You will need to scan the QR code again to reconnect.";
        }
        return "Not currently connected.";
    }
  });

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
    name: "list_messages",
    description: "Retrieve message history for a specific chat with pagination",
    parameters: z.object({
      chat_jid: z.string().describe("The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')"),
      limit: z.number().int().positive().optional().default(20).describe("Max messages per page (default 20)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (0-indexed, default 0)"),
    }),
    execute: async ({ chat_jid, limit, page }) => {
      mcpLogger.info(`[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}`);
      const messages = getMessages(chat_jid, limit, page);
      if (!messages.length) {
        return page === 0 ? `No messages found for chat ${chat_jid}.` : `No more messages found on page ${page} for chat ${chat_jid}.`;
      }
      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  server.addTool({
    name: "list_chats",
    description: "List WhatsApp chats with metadata and filtering",
    parameters: z.object({
      limit: z.number().int().positive().optional().default(20).describe("Max chats per page (default 20)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (0-indexed, default 0)"),
      sort_by: z.enum(["last_active", "name"]).optional().default("last_active").describe("Sort order: 'last_active' (default) or 'name'"),
      query: z.string().optional().describe("Optional filter by chat name or JID"),
      include_last_message: z.boolean().optional().default(true).describe("Include last message details (default true)"),
    }),
    execute: async ({ limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(`[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}`);
      const chats = getChats(limit, page, sort_by, query ?? null, include_last_message);
      if (!chats.length) {
        const matching = query ? ` matching "${query}"` : "";
        return page === 0 ? `No chats found${matching}.` : `No more chats found on page ${page}${matching}.`;
      }
      return JSON.stringify(chats.map(formatDbChatForJson), null, 2);
    },
  });

  server.addTool({
    name: "get_chat",
    description: "Get detailed information about a specific chat",
    parameters: z.object({
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z.boolean().optional().default(true).describe("Include last message details (default true)"),
    }),
    execute: async ({ chat_jid, include_last_message }) => {
      mcpLogger.info(`[MCP Tool] Executing get_chat for ${chat_jid}`);
      const chat = getChat(chat_jid, include_last_message);
      if (!chat) {
          throw new Error(`Chat with JID ${chat_jid} not found.`);
      }
      return JSON.stringify(formatDbChatForJson(chat), null, 2);
    },
  });

  server.addTool({
    name: "get_message_context",
    description: "Retrieve messages around a specific message for context",
    parameters: z.object({
      message_id: z.string().describe("The ID of the target message"),
      before: z.number().int().nonnegative().optional().default(5).describe("Messages before (default 5)"),
      after: z.number().int().nonnegative().optional().default(5).describe("Messages after (default 5)"),
    }),
    execute: async ({ message_id, before, after }) => {
      mcpLogger.info(`[MCP Tool] Executing get_message_context for msg ${message_id}`);
      const context = getMessagesAround(message_id, before, after);
      if (!context.target) {
          throw new Error(`Message with ID ${message_id} not found.`);
      }
      return JSON.stringify({
        target: formatDbMessageForJson(context.target),
        before: context.before.map(formatDbMessageForJson),
        after: context.after.map(formatDbMessageForJson),
      }, null, 2);
    },
  });

  server.addTool({
    name: "send_message",
    description: "Send a text message to a contact or group",
    parameters: z.object({
      recipient: z.string().describe("Recipient JID (e.g., 'number@s.whatsapp.net' or 'group@g.us')"),
      message: z.string().min(1).describe("The text message to send"),
    }),
    execute: async ({ recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
      if (!socketState.socket) {
        throw new Error("WhatsApp connection is not active.");
      }

      const normalizedRecipient = jidNormalizedUser(recipient);
      if (!normalizedRecipient.includes("@")) {
          throw new Error(`Invalid recipient format: "${recipient}". JID must contain "@".`);
      }

      const result = await sendWhatsAppMessage(waLogger, normalizedRecipient, message);

      if (result && result.key && result.key.id) {
        return `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`;
      } else {
        throw new Error(`Failed to send message to ${normalizedRecipient}.`);
      }
    },
  });

  server.addTool({
    name: "send_file",
    description: "Send a file (image, video, document, audio) to a contact or group",
    parameters: z.object({
      recipient: z.string().describe("Recipient JID"),
      file_path: z.string().describe("Local path to the file"),
      caption: z.string().optional().describe("Optional caption for images/videos/documents"),
      type: z.enum(['image', 'video', 'document', 'audio']).optional().default('image').describe("Type of the media (default: image)"),
    }),
    execute: async ({ recipient, file_path, caption, type }) => {
      mcpLogger.info(`[MCP Tool] Executing send_file to ${recipient}: ${file_path}`);
      if (!socketState.socket) {
        throw new Error("WhatsApp connection is not active.");
      }

      const normalizedRecipient = jidNormalizedUser(recipient);
      const result = await sendWhatsAppMedia(waLogger, normalizedRecipient, file_path, caption, type);

      if (result && result.key && result.key.id) {
        return `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`;
      } else {
        throw new Error(`Failed to send ${type} to ${normalizedRecipient}. Check if the file path is correct and accessible.`);
      }
    },
  });

  server.addTool({
    name: "search_messages",
    description: "Search for messages across all chats or within a specific chat",
    parameters: z.object({
      query: z.string().min(1).describe("The text to search for"),
      chat_jid: z.string().optional().describe("Optional: Search within a specific chat JID"),
      limit: z.number().int().positive().optional().default(10).describe("Max results (default 10)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (default 0)"),
    }),
    execute: async ({ chat_jid, query, limit, page }) => {
      mcpLogger.info(`[MCP Tool] Executing search_messages, query="${query}"`);
      const messages = searchMessages(query, chat_jid, limit, page);

      if (!messages.length) {
        const scope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
        return page === 0 ? `No messages found containing "${query}" ${scope}.` : `No more messages found on page ${page}.`;
      }

      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  server.addResource({
    uri: "schema://whatsapp/main",
    name: "Database Schema",
    description: "The SQLite schema for WhatsApp data",
    async load() {
        return {
            text: `
TABLE chats (jid TEXT PK, name TEXT, last_message_time TIMESTAMP)
TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, PK(id, chat_jid), FK(chat_jid) REFERENCES chats(jid))
            `.trim()
        };
    }
  });

  mcpLogger.info("FastMCP server configured. Starting...");
  server.start();
}
