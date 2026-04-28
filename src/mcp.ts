import { FastMCP, imageContent, audioContent } from "fastmcp";
import { z } from "zod";
import { normalizeJid, type MediaType } from "@amiticia/baileys-client";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  getContactName,
  getContacts,
  getMessagesWithDateFilter,
  searchDbForContacts,
  searchMessages,
  getMessageById,
  getLatestMessage,
  updateMessageMediaObjectKey,
} from "./database.ts";

import { sendWhatsAppMessage, sendWhatsAppMedia, downloadMedia, startWhatsAppConnection, connectionState, socketState } from "./whatsapp.ts";
import { putMedia, publicUrlFor } from "./storage.ts";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import type { Logger } from "pino";

/** Throws a consistent error when the WhatsApp socket is not yet connected. */
function assertSocketActive(): void {
  if (!socketState.socket) {
    throw new Error("WhatsApp connection is not active.");
  }
}

export function formatDbMessageForJson(msg: DbMessage) {
  const contactName = msg.sender ? getContactName(msg.sender) : null;
  const result: Record<string, unknown> = {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: contactName
      ?? (msg.sender ? msg.sender.split("@")[0] : null)
      ?? (msg.is_from_me ? "Me" : "Unknown"),
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };

  if (msg.media_type) {
    result.media = {
      type: msg.media_type,
      mimetype: msg.mimetype,
      file_size: msg.file_length,
      downloaded: !!msg.media_object_key,
      object_key: msg.media_object_key ?? null,
    };
  }

  return result;
}

