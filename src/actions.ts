/**
 * Application-layer actions: orchestrate DB + WhatsApp + Storage.
 *
 * These are the "use cases" that MCP tools delegate to. Extracting them from
 * mcp.ts lets us:
 *  - test them without instantiating a FastMCP server
 *  - keep mcp.ts focused on tool registration / transport concerns
 *  - reuse the same logic from future transports (REST, CLI, …)
 */

import { imageContent, audioContent } from "fastmcp";
import type { Logger } from "pino";
import type { MediaType, WhatsAppSocket } from "@amiticia/baileys-client";

import {
  getMessageById,
  getLatestMessage,
  updateMessageMediaObjectKey,
  getContactName,
} from "./database.ts";
import { downloadMedia, socketState } from "./whatsapp.ts";
import { putMedia, publicUrlFor } from "./storage.ts";

export const MEDIA_INLINE_MAX_BYTES = Number(process.env.MEDIA_INLINE_MAX_BYTES ?? 5_242_880);

/** Throws if the WhatsApp socket is not connected; returns the narrowed socket. */
export function assertSocketActive(): WhatsAppSocket {
  if (!socketState.socket) {
    throw new Error("WhatsApp connection is not active.");
  }
  return socketState.socket;
}

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
  const socket = assertSocketActive();

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

  await socket.chatModify(
    { markRead: true, lastMessages: [minimalMessage] as any },
    chat_jid,
  );

  return `Chat ${chat_jid} marked as read.`;
}

// ── Connection actions ─────────────────────────────────────────────

export async function executeLogout(): Promise<string> {
  if (socketState.socket) {
    await socketState.socket.logout();
    return "Logged out. Reconnecting for new QR code — call get_connection_status in a few seconds to scan.";
  }
  return "Not currently connected.";
}

// ── Group actions ──────────────────────────────────────────────────

export async function executeGetGroupInfo(
  { group_jid }: { group_jid: string },
): Promise<string> {
  const socket = assertSocketActive();
  if (!group_jid.endsWith("@g.us")) {
    throw new Error(`Invalid group JID: "${group_jid}". Must end with "@g.us".`);
  }

  const metadata = await socket.groupMetadata(group_jid);

  return JSON.stringify({
    jid: metadata.id,
    name: metadata.subject,
    description: metadata.desc ?? null,
    owner: metadata.owner ?? null,
    creation_time: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
    participant_count: metadata.participants.length,
    participants: metadata.participants.map((p: any) => ({
      jid: p.id,
      name: getContactName(p.id) ?? p.id.split("@")[0],
      admin: p.admin ?? null,
    })),
  }, null, 2);
}

// ── Message actions ────────────────────────────────────────────────

export async function executeReactToMessage(
  { chat_jid, message_id, emoji, from_me }: { chat_jid: string; message_id: string; emoji: string; from_me: boolean },
): Promise<string> {
  const socket = assertSocketActive();

  await socket.sendMessage(chat_jid, {
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
}

export async function executeDeleteMessage(
  { chat_jid, message_id, from_me }: { chat_jid: string; message_id: string; from_me: boolean },
): Promise<string> {
  const socket = assertSocketActive();

  await socket.sendMessage(chat_jid, {
    delete: {
      remoteJid: chat_jid,
      id: message_id,
      fromMe: from_me,
    },
  });

  return `Message ${message_id} deleted successfully.`;
}
