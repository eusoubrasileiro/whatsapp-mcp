/**
 * Presentation-layer formatters: convert database row types to plain JSON
 * objects suitable for MCP tool responses.
 *
 * Kept separate from mcp.ts so they can be tested without pulling in the
 * full FastMCP / server wiring, and to make the boundary between the
 * persistence layer and the transport layer explicit.
 */

import { getContactName, type Message as DbMessage, type Chat as DbChat } from "./database.ts";

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