export function formatDbChatForJson(chat: DbChat) {
  const lastSenderName = chat.last_sender ? getContactName(chat.last_sender) : null;
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_display: lastSenderName
      ?? (chat.last_sender ? chat.last_sender.split("@")[0] : null)
      ?? (chat.last_is_from_me ? "Me" : null),
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

const MEDIA_INLINE_MAX_BYTES = Number(process.env.MEDIA_INLINE_MAX_BYTES ?? 5_242_880);

export async function executeDownloadMedia(
  waLogger: Logger,
  { message_id, chat_jid }: { message_id: string; chat_jid: string },
) {
  waLogger.info(`[MCP Tool] Executing download_media for msg ${message_id} in ${chat_jid}`);

  const message = getMessageById(message_id, chat_jid);
  if (!message) {
    throw new Error(`Message ${message_id} not found in chat ${chat_jid}.`);
  }
  if (!message.media_type || !message.media_key || !message.direct_path) {
    throw new Error(`Message ${message_id} does not contain downloadable media or media metadata is missing.`);
  }

  const mimetype = message.mimetype ?? "application/octet-stream";
  const fileLength = message.file_length ?? 0;

  // Cache hit: object already uploaded to S3
  if (message.media_object_key) {
    const url = publicUrlFor(message.media_object_key);
    const ext = message.media_object_key.split(".").pop() ?? "bin";
    waLogger.info(`[MCP Tool] Media already in S3: ${message.media_object_key}`);
    return {
      content: [
        { type: "resource_link" as const, uri: url, name: `${message_id}.${ext}`, mimeType: mimetype },
        { type: "text" as const, text: JSON.stringify({ status: "cached", url, media_type: message.media_type, mimetype, file_size: message.file_length }, null, 2) },
      ],
    };
  }

  const { buffer, ext } = await downloadMedia({
    logger: waLogger,
    mediaKey: message.media_key,
    directPath: message.direct_path,
    mediaUrl: message.media_url ?? null,
    mediaType: message.media_type as MediaType,
    mimetype: message.mimetype ?? null,
    chatJid: chat_jid,
    messageId: message_id,
    fromMe: Boolean(message.is_from_me),
  });

  const { key, url } = await putMedia({ chatJid: chat_jid, messageId: message_id, ext, mimetype, buffer });
  updateMessageMediaObjectKey(message_id, chat_jid, key);

  const metaText = JSON.stringify({ status: "uploaded", url, media_type: message.media_type, mimetype, file_size: message.file_length }, null, 2);
  const resLink = { type: "resource_link" as const, uri: url, name: `${message_id}.${ext}`, mimeType: mimetype };
  const textBlock = { type: "text" as const, text: metaText };

  if (mimetype.startsWith("image/") && fileLength < MEDIA_INLINE_MAX_BYTES) {
    const img = await imageContent({ buffer });
    return { content: [img, resLink, textBlock] };
  }

  if (mimetype.startsWith("audio/") && fileLength < MEDIA_INLINE_MAX_BYTES) {
    const aud = await audioContent({ buffer });
    return { content: [aud, resLink, textBlock] };
  }

  return { content: [resLink, textBlock] };
}

export async function executeMarkChatRead(
  waLogger: Logger,
  { chat_jid }: { chat_jid: string },
): Promise<string> {
  waLogger.info(`[MCP Tool] Executing mark_chat_read for ${chat_jid}`);
  assertSocketActive();

  const latest = getLatestMessage(chat_jid);
  if (!latest) {
    throw new Error(`Cannot mark chat ${chat_jid} as read: no messages stored.`);
  }

  const isGroup = chat_jid.endsWith("@g.us");
  const minimalMessage = {
    key: {
      remoteJid: chat_jid,
      id: latest.id,
      fromMe: latest.is_from_me,
      ...(isGroup && latest.sender ? { participant: latest.sender } : {}),
    },
    messageTimestamp: Math.floor(latest.timestamp.getTime() / 1000),
  };

  await socketState.socket.chatModify(
    { markRead: true, lastMessages: [minimalMessage] as any },
    chat_jid,
  );

  return `Chat ${chat_jid} marked as read.`;
}

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

  // ── Connection / Auth ─────────────────────────────────────────────

  server.addTool({
    name: "get_connection_status",
    description: "Get current WhatsApp connection status and QR code if pending",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing get_connection_status");

      if (connectionState.status === 'qr_pending' && connectionState.qrCode) {
        const qrPath = "/tmp/whatsapp-mcp-qr.png";
        await QRCode.toFile(qrPath, connectionState.qrCode, { scale: 10 });
        mcpLogger.info({ qrPath }, "QR code saved as PNG");

        const child = spawn("xdg-open", [qrPath], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        return JSON.stringify({
          status: "qr_pending",
          qr_code_path: qrPath,
          message: "QR code saved and opened. Scan with WhatsApp mobile (Settings > Linked Devices). Call this tool again after scanning.",
        }, null, 2);
      }

      const result: Record<string, unknown> = {
        status: connectionState.status,
      };

      if (connectionState.user) {
        result.user = connectionState.user;
      }

      if (connectionState.status === 'connected') {
        result.message = "WhatsApp is connected and ready";
      } else if (connectionState.status === 'syncing') {
        result.message = "WhatsApp is connected but syncing history. Some operations may fail.";
        result.sync_progress = {
          chats: connectionState.syncProgress.chats,
          contacts: connectionState.syncProgress.contacts,
          messages: connectionState.syncProgress.messages,
          last_batch_ago_seconds: connectionState.syncProgress.lastBatchAt
            ? Math.round((Date.now() - connectionState.syncProgress.lastBatchAt.getTime()) / 1000)
            : null,
        };
      } else if (connectionState.status === 'connecting') {
        result.message = "Connecting to WhatsApp...";
      } else {
        result.message = "WhatsApp is disconnected. Attempting to reconnect...";
        // Trigger lazy reconnection
        startWhatsAppConnection(waLogger).catch((err) => {
          mcpLogger.error({ err }, "Reconnection attempt from get_connection_status failed");
        });
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
        return "Logged out. Reconnecting for new QR code — call get_connection_status in a few seconds to scan.";
      }
      return "Not currently connected.";
    }
  });

  // ── Contacts ──────────────────────────────────────────────────────

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

  // ── Messages ──────────────────────────────────────────────────────

  server.addTool({
    name: "list_messages",
    description: "Retrieve message history for a specific chat with pagination and optional date filtering",
    parameters: z.object({
      chat_jid: z.string().describe("The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')"),
      limit: z.number().int().positive().optional().default(20).describe("Max messages per page (default 20)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (0-indexed, default 0)"),
      from_date: z.string().optional().describe("Filter messages from this date (ISO 8601, e.g., '2025-01-01')"),
      to_date: z.string().optional().describe("Filter messages up to this date (ISO 8601, e.g., '2025-02-01')"),
    }),
    execute: async ({ chat_jid, limit, page, from_date, to_date }) => {
      mcpLogger.info(`[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}, from=${from_date}, to=${to_date}`);

      let messages: DbMessage[];
      if (from_date || to_date) {
        messages = getMessagesWithDateFilter(chat_jid, from_date, to_date, limit, page);
      } else {
        messages = getMessages(chat_jid, limit, page);
      }

      if (!messages.length) {
        return page === 0 ? `No messages found for chat ${chat_jid}.` : `No more messages found on page ${page} for chat ${chat_jid}.`;
      }
      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  server.addTool({
    name: "get_messages_today",
    description: "Get today's messages, optionally filtered to a specific chat",
    parameters: z.object({
      chat_jid: z.string().optional().describe("Optional: filter to a specific chat JID"),
      limit: z.number().int().positive().optional().default(50).describe("Max messages (default 50)"),
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
    description: "Search for messages across all chats or within a specific chat, with optional date filtering",
    parameters: z.object({
      query: z.string().min(1).describe("The text to search for"),
      chat_jid: z.string().optional().describe("Optional: Search within a specific chat JID"),
      from_date: z.string().optional().describe("Filter from this date (ISO 8601)"),
      to_date: z.string().optional().describe("Filter up to this date (ISO 8601)"),
      limit: z.number().int().positive().optional().default(10).describe("Max results (default 10)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (default 0)"),
    }),
    execute: async ({ chat_jid, query, from_date, to_date, limit, page }) => {
      mcpLogger.info(`[MCP Tool] Executing search_messages, query="${query}", from=${from_date}, to=${to_date}`);
      const messages = searchMessages(query, chat_jid, from_date, to_date, limit, page);

      if (!messages.length) {
        const scope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
        return page === 0 ? `No messages found containing "${query}" ${scope}.` : `No more messages found on page ${page}.`;
      }

      return JSON.stringify(messages.map(formatDbMessageForJson), null, 2);
    },
  });

  // ── Chats ─────────────────────────────────────────────────────────

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
      chat_jid: z.string().describe("The JID of the chat where the message lives"),
      message_id: z.string().describe("The ID of the target message"),
      before: z.number().int().nonnegative().optional().default(5).describe("Messages before (default 5)"),
      after: z.number().int().nonnegative().optional().default(5).describe("Messages after (default 5)"),
    }),
    execute: async ({ chat_jid, message_id, before, after }) => {
      mcpLogger.info(`[MCP Tool] Executing get_message_context for msg ${message_id} in ${chat_jid}`);
      const context = getMessagesAround(message_id, chat_jid, before, after);
      if (!context.target) {
        throw new Error(`Message with ID ${message_id} not found in chat ${chat_jid}.`);
      }
      return JSON.stringify({
        target: formatDbMessageForJson(context.target),
        before: context.before.map(formatDbMessageForJson),
        after: context.after.map(formatDbMessageForJson),
      }, null, 2);
    },
  });

  // ── Groups ────────────────────────────────────────────────────────

  server.addTool({
    name: "get_group_info",
    description: "Get metadata for a WhatsApp group (name, description, participants, admins)",
    parameters: z.object({
      group_jid: z.string().describe("The group JID (must end with '@g.us')"),
    }),
    execute: async ({ group_jid }) => {
      mcpLogger.info(`[MCP Tool] Executing get_group_info for ${group_jid}`);
      assertSocketActive();
      if (!group_jid.endsWith("@g.us")) {
        throw new Error(`Invalid group JID: "${group_jid}". Must end with "@g.us".`);
      }

      const metadata = await socketState.socket.groupMetadata(group_jid);

      return JSON.stringify({
        jid: metadata.id,
        name: metadata.subject,
        description: metadata.desc ?? null,
        owner: metadata.owner ?? null,
        creation_time: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
        participant_count: metadata.participants.length,
        participants: metadata.participants.map((p) => ({
          jid: p.id,
          name: getContactName(p.id) ?? p.id.split("@")[0],
          admin: p.admin ?? null,
        })),
      }, null, 2);
    },
  });

  // ── Sending ───────────────────────────────────────────────────────

  server.addTool({
    name: "send_message",
    description: "Send a text message to a contact or group",
    parameters: z.object({
      recipient: z.string().describe("Recipient JID (e.g., 'number@s.whatsapp.net' or 'group@g.us')"),
      message: z.string().min(1).describe("The text message to send"),
    }),
    execute: async ({ recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
      assertSocketActive();

      const normalizedRecipient = normalizeJid(recipient);
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
      assertSocketActive();

      const normalizedRecipient = normalizeJid(recipient);
      const result = await sendWhatsAppMedia(waLogger, normalizedRecipient, file_path, caption, type);

      if (result && result.key && result.key.id) {
        return `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`;
      } else {
        throw new Error(`Failed to send ${type} to ${normalizedRecipient}. Check if the file path is correct and accessible.`);
      }
    },
  });

  // ── Message Actions ───────────────────────────────────────────────

  server.addTool({
    name: "react_to_message",
    description: "React to a message with an emoji",
    parameters: z.object({
      chat_jid: z.string().describe("The chat JID where the message is"),
      message_id: z.string().describe("The ID of the message to react to"),
      emoji: z.string().describe("The emoji to react with (e.g., '👍', '❤️', '😂'). Use empty string to remove reaction."),
      from_me: z.boolean().optional().default(false).describe("Whether the target message was sent by you"),
    }),
    execute: async ({ chat_jid, message_id, emoji, from_me }) => {
      mcpLogger.info(`[MCP Tool] Executing react_to_message: ${emoji} on ${message_id} in ${chat_jid}`);
      assertSocketActive();

      await socketState.socket.sendMessage(chat_jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: chat_jid,
            id: message_id,
            fromMe: from_me,
          },
        },
      });

      return emoji
        ? `Reacted with ${emoji} to message ${message_id}.`
        : `Removed reaction from message ${message_id}.`;
    },
  });

  server.addTool({
    name: "delete_message",
    description: "Delete (revoke) a message you sent",
    parameters: z.object({
      chat_jid: z.string().describe("The chat JID where the message is"),
      message_id: z.string().describe("The ID of the message to delete"),
      from_me: z.boolean().optional().default(true).describe("Whether the message was sent by you (default true)"),
    }),
    execute: async ({ chat_jid, message_id, from_me }) => {
      mcpLogger.info(`[MCP Tool] Executing delete_message: ${message_id} in ${chat_jid}`);
      assertSocketActive();

      await socketState.socket.sendMessage(chat_jid, {
        delete: {
          remoteJid: chat_jid,
          id: message_id,
          fromMe: from_me,
        },
      });

      return `Message ${message_id} deleted successfully.`;
    },
  });

  server.addTool({
    name: "mark_chat_read",
    description: "Mark all messages in a chat as read",
    parameters: z.object({
      chat_jid: z.string().describe("The chat JID to mark as read"),
    }),
    execute: executeMarkChatRead.bind(null, mcpLogger),
  });

  // ── Media Download ──────────────────────────────────────────────

  server.addTool({
    name: "download_media",
    description: "Download media (image, video, audio, document, sticker) from a WhatsApp message and return it via S3-compatible storage",
    parameters: z.object({
      message_id: z.string().describe("The ID of the message containing media"),
      chat_jid: z.string().describe("The JID of the chat where the message is"),
    }),
    execute: executeDownloadMedia.bind(null, waLogger),
  });

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
