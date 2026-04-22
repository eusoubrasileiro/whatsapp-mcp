import { FastMCP, UserError, imageContent, audioContent } from "fastmcp";
import { z } from "zod";
import { normalizeJid, type MediaType } from "@amiticia/baileys-client";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  listMessages,
  listChats,
  getChat,
  getMessagesAround,
  getContactName,
  listContacts,
  listMessagesWithDateFilter,
  searchContacts,
  searchMessages,
  getMessageById,
  updateMessageMediaObjectKey,
} from "./db/queries.ts";

import { assertToolAllowed } from "./tenancy/tool-gating.ts";
import type { TenantConnectionManager } from "./tenancy/manager.ts";
import { downloadMedia } from "./whatsapp.ts";
import { putMedia, publicUrlFor } from "./storage.ts";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import type { Logger } from "pino";

async function formatDbMessageForJson(tenantId: string, msg: DbMessage) {
  const contactName = msg.sender ? await getContactName(tenantId, msg.sender) : null;
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

async function formatDbChatForJson(tenantId: string, chat: DbChat) {
  const lastSenderName = chat.last_sender ? await getContactName(tenantId, chat.last_sender) : null;
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

async function mapMessagesForJson(tenantId: string, msgs: DbMessage[]): Promise<unknown[]> {
  return Promise.all(msgs.map((m) => formatDbMessageForJson(tenantId, m)));
}

async function mapChatsForJson(tenantId: string, chats: DbChat[]): Promise<unknown[]> {
  return Promise.all(chats.map((c) => formatDbChatForJson(tenantId, c)));
}

const MEDIA_INLINE_MAX_BYTES = Number(process.env.MEDIA_INLINE_MAX_BYTES ?? 5_242_880);

export async function executeDownloadMedia(
  waLogger: Logger,
  manager: TenantConnectionManager,
  { message_id, chat_jid, tenant_id }: { message_id: string; chat_jid: string; tenant_id: string },
) {
  waLogger.info(`[MCP Tool] Executing download_media for msg ${message_id} in ${chat_jid} (tenant=${tenant_id})`);

  const message = await getMessageById(tenant_id, message_id, chat_jid);
  if (!message) {
    throw new Error(`Message ${message_id} not found in chat ${chat_jid}.`);
  }
  if (!message.media_type || !message.media_key || !message.direct_path) {
    throw new Error(`Message ${message_id} does not contain downloadable media or media metadata is missing.`);
  }

  const mimetype = message.mimetype ?? "application/octet-stream";
  const fileLength = message.file_length ?? 0;

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
    manager,
    tenantId: tenant_id,
    mediaKey: message.media_key,
    directPath: message.direct_path,
    mediaUrl: message.media_url ?? null,
    mediaType: message.media_type as MediaType,
    mimetype: message.mimetype ?? null,
    chatJid: chat_jid,
    messageId: message_id,
    fromMe: Boolean(message.is_from_me),
  });

  const { key, url } = await putMedia({ tenantId: tenant_id, chatJid: chat_jid, messageId: message_id, ext, mimetype, buffer });
  await updateMessageMediaObjectKey(tenant_id, message_id, chat_jid, key);

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

function requireTenantSocket(manager: TenantConnectionManager, tenantId: string) {
  const tc = manager.get(tenantId);
  if (!tc) throw new UserError(`Tenant ${tenantId} not found.`);
  const sock = tc.socket;
  if (!sock) throw new UserError(`WhatsApp connection for tenant ${tenantId} is not active.`);
  return { tc, sock };
}

export async function startMcpServer(
  mcpLogger: Logger,
  waLogger: Logger,
  manager: TenantConnectionManager,
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
    version: "0.4.0",
    authenticate: async (request) => {
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
      return { role: "admin" };
    },
  });

  // ── Connection / Auth ─────────────────────────────────────────────

  server.addTool({
    name: "get_connection_status",
    description: "Get WhatsApp connection status for a tenant (or all tenants if tenant_id is omitted)",
    parameters: z.object({
      tenant_id: z.string().optional().describe("Tenant ID. If omitted, returns status of all tenants."),
    }),
    execute: async ({ tenant_id }) => {
      mcpLogger.info(`[MCP Tool] Executing get_connection_status for tenant=${tenant_id ?? "all"}`);

      if (!tenant_id) {
        return JSON.stringify(manager.statusSnapshot(), null, 2);
      }

      const tc = manager.get(tenant_id);
      if (!tc) throw new UserError(`Tenant ${tenant_id} not found.`);

      const state = tc.connectionState;

      if (state.status === "qr_pending" && state.qrCode) {
        const qrPath = `/tmp/whatsapp-mcp-qr-${tenant_id}.png`;
        await QRCode.toFile(qrPath, state.qrCode, { scale: 10 });
        mcpLogger.info({ qrPath }, "QR code saved as PNG");

        const child = spawn("xdg-open", [qrPath], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        return JSON.stringify({
          tenant_id,
          status: "qr_pending",
          qr_code_path: qrPath,
          message: "QR code saved and opened. Scan with WhatsApp mobile (Settings > Linked Devices). Call this tool again after scanning.",
        }, null, 2);
      }

      const result: Record<string, unknown> = {
        tenant_id,
        status: state.status,
      };

      if (state.user) result.user = state.user;

      if (state.status === "connected") {
        result.message = "WhatsApp is connected and ready";
      } else if (state.status === "syncing") {
        result.message = "WhatsApp is connected but syncing history. Some operations may fail.";
        result.sync_progress = {
          chats: state.syncProgress.chats,
          contacts: state.syncProgress.contacts,
          messages: state.syncProgress.messages,
          last_batch_ago_seconds: state.syncProgress.lastBatchAt
            ? Math.round((Date.now() - state.syncProgress.lastBatchAt.getTime()) / 1000)
            : null,
        };
      } else if (state.status === "connecting") {
        result.message = "Connecting to WhatsApp...";
      } else {
        result.message = "WhatsApp is disconnected. Attempting to reconnect...";
        tc.start().catch((err) => {
          mcpLogger.error({ err }, "Reconnection attempt from get_connection_status failed");
        });
      }

      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "logout",
    description: "Log out a tenant from WhatsApp and clear session data",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID to log out"),
    }),
    execute: async ({ tenant_id }) => {
      mcpLogger.info(`[MCP Tool] Executing logout for tenant=${tenant_id}`);
      const { sock } = requireTenantSocket(manager, tenant_id);
      await sock.logout();
      return `Tenant ${tenant_id} logged out. Reconnecting for new QR code — call get_connection_status in a few seconds to scan.`;
    },
  });

  // ── Contacts ──────────────────────────────────────────────────────

  server.addTool({
    name: "search_contacts",
    description: "Search for contacts by name or phone number part (JID)",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID to search within"),
      query: z.string().min(1).describe("Search term for contact name or phone number part of JID"),
    }),
    execute: async ({ tenant_id, query }) => {
      mcpLogger.info(`[MCP Tool] Executing search_contacts for tenant=${tenant_id}, query="${query}"`);
      const contacts = await searchContacts(tenant_id, query, 20);
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
      tenant_id: z.string().describe("Tenant ID"),
      query: z.string().optional().describe("Optional filter by name or phone number"),
      limit: z.number().int().positive().optional().default(50).describe("Max contacts to return (default 50)"),
    }),
    execute: async ({ tenant_id, query, limit }) => {
      mcpLogger.info(`[MCP Tool] Executing list_contacts for tenant=${tenant_id}, query="${query ?? ""}", limit=${limit}`);
      const contacts = await listContacts(tenant_id, query ?? undefined, limit);
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
      tenant_id: z.string().describe("Tenant ID"),
      chat_jid: z.string().describe("The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')"),
      limit: z.number().int().positive().optional().default(20).describe("Max messages per page (default 20)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (0-indexed, default 0)"),
      from_date: z.string().optional().describe("Filter messages from this date (ISO 8601, e.g., '2025-01-01')"),
      to_date: z.string().optional().describe("Filter messages up to this date (ISO 8601, e.g., '2025-02-01')"),
    }),
    execute: async ({ tenant_id, chat_jid, limit, page, from_date, to_date }) => {
      mcpLogger.info(`[MCP Tool] Executing list_messages for tenant=${tenant_id}, chat=${chat_jid}`);

      let messages: DbMessage[];
      if (from_date || to_date) {
        messages = await listMessagesWithDateFilter(tenant_id, chat_jid, from_date, to_date, limit, page);
      } else {
        messages = await listMessages(tenant_id, chat_jid, limit, page);
      }

      if (!messages.length) {
        return page === 0 ? `No messages found for chat ${chat_jid}.` : `No more messages found on page ${page} for chat ${chat_jid}.`;
      }
      return JSON.stringify(await mapMessagesForJson(tenant_id, messages), null, 2);
    },
  });

  server.addTool({
    name: "get_messages_today",
    description: "Get today's messages, optionally filtered to a specific chat",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      chat_jid: z.string().optional().describe("Optional: filter to a specific chat JID"),
      limit: z.number().int().positive().optional().default(50).describe("Max messages (default 50)"),
    }),
    execute: async ({ tenant_id, chat_jid, limit }) => {
      mcpLogger.info(`[MCP Tool] Executing get_messages_today for tenant=${tenant_id}, chat=${chat_jid}`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const fromDate = today.toISOString();

      const messages = await listMessagesWithDateFilter(tenant_id, chat_jid, fromDate, null, limit, 0);

      if (!messages.length) {
        const scope = chat_jid ? ` in chat ${chat_jid}` : "";
        return `No messages found for today${scope}.`;
      }
      return JSON.stringify(await mapMessagesForJson(tenant_id, messages), null, 2);
    },
  });

  server.addTool({
    name: "search_messages",
    description: "Search for messages across all chats or within a specific chat, with optional date filtering",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      query: z.string().min(1).describe("The text to search for"),
      chat_jid: z.string().optional().describe("Optional: Search within a specific chat JID"),
      from_date: z.string().optional().describe("Filter from this date (ISO 8601)"),
      to_date: z.string().optional().describe("Filter up to this date (ISO 8601)"),
      limit: z.number().int().positive().optional().default(10).describe("Max results (default 10)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (default 0)"),
    }),
    execute: async ({ tenant_id, chat_jid, query, from_date, to_date, limit, page }) => {
      mcpLogger.info(`[MCP Tool] Executing search_messages for tenant=${tenant_id}, query="${query}"`);
      const messages = await searchMessages(tenant_id, query, chat_jid, from_date, to_date, limit, page);

      if (!messages.length) {
        const scope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
        return page === 0 ? `No messages found containing "${query}" ${scope}.` : `No more messages found on page ${page}.`;
      }

      return JSON.stringify(await mapMessagesForJson(tenant_id, messages), null, 2);
    },
  });

  // ── Chats ─────────────────────────────────────────────────────────

  server.addTool({
    name: "list_chats",
    description: "List WhatsApp chats with metadata and filtering",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      limit: z.number().int().positive().optional().default(20).describe("Max chats per page (default 20)"),
      page: z.number().int().nonnegative().optional().default(0).describe("Page number (0-indexed, default 0)"),
      sort_by: z.enum(["last_active", "name"]).optional().default("last_active").describe("Sort order: 'last_active' (default) or 'name'"),
      query: z.string().optional().describe("Optional filter by chat name or JID"),
      include_last_message: z.boolean().optional().default(true).describe("Include last message details (default true)"),
    }),
    execute: async ({ tenant_id, limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(`[MCP Tool] Executing list_chats for tenant=${tenant_id}`);
      const chats = await listChats(tenant_id, limit, page, sort_by, query ?? null, include_last_message);
      if (!chats.length) {
        const matching = query ? ` matching "${query}"` : "";
        return page === 0 ? `No chats found${matching}.` : `No more chats found on page ${page}${matching}.`;
      }
      return JSON.stringify(await mapChatsForJson(tenant_id, chats), null, 2);
    },
  });

  server.addTool({
    name: "get_chat",
    description: "Get detailed information about a specific chat",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z.boolean().optional().default(true).describe("Include last message details (default true)"),
    }),
    execute: async ({ tenant_id, chat_jid, include_last_message }) => {
      mcpLogger.info(`[MCP Tool] Executing get_chat for tenant=${tenant_id}, chat=${chat_jid}`);
      const chat = await getChat(tenant_id, chat_jid, include_last_message);
      if (!chat) {
        throw new Error(`Chat with JID ${chat_jid} not found.`);
      }
      return JSON.stringify(await formatDbChatForJson(tenant_id, chat), null, 2);
    },
  });

  server.addTool({
    name: "get_message_context",
    description: "Retrieve messages around a specific message for context",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      message_id: z.string().describe("The ID of the target message"),
      before: z.number().int().nonnegative().optional().default(5).describe("Messages before (default 5)"),
      after: z.number().int().nonnegative().optional().default(5).describe("Messages after (default 5)"),
    }),
    execute: async ({ tenant_id, message_id, before, after }) => {
      mcpLogger.info(`[MCP Tool] Executing get_message_context for tenant=${tenant_id}, msg=${message_id}`);
      const context = await getMessagesAround(tenant_id, message_id, before, after);
      if (!context.target) {
        throw new Error(`Message with ID ${message_id} not found.`);
      }
      return JSON.stringify({
        target: await formatDbMessageForJson(tenant_id, context.target),
        before: await mapMessagesForJson(tenant_id, context.before),
        after: await mapMessagesForJson(tenant_id, context.after),
      }, null, 2);
    },
  });

  // ── Groups ────────────────────────────────────────────────────────

  server.addTool({
    name: "get_group_info",
    description: "Get metadata for a WhatsApp group (name, description, participants, admins)",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      group_jid: z.string().describe("The group JID (must end with '@g.us')"),
    }),
    execute: async ({ tenant_id, group_jid }) => {
      mcpLogger.info(`[MCP Tool] Executing get_group_info for tenant=${tenant_id}, group=${group_jid}`);
      const { sock } = requireTenantSocket(manager, tenant_id);

      if (!group_jid.endsWith("@g.us")) {
        throw new Error(`Invalid group JID: "${group_jid}". Must end with "@g.us".`);
      }

      const metadata = await sock.groupMetadata(group_jid);

      const participants = await Promise.all(
        metadata.participants.map(async (p) => ({
          jid: p.id,
          name: (await getContactName(tenant_id, p.id)) ?? p.id.split("@")[0],
          admin: p.admin ?? null,
        })),
      );

      return JSON.stringify({
        jid: metadata.id,
        name: metadata.subject,
        description: metadata.desc ?? null,
        owner: metadata.owner ?? null,
        creation_time: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
        participant_count: metadata.participants.length,
        participants,
      }, null, 2);
    },
  });

  // ── Sending (write tools — gated) ────────────────────────────────

  server.addTool({
    name: "send_message",
    description: "Send a text message to a contact or group",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      recipient: z.string().describe("Recipient JID (e.g., 'number@s.whatsapp.net' or 'group@g.us')"),
      message: z.string().min(1).describe("The text message to send"),
    }),
    execute: async ({ tenant_id, recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message for tenant=${tenant_id} to ${recipient}`);
      await assertToolAllowed(tenant_id, "send_message");
      const { sock } = requireTenantSocket(manager, tenant_id);

      const normalizedRecipient = normalizeJid(recipient);
      if (!normalizedRecipient.includes("@")) {
        throw new Error(`Invalid recipient format: "${recipient}". JID must contain "@".`);
      }

      const result = await sock.sendMessage(normalizedRecipient, { text: message });

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
      tenant_id: z.string().describe("Tenant ID"),
      recipient: z.string().describe("Recipient JID"),
      file_path: z.string().describe("Local path to the file"),
      caption: z.string().optional().describe("Optional caption for images/videos/documents"),
      type: z.enum(["image", "video", "document", "audio"]).optional().default("image").describe("Type of the media (default: image)"),
    }),
    execute: async ({ tenant_id, recipient, file_path, caption, type }) => {
      mcpLogger.info(`[MCP Tool] Executing send_file for tenant=${tenant_id} to ${recipient}: ${file_path}`);
      await assertToolAllowed(tenant_id, "send_file");

      const { sock } = requireTenantSocket(manager, tenant_id);
      const normalizedRecipient = normalizeJid(recipient);

      const { sendMediaMessage } = await import("@amiticia/baileys-client");
      const fs = await import("node:fs");
      const pathMod = await import("node:path");

      if (!fs.existsSync(file_path)) {
        throw new Error(`File not found at ${file_path}`);
      }

      const fileBuffer = fs.readFileSync(file_path);
      const result = await sendMediaMessage(
        sock,
        normalizedRecipient,
        {
          buffer: Buffer.from(fileBuffer),
          type,
          caption,
          fileName: type === "document" ? pathMod.basename(file_path) : undefined,
        },
        waLogger,
      );

      if (result.success && result.messageId) {
        return `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully to ${normalizedRecipient} (ID: ${result.messageId}).`;
      } else {
        throw new Error(`Failed to send ${type} to ${normalizedRecipient}. Check if the file path is correct and accessible.`);
      }
    },
  });

  // ── Message Actions (write tools — gated) ─────────────────────────

  server.addTool({
    name: "react_to_message",
    description: "React to a message with an emoji",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      chat_jid: z.string().describe("The chat JID where the message is"),
      message_id: z.string().describe("The ID of the message to react to"),
      emoji: z.string().describe("The emoji to react with (e.g., '👍', '❤️', '😂'). Use empty string to remove reaction."),
      from_me: z.boolean().optional().default(false).describe("Whether the target message was sent by you"),
    }),
    execute: async ({ tenant_id, chat_jid, message_id, emoji, from_me }) => {
      mcpLogger.info(`[MCP Tool] Executing react_to_message for tenant=${tenant_id}`);
      await assertToolAllowed(tenant_id, "react_to_message");
      const { sock } = requireTenantSocket(manager, tenant_id);

      await sock.sendMessage(chat_jid, {
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
      tenant_id: z.string().describe("Tenant ID"),
      chat_jid: z.string().describe("The chat JID where the message is"),
      message_id: z.string().describe("The ID of the message to delete"),
      from_me: z.boolean().optional().default(true).describe("Whether the message was sent by you (default true)"),
    }),
    execute: async ({ tenant_id, chat_jid, message_id, from_me }) => {
      mcpLogger.info(`[MCP Tool] Executing delete_message for tenant=${tenant_id}`);
      await assertToolAllowed(tenant_id, "delete_message");
      const { sock } = requireTenantSocket(manager, tenant_id);

      await sock.sendMessage(chat_jid, {
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
      tenant_id: z.string().describe("Tenant ID"),
      chat_jid: z.string().describe("The chat JID to mark as read"),
    }),
    execute: async ({ tenant_id, chat_jid }) => {
      mcpLogger.info(`[MCP Tool] Executing mark_chat_read for tenant=${tenant_id}`);
      await assertToolAllowed(tenant_id, "mark_chat_read");
      const { sock } = requireTenantSocket(manager, tenant_id);

      await sock.readMessages([{ remoteJid: chat_jid, id: undefined! }]);

      return `Chat ${chat_jid} marked as read.`;
    },
  });

  // ── Media Download ──────────────────────────────────────────────

  server.addTool({
    name: "download_media",
    description: "Download media (image, video, audio, document, sticker) from a WhatsApp message and return it via S3-compatible storage",
    parameters: z.object({
      tenant_id: z.string().describe("Tenant ID"),
      message_id: z.string().describe("The ID of the message containing media"),
      chat_jid: z.string().describe("The JID of the chat where the message is"),
    }),
    execute: async ({ tenant_id, message_id, chat_jid }) => {
      return executeDownloadMedia(waLogger, manager, { message_id, chat_jid, tenant_id });
    },
  });

  // ── Resource ──────────────────────────────────────────────────────

  server.addResource({
    uri: "schema://whatsapp/main",
    name: "Database Schema",
    description: "The PostgreSQL schema for WhatsApp data (multi-tenant)",
    async load() {
      return {
        text: `
TABLE tenants (id TEXT PK, displayName TEXT, expectedWaNumber TEXT, status TEXT, ...)
TABLE chats (tenantId TEXT, jid TEXT, name TEXT, lastMessageTime TIMESTAMP, PK(tenantId, jid), FK(tenantId) REFERENCES tenants(id))
TABLE messages (tenantId TEXT, chatJid TEXT, id TEXT, timestamp TIMESTAMP, sender TEXT, content TEXT, isFromMe BOOLEAN, ..., PK(tenantId, chatJid, id))
TABLE contacts (tenantId TEXT, jid TEXT, name TEXT, notify TEXT, phoneNumber TEXT, PK(tenantId, jid))
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
